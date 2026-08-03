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

**The short way** — everything in one command:
```bash
docker compose up --build
docker compose run --rm backend npm run db:seed   # prints the tenant id the UI needs
```
⚠️ **The compose file and the three Dockerfiles have still never been built.** What is now
known, after actually trying rather than assuming:

- A Docker daemon **can** be started here (`dockerd` runs; the CLI reaches it, storage driver
  overlayfs). The old note that this sandbox had "the CLI but no daemon" was only half right.
- The blocker is the **network policy**, not Docker. `registry-1.docker.io` answers, but the
  blob CDN `production.cloudfront.docker.com` is **403 policy-denied at the proxy gateway**, so
  no base image (`node:22-alpine`, `python:3.11-slim`, `postgres:16-alpine`) can be pulled and
  no build can start. Confirmed via `curl "$HTTPS_PROXY/__agentproxy/status"`, which logs the
  denials. This is not something to work around — do not disable TLS verification or bypass the
  proxy to chase it.

What *has* been verified statically, which is more than nothing and less than a build:
`docker compose config` validates — the file parses, every service/volume/build-context
reference resolves, no undefined variables, and the `depends_on` health conditions are
well-formed. All three Dockerfiles were read against known project gotchas: they use `ts-node`
rather than `tsx` (see above), and **all three `.dockerignore` files exist** and exclude
`node_modules`/`.venv`/`uploads`, so the classic "`COPY . .` clobbers the freshly installed
dependency tree with the host's" bug is already handled.

**Treat compose as reviewed-but-unbuilt.** Anyone on an unrestricted network should run
`docker compose up --build` once and replace this note with the result.

**The long way**, which is what every check in this repo has actually run against:
```bash
# 1. Postgres (adjust for your OS/package manager)
createdb invoice_platform

# 2. Backend
cd backend
npm install
export DATABASE_URL="postgresql://postgres:<password>@localhost:5432/invoice_platform"
export EXTRACTION_SERVICE_URL="http://localhost:8001"
npx drizzle-kit push --force   # applies schema — see src/db/schema.ts
# On a database that predates the supersede model, run this FIRST instead: `push` cannot swap
# a UNIQUE constraint for a partial index, and stops to ask whether is_active -> status is a
# rename. A fresh database needs neither.
#   psql "$DATABASE_URL" -f drizzle/0001_supersede_model.sql
npm run db:seed                # tenants, users, GL/cost centres, PO-5000, workflow definitions
# Authentication is required and fails closed: with neither OIDC_ISSUER nor AUTH_DEV_ISSUER
# the process refuses to start rather than serving an unauthenticated API.
AUTH_DEV_ISSUER=true npx ts-node src/main.ts        # NOT npx tsx

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
#     `npm run db:seed` creates it — don't hand-POST it any more.
.venv/bin/python -m uvicorn mock_server:app --port 8001

# 4. Frontend (separate terminal)
cd frontend
npm install
npm run dev        # http://localhost:5173
```

**Sign in** at http://localhost:5173 with a seeded email — `alice@acme.test` (AP_CLERK),
`manager1@acme.test` / `manager2@acme.test` (AP_MANAGER), `controller1@acme.test`,
`approver1@acme.test` (APPROVER) or `admin@acme.test` (ADMIN — configures, cannot approve). The
development issuer mints a real RS256 token for that address and the API verifies it through
exactly the same path a production IdP's token takes. There is no tenant field and no
"acting as" picker any more: tenant, user and role all come from the token's user row.

An account must already exist — a valid token for an unknown email is refused, deliberately
(see "no just-in-time provisioning" below).

## Tests

```bash
cd backend && npm test               # 266 unit tests — no DB, no server
cd backend && npm run test:integration   # 96 integration tests — needs DATABASE_URL
cd extraction-service && .venv/bin/python -m pytest -q   # 19 tests
cd frontend && npm run build         # typecheck + build; there are no frontend tests
```

`test:integration` derives its database by appending `_test` to `DATABASE_URL`'s database
name, creates it if absent, pushes the schema with the same `drizzle-kit push` used
everywhere else, and truncates every table between tests — so it can never touch a
development database, and it **empties whatever it points at**. With no `DATABASE_URL` the
suites skip cleanly rather than fail, which is what keeps `npm test` DB-free.

Test files run in separate processes concurrently by default, and they share one test
database, so integration runs are pinned to `--test-concurrency=1`. Without it the files
truncate each other mid-run and everything fails at once.

**CI is real.** `.github/workflows/ci.yml` has run **10 times on GitHub's runners, all green**,
most recently against `9bc43a7`. It fires on every push and runs four jobs: typecheck, 266 unit
tests, 96 integration tests against a real `postgres:16-alpine` service container, 19 Python
tests, and the frontend build. So the suites are proven to pass on a clean machine from
scratch, not just on a developer's warm one. (This entry previously said the workflow had never
executed. That was true when written and stayed in the file long after it stopped being true —
check the Actions tab before repeating a claim like this.)

⚠️ **CI passing is not evidence for `docker-compose.yml`.** The workflow contains zero
references to compose or any Dockerfile — it uses a service container and runs commands
directly on the runner. See below.

## Testing inbound mail

```bash
sudo apt-get install -y dovecot-imapd
sudo scripts/dev-mailbox.sh start                    # IMAP on 127.0.0.1:10143
scripts/dev-mailbox.sh deliver some-invoice.pdf      # + an image001.png, as a real mailbox has
INBOUND_IMAP_HOST=127.0.0.1 INBOUND_IMAP_PORT=10143 INBOUND_IMAP_SECURE=false \
INBOUND_IMAP_USER=ap@test.local INBOUND_IMAP_PASSWORD=testpass \
INBOUND_TENANT_ID=<tenant> npx ts-node src/main.ts
```

