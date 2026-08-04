import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_REVIEW_THRESHOLD,
  CORRECTABLE_FIELDS,
  DATE_FIELDS,
  FIELD_LABELS,
  MONEY_FIELDS,
  confidenceLevel,
  formatConfidence,
} from './confidence';

/**
 * The drift guard for the constants this file duplicates from the backend.
 *
 * CLAUDE.md has listed these copies as a known gap since the frontend was written: the
 * threshold, the correctable-field allowlist and the date/money classifications all restate
 * something the backend owns, and nothing checked they still agreed. The failure mode is
 * quiet in both directions — a field the backend stopped accepting keeps its Edit button and
 * 400s when used, and a field the backend started accepting silently has no Edit button at
 * all — so neither shows up as a crash.
 *
 * Same technique as `backend/src/test-support/fixtures.spec.ts`, which parses the Python mock
 * server to keep the TypeScript fixtures honest: read the other language's source and compare.
 * Parsing source is crude, but the alternative is a shared package for eleven strings, and the
 * guard only has to be sensitive enough to notice a change.
 */

import { backendSource as backend } from '../test-support/repo';

describe('the constants copied from the backend', () => {
  it('has the same review threshold', () => {
    const src = backend('src/invoices/extraction-client.service.ts');
    const m = src.match(/export const CONFIDENCE_REVIEW_THRESHOLD\s*=\s*([\d.]+)/);
    expect(m, 'could not find CONFIDENCE_REVIEW_THRESHOLD in the backend — has it moved?').toBeTruthy();
    expect(Number(m![1])).toBe(CONFIDENCE_REVIEW_THRESHOLD);
  });

  it('OFFERS EDITING FOR EXACTLY THE FIELDS THE BACKEND ACCEPTS', () => {
    const backendFields = parseCorrectableFields();
    expect(backendFields.length).toBeGreaterThan(5); // the parse found something real
    expect([...CORRECTABLE_FIELDS].sort()).toEqual([...backendFields].sort());
  });

  it('classifies dates and money the way the backend parses them', () => {
    // A field the backend runs through parseDateOrThrow must render as a date input, or the
    // reviewer types a European date into a text box and gets it read day-first by luck.
    const src = correctableBlock();
    const withParser = (parser: string) =>
      [...src.matchAll(new RegExp(`^\\s{2}(\\w+):.*${parser}`, 'gm'))].map((m) => m[1]);

    expect(withParser('parseDateOrThrow').sort()).toEqual([...DATE_FIELDS].sort());
    expect(withParser('parseMoneyOrThrow').sort()).toEqual([...MONEY_FIELDS].sort());
  });

  it('has a human label for every field it will show an Edit button on', () => {
    for (const field of CORRECTABLE_FIELDS) {
      expect(FIELD_LABELS[field], `${field} would render as its raw property name`).toBeTruthy();
    }
  });

  it('does not offer to edit the vendor name', () => {
    // Correcting a vendor means re-linking a Vendor row, not writing a column — and vendor
    // identity gates duplicate detection, so a wrong link is a money bug. It is deliberately
    // shown with a confidence score and no Edit affordance.
    expect(CORRECTABLE_FIELDS.has('vendorName')).toBe(false);
    expect(FIELD_LABELS.vendorName).toBeTruthy();
  });
});

function correctableBlock(): string {
  const src = backend('src/invoices/invoices.service.ts');
  const start = src.indexOf('export const CORRECTABLE_FIELDS');
  expect(start, 'CORRECTABLE_FIELDS is no longer in invoices.service.ts').toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start);
  return src.slice(start, end);
}

function parseCorrectableFields(): string[] {
  return [...correctableBlock().matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
}

describe('confidenceLevel', () => {
  const meta = (confidence: number, source = 'AI_EXTRACTED') =>
    ({ confidence, source }) as Parameters<typeof confidenceLevel>[0];

  it('flags a field below the threshold and clears one at it', () => {
    // The boundary matters: the backend routes on `< threshold`, so exactly 0.9 is *not* low.
    // Getting this off by one comparison makes the UI disagree with the routing decision.
    expect(confidenceLevel(meta(0.89))).toBe('low');
    expect(confidenceLevel(meta(0.9))).toBe('high');
    expect(confidenceLevel(meta(0.75))).toBe('low');
  });

  it('shows a corrected field as corrected regardless of the score it carries', () => {
    // Provenance beats confidence. A human-corrected field keeps whatever number extraction
    // reported, and showing that as "low" would send a reviewer back to a field they fixed.
    expect(confidenceLevel(meta(0.2, 'HUMAN_CORRECTED'))).toBe('corrected');
    expect(confidenceLevel(meta(0.99, 'HUMAN_CORRECTED'))).toBe('corrected');
  });

  it('distinguishes a field with no confidence from a low one', () => {
    expect(confidenceLevel(undefined)).toBe('unknown');
    expect(formatConfidence(undefined)).toBe('—');
    expect(formatConfidence(meta(0.755))).toBe('76%');
  });
});
