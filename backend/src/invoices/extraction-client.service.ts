import { Injectable, Logger } from '@nestjs/common';

export interface ExtractedField<T = string> {
  value: T | null;
  confidence: number; // 0..1
}

export interface ExtractionResult {
  invoiceNumber: ExtractedField;
  invoiceDate: ExtractedField;
  dueDate: ExtractedField;
  currency: ExtractedField;
  vendorName: ExtractedField;
  subtotal: ExtractedField<number>;
  taxAmount: ExtractedField<number>;
  totalAmount: ExtractedField<number>;
  lineItems: {
    description: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
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

  /** Returns names of fields that fell below the confidence threshold. */
  static fieldsNeedingReview(result: ExtractionResult): string[] {
    const flat: [string, number][] = [
      ['invoiceNumber', result.invoiceNumber.confidence],
      ['invoiceDate', result.invoiceDate.confidence],
      ['currency', result.currency.confidence],
      ['vendorName', result.vendorName.confidence],
      ['subtotal', result.subtotal.confidence],
      ['taxAmount', result.taxAmount.confidence],
      ['totalAmount', result.totalAmount.confidence],
    ];
    const low = flat.filter(([, c]) => c < CONFIDENCE_REVIEW_THRESHOLD).map(([n]) => n);
    result.lineItems.forEach((li, i) => {
      if (li.confidence < CONFIDENCE_REVIEW_THRESHOLD) low.push(`lineItems[${i}]`);
    });
    return low;
  }
}
