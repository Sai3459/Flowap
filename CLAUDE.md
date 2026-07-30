# CLAUDE.md — Universal Invoice Management Platform

Read this before doing anything else in this repo. It's the context a new session needs.

## What this is
An AI-first vendor invoice management platform (AP automation), designed to beat the
market incumbents (OpenText VIM, Basware, Coupa, Kofax, Tipalti) on three specific,
verified failure points:
1. **OCR/extraction that's either brittle rules or an unaccountable black box.**
2. **Workflow engines that are "configurable" until you need something non-standard.**
3. **"AI" that's really just OCR wearing a costume, not something that reasons.**

See competitive research and full differentiation strategy in the conversation history /
project docs — the short version is in "Core design decisions" below.

## Stack (chosen for THIS sandbox's constraints — re-evaluate for production)
- **Backend:** NestJS (TypeScript), run via `ts-node` (NOT `tsx` — see gotcha below)
- **ORM:** Drizzle ORM + `pg` (node-postgres) — NOT Prisma
- **AI/Extraction service:** Python FastAPI, calls Claude API directly for vision-based extraction
- **DB:** PostgreSQL 16
- **Frontend:** React + TypeScript + Vite (`frontend/`), react-router, plain CSS, no UI kit

### Why not .NET/Java/Prisma
This was built inside a sandboxed environment whose network allowlist covers npm and
PyPI but NOT NuGet (`api.nuget.org`), Maven Central, or Prisma's engine binary host
(`binaries.prisma.sh`). That's a sandbox constraint, not a recommendation against those
tools for production — if you're now working in an unrestricted environment (e.g. local
Claude Code), Prisma is worth reconsidering for its superior DX, and .NET/Java are back
on the table if there's an organizational reason to prefer them. The architecture
(REST API, clear module boundaries, Postgres schema) ports cleanly either way.

## Critical gotcha: use `ts-node`, not `tsx`
`tsx` (esbuild-based) does NOT fully emit the `design:paramtypes` decorator metadata
NestJS's dependency injection relies on. Routes will map correctly and the app will
"start," but constructor-injected services will be `undefined` at call time, producing
`Cannot read properties of undefined` errors that look unrelated to DI. Always run this
project with `ts-node`, and keep `typescript` pinned to `5.7.3` in package.json —
`ts-node@10.9.2` has a config-loading crash against TypeScript 7.x.

## How to run locally
```bash
# 1. Postgres (adjust for your OS/package manager)
createdb invoice_platform

# 2. Backend
cd backend
npm install
export DATABASE_URL="postgresql://postgres:<password>@localhost:5432/invoice_platform"
export EXTRACTION_SERVICE_URL="http://localhost:8001"
npx drizzle-kit push --force   # applies schema — see src/db/schema.ts
npx ts-node src/main.ts        # NOT npx tsx

# 3. Extraction service (separate terminal)
cd extraction-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export ANTHROPIC_API_KEY="sk-..."
.venv/bin/python -m uvicorn main:app --port 8001

# 3b. …or the mock, which needs no API key and is what the E2E checks above ran against.
#     Serves a clean invoice ($1296), a low-amount one (url contains "lowamount", $486),
#     and a deliberately inconsistent one (url contains "inconsistent").
.venv/bin/python -m uvicorn mock_server:app --port 8001

# 4. Frontend (separate terminal)
cd frontend
npm install
npm run dev        # http://localhost:5173
```

The UI needs a tenant UUID, entered in its header bar and kept in localStorage (the backend
still resolves tenants from the `x-tenant-id` header). Get one with:
`psql -c "SELECT id, name FROM tenants;"` — or set `VITE_TENANT_ID` in `frontend/.env`
as a default (see `frontend/.env.example`).

Tests: `cd backend && npm test` — Node's built-in runner, no DB or running server needed.

API docs: `http://localhost:3000/api/docs` (Swagger, auto-generated from decorators).

Note the backend restarts fussily: `npx ts-node` leaves a child `node` process behind, so
killing only the wrapper PID silently fails the next start with `EADDRINUSE`. Kill every PID
matching `ts-node src/main.ts` before restarting.

## Core design decisions baked into the code (don't casually change these)

1. **Confidence is per-field, not per-document**, and lives in `invoices.fieldConfidence`
   (jsonb): `{ "fieldName": { "confidence": 0.0-1.0, "source": "AI_EXTRACTED" | "HUMAN_CORRECTED" | "MANUAL_ENTRY" } }`.
   Only fields below `CONFIDENCE_REVIEW_THRESHOLD` (0.9, in `extraction-client.service.ts`)
   ever need a human. This is what lets a 98%-confident header with one shaky line item
   surface only that one line item — not the whole document.