A local server is the right default for development: no secrets, works offline, and you
control exactly which messages exist. `backend/scratch/imap-smoke.ts` and
`backend/scratch/imap-e2e.ts` drive it directly; neither is part of the suite, because CI has
no mail server.

**Using a real provider instead**, when provider-specific behaviour is what you need to test:

- **Gmail** works with `imap.gmail.com:993`, but *not* with the account password. It needs
  2-Step Verification enabled and a 16-character **App Password**, and IMAP switched on in
  Gmail settings. Treat that password as a real credential — never commit it, and never put
  it in `.env.example`.
- **Microsoft 365 does not work this way at all.** Basic authentication for IMAP was disabled
  across Exchange Online in 2022, so a username and password will simply be refused no matter
  how it is configured. It requires OAuth2 with a registered Entra ID application. Since most
  corporate AP mailboxes are on Microsoft 365, **a production connector will need OAuth2**,
  and `ImapMailboxSource`'s password-based config is a development affordance rather than the
  eventual shape.
- Disposable inbox services (Mailinator, Mailsac) mostly put IMAP behind a paid tier; their
  free tiers are HTTP-only and will not exercise this code path.

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
   the arithmetic doesn't hold regardless of what the model claimed.
   This entry previously claimed the check was unit-tested. It was not — it had been verified
   interactively in an earlier session and never committed as a test, so nothing in the repo
   would have caught a regression in the single most important piece of logic in the
   extraction service. `extraction-service/test_consistency.py` now covers it (19 tests):
   both checks, the rounding tolerance boundary, `min()` never *raising* an already-low
   confidence, and unparseable/missing amounts leaving the pass inert rather than crashing
   ingestion.
   Note this check is Python-side, so the backend's own suite cannot reach it: the TypeScript
   integration tests stub the extractor and therefore test the *confidence gate*, not the
   arithmetic that feeds it. Both halves are needed.

3. **Workflow is a graph (`workflowDefinitions.graph` jsonb: `{nodes, edges}`), not a
   fixed N-level chain.** This is the anti-rigidity design — a visual builder sits on
   top, but power users can drop into raw graph/expression editing when a wizard runs
   out of road. The engine that evaluates this at runtime is **built** — see
   `src/workflow/` and the graph contract below.

3. **Every table is tenant-scoped from day one** (`tenantId` FK on nearly everything), and
   **the tenant is derived from the authenticated user's row, never from the request.** This
   used to be an `x-tenant-id` header; that is gone. A client cannot name a tenant, a user or
   a role anywhere in the API surface. See "Authentication" below.

4. **ERP integration is an overlay, not a replacement.** `ErpConnection` stores
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
  246 tests covering `resolveNodeOutcome`, `evaluateCondition`, `validateGraph`, the PO matching
  functions (`matchInvoiceToPo`, `pairLines`, `variancePct`, `resolveTolerances`),
  `validatePoPayload`, the re-validation rules (`revalidationDecision`,
  `correctionBlockedByApproval`), the fixture drift guard, vendor-name normalisation, the
  inbound attachment decision, locale-aware date/money parsing, and the S/4HANA mappers
  (OData wire format, auth, supplier invoice, purchase order, goods receipt), and the
  auth token verifier and identity-linking decision table.
- **Email inbound** (`src/inbound/`) — the channel that makes "touchless" true at the front
  door. Until this, an invoice entered because a person dragged a PDF into a browser, which
  meant a human touched every document at the exact moment we claimed not to need one; in real
  AP the great majority arrive at an `ap@` mailbox.
  Each accepted attachment is stored and handed to the pipeline **by URL** — the same path an
  upload or a connector push takes, so there is no second ingestion route to keep in step.
  - **Ordering is deliberate**: store and ingest first, record the message second, mark it read
    last. A crash therefore produces a duplicate *attempt*, absorbed by the unique key on
    `(tenantId, messageId)` — whereas marking read first would lose a supplier's invoice
    outright. Retrying beats losing.
  - `decideAttachments()` is pure and tested: takes PDF/PNG/JPEG/WebP, skips Office documents,
    and skips Outlook signature images **by filename pattern rather than size**, so a
    genuinely tiny scan is not thrown away with the logos. Every skip is recorded with a
    reason — an operator asking "where is my invoice?" needs to see it arrived and why nothing
    came of it.
  - `GET /inbound/messages`, `POST /inbound/poll` (sweep now), a 5-minute cron, and an
    "Arrived by email" panel on the Upload screen.
  - **The IMAP transport has now been run against a real server.** A local Dovecot was stood
    up, three realistic messages delivered (a genuine invoice PDF; an invoice plus an Outlook
    signature image plus a .docx; a reply with no attachment), and the full path exercised:
    3 messages fetched → 2 invoices created → the signature image and Office document skipped
    with reasons → the bare reply recorded as `no-attachments` → **a second poll fetched 0**,
    proving `\Seen` and the dedupe key both hold. Reproduce it with
    `scripts/dev-mailbox.sh` (see "Testing inbound mail" below).
  - Logic is additionally covered by 8 integration tests against a fake mailbox, using the
    real Arena Media PDF bytes and asserting byte-for-byte storage.
  - Config is per-process (`INBOUND_IMAP_*`) and belongs in per-tenant config with the
    password in a secret store; that arrives with the config plane.
