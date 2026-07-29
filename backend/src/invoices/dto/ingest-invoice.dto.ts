import { IsIn, IsOptional, IsString, IsUrl } from 'class-validator';

const SOURCE_CHANNELS = ['EMAIL', 'PORTAL', 'API', 'MANUAL_UPLOAD', 'MOBILE', 'DRAG_DROP'] as const;

export class IngestInvoiceDto {
  @IsUrl({ require_tld: false })
  fileUrl!: string;

  @IsIn(SOURCE_CHANNELS)
  sourceChannel!: (typeof SOURCE_CHANNELS)[number];

  @IsOptional()
  @IsString()
  vendorHint?: string;
}

export class CorrectFieldDto {
  @IsString()
  fieldName!: string;

  @IsString()
  correctedValue!: string;
}
