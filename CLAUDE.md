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

# 3b. …or the mock, which needs no API key and is what every E2E check has run against.
#     Scenarios are chosen by a token in the requested file_url — GET /health lists them:
#       cleanpo | withintolerance | pricevariance | qtyvariance | unknownpo
#       currencymismatch | nopo | lowamount | inconsistent
#     The PO scenarios assume this order exists:
#       PO-5000, Northwind Traders, 20 x "Consulting hours" @ 60.00 USD, received 20
#     Seed it via POST /purchase-orders (see "Purchase order API" below).
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
  97 tests covering `resolveNodeOutcome`, `evaluateCondition`, `validateGraph`, the PO matching
  functions (`matchInvoiceToPo`, `pairLines`, `variancePct`, `resolveTolerances`),
  `validatePoPayload`, and the re-validation rules (`revalidationDecision`,
  `correctionBlockedByApproval`). These are the pure functions; anything touching the DB is
  still only verified by hand.
- **SLA escalation scheduler** — `SlaSchedulerService` runs `escalateOverdueStepsAllTenants()`
  on a cron (default every 10 min; `SLA_ESCALATION_CRON` to change, `SLA_ESCALATION_ENABLED=false`
  to disable). Escalations now fire without anyone calling the endpoint. Each breach is
  reported once via the `approvalSteps.slaBreachedAt` stamp — before that existed, a node
  with no `onSlaBreach` edge re-logged a breach on every tick forever. Verified live with a
  1-minute cron: one audit row across multiple ticks, step left PENDING but not re-fired.
- **PO matching (2- and 3-way) with variance routing** — `src/matching/po-matching.ts` is pure
  and unit-tested; `runPoMatch()` in `invoices.service.ts` wires it into `runValidation()`.
  Extraction now returns `poNumber`, so the PO is resolved by `(tenantId, poNumber)`, lines are
  paired to PO lines (normalised description, positional fallback, each PO line claimed once),
  and price/quantity/net-total variance is computed against per-tenant tolerances
  (`tenants.matchTolerances`, defaults in `DEFAULT_MATCH_TOLERANCES`). Goods receipt
  (`purchaseOrders.receivedQty`) drives the third way. All the previously-unused exception types
  now fire: `MISSING_PO`, `PO_MISMATCH`, `GRN_MISMATCH`, `CURRENCY_MISMATCH`.
  Verified live across 7 scenarios (clean, within-tolerance, price variance, quantity variance
  + over-receipt, unknown PO, currency mismatch, non-PO).
- **Purchase order API** — `POST /purchase-orders` (create or re-sync), `GET /purchase-orders`,
  `GET /purchase-orders/:poNumber`, `POST /purchase-orders/:poNumber/receipts`. Shaped as an
  **ERP sync**, not an authoring form: `poNumber` is the natural key and re-posting the same PO
  updates the local copy, so an ERP connector can replay idempotently and the ERP stays the
  system of record. Vendors are resolved by name through the shared `VendorsService`, so an
  invoice and its PO cannot end up on two different vendor rows for the same company.
  `validatePoPayload()` is pure and unit-tested: it rejects a PO whose header total disagrees
  with its own lines, because such a PO produces phantom total variance on *every* invoice
  matched to it. The consequence is that freight/surcharges must be modelled as their own PO
  line — which is also what makes them matchable later.
- **Goods receipts** are recorded separately (`/receipts`, merging rather than replacing, since
  partial deliveries land over time). This is what makes the third leg of the 3-way match
  reachable without raw SQL.
- **Re-validation** — `revalidate()` clears the previous match's conclusions (variance columns,
  `purchaseOrderId`, per-line `poLineNumber`), marks the exceptions the previous run raised as
  `resolvedAt` rather than deleting them, and re-runs `runValidation`. Triggered three ways:
  automatically when a correction changes a field a check reads (`CORRECTABLE_FIELDS[...]
  .revalidates` — `invoiceNumber`, `poNumber`, `currency`, `subtotal`); automatically when a
  correction clears the last field holding an invoice in review; and explicitly via
  `POST /invoices/:id/revalidate`, which forces past the confidence gate. A late PO sync also
  re-validates every `EXCEPTION` invoice citing that PO number, so an invoice that arrived
  before its order clears itself. Verified live end to end for all of these.