- **Vendor identity is a normalised key, not the printed name** (`src/vendors/vendor-name.ts`).
  This was a money bug: duplicate detection gates on `vendorId`, so a supplier fragmented
  across spellings silently disabled it and the same invoice could be paid twice. The live
  database already had it — "Arena Media Comunicaciones Espana, S.A." and
  "…España, S.A." were two rows for one company.
  `normaliseVendorName()` strips accents, case, punctuation, dotted abbreviations (`S.A.` →
  `sa`) and trailing legal forms, and uniqueness moved to `(tenantId, normalisedName)`.
  Deliberately **not** fuzzy matching — "Acme Supplies" and "Acme Supply Co" stay separate,
  because merging two real suppliers points payments at the wrong bank account. Aggressive on
  noise, conservative on meaning.
  `drizzle/0002_vendor_normalisation.sql` backfills *and merges*: it repoints invoices and
  POs at one winning row per key before deleting the losers. Verified on the live database —
  three fragments merged into one, the invoice repointed, zero orphans.
- **Locale-correct field parsing** (`parseDateOrThrow`, `parseMoneyOrThrow`) — found by the
  first two real invoices, both of which the previous parsers got wrong:
  - `new Date('04/05/2026')` returned **5 April** for a Spanish invoice dated **4 May**. Wrong
    by a month, silently. On the same document the due date `03/06/2026` (3 June) became
    6 March — *before* the invoice date, so it would read as long overdue and drive a wrong
    payment run. And `23/01/2026` threw a 400, because there is no month 23. Roughly half the
    year corrupted silently and the other half failed loudly.
    Now: ISO first, then day-first `DD/MM/YYYY`, impossible dates rejected rather than rolled
    over, and `new Date()` never allowed to guess. **Day-first is a deliberate locale choice**
    that belongs in per-tenant config before the first US customer.
  - `parseMoneyOrThrow` accepted only `1234.56`, so `10.000,00` and `800,00` — the amounts as
    printed on both invoices — were rejected outright. Worse, `1.50` was read as one-and-a-half
    when a European operator typing what the document shows for one thousand five hundred
    means `1.500`: a silent factor-of-1000 error on a money field. Now both conventions parse
    (last separator wins), and genuinely ambiguous input like `1.500` is **refused** rather
    than guessed.
  - `GET /files/:name` served a real PDF with **no `Content-Type`** — the extraction service
    would have had to guess from the extension before a vision call that must declare a media
    type. Now set from the stored name, plus `Cache-Control: private, no-store`.
