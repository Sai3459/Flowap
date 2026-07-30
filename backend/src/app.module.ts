import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './db/database.module';
import { InvoicesModule } from './invoices/invoices.module';
import { WorkflowModule } from './workflow/workflow.module';
import { VendorsModule } from './vendors/vendors.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    WorkflowModule,
    VendorsModule,
    InvoicesModule,
    PurchaseOrdersModule,
  ],
})
export class AppModule {}
