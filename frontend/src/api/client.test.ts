import { describe, expect, it } from 'vitest';
import { ApiError, api, session } from './client';
import { fakeApi, nestError } from '../test-support/fake-api';
import { signIn } from '../test-support/render';

/**
 * The transport layer.
 *
 * Most of this file is about **what the browser is allowed to assert**. When `x-tenant-id`
 * was removed, the rule that replaced it was that a client cannot name a tenant, a user or a
 * role anywhere in the API surface — and the server enforces that. But the server enforcing
 * it is only half the story: if the client still *sends* an actor, the field is one
 * `forbidNonWhitelisted` change away from being trusted again, and nobody would notice until
 * it was. So the assertions here are mostly about what is absent from a request body.
 */

describe('the bearer token', () => {
  it('goes out on every request', async () => {
    signIn('token-abc');
    const fake = fakeApi({ 'GET /invoices': { body: [] } });
    await api.listInvoices();
    expect(fake.only('GET /invoices').authorization).toBe('Bearer token-abc');
  });

  it('REFUSES TO SEND A REQUEST WITH NO TOKEN', async () => {
    // Not merely "the request fails" — it must not reach the network at all. An
    // unauthenticated request that happens to be rejected still leaks the path, the tenant's
    // hostname and the fact that somebody is looking.
    const fake = fakeApi({ 'GET /invoices': { body: [] } });
    await expect(api.listInvoices()).rejects.toThrow(ApiError);
    expect(fake.calls).toHaveLength(0);
  });

  it('is read per request, so signing out takes effect immediately', async () => {
    signIn('first');
    const fake = fakeApi({ 'GET /invoices': { body: [] } });
    await api.listInvoices();
    session.setToken('second');
    await api.listInvoices();
    expect(fake.matching('GET /invoices').map((c) => c.authorization)).toEqual([
      'Bearer first',
      'Bearer second',
    ]);

    session.clear();
    await expect(api.listInvoices()).rejects.toThrow(/Not signed in/);
  });
});

