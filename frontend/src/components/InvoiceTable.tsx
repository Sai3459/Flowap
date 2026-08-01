import { useMemo, useState } from 'react'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { motion } from 'motion/react'
import type { Invoice } from '../lib/types'
import { lowestConfidence } from '../lib/types'
import { formatDate, formatMoney } from '../lib/format'
import { StatusBadge } from './StatusBadge'
import { ConfidenceCell } from './ConfidenceCell'

const columnHelper = createColumnHelper<Invoice>()

export function InvoiceTable({ invoices }: { invoices: Invoice[] }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }])

  const columns = useMemo(
    () => [
      columnHelper.accessor('invoiceNumber', {
        header: 'Invoice',
        cell: (ctx) => (
          <span className="font-medium">{ctx.getValue() ?? <span className="text-muted">Not extracted</span>}</span>
        ),
      }),
      columnHelper.accessor('status', {
        header: 'Status',
        cell: (ctx) => <StatusBadge status={ctx.getValue()} />,
      }),
      columnHelper.accessor('invoiceDate', {
        header: 'Invoice date',
        cell: (ctx) => <span className="text-muted">{formatDate(ctx.getValue())}</span>,
      }),
      columnHelper.accessor((row) => (row.totalAmount === null ? null : Number(row.totalAmount)), {
        id: 'totalAmount',
        header: 'Total',
        cell: (ctx) => (
          <span className="tabular-nums">
            {formatMoney(ctx.row.original.totalAmount, ctx.row.original.currency)}
          </span>
        ),
        // Sort on the numeric projection above; the cell still renders the string.
        sortUndefined: 'last',
      }),
      columnHelper.accessor(lowestConfidence, {
        id: 'confidence',
        header: 'Confidence',
        cell: (ctx) => <ConfidenceCell invoice={ctx.row.original} />,
        sortUndefined: 'last',
      }),
      columnHelper.accessor('sourceChannel', {
        header: 'Source',
        cell: (ctx) => <span className="text-muted text-xs">{ctx.getValue().toLowerCase()}</span>,
      }),
      columnHelper.accessor('createdAt', {
        header: 'Received',
        cell: (ctx) => <span className="text-muted">{formatDate(ctx.getValue())}</span>,
      }),
    ],
    [],
  )

  const table = useReactTable({
    data: invoices,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <div className="border-line bg-surface overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-sm">
        <thead className="border-line text-muted border-b">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted()
                const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown
                return (
                  <th key={header.id} scope="col" className="px-4 py-3 font-medium">
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="hover:text-ink inline-flex items-center gap-1.5"
                      aria-label={`Sort by ${String(header.column.columnDef.header)}`}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <Icon
                        className={`size-3.5 ${sorted ? 'text-accent' : 'opacity-40'}`}
                        aria-hidden="true"
                      />
                    </button>
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, index) => (
            <motion.tr
              key={row.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15, delay: Math.min(index * 0.015, 0.3) }}
              className="border-line hover:bg-sunken border-b last:border-0"
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="px-4 py-3">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
