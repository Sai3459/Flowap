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
} satisfies Record<string, ExtractionResult>;

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
