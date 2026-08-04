import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { FileStorageService } from './file-storage.service';
import { IngestInvoiceDto, CorrectFieldDto } from './dto/ingest-invoice.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { Roles } from '../auth/roles.decorator';
import { humanActor } from '../metrics/touchless';

// Tenant is resolved from a header for the prototype. In production this comes from
// the authenticated session (SSO claim), never a client-supplied header.
@ApiTags('invoices')
@ApiBearerAuth()
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly fileStorage: FileStorageService,
  ) {}

  @Roles('AP_CLERK', 'AP_MANAGER')
  @Post()
  ingest(@CurrentUser() { tenantId }: Principal, @Body() dto: IngestInvoiceDto) {
    return this.invoicesService.ingest(tenantId, dto);
  }

  /**
   * Upload a document straight from the UI. The file is stored and then handed to the same
   * pipeline as any other invoice, by URL — so an upload and a connector push take an
   * identical path, and there is no second code path to keep in step.
   */
  @Roles('AP_CLERK', 'AP_MANAGER')
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(
    @CurrentUser() { tenantId }: Principal,
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

  @Roles('AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN')
  @Get()
  list(@CurrentUser() { tenantId }: Principal) {
    return this.invoicesService.findAll(tenantId);
  }

  @Roles('AP_CLERK', 'AP_MANAGER', 'CONTROLLER', 'ADMIN')
  @Get('exceptions')
  exceptionQueue(@CurrentUser() { tenantId }: Principal) {
    return this.invoicesService.findExceptionQueue(tenantId);
  }

  // APPROVER is included here and *only* here among the invoice reads: someone asked to
  // approve a payment has to be able to see what they are approving. They still cannot list
  // the tenant's invoices — and `findOne` restricts an APPROVER to invoices they hold or held
  // a step on, which is a record-level rule the guard cannot express.
  @Roles('AP_CLERK', 'APPROVER', 'AP_MANAGER', 'CONTROLLER', 'ADMIN')
  @Get(':id')
  findOne(@CurrentUser() user: Principal, @Param('id') id: string) {
    return this.invoicesService.findOne(user.tenantId, id, user);
  }

  @Roles('AP_CLERK', 'AP_MANAGER', 'CONTROLLER')
  @Patch(':id/correct-field')
  correctField(
    @CurrentUser() user: Principal,
    @Param('id') id: string,
    @Body() dto: CorrectFieldDto,
  ) {
    return this.invoicesService.correctField(user.tenantId, id, dto, user);
  }

  /**
   * Explicitly re-run duplicate detection and PO matching. Corrections to validation-relevant
   * fields already trigger this automatically; this endpoint is for the cases they don't cover
   * — notably releasing an invoice held by a low-confidence line item, which is why it forces
   * past the confidence gate.
   */
  @Roles('AP_MANAGER', 'CONTROLLER')
  @Post(':id/revalidate')
  revalidate(@CurrentUser() { tenantId, userId }: Principal, @Param('id') id: string) {
    // Explicit human request: an invoice that needed a person to push it is not touchless.
    return this.invoicesService.revalidate(tenantId, id, { force: true, actor: humanActor(userId) });
  }
}
