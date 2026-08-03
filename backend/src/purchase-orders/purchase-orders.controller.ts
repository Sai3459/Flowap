import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PurchaseOrdersService } from './purchase-orders.service';
import { CreatePurchaseOrderDto, RecordReceiptDto } from './dto/purchase-order.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';

@ApiTags('purchase-orders')
@ApiBearerAuth()
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  /** Create or re-sync a PO. Idempotent on (tenant, poNumber). */
  @Post()
  upsert(@CurrentUser() { tenantId }: Principal, @Body() dto: CreatePurchaseOrderDto) {
    return this.purchaseOrders.upsert(tenantId, dto);
  }

  @Get()
  list(@CurrentUser() { tenantId }: Principal) {
    return this.purchaseOrders.list(tenantId);
  }

  @Get(':poNumber')
  findOne(@CurrentUser() { tenantId }: Principal, @Param('poNumber') poNumber: string) {
    return this.purchaseOrders.findOne(tenantId, poNumber);
  }

  /** Record goods-receipt quantities — the third leg of the three-way match. */
  @Post(':poNumber/receipts')
  recordReceipt(
    @CurrentUser() { tenantId }: Principal,
    @Param('poNumber') poNumber: string,
    @Body() dto: RecordReceiptDto,
  ) {
    return this.purchaseOrders.recordReceipt(tenantId, poNumber, dto);
  }
}
