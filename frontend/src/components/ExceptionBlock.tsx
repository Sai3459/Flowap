import type { InvoiceException } from '../api/types';

/**
 * One flagged problem: what the pipeline detected and what it suggests doing about it.
 * `detail` and `suggestedFix` are generated server-side (duplicate detection today,
 * PO/GRN matching and fraud scoring later), so this renders them rather than deriving
 * its own explanation.
 */
export function ExceptionBlock({ exception }: { exception: InvoiceException }) {
  return (
    <div className="exception-block">
      <div className="row-between">
        <span className="type">{exception.type.replace(/_/g, ' ')}</span>
        {exception.resolvedAt ? (
          <span className="badge badge-ok">resolved</span>
        ) : (
          <span className="subtle">{new Date(exception.createdAt).toLocaleString()}</span>
        )}
      </div>
      <p className="detail">{exception.detail}</p>
      {exception.suggestedFix && (
        <p className="fix">
          <strong>Suggested fix:</strong> {exception.suggestedFix}
        </p>
      )}
    </div>
  );
}
