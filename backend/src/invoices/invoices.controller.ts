import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Headers,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { IngestInvoiceDto, CorrectFieldDto } from './dto/ingest-invoice.dto';
import { invoiceStatusEnum } from '../db/schema';

const INVOICE_STATUSES = invoiceStatusEnum.enumValues;
type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// Tenant is resolved from a header for the prototype. In production this comes from
// the authenticated session (SSO claim), never a client-supplied header.
@ApiTags('invoices')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Post()
  ingest(@Headers('x-tenant-id') tenantId: string, @Body() dto: IngestInvoiceDto) {
    return this.invoicesService.ingest(tenantId, dto);
  }

  // Declared before @Get(':id') so "exceptions" is not swallowed as an id.
  @Get('exceptions')
  exceptionQueue(@Headers('x-tenant-id') tenantId: string) {
    return this.invoicesService.findExceptionQueue(tenantId);
  }

  @Get()
  @ApiQuery({ name: 'status', required: false, enum: INVOICE_STATUSES, isArray: true })
  findAll(
    @Headers('x-tenant-id') tenantId: string,
    @Query('status') status?: string | string[],
  ) {
    const requested = status === undefined ? [] : Array.isArray(status) ? status : [status];
    const statuses = requested.filter((s): s is InvoiceStatus =>
      (INVOICE_STATUSES as readonly string[]).includes(s),
    );

    if (statuses.length !== requested.length) {
      throw new BadRequestException(
        `status must be one of: ${INVOICE_STATUSES.join(', ')}`,
      );
    }

    return this.invoicesService.findAll(tenantId, statuses);
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
}
