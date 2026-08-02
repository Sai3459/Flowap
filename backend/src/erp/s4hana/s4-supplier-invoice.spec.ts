/**
 * Supplier Invoice mapping, against the real API_SUPPLIERINVOICE_PROCESS_SRV v1.5.0 spec.
 *
 * The two real invoices drive these: Ready4people (non-PO, GL-coded) and a PO-referenced
 * case. Both are intra-EU reverse charge, so zero tax is a correct value rather than a
 * missing one — which is exactly the case a naive mapper drops.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { ErpInvoicePosting } from '../erp-connector.types';
import {
  S4MappingError,
  buildSupplierInvoicePayload,
  postActionQuery,
} from './s4-supplier-invoice';

const base = (over: Partial<ErpInvoicePosting> = {}): ErpInvoicePosting => ({
  mode: 'PARK',
  invoiceNumber: '260011',
  invoiceDate: new Date('2026-01-23T00:00:00Z'),
  postingDate: new Date('2026-01-23T00:00:00Z'),
  supplierExternalId: '0017100001',
  companyCode: '1710',
  currency: 'EUR',
  grossAmount: 800,
  taxAmount: 0,
  poLines: [],
  glLines: [{ glAccount: '0000600100', costCenter: '0000001000', amount: 800, taxCode: 'V0' }],
  idempotencyKey: 'flowap-260011',
  ...over,
});

describe('supplier invoice payload — header', () => {
  it('maps the Ready4people invoice onto the create payload', () => {
    const p = buildSupplierInvoicePayload(base());

    assert.equal(p.CompanyCode, '1710');
    assert.equal(p.DocumentCurrency, 'EUR');
    assert.equal(p.InvoicingParty, '0017100001');
    assert.equal(p.SupplierInvoiceIDByInvcgParty, '260011');
    // Decimal as a string, always — SAP declares these as Edm.Decimal for a reason and a
    // float would reintroduce exactly the error it avoids.
    assert.equal(p.InvoiceGrossAmount, '800.00');
    assert.equal(typeof p.InvoiceGrossAmount, 'string');
  });

  it('formats dates the way the service expects', () => {
    const p = buildSupplierInvoicePayload(base());
    assert.equal(p.DocumentDate, '2026-01-23T00:00:00');
    assert.equal(p.PostingDate, '2026-01-23T00:00:00');
  });

  it('does not send SupplierInvoice or FiscalYear — SAP assigns them', () => {
    // They are absent from the create schema. Sending them is not how you get a document
    // number; posting is a separate call afterwards.
    const p = buildSupplierInvoicePayload(base()) as unknown as Record<string, unknown>;
    assert.equal(p.SupplierInvoice, undefined);
    assert.equal(p.FiscalYear, undefined);
  });
});

describe('supplier invoice payload — G/L lines (the non-PO path)', () => {
  it('builds a G/L item with the mandatory debit indicator', () => {
    const [item] = buildSupplierInvoicePayload(base()).to_SupplierInvoiceItemGLAcct!.results;

    assert.equal(item.GLAccount, '0000600100');
    assert.equal(item.CostCenter, '0000001000');
    assert.equal(item.SupplierInvoiceItemAmount, '800.00');
    assert.equal(item.DebitCreditCode, 'S', 'an incoming invoice debits the expense');
    assert.equal(item.SupplierInvoiceItem, '0001', 'item numbers are zero-padded strings');
  });

  it('flips to a credit indicator for a negative amount', () => {
    // Where credit-note handling attaches once documentType is acted on.
    const p = buildSupplierInvoicePayload(
      base({ grossAmount: -800, glLines: [{ glAccount: '0000600100', costCenter: null, amount: -800, taxCode: 'V0' }] }),
    );
    assert.equal(p.to_SupplierInvoiceItemGLAcct!.results[0].DebitCreditCode, 'H');
  });

  it('sends a zero-tax block rather than omitting it', () => {
    // Both real invoices are intra-EU reverse charge: 0.00 tax is the correct value, not a
    // missing one. Omitting the block would leave SAP to derive tax itself.
    const p = buildSupplierInvoicePayload(base());
    assert.deepEqual(p.to_SupplierInvoiceTax!.results, [{ TaxCode: 'V0', TaxAmount: '0.00' }]);
  });
});

describe('supplier invoice payload — PO-reference lines', () => {
  const withPo = base({
    invoiceNumber: 'INV-1001',
    grossAmount: 1296,
    taxAmount: 96,
    poLines: [{ poNumber: '4500000123', poLineNumber: 10, quantity: 20, amount: 1200 }],
    glLines: [{ glAccount: '0000600100', costCenter: null, amount: 0, taxCode: 'V1' }],
  });

  it('zero-pads the purchase order item, as SAP numbers them', () => {
    const [item] = buildSupplierInvoicePayload(withPo).to_SuplrInvcItemPurOrdRef!.results;
    assert.equal(item.PurchaseOrder, '4500000123');
    assert.equal(item.PurchaseOrderItem, '00010', 'line 10 is "00010", not "10"');
    assert.equal(item.SupplierInvoiceItemAmount, '1200.00');
    assert.equal(item.QuantityInPurchaseOrderUnit, '20.00');
  });

  it('requires a tax code on every PO line, because the specification does', () => {
    const noTax = base({
      poLines: [{ poNumber: '4500000123', poLineNumber: 10, quantity: 1, amount: 100 }],
      glLines: [],
    });
    assert.throws(() => buildSupplierInvoicePayload(noTax), /tax code/i);
  });
});

describe('field length limits — reject, never truncate', () => {
  it('refuses an invoice number longer than SAP allows', () => {
    // SupplierInvoiceIDByInvcgParty is 16 characters. Truncating would produce a document
    // that reconciles against nothing and defeats SAP's own duplicate check.
    const long = base({ invoiceNumber: 'INV-2026-0000000123456789' });
    assert.throws(() => buildSupplierInvoicePayload(long), (err: Error) => {
      assert.ok(err instanceof S4MappingError);
      assert.match(err.message, /16/);
      return true;
    });
  });

  it('refuses an over-long company code, GL account and cost centre', () => {
    assert.throws(() => buildSupplierInvoicePayload(base({ companyCode: '17100' })), /CompanyCode/);
    assert.throws(
      () => buildSupplierInvoicePayload(base({ glLines: [{ glAccount: '00006001001', costCenter: null, amount: 800, taxCode: 'V0' }] })),
      /GLAccount/,
    );
  });

  it('refuses a tax code longer than two characters', () => {
    // Our extracted taxCode is whatever the supplier printed — "21%" or "IVA21" — so it
    // always needs mapping to the customer's SAP code, never passing through.
    assert.throws(
      () => buildSupplierInvoicePayload(base({ glLines: [{ glAccount: '0000600100', costCenter: null, amount: 800, taxCode: 'IVA21' }] })),
      /TaxCode/,
    );
  });

  it('refuses an invoice with no lines at all', () => {
    assert.throws(() => buildSupplierInvoicePayload(base({ glLines: [], poLines: [] })), /at least one/);
  });
});

describe('the Post action', () => {
  it('requires both the document number and the fiscal year', () => {
    assert.deepEqual(postActionQuery('5105600000', '2026'), {
      SupplierInvoice: '5105600000',
      FiscalYear: '2026',
    });
  });

  it('refuses to post without a fiscal year', () => {
    // Both are mandatory query parameters on POST /Post. An invoice created today and posted
    // tomorrow is unpostable unless we stored the fiscal year — which is why
    // invoices.erpDocumentNumber alone is not enough.
    assert.throws(() => postActionQuery('5105600000', ''), /FiscalYear/);
    assert.throws(() => postActionQuery('', '2026'), /SupplierInvoice/);
  });
});