- **Developer plane (Phase 0)** — the first automated checks this repo has had, and the first
  way to stand it up that isn't "a developer with psql access".
  - **`npm run db:seed`** (`src/db/seed.ts`) — tenants, users, GL accounts, cost centres,
    PO-5000/PO-6000 and the three workflow definitions. Idempotent by natural key (tenants by
    name, users by **email**, POs by `poNumber`, definitions by name), so re-running updates
    rather than duplicating and never touches transactional rows. Changing a seed email does
    not rename a user — it creates a second one and orphans the existing approval history.
    ⚠️ **That idempotence does not survive a database whose workflow definitions have been
    published or retired through the API.** Re-seeding then tries to set a definition
    `PUBLISHED` while another already is, and the partial unique index
    `workflow_one_published_per_tenant` refuses — `db:seed` dies part-way. Reproduced on
    unmodified code, so it is not a regression from anything recent; a *fresh* database
    (the documented path, and what CI exercises) is unaffected. The fix is for the seed to
    retire the incumbent in the same transaction, exactly as `publishDefinition` does.
    **Not yet fixed.**
  - **Integration harness** (`src/test-support/db.ts`) — derives a `_test` database from
    `DATABASE_URL`, creates it, pushes the schema, truncates every table between tests.
    Truncate rather than transaction-rollback because the services hold `DatabaseService.db`
    directly; rolling back would mean threading a transaction handle through every service
    signature, which is production code changed in service of tests.
  - **`src/test-support/services.ts`** wires the real services by hand — they are plain
    classes with constructor injection, so `@nestjs/testing` buys nothing. Only the extractor
    is stubbed; matching, workflow traversal, coding, posting and the audit trail are all
    production code against real Postgres.
  - **66 integration tests** (`*.int-spec.ts`) over the paths that were previously
    hand-verified only: the nine ingestion scenarios end to end, net-vs-net PO comparison,
    duplicate detection, late-PO re-validation, workflow traversal, ALL/ANY node semantics,
    sibling skipping, delegation not deadlocking an ALL node, SLA inheritance on handoff, the
    approver check, tenant isolation on both reads and PO matching, the supersede/recall
    lifecycle, and definition versioning. One is still labelled `DOCUMENTS:` — it asserts
    *current* behaviour for the known double-advance race, so the gap is measured rather than
    remembered. (The second such test, for the UNIQUE-instance constraint, became a real
    assertion when supersede landed.)
  - **Scenario fixtures** (`src/test-support/fixtures.ts`) — the nine mock documents as typed
    TypeScript. They exist twice (here and in `mock_server.py`) because the Python one drives
    the live system and the frontend; `fixtures.spec.ts` parses the Python source and fails if
    the scenario names or invoice numbers drift, and also asserts every fixture is
    arithmetically self-consistent except the one that must not be. Verified the guard bites
    by breaking a number and watching it fail.
  - **`extraction-service/test_consistency.py`** — 19 tests for the arithmetic pass, which had
    none (see design decision 2).
  - **`.github/workflows/ci.yml`** — now green on GitHub's runners on every push (10 runs).
    **`docker-compose.yml`** and the three Dockerfiles remain built-never, blocked on the image
    registry rather than on Docker. See "How to run locally".
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
- **Supersede / recall, and workflow definition versioning.** Two problems with one answer.
  - `approvalInstances.invoiceId` is no longer UNIQUE. An invoice accumulates one instance per
    attempt, and a **partial unique index** — `UNIQUE (invoice_id) WHERE status = 'ACTIVE'` —
    keeps at most one live. The invariant is enforced by the database, so a buggy path or two
    concurrent requests cannot produce two live instances; a careless second `startInstance()`
    still fails, exactly as it did under the old constraint.
  - `recallInstance()` marks the live instance `SUPERSEDED`, cancels its `PENDING` steps
    (`CANCELLED`, distinct from `SKIPPED` — "the question was withdrawn" vs "someone else
    answered"), and records a reason. `restartInstance()` then starts a fresh one and sets
    `supersededByInstanceId`, so `GET /approvals/:invoiceId` returns an `attempts` chain.
  - **Every approval already cast is discarded.** Prior steps stay visible as history but
    nothing carries forward. A recall happens because the figures the approvers saw have
    changed, and an approval given against different numbers is not an approval of these ones.
  - **Definitions are immutable once published.** `POST /workflow-definitions` creates a
    `DRAFT` at the next version for that name; `POST /:id/publish` retires the prior published
    row and publishes this one **in one transaction**. Because `approvalInstances.workflowId`
    references a definition *row*, an in-flight instance keeps evaluating the graph it started
    under — with no per-instance graph snapshot and no change to instance storage. Retired
    definitions are never deleted, because live instances still point at them. A partial unique
    index allows only one `PUBLISHED` definition per tenant.
  - Verified through the HTTP API, not only in tests: a 15% price-variance invoice parked at
    the controller, its PO corrected mid-approval (previously a 409), superseded and re-routed;
    then its definition retired under it and the approval still walked the *old* graph to
    APPROVED while a new invoice took the newly published one.
- **Corrections mid-approval now recall instead of refusing.** A correction to a
  check-feeding field withdraws the running instance, re-validates, and starts a fresh one.
  What is still refused (409, `correctionBlockedByPosting`) is a **posted** invoice: the ERP
  holds the accounting document, so the answer there is a credit note or an ERP-side reversal.
  Fields that feed no check (dates, reference, tax id) stay correctable throughout, even after
  posting.
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

## Authentication (Phase 1 — complete)

**`x-tenant-id` is gone.** There is no header, no query parameter and no body field by which a
caller can name a tenant, a user or a role. Every request carries an OIDC bearer token; the
guard verifies it, resolves it to a `users` row, and everything downstream reads tenant and
actor from that row. Verified live: the exact request that used to return a tenant's invoices
— `curl -H "x-tenant-id: <uuid>" /invoices` — now returns **401**, and a *valid* token
presented with a forged `x-tenant-id` for another tenant returns that caller's own data,
not the named tenant's.

**Deny by default.** `AuthGuard` is an `APP_GUARD`, so it covers every route including ones
added later. Forgetting to annotate a new endpoint leaves it **closed**; opening one requires
writing `@Public()` deliberately. That direction is the whole point — the previous arrangement
failed open and an unprotected endpoint looked identical to a protected one.

**Fails closed at startup, twice.** With neither `OIDC_ISSUER` nor `AUTH_DEV_ISSUER` the
process refuses to boot rather than serving an unauthenticated API; and `AUTH_DEV_ISSUER=true`
with `NODE_ENV=production` throws during construction, because the dev issuer mints valid
tokens for any email on request. Both verified by running them.

### The pieces
- **`jwt-verifier.ts`** — JWKS signature check, issuer *and* audience required, asymmetric-only
  algorithm pin, bounded clock skew, `email_verified` read strictly.
- **`identity-link.ts`** — the decision table (subject is the identity key; email links only on
  first login and only when verified; never re-link a claimed account; ambiguous email across
  tenants refused; **no just-in-time provisioning**).
- **`auth.service.ts`** — lookup and first-login binding, with `WHERE sso_subject IS NULL` so a
  concurrent second binding is refused rather than overwriting the first.
- **`auth.guard.ts` + `@CurrentUser()`** — the guard, and the decorator that replaced 39
  `@Headers('x-tenant-id')` parameters. `@CurrentUser()` **throws** rather than yielding
  undefined on a `@Public()` route, because the quiet form of that mistake is `tenantId`
  becoming undefined and a query then matching every tenant's rows.
- **`dev-issuer.ts`** — a real local OIDC issuer (discovery document, JWKS, RS256 signing), so
  development exercises the *same* verification path as production. Deliberately **not** a
  bypass branch in the guard: a `if (dev) skipAuth()` leaves the real path untested until the
  first IdP is connected, which is the worst moment to find out it is wrong.

### The actor now comes from the session
`decideStep`, `delegateStep` and `post` used to take the actor from the request body, so the
"is this the assigned approver?" check compared a value the caller chose against one the caller
could look up. It stopped mistakes, not people. Now:
- `DecideStepDto` has **no** `approverId` field at all, and `forbidNonWhitelisted` rejects a
  request that still sends one — verified: **400**, not silently ignored.
- Approving someone else's step returns **403**, verified live with two real tokens.
- `DelegateStepDto` carries only the recipient. A handoff you can perform on someone else's
  behalf is not a handoff.
- `GET /approvals/inbox/:approverId` **was an IDOR** — any authenticated user could read any
  colleague's queue by changing the id. The routes are now `/approvals/inbox` and
  `/approvals/history`, session-scoped, with no id to enumerate.
- `postedById` is the session, closing the last place a client could write a false actor into
  an irreversible record.

### Frontend
The tenant field and the "acting as" role picker are **deleted**, not hidden — both were
client-asserted identity. The shell shows "Signed in as / Role" read from `GET /auth/me`, plus
sign-out. Verified in a real browser: sign in as `manager1@acme.test` → dashboard renders with
role `AP_MANAGER` from the server, zero tenant inputs, zero selects, sign-out returns to the
sign-in screen, no console errors.

The token is kept in `localStorage`, which is the pragmatic choice for a dev-issuer flow and
**not** what a production build should do — an httpOnly cookie or in-memory token with silent
refresh both survive XSS better.

## Role-based authorization (the permission matrix)

Roles were stored on `users` from day one and used by the workflow engine for `ROLE`-typed
approver nodes, but **nothing ever checked them for access**. They do now.

**Two different concepts, deliberately kept apart.** A *permission role* is what you may do;
an *approval position* ("approver 1", "final approval") is where you sit in a chain. The
second is not a role — it is a node in the workflow graph, and modelling it as a role is how
AP systems end up with sixty roles nobody can audit. The five roles below are the whole set
and no more should be added for approval levels.

| Role | Does | Explicitly cannot |
|---|---|---|
| `AP_CLERK` | ingest, correct, code, read | approve, post, configure |
| `APPROVER` | decide/delegate their own steps | list invoices, code, post, configure |
| `AP_MANAGER` | everything a clerk does + approve, post, recall, ops | configure |
| `CONTROLLER` | approve, post, recall, read everything | ingest, ops |
| `ADMIN` | users, workflow definitions, GL/cost-centre master | **approve, post, ingest, code** |

**`ADMIN` cannot transact, and that is the point of the role.** Whoever decides who may
approve a payment must not also be able to approve one; a single account that could do both
would make every other control here decorative. The cost is that a tenant needs at least two
people.

**`@Roles()` + a check inside `AuthGuard`.** In the same guard as authentication rather than a
second one, so there is no registration order in which a role check could run against a
principal that was never established. Absent `@Roles()` means "any authenticated user of the
tenant", which is correct only for routes already scoped to the caller (`/auth/me`,
`/approvals/inbox`).

