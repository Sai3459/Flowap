import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { CodingQueueItem, CostCenter, GlAccount, InvoiceDetail } from '../api/types';
import { useApi } from '../lib/useApi';
import { Empty, ErrorNote, Loading, Money, StatusPill } from '../components/ui';

/**
 * Cost assignment — charging each line to a GL account and cost centre.
 *
 * This is the one step where the tool genuinely needs a person rather than a checker: the
 * information is not on the document, so it cannot be extracted, only decided.
 */
export function CostAssignmentPage() {
  const queue = useApi<CodingQueueItem[]>(() => api.codingQueue());
  const { data: accounts } = useApi<GlAccount[]>(() => api.glAccounts(), []);
  const { data: centers } = useApi<CostCenter[]>(() => api.costCenters(), []);
  const [openId, setOpenId] = useState<string | null>(null);

  if (queue.loading) return <Loading what="the coding queue" />;
  if (queue.error) return <ErrorNote message={queue.error} />;

  const items = queue.data ?? [];

  return (
    <>
      <div className="row-between">
        <p className="dim small">
          {items.length === 0
            ? 'Every invoice with line items is fully coded.'
            : `${items.length} invoice(s) have lines with no GL account or cost centre. An invoice cannot post until all of its lines are coded.`}
        </p>
        <span className="lbl">{accounts?.length ?? 0} accounts · {centers?.length ?? 0} cost centres</span>
      </div>

      {items.length === 0 ? (
        <Empty>Nothing to code.</Empty>
      ) : (
        <div className="stack">
          {items.map((item) => (
            <div className="card" key={item.id}>
              <div className="row-between">
                <h2>
                  <Link to={`/invoices/${item.id}`}>{item.invoiceNumber ?? item.id.slice(0, 8)}</Link>
                  <span className="mute mono small" style={{ marginLeft: '0.6rem' }}>
                    PO {item.poNumber ?? 'non-PO'}
                  </span>
                </h2>
                <div className="row">
                  <StatusPill status={item.status} />
                  <span className="mono small">
                    {item.coding.codedLines}/{item.coding.totalLines} lines coded
                  </span>
                  <span className="mono"><Money amount={item.totalAmount} currency={item.currency} /></span>
                  <button onClick={() => setOpenId(openId === item.id ? null : item.id)}>
                    {openId === item.id ? 'Close' : 'Code lines'}
                  </button>
                </div>
              </div>

              {openId === item.id && (
                <CodingEditor
                  invoiceId={item.id}
                  accounts={accounts ?? []}
                  centers={centers ?? []}
                  onCoded={() => queue.reload()}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function CodingEditor({
  invoiceId, accounts, centers, onCoded,
}: {
  invoiceId: string;
  accounts: GlAccount[];
  centers: CostCenter[];
  onCoded: () => void;
}) {
  const invoice = useApi<InvoiceDetail>(() => api.getInvoice(invoiceId), [invoiceId]);
  const { data: suggestions } = useApi(() => api.codingSuggestions(invoiceId), [invoiceId]);
  const [draft, setDraft] = useState<Record<string, { gl?: string; cc?: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (invoice.loading) return <Loading what="lines" />;
  if (invoice.error) return <ErrorNote message={invoice.error} />;
  const lines = invoice.data?.lineItems ?? [];

  async function save(lineId: string) {
    const d = draft[lineId] ?? {};
    const line = lines.find((l) => l.id === lineId);
    setSaving(lineId);
    setError(null);
    try {
      await api.codeLine(invoiceId, lineId, d.gl ?? line?.glAccountId ?? undefined, d.cc ?? line?.costCenterId ?? undefined);
      invoice.reload();
      onCoded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  }

  /** Applies a suggestion to every uncoded line at once — the common case is one repeated code. */
  function applyToAll(glAccountId: string, costCenterId: string) {
    const next = { ...draft };
    for (const l of lines) next[l.id] = { gl: glAccountId, cc: costCenterId };
    setDraft(next);
  }

  return (
    <>
      {error && <ErrorNote message={error} />}

      {(suggestions ?? []).length > 0 && (
        <div className="row small">
          <span className="lbl">Suggested from history</span>
          {(suggestions ?? []).map((s) => (
            <button key={s.label} className="ghost" title={s.reason} onClick={() => applyToAll(s.glAccountId, s.costCenterId)}>
              {s.label} <span className="mute">· {s.reason}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Line</th><th className="r">Amount</th><th>GL account</th><th>Cost centre</th><th></th></tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const d = draft[line.id] ?? {};
              const gl = d.gl ?? line.glAccountId ?? '';
              const cc = d.cc ?? line.costCenterId ?? '';
              const complete = Boolean(gl && cc);
              return (
                <tr key={line.id}>
                  <td className="wrap">{line.description}</td>
                  <td className="r">{line.lineTotal}</td>
                  <td>
                    <select value={gl} onChange={(e) => setDraft({ ...draft, [line.id]: { ...d, gl: e.target.value } })}>
                      <option value="">— choose —</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={cc} onChange={(e) => setDraft({ ...draft, [line.id]: { ...d, cc: e.target.value } })}>
                      <option value="">— choose —</option>
                      {centers.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <button
                      className={complete ? 'primary' : ''}
                      disabled={!complete || saving === line.id}
                      onClick={() => void save(line.id)}
                    >
                      {saving === line.id ? 'Saving…' : line.glAccountId && line.costCenterId ? 'Update' : 'Assign'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
