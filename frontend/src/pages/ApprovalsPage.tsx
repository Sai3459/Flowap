import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, session } from '../api/client';
import type { ApprovalHistoryItem, InboxItem, TenantUser } from '../api/types';
import { useApi } from '../lib/useApi';
import { Empty, ErrorNote, Loading, Money, StatusPill, StepPill } from '../components/ui';

/**
 * The approval app: one person's queue and their decision history.
 *
 * This is a **pull** model. Nothing emails or notifies the next approver when their turn
 * arrives — their step is simply created and appears here. That is a genuine gap versus a
 * production AP tool, and this screen is what keeps it workable in the meantime.
 */
export function ApprovalsPage() {
  const approverId = session.userId();
  const [tab, setTab] = useState<'inbox' | 'history'>('inbox');
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [delegateTo, setDelegateTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const inbox = useApi<InboxItem[]>(() => api.inbox(approverId), [approverId]);
  const history = useApi<ApprovalHistoryItem[]>(() => api.approvalHistory(approverId), [approverId]);
  const { data: users } = useApi<TenantUser[]>(() => api.listUsers(), []);

  if (!approverId) return <div className="notice">Pick who you are acting as in the sidebar first.</div>;

  async function act(stepId: string, fn: () => Promise<unknown>, message: string) {
    setBusyStep(stepId);
    setError(null);
    setFlash(null);
    try {
      await fn();
      setFlash(message);
      inbox.reload();
      history.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyStep(null);
    }
  }

  return (
    <>
      <div className="row">
        <button className={tab === 'inbox' ? 'primary' : ''} onClick={() => setTab('inbox')}>
          Waiting on me {inbox.data ? `(${inbox.data.length})` : ''}
        </button>
        <button className={tab === 'history' ? 'primary' : ''} onClick={() => setTab('history')}>
          My history {history.data ? `(${history.data.length})` : ''}
        </button>
      </div>

      {flash && <div className="notice ok">{flash}</div>}
      {error && <ErrorNote message={error} />}

      {tab === 'inbox' && (
        inbox.loading ? <Loading what="your approvals" />
        : inbox.error ? <ErrorNote message={inbox.error} />
        : (inbox.data ?? []).length === 0 ? <Empty>Nothing is waiting on you.</Empty>
        : (
          <div className="stack">
            {(inbox.data ?? []).map((item) => {
              const overdue = item.step.slaDueAt && new Date(item.step.slaDueAt) < new Date();
              return (
                <div className="card" key={item.step.id}>
                  <div className="row-between">
                    <h2>
                      <Link to={`/invoices/${item.invoiceId}`}>{item.invoiceNumber ?? 'Untitled'}</Link>
                      <span className="mute mono small" style={{ marginLeft: '0.6rem' }}>{item.vendorName ?? 'unresolved vendor'}</span>
                    </h2>
                    <div className="row">
                      {overdue && <span className="pill p-blocked">overdue</span>}
                      <span className="mono">{<Money amount={item.totalAmount} currency={item.currency} />}</span>
                    </div>
                  </div>

                  <div className="row small dim">
                    <span>PO <span className="mono">{item.poNumber ?? 'non-PO'}</span></span>
                    {item.priceVariancePct !== null && (
                      <span className="pill p-review">price +{item.priceVariancePct.toFixed(1)}%</span>
                    )}
                    {item.quantityVariancePct !== null && (
                      <span className="pill p-review">qty +{item.quantityVariancePct.toFixed(1)}%</span>
                    )}
                    {item.step.slaDueAt && (
                      <span className="mute">due {new Date(item.step.slaDueAt).toLocaleString()}</span>
                    )}
                  </div>

                  <div className="row">
                    <input
                      placeholder="Comment (optional)"
                      style={{ flex: 1, minWidth: '14rem' }}
                      value={comment[item.step.id] ?? ''}
                      onChange={(e) => setComment({ ...comment, [item.step.id]: e.target.value })}
                    />
                    <button
                      className="approve"
                      disabled={busyStep === item.step.id}
                      onClick={() => act(item.step.id,
                        () => api.decide(item.step.id, 'APPROVE', approverId, comment[item.step.id]),
                        `Approved ${item.invoiceNumber ?? 'invoice'}.`)}
                    >Approve</button>
                    <button
                      className="reject"
                      disabled={busyStep === item.step.id}
                      onClick={() => act(item.step.id,
                        () => api.decide(item.step.id, 'REJECT', approverId, comment[item.step.id]),
                        `Rejected ${item.invoiceNumber ?? 'invoice'}.`)}
                    >Reject</button>
                  </div>

                  <div className="row small">
                    <span className="lbl">Delegate to</span>
                    <select
                      value={delegateTo[item.step.id] ?? ''}
                      onChange={(e) => setDelegateTo({ ...delegateTo, [item.step.id]: e.target.value })}
                    >
                      <option value="">choose a colleague…</option>
                      {(users ?? []).filter((u) => u.id !== approverId).map((u) => (
                        <option key={u.id} value={u.id}>{u.name} · {u.role}</option>
                      ))}
                    </select>
                    <button
                      disabled={!delegateTo[item.step.id] || busyStep === item.step.id}
                      onClick={() => act(item.step.id,
                        () => api.delegate(item.step.id, approverId, delegateTo[item.step.id], comment[item.step.id]),
                        'Handed off — the delegate keeps your original SLA deadline.')}
                    >Delegate</button>
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}

      {tab === 'history' && (
        history.loading ? <Loading what="your history" />
        : history.error ? <ErrorNote message={history.error} />
        : (history.data ?? []).length === 0 ? <Empty>You have not decided anything yet.</Empty>
        : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Decided</th><th>Invoice</th><th>Vendor</th><th className="r">Amount</th><th>Your decision</th><th>Comment</th><th>Invoice now</th></tr>
              </thead>
              <tbody>
                {(history.data ?? []).map((h) => (
                  <tr key={h.step.id}>
                    <td className="mute">{h.step.actedAt ? new Date(h.step.actedAt).toLocaleString() : '—'}</td>
                    <td><Link to={`/invoices/${h.invoiceId}`}>{h.invoiceNumber ?? h.invoiceId.slice(0, 8)}</Link></td>
                    <td>{h.vendorName ?? '—'}</td>
                    <td className="r"><Money amount={h.totalAmount} currency={h.currency} /></td>
                    <td><StepPill status={h.step.status} /></td>
                    <td className="wrap dim">{h.step.comment ?? '—'}</td>
                    <td><StatusPill status={h.invoiceStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
}
