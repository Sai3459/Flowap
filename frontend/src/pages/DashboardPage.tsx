import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { DashboardSummary, TouchKind, TouchlessSummary } from '../api/types';
import { useApi } from '../lib/useApi';
import { ErrorNote, Loading, Money, StatusPill } from '../components/ui';

/** Audit action → human sentence. The trail is written for machines; this reads it back. */
const ACTION_TEXT: Record<string, string> = {
  INVOICE_RECEIVED: 'Document received',
  AI_EXTRACTION_COMPLETE: 'Fields extracted',
  PO_MATCHED: 'Matched to purchase order',
  PO_MATCH_FAILED: 'Purchase order not found',
  APPROVAL_INSTANCE_CREATED: 'Approval started',
  APPROVAL_STEP_CREATED: 'Sent to approver',
  APPROVAL_STEP_DECIDED: 'Approver decided',
  APPROVAL_STEP_DELEGATED: 'Approval delegated',
  APPROVAL_INSTANCE_COMPLETED: 'Approval completed',
  APPROVAL_SLA_BREACHED: 'SLA breached',
  FIELD_CORRECTED: 'Field corrected',
  LINE_CODED: 'Line coded',
  INVOICE_POSTED: 'Posted to ERP',
  REVALIDATION_STARTED: 'Re-validation started',
  REVALIDATION_COMPLETE: 'Re-validated',
  REVALIDATION_SKIPPED: 'Re-validation skipped',
  PURCHASE_ORDER_SYNCED: 'Purchase order synced',
  GOODS_RECEIPT_RECORDED: 'Goods receipt recorded',
};

