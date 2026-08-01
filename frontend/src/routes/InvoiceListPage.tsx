import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Inbox, Loader2, TriangleAlert } from 'lucide-react'
import { listInvoices } from '../lib/api'
import type { InvoiceStatus } from '../lib/types'
import { InvoiceTable } from '../components/InvoiceTable'

/**
 * Presets rather than the full 12-status enum: the two that matter day to day are
 * "what needs me" and "what is waiting on someone else". The full list stays
 * reachable through All.
 */
const FILTERS: { label: string; statuses: InvoiceStatus[] }[] = [
  { label: 'All', statuses: [] },
  { label: 'Needs attention', statuses: ['NEEDS_REVIEW', 'EXCEPTION'] },
  { label: 'Pending approval', statuses: ['PENDING_APPROVAL'] },
  { label: 'Completed', statuses: ['APPROVED', 'POSTED', 'PAID'] },
]

export function InvoiceListPage() {
  const [filterIndex, setFilterIndex] = useState(0)
  const filter = FILTERS[filterIndex]

  const { data, isPending, error, isFetching } = useQuery({
    queryKey: ['invoices', filter.statuses],
    queryFn: () => listInvoices(filter.statuses),
  })

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
        <p className="text-muted mt-1 text-sm">
          Confidence is the lowest-scoring field on each invoice, not a document average.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {FILTERS.map((option, index) => (
          <button
            key={option.label}
            type="button"
            onClick={() => setFilterIndex(index)}
            aria-pressed={index === filterIndex}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              index === filterIndex
                ? 'border-accent bg-accent text-white'
                : 'border-line text-muted hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        ))}
        {isFetching && !isPending && (
          <span className="text-muted inline-flex items-center gap-1.5 px-2 text-sm">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Refreshing
          </span>
        )}
      </div>

      {isPending ? (
        <Panel icon={<Loader2 className="size-5 animate-spin" aria-hidden="true" />}>
          Loading invoices…
        </Panel>
      ) : error ? (
        <Panel
          icon={<TriangleAlert className="size-5 text-red-600 dark:text-red-400" aria-hidden="true" />}
          tone="error"
        >
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </Panel>
      ) : data.length === 0 ? (
        <Panel icon={<Inbox className="size-5" aria-hidden="true" />}>
          No invoices{filter.statuses.length > 0 ? ` matching “${filter.label}”` : ' yet'}. Ingest
          one with <code className="bg-sunken rounded px-1 py-0.5 text-xs">POST /invoices</code>.
        </Panel>
      ) : (
        <>
          <InvoiceTable invoices={data} />
          <p className="text-muted mt-3 text-xs">
            {data.length} invoice{data.length === 1 ? '' : 's'}
          </p>
        </>
      )}
    </div>
  )
}

function Panel({
  icon,
  children,
  tone = 'neutral',
}: {
  icon: React.ReactNode
  children: React.ReactNode
  tone?: 'neutral' | 'error'
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`flex items-center gap-3 rounded-xl border px-4 py-8 text-sm ${
        tone === 'error'
          ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200'
          : 'border-line bg-surface text-muted'
      }`}
    >
      {icon}
      <span>{children}</span>
    </div>
  )
}
