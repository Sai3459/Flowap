-- Chart of Authority: who may approve, up to how much, for what.
--
-- Separate from the workflow graph on purpose. The graph answers "what sequence"; this answers
-- "who has authority". Keeping limits in the graph, as amount thresholds on CONDITION nodes,
-- means changing one person's spending limit requires editing a published, versioned workflow
-- definition that routes everybody else too.
--
-- `currency` is NOT NULL deliberately: an amount band with no currency is not a limit, and
-- treating null as "any currency" would silently grant whichever is worth more.
--
-- Enforcement is off per tenant by default. Switching it on globally at deploy time would
-- refuse every approval until a COA had been populated — i.e. it would stop the product
-- working. An administrator turns it on once the table is filled in.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enforce_approval_limits boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS approval_authorities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  document_type text,
  currency      text NOT NULL,
  amount_from   numeric(18,2) NOT NULL DEFAULT 0,
  amount_to     numeric(18,2) NOT NULL,
  valid_from    timestamp,
  valid_to      timestamp,
  created_at    timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coa_tenant_user_idx ON approval_authorities (tenant_id, user_id);
