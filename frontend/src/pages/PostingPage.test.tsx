import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PostingPage } from './PostingPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { listItem, readyToPost } from '../test-support/fixtures';

/**
 * Posting — the irreversible one.
 *
 * Once an invoice is POSTED the ERP holds the accounting document, coding is frozen, and the
 * only correct remedy for a mistake is a credit note or an ERP-side reversal, which this tool
 * cannot request. So the two failures that matter on this screen are posting something that
 * should not have been posted, and *saying* something posted when it did not.
 */

const routes = (ready = [readyToPost()], posted = [] as ReturnType<typeof listItem>[]) => ({
  'GET /posting/ready': { body: ready },
  'GET /posting/posted': { body: posted },
});

describe('the coding gate', () => {
  it('WILL NOT OFFER TO POST AN INVOICE WITH UNCODED LINES', async () => {
    // The backend refuses this too, and that is what actually enforces it. The screen's job
    // is to not present an action that cannot succeed — and, more usefully, to say what is
    // missing and where to fix it.
    signIn();
    const fake = fakeApi(routes([readyToPost({ invoiceNumber: 'INV-UNCODED', uncodedLines: 2 })]));
    renderScreen(<PostingPage />);

    const row = (await screen.findByRole('link', { name: 'INV-UNCODED' })).closest('tr')!;
    expect(within(row).queryByRole('button', { name: /Post to ERP/ })).not.toBeInTheDocument();
    expect(within(row).getByText('2 line(s) uncoded')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Code it first' })).toBeInTheDocument();
    expect(fake.matching('POST /invoices/*/post')).toHaveLength(0);
  });

  it('offers it once every line is coded', async () => {
    signIn();
    fakeApi(routes([readyToPost({ uncodedLines: 0 })]));
    renderScreen(<PostingPage />);
    expect(await screen.findByRole('button', { name: 'Post to ERP' })).toBeInTheDocument();
    expect(screen.getByText('complete')).toBeInTheDocument();
  });
});

describe('posting', () => {
  it('POSTS THE INVOICE THE BUTTON BELONGS TO', async () => {
    signIn();
    const fake = fakeApi({
      ...routes([
        readyToPost({ id: 'inv-a', invoiceNumber: 'INV-A' }),
        readyToPost({ id: 'inv-b', invoiceNumber: 'INV-B' }),
      ]),
      'POST /invoices/*/post': { body: { erpDocumentNumber: '5106040049' } },
    });
    renderScreen(<PostingPage />);

    const rowB = (await screen.findByRole('link', { name: 'INV-B' })).closest('tr')!;
    await userEvent.click(within(rowB).getByRole('button', { name: 'Post to ERP' }));

    expect(fake.only('POST /invoices/inv-b/post').body).toBeUndefined();
    expect(fake.matching('POST /invoices/inv-a/post')).toHaveLength(0);
  });

  it('SHOWS THE DOCUMENT NUMBER THE SERVER RETURNED, NOT ONE OF ITS OWN', async () => {
    // The number is the receipt an operator quotes to Finance. Rendering anything the server
    // did not send — a placeholder, an id, a locally generated string — would hand them a
    // reference that reconciles against nothing.
    signIn();
    fakeApi({ ...routes(), 'POST /invoices/*/post': { body: { erpDocumentNumber: '5106040049' } } });
    renderScreen(<PostingPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Post to ERP' }));
    expect(await screen.findByText(/posted as ERP document 5106040049\./)).toBeInTheDocument();
    expect(await screen.findByText('5106040049')).toBeInTheDocument();
  });

  it('refreshes both lists, so the invoice moves out of "ready" and into "posted"', async () => {
    // Posting is terminal. An invoice left sitting under "Ready to post" with a live button
    // invites a second attempt at the one operation that cannot be undone.
    signIn();
    const fake = fakeApi({ ...routes(), 'POST /invoices/*/post': { body: { erpDocumentNumber: '51060' } } });
    renderScreen(<PostingPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Post to ERP' }));
    await waitFor(() => expect(fake.matching('GET /posting/ready').length).toBeGreaterThan(1));
    expect(fake.matching('GET /posting/posted').length).toBeGreaterThan(1);
  });

  it('NEVER CLAIMS A POSTING THAT DID NOT HAPPEN', async () => {
    // A false "posted" is worse here than anywhere else in the product: the operator stops,
    // the invoice is never handed to the ERP, and the supplier is not paid — with a screen
    // saying it was.
    signIn();
    fakeApi({
      ...routes(),
      'POST /invoices/*/post': nestError(400, 'Invoice cannot be posted: 1 line(s) are not coded'),
    });
    renderScreen(<PostingPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Post to ERP' }));

    expect(await screen.findByText(/1 line\(s\) are not coded/)).toBeInTheDocument();
    // Asserted as "no success notice of any wording" rather than against the exact sentence:
    // the failure being guarded is a screen claiming success, and pinning one phrasing would
    // let any other phrasing of the same lie through.
    expect(document.querySelector('.notice.ok')).toBeNull();
    expect(screen.queryByText('Posted to the ERP')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post to ERP' })).toBeEnabled();
  });

  it('refuses a second click while the first is in flight', async () => {
    // Posting is not idempotent — the backend would generate a second document number.
    signIn();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    fakeApi({
      ...routes(),
      'POST /invoices/*/post': async () => {
        await held;
        return { body: { erpDocumentNumber: '51060' } };
      },
    });
    renderScreen(<PostingPage />);

    const button = await screen.findByRole('button', { name: 'Post to ERP' });
    await userEvent.click(button);
    expect(await screen.findByRole('button', { name: 'Posting…' })).toBeDisabled();
    release();
  });
});

describe('what the screen discloses', () => {
  it('SAYS THE DOCUMENT NUMBER IS SIMULATED', async () => {
    // No ERP is contacted; the number is generated locally and looks entirely real. Nothing
    // in the data marks it as fake, so this sentence is the only thing standing between an
    // operator and quoting an invented document number to their finance team.
    signIn();
    fakeApi(routes());
    renderScreen(<PostingPage />);

    const notice = await screen.findByText(/Simulated posting\./);
    expect(notice.parentElement).toHaveTextContent(/generated here, not returned\s+by an ERP/);
  });

  it('lists what has already been posted with its ERP document number', async () => {
    signIn();
    fakeApi(routes([], [listItem({ status: 'POSTED', erpDocumentNumber: '5106040049' })]));
    renderScreen(<PostingPage />);

    expect(await screen.findByText('5106040049')).toBeInTheDocument();
    expect(screen.getByText('No approved invoices waiting.')).toBeInTheDocument();
  });

  it('surfaces a failed load rather than an empty list', async () => {
    signIn();
    fakeApi({ ...routes(), 'GET /posting/ready': nestError(403, 'Forbidden resource') });
    renderScreen(<PostingPage />);

    expect(await screen.findByText('Forbidden resource')).toBeInTheDocument();
    expect(screen.queryByText('No approved invoices waiting.')).not.toBeInTheDocument();
  });
});
