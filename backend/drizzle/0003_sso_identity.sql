-- SSO identity on users: the issuer alongside the subject, and a uniqueness guarantee.
--
-- Hand-written for the same reason as 0001 and 0002: `drizzle-kit push` cannot add a unique
-- constraint to a table that already has rows without stopping to ask whether it may
-- **truncate** it. Answering that prompt wrongly on `users` would delete every approver and
-- orphan the approval history, so this is not a prompt to click through.
--
-- Why the issuer is stored at all: an OIDC `sub` is unique only *within* an issuer. Two
-- identity providers can each legitimately emit `sub: "12345"` for different people, so
-- keying on the subject alone would let one person's identity collide onto another's user
-- row. The pair is the identity.
--
-- NULLs are deliberate and safe here. A user who has never signed in via SSO has both columns
-- NULL, and Postgres treats NULLs as distinct in a unique constraint, so any number of
-- not-yet-linked users coexist. The constraint only bites once a subject is actually bound —
-- which is exactly when two rows claiming one identity would become a security problem.

ALTER TABLE users ADD COLUMN IF NOT EXISTS sso_issuer text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_sso_identity_unique'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_sso_identity_unique UNIQUE (sso_issuer, sso_subject);
  END IF;
END $$;
