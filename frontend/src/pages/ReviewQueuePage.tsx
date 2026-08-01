import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ExceptionQueueItem } from '../api/types';
import { useApi } from '../lib/useApi';
import { Empty, ErrorNote, Loading, Money, StatusPill } from '../components/ui';
import { FIELD_LABELS, confidenceLevel } from '../lib/confidence';

/**
 * Everything the pipeline could not clear on its own. Two distinct reasons land here — a
 * recorded exception (duplicate, missing PO, over-receipt) and low-confidence extraction —
 * and both are spelled out rather than collapsed into one "needs attention".
 */
export function ReviewQueuePage() {
  const { data, loading, error } = useApi<ExceptionQueueItem[]>(() => api.listExceptions());

  if (loading) return <Loading what="review queue" />;
  if (error) return <ErrorNote message={error} />;
  const items = data ?? [];

  if (items.length === 0) return <Empty>Nothing in the queue — every invoice cleared automatically.</Empty>;

  return (
    <div className="stack">
      <p className="dim small">{items.length} invoice(s) need a human.</p>
      {items.map((inv) => {
        const confidence = inv.fieldConfidence ?? {};
        const low = Object.keys(confidence).filter((n) => confidenceLevel(confidence[n]) === 'low');
        return (
          <div className="card" key={inv.id}>
            <div className="row-between">
              <h2><Link to={`/invoices/${inv.id}`}>{inv.invoiceNumber ?? 'Untitled invoice'}</Link></h2>
              <div className="row">
                <StatusPill status={inv.status} />
                <span className="mono"><Money amount={inv.totalAmount} currency={inv.currency} /></span>
              </div>
            </div>

            <div className="row small dim">
              <span><span className="lbl">Vendor</span> {inv.vendorName ?? 'unresolved'}</span>
              <span><span className="lbl">PO</span> {inv.poNumber ?? 'non-PO'}</span>
              <span><span className="lbl">Received</span> {new Date(inv.createdAt).toLocaleDateString()}</span>
            </div>

            {inv.exceptions.filter((e) => !e.resolvedAt).map((e) => (
              <div className="exc" key={e.id}>
                <span className="t">{e.type.replace(/_/g, ' ')}</span>
                <p className="small">{e.detail}</p>
                {e.suggestedFix && <p className="fix"><strong>Suggested fix:</strong> {e.suggestedFix}</p>}
              </div>
            ))}

            {low.length > 0 && (
              <div className="exc">
                <span className="t">LOW CONFIDENCE EXTRACTION</span>
                <p className="small">
                  {low.length} field(s) below the review threshold:{' '}
                  {low.map((n) => `${FIELD_LABELS[n] ?? n} (${Math.round((confidence[n]?.confidence ?? 0) * 100)}%)`).join(', ')}.
                </p>
                <p className="fix">
                  <strong>Suggested fix:</strong> open the invoice and confirm or correct the flagged
                  fields — a correction marks them human-corrected and clears the flag.
                </p>
              </div>
            )}

            <div className="row small"><Link to={`/invoices/${inv.id}`}>Review this invoice →</Link></div>
          </div>
        );
      })}
    </div>
  );
}
