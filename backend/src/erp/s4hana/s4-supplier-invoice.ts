/**
 * Maps a Flowap posting onto the S/4HANA Supplier Invoice payload.
 *
 * Built against the real `API_SUPPLIERINVOICE_PROCESS_SRV` v1.5.0 specification, not from
 * recollection — field names, types and **length limits** below all come from it.
 *
 * Two things the specification settled that were previously assumptions:
 *
 * 1. **Creating and posting are separate calls, natively.** `POST /A_SupplierInvoice` does not
 *    accept `SupplierInvoice` or `FiscalYear` — SAP assigns them — and there is a distinct
 *    `POST /Post?SupplierInvoice=…&FiscalYear=…` action. So a created invoice is *parked*
 *    until posted. The safer go-live route (create, let SAP's checks run, post separately) is not
 *    a workaround; it is how the API is designed.
 *
 * 2. **FiscalYear is mandatory to post.** It is a required query parameter on the Post action,
 *    so an invoice created and not immediately posted is unpostable unless we store the fiscal
 *    year alongside the document number. `invoices.erpDocumentNumber` alone is insufficient.
 *
 * Field lengths are enforced rather than truncated. Silently trimming an invoice number to 16
 * characters would produce a document that reconciles against nothing.
 */
import type { ErpInvoicePosting } from '../erp-connector.types';
import { formatODataDate } from './s4-odata';

/** From the specification's `maxLength` on each create schema. */
export const S4_FIELD_LIMITS = {
  CompanyCode: 4,
  DocumentCurrency: 5,
  InvoicingParty: 10,
  SupplierInvoiceIDByInvcgParty: 16,
  PaymentTerms: 4,
  SupplierPostingLineItemText: 50,
  PurchaseOrder: 10,
  PurchaseOrderItem: 5,
  TaxCode: 2,
  GLAccount: 10,
  CostCenter: 10,
  SupplierInvoiceItemPurOrdRef: 6,
  SupplierInvoiceItemGLAcct: 4,
} as const;

export interface S4SupplierInvoicePayload {
  CompanyCode: string;
  DocumentDate: string;
  PostingDate: string;
  DocumentCurrency: string;
  InvoiceGrossAmount: string;
  InvoicingParty?: string;
  SupplierInvoiceIDByInvcgParty?: string;
  PaymentTerms?: string;
  DueCalculationBaseDate?: string;
  SupplierPostingLineItemText?: string;
  to_SuplrInvcItemPurOrdRef?: { results: S4PoRefItem[] };
  to_SupplierInvoiceItemGLAcct?: { results: S4GlItem[] };
  to_SupplierInvoiceTax?: { results: S4TaxItem[] };
}

interface S4PoRefItem {
  SupplierInvoiceItem: string;
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  TaxCode: string;
  SupplierInvoiceItemAmount: string;
  QuantityInPurchaseOrderUnit?: string;
  DocumentCurrency?: string;
}

interface S4GlItem {
  SupplierInvoiceItem: string;
  GLAccount: string;
  SupplierInvoiceItemAmount: string;
  /** 'S' debit, 'H' credit. Required by the specification. */
  DebitCreditCode: 'S' | 'H';
  TaxCode?: string;
  CostCenter?: string;
  CompanyCode?: string;
  DocumentCurrency?: string;
}

interface S4TaxItem {
  TaxCode: string;
  TaxAmount: string;
}

export class S4MappingError extends Error {}

/** Rejects rather than truncates: a trimmed key reconciles against nothing. */
function fit(value: string, field: keyof typeof S4_FIELD_LIMITS, label = field): string {
  const limit = S4_FIELD_LIMITS[field];
  if (value.length > limit) {
    throw new S4MappingError(
      `${label} "${value}" is ${value.length} characters; S/4HANA allows ${limit}. ` +
        'Map or shorten it in the connector configuration rather than letting it be truncated.',
    );
  }
  return value;
}

/** SAP wants a plain decimal string. Never a float, never a locale-formatted number. */
function amount(value: number, label: string): string {
  if (!Number.isFinite(value)) throw new S4MappingError(`${label} is not a finite amount`);
  return value.toFixed(2);
}

/** SAP item numbers are zero-padded strings, not integers. */
const itemNo = (index: number, width: number) => String(index + 1).padStart(width, '0');

/**
 * Builds the create payload. This **parks** the invoice — posting is a second call, because
 * that is what the API does.
 */