- **Corrections are refused mid-approval** when the field feeds a validation check
  (409, `correctionBlockedByApproval`). Accepting one would leave the invoice showing variance
  measured against a PO it no longer cites while parked in a workflow branch chosen because of
  that variance; clearing the variance instead would make it read as clean in the not-clean
  branch. Fields that feed no check (dates, reference, tax id) stay correctable throughout.
- **Two outcomes, deliberately different** (see `runValidation`'s doc comment): *hard stops*
  (duplicate, PO not found, currency mismatch, over-receipt) park at `EXCEPTION` with no
  approval instance; *variances* record an exception **and still start the workflow**, because
  a price overrun is a decision someone is allowed to approve.
- **Variance-based approval routing, with no engine change** — variance is persisted to flat
  numeric columns (`priceVariancePct`, `quantityVariancePct`, `totalVarianceAmount`) precisely
  because `CONDITION` nodes evaluate a numeric column on the invoice row. A graph branching on
  `priceVariancePct > 5` therefore works through the existing evaluator. Verified live: a 15%
  price variance routed to the CONTROLLER while a clean invoice took the default edge to
  AP_MANAGER. `matchResult` (jsonb) carries the per-line detail and explanations.
- **Richer extraction** — `poNumber`, `referenceNumber`, `supplyDate` (delivery/service date,
  which governs tax treatment), `vendorTaxId`, `bankDetails`, persisted `documentType`, and
  per-line `taxCode`/`taxRate`. `vendorTaxId`/`bankDetails` are stored as *claimed on the
  document* and deliberately never written back to `vendors` — the difference between claim and
  master is the fraud signal.
  `fieldsNeedingReview` distinguishes required from optional fields, so an absent optional
  field (confidence 0.0 because it isn't on the document) no longer drags every non-PO invoice
  into review.
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
- **Upload / inbound** — `POST /invoices/upload` (multipart) stores the document to disk and
  hands it to the pipeline **by URL**, served back from `GET /files/:name`. An upload and a
  connector push therefore take an identical path with no second code path. This is what makes
  the vision route reachable without a developer; extraction itself is still the mock.
- **Simulated ERP posting** — `POST /invoices/:id/post` moves an APPROVED, fully-coded invoice
  to `POSTED` and stores a generated `erpDocumentNumber`. No ERP is contacted: a real connector
  replaces one method (`generateDocumentNumber`) and fills the same columns. Posting is
  terminal, and coding is frozen afterwards, because the ERP then holds the accounting document.
  `GET /posting/ready` and `GET /posting/posted` join the vendor name in, like every other list
  endpoint — they did not, so the posting screen's Vendor column read "—" on every row.
- **Cost assignment (GL coding)** — `glAccounts` and `costCenters` synced by code, per-line
  `glAccountId`/`costCenterId`, `PATCH /invoices/:id/lines/:lineId/code`, a coding queue, and
  suggestions derived from how this tenant coded the same vendor before (evidence-based, so the
  UI can show *why*). An invoice cannot post until every line is coded.
- **Approval visibility** — `GET /approvals/inbox/:approverId` (what is waiting on one person),
  `GET /approvals/history/:approverId` (their past decisions), and
  `GET /approvals/:invoiceId/progress`, which walks the graph forward to answer "how many more
  approvals does this need".
- **Dashboard** — `GET /dashboard`: counts and value by status, open exceptions by type, overdue
  approvals, touchless rate, and recent audit activity in one aggregate read.
- **Frontend** (`frontend/`, React + TS + Vite) — a single role-switched workspace. The design
  system is a tonal blue-slate palette (`#212A31` ground, `#2E3944` panels, `#124E66` petrol
  accent, `#748D92` muted text, `#D3D9D4` ink) with monospace on every value and label and
  per-field confidence shown as a ten-segment equalizer. The palette supplies no signal
  colours, so the four state colours are desaturated to sit in the same key rather than
  punching out of it — `--clear` sage, `--review` dusty gold, `--blocked` clay, `--inflight`
  petrol, plus a receding neutral for posted. All tokens live in `:root` of `index.css`;
  components reference them by name and hard-code no colour.
  Verified in a real browser: upload → code → approve → post ran end to end and produced ERP
  document 5106040049.
  - **Overview** — pipeline by status, open exceptions, overdue approvals, touchless rate, audit feed.
  - **Upload** — drag-and-drop inbound, showing each document's outcome immediately.
  - **Invoices** — filterable list with confidence and PO-match indicators and the ERP doc number.
  - **Invoice detail** — approval chain and progress meter, per-field confidence with inline
    correction, PO match table, line items with coding state.
  - **Review queue** — exceptions and low-confidence extractions with their suggested fixes.
  - **Cost assignment** — per-line GL/cost-centre coding with history-based suggestions.
  - **My approvals** — inbox with approve / reject / delegate, plus personal decision history.
  - **Posting** — ready-to-post list gated on coding, and everything already posted.
  - **Purchase orders** — orders, lines, goods-receipt entry, and a PO sync form.
- **Feedback effects** (`frontend/src/components/Effects.tsx`, styles at the end of `index.css`).
  Three pieces, all suppressed under `prefers-reduced-motion`:
  - **Arrival.** `useInboxWatch` (`lib/useInboxWatch.ts`) polls the acting user's queue every
    15s from the shell, so an invoice reaching them raises a toast wherever they are, plus a
    beacon on the sidebar item and a banner on the queue itself. It diffs **step ids**, not
    counts — a poll where one step is decided and another arrives leaves the count unchanged.
    Screens that change the queue call `notifyInboxChanged()` so the badge moves on the same
    tick instead of lagging up to 15s. This is the in-app half of the notification gap; it
    still only reaches someone with the tab open.
  - **The bulb.** `button.approve.bulb` breathes on a 2.4s cycle. Deliberately a breathe and
    not a blink — fast flashing is a seizure hazard — and it pauses on hover.
  - **The 3D lift.** A confirmation card that rises *out of the control you pressed*: the
    origin's `DOMRect` is captured at click time (`rectOf()`), and a Web Animation carries the
    card from that point at `translateZ(-420px) rotateX(62deg) scale(0.35)` up to rest, holds,
    then floats away. Fires on approve (sage), reject (clay), upload (tone follows the
    pipeline's verdict) and post (neutral, stamped with the ERP document number).
    Two things are load-bearing: the rect must be captured at click time, because the row is
    usually unmounted by the time the request resolves and a detached node measures all-zero;
    and easing is **per-keyframe** with the animation-level easing linear, because one
    aggressive ease-out across the whole thing collapses the rise into the first ~8% and the
    card just appears. Verified by scrubbing the animation in a real browser: at 250ms it is
    at scale 0.74 / z −162 / opacity 0.55, settled by 1700ms, gone by 2600ms.

## Not yet built (in rough priority order)
1. **One real extraction run.** The vision path in `extraction-service/main.py` fetches the
   document and calls Claude, and uploads now feed it a genuine URL — but no real PDF and no
   real `ANTHROPIC_API_KEY` has ever gone through it. Every result in this repo, including the
   screenshots, came from `mock_server.py`. Until this runs once, the extraction claims are
   unverified.
2. **Real auth** — SSO (Entra ID, Google), replace the `x-tenant-id` header hack **and** the
   workspace's "acting as" picker. This is also what makes the approver check real:
   `decideStep`/`delegateStep` verify the caller is the step's assigned approver, but against a
   **client-supplied** `approverId`. That stops wrong-user and accidental decisions; it is not
   authorization until the id comes from a session. `assertIsAssignedApprover` then reads the
   session subject — the check itself doesn't move. Same for `postedById`.
3. **A real ERP connector.** Posting is simulated: the document number is generated locally.
   `erpConnections` still stores config with no connector logic. Nothing pulls purchase orders,
   GL accounts, cost centres or vendors from an ERP either — all four are pushed in by hand.
4. **Notifying the next approver, outside the app.** In-app arrival is now covered — the
   workspace polls the acting user's queue and announces new items (see "Feedback effects").
   But that only reaches someone with the tab open: there is still no email, no push, no
   digest, and no server-side notification of any kind. The poll is also per-open-tab, which
   is fine for a prototype and is not how this should work at volume; the eventual answer is
   the server emitting an event when a step is created.
5. **Fraud risk scoring** — `Vendor.riskScore` field exists; nothing populates it.
6. **AI copilot** — natural-language invoice search, smarter GL coding suggestions (today's are
   frequency counts over this vendor's history, not a model call), plain-language explanations
   of why an invoice is stuck (`_consistency_warnings` is a natural input).
7. **Feedback loop** — `/feedback` on the extraction service is a stub; corrections should
   persist per tenant/vendor-layout and feed back into the prompt as few-shot examples.
8. **Vendor portal** — separate, simplified auth context and shell.

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

### Known gaps in PO matching / master data
- **There is no ERP connector behind the PO API.** POs have to be pushed in by whatever calls
  `POST /purchase-orders`; nothing pulls them from an ERP on a schedule, and `erpConnections`
  still has no connector logic. The endpoint is deliberately shaped so a connector can drive
  it idempotently, but that connector does not exist.
- **No PO is ever closed or cancelled.** There is no status on `purchaseOrders`, so a fully
  consumed or cancelled order still matches new invoices exactly as an open one does.
- **An in-flight invoice cannot be re-validated.** `approvalInstances.invoiceId` is UNIQUE and
  there is no supersede/recall model, so once an invoice is in an approval flow its match
  conclusions are frozen. The current answer is to refuse the correction (409) and tell the
  user to reject the invoice; a proper recall — cancel the instance, keep its audit trail,
  re-validate, start a fresh one — needs the unique constraint replaced with a
  current-instance concept.
- **Re-validation is not transactional.** It clears the match state, resolves exceptions, then
  re-runs validation as separate statements; a crash midway leaves the invoice with its old
  exceptions resolved and no new match.
- **Line pairing is exact-normalised-description then positional.** No fuzzy matching, no
  part-number matching (invoice lines have no part number field). Positional fallback will
  mis-pair a multi-line invoice whose ordering differs from the PO.
- **Tax is checked arithmetically, not against tax codes.** `taxCode`/`taxRate` are extracted
  and stored but nothing validates them, so `TAX_MISMATCH` is still unused. Only one header tax
  total is modelled — an invoice with several tax rates loses that breakdown.
- **`vendorTaxId` and `bankDetails` are captured but not compared** against `vendors.taxId` /
  `vendors.bankDetails`, which are still never populated. The data needed for `FRAUD_RISK` is
  now there; the comparison is not written.
- **Partial and repeat billing against one PO is not tracked.** Matching compares each invoice
  against the full PO independently, so two invoices each billing half an order both look like
  50% under-billings, and billing the same PO twice in full is not detected as over-consumption.
- **No credit-note handling.** `documentType` is stored but not acted on; a CREDIT_NOTE is
  matched as though it were an invoice.
- **Variance invoices do not appear in the review queue.** The queue filters on *status*, and a
  variance invoice deliberately sits at `PENDING_APPROVAL`, so an open `PO_MISMATCH` is only
  visible on the detail screen. An "open exceptions" view independent of status is missing.

### Known gaps in upload, coding and posting
- **Uploaded files are served unauthenticated.** `GET /files/:name` takes no tenant header,
  because the extraction service fetches it as an anonymous client. Names are unguessable
  UUIDs, which is adequate for a prototype and **not** adequate for production — invoice PDFs
  are confidential and want signed, expiring URLs.
- **Files are stored on local disk** (`backend/uploads/`), so the API is no longer stateless and
  a second replica would not see the first's uploads. Swap `FileStorageService` for S3/blob.
- **Posting does not contact anything.** The `erpDocumentNumber` is generated locally and looks
  real; the UI says so on screen, but nothing enforces that a reader knows it is simulated.
- **No credit notes or reversals.** Posting is terminal by design, so the only correct response
  to a posted-in-error invoice is an ERP-side reversal — which this tool cannot request.
- **Coding has no rules or defaults.** Suggestions are frequency counts over the same vendor's
  previous lines; there is no rule engine, no per-category default, no split coding (one line to
  several cost centres), and no budget or authorisation check against the cost centre owner.
- **`costCenters.ownerId` is captured but unused.** It is the natural approver for non-PO spend,
  which is exactly the dynamic approver type the workflow engine still lacks.

### Known gaps in the frontend
- **No tests at all.** Verified by driving a real browser against the running API, not by
  anything repeatable. No component tests, no e2e suite. This is now the largest untested
  surface in the repo: ~2,600 lines of UI against 97 backend unit tests.
- **Identity is picked, not authenticated.** Both the tenant field and the "acting as" role
  switcher are prototype affordances to be deleted when SSO lands, not adapted.
- **No way to resolve an exception from the UI.** `invoiceExceptions.resolvedAt` is only ever
  set automatically by re-validation; a human cannot dismiss one.
- **Duplicated constants.** `CONFIDENCE_REVIEW_THRESHOLD`, the correctable-field list and
  the field labels are restated in `frontend/src/lib/confidence.ts`. The backend stays
  authoritative (it returns `lowConfidenceFields` and rejects non-allowlisted fields), but
  the copies can drift out of sync with no test to catch it.
- **No pagination, filtering, or sorting** on the invoice list — it renders every invoice
  the tenant has in one table.
- **Purchase orders are API-only in the UI.** The detail screen shows the *match* against a PO,
  but there is no screen to list, inspect or create purchase orders and no way to record a
  goods receipt from the frontend — those go through `POST /purchase-orders` and
  `/receipts` by hand.
- **Nothing surfaces the re-validate action.** `POST /invoices/:id/revalidate` exists (the only
  route out for an invoice held by a low-confidence *line item*, since line items still aren't
  correctable) but no button calls it, and the 409 refusal on a mid-approval correction has no
  UI affordance explaining it.
- **`vendorName` is shown with a confidence score but is not editable**, because correcting
  it means re-linking a `Vendor` row rather than writing a column. It's the one field on the
  detail screen with a confidence and no Edit affordance.
- **Vendor matching is exact-name.** `resolveVendor()` does no normalisation, so
  "Acme Inc." and "Acme, Inc" become two vendors — and duplicate detection, which keys on
  `vendorId`, won't see invoices from those two as related.

### Inbound is still one endpoint
`POST /invoices` with a `fileUrl` is the only way in. `sourceChannel` accepts EMAIL/PORTAL/
MOBILE/etc. but it is **just a label the caller passes** — there is no mailbox listener, no
vendor portal, no upload screen. The extraction service does fetch the URL and base64 it for
Claude vision (`main.py`), so the real path is coded, but it has only ever been exercised
against `mock_server.py`: no real PDF and no real `ANTHROPIC_API_KEY` has been through it.

## Conventions
- Tenant ID always comes first in service method signatures: `(tenantId, ...)`.
- Every state-changing action should write an `AuditEvent` — see `logAudit()` pattern
  in `invoices.service.ts`.
- Money fields are `numeric(18,2)` in Postgres / passed as strings to Drizzle inserts
  (avoid floating point on currency amounts).
- New Nest modules follow the standard controller/service/dto split already established
  in `src/invoices/`.
