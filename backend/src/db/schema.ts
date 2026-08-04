import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  real,
  boolean,
  integer,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Design principles carried over from the original schema:
// 1. Every extracted field stores confidence + provenance -> fieldConfidence jsonb on invoices.
// 2. Workflow is a graph (jsonb), not a fixed chain -> workflowDefinitions.graph.
// 3. Every domain table is tenant-scoped from day one.

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'RECEIVED', 'CLASSIFYING', 'EXTRACTING', 'NEEDS_REVIEW', 'VALIDATING',
  'MATCHING', 'EXCEPTION', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'PAID', 'REJECTED',
]);

export const exceptionTypeEnum = pgEnum('exception_type', [
  'DUPLICATE_INVOICE', 'PO_MISMATCH', 'GRN_MISMATCH', 'FRAUD_RISK',
  'MISSING_PO', 'TAX_MISMATCH', 'VENDOR_NOT_FOUND', 'CURRENCY_MISMATCH',
]);

export const fieldSourceEnum = pgEnum('field_source', ['AI_EXTRACTED', 'HUMAN_CORRECTED', 'MANUAL_ENTRY']);

/**
 * SKIPPED and CANCELLED are deliberately distinct, and `resolveNodeOutcome` excludes both:
 * SKIPPED means a sibling decided this node for you (an ANY node carried, or an ALL node
 * failed), while CANCELLED means the whole instance was recalled out from under the step.
 * Collapsing them would lose the difference between "someone else answered" and "the question
 * was withdrawn", which is exactly what an auditor is asking about.
 */
export const approvalStepStatusEnum = pgEnum('approval_step_status', [
  'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'DELEGATED', 'CANCELLED',
]);

/**
 * ACTIVE is the only status that lets an instance be decided, and at most one per invoice may
 * hold it — enforced by a partial unique index, not by application code.
 *
 * COMPLETED   reached END or REJECT normally.
 * SUPERSEDED  replaced by a fresh instance after a recall; `supersededByInstanceId` points at it.
 * CANCELLED   abandoned with no successor.
 */
export const approvalInstanceStatusEnum = pgEnum('approval_instance_status', [
  'ACTIVE', 'COMPLETED', 'SUPERSEDED', 'CANCELLED',
]);

/**
 * A published definition is immutable. Editing produces a new DRAFT which is published as a
 * new version, so an instance already pointing at the old row keeps its original graph with
 * no per-instance snapshot. A RETIRED definition is never deleted for the same reason.
 */
