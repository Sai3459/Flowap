import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { getTenantId, setTenantId } from './api/client';
import { InvoiceListPage } from './pages/InvoiceListPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { ExceptionQueuePage } from './pages/ExceptionQueuePage';

/**
 * Tenant is entered by hand because the backend still resolves it from an `x-tenant-id`
 * header. This control exists to make the prototype usable, and should disappear entirely
 * once SSO provides the tenant from the session — see CLAUDE.md.
 */
function TenantPicker() {
  const [value, setValue] = useState(getTenantId());
  const current = getTenantId();

  function apply() {
    setTenantId(value);
    // Simplest correct thing: every screen re-reads the tenant on load, so a reload
    // guarantees no stale cross-tenant data lingers in component state.
    window.location.reload();
  }

  return (
    <div className="tenant-picker">
      <label htmlFor="tenant">Tenant</label>
      <input
        id="tenant"
        value={value}
        placeholder="tenant UUID"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
      />
      <button onClick={apply} disabled={value.trim() === current}>
        Switch
      </button>
    </div>
  );
}

export default function App() {
  const tenantId = getTenantId();

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Flowap</span>
        <nav className="nav">
          <NavLink to="/" end>
            Invoices
          </NavLink>
          <NavLink to="/review">Review queue</NavLink>
        </nav>
        <TenantPicker />
      </header>

      <main className="content">
        {tenantId ? (
          <Routes>
            <Route path="/" element={<InvoiceListPage />} />
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="/review" element={<ExceptionQueuePage />} />
            <Route path="*" element={<div className="notice">Page not found.</div>} />
          </Routes>
        ) : (
          <div className="notice">
            Enter a tenant UUID above to begin. Find one with{' '}
            <code>psql -c "SELECT id, name FROM tenants;"</code>
          </div>
        )}
      </main>
    </div>
  );
}
