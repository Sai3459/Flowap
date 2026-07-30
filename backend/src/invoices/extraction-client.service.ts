import { Injectable, Logger } from '@nestjs/common';

export interface ExtractedField<T = string> {
  value: T | null;
  confidence: number; // 0..1
}

export interface ExtractedBankDetails {
  iban: string | null;
  accountNumber: string | null;
  bic: string | null;
  bankName: string | null;
}

export interface ExtractionResult {
  invoiceNumber: ExtractedField;
  /** As printed on the invoice; may not resolve to a real PO. */
  poNumber: ExtractedField;
  referenceNumber: ExtractedField;
  invoiceDate: ExtractedField;
  dueDate: ExtractedField;
  /** Delivery/service date — often differs from invoiceDate and drives tax treatment. */
  supplyDate: ExtractedField;
  currency: ExtractedField;
  vendorName: ExtractedField;
  vendorTaxId: ExtractedField;
  /** Remittance details claimed on the document, for comparison against vendor master. */
  bankDetails: ExtractedField<ExtractedBankDetails>;
  subtotal: ExtractedField<number>;
  taxAmount: ExtractedField<number>;
  totalAmount: ExtractedField<number>;
  lineItems: {
    description: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
    taxCode: string | null;
    taxRate: number | null;
    confidence: number;
  }[];
  documentType: ExtractedField; // e.g. INVOICE | CREDIT_NOTE | RECEIPT
}

// Fields at or above this confidence never need a human to look at them.
// This threshold is intentionally per-field, not per-document — a 98%-confident
// header with one shaky line item should only surface that one line item.
export const CONFIDENCE_REVIEW_THRESHOLD = 0.9;

@Injectable()
export class ExtractionClientService {
  private readonly logger = new Logger(ExtractionClientService.name);
  private readonly extractionServiceUrl =
    process.env.EXTRACTION_SERVICE_URL || 'http://localhost:8001';

  async extract(fileUrl: string): Promise<ExtractionResult> {
    const res = await fetch(`${this.extractionServiceUrl}/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_url: fileUrl }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Extraction service error ${res.status}: ${body}`);
      throw new Error(`Extraction failed with status ${res.status}`);
    }

    return (await res.json()) as ExtractionResult;
  }

  /**
   * Returns names of fields that fell below the confidence threshold.
   *
   * Required vs optional matters here. The extractor reports confidence 0.0 for a field
   * that is genuinely absent from the document, so treating every field as required would
   * push every non-PO invoice into review for lacking a PO number. An optional field is
   * only flagged when it *has* a value the extractor was unsure about; a missing required
   * field is always worth a human.
   */
  static fieldsNeedingReview(result: ExtractionResult): string[] {
    const required: [string, ExtractedField<unknown>][] = [
      ['invoiceNumber', result.invoiceNumber],
      ['invoiceDate', result.invoiceDate],
      ['currency', result.currency],
      ['vendorName', result.vendorName],
      ['subtotal', result.subtotal],
      ['taxAmount', result.taxAmount],
      ['totalAmount', result.totalAmount],
    ];
    const optional: [string, ExtractedField<unknown>][] = [
      ['poNumber', result.poNumber],
      ['referenceNumber', result.referenceNumber],
      ['dueDate', result.dueDate],
      ['supplyDate', result.supplyDate],
      ['vendorTaxId', result.vendorTaxId],
      ['bankDetails', result.bankDetails],
    ];

    const low = required
      .filter(([, f]) => f.confidence < CONFIDENCE_REVIEW_THRESHOLD)
      .map(([name]) => name);

    for (const [name, field] of optional) {
      if (field?.value !== null && field?.value !== undefined && field.confidence < CONFIDENCE_REVIEW_THRESHOLD) {
        low.push(name);
      }
    }

    result.lineItems.forEach((li, i) => {
      if (li.confidence < CONFIDENCE_REVIEW_THRESHOLD) low.push(`lineItems[${i}]`);
    });
    return low;
  }
}