export const workflowDefinitionStatusEnum = pgEnum('workflow_definition_status', [
  'DRAFT', 'PUBLISHED', 'RETIRED',
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /**
   * Per-tenant PO-matching tolerances, overriding DEFAULT_MATCH_TOLERANCES in
   * `matching/po-matching.ts`. Null means use the defaults. Shape:
   * { pricePct, quantityPct, totalAmountAbs, blockOnOverReceipt }
   */
  matchTolerances: jsonb('match_tolerances'),
  /**
   * Whether `approvalAuthorities` is enforced for this tenant.
   *
   * Off by default, and that is a deliberate rollout choice rather than timidity: switching
   * enforcement on for every tenant at deploy time would refuse every approval until somebody
   * had populated a Chart of Authority, i.e. it would stop the product working. Off means the
   * COA is inert until an administrator has entered limits and turned it on.
   */
  enforceApprovalLimits: boolean('enforce_approval_limits').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/**
 * The Chart of Authority: who may approve, up to how much, for what.
 *
 * This is the piece OpenText VIM calls the COA, and the reason it exists separately from the
 * workflow graph is that the two answer different questions. The graph answers *what sequence*
 * — which steps, which branches. The COA answers *who has authority* — and putting that in the
 * graph, as amount thresholds on CONDITION nodes, means a routine change to one person's
 * spending limit requires editing a published, versioned workflow definition that everyone
 * else is also routed by.
 *
 * One row is one grant. A person needing authority for two currencies, or two document types,
 * gets two rows; the row is the unit an auditor reads.
 *
 * **Currency is mandatory.** An amount band with no currency is not a limit — 10,000 EUR and
 * 10,000 USD are different authorities, and treating a null as "any currency" would silently
 * grant the larger of them.
 */
export const approvalAuthorities = pgTable('approval_authorities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  /** INVOICE | CREDIT_NOTE | … — null means any document type. */
  documentType: text('document_type'),
  currency: text('currency').notNull(),
  amountFrom: numeric('amount_from', { precision: 18, scale: 2 }).notNull().default('0'),
  amountTo: numeric('amount_to', { precision: 18, scale: 2 }).notNull(),
  /**
   * Validity window, so cover during leave is data rather than a code change. Null `validTo`
   * means open-ended, which is the ordinary case.
   */
  validFrom: timestamp('valid_from'),
  validTo: timestamp('valid_to'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantUserIdx: index('coa_tenant_user_idx').on(t.tenantId, t.userId),
}));

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  name: text('name').notNull(),
  /**
   * Flowap's own role, and deliberately **not** taken from the token.
   *
   * An IdP group claim says what someone is in the corporate directory; it does not get to
   * say who may approve a payment here. Roles are provisioned in Flowap and read from this
   * row, so a token asserting `role: ADMIN` grants nothing.
   */
  role: text('role').notNull(), // AP_CLERK | AP_MANAGER | APPROVER | ADMIN | CONTROLLER
  /**
   * The OIDC `sub`, and the issuer that asserted it.
   *
   * Both, because `sub` is only unique **within** an issuer — two IdPs can each emit
   * `sub: "12345"` for different people, and storing the subject alone would let one collide
   * onto the other's user row. The composite unique index below is what stops two identities
   * resolving to one account.
   */
  ssoSubject: text('sso_subject'),
  ssoIssuer: text('sso_issuer'),
  /**
   * Deactivation rather than deletion. `approvalSteps.approverId` and `invoices.postedById`
   * reference this row, so removing a leaver would either break those FKs or destroy the
   * record of who approved a payment. An inactive user is refused at sign-in, so the account
   * stops working while the history it is attached to stays readable.
   */
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantEmailUnique: unique().on(t.tenantId, t.email),
  tenantIdx: index('users_tenant_idx').on(t.tenantId),
  ssoIdentityUnique: unique('users_sso_identity_unique').on(t.ssoIssuer, t.ssoSubject),
}));

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  /** As printed on the document — kept for display, never used for matching. */
  name: text('name').notNull(),
  /**
   * `normaliseVendorName(name)` — the identity key. Accents, case, punctuation and legal-form
   * suffixes stripped, so "Arena Media Comunicaciones España, S.A." and
   * "ARENA MEDIA COMUNICACIONES ESPANA SA" resolve to one vendor.
   *
   * This is load-bearing for money: duplicate detection gates on `vendorId`, so fragmenting a
   * vendor silently disables it and the same invoice can be paid twice.
   */
  normalisedName: text('normalised_name').notNull(),
  taxId: text('tax_id'),
  email: text('email'),
  bankDetails: jsonb('bank_details'),
  riskScore: real('risk_score'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('vendors_tenant_idx').on(t.tenantId),
  // Uniqueness moved to the normalised key: two concurrent ingests of differently-spelled
  // versions of one supplier now collide and resolve to the same row, instead of racing to
  // create two.
  tenantNormalisedUnique: unique().on(t.tenantId, t.normalisedName),
}));

