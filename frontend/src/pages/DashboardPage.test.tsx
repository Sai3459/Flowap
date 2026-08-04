import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { DashboardPage } from './DashboardPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { touchlessPoint, touchlessSummary } from '../test-support/fixtures';

/**
 * The overview. It is a single aggregate read, so most of it is rendering — but two numbers on
 * it get quoted in conversations about whether the product is working, and both have an
 * "unknown" case that must not render as a confident zero.
 */

const summary = (over: Record<string, unknown> = {}) => ({
  totals: { invoices: 18, touchlessRate: 25, straightThroughRate: 0, purchaseOrders: 2, vendors: 4 },
  touchless: touchlessSummary(),
  touchlessTrend: [touchlessPoint()],
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

    // Scoped to the tile: the same percentage legitimately appears again in the breakdown
    // table's share-of-completed column, and an unscoped match would pass on the wrong one.
    const touchlessTile = screen.getByText('Touchless').closest('.card') as HTMLElement;
    expect(within(touchlessTile).getByText('25%')).toBeInTheDocument();
    expect(within(touchlessTile).getByText(/1\/4 completed/)).toBeInTheDocument();

    const stTile = screen.getByText('Straight-through').closest('.card') as HTMLElement;
    expect(within(stTile).getByText('0%')).toBeInTheDocument();

    const exceptions = screen.getByText('Open exceptions').closest('.card') as HTMLElement;
    expect(within(exceptions).getByText(/MISSING.PO/)).toBeInTheDocument();
    expect(within(exceptions).getByText('2')).toBeInTheDocument();
  });

  it('SHOWS AN UNKNOWN TOUCHLESS RATE AS UNKNOWN, NOT AS ZERO', async () => {
    // With nothing completed there is no rate to report. Rendering 0% would say the pipeline
    // is clearing nothing, which is a very different claim from nothing having finished — and
    // this is the number the product is now positioned on.
    signIn();
    fakeApi({
      'GET /dashboard': {
        body: summary({
          totals: { invoices: 3, touchlessRate: null, straightThroughRate: null, purchaseOrders: 0, vendors: 0 },
          touchless: touchlessSummary({
            completedInvoices: 0,
            touchless: 0,
            straightThrough: 0,
            touchlessRate: null,
            straightThroughRate: null,
            byPrimaryReason: { CORRECTION: 0, APPROVAL: 0, CODING: 0, POSTING: 0, EXCEPTION: 0 },
            cycleHours: null,
            inFlight: 3,
          }),
        }),
      },
    });
    renderScreen(<DashboardPage />);

    expect(await screen.findAllByText('—')).not.toHaveLength(0);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByText(/No invoice has reached the ERP yet/)).toBeInTheDocument();
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

describe('the touchless panel', () => {
  const render = async (over: Parameters<typeof touchlessSummary>[0] = {}, trend = [touchlessPoint()]) => {
    signIn();
    fakeApi({ 'GET /dashboard': { body: summary({ touchless: touchlessSummary(over), touchlessTrend: trend }) } });
    renderScreen(<DashboardPage />);
    return (await screen.findByText('Touchless processing')).closest('.card') as HTMLElement;
  };

  it('STATES THE DENOMINATOR AND THE WORK IT EXCLUDES', async () => {
    // The previous metric divided by every invoice ever received, including ones still in
    // flight, and nothing on screen said so. A rate whose denominator is invisible cannot be
    // checked by the person reading it — which is the whole problem with quoting it.
    const panel = await render();
    expect(within(panel).getByText(/4 completed · 14 still in flight/)).toBeInTheDocument();
    expect(within(panel).getByText(/not from current status/)).toBeInTheDocument();
  });

  it('SHOWS BOTH RATES, SO THE FRIENDLIER ONE IS NOT QUOTED ALONE', async () => {
    // 25% touchless and 0% straight-through are both true and mean different things. The
    // published 80% benchmark is the second definition, so showing only the first next to it
    // would be comparing two different measurements.
    await render();
    const touchlessTile = screen.getByText('Touchless').closest('.card') as HTMLElement;
    const stTile = screen.getByText('Straight-through').closest('.card') as HTMLElement;

    expect(within(touchlessTile).getByText('25%')).toBeInTheDocument();
    expect(within(touchlessTile).getByText(/no correction, no manual approval/)).toBeInTheDocument();
    expect(within(stTile).getByText('0%')).toBeInTheDocument();
    expect(within(stTile).getByText(/zero human touches of any kind/)).toBeInTheDocument();
  });

  it('ATTRIBUTES EACH TOUCHED INVOICE TO ONE REASON, SO THE COLUMN SUMS', async () => {
    // Read as "fix this and N invoices become touchless". If an invoice were counted under
    // every reason it hit, the column would exceed the number of invoices and the panel would
    // overstate what any single fix buys.
    const panel = await render();
    const rows = within(panel).getAllByRole('row').slice(1);
    const counts = rows.map((r) => Number(r.querySelectorAll('td')[1].textContent));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3); // 4 completed − 1 touchless
    expect(within(panel).getByText('Why 3 invoice(s) needed a human')).toBeInTheDocument();
  });

  it('names the reasons in words rather than enum values', async () => {
    const panel = await render();
    expect(within(panel).getByText('A field had to be corrected')).toBeInTheDocument();
    expect(within(panel).getByText('Someone had to approve it')).toBeInTheDocument();
    expect(within(panel).queryByText('CORRECTION')).not.toBeInTheDocument();
  });

  it('DISCLOSES AUTONOMOUS ACTIONS, WHICH ARE WHAT MOVE THE RATE', async () => {
    // A copilot action is deliberately not a human touch, so labelling something COPILOT
    // improves this number. Reporting the count keeps "the pipeline needed less" separable
    // from "the copilot did more" — without it the rate could rise for either reason and the
    // reader could not tell which.
    const panel = await render({ copilotActions: 7 });
    expect(within(panel).getByText(/resolved\s+autonomously and are not counted as human touches/)).toBeInTheDocument();
    expect(within(panel).getByText('7')).toBeInTheDocument();
  });

  it('says nothing about autonomy when nothing was autonomous', async () => {
    const panel = await render({ copilotActions: 0 });
    expect(within(panel).queryByText(/autonomously/)).not.toBeInTheDocument();
  });

  it('reports a clean sweep rather than an empty table', async () => {
    const panel = await render({
      completedInvoices: 3,
      touchless: 3,
      touchlessRate: 100,
      byPrimaryReason: { CORRECTION: 0, APPROVAL: 0, CODING: 0, POSTING: 0, EXCEPTION: 0 },
    });
    expect(within(panel).getByText('Every completed invoice cleared without a human.')).toBeInTheDocument();
  });

  it('reports cycle time as percentiles', async () => {
    // A mean is dragged somewhere no invoice has been by a few stuck behind an absent approver.
    const panel = await render({ cycleHours: { median: 4.5, p90: 30 } });
    expect(within(panel).getByText(/Median receipt-to-posted 4.5h, 90th percentile 30h/)).toBeInTheDocument();
  });
});

