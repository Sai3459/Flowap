/**
 * ERP connections: stored config, a live "test connection", and a manual sync.
 *
 * This is where the S/4HANA mappers stop being pure functions with no caller. Two things it is
 * careful about:
 *
 * **Secrets never travel outwards.** Config is encrypted on write, decrypted only in memory at
 * the moment a request is built, and redacted on every read path. There is no endpoint that
 * returns a client secret, and the placeholder on write means "leave it as it is" so a client
 * round-tripping the redacted object cannot blank a credential it never saw.
 *
 * **Sync is idempotent by natural key.** Purchase orders come back through the same
 * `PurchaseOrdersService.sync` an administrator would call by hand, so a sync run and a manual
 * push cannot diverge into two code paths — and re-running a sync updates rather than
 * duplicating.
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { erpConnections } from '../db/schema';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import {
  decryptConfig,
  encryptConfig,
  encryptionKey,
  redactConfig,
  SECRET_PLACEHOLDER,
  isSecretField,
} from './credential-crypto';
import { S4Client, S4RequestError } from './s4hana/s4-client';
import { resolveS4Auth } from './s4hana/s4-auth';
import { mapPurchaseOrders } from './s4hana/s4-purchase-order';

/** The service paths the mappers already target. */
export const S4_PATHS = {
  purchaseOrders: '/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV/A_PurchaseOrder',
  supplierInvoices: '/sap/opu/odata/sap/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice',
  materialDocuments: '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader',
} as const;

export interface ErpConnectionConfig {
  baseUrl: string;
  authKind: 'apiKey' | 'basic' | 'oauth2';
  apiKey?: string;
  user?: string;
  password?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  companyCode?: string;
}

@Injectable()
export class ErpConnectionsService {
  private readonly logger = new Logger(ErpConnectionsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Never returns secrets — see redactConfig. */
  async list(tenantId: string) {
    const rows = await this.db.select().from(erpConnections).where(eq(erpConnections.tenantId, tenantId));
    return rows.map((r) => ({ ...r, config: redactConfig(r.config as Record<string, unknown>) }));
  }

  async create(tenantId: string, erpType: string, name: string, config: ErpConnectionConfig) {
    this.assertUsable(config);
    const [created] = await this.db
      .insert(erpConnections)
      .values({
        tenantId,
        erpType,
        name,
        config: encryptConfig(config as unknown as Record<string, unknown>, encryptionKey()),
      })
      .returning();
    this.logger.log(`Created ${erpType} connection ${created.id} for tenant ${tenantId}`);
    return { ...created, config: redactConfig(created.config as Record<string, unknown>) };
  }

  async update(tenantId: string, id: string, patch: Partial<ErpConnectionConfig>) {
    const row = await this.require(tenantId, id);
    const current = decryptConfig(row.config as Record<string, unknown>, encryptionKey());

    // A field left at the placeholder is one the client was shown but never saw the value of.
    // Writing it back verbatim would replace a real secret with bullet characters.
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (isSecretField(k) && v === SECRET_PLACEHOLDER) continue;
      merged[k] = v;
    }
    this.assertUsable(merged as unknown as ErpConnectionConfig);

    const [updated] = await this.db
      .update(erpConnections)
      .set({ config: encryptConfig(merged, encryptionKey()) })
      .where(eq(erpConnections.id, id))
      .returning();
    return { ...updated, config: redactConfig(updated.config as Record<string, unknown>) };
  }

  /**
   * Opens a real connection and reads one row.
   *
   * The outcome is stored, so "is this working" survives the person who clicked the button.
   * A failure is recorded as a failure rather than thrown away — a connection that has never
   * succeeded and one that broke this morning need to look different.
   */
  async testConnection(tenantId: string, id: string) {
    const row = await this.require(tenantId, id);
    const client = this.clientFor(row.config as Record<string, unknown>);

    try {
      const result = await client.ping(S4_PATHS.purchaseOrders);
      await this.recordTest(id, true, `Reached ${(row.config as ErpConnectionConfig).baseUrl}; read ${result.sample} row(s).`);
      return { ok: true, message: 'Connection succeeded.', sample: result.sample };
    } catch (err) {
      const message = err instanceof S4RequestError ? err.message : (err as Error).message;
      await this.recordTest(id, false, message);
      // Returned rather than thrown: a failed connection test is a normal answer to "does this
      // work", not a server error, and the caller needs the detail to fix the configuration.
      return { ok: false, message };
    }
  }

