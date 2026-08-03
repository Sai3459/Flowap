import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, session } from './api/client';
import type { CurrentUser } from './api/types';
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
 * Who you are, as the server sees it. Read-only.
 *
 * This replaces the tenant field and the "acting as" picker. Both were client-supplied
 * identity — one asserted a tenant, the other chose whose approvals you could cast — and both
 * are gone because neither could be made safe. There is nothing to change here now: tenant,
 * name and role all come from `GET /auth/me`, which reads them off the token's user row.
 */
function IdentityPanel({ me, onSignOut }: { me: CurrentUser | null; onSignOut: () => void }) {
  if (!me) return null;
  return (
    <div className="identity">
      <span className="lbl">Signed in as</span>
      <span className="mono" style={{ fontSize: '0.78rem' }}>{me.name}</span>
      <span className="lbl" style={{ marginTop: '0.3rem' }}>Role</span>
      <span className="mono" style={{ fontSize: '0.78rem' }}>{me.role}</span>
      <button className="ghost" style={{ marginTop: '0.5rem' }} onClick={onSignOut}>Sign out</button>
    </div>
  );
}

/**
 * Development sign-in against the local OIDC issuer.
 *
 * It asks the dev issuer for a token by email and stores it — the same Authorization header a
 * real IdP's token would produce, verified by the same code path. A production build replaces
 * this with a redirect to the real authorization endpoint; nothing downstream changes,
 * because everything downstream only knows there is a bearer token.
 */
function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!email.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000'}/dev-auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
      const { access_token } = (await res.json()) as { access_token: string };
      session.setToken(access_token);
      onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="notice">
        <strong>Sign in</strong>
        <div style={{ marginTop: '0.5rem', opacity: 0.8 }}>
          Development issuer. A token is minted for the email you give, then verified exactly as a
          real identity provider's would be — the account must already exist in Flowap.
        </div>
        <div style={{ marginTop: '0.7rem', display: 'flex', gap: '0.5rem' }}>
          <input
            placeholder="alice@acme.test"
            style={{ width: '20rem' }}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
        {error && <div className="err" style={{ marginTop: '0.6rem' }}>{error}</div>}
      </div>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  const [signedIn, setSignedIn] = useState(session.isSignedIn());
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [authError, setAuthError] = useState('');

  // Who the server says we are. A 401 here means the token is stale or the account was
  // removed — either way the only correct response is to stop pretending to be signed in.
  useEffect(() => {
    if (!signedIn) return;
    api.me().then(setMe, (e: Error) => {
      session.clear();
      setSignedIn(false);
      setAuthError(e.message);
    });
  }, [signedIn]);

  const { data: summary } = useApi(() => (signedIn && me ? api.dashboard() : Promise.resolve(null)), [location.pathname, me]);

  // Announces invoices arriving in this user's queue from anywhere in the workspace.
  const { waiting } = useInboxWatch(me?.userId ?? '');

  const [, title, subtitle] = TITLES.find(([re]) => re.test(location.pathname)) ?? [null, 'Flowap', ''];

  const counts = {
    review: summary?.byStatus
      .filter((s) => s.status === 'NEEDS_REVIEW' || s.status === 'EXCEPTION')
      .reduce((a, s) => a + s.count, 0) ?? 0,
    posting: summary?.byStatus.find((s) => s.status === 'APPROVED')?.count ?? 0,
    invoices: summary?.totals.invoices ?? 0,
  };

  if (!signedIn) {
    return (
      <>
        {authError && <div className="page"><div className="notice err">{authError}</div></div>}
        <SignIn onSignedIn={() => { setAuthError(''); setSignedIn(true); }} />
      </>
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

        <IdentityPanel me={me} onSignOut={() => { session.clear(); setMe(null); setSignedIn(false); }} />
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
