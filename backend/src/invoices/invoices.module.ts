import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { FilesController } from './files.controller';
import { InvoicesService } from './invoices.service';
import { ExtractionClientService } from './extraction-client.service';
import { FileStorageService } from './file-storage.service';
import { WorkflowModule } from '../workflow/workflow.module';
import { VendorsModule } from '../vendors/vendors.module';

@Module({
  imports: [WorkflowModule, VendorsModule],
  controllers: [InvoicesController, FilesController],
  providers: [InvoicesService, ExtractionClientService, FileStorageService],
  exports: [InvoicesService, FileStorageService],
})
export class InvoicesModule {}
