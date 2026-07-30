import { Module } from '@nestjs/common';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { VendorsModule } from '../vendors/vendors.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  // InvoicesModule for revalidate(): a PO arriving late needs to unblock invoices that
  // already failed to match against it.
  imports: [VendorsModule, InvoicesModule],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
