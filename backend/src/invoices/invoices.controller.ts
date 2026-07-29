import { Body, Controller, Get, Param, Patch, Post, Headers } from '@nestjs/common';
import { ApiTags, ApiHeader } from '@nestjs/swagger';
import { InvoicesService } from './invoices.service';
import { IngestInvoiceDto, CorrectFieldDto } from './dto/ingest-invoice.dto';

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
}
