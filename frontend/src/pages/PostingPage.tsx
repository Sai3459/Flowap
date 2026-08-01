import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, session } from '../api/client';
import type { InvoiceListItem, ReadyToPostItem } from '../api/types';
import { useApi } from '../lib/useApi';
import { Empty, ErrorNote, Loading, Money } from '../components/ui';

/**
 * Posting — the last step, handing an approved invoice back to the ERP.
 *
 * The document number is generated locally: no ERP is contacted. That is stated on screen
 * rather than hidden, because an operator seeing a plausible-looking document number needs to
 * know whether it exists in the ledger or not.
 */
export function PostingPage() {
  const ready = useApi<ReadyToPostItem[]>(() => api.readyToPost());
  const posted = useApi<InvoiceListItem[]>(() => api.postedInvoices());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function post(invoiceId: string, label: string) {
    setBusy(invoiceId);
    setError(null);
    setFlash(null);
    try {
      const result = await api.postInvoice(invoiceId, session.userId() || undefined);
      setFlash(`${label} posted as ERP document ${result.erpDocumentNumber}.`);
      ready.reload();
      posted.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="notice">
        <strong>Simulated posting.</strong> The ERP document number is generated here, not returned
        by an ERP — no connector exists yet. Everything else is real: only an approved, fully coded
        invoice can post, and posting is final.
      </div>

      {flash && <div className="notice ok">{flash}</div>}
      {error && <ErrorNote message={error} />}

      <div className="card">
        <div className="card-head"><h2>Ready to post</h2><span className="lbl">approved</span></div>
        {ready.loading ? <Loading what="approved invoices" />
        : ready.error ? <ErrorNote message={ready.error} />
        : (ready.data ?? []).length === 0 ? <Empty>No approved invoices waiting.</Empty>
        : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Invoice</th><th>Vendor</th><th>PO</th><th className="r">Amount</th><th>Coding</th><th></th></tr>
              </thead>
              <tbody>
                {(ready.data ?? []).map((inv) => (
                  <tr key={inv.id}>
                    <td><Link to={`/invoices/${inv.id}`}>{inv.invoiceNumber ?? inv.id.slice(0, 8)}</Link></td>
                    <td>{inv.vendorName ?? '—'}</td>
                    <td className="mute">{inv.poNumber ?? 'non-PO'}</td>
                    <td className="r"><Money amount={inv.totalAmount} currency={inv.currency} /></td>
                    <td>
                      {inv.uncodedLines === 0
                        ? <span className="pill p-clear">complete</span>
                        : <span className="pill p-review">{inv.uncodedLines} line(s) uncoded</span>}
                    </td>
                    <td>
                      {inv.uncodedLines === 0 ? (
                        <button className="primary" disabled={busy === inv.id} onClick={() => void post(inv.id, inv.invoiceNumber ?? 'Invoice')}>
                          {busy === inv.id ? 'Posting…' : 'Post to ERP'}
                        </button>
                      ) : (
                        <Link to="/coding"><button>Code it first</button></Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h2>Posted</h2><span className="lbl">handed to the ERP</span></div>
        {posted.loading ? <Loading what="posted invoices" />
        : (posted.data ?? []).length === 0 ? <Empty>Nothing posted yet.</Empty>
        : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>ERP document</th><th>Invoice</th><th>PO</th><th className="r">Amount</th><th>Posted</th></tr>
              </thead>
              <tbody>
                {(posted.data ?? []).map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ color: 'var(--violet)' }}>{inv.erpDocumentNumber}</td>
                    <td><Link to={`/invoices/${inv.id}`}>{inv.invoiceNumber ?? inv.id.slice(0, 8)}</Link></td>
                    <td className="mute">{inv.poNumber ?? 'non-PO'}</td>
                    <td className="r"><Money amount={inv.totalAmount} currency={inv.currency} /></td>
                    <td className="mute">{inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
