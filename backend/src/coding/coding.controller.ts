import { Body, Controller, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { CodingService } from './coding.service';
import { CodeLineDto, CreateCostCenterDto, CreateGlAccountDto } from './dto/coding.dto';

@ApiTags('cost-assignment')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller()
export class CodingController {
  constructor(private readonly coding: CodingService) {}

  // ---- master data, synced from the ERP ----

  @Get('gl-accounts')
  listGlAccounts(@Headers('x-tenant-id') tenantId: string) {
    return this.coding.listGlAccounts(tenantId);
  }

  @Post('gl-accounts')
  upsertGlAccount(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateGlAccountDto) {
    return this.coding.upsertGlAccount(tenantId, dto);
  }

  @Get('cost-centers')
  listCostCenters(@Headers('x-tenant-id') tenantId: string) {
    return this.coding.listCostCenters(tenantId);
  }

  @Post('cost-centers')
  upsertCostCenter(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreateCostCenterDto) {
    return this.coding.upsertCostCenter(tenantId, dto);
  }

  // ---- the cost-assignment work itself ----

  /** The coding queue: invoices with at least one line still missing its assignment. */
  @Get('cost-assignment/queue')
  queue(@Headers('x-tenant-id') tenantId: string) {
    return this.coding.findAwaitingCoding(tenantId);
  }

  @Get('invoices/:invoiceId/coding-suggestions')
  suggestions(@Headers('x-tenant-id') tenantId: string, @Param('invoiceId') invoiceId: string) {
    return this.coding.suggestForInvoice(tenantId, invoiceId);
  }

  @Patch('invoices/:invoiceId/lines/:lineId/code')
  codeLine(
    @Headers('x-tenant-id') tenantId: string,
    @Param('invoiceId') invoiceId: string,
    @Param('lineId') lineId: string,
    @Body() dto: CodeLineDto,
  ) {
    return this.coding.codeLine(tenantId, invoiceId, lineId, dto);
  }
}
