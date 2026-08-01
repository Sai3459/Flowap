/**
 * Keeps the two copies of the scenario corpus in step.
 *
 * The scenarios exist twice on purpose: as typed TypeScript here (so tests can drive the
 * pipeline with no network) and as Python in `extraction-service/mock_server.py` (so the live
 * system can be driven by hand and by the frontend). Two copies means they can drift, and a
 * drifted corpus is worse than one copy — a test would pass against a document the running
 * system never produces.
 *
 * This parses the Python source rather than importing it: adding a Python runtime dependency
 * to the Node test suite would be a much worse trade than a regex over a file we control.
 * It checks the scenario *names* and each one's invoice number, which is what identifies a
 * document; the field-by-field payloads are asserted by the integration tests that use them.
 *
 * This is a pure unit test — no database, so it runs in `npm test` with everything else.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCENARIOS } from './fixtures';

const MOCK_SERVER = join(__dirname, '../../../extraction-service/mock_server.py');

function pythonScenarios(): Map<string, string> {
  const source = readFileSync(MOCK_SERVER, 'utf8');
  const body = source.slice(source.indexOf('def scenarios()'));

  // Each entry looks like:   "cleanpo": invoice(\n  number="INV-1001", ...
  const found = new Map<string, string>();
  // [a-z0-9]: scenario keys can contain digits ("ready4people"). Matching only [a-z]+ silently
  // skipped that entry, so the two corpora looked out of step when they were not.
  const entry = /"([a-z0-9]+)":\s*invoice\(([\s\S]*?)\n\s*\),/g;
  for (const [, name, args] of body.matchAll(entry)) {
    const number = /number="([^"]+)"/.exec(args);
    assert.ok(number, `scenario "${name}" in mock_server.py has no number=`);
    found.set(name, number[1]);
  }
  return found;
}

describe('scenario fixtures stay in step with the Python mock', () => {
  it('defines exactly the same scenario names on both sides', () => {
    const python = pythonScenarios();
    assert.ok(python.size > 0, 'failed to parse any scenario out of mock_server.py');

    assert.deepEqual(
      Object.keys(SCENARIOS).sort(),
      [...python.keys()].sort(),
      'a scenario exists on one side only — add it to both, or the tests and the running system disagree',
    );
  });

  it('agrees on the invoice number each scenario produces', () => {
    const python = pythonScenarios();

    for (const [name, invoiceNumber] of python) {
      const ts = SCENARIOS[name as keyof typeof SCENARIOS];
      assert.equal(
        ts.invoiceNumber.value,
        invoiceNumber,
        `scenario "${name}" is ${ts.invoiceNumber.value} in TypeScript but ${invoiceNumber} in Python`,
      );
    }
  });

  it('keeps every fixture arithmetically self-consistent unless it is the one that should not be', () => {
    for (const [name, doc] of Object.entries(SCENARIOS)) {
      const subtotal = doc.subtotal.value ?? 0;
      const tax = doc.taxAmount.value ?? 0;
      const total = doc.totalAmount.value ?? 0;
      const lineSum = doc.lineItems.reduce((a, l) => a + l.lineTotal, 0);
      const addsUp = Math.abs(subtotal + tax - total) <= 0.02;

      if (name === 'inconsistent') {
        assert.ok(!addsUp, 'the "inconsistent" fixture must actually be inconsistent');
      } else {
        assert.ok(addsUp, `fixture "${name}": ${subtotal} + ${tax} != ${total}`);
        assert.ok(
          Math.abs(lineSum - subtotal) <= 0.05,
          `fixture "${name}": line items sum to ${lineSum} but subtotal is ${subtotal}`,
        );
      }
    }
  });
});
