import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, session } from './api/client';
import type { TenantUser } from './api/types';
import { useApi } from './lib/useApi';
import { useInboxWatch } from './lib/useInboxWatch';
import { DashboardPage } from './pages/DashboardPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { CostAssignmentPage } from './pages/CostAssignmentPage';
import { PostingPage } from './pages/PostingPage';
import { PurchaseOrdersPage } from './pages/PurchaseOrdersPage';
import { UploadPage } from './pages/UploadPage';

/** Page titles, so the top bar names the app you are in rather than repeating the route. */
const TITLES: [RegExp, string, string][] = [
  [/^\/$/, 'Overview', 'Everything across the workspace, as of now'],
  [/^\/inbox/, 'My approvals', 'Invoices waiting on you, and what you have already decided'],
  [/^\/invoices\/[^/]+$/, 'Invoice', 'Extraction, matching, coding and approval for one document'],
  [/^\/invoices/, 'Invoices', 'Every document received by this tenant'],
  [/^\/review/, 'Review queue', 'Documents the pipeline could not clear on its own'],
  [/^\/coding/, 'Cost assignment', 'Charge each line to a GL account and cost centre'],
  [/^\/posting/, 'Posting', 'Hand approved invoices back to the ERP'],
  [/^\/purchase-orders/, 'Purchase orders', 'Orders and goods receipts synced from the ERP'],
  [/^\/upload/, 'Upload', 'Put a document into the pipeline'],
];

/**
 * Identity is chosen, not authenticated. The tenant header and the "acting as" picker both
 * stand in for a login the backend does not have yet — see CLAUDE.md. Everything downstream
 * reads `session`, so when SSO arrives this panel is deleted and nothing else changes.
 */
function IdentityPanel({
  users,
  user,
  setUser,
}: {
  users: TenantUser[];
  user: string;
  setUser: (id: string) => void;
}) {
  const [tenant, setTenant] = useState(session.tenantId());

  // Default to the first approver so the inbox is not empty on a fresh load. This lives in
  // App's state rather than the panel's because the queue watcher needs the same value.
  useEffect(() => {
    if (!user && users.length > 0) {
      const preferred = users.find((u) => u.role !== 'AP_CLERK') ?? users[0];
      session.setUserId(preferred.id);
      setUser(preferred.id);
    }
  }, [users, user, setUser]);

  return (
    <div className="identity">
      <span className="lbl">Acting as</span>
      <select
        value={user}
        onChange={(e) => { session.setUserId(e.target.value); setUser(e.target.value); window.location.reload(); }}
      >
        {users.length === 0 && <option value="">no users</option>}
        {users.map((u) => (
          <option key={u.id} value={u.id}>{u.name} · {u.role}</option>
        ))}
      </select>
      <span className="lbl" style={{ marginTop: '0.3rem' }}>Tenant</span>
      <input
        value={tenant}
        placeholder="tenant UUID"
        onChange={(e) => setTenant(e.target.value)}
        onBlur={() => { if (tenant.trim() !== session.tenantId()) { session.setTenantId(tenant); window.location.reload(); } }}
      />
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const tenantId = session.tenantId();
  const { data: users } = useApi<TenantUser[]>(() => api.listUsers(), []);
  const { data: summary } = useApi(() => api.dashboard(), [location.pathname]);
  const [actingUser, setActingUser] = useState(session.userId());

  // Announces invoices arriving in the acting user's queue from anywhere in the workspace.
  const { waiting } = useInboxWatch(actingUser);

  const [, title, subtitle] = TITLES.find(([re]) => re.test(location.pathname)) ?? [null, 'Flowap', ''];

  const counts = {
    review: summary?.byStatus
      .filter((s) => s.status === 'NEEDS_REVIEW' || s.status === 'EXCEPTION')
      .reduce((a, s) => a + s.count, 0) ?? 0,
    posting: summary?.byStatus.find((s) => s.status === 'APPROVED')?.count ?? 0,
    invoices: summary?.totals.invoices ?? 0,
  };

  if (!tenantId) {
    return (
      <div className="page">
        <div className="notice">
          Set a tenant UUID to begin — find one with <code className="mono">psql -c "SELECT id, name FROM tenants;"</code>
          <div style={{ marginTop: '0.7rem' }}>
            <input
              placeholder="tenant UUID"
              style={{ width: '24rem' }}
              onBlur={(e) => { if (e.target.value.trim()) { session.setTenantId(e.target.value); window.location.reload(); } }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark" />
          <span className="name">Flowap</span>
          <span className="lbl env">AP</span>
        </div>

        <nav className="nav">
          <NavLink to="/" end>Overview</NavLink>

          <div className="nav-group"><span className="lbl">Process</span></div>
          <NavLink to="/upload">Upload</NavLink>
          <NavLink to="/invoices">Invoices <span className="count">{counts.invoices}</span></NavLink>
          <NavLink to="/review">Review queue <span className="count">{counts.review}</span></NavLink>
          <NavLink to="/coding">Cost assignment</NavLink>

          <div className="nav-group"><span className="lbl">Approve</span></div>
          <NavLink to="/inbox">
            {waiting > 0 && <span className="beacon" />}
            My approvals <span className="count">{waiting}</span>
          </NavLink>

          <div className="nav-group"><span className="lbl">Output</span></div>
          <NavLink to="/posting">Posting <span className="count">{counts.posting}</span></NavLink>

          <div className="nav-group"><span className="lbl">Master data</span></div>
          <NavLink to="/purchase-orders">Purchase orders</NavLink>
        </nav>

        <IdentityPanel users={users ?? []} user={actingUser} setUser={setActingUser} />
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{title}</h1>
          <span className="sub">{subtitle}</span>
        </header>

        <main className="page">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="/review" element={<ReviewQueuePage />} />
            <Route path="/coding" element={<CostAssignmentPage />} />
            <Route path="/inbox" element={<ApprovalsPage />} />
            <Route path="/posting" element={<PostingPage />} />
            <Route path="/purchase-orders" element={<PurchaseOrdersPage />} />
            <Route path="*" element={<div className="notice">Page not found.</div>} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
