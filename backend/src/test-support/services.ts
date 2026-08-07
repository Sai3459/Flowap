/**
 * Wires the real services against the test database, by hand.
 *
 * Deliberately not `@nestjs/testing`: the services are plain classes with constructor
 * injection, so calling `new` is enough, and adding a test-only Nest dependency to run them
 * buys nothing. The `DatabaseService` stand-in is the same shape the real one exposes
 * (`.db`), so the services under test cannot tell the difference.
 *
 * The extractor is stubbed. Everything else — matching, workflow traversal, coding, posting,
 * the audit trail — is the production code path hitting real Postgres.
 */
import type { DatabaseService } from '../db/database.service';
import { InvoicesService } from '../invoices/invoices.service';
import { FileStorageService } from '../invoices/file-storage.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { VendorsService } from '../vendors/vendors.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { CodingService } from '../coding/coding.service';
import { PostingService } from '../posting/posting.service';
import { DashboardService } from '../dashboard/dashboard.service';
import { TouchlessService } from '../metrics/touchless.service';
import { CopilotService } from '../copilot/copilot.service';
import { AutoApproveService } from '../workflow/auto-approve.service';
import { StubExtractionClient, scenario } from './fixtures';
import type { TestDb } from './db';

export interface TestServices {
  invoices: InvoicesService;
  workflow: WorkflowEngineService;
  vendors: VendorsService;
  purchaseOrders: PurchaseOrdersService;
  coding: CodingService;
  posting: PostingService;
  dashboard: DashboardService;
  touchless: TouchlessService;
  copilot: CopilotService;
  autoApprove: AutoApproveService;
  /** Controls what the next ingest will "extract". */
  extraction: StubExtractionClient;
}

export function buildServices(db: TestDb): TestServices {
  const database = { db } as unknown as DatabaseService;
  const extraction = new StubExtractionClient(scenario('cleanpo'));

  const autoApprove = new AutoApproveService(database);
  const workflow = new WorkflowEngineService(database, autoApprove);
  const vendors = new VendorsService(database);
  const copilot = new CopilotService(database);
  const invoices = new InvoicesService(
    database,
    extraction as never, // structurally compatible: the pipeline only ever calls extract()
    workflow,
    vendors,
    new FileStorageService(),
    copilot,
  );
  const purchaseOrders = new PurchaseOrdersService(database, vendors, invoices);

  const touchless = new TouchlessService(database);

  return {
    invoices,
    workflow,
    vendors,
    purchaseOrders,
    autoApprove,
    coding: new CodingService(database),
    posting: new PostingService(database),
    dashboard: new DashboardService(database, touchless),
    touchless,
    copilot,
    extraction,
  };
}
