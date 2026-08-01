import { Controller, Get, Headers, Injectable, Module } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { users, vendors } from '../db/schema';

/**
 * Shared vendor resolution. Both invoice ingestion and purchase-order sync need to turn a
 * vendor *name* into a vendor row, and they must agree on how — otherwise an invoice and
 * its PO can end up pointing at two different vendor records for the same company.
 */
@Injectable()
export class VendorsService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Upserts by (tenantId, name) and returns the vendor id. Null for a blank name.
   *
   * Matching is exact-name after trimming. Real vendor resolution needs fuzzy matching plus
   * tax-id and bank-detail verification — "Acme Inc." and "Acme, Inc" become two vendors
   * here, and duplicate detection keys on vendorId so it won't relate their invoices.
   */
  async resolveByName(tenantId: string, vendorName: string | null | undefined): Promise<string | null> {
    const name = vendorName?.trim();
    if (!name) return null;

    // Relies on the unique index on (tenantId, name) so two concurrent ingests of the same
    // vendor can't create duplicate rows.
    await this.db
      .insert(vendors)
      .values({ tenantId, name })
      .onConflictDoNothing({ target: [vendors.tenantId, vendors.name] });

    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.name, name)));

    return vendor?.id ?? null;
  }

  async list(tenantId: string) {
    return this.db.select().from(vendors).where(eq(vendors.tenantId, tenantId));
  }

  /**
   * Tenant users. Backs the workspace's role switcher — which stands in for a login until SSO
   * exists, and disappears the moment it does.
   */
  async listUsers(tenantId: string) {
    return this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.tenantId, tenantId))
      .orderBy(users.role);
  }
}

@ApiTags('directory')
@ApiHeader({ name: 'x-tenant-id', required: true })
@Controller()
export class DirectoryController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Get('vendors')
  vendors(@Headers('x-tenant-id') tenantId: string) {
    return this.vendorsService.list(tenantId);
  }

  @Get('users')
  users(@Headers('x-tenant-id') tenantId: string) {
    return this.vendorsService.listUsers(tenantId);
  }
}
