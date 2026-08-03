/**
 * The scenario corpus, as typed TypeScript.
 *
 * These nine documents already existed, but only inside `extraction-service/mock_server.py`,
 * reachable only by putting a token in a file URL and only ever exercised by me curling the
 * running API. That made them a demo fixture, not a test corpus: nothing re-ran them, so
 * nothing caught a regression in the checks they were designed to trip.
 *
 * Restating them here — matching `ExtractionResult` exactly — lets the integration tests drive
 * the real pipeline with a stubbed extractor and assert on the end state. The Python mock stays
 * as-is for driving the live system by hand and for the frontend; the two are kept in step by
 * `fixtures.consistency.spec.ts`, which fails if a scenario exists in one and not the other.
 *
 * Every scenario bills against the PO shapes in `db/seed.ts`. Change one, change both.
 */
import type { ExtractionResult } from '../invoices/extraction-client.service';

const NORTHWIND_BANK = {
  iban: 'DE89370400440532013000',
  accountNumber: null,
  bic: 'COBADEFFXXX',
  bankName: 'Commerzbank',
};

interface LineSpec {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  confidence?: number;
  taxCode?: string | null;
  taxRate?: number | null;
}

function line(l: LineSpec): ExtractionResult['lineItems'][number] {
  return {
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: l.lineTotal,
    taxCode: l.taxCode ?? 'V1',
    taxRate: l.taxRate ?? 8.0,
    confidence: l.confidence ?? 0.96,
  };
}

interface InvoiceSpec {
  number: string;
  vendor: string;
  subtotal: number;
  tax: number;
  total: number;
  lines: LineSpec[];
  po?: string | null;
  reference?: string | null;
  invoiceDate?: string;
  dueDate?: string;
  supplyDate?: string | null;
  vendorTaxId?: string | null;
  bank?: typeof NORTHWIND_BANK | null;
  currency?: string;
  amountConfidence?: number;
}

/** Mirrors `invoice()` in mock_server.py — only the interesting bits vary per scenario. */
function invoice(spec: InvoiceSpec): ExtractionResult {
  const {
    number, vendor, subtotal, tax, total, lines,
    po = null, reference = null,
    invoiceDate = '2026-07-15', dueDate = '2026-08-14', supplyDate = '2026-07-10',
    vendorTaxId = 'DE123456789', bank = null, currency = 'USD', amountConfidence = 0.97,
  } = spec;

  return {
    documentType: { value: 'INVOICE', confidence: 0.99 },
    invoiceNumber: { value: number, confidence: 0.98 },
    poNumber: { value: po, confidence: po ? 0.95 : 0.0 },
    referenceNumber: { value: reference, confidence: reference ? 0.9 : 0.0 },
    invoiceDate: { value: invoiceDate, confidence: 0.96 },
    dueDate: { value: dueDate, confidence: 0.93 },
    supplyDate: { value: supplyDate, confidence: supplyDate ? 0.92 : 0.0 },
    currency: { value: currency, confidence: 0.99 },
    vendorName: { value: vendor, confidence: 0.97 },
    vendorTaxId: { value: vendorTaxId, confidence: vendorTaxId ? 0.94 : 0.0 },
    bankDetails: { value: bank, confidence: bank ? 0.93 : 0.0 },
    subtotal: { value: subtotal, confidence: amountConfidence },
    taxAmount: { value: tax, confidence: amountConfidence },
    totalAmount: { value: total, confidence: amountConfidence },
    lineItems: lines.map(line),
  };
}

