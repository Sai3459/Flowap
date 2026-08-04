import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { DashboardPage } from './DashboardPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';

/**
 * The overview. It is a single aggregate read, so most of it is rendering — but two numbers on
 * it get quoted in conversations about whether the product is working, and both have an
 * "unknown" case that must not render as a confident zero.
 */

const summary = (over: Record<string, unknown> = {}) => ({
  totals: { invoices: 18, touchlessRate: 61, purchaseOrders: 2, vendors: 4 },
  byStatus: [
    { status: 'PENDING_APPROVAL', count: 3, value: '4200.00' },
    { status: 'POSTED', count: 5, value: '9000.00' },
  ],
  openExceptions: [{ type: 'MISSING_PO', count: 2 }],
  overdueApprovals: 1,
  awaitingApproval: { count: 3, value: '4200.00' },
  posted: { count: 5, value: '9000.00' },
  recentActivity: [
    { action: 'INVOICE_POSTED', createdAt: '2026-05-04T09:00:00.000Z', invoiceId: 'inv-1', invoiceNumber: 'INV-1', detail: null },
  ],
  ...over,
});

describe('the overview', () => {
  it('reports the headline numbers the server sent', async () => {
    signIn();
    fakeApi({ 'GET /dashboard': { body: summary() } });
    renderScreen(<DashboardPage />);

    expect(await screen.findByText('18')).toBeInTheDocument();
    expect(screen.getByText('61%')).toBeInTheDocument();

    const exceptions = screen.getByText('Open exceptions').closest('.card') as HTMLElement;
    expect(within(exceptions).getByText(/MISSING.PO/)).toBeInTheDocument();
    expect(within(exceptions).getByText('2')).toBeInTheDocument();
  });

  it('SHOWS AN UNKNOWN TOUCHLESS RATE AS UNKNOWN, NOT AS ZERO', async () => {
    // With no invoices there is no rate to report. Rendering 0% would say the pipeline is
    // clearing nothing, which is a very different claim from having nothing to clear — and
    // touchless rate is the number this product is judged on.
    signIn();
    fakeApi({
      'GET /dashboard': {
        body: summary({ totals: { invoices: 0, touchlessRate: null, purchaseOrders: 0, vendors: 0 } }),
      },
    });
    renderScreen(<DashboardPage />);

    expect(await screen.findByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('reads the audit trail back as sentences rather than enum names', async () => {
    signIn();
    fakeApi({ 'GET /dashboard': { body: summary() } });
    renderScreen(<DashboardPage />);

    expect(await screen.findByText('Posted to ERP')).toBeInTheDocument();
    expect(screen.queryByText('INVOICE_POSTED')).not.toBeInTheDocument();
  });

  it('shows the pipeline broken down by status', async () => {
    signIn();
    fakeApi({ 'GET /dashboard': { body: summary() } });
    renderScreen(<DashboardPage />);

    const pipeline = (await screen.findByText('Pipeline')).closest('.card') as HTMLElement;
    expect(within(pipeline).getByText('PENDING APPROVAL')).toBeInTheDocument();
    expect(within(pipeline).getByText('4,200.00')).toBeInTheDocument();
  });

  it('reports a failed load rather than an empty dashboard', async () => {
    signIn();
    fakeApi({ 'GET /dashboard': nestError(403, 'Forbidden resource') });
    renderScreen(<DashboardPage />);
    expect(await screen.findByText('Forbidden resource')).toBeInTheDocument();
  });
});
