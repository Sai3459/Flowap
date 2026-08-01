import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { PostingService } from './posting.service';

export class PostInvoiceDto {
  /** Who posted it. Client-supplied until SSO lands, same caveat as approver ids. */
  @IsOptional()
  @IsUUID()
  postedById?: string;
}

@ApiTags('posting')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller()
export class PostingController {
  constructor(private readonly posting: PostingService) {}

  /** Approved invoices with nothing left but posting. */
  @Get('posting/ready')
  ready(@Headers('x-tenant-id') tenantId: string) {
    return this.posting.findReadyToPost(tenantId);
  }

  @Get('posting/posted')
  posted(@Headers('x-tenant-id') tenantId: string) {
    return this.posting.findPosted(tenantId);
  }

  @Post('invoices/:id/post')
  post(
    @Headers('x-tenant-id') tenantId: string,
    @Param('id') id: string,
    @Body() dto: PostInvoiceDto,
  ) {
    return this.posting.post(tenantId, id, dto.postedById);
  }
}
