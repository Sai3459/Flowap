import { describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { NAV_ROLES } from './App';
import { session } from './api/client';
import { fakeApi, nestError } from './test-support/fake-api';
import { renderScreen, signIn } from './test-support/render';
import { currentUser } from './test-support/fixtures';
import { backendSource } from './test-support/repo';

/**
 * The shell: signing in, who the server says you are, and which doors are shown.
 *
 * Identity is the thing this file is really about. The tenant field and the "acting as" role
 * picker were **deleted** when auth landed, not hidden — both were client-asserted identity —
 * and several tests here exist to keep them deleted.
 */

const shellRoutes = (me = currentUser()) => ({
  'GET /auth/me': { body: me },
  'GET /dashboard': { body: { totals: { invoices: 3 }, byStatus: [], openExceptions: [], recentActivity: [] } },
  'GET /approvals/inbox': { body: [] },
  'GET /approvals/history': { body: [] },
  'GET /users': { body: [] },
});

describe('signing in', () => {
  it('shows the sign-in screen and calls nothing until there is a token', async () => {
    const fake = fakeApi(shellRoutes());
    renderScreen(<App />);

    expect(await screen.findByPlaceholderText('alice@acme.test')).toBeInTheDocument();
    expect(fake.calls).toHaveLength(0);
  });

  it('mints a token for the given email and then asks the server who that is', async () => {
    const fake = fakeApi({
      ...shellRoutes(),
      'POST /dev-auth/token': { body: { access_token: 'minted-token' } },
    });
    renderScreen(<App />, { route: '/inbox' });

    await userEvent.type(await screen.findByPlaceholderText('alice@acme.test'), 'manager1@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(fake.only('POST /dev-auth/token').body).toEqual({ email: 'manager1@acme.test' });
    expect(await screen.findByText('Marta Manager')).toBeInTheDocument();
    // Every subsequent request carries the minted token.
    expect(fake.only('GET /auth/me').authorization).toBe('Bearer minted-token');
  });

  it('reports a refused sign-in instead of appearing to succeed', async () => {
    fakeApi({ ...shellRoutes(), 'POST /dev-auth/token': { status: 404 } });
    renderScreen(<App />);

    await userEvent.type(await screen.findByPlaceholderText('alice@acme.test'), 'nobody@acme.test');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/Token endpoint returned 404/)).toBeInTheDocument();
    expect(session.isSignedIn()).toBe(false);
  });
});

describe('a token the server will not accept', () => {
  it('THROWS THE STALE TOKEN AWAY RATHER THAN STAYING HALF SIGNED IN', async () => {
    // Deactivating a user revokes tokens already issued — the user row is read on every
    // request, so a leaver's existing bearer token 401s on its next call. The client has to
    // act on that. Keeping the token would leave a shell that renders but 401s everything,
    // which reads as the product being broken rather than as the account being closed.
    signIn('stale-token');
    fakeApi({ ...shellRoutes(), 'GET /auth/me': nestError(401, 'Unauthorized') });
    renderScreen(<App />);

    expect(await screen.findByPlaceholderText('alice@acme.test')).toBeInTheDocument();
    expect(session.isSignedIn()).toBe(false);
    expect(screen.getByText('Unauthorized')).toBeInTheDocument();
  });

  it('signs out on request', async () => {
    signIn();
    fakeApi(shellRoutes());
    renderScreen(<App />, { route: '/inbox' });

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(session.isSignedIn()).toBe(false);
    expect(await screen.findByPlaceholderText('alice@acme.test')).toBeInTheDocument();
  });
});

describe('identity is read, never chosen', () => {
  it('SHOWS NO TENANT FIELD AND NO ROLE PICKER', async () => {
    // The two controls that used to be here sent `x-tenant-id` and chose whose approvals you
    // could cast. Both are gone, and a regression would most plausibly arrive as a helpful
    // "switch tenant" or "view as" control rather than as a security change anyone reviewed.
    signIn();
    fakeApi(shellRoutes());
    renderScreen(<App />, { route: '/inbox' });

    await screen.findByText('Marta Manager');
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    for (const el of screen.queryAllByRole('textbox')) {
      expect(el).not.toHaveAttribute('placeholder', expect.stringMatching(/tenant/i));
    }
    expect(screen.queryByText(/tenant/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/acting as/i)).not.toBeInTheDocument();
  });

  it('shows the name and role the server returned, not anything local', async () => {
    signIn();
    fakeApi(shellRoutes(currentUser({ name: 'Carla Controller', role: 'CONTROLLER' })));
    renderScreen(<App />, { route: '/inbox' });

    expect(await screen.findByText('Carla Controller')).toBeInTheDocument();
    expect(screen.getByText('CONTROLLER')).toBeInTheDocument();
  });
});

