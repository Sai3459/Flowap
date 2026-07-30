import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

export class PoLineItemDto {
  @IsInt()
  @Min(1)
  lineNumber!: number;

  @IsString()
  @IsNotEmpty()
  description!: string;

  @IsNumber()
  quantity!: number;

  @IsNumber()
  unitPrice!: number;

  @IsNumber()
  lineTotal!: number;

  @IsOptional()
  @IsString()
  unit?: string;
}

/**
 * Shaped as an ERP *sync* payload rather than an authoring form: `poNumber` is the ERP's
 * identifier and the natural key, so re-posting the same PO updates the local copy instead
 * of creating a second one. The ERP stays the system of record (CLAUDE.md design decision 5).
 */
export class CreatePurchaseOrderDto {
  @IsString()
  @IsNotEmpty()
  poNumber!: string;

  /** Resolved/upserted by name, the same way invoice ingestion resolves its vendor. */
  @IsString()
  @IsNotEmpty()
  vendorName!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;

  @IsNumber()
  totalAmount!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PoLineItemDto)
  lineItems!: PoLineItemDto[];

  /** Goods-receipt quantities keyed by PO line number, e.g. { "1": 20 }. */
  @IsOptional()
  @IsObject()
  receivedQty?: Record<string, number>;
}

export class RecordReceiptDto {
  /**
   * Quantities received per PO line number. Absolute totals, not deltas — a goods receipt
   * correction is easier to reason about as "line 1 now stands at 18" than as an increment.
   */
  @IsObject()
  receivedQty!: Record<string, number>;
}