describe('the touchless trend', () => {
  const renderTrend = async (trend: ReturnType<typeof touchlessPoint>[]) => {
    signIn();
    fakeApi({ 'GET /dashboard': { body: summary({ touchlessTrend: trend }) } });
    renderScreen(<DashboardPage />);
    return (await screen.findByText('Touchless processing')).closest('.card') as HTMLElement;
  };

  it('SHOWS THE RATE WEEK BY WEEK, NOT JUST THE LATEST NUMBER', async () => {
    // "Over time" is the half of the ask a single percentage cannot answer: whether the number
    // is moving, and in which direction.
    const panel = await renderTrend([
      touchlessPoint({ bucket: '2026-07-12', touchlessRate: 10 }),
      touchlessPoint({ bucket: '2026-07-19', touchlessRate: 40 }),
      touchlessPoint({ bucket: '2026-07-26', touchlessRate: 25 }),
    ]);

    const bars = panel.querySelectorAll('.trend-bar');
    expect(bars).toHaveLength(3);
    expect(within(panel).getByText('10%')).toBeInTheDocument();
    expect(within(panel).getByText('40%')).toBeInTheDocument();
  });

  it('STATES THE DENOMINATOR BEHIND EACH BAR', async () => {
    // A 100% week over one invoice and a 100% week over two hundred are not the same claim,
    // and a bar chart flattens exactly that difference. The count is on the bar itself.
    const panel = await renderTrend([
      touchlessPoint({ bucket: '2026-07-26', touchlessRate: 100, completedInvoices: 1, touchless: 1 }),
    ]);
    const bar = panel.querySelector('.trend-bar')!;
    expect(bar.getAttribute('title')).toMatch(/over 1 completed invoice/);
    expect(bar.getAttribute('title')).toMatch(/100% touchless/);
  });

  it('renders nothing rather than an empty chart when no week has completed', async () => {
    const panel = await renderTrend([]);
    expect(panel.querySelector('.trend')).toBeNull();
  });

  it('shows a week with no completions as unknown rather than zero', async () => {
    const panel = await renderTrend([touchlessPoint({ completedInvoices: 0, touchless: 0, touchlessRate: null })]);
    expect(within(panel).getByText('—')).toBeInTheDocument();
  });
});