describe('the client cannot name an actor', () => {
  it('SENDS NO APPROVER ID WHEN DECIDING A STEP', async () => {
    // `DecideStepDto` has no `approverId` field and `forbidNonWhitelisted` rejects a request
    // that sends one — a 400, not a silent ignore. This asserts the client's half: the
    // decider is the session, and there is nothing in the body to disagree with it.
    signIn();
    const fake = fakeApi({ 'POST /approvals/steps/*/decide': { body: {} } });
    await api.decide('step-1', 'APPROVE', 'looks right');

    const call = fake.only('POST /approvals/steps/step-1/decide');
    expect(call.body).toEqual({ decision: 'APPROVE', comment: 'looks right' });
    expect(Object.keys(call.body as object)).not.toContain('approverId');
  });

  it('sends only the recipient when delegating', async () => {
    // A handoff you can perform on someone else's behalf is not a handoff, so the body names
    // who it goes *to* and never who it comes from.
    signIn();
    const fake = fakeApi({ 'POST /approvals/steps/*/delegate': { body: {} } });
    await api.delegate('step-1', 'u-colleague');

    const call = fake.only('POST /approvals/steps/step-1/delegate');
    expect(call.body).toEqual({ toApproverId: 'u-colleague', comment: undefined });
    expect(JSON.stringify(call.body)).not.toMatch(/fromApproverId|approverId"\s*:/);
  });

  it('SENDS NO BODY AT ALL WHEN POSTING TO THE ERP', async () => {
    // `postedById` is the session. Posting is irreversible and terminal, so it is the last
    // place a client could have written a false actor into a permanent record.
    signIn();
    const fake = fakeApi({ 'POST /invoices/*/post': { body: {} } });
    await api.postInvoice('inv-1');
    expect(fake.only('POST /invoices/inv-1/post').body).toBeUndefined();
  });

  it('reads the inbox and history with no id in the path', async () => {
    // These were `/approvals/inbox/:approverId` — an IDOR, since any authenticated user could
    // read a colleague's queue by changing the id. Both are session-scoped now, so there is
    // no id to enumerate. A regression would show up here as a path with a segment in it.
    signIn();
    const fake = fakeApi({ 'GET /approvals/inbox': { body: [] }, 'GET /approvals/history': { body: [] } });
    await api.inbox();
    await api.approvalHistory();
    expect(fake.calls.map((c) => c.path)).toEqual(['/approvals/inbox', '/approvals/history']);
  });

  it('names no tenant anywhere', async () => {
    signIn();
    const fake = fakeApi({ 'GET /invoices': { body: [] }, 'GET /dashboard': { body: {} } });
    await api.listInvoices();
    await api.dashboard();
    for (const call of fake.calls) {
      expect(Object.keys(call.headers).map((h) => h.toLowerCase())).not.toContain('x-tenant-id');
      expect(call.path).not.toMatch(/tenant/i);
    }
  });
});

describe('errors', () => {
  it('surfaces the server\'s message rather than a status code', async () => {
    // The refusals this product produces are written for the person hitting them — "above
    // your approval limit of 5000.00 EUR" is only useful if it survives the transport.
    signIn();
    fakeApi({
      'POST /approvals/steps/*/decide': nestError(403, 'This invoice is 40000.00 EUR, above your approval limit of 5000.00 EUR'),
    });
    await expect(api.decide('s1', 'APPROVE')).rejects.toThrow(/above your approval limit of 5000.00 EUR/);
  });

  it('joins the array of messages class-validator returns', async () => {
    signIn();
    fakeApi({ 'POST /purchase-orders': nestError(400, ['poNumber must be a string', 'currency should not be empty']) });
    await expect(api.createPurchaseOrder({})).rejects.toThrow(
      'poNumber must be a string; currency should not be empty',
    );
  });

  it('carries the status, so a caller can tell 403 from 409', async () => {
    // The two refusals on correct-field are different situations with different fixes: a
    // clerk correcting mid-approval (403) versus a posted invoice (409).
    signIn();
    fakeApi({ 'PATCH /invoices/*/correct-field': nestError(409, 'correctionBlockedByPosting') });
    await api.correctField('inv-1', 'subtotal', '10').catch((e: ApiError) => {
      expect(e).toBeInstanceOf(ApiError);
      expect(e.status).toBe(409);
    });
    expect.assertions(2);
  });

  it('falls back to the status line when the body is not JSON', async () => {
    signIn();
    fakeApi({ 'GET /invoices': { status: 502 } });
    await expect(api.listInvoices()).rejects.toThrow(/502/);
  });

  it('says the backend may be down rather than reporting a bare network error', async () => {
    signIn();
    fakeApi({}); // any call throws, which is what a refused connection looks like
    const err = await api.listInvoices().catch((e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(0);
    expect((err as ApiError).message).toMatch(/Is the backend running\?/);
  });
});

describe('bodies', () => {
  it('sends JSON with a content type', async () => {
    signIn();
    const fake = fakeApi({ 'PATCH /invoices/*/correct-field': { body: {} } });
    await api.correctField('inv-1', 'poNumber', 'PO-5000');
    const call = fake.only('PATCH /invoices/inv-1/correct-field');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.body).toEqual({ fieldName: 'poNumber', correctedValue: 'PO-5000' });
  });

  it('LEAVES CONTENT-TYPE OFF A MULTIPART UPLOAD', async () => {
    // Setting it by hand omits the boundary the browser generates, and the server then cannot
    // parse the parts. The failure is a confusing 400 on a file that is perfectly fine.
    signIn();
    const fake = fakeApi({ 'POST /invoices/upload': { body: {} } });
    await api.upload(new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' }));

    const call = fake.only('POST /invoices/upload');
    expect(call.headers['Content-Type']).toBeUndefined();
    expect(call.body).toBeInstanceOf(FormData);
    expect((call.body as FormData).get('sourceChannel')).toBe('MANUAL_UPLOAD');
  });

  it('handles a 204 without trying to parse an empty body', async () => {
    signIn();
    fakeApi({ 'GET /approvals/inbox': { status: 204 } });
    await expect(api.inbox()).resolves.toBeUndefined();
  });
});
