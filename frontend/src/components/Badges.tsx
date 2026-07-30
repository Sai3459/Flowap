import type { InvoiceStatus } from '../api/types';

/** Maps pipeline status onto a severity colour — needs-attention states read as warnings. */
const STATUS_TONE: Record<InvoiceStatus, string> = {
  RECEIVED: 'badge-neutral',
  CLASSIFYING: 'badge-neutral',
  EXTRACTING: 'badge-neutral',
  VALIDATING: 'badge-neutral',
  MATCHING: 'badge-neutral',
  NEEDS_REVIEW: 'badge-warn',
  EXCEPTION: 'badge-danger',
  PENDING_APPROVAL: 'badge-info',
  APPROVED: 'badge-ok',
  POSTED: 'badge-ok',
  PAID: 'badge-ok',
  REJECTED: 'badge-danger',
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span className={`badge ${STATUS_TONE[status] ?? 'badge-neutral'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * Row-level confidence signal for the list view: how many fields need a human. Zero flagged
 * fields is shown as a quiet "clean" rather than nothing, so an empty cell never reads as
 * "not yet extracted".
 */
export function ConfidenceIndicator({ lowConfidenceFields }: { lowConfidenceFields: string[] }) {
  if (lowConfidenceFields.length === 0) {
    return <span className="badge badge-ok">clean</span>;
  }
  const count = lowConfidenceFields.length;
  return (
    <span className="badge badge-danger" title={`Low confidence: ${lowConfidenceFields.join(', ')}`}>
      {count} field{count === 1 ? '' : 's'} flagged
    </span>
  );
}
