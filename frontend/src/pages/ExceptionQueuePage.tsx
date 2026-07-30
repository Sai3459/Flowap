import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ExceptionQueueItem } from '../api/types';
import { StatusBadge } from '../components/Badges';
import { ExceptionBlock } from '../components/ExceptionBlock';
import { confidenceLevel, FIELD_LABELS, formatConfidence } from '../lib/confidence';
import { useApi } from '../lib/useApi';

/**
 * The review queue: everything in NEEDS_REVIEW or EXCEPTION. Two different reasons an
 * invoice lands here, so both are spelled out — a recorded exception (duplicate, PO
 * mismatch) and/or fields the extractor wasn't confident about.
 */
export function ExceptionQueuePage() {
  const { data, loading, error } = useApi<ExceptionQueueItem[]>(() => api.listExceptions());

  if (loading) return <div className="notice">Loading review queue…</div>;
  if (error) return <div className="notice error">{error}</div>;

  const items = data ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Review queue</h1>
        <span className="count">{items.length} invoice{items.length === 1 ? '' : 's'} need attention</span>
      </div>

      {items.length === 0 ? (
        <div className="card">
          <div className="empty-state">Nothing in the queue — every invoice cleared automatically.</div>
        </div>
      ) : (
        items.map((invoice) => {
          const confidence = invoice.fieldConfidence ?? {};
          const lowFields = Object.keys(confidence).filter(
            (name) => confidenceLevel(confidence[name]) === 'low',
          );

          return (
            <div className="card" key={invoice.id}>
              <div className="row-between">
                <h2 style={{ margin: 0 }}>
                  <Link to={`/invoices/${invoice.id}`}>
                    {invoice.invoiceNumber ?? 'Untitled invoice'}
                  </Link>
                </h2>
                <StatusBadge status={invoice.status} />
              </div>

              <div className="meta-list" style={{ marginTop: '0.5rem' }}>
                <span>
                  <strong>Vendor:</strong> {invoice.vendorName ?? 'unresolved'}
                </span>
                <span>
                  <strong>Total:</strong> {invoice.totalAmount ?? '—'} {invoice.currency ?? ''}
                </span>
                <span>
                  <strong>Received:</strong> {new Date(invoice.createdAt).toLocaleDateString()}
                </span>
              </div>

              {invoice.exceptions.map((exception) => (
                <ExceptionBlock key={exception.id} exception={exception} />
              ))}

              {lowFields.length > 0 && (
                <div className="exception-block">
                  <span className="type">LOW CONFIDENCE EXTRACTION</span>
                  <p className="detail">
                    {lowFields.length} field{lowFields.length === 1 ? '' : 's'} below the review
                    threshold:{' '}
                    {lowFields
                      .map((name) => `${FIELD_LABELS[name] ?? name} (${formatConfidence(confidence[name])})`)
                      .join(', ')}
                    .
                  </p>
                  <p className="fix">
                    <strong>Suggested fix:</strong> open the invoice and confirm or correct the
                    flagged fields — a correction marks them HUMAN_CORRECTED and clears the flag.
                  </p>
                </div>
              )}

              <p style={{ margin: '0.75rem 0 0' }}>
                <Link to={`/invoices/${invoice.id}`}>Review this invoice →</Link>
              </p>
            </div>
          );
        })
      )}
    </>
  );
}
