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
} from 'drizzle-orm/pg-core';

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

export const approvalStepStatusEnum = pgEnum('approval_step_status', [
  'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED', 'DELEGATED',
]);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(), // AP_CLERK | AP_MANAGER | APPROVER | ADMIN | CONTROLLER
  ssoSubject: text('sso_subject'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantEmailUnique: unique().on(t.tenantId, t.email),
  tenantIdx: index('users_tenant_idx').on(t.tenantId),
}));

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  taxId: text('tax_id'),
  email: text('email'),
  bankDetails: jsonb('bank_details'),
  riskScore: real('risk_score'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('vendors_tenant_idx').on(t.tenantId),
}));

export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  poNumber: text('po_number').notNull(),
  totalAmount: numeric('total_amount', { precision: 18, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
  lineItems: jsonb('line_items').notNull(),
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
  fileUrl: text('file_url').notNull(),

  invoiceNumber: text('invoice_number'),
  invoiceDate: timestamp('invoice_date'),
  dueDate: timestamp('due_date'),
  currency: text('currency'),
  subtotal: numeric('subtotal', { precision: 18, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 18, scale: 2 }),
  totalAmount: numeric('total_amount', { precision: 18, scale: 2 }),

  // { "invoiceNumber": { "confidence": 0.97, "source": "AI_EXTRACTED" }, ... }
  fieldConfidence: jsonb('field_confidence'),

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
  glCode: text('gl_code'),
  glCodeSource: fieldSourceEnum('gl_code_source'),
  confidence: real('confidence'),
}, (t) => ({
  invoiceIdx: index('line_items_invoice_idx').on(t.invoiceId),
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
  isActive: boolean('is_active').notNull().default(true),
  graph: jsonb('graph').notNull(), // { nodes: [...], edges: [...] }
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantActiveIdx: index('workflow_tenant_active_idx').on(t.tenantId, t.isActive),
}));

export const approvalInstances = pgTable('approval_instances', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().unique().references(() => invoices.id),
  workflowId: uuid('workflow_id').notNull().references(() => workflowDefinitions.id),
  currentNodeId: text('current_node_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

export const approvalSteps = pgTable('approval_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  instanceId: uuid('instance_id').notNull().references(() => approvalInstances.id),
  nodeId: text('node_id').notNull(),
  approverId: uuid('approver_id'),
  status: approvalStepStatusEnum('status').notNull().default('PENDING'),
  comment: text('comment'),
  slaDueAt: timestamp('sla_due_at'),
  actedAt: timestamp('acted_at'),
}, (t) => ({
  instanceIdx: index('approval_steps_instance_idx').on(t.instanceId),
}));

export const erpConnections = pgTable('erp_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  erpType: text('erp_type').notNull(),
  config: jsonb('config').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('erp_tenant_idx').on(t.tenantId),
}));

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  tenantId: uuid('tenant_id').notNull(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  tenantIdx: index('audit_tenant_idx').on(t.tenantId),
  invoiceIdx: index('audit_invoice_idx').on(t.invoiceId),
}));