**Two rules the matrix could not express**, because they depend on the record rather than the
route — both live in the service, where the record is in hand:
- **An `APPROVER` may read only invoices they hold or held a step on.** They are frequently a
  line manager outside AP; being asked to approve one payment is not a reason to see the
  company's invoice book. Returns 404 rather than 403, because a distinct 403 would confirm
  the invoice exists — which is the fact being withheld.
- **An `AP_CLERK` may not correct a check-feeding field while an approval is running**
  (`correctionBlockedByRole`). Correcting extraction is their job, but such a correction now
  recalls the instance and **discards every approval already cast**; a clerk should not undo a
  controller's decision as a side effect of fixing a typo. Gated on *state*, not on the field
  list — before an approval starts, a clerk may correct anything.

**User administration** — `GET|POST /admin/users`, `PATCH /admin/users/:id`, `ADMIN` only.
No passwords (accounts are shells an OIDC identity binds to) and **no delete**, because
`approvalSteps.approverId` and `invoices.postedById` reference the row: deleting a leaver
would destroy the record of who approved a payment. Deactivation instead, via
`users.isActive` (`drizzle/0004_user_deactivation.sql`).

**Deactivation revokes immediately, including tokens already issued** — verified live. The
user row is read on every request rather than trusted from the token, so an existing bearer
token for a deactivated account returns 401 on its next call. Without the check in
`decideLink` this would have been cosmetic: a leaver's IdP account can keep minting valid
tokens for months, and their subject is already bound, so every request would take the happy
path.

Two lockout guards on `PATCH /admin/users/:id`: an admin cannot remove their own admin rights
or deactivate themselves, and the **last** active admin cannot be demoted or disabled. Either
would strand a tenant outside its own configuration with no route back in through the product.

**The matrix is tested as data** (`rbac.int-spec.ts`): one row per route listing who may reach
it, asserted in *both* directions against a running application. A matrix that only checks the
allowed cases proves nothing — the interesting failure is a role reaching something it should
not. Mutation-checked: disabling the guard's role check fails 19 tests.

**The frontend hides navigation a role cannot use, and that is not a security boundary.** The
server returns 403 regardless; the mirror in `App.tsx` only avoids showing people doors that
will not open. Drift produces a visible 403, never unauthorised access.

### Known gaps in authorization
- **No Chart of Authority.** Approval *limits* are still expressed as CONDITION nodes on
  amount inside the graph, so changing one person's spending authority means editing a
  published workflow definition. A COA table (per-user limits by document type, company code,
  cost centre, validity window) is the next piece; the agreed shape is enforcement-first —
  check the decider's limit in `decideStep` — because that closes the delegation hole where a
  manager hands a €40k invoice to a junior with a €5k limit.
- **`POST /purchase-orders` is `AP_MANAGER`/`ADMIN` as an interim.** It is shaped for an ERP
  connector to replay idempotently, so it really wants a **service identity**, which does not
  exist yet.
- **No per-record scoping beyond the two rules above.** A clerk can see every invoice in the
  tenant; there is no cost-centre or company-code partitioning of visibility.

