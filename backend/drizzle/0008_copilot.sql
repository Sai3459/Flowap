-- Autonomous exception resolution: the mode switch and the decision log.
--
-- `copilot_mode` defaults to 'OFF' for every existing tenant, so applying this migration
-- changes no behaviour at all. Turning it on is a deliberate per-tenant act, the same rollout
-- posture as `enforce_approval_limits` — switching a money-adjacent behaviour on globally at
-- deploy time is how you find out about a bad rule from a customer rather than from a test.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS copilot_mode text NOT NULL DEFAULT 'OFF';

CREATE TABLE IF NOT EXISTS copilot_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  invoice_id       uuid NOT NULL REFERENCES invoices(id),
  rule             text NOT NULL,
  outcome          text NOT NULL,
  mode             text NOT NULL,
  reasoning        text NOT NULL,
  evidence         jsonb,
  field            text,
  previous_value   text,
  proposed_value   text,
  -- Null in shadow mode and on an escalation. Only a real change stamps this.
  applied_at       timestamp,
  -- A human undoing a resolution is the strongest signal a rule is wrong, so it is recorded
  -- rather than being an invisible correction like any other.
  reverted_at      timestamp,
  reverted_by_id   uuid,
  created_at       timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS copilot_tenant_idx ON copilot_decisions (tenant_id);
CREATE INDEX IF NOT EXISTS copilot_invoice_idx ON copilot_decisions (invoice_id);
