import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { InvoiceDetail } from '../api/types';
import { StatusBadge } from '../components/Badges';
import { FieldRow } from '../components/FieldRow';
import { ExceptionBlock } from '../components/ExceptionBlock';
import { MatchPanel } from '../components/MatchPanel';
import { confidenceLevel } from '../lib/confidence';
import { useApi } from '../lib/useApi';

/** Display order for header fields; anything unexpected in fieldConfidence is appended. */
const FIELD_ORDER = [
  'invoiceNumber',
  'poNumber',
  'referenceNumber',
  'vendorName',
  'vendorTaxId',
  'invoiceDate',
  'supplyDate',
  'dueDate',
  'currency',
  'subtotal',
  'taxAmount',
  'totalAmount',
];

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, setData } = useApi<InvoiceDetail>(
    () => api.getInvoice(id!),
    [id],
  );

  if (loading) return <div className="notice">Loading invoice…</div>;
  if (error) return <div className="notice error">{error}</div>;
  if (!data) return null;

  const invoice = data;
  const confidence = invoice.fieldConfidence ?? {};

  // Union of the known ordering and whatever the extractor actually reported, so a new
  // field added upstream still shows up rather than silently vanishing.
  const fieldNames = [
    ...FIELD_ORDER.filter((name) => name in confidence || name in invoice),
    ...Object.keys(confidence).filter((name) => !FIELD_ORDER.includes(name)),
  ];

  const lowConfidenceCount = fieldNames.filter(
    (name) => confidenceLevel(confidence[name]) === 'low',
  ).length;

  /** The PATCH returns the same shape as the detail read, so we swap it straight in. */
  async function handleSave(fieldName: string, correctedValue: string) {
    setData(await api.correctField(invoice.id, fieldName, correctedValue));
  }

  return (
    <>
      <div className="page-head">
        <h1>{invoice.invoiceNumber ?? 'Untitled invoice'}</h1>
        <StatusBadge status={invoice.status} />
        <span className="count">
          {lowConfidenceCount > 0
            ? `${lowConfidenceCount} field${lowConfidenceCount === 1 ? '' : 's'} need review`
            : 'all fields above threshold'}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Link to="/">← All invoices</Link>
        </span>
      </div>

      {invoice.exceptions.length > 0 && (
        <div className="card">
          <h2>Exceptions</h2>
          {invoice.exceptions.map((exception) => (
            <ExceptionBlock key={exception.id} exception={exception} />
          ))}
        </div>
      )}

      <div className="card">
        <div className="row-between">
          <h2>Extracted fields</h2>
          <span className="subtle">
            Confidence is per field — only flagged rows need a human. Edits are recorded as
            HUMAN_CORRECTED.
          </span>
        </div>
        <div className="field-grid">
          {fieldNames.map((fieldName) => (
            <FieldRow
              key={fieldName}
              fieldName={fieldName}
              value={readField(invoice, fieldName)}
              meta={confidence[fieldName]}
              onSave={handleSave}
            />
          ))}
        </div>
      </div>

      {invoice.matchResult && (
        <MatchPanel match={invoice.matchResult} poNumber={invoice.poNumber} />
      )}

      <div className="card">
        <h2>Line items</h2>
        {invoice.lineItems.length === 0 ? (
          <p className="subtle">No line items extracted.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Line total</th>
                  <th>Tax code</th>
                  <th>PO line</th>
                  <th>GL code</th>
                  <th className="num">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lineItems.map((item) => {
                  const low = item.confidence !== null && item.confidence < 0.9;
                  return (
                    <tr key={item.id}>
                      <td>{item.description}</td>
                      <td className="num">{trimNumber(item.quantity)}</td>
                      <td className="num">{trimNumber(item.unitPrice)}</td>
                      <td className="num">{item.lineTotal}</td>
                      <td className="subtle">
                        {item.taxCode ?? '—'}
                        {item.taxRate !== null && ` (${item.taxRate}%)`}
                      </td>
                      <td className="subtle">{item.poLineNumber ?? '—'}</td>
                      <td className="subtle">{item.glCode ?? 'unassigned'}</td>
                      <td className="num">
                        {item.confidence === null ? (
                          '—'
                        ) : (
                          <span className={low ? 'badge badge-danger' : undefined}>
                            {Math.round(item.confidence * 100)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Document</h2>
        <div className="meta-list">
          <span>
            <strong>Source:</strong> {invoice.sourceChannel}
          </span>
          <span>
            <strong>Received:</strong> {new Date(invoice.createdAt).toLocaleString()}
          </span>
          <span>
            <strong>Updated:</strong> {new Date(invoice.updatedAt).toLocaleString()}
          </span>
        </div>
        <p className="subtle" style={{ marginBottom: 0 }}>
          {invoice.fileUrl}
        </p>
      </div>
    </>
  );
}

function readField(invoice: InvoiceDetail, fieldName: string): string | null {
  const value = (invoice as unknown as Record<string, unknown>)[fieldName];
  return value === null || value === undefined ? null : String(value);
}

/** Quantities/prices are numeric(18,4); drop trailing zeros for readability. */
function trimNumber(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : value;
}
