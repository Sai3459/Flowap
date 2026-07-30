import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { InvoiceListItem } from '../api/types';
import { ConfidenceIndicator, StatusBadge } from '../components/Badges';
import { useApi } from '../lib/useApi';

function formatMoney(amount: string | null, currency: string | null): string {
  if (amount === null) return '—';
  // Amounts arrive as numeric strings; format for display only, never parse for arithmetic.
  const n = Number(amount);
  const formatted = Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : amount;
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

export function InvoiceListPage() {
  const navigate = useNavigate();
  const { data, loading, error } = useApi<InvoiceListItem[]>(() => api.listInvoices());

  if (loading) return <div className="notice">Loading invoices…</div>;
  if (error) return <div className="notice error">{error}</div>;

  const invoices = data ?? [];
  const flaggedCount = invoices.filter((i) => i.lowConfidenceFields.length > 0).length;

  return (
    <>
      <div className="page-head">
        <h1>Invoices</h1>
        <span className="count">
          {invoices.length} total
          {flaggedCount > 0 && ` · ${flaggedCount} with low-confidence fields`}
        </span>
      </div>

      {invoices.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state">
            No invoices for this tenant yet. Ingest one with <code>POST /invoices</code>.
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Vendor</th>
                <th>Date</th>
                <th className="num">Amount</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr
                  key={invoice.id}
                  className="clickable"
                  onClick={() => navigate(`/invoices/${invoice.id}`)}
                >
                  <td>{invoice.invoiceNumber ?? <span className="subtle">—</span>}</td>
                  <td>{invoice.vendorName ?? <span className="subtle">unresolved</span>}</td>
                  <td>{formatDate(invoice.invoiceDate)}</td>
                  <td className="num">{formatMoney(invoice.totalAmount, invoice.currency)}</td>
                  <td>
                    <StatusBadge status={invoice.status} />
                  </td>
                  <td>
                    <ConfidenceIndicator lowConfidenceFields={invoice.lowConfidenceFields} />
                  </td>
                  <td className="subtle">{invoice.sourceChannel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
