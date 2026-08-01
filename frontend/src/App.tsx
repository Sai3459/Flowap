import { NavLink, Route, Routes } from 'react-router'
import { InvoiceListPage } from './routes/InvoiceListPage'

export default function App() {
  return (
    <div className="bg-sunken text-ink min-h-full">
      <header className="border-line bg-surface border-b">
        <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">Invoice Platform</span>
          <NavLink
            to="/"
            className={({ isActive }) =>
              `text-sm ${isActive ? 'text-ink font-medium' : 'text-muted hover:text-ink'}`
            }
          >
            Invoices
          </NavLink>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<InvoiceListPage />} />
        <Route
          path="*"
          element={<p className="text-muted mx-auto max-w-6xl px-6 py-10">Not found.</p>}
        />
      </Routes>
    </div>
  )
}
