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
- **Frontend:** React + TypeScript (not yet built — next milestone)

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
./install.sh
```

That's the whole setup. It installs backend npm deps, creates
`extraction-service/.venv` and installs the Python deps, seeds both `.env` files from
their `.env.example` templates, creates the Postgres database, and pushes the Drizzle
schema. Every step is idempotent — re-run it after a `git pull` to pick up new
dependencies or schema changes. `./install.sh --help` lists the flags
(`--skip-node`, `--skip-python`, `--skip-db`, `--no-venv`).

Prerequisites the script checks for but does not install: Node 20+, Python 3.10+, and a
running PostgreSQL 16 with the `psql` client on PATH.

Then start the two services in separate terminals:

```bash
# 1. Extraction service
cd extraction-service && .venv/bin/python -m uvicorn main:app --port 8001
# ...or, with no ANTHROPIC_API_KEY, the mock the backend was verified against:
cd extraction-service && .venv/bin/python -m uvicorn mock_server:app --port 8001

# 2. Backend
cd backend && npm start        # runs ts-node src/main.ts — NOT tsx, see gotcha above
```

API docs: `http://localhost:3000/api/docs` (Swagger, auto-generated from decorators).

<details>
<summary>Manual setup, if you'd rather not use the script</summary>

```bash
# 1. Postgres (adjust for your OS/package manager)
createdb invoice_platform

# 2. Backend
cd backend
npm ci
cp .env.example .env           # then edit DATABASE_URL / EXTRACTION_SERVICE_URL
npx drizzle-kit push --force   # applies schema — see src/db/schema.ts
npx ts-node src/main.ts        # NOT npx tsx

# 3. Extraction service (separate terminal)
cd extraction-service
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export ANTHROPIC_API_KEY="sk-ant-..."   # main.py reads it from the environment
.venv/bin/python -m uvicorn main:app --port 8001
```

Note that the backend auto-loads `backend/.env` via `ConfigModule`, but the extraction
service reads `ANTHROPIC_API_KEY` straight from `os.environ` — export it, or
`set -a; source .env; set +a` before starting uvicorn.
</details>

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
   out of road. The workflow engine itself (evaluating the graph at runtime) is NOT YET
   BUILT — `WorkflowDefinition`/`ApprovalInstance`/`ApprovalStep` tables exist in the
   schema but there's no service consuming them yet. This is the next major module.

4. **Every table is tenant-scoped from day one** (`tenantId` FK on nearly everything).
   Tenant resolution is currently a raw `x-tenant-id` header for prototype convenience —
   **this must be replaced with SSO-session-derived tenant resolution before any real
   auth is added.** Never let a client supply its own tenant ID in production.

5. **ERP integration is an overlay, not a replacement.** `ErpConnection` stores
   per-tenant connector config; the platform should feel like an upgrade sitting on top
   of the existing ERP, not a new system of record competing with it.

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

## Not yet built (in rough priority order)
1. **Workflow engine** — evaluate `WorkflowDefinition.graph` at runtime, create
   `ApprovalStep` rows, handle parallel/sequential/conditional approval, SLA/escalation.
2. **Real auth** — SSO (Entra ID, Google), replace the `x-tenant-id` header hack.
3. **PO / goods-receipt matching** — `PurchaseOrder` table exists; no matching logic yet.
4. **Fraud risk scoring** — `Vendor.riskScore` field exists; nothing populates it.
5. **AI copilot** — natural-language invoice search, GL coding suggestions, plain-language
   explanations of why an invoice is stuck (the extraction service's `_consistency_warnings`
   are a natural input to this).
6. **Feedback loop** — `/feedback` endpoint on the extraction service is a stub; needs to
   actually persist corrections per tenant/vendor-layout and feed them back into the
   extraction prompt as few-shot examples.
7. **Frontend** — nothing built yet. React + TS, Vite. Priority screens: invoice list,
   invoice detail with confidence-flagged fields, exception queue, mobile approval view.
8. **Vendor portal** — separate, simplified auth context and shell.
9. **ERP connectors** — `ErpConnection` config storage exists; no actual connector logic.

## Conventions
- Tenant ID always comes first in service method signatures: `(tenantId, ...)`.
- Every state-changing action should write an `AuditEvent` — see `logAudit()` pattern
  in `invoices.service.ts`.
- Money fields are `numeric(18,2)` in Postgres / passed as strings to Drizzle inserts
  (avoid floating point on currency amounts).
- New Nest modules follow the standard controller/service/dto split already established
  in `src/invoices/`.