export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  poNumber: text('po_number').notNull(),
  totalAmount: numeric('total_amount', { precision: 18, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
  /**
   * PoLineItem[] — see `matching/po-matching.types.ts`:
   * [{ lineNumber, description, quantity, unitPrice, lineTotal, unit? }]
   * In production these are synced from the ERP, which stays the system of record.
   */
  lineItems: jsonb('line_items').notNull(),
  /**
   * Goods-receipt quantities keyed by PO line number: { "1": 20, "2": 5 }.
   * Absent entirely = no receipt recorded, which is what makes the 3-way match
   * distinguishable from a genuine zero receipt.
   */
  receivedQty: jsonb('received_qty'),
}, (t) => ({
  tenantPoUnique: unique().on(t.tenantId, t.poNumber),
  tenantIdx: index('po_tenant_idx').on(t.tenantId),
}));

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  vendorId: uuid('vendor_id').references(() => vendors.id),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),

  status: invoiceStatusEnum('status').notNull().default('RECEIVED'),
  sourceChannel: text('source_channel').notNull(),
  /** Where the document lives. For uploads this points back at this API's own /files route,
   *  which is what lets the extraction service fetch it the same way it would any URL. */
  fileUrl: text('file_url').notNull(),
  storedFilename: text('stored_filename'), // set for uploads; null when a URL was posted in
  originalFilename: text('original_filename'),
  fileMimeType: text('file_mime_type'),
  fileSizeBytes: integer('file_size_bytes'),

  documentType: text('document_type'), // INVOICE | CREDIT_NOTE | RECEIPT | UNKNOWN, as extracted

  invoiceNumber: text('invoice_number'),
  // The PO number as printed on the invoice. Kept separate from purchaseOrderId: this is
  // what the vendor *claims*, which may not resolve to a real order — the difference
  // between the two is what MISSING_PO reports.
  poNumber: text('po_number'),
  referenceNumber: text('reference_number'), // vendor's own ref: delivery note, contract
  invoiceDate: timestamp('invoice_date'),
  dueDate: timestamp('due_date'),
  supplyDate: timestamp('supply_date'), // delivery/service date; governs tax treatment
  currency: text('currency'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }),
  totalAmount: numeric('total_amount', { precision: 18, scale: 2 }),

  // Claimed on the document, to be compared against vendor master data. Deliberately not
  // written back to `vendors` — a mismatch is a fraud signal, not a master-data update.
  vendorTaxId: text('vendor_tax_id'),
  bankDetails: jsonb('bank_details'),

  // { "invoiceNumber": { "confidence": 0.97, "source": "AI_EXTRACTED" }, ... }
  fieldConfidence: jsonb('field_confidence'),

  // --- Posting back to the ERP ---
  // The ERP's own document number, returned by the posting call. This tool never becomes the
  // ledger (design decision 5) — it records what the ERP assigned so the two can be
  // reconciled. Simulated for now; a real connector fills the same columns.
  erpDocumentNumber: text('erp_document_number'),
  postedAt: timestamp('posted_at'),
  postedById: uuid('posted_by_id'),

  // --- PO match results ---
  // Flat numerics rather than only jsonb, because workflow CONDITION nodes evaluate a
  // numeric column on this row: keeping variance here means variance-based approval
  // routing works through the existing engine with no changes to the evaluator.
  priceVariancePct: real('price_variance_pct'),
  quantityVariancePct: real('quantity_variance_pct'),
  totalVarianceAmount: numeric('total_variance_amount', { precision: 18, scale: 2 }),
  // Per-line detail and the human-readable explanation behind the numbers above.
  matchResult: jsonb('match_result'),

  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  tenantStatusIdx: index('invoices_tenant_status_idx').on(t.tenantId, t.status),
  vendorIdx: index('invoices_vendor_idx').on(t.vendorId),
}));

export const invoiceLineItems = pgTable('invoice_line_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull(),
  lineTotal: numeric('line_total', { precision: 18, scale: 2 }).notNull(),
  taxCode: text('tax_code'),
  taxRate: real('tax_rate'), // percentage, e.g. 19.0
  glCode: text('gl_code'),
  glCodeSource: fieldSourceEnum('gl_code_source'),
  /** Cost assignment. A line is "coded" once both are set; an invoice is codeable-complete
   *  when every line is. Kept as FKs (not just the free-text glCode) so coding can be
   *  validated against the synced chart of accounts. */
  glAccountId: uuid('gl_account_id').references(() => glAccounts.id),
  costCenterId: uuid('cost_center_id').references(() => costCenters.id),
  confidence: real('confidence'),
  /** Which PO line this was matched to, once PO matching has run. Null = unmatched. */
  poLineNumber: integer('po_line_number'),
}, (t) => ({
  invoiceIdx: index('line_items_invoice_idx').on(t.invoiceId),
}));