describe('navigation by role', () => {
  /** The navigation labels a role is shown, with the count badges stripped. */
  const navFor = async (role: string) => {
    cleanup();
    fakeApi(shellRoutes(currentUser({ role })));
    renderScreen(<App />, { route: '/inbox' });
    await screen.findByText(role);
    return screen.getAllByRole('link').map((a) => (a.textContent ?? '').replace(/\d+$/, '').trim());
  };

  it('does not show an AP clerk the posting screen', async () => {
    signIn();
    const nav = await navFor('AP_CLERK');
    expect(nav).toContain('Upload');
    expect(nav).not.toContain('Posting');
  });

  it('does not show an ADMIN anything transactional', async () => {
    // ADMIN configures and cannot transact — that separation is the point of the role.
    signIn();
    const nav = await navFor('ADMIN');
    expect(nav).not.toContain('Upload');
    expect(nav).not.toContain('Cost assignment');
    expect(nav).not.toContain('Posting');
    expect(nav).toContain('Overview');
  });

  it('shows an APPROVER their queue and almost nothing else', async () => {
    // A line manager asked to approve one payment has no business listing the invoice book.
    signIn();
    const nav = await navFor('APPROVER');
    expect(nav).toContain('My approvals');
    expect(nav).not.toContain('Invoices');
    expect(nav).not.toContain('Overview');
  });

  it('gives every role a queue, including one that will never have anything in it', async () => {
    signIn();
    for (const role of ['AP_CLERK', 'APPROVER', 'AP_MANAGER', 'CONTROLLER', 'ADMIN']) {
      expect(await navFor(role), role).toContain('My approvals');
    }
  });
});

describe('the navigation mirror does not drift from the server', () => {
  /**
   * `NAV_ROLES` restates the backend permission matrix so the shell can avoid showing people
   * doors that will not open. It is **not** a security boundary — the server returns 403
   * regardless — but a stale mirror is still a real defect in both directions: a menu item
   * that 403s, or a screen a role is entitled to and cannot find.
   *
   * The source of truth read here is `backend/src/auth/rbac.int-spec.ts`, whose MATRIX is
   * asserted route by route in **both** directions against a running application. So it is not
   * a second opinion about the rules — it is the statement the server is already tested
   * against.
   */
  const matrix = (() => {
    const src = backendSource('src/auth/rbac.int-spec.ts');
    const rows = new Map<string, string[]>();
    for (const m of src.matchAll(
      /method:\s*'(\w+)',\s*\n?\s*path:\s*'([^']+)',\s*\n?\s*allow:\s*\[([^\]]*)\]/g,
    )) {
      rows.set(`${m[1]} ${m[2]}`, [...m[3].matchAll(/'(\w+)'/g)].map((r) => r[1]));
    }
    return rows;
  })();

  /** The backend route each navigation area leads to. */
  const AREA_ROUTE: Record<keyof typeof NAV_ROLES, string | null> = {
    overview: 'GET /dashboard',
    upload: 'POST /invoices',
    invoices: 'GET /invoices',
    coding: 'GET /cost-assignment/queue',
    posting: 'GET /posting/ready',
    // GET /purchase-orders carries no @Roles at all — any authenticated user of the tenant may
    // read it — so there is no matrix row to compare against. Checked separately below.
    purchaseOrders: null,
  };

  it('found the matrix it is comparing against', () => {
    expect(matrix.size).toBeGreaterThan(15);
  });

  it('MATCHES THE SERVER FOR EVERY AREA THAT HAS A MATRIX ROW', () => {
    for (const [area, route] of Object.entries(AREA_ROUTE)) {
      if (!route) continue;
      const allowed = matrix.get(route);
      expect(allowed, `${route} is no longer in the backend matrix — has it moved?`).toBeTruthy();
      expect([...NAV_ROLES[area as keyof typeof NAV_ROLES]].sort(), `nav '${area}'`).toEqual(
        [...allowed!].sort(),
      );
    }
  });

  it('shows purchase orders to everyone, matching an endpoint with no role guard', () => {
    const src = backendSource('src/purchase-orders/purchase-orders.controller.ts');
    // The read is `@Get()` with nothing above it; the writes carry @Roles. If a guard is ever
    // added to the read, this fails and the nav has to narrow with it.
    expect(src).toMatch(/\n {2}@Get\(\)\n/);
    expect(NAV_ROLES.purchaseOrders).toEqual(['AP_CLERK', 'APPROVER', 'AP_MANAGER', 'CONTROLLER', 'ADMIN']);
  });
});
