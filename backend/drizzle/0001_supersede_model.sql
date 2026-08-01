-- Supersede model + workflow definition versioning.
--
-- This project applies schema with `drizzle-kit push`, which is fine for additive changes but
-- cannot do this one: it sees workflow_definitions.is_active dropped and .status added and
-- stops to ask whether that is a rename, and it will not swap a UNIQUE constraint for a
-- partial index. So this migration is written out explicitly.
--
-- A fresh database (CI, the integration harness) never needs this file — `push` builds the
-- final shape directly. It exists for databases that already hold data.
--
--   psql "$DATABASE_URL" -f drizzle/0001_supersede_model.sql
--
-- Safe to re-run: every statement is guarded.

BEGIN;

-- ---------------------------------------------------------------- enums

DO $$ BEGIN
  CREATE TYPE approval_instance_status AS ENUM ('ACTIVE','COMPLETED','SUPERSEDED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workflow_definition_status AS ENUM ('DRAFT','PUBLISHED','RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CANCELLED joins the step statuses. Distinct from SKIPPED, which means a sibling decided the
-- node for you; CANCELLED means the instance was withdrawn out from under the step.
ALTER TYPE approval_step_status ADD VALUE IF NOT EXISTS 'CANCELLED';

-- ------------------------------------------------- workflow_definitions

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS status workflow_definition_status NOT NULL DEFAULT 'DRAFT';

-- Carry the old boolean across before dropping it: whatever was active becomes the published
-- version, everything else becomes a draft.
UPDATE workflow_definitions
   SET status = CASE WHEN is_active THEN 'PUBLISHED'::workflow_definition_status
                     ELSE 'DRAFT'::workflow_definition_status END
 WHERE EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_definitions' AND column_name = 'is_active'
 );

-- version defaulted to 1 on every row because createDefinition never set it. Give each name's
-- rows a distinct version so (tenant, name, version) can be unique.
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY tenant_id, name ORDER BY created_at) AS rn
    FROM workflow_definitions
)
UPDATE workflow_definitions d
   SET version = n.rn
  FROM numbered n
 WHERE d.id = n.id;

ALTER TABLE workflow_definitions DROP COLUMN IF EXISTS is_active;
DROP INDEX IF EXISTS workflow_tenant_active_idx;

CREATE INDEX IF NOT EXISTS workflow_tenant_status_idx
  ON workflow_definitions (tenant_id, status);

DO $$ BEGIN
  ALTER TABLE workflow_definitions
    ADD CONSTRAINT workflow_definitions_tenant_id_name_version_unique
    UNIQUE (tenant_id, name, version);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

-- At most one published definition per tenant. Two would make which graph an invoice gets
-- depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_one_published_per_tenant
  ON workflow_definitions (tenant_id) WHERE status = 'PUBLISHED';

-- -------------------------------------------------- approval_instances

ALTER TABLE approval_instances
  ADD COLUMN IF NOT EXISTS status approval_instance_status NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS superseded_by_instance_id uuid REFERENCES approval_instances(id),
  ADD COLUMN IF NOT EXISTS reason text;

-- Existing rows: completion was previously inferred from completed_at alone.
UPDATE approval_instances
   SET status = 'COMPLETED'
 WHERE completed_at IS NOT NULL AND status = 'ACTIVE';

-- The constraint swap `push` will not do. Dropping UNIQUE(invoice_id) is what allows an
-- invoice to accumulate attempts; the partial index keeps at most one of them live, so the
-- invariant stays enforced by the database rather than by application code.
ALTER TABLE approval_instances DROP CONSTRAINT IF EXISTS approval_instances_invoice_id_unique;
ALTER TABLE approval_instances DROP CONSTRAINT IF EXISTS approval_instances_invoice_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS approval_instances_one_active_per_invoice
  ON approval_instances (invoice_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS approval_instances_invoice_idx
  ON approval_instances (invoice_id);

COMMIT;
