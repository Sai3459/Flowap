/**
 * The ERP connector contract.
 *
 * Flowap is an overlay: the ERP stays the system of record. So a connector only ever does two
 * kinds of thing — *pull* master data we need in order to reason (suppliers, orders, receipts,
 * cost objects), and *push* one document back at the end. Everything in between is ours.
 *
 * Keeping that surface narrow is what makes "supports any ERP" more than a slogan. A new
 * connector implements this interface; nothing in matching, workflow, coding or posting needs
 * to know which ERP is behind it.
 *
 * The types below are **canonical** — Flowap's shape, not SAP's. Mapping SAP's field names
 * into these lives in `s4hana/s4-mapping.ts`, so a second ERP never inherits SAP's vocabulary.
 */

/** A supplier as the ERP holds it. `externalId` is the ERP's key, not ours. */
export interface ErpSupplier {
  externalId: string;
  name: string;
  taxId: string | null;
  /** ISO country, useful later for tax treatment and e-invoicing routing. */
  country: string | null;
  isBlocked: boolean;
}

export interface ErpPurchaseOrderLine {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  unit: string | null;
  /** Set when the ERP tracks receipts against this line. */
  goodsReceiptRequired: boolean;
}

export interface ErpPurchaseOrder {
  externalId: string;
  poNumber: string;
  supplierExternalId: string;
  currency: string;
  totalAmount: number;
  /** Mandatory on any SAP posting, and the reason multi-entity customers need it modelled. */
  companyCode: string | null;
  lines: ErpPurchaseOrderLine[];
}

/** A goods receipt, which is what makes the third leg of the 3-way match real. */
export interface ErpGoodsReceipt {
  poNumber: string;
  poLineNumber: number;
  quantity: number;
  postingDate: Date | null;
}

export interface ErpCostObject {
  externalId: string;
  code: string;
  name: string;
  companyCode: string | null;
}

/**
 * What we hand back when an invoice is approved and coded.
 *
 * `mode` is the decision worth taking seriously: `PARK` creates the document in the ERP
 * without posting it, so the ERP's own checks run and a human there can complete it. For a
 * first go-live that is much the safer default — a wrongly parked document is a nuisance
 * someone deletes, a wrongly posted one is a journal entry in a live ledger that has to be
 * reversed.
 */
export interface ErpInvoicePosting {
  mode: 'PARK' | 'POST';
  invoiceNumber: string;
  invoiceDate: Date;
  postingDate: Date;
  supplierExternalId: string;
  companyCode: string;
  currency: string;
  grossAmount: number;
  taxAmount: number;
  /** Lines referencing a PO — the ERP derives the account from the order. */
  poLines: { poNumber: string; poLineNumber: number; quantity: number; amount: number }[];
  /** Lines coded directly to a GL account — the non-PO path. */
  glLines: { glAccount: string; costCenter: string | null; amount: number; taxCode: string | null }[];
  /**
   * Ours, echoed back on retry. The ERP will not de-duplicate for us: if a post succeeds and
   * the response is lost, a naive retry creates a second accounting document.
   */
  idempotencyKey: string;
}

export interface ErpPostingResult {
  /** The ERP's document number. */
  documentNumber: string;
  /**
   * Mandatory alongside it for SAP: a document number is only unique within company code
   * *and* fiscal year, so storing the number alone cannot reliably identify the document.
   */
  fiscalYear: string | null;
  status: 'PARKED' | 'POSTED';
}

/**
 * Every method is optional to *implement* but explicit here, so a connector's gaps are
 * visible rather than discovered at runtime. A read-only connector is a legitimate first
 * deliverable — it makes matching real against actual procurement data while being incapable
 * of changing anything in the customer's system.
 */
export interface ErpConnector {
  readonly name: string;

  /** Cheap call proving credentials and connectivity, for the config screen's "Test" button. */
  ping(): Promise<{ ok: boolean; detail: string }>;

  listSuppliers(since?: Date): Promise<ErpSupplier[]>;
  listPurchaseOrders(since?: Date): Promise<ErpPurchaseOrder[]>;
  listGoodsReceipts(poNumbers: string[]): Promise<ErpGoodsReceipt[]>;
  listGlAccounts(): Promise<ErpCostObject[]>;
  listCostCenters(): Promise<ErpCostObject[]>;

  /** Absent on a read-only connector, which is the safe way to start. */
  postInvoice?(posting: ErpInvoicePosting): Promise<ErpPostingResult>;
}
