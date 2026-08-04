import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UploadPage } from './UploadPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { invoiceDetail } from '../test-support/fixtures';

/**
 * The inbound screen — drag-and-drop, and the email channel beside it.
 *
 * One thing here is more than cosmetic: an uploaded document goes through the **whole**
 * pipeline inline, so the row that appears afterwards is the pipeline's verdict, not a
 * receipt. A document that was blocked has to look blocked. "Cleared automatically" on an
 * invoice sitting at EXCEPTION is the failure worth guarding — the clerk moves on and the
 * document never gets looked at.
 */

const pdf = (name = 'invoice.pdf') => new File(['%PDF-1.4'], name, { type: 'application/pdf' });

const routes = (over: Record<string, unknown> = {}) => ({
  'GET /inbound/messages': { body: [] },
  'POST /invoices/upload': { body: invoiceDetail({ status: 'PENDING_APPROVAL' }) },
  ...over,
});

const choose = async (...files: File[]) => {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  await userEvent.upload(input, files);
};

describe('uploading', () => {
  it('sends the file and shows what the pipeline decided', async () => {
    signIn();
    const fake = fakeApi(routes());
    renderScreen(<UploadPage />);
    await screen.findByText('Drop an invoice here');

    await choose(pdf());

    const call = fake.only('POST /invoices/upload');
    expect((call.body as FormData).get('file')).toBeInstanceOf(File);
    expect(await screen.findByText('Cleared automatically')).toBeInTheDocument();
    expect(screen.getByText('PENDING APPROVAL')).toBeInTheDocument();
  });

  it('SHOWS A BLOCKED DOCUMENT AS BLOCKED, NOT AS CLEARED', async () => {
    signIn();
    fakeApi(routes({
      'POST /invoices/upload': {
        body: invoiceDetail({
          status: 'EXCEPTION',
          exceptions: [{
            id: 'e1', invoiceId: 'inv-1', type: 'DUPLICATE_INVOICE',
            detail: 'An invoice with this number already exists for this vendor.',
            suggestedFix: null, resolvedAt: null, createdAt: '2026-05-04T09:00:00.000Z',
          }],
        }),
      },
    }));
    renderScreen(<UploadPage />);
    await screen.findByText('Drop an invoice here');

    await choose(pdf());

    expect(await screen.findByText('DUPLICATE INVOICE')).toBeInTheDocument();
    expect(screen.getByText('EXCEPTION')).toBeInTheDocument();
    expect(screen.queryByText('Cleared automatically')).not.toBeInTheDocument();
    expect(await screen.findByText('Received — blocked')).toBeInTheDocument();
  });

  it('marks a low-confidence document as needing review', async () => {
    signIn();
    fakeApi(routes({ 'POST /invoices/upload': { body: invoiceDetail({ status: 'NEEDS_REVIEW' }) } }));
    renderScreen(<UploadPage />);
    await screen.findByText('Drop an invoice here');

    await choose(pdf());
    expect(await screen.findByText('Received — needs review')).toBeInTheDocument();
  });

  it('KEEPS THE DOCUMENTS THAT SUCCEEDED WHEN A LATER ONE FAILS', async () => {
    // Files are sent one at a time. Discarding the batch on the first failure would leave a
    // clerk unable to tell which of five documents actually entered the system — and the
    // successful ones are already ingested server-side, so re-uploading them makes duplicates.
    signIn();
    let n = 0;
    fakeApi(routes({
      'POST /invoices/upload': () => {
        n += 1;
        return n === 1
          ? { body: invoiceDetail({ id: 'inv-a', invoiceNumber: 'FIRST', status: 'PENDING_APPROVAL' }) }
          : nestError(415, 'Unsupported file type');
      },
    }));
    renderScreen(<UploadPage />);
    await screen.findByText('Drop an invoice here');

    await choose(pdf('first.pdf'), pdf('second.pdf'));

    expect(await screen.findByText('Unsupported file type')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('FIRST')).toBeInTheDocument();
  });

  it('tells the sidebar the queue may have changed', async () => {
    // A document that clears validation is already parked at an approval node, which may be
    // the uploader's own.
    signIn();
    fakeApi(routes());
    let fired = 0;
    window.addEventListener('flowap:inbox-changed', () => { fired += 1; });
    renderScreen(<UploadPage />);
    await screen.findByText('Drop an invoice here');

    await choose(pdf());
    await waitFor(() => expect(fired).toBe(1));
  });

  it('SAYS EXTRACTION IS RUNNING AGAINST A MOCK', async () => {
    // The file really is stored and really is fetched, but the extractor returns fixed sample
    // documents. Without this sentence a clerk uploads their PDF, sees a different invoice's
    // numbers, and reasonably concludes the extraction is wrong rather than absent.
    signIn();
    fakeApi(routes());
    renderScreen(<UploadPage />);
    expect(await screen.findByText(/Extraction currently runs against a mock\./)).toBeInTheDocument();
  });
});

describe('the email channel', () => {
  it('shows what arrived and what was deliberately skipped, with reasons', async () => {
    // An operator asking "where is my invoice?" needs to see that it arrived and why nothing
    // came of it. An empty screen and a skipped attachment look identical otherwise.
    signIn();
    fakeApi(routes({
      'GET /inbound/messages': {
        body: [{
          id: 'm1',
          messageId: '<a@b>',
          fromAddress: 'billing@northwind.test',
          subject: 'Invoice 0001',
          receivedAt: '2026-05-04T08:00:00.000Z',
          invoicesCreated: 1,
          outcome: { accepted: 1, skipped: [{ filename: 'image001.png', reason: 'signature-image' }] },
          processedAt: '2026-05-04T08:01:00.000Z',
        }],
      },
    }));
    renderScreen(<UploadPage />);

    expect(await screen.findByText('billing@northwind.test')).toBeInTheDocument();
    expect(screen.getByText('image001.png: signature image')).toBeInTheDocument();
  });

  it('sweeps the mailbox on demand and reports what it found', async () => {
    signIn();
    const fake = fakeApi(routes({
      'POST /inbound/poll': { body: { fetched: 3, invoicesCreated: 2 } },
    }));
    renderScreen(<UploadPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(fake.only('POST /inbound/poll')).toBeTruthy();
    expect(await screen.findByText('Checked the mailbox: 3 message(s), 2 invoice(s).')).toBeInTheDocument();
    await waitFor(() => expect(fake.matching('GET /inbound/messages').length).toBeGreaterThan(1));
  });

  it('says the mailbox is not configured rather than reporting zero messages', async () => {
    // Zero fetched and "no mailbox configured" are different situations. Reporting the second
    // as the first sends an operator looking for a missing email that was never collected.
    signIn();
    fakeApi(routes({
      'POST /inbound/poll': { body: { configured: false, reason: 'INBOUND_IMAP_HOST is not set.' } },
    }));
    renderScreen(<UploadPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('INBOUND_IMAP_HOST is not set.')).toBeInTheDocument();
  });

  it('says nothing has arrived when nothing has', async () => {
    signIn();
    fakeApi(routes());
    renderScreen(<UploadPage />);
    expect(await screen.findByText('Nothing has arrived by email yet.')).toBeInTheDocument();
  });
});
