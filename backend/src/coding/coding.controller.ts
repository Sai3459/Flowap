import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CodingService } from './coding.service';
import { CodeLineDto, CreateCostCenterDto, CreateGlAccountDto } from './dto/coding.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';
import { Roles } from '../auth/roles.decorator';

@ApiTags('cost-assignment')
@ApiBearerAuth()
@Controller()
export class CodingController {
  constructor(private readonly coding: CodingService) {}

  // ---- master data, synced from the ERP ----

  @Get('gl-accounts')
  listGlAccounts(@CurrentUser() { tenantId }: Principal) {
    return this.coding.listGlAccounts(tenantId);
  }

  @Roles('ADMIN')
  @Post('gl-accounts')
  upsertGlAccount(@CurrentUser() { tenantId }: Principal, @Body() dto: CreateGlAccountDto) {
    return this.coding.upsertGlAccount(tenantId, dto);
  }

  @Get('cost-centers')
  listCostCenters(@CurrentUser() { tenantId }: Principal) {
    return this.coding.listCostCenters(tenantId);
  }

  @Roles('ADMIN')
  @Post('cost-centers')
  upsertCostCenter(@CurrentUser() { tenantId }: Principal, @Body() dto: CreateCostCenterDto) {
    return this.coding.upsertCostCenter(tenantId, dto);
  }

  // ---- the cost-assignment work itself ----

  /** The coding queue: invoices with at least one line still missing its assignment. */
  @Roles('AP_CLERK', 'AP_MANAGER', 'CONTROLLER')
  @Get('cost-assignment/queue')
  queue(@CurrentUser() { tenantId }: Principal) {
    return this.coding.findAwaitingCoding(tenantId);
  }

  @Roles('AP_CLERK', 'AP_MANAGER', 'CONTROLLER')
  @Get('invoices/:invoiceId/coding-suggestions')
  suggestions(@CurrentUser() { tenantId }: Principal, @Param('invoiceId') invoiceId: string) {
    return this.coding.suggestForInvoice(tenantId, invoiceId);
  }

  @Roles('AP_CLERK', 'AP_MANAGER', 'CONTROLLER')
  @Patch('invoices/:invoiceId/lines/:lineId/code')
  codeLine(
    @CurrentUser() { tenantId, userId }: Principal,
    @Param('invoiceId') invoiceId: string,
    @Param('lineId') lineId: string,
    @Body() dto: CodeLineDto,
  ) {
    return this.coding.codeLine(tenantId, invoiceId, lineId, dto, userId);
  }
}
