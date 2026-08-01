import type { InvoiceStatus } from '../lib/types'

/**
 * Colour carries meaning here, so it is never the only signal — the label is always
 * present. Amber marks the states that are waiting on a human, red the ones that are
 * blocked, emerald the ones that cleared.
 */
const STYLES: Record<InvoiceStatus, string> = {
  RECEIVED: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  CLASSIFYING: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  EXTRACTING: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  VALIDATING: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  MATCHING: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  NEEDS_REVIEW: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  EXCEPTION: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  REJECTED: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  PENDING_APPROVAL: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  POSTED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  PAID: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
}

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STYLES[status]}`}
    >
      {status.replace(/_/g, ' ').toLowerCase()}
    </span>
  )
}
