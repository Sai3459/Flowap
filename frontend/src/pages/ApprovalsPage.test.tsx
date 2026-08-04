import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalsPage } from './ApprovalsPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { inboxItem, step } from '../test-support/fixtures';

/**
 * The approval screen — the money-adjacent one.
 *
 * An approval releases a payment, so the failures worth testing are not "the button does
 * nothing". They are the ones where the screen tells a person something that is not true:
 * a success message after a refusal, an invoice still sitting in a queue it has left, or a
 * queue that has not caught up so the same step can be decided twice.
 */

const inboxRoutes = (items = [inboxItem()]) => ({
  'GET /approvals/inbox': { body: items },
  'GET /approvals/history': { body: [] },
  'GET /users': { body: [{ id: 'u-colleague', name: 'Carla Colleague', email: 'c@acme.test', role: 'APPROVER' }] },
});

describe('deciding a step', () => {
  it('APPROVES THE STEP THE BUTTON BELONGS TO', async () => {
    // With several invoices on screen the interesting mistake is approving the wrong one —
    // shared state keyed wrongly, or a stale closure over the first row.
    signIn();
    const fake = fakeApi({
      ...inboxRoutes([
        inboxItem({ step: step({ id: 'step-a' }), invoiceId: 'inv-a', invoiceNumber: 'INV-A' }),
        inboxItem({ step: step({ id: 'step-b' }), invoiceId: 'inv-b', invoiceNumber: 'INV-B' }),
      ]),
      'POST /approvals/steps/*/decide': { body: {} },
    });
    renderScreen(<ApprovalsPage />);

    const cardB = (await screen.findByRole('link', { name: 'INV-B' })).closest('.card')!;
    await userEvent.click(within(cardB as HTMLElement).getByRole('button', { name: 'Approve' }));

    const call = fake.only('POST /approvals/steps/step-b/decide');
    expect(call.body).toEqual({ decision: 'APPROVE', comment: undefined });
    expect(fake.matching('POST /approvals/steps/step-a/decide')).toHaveLength(0);
  });

  it('sends the comment typed against that row', async () => {
    signIn();
    const fake = fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/decide': { body: {} } });
    renderScreen(<ApprovalsPage />);

    await userEvent.type(await screen.findByPlaceholderText('Comment (optional)'), 'checked against the PO');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(fake.only('POST /approvals/steps/step-1/decide').body).toEqual({
      decision: 'APPROVE',
      comment: 'checked against the PO',
    });
  });

  it('rejects with REJECT, not a second approve path', async () => {
    signIn();
    const fake = fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/decide': { body: {} } });
    renderScreen(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect((fake.only('POST /approvals/steps/step-1/decide').body as { decision: string }).decision).toBe('REJECT');
  });

  it('REFETCHES THE QUEUE AFTER A DECISION', async () => {
    // Without this the decided invoice stays on screen with a live Approve button. Approving
    // it again is a 4xx rather than a double payment, but an approver being told their queue
    // still holds something they have dealt with is how a real one gets decided twice.
    signIn();
    const fake = fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/decide': { body: {} } });
    renderScreen(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fake.matching('GET /approvals/inbox').length).toBeGreaterThan(1));
    expect(fake.matching('GET /approvals/history').length).toBeGreaterThan(1);
  });

  it('tells the sidebar its count has changed on the same tick', async () => {
    // The shell polls every 15s. Without this event the badge disagrees with the screen for
    // up to a quarter of a minute, which reads as the decision not having registered.
    signIn();
    fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/decide': { body: {} } });
    let fired = 0;
    window.addEventListener('flowap:inbox-changed', () => { fired += 1; });
    renderScreen(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fired).toBe(1));
  });

  it('confirms with the invoice it acted on', async () => {
    signIn();
    fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/decide': { body: {} } });
    renderScreen(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved INV-2026-0001.')).toBeInTheDocument();
    expect(await screen.findByText('Invoice approved')).toBeInTheDocument();
  });
});