/**
 * Chart of accounts, synced from the ERP. Like purchase orders, this is a local copy for
 * coding and validation — the ERP remains the master.
 */
export const glAccounts = pgTable('gl_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** EXPENSE | ASSET | LIABILITY | REVENUE — drives which accounts are offered for AP coding. */
  accountType: text('account_type').notNull().default('EXPENSE'),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => ({
  tenantCodeUnique: unique().on(t.tenantId, t.code),
  tenantIdx: index('gl_accounts_tenant_idx').on(t.tenantId),
}));

/** Cost centres / internal orders an expense can be charged to. */
export const costCenters = pgTable('cost_centers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  /** The person accountable for this cost centre — the natural approver for non-PO spend. */
  ownerId: uuid('owner_id').references(() => users.id),
  isActive: boolean('is_active').notNull().default(true),
}, (t) => ({
  tenantCodeUnique: unique().on(t.tenantId, t.code),
  tenantIdx: index('cost_centers_tenant_idx').on(t.tenantId),
}));

export const invoiceExceptions = pgTable('invoice_exceptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  type: exceptionTypeEnum('type').notNull(),
  detail: text('detail').notNull(),
  suggestedFix: text('suggested_fix'),
  resolvedAt: timestamp('resolved_at'),
  resolvedById: uuid('resolved_by_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  invoiceIdx: index('exceptions_invoice_idx').on(t.invoiceId),
}));

export const workflowDefinitions = pgTable('workflow_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  status: workflowDefinitionStatusEnum('status').notNull().default('DRAFT'),
  graph: jsonb('graph').notNull(), // { nodes: [...], edges: [...] }
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantStatusIdx: index('workflow_tenant_status_idx').on(t.tenantId, t.status),
  // Publishing v2 inserts a new row rather than editing v1, so (name, version) is the
  // natural key of a definition and must not collide.
  tenantNameVersionUnique: unique().on(t.tenantId, t.name, t.version),
  // At most one PUBLISHED definition per tenant. startInstance picks "the" published
  // definition, and two of them would make which graph an invoice gets depend on row order.
  onePublishedPerTenant: uniqueIndex('workflow_one_published_per_tenant')
    .on(t.tenantId)
    .where(sql`status = 'PUBLISHED'`),
}));

export const approvalInstances = pgTable('approval_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  // NOT unique: an invoice may accumulate several instances over its life as it is recalled
  // and re-run. The partial index below is what keeps at most one of them live.
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  /**
   * The definition *row*, not a version number — which is what makes versioning free.
   * Published definitions are immutable, so an in-flight instance keeps pointing at the graph
   * it started under even after a v2 is published.
   */
  workflowId: uuid('workflow_id').notNull().references(() => workflowDefinitions.id),
  status: approvalInstanceStatusEnum('status').notNull().default('ACTIVE'),
  currentNodeId: text('current_node_id'),
  /** Set on the superseded instance, pointing forward at the one that replaced it. */
  supersededByInstanceId: uuid('superseded_by_instance_id'),
  /** Why this instance stopped being live — free text, shown in the invoice's history. */
  reason: text('reason'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
}, (t) => ({
  invoiceIdx: index('approval_instances_invoice_idx').on(t.invoiceId),
  // The supersede invariant, enforced by the database rather than by application code: a
  // buggy path or two concurrent requests cannot produce two live instances for one invoice.
  oneActivePerInvoice: uniqueIndex('approval_instances_one_active_per_invoice')
    .on(t.invoiceId)
    .where(sql`status = 'ACTIVE'`),
}));

export const approvalSteps = pgTable('approval_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: uuid('instance_id').notNull().references(() => approvalInstances.id),
  nodeId: text('node_id').notNull(),
  approverId: uuid('approver_id'),
  status: approvalStepStatusEnum('status').notNull().default('PENDING'),
  comment: text('comment'),
  slaDueAt: timestamp('sla_due_at'),
  // Stamped when an SLA breach has been reported for this step, so the escalation sweep
  // reports each breach once instead of re-firing on every tick. A step whose node has no
  // onSlaBreach edge stays PENDING and still shows as overdue — it just stops re-escalating.
  slaBreachedAt: timestamp('sla_breached_at'),
  actedAt: timestamp('acted_at'),
}, (t) => ({
  instanceIdx: index('approval_steps_instance_idx').on(t.instanceId),
}));