  /**
   * Pulls purchase orders and upserts them through the existing PO service.
   *
   * Manual for now. A scheduled job wants a lock and a watermark so two replicas do not both
   * sweep, and that belongs with the integration plane rather than being bolted on here.
   */
  async syncPurchaseOrders(tenantId: string, id: string, since?: Date) {
    const row = await this.require(tenantId, id);
    const client = this.clientFor(row.config as Record<string, unknown>);

    const raw = await client.getRaw(S4_PATHS.purchaseOrders, {
      $expand: 'to_PurchaseOrderItem',
      $format: 'json',
      $filter: since ? `LastChangeDateTime ge datetime'${since.toISOString().slice(0, 19)}'` : undefined,
    });

    const orders = mapPurchaseOrders(raw);
    const results: { poNumber: string; ok: boolean; error?: string }[] = [];

    for (const po of orders) {
      try {
        await this.purchaseOrders.upsert(tenantId, {
          poNumber: po.poNumber,
          vendorName: po.supplierExternalId, // no vendor master sync yet — see the gap note
          currency: po.currency,
          totalAmount: po.totalAmount,
          lineItems: po.lines.map((l) => ({
            lineNumber: l.lineNumber,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            lineTotal: l.lineTotal,
            unit: l.unit ?? undefined,
          })),
        });
        results.push({ poNumber: po.poNumber, ok: true });
      } catch (err) {
        // One bad order must not abort the run — the rest of the sync is still worth having.
        results.push({ poNumber: po.poNumber, ok: false, error: (err as Error).message });
      }
    }

    await this.db.update(erpConnections).set({ lastSyncAt: new Date() }).where(eq(erpConnections.id, id));
    const failed = results.filter((r) => !r.ok);
    this.logger.log(`Synced ${results.length - failed.length}/${results.length} purchase orders for tenant ${tenantId}`);
    return { fetched: orders.length, synced: results.length - failed.length, failures: failed, results };
  }

  /** Builds a live client from stored config. Decryption happens here and nowhere else. */
  private clientFor(stored: Record<string, unknown>): S4Client {
    const config = decryptConfig(stored, encryptionKey()) as unknown as ErpConnectionConfig;
    return new S4Client({ baseUrl: config.baseUrl, auth: resolveS4Auth(config) });
  }

  private async recordTest(id: string, ok: boolean, message: string) {
    await this.db
      .update(erpConnections)
      .set({ lastTestedAt: new Date(), lastTestOk: ok, lastTestMessage: message.slice(0, 500) })
      .where(eq(erpConnections.id, id));
  }

  private async require(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(erpConnections)
      .where(and(eq(erpConnections.id, id), eq(erpConnections.tenantId, tenantId)));
    if (!row) throw new NotFoundException('ERP connection not found');
    return row;
  }

  /** Refuses a config that could never work, at write time rather than at first use. */
  private assertUsable(config: ErpConnectionConfig) {
    if (!config.baseUrl || !/^https?:\/\//.test(config.baseUrl)) {
      throw new BadRequestException('baseUrl must be an absolute http(s) URL.');
    }
    const need: Record<string, (keyof ErpConnectionConfig)[]> = {
      apiKey: ['apiKey'],
      basic: ['user', 'password'],
      oauth2: ['tokenUrl', 'clientId', 'clientSecret'],
    };
    const required = need[config.authKind];
    if (!required) throw new BadRequestException(`authKind must be one of ${Object.keys(need).join(', ')}.`);
    const missing = required.filter((f) => !config[f]);
    if (missing.length) {
      throw new BadRequestException(`authKind "${config.authKind}" requires: ${missing.join(', ')}.`);
    }
  }
}
