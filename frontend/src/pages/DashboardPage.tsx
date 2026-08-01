import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { DashboardSummary } from '../api/types';
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

  const { totals, byStatus, openExceptions, overdueApprovals, awaitingApproval, posted, recentActivity } = data;

  return (
    <>
      <div className="grid g-4">
        <div className="card">
          <span className="lbl">Invoices received</span>
          <div className="stat"><span className="v">{totals.invoices}</span></div>
        </div>
        <div className="card">
          <span className="lbl">Cleared without a human</span>
          <div className="stat">
            <span className="v" style={{ color: 'var(--clear)' }}>
              {totals.touchlessRate === null ? '—' : `${totals.touchlessRate}%`}
            </span>
            <span className="d">never entered review or exception</span>
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
            <span className="v" style={{ color: 'var(--violet)' }}>{posted.count}</span>
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
