/**
 * ERP connection administration. `ADMIN` only — this is config-plane work, and the config
 * itself grants the ability to post accounting documents into a customer's ledger.
 */
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { ErpConnectionsService, type ErpConnectionConfig } from './erp-connections.service';
import type { Principal } from '../auth/principal';

class ConnectionConfigDto implements ErpConnectionConfig {
  @IsUrl({ require_tld: false })
  baseUrl!: string;

  @IsIn(['apiKey', 'basic', 'oauth2'])
  authKind!: 'apiKey' | 'basic' | 'oauth2';

  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() user?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsString() tokenUrl?: string;
  @IsOptional() @IsString() clientId?: string;
  @IsOptional() @IsString() clientSecret?: string;
  @IsOptional() @IsString() companyCode?: string;
}

export class CreateConnectionDto {
  @IsIn(['S4HANA_CLOUD'])
  erpType!: string;

  @IsString()
  name!: string;

  // Both decorators are required. Without @ValidateNested the nested object is not checked;
  // without @Type it is not transformed into the class, and `forbidNonWhitelisted` then
  // rejects the whole property as unrecognised — which is exactly how this failed the first
  // time it was called over HTTP rather than through the service directly.
  @ValidateNested()
  @Type(() => ConnectionConfigDto)
  config!: ConnectionConfigDto;
}

@ApiTags('admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/erp-connections')
export class ErpConnectionsController {
  constructor(private readonly connections: ErpConnectionsService) {}

  @Get()
  list(@CurrentUser() { tenantId }: Principal) {
    return this.connections.list(tenantId);
  }

  @Post()
  create(@CurrentUser() { tenantId }: Principal, @Body() dto: CreateConnectionDto) {
    return this.connections.create(tenantId, dto.erpType, dto.name, dto.config);
  }

  @Patch(':id')
  update(@CurrentUser() { tenantId }: Principal, @Param('id') id: string, @Body() dto: ConnectionConfigDto) {
    return this.connections.update(tenantId, id, dto);
  }

  /** Opens a real connection. Returns ok:false with the reason rather than throwing. */
  @Post(':id/test')
  test(@CurrentUser() { tenantId }: Principal, @Param('id') id: string) {
    return this.connections.testConnection(tenantId, id);
  }

  /** Pull purchase orders now. Manual on purpose — see the service comment. */
  @Post(':id/sync/purchase-orders')
  syncPurchaseOrders(@CurrentUser() { tenantId }: Principal, @Param('id') id: string) {
    return this.connections.syncPurchaseOrders(tenantId, id);
  }
}
