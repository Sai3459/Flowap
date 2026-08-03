import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ApprovalHistoryItem, InboxItem, TenantUser } from '../api/types';
import { useApi } from '../lib/useApi';
import { Empty, ErrorNote, Loading, Money, StatusPill, StepPill } from '../components/ui';
import { rectOf, useEffectsApi } from '../components/Effects';
import { notifyInboxChanged } from '../lib/useInboxWatch';

/**
 * The approval app: one person's queue and their decision history.
 *
 * This is a **pull** model. Nothing emails or notifies the next approver when their turn
 * arrives — their step is simply created and appears here. `useInboxWatch` in App.tsx now
 * announces arrivals in-app, but that only reaches someone with the tab open; real
 * notification is still unbuilt.
 */
export function ApprovalsPage() {
  const { lift } = useEffectsApi();
  
  const [tab, setTab] = useState<'inbox' | 'history'>('inbox');
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [comment, setComment] = useState<Record<string, string>>({});
  const [delegateTo, setDelegateTo] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Both are session-scoped now — the server answers for whoever the token says we are, so
  // there is no id to pass and nothing to re-fetch when it changes.
  const inbox = useApi<InboxItem[]>(() => api.inbox(), []);
  const history = useApi<ApprovalHistoryItem[]>(() => api.approvalHistory(), []);
  const { data: users } = useApi<TenantUser[]>(() => api.listUsers(), []);

  async function act(
    stepId: string,
    fn: () => Promise<unknown>,
    message: string,
    confirm?: { title: string; detail?: string; stamp?: string; tone: 'clear' | 'blocked'; from?: DOMRect },
  ) {
    setBusyStep(stepId);
    setError(null);
    setFlash(null);
    try {
      await fn();
      setFlash(message);
      // Fire the confirmation before reloading: the lift is anchored to a rect captured at
      // click time, so it stays correct even as the row it came from disappears beneath it.
      if (confirm) lift({ ...confirm, origin: confirm.from });
      inbox.reload();
      history.reload();
      notifyInboxChanged();
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
            <div className="arrival">
              <span className="beacon" />
              <span className="n">{(inbox.data ?? []).length}</span>
              <span className="txt">
                <span className="t">
                  {(inbox.data ?? []).length === 1
                    ? 'Invoice ready to be approved'
                    : 'Invoices ready to be approved'}
                </span>
                <span className="d">Each one is parked at a node in its workflow, waiting on your decision.</span>
              </span>
            </div>

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
                      className="approve bulb"
                      disabled={busyStep === item.step.id}
                      onClick={(e) => act(item.step.id,
                        () => api.decide(item.step.id, 'APPROVE', comment[item.step.id]),
                        `Approved ${item.invoiceNumber ?? 'invoice'}.`,
                        {
                          title: 'Invoice approved',
                          detail: item.vendorName ?? 'unresolved vendor',
                          stamp: item.invoiceNumber ?? undefined,
                          tone: 'clear',
                          from: rectOf(e.currentTarget),
                        })}
                    >Approve</button>
                    <button
                      className="reject"
                      disabled={busyStep === item.step.id}
                      onClick={(e) => act(item.step.id,
                        () => api.decide(item.step.id, 'REJECT', comment[item.step.id]),
                        `Rejected ${item.invoiceNumber ?? 'invoice'}.`,
                        {
                          title: 'Invoice rejected',
                          detail: item.vendorName ?? 'unresolved vendor',
                          stamp: item.invoiceNumber ?? undefined,
                          tone: 'blocked',
                          from: rectOf(e.currentTarget),
                        })}
                    >Reject</button>
                  </div>

                  <div className="row small">
                    <span className="lbl">Delegate to</span>
                    <select
                      value={delegateTo[item.step.id] ?? ''}
                      onChange={(e) => setDelegateTo({ ...delegateTo, [item.step.id]: e.target.value })}
                    >
                      <option value="">choose a colleague…</option>
                      {(users ?? []).map((u) => (
                        <option key={u.id} value={u.id}>{u.name} · {u.role}</option>
                      ))}
                    </select>
                    <button
                      disabled={!delegateTo[item.step.id] || busyStep === item.step.id}
                      onClick={() => act(item.step.id,
                        () => api.delegate(item.step.id, delegateTo[item.step.id], comment[item.step.id]),
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