### Known gaps in auth
- **`GET /files/:name` is deliberately `@Public()`** and is now the weakest point in the
  system. The extraction service fetches documents as an anonymous HTTP client, so a bearer
  token cannot be required there; an unguessable UUID is all that protects a confidential
  invoice PDF. The answer is **signed, expiring URLs** (or handing the extractor bytes over an
  authenticated internal channel), not a token on this route.
- ~~**No role-based authorisation yet.**~~ Built — see "Role-based authorization" above.
  Recall/re-validate is now `AP_MANAGER`/`CONTROLLER` only.
- **No refresh-token flow, no logout at the IdP.** Signing out clears the local token only.
- **One issuer per deployment.** `resolveAuthConfig` reads a single `OIDC_ISSUER`. Per-tenant
  issuers — which real multi-tenant SaaS needs — would key the verifier by tenant. The schema
  is ready for it (`users.ssoIssuer` is stored and matched), the wiring is not.
- **`@nestjs/testing` is now a dev dependency.** The repo previously avoided it on the grounds
  that plain classes need no test framework, which was right for services; booting an HTTP app
  with a global guard is the case it earns.

## ERP connector (S/4HANA Cloud Public Edition)

`src/erp/` — the connector contract plus the S/4HANA implementation. **Nothing has ever
called SAP**: no tenant, no sandbox for this API, and SAP domains are unreachable from the
build environment. What exists is built against the **real** OData specifications, checked in
at `src/erp/s4hana/spec/`: `API_SUPPLIERINVOICE_PROCESS_SRV` v1.5.0,
`API_PURCHASEORDER_PROCESS_SRV` v1.0.0, `API_MATERIAL_DOCUMENT_SRV` v1.5.0.

**All three mappers are pure functions with no caller.** They are tested against the specs and
correct as far as a spec can make them, but nothing in `src/` invokes them: there is no HTTP
client, no sync job, no credential plumbing, and `erpConnections` still has zero code
references. The mapping is the part that needed a specification to get right; the transport is
the part that needs a tenant. Read them as "the hard half is done and unverified against a live
system", not as a working connector.

(Note: `CST_MaterialDocument` — SAP's Data Ingestion service — was ruled out deliberately. It
is the wrong product and the wrong direction: it ingests *into* SAP's data platform rather than
reading goods receipts *out of* S/4HANA.)

- **The contract is deliberately narrow.** Flowap is an overlay, so a connector only pulls
  master data and pushes one document. `postInvoice` is optional, because a **read-only**
  connector is a legitimate first deliverable — it makes matching real against actual
  procurement data while being incapable of changing anything in a customer's system.
- **Park and post are separate calls, natively.** `POST /A_SupplierInvoice` does not accept
  `SupplierInvoice` or `FiscalYear` (SAP assigns them), and there is a distinct
  `POST /Post?SupplierInvoice=…&FiscalYear=…`. Creating without posting is therefore how the
  API is designed, not a workaround — and it is the right first go-live posture, since a
  wrongly parked document is a nuisance and a wrongly posted one is a journal entry to reverse.
- **`FiscalYear` is mandatory to post**, so `invoices.erpDocumentNumber` alone is not enough:
  an SAP document number is only unique within company code *and* fiscal year.
- **Field lengths are enforced, never truncated** (`S4_FIELD_LIMITS`, taken from the spec).
  `SupplierInvoiceIDByInvcgParty` is 16 characters; silently trimming an invoice number would
  produce a document that reconciles against nothing and defeats SAP's own duplicate check.
  `TaxCode` is **2** characters, so the code printed on a document can never pass through —
  it always needs a per-tenant mapping.
- **OData V2 wire format is handled explicitly** (`s4-odata.ts`): dates arrive as
  `/Date(1748563200000)/` which `new Date()` turns into Invalid Date; decimals arrive as
  strings on purpose and must not become floats; collections are `{ d: { results: [] } }`.
  Malformed responses return null or an empty array rather than throwing, so one odd payload
  cannot kill a sync job.
- **Auth is an interface** (`s4-auth.ts`): `ApiKeyAuth` for the Hub sandbox, `BasicAuth` for a
  communication user, `OAuth2ClientCredentialsAuth` for a real Cloud tenant. The token
  refreshes 60s before expiry — a token expiring mid-*posting* yields a 401, and retrying a
  posting is how duplicate accounting documents get created.

- **The purchase order mapping found three things that change matching** (`s4-purchase-order.ts`,
  built against `API_PURCHASEORDER_PROCESS_SRV` v1.0.0):
  - **There is no line net amount.** SAP gives `NetPriceAmount` *and* `NetPriceQuantity` — the
    price is quoted *per N units*. A line priced "12.00 per 100" with 500 ordered is 60.00, not
    6,000.00. Multiplying quantity by price is the obvious reading and is wrong by a factor of
    the price unit — the same shape as the gross-vs-net bug, and it would produce phantom
    variance on every matched invoice.
  - **`GoodsReceiptIsExpected` says whether the third way applies at all.** Not every line is
    receipt-controlled; raising `GRN_MISMATCH` against a service line that never expected a
    receipt would block a correct invoice.
  - **`IsFinallyInvoiced` and `PurchasingDocumentDeletionCode` give us PO status**, which
    Flowap has never had — see the "no PO is ever closed or cancelled" gap below. Deleted lines
    and deleted orders are now dropped rather than matched.
  Header totals are summed from the lines, since the service exposes no header net, which keeps
  `validatePoPayload`'s invariant true by construction.
