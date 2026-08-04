import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { ReviewQueuePage } from './ReviewQueuePage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { invoiceDetail } from '../test-support/fixtures';

/**
 * The review queue. Two different reasons land an invoice here — a recorded exception and a
 * low-confidence extraction — and they need different work from a person, so the screen keeps
 * them apart rather than collapsing both into "needs attention".
 */

const exception = (over = {}) => ({
  id: 'e1',
  invoiceId: 'inv-1',
  type: 'MISSING_PO',
  detail: 'No purchase order PO-9999 exists for this tenant.',
  suggestedFix: 'Correct the PO number, or sync the order from the ERP.',
  resolvedAt: null as string | null,
  createdAt: '2026-05-04T09:00:00.000Z',
  ...over,
});

describe('what the queue shows', () => {
  it('spells out an exception with its suggested fix', async () => {
    signIn();
    fakeApi({
      'GET /invoices/exceptions': {
        body: [invoiceDetail({ status: 'EXCEPTION', exceptions: [exception()], fieldConfidence: {} })],
      },
    });
    renderScreen(<ReviewQueuePage />);

    expect(await screen.findByText('MISSING PO')).toBeInTheDocument();
    expect(screen.getByText(/No purchase order PO-9999 exists/)).toBeInTheDocument();
    expect(screen.getByText(/sync the order from the ERP/)).toBeInTheDocument();
  });

  it('NAMES THE LOW-CONFIDENCE FIELDS AND THEIR SCORES', async () => {
    // The per-field design's payoff: a reviewer is sent to the two fields that need a look
    // rather than being asked to re-read the document. Listing the fields without the scores
    // would lose the difference between "check this" and "this is probably wrong".
    signIn();
    fakeApi({
      'GET /invoices/exceptions': {
        body: [invoiceDetail({
          status: 'NEEDS_REVIEW',
          exceptions: [],
          fieldConfidence: {
            poNumber: { confidence: 0.75, source: 'AI_EXTRACTED' },
            taxAmount: { confidence: 0.6, source: 'AI_EXTRACTED' },
            totalAmount: { confidence: 0.99, source: 'AI_EXTRACTED' },
          },
        })],
      },
    });
    renderScreen(<ReviewQueuePage />);

    expect(await screen.findByText('LOW CONFIDENCE EXTRACTION')).toBeInTheDocument();
    expect(screen.getByText(/PO number \(75%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Tax \(60%\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 field\(s\) below the review threshold/)).toBeInTheDocument();
    expect(screen.queryByText(/Total \(gross\) \(99%\)/)).not.toBeInTheDocument();
  });

  it('does not re-flag a field a human already corrected', async () => {
    signIn();
    fakeApi({
      'GET /invoices/exceptions': {
        body: [invoiceDetail({
          status: 'NEEDS_REVIEW',
          exceptions: [exception()],
          fieldConfidence: { poNumber: { confidence: 0.3, source: 'HUMAN_CORRECTED' } },
        })],
      },
    });
    renderScreen(<ReviewQueuePage />);

    await screen.findByText('MISSING PO');
    expect(screen.queryByText('LOW CONFIDENCE EXTRACTION')).not.toBeInTheDocument();
  });

  it('HIDES AN EXCEPTION THAT RE-VALIDATION ALREADY RESOLVED', async () => {
    // Resolved exceptions are kept rather than deleted, so the history survives. Showing one
    // in the queue would send someone to fix a problem that no longer exists.
    signIn();
    fakeApi({
      'GET /invoices/exceptions': {
        body: [invoiceDetail({
          status: 'NEEDS_REVIEW',
          fieldConfidence: {},
          exceptions: [
            exception({ id: 'old', type: 'MISSING_PO', resolvedAt: '2026-05-05T09:00:00.000Z' }),
            exception({ id: 'new', type: 'PO_MISMATCH', detail: 'Billed price is 15.2% above the order.' }),
          ],
        })],
      },
    });
    renderScreen(<ReviewQueuePage />);

    expect(await screen.findByText('PO MISMATCH')).toBeInTheDocument();
    expect(screen.queryByText('MISSING PO')).not.toBeInTheDocument();
  });

  it('says the queue is empty when it is', async () => {
    signIn();
    fakeApi({ 'GET /invoices/exceptions': { body: [] } });
    renderScreen(<ReviewQueuePage />);
    expect(await screen.findByText(/every invoice cleared automatically/)).toBeInTheDocument();
  });

  it('reports a failed load rather than claiming the queue is clear', async () => {
    signIn();
    fakeApi({ 'GET /invoices/exceptions': nestError(500, 'database is down') });
    renderScreen(<ReviewQueuePage />);

    expect(await screen.findByText('database is down')).toBeInTheDocument();
    expect(screen.queryByText(/every invoice cleared automatically/)).not.toBeInTheDocument();
  });
});
