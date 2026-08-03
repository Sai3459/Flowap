-- Deactivation instead of deletion, and the ADMIN role's reason to exist.
--
-- `approvalSteps.approverId` and `invoices.postedById` reference `users`, so a leaver cannot
-- simply be deleted: the row is what makes "who approved this payment" answerable a year
-- later. Deactivating stops the account working while leaving the history intact.
--
-- Defaults to true so every existing user keeps working. This is additive and safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
