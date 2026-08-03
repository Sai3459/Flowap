/**
 * The S/4HANA transport, driven over a real socket against a mock that speaks OData V2.
 *
 * Everything here goes through `fetch` to a server on a real port — no stubbed HTTP. That is
 * the point: the mappers were correct against a specification and never once opened a
 * connection, and the protocol details that break clients (the CSRF handshake, cookie binding,
 * token expiry) only exist at the transport layer.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { S4Client, S4AuthError, S4NotFoundError, S4RequestError } from './s4-client';
import { ApiKeyAuth } from './s4-auth';
import { startMockS4, type MockS4Handle } from './mock-s4-server';
import { mapPurchaseOrders } from './s4-purchase-order';

let mock: MockS4Handle;
const client = () => new S4Client({ baseUrl: mock.url, auth: new ApiKeyAuth('test-key') });

describe('S4Client over real HTTP', () => {
  before(async () => {
    mock = await startMockS4({ requireApiKey: 'test-key' });
  });
  after(async () => mock.close());

  it('reads a collection and unwraps the d envelope', async () => {
    const rows = await client().list('/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder');
    assert.equal(rows.length, 1);
  });

  it('feeds the mapper end to end, nested $expand included', async () => {
    // The whole chain: socket → envelope → mapper. The nested `to_PurchaseOrderItem` arrives as
    // a bare `{ results }`, which is the shape that silently produced zero line items before
    // odataCollection handled it.
    const raw = await client().getRaw('/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder', {
      $expand: 'to_PurchaseOrderItem',
    });
    const [po] = mapPurchaseOrders(raw);
    assert.equal(po.poNumber, '4500000123');
    assert.equal(po.lines.length, 1, 'nested expand must not come back empty');
    assert.equal(po.lines[0].lineTotal, 1200);
    assert.equal(po.totalAmount, 1200);
  });

  it('builds query strings without mangling OData options', async () => {
    const url = client().url('/svc/A_Thing', { $top: 1, $filter: "CompanyCode eq '1710'", $skip: undefined });
    assert.match(url, /\$top=1/);
    // Spaces encoded, quotes left literal — exactly the form SAP's own examples use.
    assert.match(url, /\$filter=CompanyCode%20eq%20'1710'/);
    assert.ok(!url.includes('$skip'), 'undefined options must be omitted, not sent empty');
  });

  it('returns an empty array for an empty collection rather than throwing', async () => {
    assert.deepEqual(await client().list('/svc/A_Empty'), []);
  });
});

describe('failures are distinguishable', () => {
  before(async () => {
    mock = await startMockS4({ requireApiKey: 'test-key' });
  });
  after(async () => mock.close());

  it('surfaces SAP error text, not just the status', async () => {
    const bad = new S4Client({ baseUrl: mock.url, auth: new ApiKeyAuth('wrong-key') });
    await bad.list('/svc/A_PurchaseOrder').then(
      () => assert.fail('should have refused'),
      (err: S4AuthError) => {
        assert.ok(err instanceof S4AuthError);
        assert.match(err.message, /invalid API key/, 'the actionable text is in the body, not the status');
        assert.equal(err.status, 401);
      },
    );
  });

  it('says a 404 is ambiguous, so a wrong base URL is not read as "no data"', async () => {
    await client().list('/svc/A_DoesNotExist').then(
      () => assert.fail('should have refused'),
      (err: S4NotFoundError) => {
        assert.ok(err instanceof S4NotFoundError);
        assert.match(err.message, /service path or base URL is wrong/);
      },
    );
  });

  it('reports an unreachable host rather than hanging', async () => {
    const dead = new S4Client({
      baseUrl: 'http://127.0.0.1:1',
      auth: new ApiKeyAuth('k'),
      timeoutMs: 2_000,
    });
    await assert.rejects(() => dead.list('/svc/A_Thing'), (err: S4RequestError) => {
      assert.equal(err.status, 0);
      assert.match(err.message, /Could not reach S\/4HANA/);
      return true;
    });
  });

  it('times out instead of waiting forever', async () => {
    // The stand-in has to honour the abort signal, exactly as real fetch does. A fake that
    // simply never settles would hang the suite rather than test the timeout — which is what
    // the first version of this test did.
    const slow = new S4Client({
      baseUrl: mock.url,
      auth: new ApiKeyAuth('test-key'),
      timeoutMs: 20,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })) as unknown as typeof fetch,
    });
    await assert.rejects(() => slow.list('/svc/A_Thing'), /timed out after 20ms/);
  });

  it('does not crash on a malformed body', async () => {
    await assert.rejects(() => client().getRaw('/svc/A_Broken'));
  });
});

describe('the CSRF handshake — the part specs do not tell you', () => {
  before(async () => {
    mock = await startMockS4({ requireApiKey: 'test-key' });
  });
  after(async () => mock.close());

  it('fetches a token before writing, and sends the session cookie with it', async () => {
    const c = client();
    const result = await c.post('/svc/A_SupplierInvoice', { CompanyCode: '1710' });
    assert.equal((result as { SupplierInvoice: string }).SupplierInvoice, '5105600000');

    const fetchCall = mock.requests.find((r) => r.csrf?.toLowerCase() === 'fetch');
    const write = mock.requests.find((r) => r.method === 'POST');
    assert.ok(fetchCall, 'a token must be fetched before the write');
    assert.ok(write?.csrf && write.csrf.toLowerCase() !== 'fetch', 'the write must carry the token');
    assert.match(write!.cookie ?? '', /SAP_SESSIONID=/, 'and the session cookie it was issued with');
  });

  it('reuses the token for a second write rather than re-fetching', async () => {
    const c = client();
    await c.post('/svc/A_SupplierInvoice', { n: 1 });
    const before = mock.requests.filter((r) => r.csrf?.toLowerCase() === 'fetch').length;
    await c.post('/svc/A_SupplierInvoice', { n: 2 });
    const after = mock.requests.filter((r) => r.csrf?.toLowerCase() === 'fetch').length;
    assert.equal(after, before, 'a cached token must not be re-fetched on every write');
  });

  it('RETRIES ONCE when SAP says the token expired', async () => {
    // The failure that looks like a permissions problem: a write that worked a minute ago
    // returns 403 with `x-csrf-token: Required`. Without the retry a sync job dies mid-run.
    const c = client();
    await c.post('/svc/A_SupplierInvoice', { warm: true }); // establish a token
    mock.options.expireNextCsrf = true;

    const result = await c.post('/svc/A_SupplierInvoice', { CompanyCode: '1710' });
    assert.equal((result as { SupplierInvoice: string }).SupplierInvoice, '5105600000');
  });

  it('gives up rather than retrying forever', async () => {
    // Bounded to one attempt on purpose. Retrying a posting blindly is how duplicate
    // accounting documents get created.
    const c = new S4Client({
      baseUrl: mock.url,
      auth: new ApiKeyAuth('test-key'),
      fetchImpl: (async (url: string, init: RequestInit) => {
        const res = await fetch(url, init);
        if (init.method === 'POST') {
          return new Response(JSON.stringify({ error: { message: { value: 'CSRF token validation failed' } } }), {
            status: 403,
            headers: { 'x-csrf-token': 'Required', 'Content-Type': 'application/json' },
          });
        }
        return res;
      }) as unknown as typeof fetch,
    });
    await assert.rejects(() => c.post('/svc/A_SupplierInvoice', {}), S4AuthError);
  });
});

describe('ping, for a test-connection button', () => {
  before(async () => {
    mock = await startMockS4({ requireApiKey: 'test-key' });
  });
  after(async () => mock.close());

  it('proves connectivity and credentials with one bounded read', async () => {
    const result = await client().ping('/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder');
    assert.deepEqual(result, { ok: true, sample: 1 });
    const read = mock.requests.find((r) => r.path.includes('A_PurchaseOrder'));
    assert.ok(read, 'ping must actually call out');
  });

  it('fails with the credential error when the key is wrong', async () => {
    const bad = new S4Client({ baseUrl: mock.url, auth: new ApiKeyAuth('nope') });
    await assert.rejects(() => bad.ping('/svc/A_PurchaseOrder'), S4AuthError);
  });
});
