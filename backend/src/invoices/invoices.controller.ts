import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Headers,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiTags, ApiHeader } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { FileStorageService } from './file-storage.service';
import { IngestInvoiceDto, CorrectFieldDto } from './dto/ingest-invoice.dto';

// Tenant is resolved from a header for the prototype. In production this comes from
// the authenticated session (SSO claim), never a client-supplied header.
@ApiTags('invoices')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly fileStorage: FileStorageService,
  ) {}

  @Post()
  ingest(@Headers('x-tenant-id') tenantId: string, @Body() dto: IngestInvoiceDto) {
    return this.invoicesService.ingest(tenantId, dto);
  }

  /**
   * Upload a document straight from the UI. The file is stored and then handed to the same
   * pipeline as any other invoice, by URL — so an upload and a connector push take an
   * identical path, and there is no second code path to keep in step.
   */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(
    @Headers('x-tenant-id') tenantId: string,
    @UploadedFile() file: { originalname: string; mimetype: string; buffer: Buffer } | undefined,
    @Body('sourceChannel') sourceChannel?: string,
  ) {
    if (!file) throw new BadRequestException('No file uploaded — send it as multipart field "file".');

    const accepted = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
    if (!accepted.includes(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type ${file.mimetype}. Upload a PDF or an image (PNG, JPEG, WebP).`,
      );
    }

    const stored = await this.fileStorage.save(file);
    return this.invoicesService.ingest(
      tenantId,
      { fileUrl: stored.url, sourceChannel: (sourceChannel as never) ?? 'MANUAL_UPLOAD' },
      stored,
    );
  }

  @Get()
  list(@Headers('x-tenant-id') tenantId: string) {
    return this.invoicesService.findAll(tenantId);
  }

  @Get('exceptions')
  exceptionQueue(@Headers('x-tenant-id') tenantId: string) {
    return this.invoicesService.findExceptionQueue(tenantId);
  }

  @Get(':id')
  findOne(@Headers('x-tenant-id') tenantId: string, @Param('id') id: string) {
    return this.invoicesService.findOne(tenantId, id);
  }

  @Patch(':id/correct-field')
  correctField(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') id: string,
    @Body() dto: CorrectFieldDto,
  ) {
    return this.invoicesService.correctField(tenantId, id, dto);
  }

  /**
   * Explicitly re-run duplicate detection and PO matching. Corrections to validation-relevant
   * fields already trigger this automatically; this endpoint is for the cases they don't cover
   * — notably releasing an invoice held by a low-confidence line item, which is why it forces
   * past the confidence gate.
   */
  @Post(':id/revalidate')
  revalidate(@Headers('x-tenant-id') tenantId: string, @Param('id') id: string) {
    return this.invoicesService.revalidate(tenantId, id, { force: true });
  }
}