2. **The extraction service never trusts the model's self-reported confidence alone.**
   `_apply_arithmetic_consistency_checks()` in `extraction-service/main.py` independently
   verifies subtotal+tax=total and sum(line items)=subtotal, downgrading confidence when
   the arithmetic doesn't hold regardless of what the model claimed. This is unit-tested
   and verified working (see conversation history) — a deliberately-wrong total was
   correctly caught and downgraded from 0.95 to 0.4 confidence.

3. **Workflow is a graph (`workflowDefinitions.graph` jsonb: `{nodes, edges}`), not a
   fixed N-level chain.** This is the anti-rigidity design — a visual builder sits on
   top, but power users can drop into raw graph/expression editing when a wizard runs
   out of road. The engine that evaluates this at runtime is **built** — see
   `src/workflow/` and the graph contract below.

4. **Every table is tenant-scoped from day one** (`tenantId` FK on nearly everything).
   Tenant resolution is currently a raw `x-tenant-id` header for prototype convenience —
   **this must be replaced with SSO-session-derived tenant resolution before any real
   auth is added.** Never let a client supply its own tenant ID in production.

5. **ERP integration is an overlay, not a replacement.** `ErpConnection` stores
   per-tenant connector config; the platform should feel like an upgrade sitting on top
   of the existing ERP, not a new system of record competing with it.

## The workflow graph contract (`src/workflow/`)

`WorkflowEngineService` walks a tenant's active `workflowDefinitions.graph`, creating
`approvalSteps` rows and moving `approvalInstances.currentNodeId` as steps are decided.
START and CONDITION nodes resolve in-memory without persisting; the engine only parks
(and writes) at an APPROVAL node or a terminal node. Shapes live in
`workflow-graph.types.ts`; `validateGraph()` enforces the structure below **at
definition-creation time**, so the engine can assume a well-formed graph at runtime
rather than re-checking invariants on every advance.

**Node types.** `START` (exactly one per graph, one outgoing edge) · `APPROVAL` ·
`CONDITION` · `END` (→ invoice `APPROVED`) · `REJECT` (→ invoice `REJECTED`).

**APPROVAL nodes** need an approver (`approverType: 'USER'` + `approverIds`, or
`'ROLE'` + `approverRole` resolved against tenant users) and a `mode`:
- `ALL` — a parallel approval group; every approver must approve, and any single
  rejection fails the node immediately without waiting for the rest.
- `ANY` — first decision wins; an approval carries the node outright, while a rejection
  only fails it once *every* approver has rejected.

Sequential approval is just APPROVAL nodes chained by edges — there is no separate
"level" concept. Optional `slaHours` sets each step's `slaDueAt`.

**Edges** out of an APPROVAL node: the one plain edge is the approve path, plus at most
one `onReject` and at most one `onSlaBreach` alternate exit. Use `isApproveEdge()` rather
than testing flags by hand so the engine and validator can't drift. A rejected node with
no `onReject` edge terminates the instance as REJECTED. Out of a CONDITION node: any
number of edges carrying `condition: {op, value}` evaluated against a numeric invoice
field (`field`), plus exactly one `isDefault` fallback. A non-numeric or null field
matches nothing, so the default edge is taken.

**Step statuses.** `PENDING`/`APPROVED`/`REJECTED` are the deciding states;
`DELEGATED` and `SKIPPED` are excluded from node-outcome evaluation (see
`resolveNodeOutcome`). Delegation marks the original step `DELEGATED` and creates a
replacement `PENDING` step on the same node, inheriting the original `slaDueAt` so a
handoff can't quietly reset the clock. Counting `DELEGATED` rows would deadlock an ALL
node — there's a regression test for exactly that.

## What's built and verified (as of last session)
- Full Drizzle schema, pushed to a real Postgres instance — 12 tables, all FKs correct
- `POST /invoices` — full ingestion pipeline: create → call extraction service → apply
  confidence-based routing (NEEDS_REVIEW vs VALIDATING) → duplicate check → PENDING_APPROVAL/EXCEPTION
- `GET /invoices/exceptions` — review/exception queue
- `GET /invoices/:id` — single invoice with line items + exceptions
- `PATCH /invoices/:id/correct-field` — human correction, updates provenance to HUMAN_CORRECTED
- Verified live against a mock extraction server (no real Anthropic key was available in
  the build sandbox): a clean invoice sailed through to PENDING_APPROVAL automatically;
  a deliberately inconsistent invoice was caught, downgraded, and routed to NEEDS_REVIEW.
