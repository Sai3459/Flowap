import { Module } from '@nestjs/common';
import { DirectoryController, VendorsService } from './vendors.service';

@Module({
  controllers: [DirectoryController],
  providers: [VendorsService],
  exports: [VendorsService],
})
export class VendorsModule {}
