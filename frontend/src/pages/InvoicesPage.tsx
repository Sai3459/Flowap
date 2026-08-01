import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { InvoiceListItem, InvoiceStatus } from '../api/types';
import { useApi } from '../lib/useApi';
import { Empty, ErrorNote, Loading, Money, StatusPill, shortDate } from '../components/ui';

const FILTERS: { key: string; label: string; match: (i: InvoiceListItem) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'attention', label: 'Needs attention', match: (i) => i.status === 'NEEDS_REVIEW' || i.status === 'EXCEPTION' },
  { key: 'approval', label: 'In approval', match: (i) => i.status === 'PENDING_APPROVAL' },
  { key: 'done', label: 'Approved / posted', match: (i) => ['APPROVED', 'POSTED', 'PAID'].includes(i.status) },
];

export function InvoicesPage() {
  const navigate = useNavigate();
  const { data, loading, error } = useApi<InvoiceListItem[]>(() => api.listInvoices());
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');

  if (loading) return <Loading what="invoices" />;
  if (error) return <ErrorNote message={error} />;

  const all = data ?? [];
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const rows = all.filter(active.match).filter((i) => {
    if (!q.trim()) return true;
    const hay = `${i.invoiceNumber ?? ''} ${i.vendorName ?? ''} ${i.poNumber ?? ''}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <>
      <div className="row-between">
        <div className="row">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'primary' : ''} onClick={() => setFilter(f.key)}>
              {f.label} <span className="mono mute">{all.filter(f.match).length}</span>
            </button>
          ))}
        </div>
        <input placeholder="Search invoice, vendor or PO…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '18rem' }} />
      </div>

      {rows.length === 0 ? (
        <Empty>No invoices match.</Empty>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Invoice</th><th>PO</th><th>Vendor</th><th>Date</th>
                <th className="r">Amount</th><th>Status</th><th>Confidence</th><th>PO match</th><th>ERP doc</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv) => (
                <tr key={inv.id} className="clickable" onClick={() => navigate(`/invoices/${inv.id}`)}>
                  <td>{inv.invoiceNumber ?? <span className="mute">—</span>}</td>
                  <td className="mute">{inv.poNumber ?? 'non-PO'}</td>
                  <td>{inv.vendorName ?? <span className="mute">unresolved</span>}</td>
                  <td className="mute">{shortDate(inv.invoiceDate)}</td>
                  <td className="r"><Money amount={inv.totalAmount} currency={inv.currency} /></td>
                  <td><StatusPill status={inv.status as InvoiceStatus} /></td>
                  <td>
                    {inv.lowConfidenceFields.length === 0
                      ? <span className="pill p-clear">clean</span>
                      : <span className="pill p-blocked" title={inv.lowConfidenceFields.join(', ')}>
                          {inv.lowConfidenceFields.length} flagged
                        </span>}
                  </td>
                  <td>
                    {!inv.poNumber ? <span className="mute">n/a</span>
                      : inv.priceVariancePct || inv.quantityVariancePct
                        ? <span className="pill p-review">
                            +{Math.max(inv.priceVariancePct ?? 0, inv.quantityVariancePct ?? 0).toFixed(1)}%
                          </span>
                        : <span className="pill p-clear">in tolerance</span>}
                  </td>
                  <td style={{ color: 'var(--posted)' }}>{inv.erpDocumentNumber ?? <span className="mute">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
