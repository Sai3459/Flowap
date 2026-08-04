import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useInboxWatch, notifyInboxChanged } from './useInboxWatch';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { inboxItem, step } from '../test-support/fixtures';

/**
 * The in-app arrival watcher.
 *
 * Approval is a pull model — a step is created and the approver has to go looking for it — and
 * this is the only thing that tells them otherwise while the tab is open. Its one subtle
 * requirement is that it compares **step ids, not counts**: a poll in which one invoice is
 * decided and another arrives leaves the count unchanged, and a count check would miss the
 * arrival entirely. That is the case the tests below are built around.
 */

function Watcher() {
  const { waiting } = useInboxWatch('u-manager');
  return <span data-testid="waiting">{waiting}</span>;
}

const waitingCount = () => Number(screen.getByTestId('waiting').textContent);

describe('useInboxWatch', () => {
  it('announces what is already waiting on the first look', async () => {
    signIn();
    fakeApi({ 'GET /approvals/inbox': { body: [inboxItem()] } });
    renderScreen(<Watcher />);

    expect(await screen.findByText('Invoice ready to be approved')).toBeInTheDocument();
    expect(await screen.findByText('INV-2026-0001 · Northwind Traders')).toBeInTheDocument();
    await waitFor(() => expect(waitingCount()).toBe(1));
  });

  it('does not announce the same queue twice', async () => {
    signIn();
    fakeApi({ 'GET /approvals/inbox': { body: [inboxItem()] } });
    renderScreen(<Watcher />);
    await screen.findByText('Invoice ready to be approved');

    notifyInboxChanged();
    await waitFor(() => expect(screen.getAllByText('Invoice ready to be approved')).toHaveLength(1));
  });

  it('ANNOUNCES AN ARRIVAL THAT LEAVES THE COUNT UNCHANGED', async () => {
    // One step decided, one step arrived: still one item waiting. Comparing counts would
    // report nothing and the new invoice would sit unnoticed until the approver went looking —
    // which is the exact behaviour this hook exists to replace.
    signIn();
    const fake = fakeApi({
      'GET /approvals/inbox': { body: [inboxItem({ step: step({ id: 'step-old' }), invoiceNumber: 'OLD' })] },
    });
    renderScreen(<Watcher />);
    await screen.findByText('OLD · Northwind Traders');

    fake.set('GET /approvals/inbox', {
      body: [inboxItem({ step: step({ id: 'step-new' }), invoiceNumber: 'NEW' })],
    });
    notifyInboxChanged();

    expect(await screen.findByText('NEW · Northwind Traders')).toBeInTheDocument();
    expect(waitingCount()).toBe(1);
  });

  it('announces only the new ones when several are already known', async () => {
    signIn();
    const fake = fakeApi({
      'GET /approvals/inbox': {
        body: [
          inboxItem({ step: step({ id: 'a' }), invoiceNumber: 'A' }),
          inboxItem({ step: step({ id: 'b' }), invoiceNumber: 'B' }),
        ],
      },
    });
    renderScreen(<Watcher />);
    await screen.findByText('2 invoices ready to be approved');

    fake.set('GET /approvals/inbox', {
      body: [
        inboxItem({ step: step({ id: 'a' }), invoiceNumber: 'A' }),
        inboxItem({ step: step({ id: 'b' }), invoiceNumber: 'B' }),
        inboxItem({ step: step({ id: 'c' }), invoiceNumber: 'C' }),
      ],
    });
    notifyInboxChanged();

    // The toast names C alone, not "3 invoices" — only one of them is news.
    expect(await screen.findByText('C · Northwind Traders')).toBeInTheDocument();
    await waitFor(() => expect(waitingCount()).toBe(3));
  });

  it('says nothing when a poll fails, rather than toasting an error', async () => {
    // A transient failure is not worth interrupting someone for; the next poll catches up.
    signIn();
    fakeApi({ 'GET /approvals/inbox': nestError(503, 'upstream down') });
    renderScreen(<Watcher />);

    await waitFor(() => expect(waitingCount()).toBe(0));
    expect(screen.queryByText('upstream down')).not.toBeInTheDocument();
    expect(screen.queryByText(/ready to be approved/)).not.toBeInTheDocument();
  });

  it('does not treat a recovered queue as a fresh arrival storm', async () => {
    // A failed first poll must not leave `seen` initialised. If it did, the recovery would
    // announce nothing at all, and the approver would never hear about what is waiting.
    signIn();
    const fake = fakeApi({ 'GET /approvals/inbox': nestError(503, 'upstream down') });
    renderScreen(<Watcher />);
    await waitFor(() => expect(waitingCount()).toBe(0));

    fake.set('GET /approvals/inbox', { body: [inboxItem()] });
    notifyInboxChanged();
    expect(await screen.findByText('Invoice ready to be approved')).toBeInTheDocument();
  });

  it('polls on nothing at all when there is no acting user', async () => {
    // The shell renders before `GET /auth/me` resolves, and an inbox poll for nobody would
    // 401 on every tick.
    signIn();
    const fake = fakeApi({ 'GET /approvals/inbox': { body: [] } });
    function NoUser() {
      const { waiting } = useInboxWatch('');
      return <span data-testid="waiting">{waiting}</span>;
    }
    renderScreen(<NoUser />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.calls).toHaveLength(0);
  });
});
