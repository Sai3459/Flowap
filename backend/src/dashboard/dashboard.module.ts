import { Controller, Get, Headers, Module } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  summary(@Headers('x-tenant-id') tenantId: string) {
    return this.dashboard.summary(tenantId);
  }
}

@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