export function buildSupplierInvoicePayload(posting: ErpInvoicePosting): S4SupplierInvoicePayload {
  if (posting.poLines.length === 0 && posting.glLines.length === 0) {
    throw new S4MappingError('A supplier invoice needs at least one PO-reference or G/L line');
  }

  const payload: S4SupplierInvoicePayload = {
    CompanyCode: fit(posting.companyCode, 'CompanyCode'),
    DocumentDate: formatODataDate(posting.invoiceDate),
    PostingDate: formatODataDate(posting.postingDate),
    DocumentCurrency: fit(posting.currency, 'DocumentCurrency'),
    InvoiceGrossAmount: amount(posting.grossAmount, 'InvoiceGrossAmount'),
    InvoicingParty: fit(posting.supplierExternalId, 'InvoicingParty'),
    // The supplier's own invoice number. SAP uses it for its duplicate check, so getting it
    // in is what stops the same document being paid twice on their side as well as ours.
    SupplierInvoiceIDByInvcgParty: fit(posting.invoiceNumber, 'SupplierInvoiceIDByInvcgParty'),
  };

  if (posting.poLines.length > 0) {
    payload.to_SuplrInvcItemPurOrdRef = {
      results: posting.poLines.map((line, i) => ({
        SupplierInvoiceItem: itemNo(i, S4_FIELD_LIMITS.SupplierInvoiceItemPurOrdRef),
        PurchaseOrder: fit(line.poNumber, 'PurchaseOrder'),
        // SAP PO items are 5-character zero-padded: line 10 is "00010".
        PurchaseOrderItem: fit(String(line.poLineNumber).padStart(5, '0'), 'PurchaseOrderItem'),
        // Required by the specification, and only two characters — our extracted tax code is
        // whatever the supplier printed, so this always needs mapping, never passing through.
        TaxCode: fit(taxCodeFor(posting, line.poNumber), 'TaxCode'),
        SupplierInvoiceItemAmount: amount(line.amount, 'SupplierInvoiceItemAmount'),
        QuantityInPurchaseOrderUnit: amount(line.quantity, 'QuantityInPurchaseOrderUnit'),
        DocumentCurrency: posting.currency,
      })),
    };
  }

  if (posting.glLines.length > 0) {
    payload.to_SupplierInvoiceItemGLAcct = {
      results: posting.glLines.map((line, i) => ({
        SupplierInvoiceItem: itemNo(i, S4_FIELD_LIMITS.SupplierInvoiceItemGLAcct),
        GLAccount: fit(line.glAccount, 'GLAccount'),
        SupplierInvoiceItemAmount: amount(line.amount, 'SupplierInvoiceItemAmount'),
        // An incoming supplier invoice debits the expense. A credit note would be 'H', which
        // is where credit-note handling will attach once we model it.
        DebitCreditCode: line.amount >= 0 ? 'S' : 'H',
        ...(line.taxCode ? { TaxCode: fit(line.taxCode, 'TaxCode') } : {}),
        ...(line.costCenter ? { CostCenter: fit(line.costCenter, 'CostCenter') } : {}),
        CompanyCode: posting.companyCode,
        DocumentCurrency: posting.currency,
      })),
    };
  }

  // Zero tax is a real value on an intra-EU reverse charge — both real invoices we hold are
  // exactly that — so the tax block is sent whenever a tax code is known, not only when the
  // amount is non-zero.
  const headerTaxCode = posting.glLines.find((l) => l.taxCode)?.taxCode;
  if (headerTaxCode) {
    payload.to_SupplierInvoiceTax = {
      results: [{ TaxCode: fit(headerTaxCode, 'TaxCode'), TaxAmount: amount(posting.taxAmount, 'TaxAmount') }],
    };
  }

  return payload;
}

/**
 * Tax code for a PO line. Placeholder until the config plane carries a per-tenant map from
 * the rate printed on the document to the customer's SAP tax code — which cannot be derived,
 * because two customers on the same rate may use different codes.
 */
function taxCodeFor(posting: ErpInvoicePosting, _poNumber: string): string {
  const fromLines = posting.glLines.find((l) => l.taxCode)?.taxCode;
  if (fromLines) return fromLines;
  throw new S4MappingError(
    'No SAP tax code available for a purchase-order line. S/4HANA requires one on every ' +
      'PO-reference item; configure the tax-code mapping for this tenant.',
  );
}

/** The Post action's query parameters — both mandatory, hence storing the fiscal year. */
export function postActionQuery(documentNumber: string, fiscalYear: string) {
  if (!documentNumber || !fiscalYear) {
    throw new S4MappingError(
      'Posting requires both SupplierInvoice and FiscalYear. A document number alone cannot ' +
        'identify an SAP document — it is only unique within company code and fiscal year.',
    );
  }
  return { SupplierInvoice: documentNumber, FiscalYear: fiscalYear };
}