export function DashboardPage() {
  const { data, loading, error } = useApi<DashboardSummary>(() => api.dashboard());

  if (loading) return <Loading what="overview" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const { totals, touchless, byStatus, openExceptions, overdueApprovals, awaitingApproval, posted, recentActivity } = data;

  return (
    <>
      <div className="grid g-4">
        <div className="card">
          <span className="lbl">Invoices received</span>
          <div className="stat"><span className="v">{totals.invoices}</span></div>
        </div>
        <div className="card">
          <span className="lbl">Touchless</span>
          <div className="stat">
            <span className="v" style={{ color: 'var(--clear)' }}>
              {totals.touchlessRate === null ? '—' : `${totals.touchlessRate}%`}
            </span>
            <span className="d">
              {touchless.completedInvoices === 0
                ? 'nothing has completed yet'
                : `no correction, no manual approval · ${touchless.touchless}/${touchless.completedInvoices} completed`}
            </span>
          </div>
        </div>
        <div className="card">
          <span className="lbl">Straight-through</span>
          <div className="stat">
            <span className="v" style={{ color: 'var(--clear)' }}>
              {totals.straightThroughRate === null ? '—' : `${totals.straightThroughRate}%`}
            </span>
            {/*
              The stricter number, and the only one comparable to a published benchmark: it
              also counts coding the lines and clicking Post, which the industry's "zero
              touches, receipt to payment" figure includes. Shown beside the friendlier number
              rather than instead of it, so nobody quotes the friendlier one against an 80%
              external claim by accident.
            */}
            <span className="d">zero human touches of any kind, receipt to posted</span>
          </div>
        </div>
        <div className="card">
          <span className="lbl">Awaiting approval</span>
          <div className="stat">
            <span className="v" style={{ color: 'var(--inflight)' }}>{awaitingApproval.count}</span>
            <span className="d"><Money amount={awaitingApproval.value} /> in value</span>
          </div>
        </div>
        <div className="card">
          <span className="lbl">Overdue approvals</span>
          <div className="stat">
            <span className="v" style={{ color: overdueApprovals > 0 ? 'var(--blocked)' : undefined }}>{overdueApprovals}</span>
            <span className="d">past their SLA</span>
          </div>
        </div>
      </div>

      <TouchlessPanel touchless={touchless} />

      <div className="grid g-2">
        <div className="card">
          <div className="card-head"><h2>Pipeline</h2><span className="lbl">by status</span></div>
          {byStatus.length === 0 ? (
            <p className="mute small">No invoices yet.</p>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Status</th><th className="r">Count</th><th className="r">Value</th></tr></thead>
                <tbody>
                  {byStatus.map((s) => (
                    <tr key={s.status}>
                      <td><StatusPill status={s.status} /></td>
                      <td className="r">{s.count}</td>
                      <td className="r"><Money amount={s.value} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h2>Open exceptions</h2><span className="lbl">unresolved</span></div>
          {openExceptions.length === 0 ? (
            <p className="mute small">Nothing outstanding — every exception has been resolved.</p>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th>Type</th><th className="r">Count</th></tr></thead>
                <tbody>
                  {openExceptions.map((e) => (
                    <tr key={e.type}>
                      <td style={{ color: 'var(--review)' }}>{e.type.replace(/_/g, ' ')}</td>
                      <td className="r">{e.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row small">
            <Link to="/review">Open the review queue →</Link>
          </div>
        </div>
      </div>

      <div className="grid g-2">
        <div className="card">
          <div className="card-head"><h2>Posted to the ERP</h2><span className="lbl">simulated</span></div>
          <div className="stat">
            <span className="v" style={{ color: 'var(--posted)' }}>{posted.count}</span>
            <span className="d"><Money amount={posted.value} /> handed back</span>
          </div>
          <p className="mute small">
            Posting generates an ERP document number locally. No ERP is contacted — a real connector
            replaces one method and fills the same columns.
          </p>
          <div className="row small"><Link to="/posting">Go to posting →</Link></div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Master data</h2></div>
          <div className="grid g-3">
            <div className="stat"><span className="v">{totals.purchaseOrders}</span><span className="d">purchase orders</span></div>
            <div className="stat"><span className="v">{totals.vendors}</span><span className="d">vendors</span></div>
          </div>
          <div className="row small"><Link to="/purchase-orders">Purchase orders →</Link></div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Recent activity</h2><span className="lbl">audit trail</span></div>
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>When</th><th>Event</th><th>Invoice</th></tr></thead>
            <tbody>
              {recentActivity.map((a, i) => (
                <tr key={`${a.createdAt}-${i}`}>
                  <td className="mute">{new Date(a.createdAt).toLocaleString()}</td>
                  <td>{ACTION_TEXT[a.action] ?? a.action}</td>
                  <td>
                    {a.invoiceId
                      ? <Link to={`/invoices/${a.invoiceId}`}>{a.invoiceNumber ?? a.invoiceId.slice(0, 8)}</Link>
                      : <span className="mute">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** Human-readable names for the reasons an invoice was not touchless. */
const REASON_LABEL: Record<string, string> = {
  CORRECTION: 'A field had to be corrected',
  APPROVAL: 'Someone had to approve it',
  CODING: 'Lines had to be coded',
  POSTING: 'Someone had to post it',
  EXCEPTION: 'Someone had to intervene',
};

/**
 * Why the rate is what it is.
 *
 * A percentage on its own is a scoreboard; this is the part that is actionable. Each completed
 * invoice that needed a human is attributed to **one** reason — the earliest in the pipeline,
 * since a bad extraction is what causes the correction that causes the re-approval — so the
 * counts sum to the number of touched invoices and can be read as "fix this and N become
 * touchless".
 *
 * It also states the denominator and the in-flight count on screen. The previous version of
 * this metric divided by every invoice ever received, including ones that had not finished, and
 * nothing on the dashboard said so.
 */
function TouchlessPanel({ touchless }: { touchless: TouchlessSummary }) {
  const reasons = (Object.keys(REASON_LABEL) as TouchKind[])
    .map((kind) => ({ kind, count: touchless.byPrimaryReason[kind] ?? 0 }))
    .filter((r) => r.count > 0);

  const touched = touchless.completedInvoices - touchless.touchless;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Touchless processing</h2>
        <span className="lbl">
          {touchless.completedInvoices} completed · {touchless.inFlight} still in flight
        </span>
      </div>

      {touchless.completedInvoices === 0 ? (
        <p className="mute small">
          No invoice has reached the ERP yet, so there is no rate to report. This is deliberately
          blank rather than 0%: nothing has finished, which is not the same as nothing clearing.
        </p>
      ) : (
        <>
          <p className="dim small">
            Measured from the audit trail of the {touchless.completedInvoices} invoice(s) that have
            been posted — not from current status, and not counting work still in progress.
            {touchless.cycleHours &&
              ` Median receipt-to-posted ${touchless.cycleHours.median}h, 90th percentile ${touchless.cycleHours.p90}h.`}
          </p>

          {touchless.copilotActions > 0 && (
            // Autonomous actions do not count as touches, which means they move this number.
            // Stating how many there were keeps "the rate improved" separable from "the copilot
            // did more", which is the distinction that makes the rate trustworthy.
            <p className="small">
              <strong>{touchless.copilotActions}</strong> action(s) in this set were resolved
              autonomously and are not counted as human touches.
            </p>
          )}

          {reasons.length === 0 ? (
            <p className="small" style={{ color: 'var(--clear)' }}>
              Every completed invoice cleared without a human.
            </p>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Why {touched} invoice(s) needed a human</th>
                    <th className="r">Invoices</th>
                    <th className="r">Share of completed</th>
                  </tr>
                </thead>
                <tbody>
                  {reasons.map((r) => (
                    <tr key={r.kind}>
                      <td>{REASON_LABEL[r.kind]}</td>
                      <td className="r mono">{r.count}</td>
                      <td className="r mono">
                        {Math.round((r.count / touchless.completedInvoices) * 1000) / 10}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