- Writing those tests found a genuine bug in `odataCollection`: the `d` envelope appears **only
  at the response root**, so a nested `$expand` arrives as a bare `{ results: [...] }`. Missing
  it yielded zero line items on every expanded read — a PO syncing with a correct header and no
  lines, which reads as a data problem rather than a parsing one.

- **Goods receipts complete the third leg** (`s4-goods-receipt.ts`, built against
  `API_MATERIAL_DOCUMENT_SRV` v1.5.0). A material document records *any* stock movement, so the
  work is deciding what counts as "received against this PO line" — and the naive reading is
  wrong four different ways:
  - **Reversals must net out.** `GoodsMovementIsCancelled` marks a cancelled item and
    `ReversedMaterialDocument` marks the document that reversed one; **both** are excluded, so
    the pair disappears rather than either double-counting the delivery or driving received
    below zero. This is the one that matters: over-receipt is a *hard stop*, so inflating
    received quantity makes the check fire on correct invoices while hiding a genuine
    over-delivery behind a reversal nobody reads.
  - **Direction comes from `DebitCreditCode`** (`'H'` → −1), not the movement type. Treating
    every movement as positive makes a return to the supplier look like a second delivery.
  - **Units are never converted.** There are two quantity/unit pairs (`QuantityInEntryUnit`
    /`EntryUnit`, `QuantityInBaseUnit`/`MaterialBaseUnit`) and the PO line has a third. We take
    the one whose unit matches and otherwise **refuse** — 2 cases against a line in pieces is 2
    or 24 depending on a factor this service doesn't carry, and either guess silently defeats
    the over-receipt check. Refusals surface as `unitMismatches`, never as a zero, because an
    invisible zero reads as "delivered nothing" and blocks a correct invoice.
  - **The posting date is on the header only.** `A_MaterialDocumentItem` has
    `ShelfLifeExpirationDate` and `ManufactureDate` and no posting date at all, so items read
    directly come back undated unless `to_MaterialDocumentHeader` is expanded. Both expand
    directions are handled.
  Deliberately filters on `PurchaseOrder` being present rather than on
  `GoodsMovementRefDocType`'s one-character code, whose values differ between releases — a
  wrong letter would silently discard *every* receipt.
  24 unit tests, and the three load-bearing ones were mutation-checked: breaking the reversal
  exclusion, the unit refusal and the `DebitCreditCode` sign each fails the suite.

**Schema additions still required before a connector can post** (none exist yet): `externalId`
on vendors / purchase orders / GL accounts / cost centres, `companyCode`, `fiscalYear` beside
`erpDocumentNumber`, a per-tenant tax-code map, and payment terms.

## Architecture direction (agreed, phased)

The system has four planes, and until Phase 0 it had exactly one.

1. **Work plane** — AP clerks, approvers, controllers. The nine screens. Read/write
   *transactions*. Built.
2. **Config plane** — the customer's own admins. Workflow definitions (create, version,
   publish, retire, simulate), tolerances, GL/cost-centre master, users and roles, SLA
   policies. Read/write *rules*. **Not built.** Decided: this ships as a **separate frontend
   bundle**, not role-gated routes in the work app — different users, different risk, and the
   AP clerk's browser should never receive rule-editing code. A UI role check is not a
   security boundary.
