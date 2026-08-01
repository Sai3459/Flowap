import { Tooltip } from 'radix-ui'
import { AlertTriangle } from 'lucide-react'
import {
  CONFIDENCE_REVIEW_THRESHOLD,
  fieldsNeedingReview,
  lowestConfidence,
  type Invoice,
} from '../lib/types'

/**
 * Shows the *lowest* field confidence, not a document-level average. Averaging is
 * what hides a single bad field behind an otherwise clean extraction — the whole
 * point of per-field confidence is that one shaky field surfaces on its own.
 */
export function ConfidenceCell({ invoice }: { invoice: Invoice }) {
  const lowest = lowestConfidence(invoice)

  if (lowest === null) {
    return <span className="text-muted text-sm">—</span>
  }

  const needsReview = lowest < CONFIDENCE_REVIEW_THRESHOLD
  const fields = fieldsNeedingReview(invoice)
  const percent = `${Math.round(lowest * 100)}%`

  if (!needsReview) {
    return <span className="text-muted text-sm tabular-nums">{percent}</span>
  }

  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-amber-700 tabular-nums dark:text-amber-400"
          >
            <AlertTriangle className="size-3.5" aria-hidden="true" />
            {percent}
            <span className="sr-only">
              , below the {Math.round(CONFIDENCE_REVIEW_THRESHOLD * 100)}% review
              threshold. Fields needing review: {fields.join(', ')}
            </span>
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            className="border-line bg-surface text-ink z-50 max-w-xs rounded-md border px-3 py-2 text-xs shadow-md"
          >
            <p className="font-medium">
              Below the {Math.round(CONFIDENCE_REVIEW_THRESHOLD * 100)}% review threshold
            </p>
            <p className="text-muted mt-1">
              {fields.length > 0 ? fields.join(', ') : 'No field breakdown available'}
            </p>
            <Tooltip.Arrow className="fill-line" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
