import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PostingService } from './posting.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';

@ApiTags('posting')
@ApiBearerAuth()
@Controller()
export class PostingController {
  constructor(private readonly posting: PostingService) {}

  /** Approved invoices with nothing left but posting. */
  @Get('posting/ready')
  ready(@CurrentUser() { tenantId }: Principal) {
    return this.posting.findReadyToPost(tenantId);
  }

  @Get('posting/posted')
  posted(@CurrentUser() { tenantId }: Principal) {
    return this.posting.findPosted(tenantId);
  }

  /**
   * Posting records who did it, and that is now the session rather than a body field.
   * `postedById` is the audit trail for an irreversible action — the ERP holds the accounting
   * document afterwards — so a caller naming someone else as the poster was the last place a
   * client could write a false actor into the record.
   */
  @Post('invoices/:id/post')
  post(@CurrentUser() { tenantId, userId }: Principal, @Param('id') id: string) {
    return this.posting.post(tenantId, id, userId);
  }
}