- **Workflow engine** — `POST|GET /workflow-definitions`, `GET /workflow-definitions/:id`,
  `GET /approvals/:invoiceId`, `POST /approvals/steps/:stepId/decide`,
  `POST /approvals/steps/:stepId/delegate`, `GET /approvals/overdue`,
  `POST /approvals/escalate-overdue`. `InvoicesService.runValidation()` calls
  `startInstance()` when an invoice reaches PENDING_APPROVAL; the engine flips the invoice
  to APPROVED/REJECTED when an instance completes. Verified live: amount-based branching
  ($486 → single approver, $1296 → parallel managers → role-resolved controller),
  rejection short-circuiting pending siblings, delegation mid-parallel-group, SLA breach
  routing down an `onSlaBreach` edge, and tenant isolation on every new endpoint.
- **Unit tests** — `npm test` (Node's built-in runner via `node:test`, no extra deps).
  29 tests covering `resolveNodeOutcome`, `evaluateCondition`, and `validateGraph`. These
  are the pure graph functions; anything touching the DB is still only verified by hand.
- **SLA escalation scheduler** — `SlaSchedulerService` runs `escalateOverdueStepsAllTenants()`
  on a cron (default every 10 min; `SLA_ESCALATION_CRON` to change, `SLA_ESCALATION_ENABLED=false`
  to disable). Escalations now fire without anyone calling the endpoint. Each breach is
  reported once via the `approvalSteps.slaBreachedAt` stamp — before that existed, a node
  with no `onSlaBreach` edge re-logged a breach on every tick forever. Verified live with a
  1-minute cron: one audit row across multiple ticks, step left PENDING but not re-fired.
- **Vendor resolution on ingest** — `resolveVendor()` upserts the extracted `vendorName` into
  `vendors` (unique on `tenantId+name`) and sets `invoices.vendorId`. This also switched
  **duplicate detection on for the first time**: it gates on `vendorId`, which nothing had
  ever populated, so that check had never once run. Verified: ingesting the same mock invoice
  twice now produces a `DUPLICATE_INVOICE` exception where it previously sailed through.
- **`GET /invoices`** — list endpoint for the UI: vendor name joined in, plus a
  `lowConfidenceFields` array so a client doesn't have to interpret `fieldConfidence` itself.
  `GET /invoices/:id`, `GET /invoices/exceptions` and the correct-field response all join
  vendor name too, so it reads consistently across screens.
- **`PATCH /invoices/:id/correct-field` hardened** — `fieldName` is checked against a
  `CORRECTABLE_FIELDS` allowlist and values are coerced per field. It previously wrote
  `fieldName` straight into an `UPDATE ... SET`, so a client could rewrite `status`,
  `tenantId` or `vendorId` through it; correcting a date also threw, because Drizzle needs a
  `Date` for a timestamp column and the endpoint passed the raw string.
- **Frontend** (`frontend/`, React + TS + Vite) — three screens, verified in a real browser
  against the running API:
  - **Invoice list** — status, vendor, amount, and a per-row confidence indicator
    (`N fields flagged` / `clean`).
  - **Invoice detail** — every extracted field beside its confidence and provenance; only
    sub-threshold rows are highlighted, which is the per-field design made visible. Flagged
    fields are editable inline against the correct-field endpoint, and server-side validation
    errors render in the row. A correction flips the row to `corrected` at 100% and drops it
    out of the flagged count.
  - **Review queue** — `NEEDS_REVIEW` + `EXCEPTION`, showing each recorded exception's detail
    and suggested fix, plus a generated summary of which fields were low-confidence and why.

## Not yet built (in rough priority order)
1. **Real auth** — SSO (Entra ID, Google), replace the `x-tenant-id` header hack. This is
   also what makes the workflow engine's approver check real: `decideStep`/`delegateStep`
   verify the caller is the step's assigned approver, but they compare against a
   **client-supplied** `approverId` in the request body. That stops wrong-user and
   accidental decisions; it is not authorization until the id comes from a session. When
   this lands, `assertIsAssignedApprover` should read the session subject instead — the
   check itself doesn't need to move.
2. **PO / goods-receipt matching** — `PurchaseOrder` table exists; no matching logic yet.
   `runValidation()` in `invoices.service.ts` is where this plugs in, next to the existing
   duplicate check.
3. **Approvals in the UI** — the three review screens exist, but nothing in the frontend
   touches the workflow engine. No approve/reject/delegate view, no overdue dashboard, no
   mobile approval screen. `GET /approvals/:invoiceId` and the decide/delegate endpoints are
   API-only, and the detail screen doesn't show where an invoice sits in its approval graph.
4. **Fraud risk scoring** — `Vendor.riskScore` field exists; nothing populates it.
5. **AI copilot** — natural-language invoice search, GL coding suggestions, plain-language
   explanations of why an invoice is stuck (the extraction service's `_consistency_warnings`
   are a natural input to this).
6. **Feedback loop** — `/feedback` endpoint on the extraction service is a stub; needs to
   actually persist corrections per tenant/vendor-layout and feed them back into the
   extraction prompt as few-shot examples.
7. **Vendor portal** — separate, simplified auth context and shell.
8. **ERP connectors** — `ErpConnection` config storage exists; no actual connector logic.

### Known gaps in the workflow engine
- **The SLA scheduler is a single-process in-memory cron, with no locking.** Fine for one
  API instance; run two replicas and both sweep, so a breach can be escalated twice. The
  `slaBreachedAt` stamp narrows the window but is not a lock — the read and the write are
  separate statements. Production wants a real queue, a leader election, or a
  `SELECT ... FOR UPDATE SKIP LOCKED` claim.
- **The cron expression is read at import time.** `SLA_ESCALATION_CRON` must be a real
  process env var; a value in a `.env` file loaded later by `ConfigModule` is ignored.
- **`advance()` is not transactional.** It performs several sequential writes (step
  inserts, `currentNodeId` updates, invoice status), so a crash mid-advance can leave an
  instance parked between nodes. Wrap the traversal in a Drizzle transaction before this
  carries real volume.
- **Two approvers deciding the last step of an ALL node concurrently can double-advance.**
  The `PENDING` check and the outcome evaluation are separate reads with no row lock.
  A `SELECT ... FOR UPDATE` on the step (or a unique constraint on
  `instanceId+nodeId+approverId`) is the fix.
- **No cycle detection in `validateGraph`.** A graph whose edges loop back would make
  `advance()` spin. Well-formed graphs from the builder won't, but hand-authored jsonb could.
- **Definitions can be created and read, but not updated or deactivated via the API.**
  There is no PATCH/PUT/DELETE on `/workflow-definitions` — changing or retiring a
  definition currently means touching the DB directly (that's how the `isActive` flag got
  flipped during testing). `createDefinition` also never sets `version`, so every
  definition is version 1 and `startInstance()`'s version ordering never actually
  discriminates; publishing a v2 needs an endpoint that increments it and deactivates the
  prior row.
- **Running instances re-read their definition's graph on every decision.** `decideStep`
  loads the definition fresh rather than snapshotting the graph onto the instance, so a
  graph edited underneath an in-flight instance changes that instance's remaining path.
  Pinning the graph (or the `version`) per instance is the safer model.

### Known gaps in the frontend
- **No tests at all.** Verified by driving a real browser against the running API, not by
  anything repeatable. No component tests, no e2e suite.
- **Tenant is typed into the header bar** and kept in localStorage, mirroring the backend's
  `x-tenant-id` hack. It is a prototype affordance and should be deleted wholesale when SSO
  lands, not adapted.
- **Read-mostly.** The only write in the whole UI is correct-field. No ingestion/upload
  screen (invoices arrive via `POST /invoices` by hand), no approval actions, no way to
  resolve an exception — `invoiceExceptions.resolvedAt` has no endpoint or UI behind it.
- **Duplicated constants.** `CONFIDENCE_REVIEW_THRESHOLD`, the correctable-field list and
  the field labels are restated in `frontend/src/lib/confidence.ts`. The backend stays
  authoritative (it returns `lowConfidenceFields` and rejects non-allowlisted fields), but
  the copies can drift out of sync with no test to catch it.
- **No pagination, filtering, or sorting** on the invoice list — it renders every invoice
  the tenant has in one table.
- **`vendorName` is shown with a confidence score but is not editable**, because correcting
  it means re-linking a `Vendor` row rather than writing a column. It's the one field on the
  detail screen with a confidence and no Edit affordance.
- **Vendor matching is exact-name.** `resolveVendor()` does no normalisation, so
  "Acme Inc." and "Acme, Inc" become two vendors — and duplicate detection, which keys on
  `vendorId`, won't see invoices from those two as related.

## Conventions
- Tenant ID always comes first in service method signatures: `(tenantId, ...)`.
- Every state-changing action should write an `AuditEvent` — see `logAudit()` pattern
  in `invoices.service.ts`.
- Money fields are `numeric(18,2)` in Postgres / passed as strings to Drizzle inserts
  (avoid floating point on currency amounts).
- New Nest modules follow the standard controller/service/dto split already established
  in `src/invoices/`.
