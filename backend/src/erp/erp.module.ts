import { Module } from '@nestjs/common';
import { DatabaseModule } from '../db/database.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { ErpConnectionsService } from './erp-connections.service';
import { ErpConnectionsController } from './erp.controller';

/** The integration plane's first module: real credentials, a real socket. */
@Module({
  imports: [DatabaseModule, PurchaseOrdersModule],
  controllers: [ErpConnectionsController],
  providers: [ErpConnectionsService],
  exports: [ErpConnectionsService],
})
export class ErpModule {}
