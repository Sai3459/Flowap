/**
 * OData V2 wire-format handling.
 *
 * These are the cases that corrupt data silently rather than failing loudly — the same class
 * of bug as the European date and money parsing that two real invoices exposed, arriving from
 * a different direction. Worth testing before a single field name is known.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  asAmountString,
  formatODataDate,
  odataCollection,
  odataEntity,
  odataErrorMessage,
  parseODataDate,
  parseODataDecimal,
} from './s4-odata';
import { ApiKeyAuth, BasicAuth, OAuth2ClientCredentialsAuth } from './s4-auth';

describe('OData V2 dates', () => {
  it('parses the /Date(...)/ form SAP actually sends', () => {
    // 2026-05-04T00:00:00Z — the Arena Media invoice date.
    const d = parseODataDate('/Date(1777852800000)/');
    assert.equal(d?.toISOString().slice(0, 10), '2026-05-04');
  });

  it('parses it with a timezone offset suffix', () => {
    const d = parseODataDate('/Date(1777852800000+0120)/');
    // The epoch value is already UTC; the suffix says how SAP displayed it, so the instant
    // must not be shifted.
    assert.equal(d?.getTime(), 1777852800000);
  });

  it('handles negative epochs, for dates before 1970', () => {
    assert.equal(parseODataDate('/Date(-86400000)/')?.toISOString().slice(0, 10), '1969-12-31');
  });

  it('also accepts plain ISO, which newer services emit', () => {
    assert.equal(parseODataDate('2026-05-04')?.toISOString().slice(0, 10), '2026-05-04');
    assert.equal(parseODataDate('2026-05-04T09:30:00Z')?.toISOString(), '2026-05-04T09:30:00.000Z');
  });

  it('returns null rather than an Invalid Date', () => {
    // `new Date('/Date(...)/')` yields Invalid Date, which then propagates as NaN through
    // every comparison instead of failing where the problem is.
    for (const junk of ['', 'not a date', null, undefined, 42, '/Date(abc)/']) {
      assert.equal(parseODataDate(junk), null, String(junk));
    }
  });

  it('formats a date the way S/4 expects it back', () => {
    assert.equal(formatODataDate(new Date('2026-05-04T00:00:00Z')), '2026-05-04T00:00:00');
  });
});

describe('OData V2 decimals', () => {
  it('parses the string form SAP sends', () => {
    assert.equal(parseODataDecimal('1200.00'), 1200);
    assert.equal(parseODataDecimal('10000.00'), 10000);
    assert.equal(parseODataDecimal('-800.00'), -800);
  });

  it('keeps money as a canonical string for storage', () => {
    // Money is numeric(18,2) and passed to Drizzle as a string precisely to stay out of
    // floating point. asAmountString is what persisted values must go through.
    assert.equal(asAmountString('1200'), '1200.00');
    assert.equal(asAmountString('1200.5'), '1200.50');
    assert.equal(asAmountString(1200.005), '1200.01');
  });

  it('returns null for absent or unparseable amounts', () => {
    for (const junk of ['', '  ', null, undefined, 'abc', NaN]) {
      assert.equal(parseODataDecimal(junk), null, String(junk));
      assert.equal(asAmountString(junk), null, String(junk));
    }
  });
});

describe('OData V2 envelopes', () => {
  it('unwraps a collection', () => {
    assert.deepEqual(odataCollection({ d: { results: [{ a: 1 }, { a: 2 }] } }), [{ a: 1 }, { a: 2 }]);
  });

  it('tolerates the shapes different services and versions use', () => {
    assert.deepEqual(odataCollection({ d: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepEqual(odataCollection([{ a: 1 }]), [{ a: 1 }]);
  });

  it('returns an empty array rather than throwing on anything unexpected', () => {
    // A sync job must not die because one response came back shaped differently.
    for (const junk of [null, undefined, {}, { d: {} }, 'nonsense', 42]) {
      assert.deepEqual(odataCollection(junk), [], String(junk));
    }
  });

  it('unwraps a single entity', () => {
    assert.deepEqual(odataEntity({ d: { PurchaseOrder: '4500000001' } }), { PurchaseOrder: '4500000001' });
    assert.equal(odataEntity({ d: [{ a: 1 }] }), null, 'a collection is not an entity');
  });

  it('surfaces SAP error text, because it is the actionable part', () => {
    const body = { error: { message: { value: 'Company code 1710 does not exist' } } };
    assert.equal(odataErrorMessage(body, 'fallback'), 'Company code 1710 does not exist');
    assert.equal(odataErrorMessage({}, 'fallback'), 'fallback');
  });
});

describe('S/4HANA authentication', () => {
  it('sends the sandbox APIKey header', async () => {
    assert.deepEqual(await new ApiKeyAuth('abc123').headers(), { APIKey: 'abc123' });
  });

  it('encodes basic credentials', async () => {
    const headers = await new BasicAuth('COMM_USER', 'secret').headers();
    assert.equal(headers.Authorization, `Basic ${Buffer.from('COMM_USER:secret').toString('base64')}`);
  });

  it('fetches an OAuth2 token and caches it', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ access_token: `token-${calls}`, expires_in: 3600 }),
      } as Response;
    }) as unknown as typeof fetch;

    const auth = new OAuth2ClientCredentialsAuth('https://token', 'id', 'secret', fakeFetch);

    assert.deepEqual(await auth.headers(), { Authorization: 'Bearer token-1' });
    assert.deepEqual(await auth.headers(), { Authorization: 'Bearer token-1' });
    assert.equal(calls, 1, 'a cached token must not be re-fetched on every request');
  });

  it('refreshes a token that is about to expire', async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      // Expires inside the 60s safety margin, so the next call must refresh. A token that
      // expires in flight produces a 401 on a posting, and retrying a posting is how
      // duplicate accounting documents happen.
      return { ok: true, json: async () => ({ access_token: `token-${calls}`, expires_in: 30 }) } as Response;
    }) as unknown as typeof fetch;

    const auth = new OAuth2ClientCredentialsAuth('https://token', 'id', 'secret', fakeFetch);
    await auth.headers();
    await auth.headers();
    assert.equal(calls, 2);
  });

  it('fails without echoing the response body', async () => {
    const fakeFetch = (async () =>
      ({ ok: false, status: 401, json: async () => ({ client_id: 'leaked' }) }) as Response) as unknown as typeof fetch;

    const auth = new OAuth2ClientCredentialsAuth('https://token', 'id', 'secret', fakeFetch);
    await assert.rejects(() => auth.headers(), (err: Error) => {
      assert.match(err.message, /401/);
      assert.ok(!err.message.includes('leaked'), 'must not put credentials into a log line');
      return true;
    });
  });
});
