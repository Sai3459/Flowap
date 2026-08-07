-- Auto-approval policy, per tenant.
--
-- NULL for every existing tenant, and NULL means off. Applying this migration changes no
-- behaviour: an invoice is routed to a human exactly as it was before until somebody writes a
-- policy. That is the same rollout posture as `enforce_approval_limits` and `copilot_mode`,
-- and it matters more here than for either of them — the failure mode of a bad auto-approval
-- default is not an error message, it is invoices being paid that nobody looked at.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS auto_approve_policy jsonb;
