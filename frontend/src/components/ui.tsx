import type { InvoiceStatus, StepStatus } from '../api/types';
import { CONFIDENCE_REVIEW_THRESHOLD } from '../lib/confidence';

/** Status → semantic colour. Four signals only: clear, review, blocked, in-flight (+ posted). */
const STATUS_TONE: Record<InvoiceStatus, string> = {
  RECEIVED: 'p-idle', CLASSIFYING: 'p-idle', EXTRACTING: 'p-idle',
  VALIDATING: 'p-idle', MATCHING: 'p-idle',
  NEEDS_REVIEW: 'p-review',
  EXCEPTION: 'p-blocked',
  REJECTED: 'p-blocked',
  PENDING_APPROVAL: 'p-flight',
  APPROVED: 'p-clear',
  POSTED: 'p-posted',
  PAID: 'p-posted',
};

export function StatusPill({ status }: { status: InvoiceStatus }) {
  return <span className={`pill ${STATUS_TONE[status] ?? 'p-idle'}`}>{status.replace(/_/g, ' ')}</span>;
}

const STEP_TONE: Record<StepStatus, string> = {
  PENDING: 'p-flight', APPROVED: 'p-clear', REJECTED: 'p-blocked',
  SKIPPED: 'p-idle', DELEGATED: 'p-review',
};

export function StepPill({ status }: { status: StepStatus }) {
  return <span className={`pill ${STEP_TONE[status]}`}>{status}</span>;
}

/**
 * The confidence spectrum: ten discrete segments rather than a continuous bar.
 * Segments make the *band* legible at a glance — you read "seven of ten, amber" without
 * parsing a number, and a 40% field is unmistakably different from an 89% one.
 */
export function ConfidenceEq({ confidence, corrected }: { confidence: number | null; corrected?: boolean }) {
  if (confidence === null) {
    return <span className="eq" aria-label="not extracted">{Array.from({ length: 10 }, (_, i) => <i key={i} />)}</span>;
  }
  const lit = Math.max(1, Math.round(confidence * 10));
  const band = corrected ? 'b-corrected'
    : confidence >= CONFIDENCE_REVIEW_THRESHOLD ? 'b-clear'
    : confidence >= 0.7 ? 'b-review'
    : 'b-blocked';
  return (
    <span className={`eq ${band}`} aria-label={`confidence ${Math.round(confidence * 100)}%`}>
      {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < lit ? 'on' : undefined} />)}
    </span>
  );
}

/** How far through its approval chain an invoice is — filled / current / remaining. */
export function ApprovalMeter({ given, remaining }: { given: number; remaining: number }) {
  const total = Math.max(given + remaining, 1);
  return (
    <span className="meter" aria-label={`${given} of ${total} approvals given`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i < given ? 'done' : i === given && remaining > 0 ? 'now' : undefined} />
      ))}
    </span>
  );
}

export function Money({ amount, currency }: { amount: string | null; currency?: string | null }) {
  if (amount === null) return <span className="mute">—</span>;
  const n = Number(amount);
  const s = Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : amount;
  return <>{s}{currency ? ` ${currency}` : ''}</>;
}

export function shortDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
}

export function Loading({ what }: { what: string }) {
  return <div className="notice">Loading {what}…</div>;
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="notice error">{message}</div>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="tbl-wrap"><div className="empty">{children}</div></div>;
}