/**
 * One row per email message the poller has handled.
 *
 * Exists so a re-poll cannot re-ingest. IMAP's \Seen flag is not enough on its own: a crash
 * between storing an attachment and marking the message read would re-deliver it, and a
 * second copy of a supplier's invoice is a duplicate payment risk rather than a cosmetic
 * annoyance. The unique key is what makes the poll idempotent; the flag is just an
 * optimisation on top.
 */
export const inboundMessages = pgTable('inbound_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  /** RFC 5322 Message-ID as the sender wrote it. */
  messageId: text('message_id').notNull(),
  fromAddress: text('from_address'),
  subject: text('subject'),
  receivedAt: timestamp('received_at'),
  /** How many attachments became invoices — 0 is normal and worth recording. */
  invoicesCreated: integer('invoices_created').notNull().default(0),
  /** Per-attachment outcomes, including why anything was skipped. */
  outcome: jsonb('outcome'),
  processedAt: timestamp('processed_at').defaultNow().notNull(),
}, (t) => ({
  tenantMessageUnique: unique().on(t.tenantId, t.messageId),
  tenantIdx: index('inbound_messages_tenant_idx').on(t.tenantId),
}));

export const erpConnections = pgTable('erp_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  erpType: text('erp_type').notNull(), // S4HANA_CLOUD
  name: text('name'),
  /**
   * Connection settings, with the secret-bearing fields **encrypted at rest**.
   *
   * `baseUrl`, `companyCode` and the auth *kind* stay readable so an administrator can
   * diagnose a connection; `clientSecret`, `password` and `apiKey` are AES-256-GCM envelopes
   * (see `erp/credential-crypto.ts`). This column is a customer's keys to their own ERP — in
   * plaintext, one SELECT by anyone with database access, a backup, or a slow-query log hands
   * over the ability to post accounting documents into a live ledger.
   */
  config: jsonb('config').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  /** Outcome of the last "test connection" or sync, so the state is visible without a log dive. */
  lastTestedAt: timestamp('last_tested_at'),
  lastTestOk: boolean('last_test_ok'),
  lastTestMessage: text('last_test_message'),
  lastSyncAt: timestamp('last_sync_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('erp_tenant_idx').on(t.tenantId),
}));

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  tenantId: uuid('tenant_id').notNull(),
  actorId: uuid('actor_id'),
  /**
   * *What kind of thing* took this action: 'SYSTEM' | 'HUMAN' | 'COPILOT'.
   *
   * `actorId` alone cannot answer this. It is null for everything the pipeline does, and a
   * null could equally mean "the system did it" or "a human did it and nobody recorded who" —
   * which is exactly what it did mean before this column existed, on every FIELD_CORRECTED
   * and every APPROVAL_STEP_DECIDED row.
   *
   * The touchless rate is defined over human actions, so an unattributed human action makes
   * the rate look *better*. Errors in a metric used for a sales claim should not all point the
   * same way, so this is `notNull` with a SYSTEM default and the writers pass it explicitly.
   *
   * 'COPILOT' is a distinct value rather than a flavour of SYSTEM on purpose: an action a
   * model chose is a different claim from an action a deterministic rule took, and once the
   * two are indistinguishable in the trail, "what did the AI do to this invoice" stops being
   * an answerable question.
   */
  actorKind: text('actor_kind').notNull().default('SYSTEM'),
  action: text('action').notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('audit_tenant_idx').on(t.tenantId),
  invoiceIdx: index('audit_invoice_idx').on(t.invoiceId),
  // The touchless aggregation groups a tenant's events by invoice and action.
  touchIdx: index('audit_touch_idx').on(t.tenantId, t.invoiceId, t.actorKind),
}));