describe('when the server refuses', () => {
  it('NEVER CLAIMS AN APPROVAL THAT DID NOT HAPPEN', async () => {
    // The Chart of Authority refuses an approval above the decider's limit, and the step
    // stays PENDING on purpose — a refused approval must not consume it. If the screen showed
    // "Approved …" anyway, the approver would walk away from an invoice still waiting on them.
    signIn();
    fakeApi({
      ...inboxRoutes(),
      'POST /approvals/steps/*/decide': nestError(
        403,
        'This invoice is 1296.00 USD, above your approval limit of 500.00 USD',
      ),
    });
    renderScreen(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/above your approval limit of 500.00 USD/)).toBeInTheDocument();
    // Asserted as "no success notice of any wording", not against one sentence — the failure
    // being guarded is the screen claiming an approval, and pinning a phrasing would let any
    // other phrasing of the same lie through.
    expect(document.querySelector('.notice.ok')).toBeNull();
    expect(screen.queryByText('Invoice approved')).not.toBeInTheDocument();
    // And the invoice is still there to be dealt with.
    expect(screen.getByRole('link', { name: 'INV-2026-0001' })).toBeInTheDocument();
  });

  it('shows a 403 on someone else\'s step as the server worded it', async () => {
    signIn();
    fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/decide': nestError(403, 'This step is not assigned to you') });
    renderScreen(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('This step is not assigned to you')).toBeInTheDocument();
  });

  it('clears a stale error when the next decision succeeds', async () => {
    signIn();
    const fake = fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/decide': nestError(403, 'no authority') });
    renderScreen(<ApprovalsPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('no authority')).toBeInTheDocument();

    fake.set('POST /approvals/steps/*/decide', { body: {} });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByText('no authority')).not.toBeInTheDocument());
  });
});

describe('delegation', () => {
  it('CANNOT BE FIRED WITHOUT CHOOSING A RECIPIENT', async () => {
    // An empty recipient would hand the step to nobody. Guarded in the UI because the
    // resulting 400 tells the approver nothing about what they did wrong.
    signIn();
    fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/delegate': { body: {} } });
    renderScreen(<ApprovalsPage />);

    expect(await screen.findByRole('button', { name: 'Delegate' })).toBeDisabled();
  });

  it('hands off to the chosen colleague and refreshes the queue', async () => {
    signIn();
    const fake = fakeApi({ ...inboxRoutes(), 'POST /approvals/steps/*/delegate': { body: {} } });
    renderScreen(<ApprovalsPage />);

    await userEvent.selectOptions(await screen.findByRole('combobox'), 'u-colleague');
    await userEvent.click(screen.getByRole('button', { name: 'Delegate' }));

    expect(fake.only('POST /approvals/steps/step-1/delegate').body).toEqual({
      toApproverId: 'u-colleague',
      comment: undefined,
    });
    expect(await screen.findByText(/keeps your original SLA deadline/)).toBeInTheDocument();
  });
});

describe('the queue itself', () => {
  it('says so plainly when there is nothing waiting', async () => {
    signIn();
    fakeApi(inboxRoutes([]));
    renderScreen(<ApprovalsPage />);
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
  });

  it('marks a step past its SLA as overdue', async () => {
    signIn();
    fakeApi(inboxRoutes([inboxItem({ step: step({ slaDueAt: '2020-01-01T00:00:00.000Z' }) })]));
    renderScreen(<ApprovalsPage />);
    expect(await screen.findByText('overdue')).toBeInTheDocument();
  });

  it('does not call a future deadline overdue', async () => {
    signIn();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    fakeApi(inboxRoutes([inboxItem({ step: step({ slaDueAt: future }) })]));
    renderScreen(<ApprovalsPage />);
    await screen.findByRole('link', { name: 'INV-2026-0001' });
    expect(screen.queryByText('overdue')).not.toBeInTheDocument();
  });

  it('shows the variance that is the reason this needs a decision', async () => {
    // A variance invoice reaches an approver *because* of the variance — it is the thing
    // being approved, so it belongs on the row rather than one click away.
    signIn();
    fakeApi(inboxRoutes([inboxItem({ priceVariancePct: 15.2, quantityVariancePct: 4 })]));
    renderScreen(<ApprovalsPage />);
    expect(await screen.findByText('price +15.2%')).toBeInTheDocument();
    expect(screen.getByText('qty +4.0%')).toBeInTheDocument();
  });

  it('surfaces a failed load rather than showing an empty queue', async () => {
    // "Nothing is waiting on you" when the request failed is the dangerous rendering: an
    // approver reads it as done and stops looking.
    signIn();
    fakeApi({ ...inboxRoutes(), 'GET /approvals/inbox': nestError(500, 'database is down') });
    renderScreen(<ApprovalsPage />);

    expect(await screen.findByText('database is down')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting on you.')).not.toBeInTheDocument();
  });
});
