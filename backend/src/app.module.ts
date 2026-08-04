import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './db/database.module';
import { ErpModule } from './erp/erp.module';
import { InvoicesModule } from './invoices/invoices.module';
import { WorkflowModule } from './workflow/workflow.module';
import { VendorsModule } from './vendors/vendors.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { CodingModule } from './coding/coding.module';
import { PostingModule } from './posting/posting.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MetricsModule } from './metrics/metrics.controller';
import { InboundModule } from './inbound/inbound.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule.forRoot(),
    AdminModule,
    ErpModule,
    WorkflowModule,
    VendorsModule,
    InvoicesModule,
    PurchaseOrdersModule,
    CodingModule,
    PostingModule,
    DashboardModule,
    MetricsModule,
    InboundModule,
  ],
})
export class AppModule {}