export const SCENARIOS = {
  /** Bills PO-5000 exactly as ordered: 20 @ 60.00. Should clear to approval untouched. */
  cleanpo: invoice({
    number: 'INV-1001', vendor: 'Northwind Traders', po: 'PO-5000', reference: 'DN-77120',
    subtotal: 1200.0, tax: 96.0, total: 1296.0, bank: NORTHWIND_BANK,
    lines: [{ description: 'Consulting hours', quantity: 20, unitPrice: 60, lineTotal: 1200.0 }],
  }),

  /** Same quantity, unit price 69 instead of 60 -> +15% price variance. */
  pricevariance: invoice({
    number: 'INV-3001', vendor: 'Northwind Traders', po: 'PO-5000',
    subtotal: 1380.0, tax: 110.4, total: 1490.4, bank: NORTHWIND_BANK,
    lines: [{ description: 'Consulting hours', quantity: 20, unitPrice: 69, lineTotal: 1380.0 }],
  }),

  /** Bills 26 of 20 ordered: quantity variance, and over the 20 received, so the GRN check trips too. */
  qtyvariance: invoice({
    number: 'INV-3002', vendor: 'Northwind Traders', po: 'PO-5000',
    subtotal: 1560.0, tax: 124.8, total: 1684.8, bank: NORTHWIND_BANK,
    lines: [{ description: 'Consulting hours', quantity: 26, unitPrice: 60, lineTotal: 1560.0 }],
  }),

  /** Small overbill inside the default 5% price tolerance — must pass silently. */
  withintolerance: invoice({
    number: 'INV-3003', vendor: 'Northwind Traders', po: 'PO-5000',
    subtotal: 1224.0, tax: 97.92, total: 1321.92, bank: NORTHWIND_BANK,
    lines: [{ description: 'Consulting hours', quantity: 20, unitPrice: 61.2, lineTotal: 1224.0 }],
  }),

  /** Cites a PO that does not exist — a hard stop, not a variance. */
  unknownpo: invoice({
    number: 'INV-4002', vendor: 'Northwind Traders', po: 'PO-DOESNOTEXIST',
    subtotal: 1200.0, tax: 96.0, total: 1296.0, bank: NORTHWIND_BANK,
    lines: [{ description: 'Consulting hours', quantity: 20, unitPrice: 60, lineTotal: 1200.0 }],
  }),

  /** Right PO, wrong currency against the order. */
  currencymismatch: invoice({
    number: 'INV-4003', vendor: 'Northwind Traders', po: 'PO-5000', currency: 'EUR',
    subtotal: 1200.0, tax: 96.0, total: 1296.0, bank: NORTHWIND_BANK,
    lines: [{ description: 'Consulting hours', quantity: 20, unitPrice: 60, lineTotal: 1200.0 }],
  }),

  /** No order referenced at all — the non-PO path. */
  nopo: invoice({
    number: 'INV-4001', vendor: 'Office Supplies Co.', po: null, vendorTaxId: 'DE987654321',
    subtotal: 450.0, tax: 36.0, total: 486.0,
    lines: [{ description: 'Paper reams', quantity: 30, unitPrice: 15, lineTotal: 450.0 }],
  }),

  /** Low amount, no PO — drives amount-based approval routing. */
  lowamount: invoice({
    number: 'INV-2001', vendor: 'Office Supplies Co.', po: null, vendorTaxId: 'DE987654321',
    invoiceDate: '2026-07-20', dueDate: '2026-08-19',
    subtotal: 450.0, tax: 36.0, total: 486.0,
    lines: [{ description: 'Paper reams', quantity: 30, unitPrice: 15, lineTotal: 450.0 }],
  }),

  /**
   * Total contradicts subtotal + tax (500 + 40 != 900). The extraction service's arithmetic
   * pass is what downgrades the amount confidences here, regardless of the 0.95 claimed —
   * so a fixture used straight, without that pass, still carries the high confidence.
   */
  inconsistent: invoice({
    number: 'INV-9001', vendor: 'Acme Supplies Inc.', po: null, vendorTaxId: 'DE555000111',
    invoiceDate: '2026-07-01', dueDate: '2026-07-31',
    subtotal: 500.0, tax: 40.0, total: 900.0, amountConfidence: 0.95,
    lines: [{ description: 'Widget A', quantity: 10, unitPrice: 50, lineTotal: 500.0, confidence: 0.95 }],
  }),
  /**
   * REAL DOCUMENT — Arena Media Comunications España, S.A. (Havas Media Network) billing
   * PUMA ITALIA SRL. Invoice 2026001293, dated 04/05/2026, due 03/06/2026.
   *
   * Provenance: transcribed by hand from the supplied PDF, then **checked against a real
   * extraction run** once an API key became available. That run corrected one value here —
   * `vendorName` was transcribed as "Comunicaciones", the Spanish spelling, which appears
   * nowhere on the document. The letterhead reads "ARENA MEDIA COMUNICATIONS ESPAÑA, S.A."
   * and the footer "Arena Media Communications España S.A.". The model read the letterhead
   * correctly and the human did not.
   *
   * (Note those two printed spellings differ by one `m`, so they normalise to *different*
   * vendor keys. `resolveVendor` only ever sees the letterhead, so this is latent rather than
   * live — but a supplier whose own footer disagrees with its letterhead is exactly the
   * fragmentation `normaliseVendorName` exists to contain, and it cannot fix this case.)
   *
   * What makes it worth keeping:
   *   - Amounts printed `10.000,00` — European grouping. The old money parser rejected this.
   *   - Dates `04/05/2026` day-first. The old date parser silently read 5 April.
   *   - 0% VAT: a Spanish supplier billing an Italian customer is an intra-EU reverse charge,
   *     so tax is genuinely zero rather than missing.
   *   - No purchase order. "BUDGET: 536478", "REQUEST Nº: 11/26" and the line's "Order
   *     23080608" are all decoys an extractor may be tempted to report as a PO.
   *     **The live run took the bait**, returning the BUDGET number as `poNumber` — at 0.75
   *     confidence, so the gate caught it and the invoice went to review rather than matching
   *     against a purchase order that does not exist. The decoy this comment predicted is
   *     real, and the confidence threshold is what contains it.
   */
  arenamedia: invoice({
    number: '2026001293', vendor: 'Arena Media Comunications España, S.A.',
    po: null, reference: '17294',
    invoiceDate: '2026-05-04', dueDate: '2026-06-03', supplyDate: null,
    vendorTaxId: 'A80537327', currency: 'EUR',
    bank: {
      iban: 'ES4300491804142810288845', accountNumber: null,
      bic: 'BSCHESMM', bankName: 'Banco Santander',
    },
    subtotal: 10000.0, tax: 0.0, total: 10000.0,
    lines: [{ description: 'RETAINER FEE 2026', quantity: 1, unitPrice: 10000, lineTotal: 10000, taxCode: null, taxRate: 0 }],
  }),

  /**
   * REAL DOCUMENT — Ready4people Development, S.L. (Barcelona) billing PUMA ITALIA SRL.
   * Factura 260011, 23/01/2026, due 22/02/2026. Same provenance caveat as above.
   *
   * Its own hazards:
   *   - `23/01/2026` has no valid month 23, so the old date parser threw a 400 outright.
   *   - The tax block prints Spain's three VAT rates (21,00 / 10,00 / 4,00) as a fixed
   *     template with the I.V.A. column left **empty**. The charged rate is 0 — another
   *     reverse charge. An extractor reading 21% off the template would invent €168 of tax
   *     that does not exist, and the arithmetic check would then fail a correct invoice.
   *   - "Referencia/Pedido Cliente" is literally the customer-PO field, and it is blank.
   */
  ready4people: invoice({
    number: '260011', vendor: 'Ready4people Development, S.L.',
    po: null, reference: null,
    invoiceDate: '2026-01-23', dueDate: '2026-02-22', supplyDate: null,
    vendorTaxId: 'B67172452', currency: 'EUR',
    bank: {
      iban: 'ES8501820231250204016939', accountNumber: null,
      bic: 'BBVAESMMXXX', bankName: 'Banco Bilbao Vizcaya Argentaria SA',
    },
    subtotal: 800.0, tax: 0.0, total: 800.0,
    lines: [{
      description: 'Sesiones de Coaching Ejecutivo (Diciembre y Enero)',
      quantity: 2, unitPrice: 400, lineTotal: 800, taxCode: null, taxRate: 0,
    }],
  }),
} satisfies Record<string, ExtractionResult>;

/** The scenarios transcribed from real supplied documents rather than invented. */
export const REAL_DOCUMENT_SCENARIOS = ['arenamedia', 'ready4people'] as const;

export type ScenarioName = keyof typeof SCENARIOS;

/** Deep-clones, so a test mutating a fixture cannot leak into the next test. */
export function scenario(name: ScenarioName): ExtractionResult {
  return structuredClone(SCENARIOS[name]);
}

/**
 * Drop-in for `ExtractionClientService`. Returns whichever scenario is named, ignoring the URL,
 * so the pipeline runs end to end with no extraction service and no network.
 */
export class StubExtractionClient {
  constructor(private next: ExtractionResult) {}

  use(name: ScenarioName) {
    this.next = scenario(name);
    return this;
  }

  /** For cases no canned scenario covers — a duplicate, a corrected field. */
  useResult(result: ExtractionResult) {
    this.next = result;
    return this;
  }

  async extract(): Promise<ExtractionResult> {
    return this.next;
  }
}