3. **Integration plane** — system-to-system, no human. Connector interface, per-tenant
   credentials in a **secret store** (not the `erpConnections.config` jsonb, where one SELECT
   would expose a customer's ERP password), scheduled sync jobs, idempotent replay, retry with
   a dead-letter queue, and outbound events. **Not built** — `erpConnections` is still a table
   with zero code references.
4. **Developer plane** — CI, seeds, fixtures, local stack, test harness. **Built (Phase 0).**

**Backend stays one modular monolith.** Different apps in the UI does not mean different
services in the backend; splitting now buys distributed transactions and pays nothing. The
extraction service stays separate because it is Python and scales on a different curve.

**Hard dependency, now satisfied:** the config plane could not ship before real auth, because
rule-editing on top of a client-supplied tenant header would have let anyone rewrite anyone's
approval routing — i.e. approve their own invoices. Authentication landed, so the config plane
is unblocked. Note it needs one thing auth does not yet provide: **role-based authorisation**.
Today every authenticated user of a tenant can reach every endpoint of that tenant, which is
survivable for transactional screens and is not survivable for rule editing.

Phase order: **0 developer plane (done)** → **1 auth (done) + config plane** → 2 integration framework
with one real connector → 3 per-tenant sandbox and workflow simulation ("run these 200
invoices through the draft graph and show me where they land"), which is both a test tool and
the safe way to change a live workflow.

Deliberately excluded: microservices, and any customer-authored scripting/plugin system.
Configuration-as-data plus a good connector interface covers the real cases without handing
customers a way to break their own tenant.

## Extraction has now actually run (the former #1 gap)

An `ANTHROPIC_API_KEY` was supplied and `main.py` made its first real vision calls, against
the two genuine invoices. **Measured accuracy: 26/26 fields correct across both documents.**

What the run found, in order of how much it matters:

- **The service returned 502 on every real document.** The model presents its JSON inside a
  ```json fence — that is simply how it renders code — and `json.loads` on a fenced string
  raises at character 0. So the *entire* real extraction path was broken, and 269 passing
  tests said nothing, because `mock_server.py` never fenced its canned replies. The bug lived
  in the one seam no test crossed. `strip_code_fence()` fixes it, with 6 regression tests
  including one asserting that genuinely malformed JSON still fails loudly rather than being
  silently "repaired" into plausible-looking values.
- **The confidence gate earned its keep.** On the Arena Media invoice the model reported
  `poNumber: "536478"` — which is the **BUDGET** number, not a purchase order. The fixture
  comment had predicted exactly this decoy. It came back at **0.75**, below the 0.9 threshold,
  so the invoice went to `NEEDS_REVIEW` instead of matching against a PO that does not exist.
  Design decision 1 is no longer a theory. Note the failure was *stable* across repeated runs,
  so this is a systematic misread of that layout, not sampling noise — retrying would not
  help, and only the threshold contains it.
- **The model beat the human on a field.** `vendorName` was transcribed by hand as
  "Comunicaciones", the Spanish spelling, which appears **nowhere** on the document — the
  letterhead reads "COMUNICATIONS". The fixtures have been corrected. Worth remembering when
  reading any remaining hand-transcribed value: the answer key had an error in it.
- **Self-assessed confidence tracked reality.** Ready4people prints Spain's three VAT rates as
  a fixed template with the charged column blank; the model returned tax `0.0` at confidence
  **0.6** rather than reading 21% off the template. It was both right and appropriately unsure
  — which is the behaviour the whole per-field confidence design assumes but had never been
  able to verify.

Still open on extraction: two documents is not a corpus, both are Spanish/European non-PO
invoices, and nothing exercises a PO-matched, multi-line, multi-tax-rate document. The
`/feedback` loop remains a stub.

## Not yet built (in rough priority order)
1. ~~**Real auth**~~ — **DONE. Phase 1 complete; `x-tenant-id` no longer exists.**
   Moved out of this list; see "Authentication" below.
2. **A real ERP connector.** Posting is simulated: the document number is generated locally.
   `erpConnections` still stores config with no connector logic. Nothing pulls purchase orders,
   GL accounts, cost centres or vendors from an ERP either — all four are pushed in by hand.
3. **Notifying the next approver, outside the app.** In-app arrival is now covered — the
   workspace polls the acting user's queue and announces new items (see "Feedback effects").
   But that only reaches someone with the tab open: there is still no email, no push, no
   digest, and no server-side notification of any kind. The poll is also per-open-tab, which
   is fine for a prototype and is not how this should work at volume; the eventual answer is
   the server emitting an event when a step is created.
4. **Fraud risk scoring** — `Vendor.riskScore` field exists; nothing populates it.
5. **AI copilot** — natural-language invoice search, smarter GL coding suggestions (today's are
   frequency counts over this vendor's history, not a model call), plain-language explanations
   of why an invoice is stuck (`_consistency_warnings` is a natural input).
6. **Feedback loop** — `/feedback` on the extraction service is a stub; corrections should
   persist per tenant/vendor-layout and feed back into the prompt as few-shot examples.
7. **Vendor portal** — separate, simplified auth context and shell.

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
- **There is still no editor, only an API.** Definitions are created as raw graph jsonb over
  HTTP and published by id. The visual builder is Phase 1 config-plane work.
- **A tenant with nothing published silently drops invoices.** `startInstance()` logs a warning
  and leaves the invoice unrouted. `retireDefinition` can reach that state deliberately, and
  nothing yet surfaces it as an alert or blocks the retire.

### Known gaps in PO matching / master data
- **There is no ERP connector behind the PO API.** POs have to be pushed in by whatever calls
  `POST /purchase-orders`; nothing pulls them from an ERP on a schedule, and `erpConnections`
  still has no connector logic. The endpoint is deliberately shaped so a connector can drive
  it idempotently, but that connector does not exist.
- **No PO is ever closed or cancelled.** There is no status on `purchaseOrders`, so a fully
  consumed or cancelled order still matches new invoices exactly as an open one does.
- **Recall is not gated by a role.** `POST /invoices/:id/revalidate` and any correction that
  triggers one will recall an in-flight approval for whoever calls it. This was blocked on
  identity; identity now exists, so restricting it to AP_MANAGER/CONTROLLER is **unblocked and
  simply not written yet** — there is no role-based authorisation anywhere in the API.
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
- **Uploaded files are served unauthenticated**, and now that everything else requires a token
  this is the weakest point in the system. `GET /files/:name` is explicitly `@Public()` because
  the extraction service fetches it as an anonymous HTTP client. Unguessable UUIDs are all that
  protect a confidential invoice PDF, and a URL that never expires and needs no credential will
  end up in a log, a proxy or a browser history. Wants **signed, expiring URLs**.
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
  surface in the repo: ~2,600 lines of UI against 246 backend unit tests.
- ~~**Identity is picked, not authenticated.**~~ Both were deleted when auth landed. The shell
  now signs in against the OIDC issuer and reads identity from `GET /auth/me`.
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

### Inbound: three channels, one pipeline
`POST /invoices` with a `fileUrl` remains the single ingestion path, and that is the point —
the upload screen, the IMAP poller and any future connector all resolve to it, so there is no
second code path to keep in step. Real PDFs and real vision calls have both now been through
it end to end.

What is still missing is a **vendor portal** (suppliers submitting directly), and
`sourceChannel` remains a label the caller passes rather than something the server derives.

## Conventions
- Tenant ID always comes first in service method signatures: `(tenantId, ...)`.
- Every state-changing action should write an `AuditEvent` — see `logAudit()` pattern
  in `invoices.service.ts`.
- Money fields are `numeric(18,2)` in Postgres / passed as strings to Drizzle inserts
  (avoid floating point on currency amounts).
- New Nest modules follow the standard controller/service/dto split already established
  in `src/invoices/`.
