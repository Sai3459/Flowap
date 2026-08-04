-- Attribution on the audit trail: who *kind of thing* took each action.
--
-- Written by hand rather than left to `drizzle-kit push` because of the backfill. Adding the
-- column with its SYSTEM default would silently declare every historical human correction and
-- every historical approval click to have been the system — which is precisely the error the
-- column exists to prevent, and it would make the first touchless rate we ever publish the
-- most flattering one we ever publish.

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS actor_kind text NOT NULL DEFAULT 'SYSTEM';

-- Backfill: actions that could only have been a person, at the time these rows were written.
--
-- This is safe to assert retrospectively because there was no autonomous actor before this
-- migration — nothing but a human has ever corrected a field, decided an approval step,
-- delegated one, coded a line or posted an invoice in this database. From here the writers
-- pass actor_kind explicitly and no inference is involved.
UPDATE audit_events
   SET actor_kind = 'HUMAN'
 WHERE action IN (
         'FIELD_CORRECTED',
         'APPROVAL_STEP_DECIDED',
         'APPROVAL_STEP_DELEGATED',
         'LINE_CODED',
         'INVOICE_POSTED'
       );

-- Deliberately NOT backfilled: REVALIDATION_STARTED and APPROVAL_INSTANCE_RECALLED.
--
-- Both are genuinely mixed in history. A re-validation is a human pressing the button, *or*
-- the pipeline reacting to a late purchase order arriving; a recall is a person intervening,
-- *or* the automatic consequence of a correction. Nothing in the old rows distinguishes them,
-- so guessing either way would put invented data behind a published number. They stay SYSTEM,
-- which is the one reading that is definitely true for some of them, and they are attributed
-- correctly from now on.
--
-- The blast radius is bounded and checkable: this can only mis-classify an invoice whose
-- *only* human touch was a re-validation or a recall. Both of those are almost always
-- downstream of a correction, which is counted separately and already disqualifies the
-- invoice. `metrics/touchless.int-spec.ts` asserts the going-forward behaviour rather than
-- trusting this note.

CREATE INDEX IF NOT EXISTS audit_touch_idx ON audit_events (tenant_id, invoice_id, actor_kind);
