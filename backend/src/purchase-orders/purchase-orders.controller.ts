import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { PurchaseOrdersService } from './purchase-orders.service';
import { CreatePurchaseOrderDto, RecordReceiptDto } from './dto/purchase-order.dto';

@ApiTags('purchase-orders')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  /** Create or re-sync a PO. Idempotent on (tenant, poNumber). */
  @Post()
  upsert(@Headers('x-tenant-id') tenantId: string, @Body() dto: CreatePurchaseOrderDto) {
    return this.purchaseOrders.upsert(tenantId, dto);
  }

  @Get()
  list(@Headers('x-tenant-id') tenantId: string) {
    return this.purchaseOrders.list(tenantId);
  }

  @Get(':poNumber')
  findOne(@Headers('x-tenant-id') tenantId: string, @Param('poNumber') poNumber: string) {
    return this.purchaseOrders.findOne(tenantId, poNumber);
  }

  /** Record goods-receipt quantities — the third leg of the three-way match. */
  @Post(':poNumber/receipts')
  recordReceipt(
    @Headers('x-tenant-id') tenantId: string,
    @Param('poNumber') poNumber: string,
    @Body() dto: RecordReceiptDto,
  ) {
    return this.purchaseOrders.recordReceipt(tenantId, poNumber, dto);
  }
}
