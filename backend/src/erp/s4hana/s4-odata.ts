/**
 * The bits of OData V2 that actually cause bugs, isolated and testable.
 *
 * S/4HANA Cloud's released APIs are OData **V2**, which serialises three things in ways that
 * will silently corrupt data if handled naively:
 *
 *   1. Dates arrive as `"/Date(1748563200000)/"` — a string, not ISO, sometimes with a
 *      timezone offset suffix. `new Date()` on that yields Invalid Date.
 *   2. Decimals arrive as **strings** (`"1200.00"`), deliberately, to avoid float error.
 *      Parsing them to `number` too early re-introduces exactly what SAP avoided.
 *   3. Collections are wrapped as `{ d: { results: [...] } }`, and a single entity as
 *      `{ d: {...} }` — so the same endpoint shape differs by cardinality.
 *
 * We already learned the cost of locale-naive parsing from two real invoices; this is the
 * same class of bug arriving from a different direction, so it gets the same treatment:
 * pure functions, tested, no guessing.
 *
 * Field *names* are filled in once the API specification arrives. These helpers do not depend
 * on them.
 */

/** `/Date(1748563200000)/` or `/Date(1748563200000+0120)/` → Date. Null for absent/unparseable. */
export function parseODataDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  if (typeof raw !== 'string' || !raw) return null;

  const edm = /^\/Date\((-?\d+)([+-]\d{1,4})?\)\/$/.exec(raw);
  if (edm) {
    const millis = Number(edm[1]);
    if (!Number.isFinite(millis)) return null;
    // The offset suffix is minutes from UTC. The epoch value is already UTC, so the offset
    // describes how SAP displayed it, not a correction to apply — ignoring it keeps the
    // instant correct.
    return new Date(millis);
  }

  // Some services emit plain ISO (`Edm.DateTimeOffset` in newer releases).
  const iso = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(raw);
  if (iso) {
    const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Date → `yyyy-MM-ddT00:00:00` as S/4 expects for an Edm.DateTime day field. */
export function formatODataDate(date: Date): string {
  return `${date.toISOString().slice(0, 10)}T00:00:00`;
}

/**
 * Decimal string → number, for arithmetic only.
 *
 * Money is stored as `numeric(18,2)` and passed to Drizzle as a string precisely to keep it
 * out of floating point end to end, so use `asAmountString` for anything persisted. This is
 * for comparisons and totals where a number is genuinely wanted.
 */
export function parseODataDecimal(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Decimal as stored: a canonical string, never a float. */
export function asAmountString(raw: unknown): string | null {
  const n = parseODataDecimal(raw);
  return n === null ? null : n.toFixed(2);
}

/** Unwraps `{ d: { results: [...] } }`, `{ d: [...] }` or a bare array. Never throws. */
export function odataCollection<T = Record<string, unknown>>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const d = (body as { d?: unknown })?.d;
  if (Array.isArray(d)) return d as T[];
  const results = (d as { results?: unknown })?.results;
  if (Array.isArray(results)) return results as T[];
  return [];
}

/** Unwraps `{ d: {...} }` for a single entity. */
export function odataEntity<T = Record<string, unknown>>(body: unknown): T | null {
  const d = (body as { d?: unknown })?.d;
  if (d && typeof d === 'object' && !Array.isArray(d)) return d as T;
  if (body && typeof body === 'object' && !('d' in (body as object))) return body as T;
  return null;
}

/**
 * SAP returns errors as `{ error: { message: { value: "..." } } }` with an HTTP error status.
 * Surfacing that text matters: "Company code 1710 does not exist" is actionable, whereas
 * "Request failed with status 400" sends someone digging through logs.
 */
export function odataErrorMessage(body: unknown, fallback: string): string {
  const message = (body as { error?: { message?: unknown } })?.error?.message;
  if (typeof message === 'string') return message;
  const value = (message as { value?: unknown })?.value;
  return typeof value === 'string' ? value : fallback;
}
