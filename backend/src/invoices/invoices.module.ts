import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { ExtractionClientService } from './extraction-client.service';
import { WorkflowModule } from '../workflow/workflow.module';

@Module({
  imports: [WorkflowModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, ExtractionClientService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
