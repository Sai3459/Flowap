import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { users, vendors } from '../db/schema';
import { normaliseVendorName } from './vendor-name';
import { CurrentUser } from '../auth/current-user.decorator';
import type { Principal } from '../auth/principal';

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
   * Upserts by the *normalised* name and returns the vendor id. Null for a blank or
   * unnameable vendor.
   *
   * Matching used to be exact-name-after-trim, which fragmented a supplier across spellings —
   * and because duplicate detection gates on `vendorId`, a fragmented vendor silently
   * disabled it and let the same invoice be paid twice. `normaliseVendorName` now supplies
   * the key; the first spelling seen is kept as the display name.
   *
   * Still not fuzzy matching, deliberately: "Acme Supplies" and "Acme Supply Co" stay
   * separate, because merging two real suppliers points payments at the wrong bank account.
   * Tax-id and bank-detail corroboration is the next step up and is not written yet.
   */
  async resolveByName(tenantId: string, vendorName: string | null | undefined): Promise<string | null> {
    const name = vendorName?.trim();
    if (!name) return null;

    const normalisedName = normaliseVendorName(name);
    // A name of pure punctuation carries no identity. Returning null keeps every such
    // vendor from collapsing into one shared row.
    if (!normalisedName) return null;

    // Relies on the unique index on (tenantId, normalisedName) so two concurrent ingests of
    // differently-spelled versions of one supplier resolve to the same row rather than racing.
    await this.db
      .insert(vendors)
      .values({ tenantId, name, normalisedName })
      .onConflictDoNothing({ target: [vendors.tenantId, vendors.normalisedName] });

    const [vendor] = await this.db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.normalisedName, normalisedName)));

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
@ApiBearerAuth()
@Controller()
export class DirectoryController {
  constructor(private readonly vendorsService: VendorsService) {}

  @Get('vendors')
  vendors(@CurrentUser() { tenantId }: Principal) {
    return this.vendorsService.list(tenantId);
  }

  @Get('users')
  users(@CurrentUser() { tenantId }: Principal) {
    return this.vendorsService.listUsers(tenantId);
  }
}
