-- Vendor identity moves from the printed name to a normalised key.
--
-- Not just a backfill: an existing database may already hold the same supplier under several
-- spellings, and those rows have to be *merged* — everything pointing at the losers repointed
-- at one winner — before the new unique index can be created. `drizzle-kit push` cannot do
-- any of that, so it is written out.
--
--   psql "$DATABASE_URL" -f drizzle/0002_vendor_normalisation.sql
--
-- The normalisation here is a SQL approximation of `normaliseVendorName()` in
-- src/vendors/vendor-name.ts: accents stripped, lowercased, punctuation removed, common
-- legal-form suffixes dropped. It only has to agree with the TypeScript on data that already
-- exists; every row written after this point gets its key from the TypeScript.
--
-- Safe to re-run.

BEGIN;

CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE vendors ADD COLUMN IF NOT EXISTS normalised_name text;

-- Approximate normalisation for existing rows.
UPDATE vendors
   SET normalised_name = NULLIF(
         btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(lower(unaccent(name)), '[''’.]', '', 'g'),  -- drop dots: s.a. -> sa
               '[^a-z0-9]+', ' ', 'g'                                     -- other punctuation -> space
             ),
             -- trailing legal forms and dangling connectives, repeated
             '( (sociedad limitada|sociedad anonima|slu|sl|sau|sa|srls|srl|spa|sas|snc|sarl|eurl|bvba|bv|nv|gmbh|mbh|ag|kg|ohg|ug|limited|ltd|llc|llp|plc|incorporated|inc|corporation|corp|company|co|ab|oy|oyj|as|aps|pty|pte|and|und))+$',
             '', 'g'
           )
         ),
         ''
       )
 WHERE normalised_name IS NULL;

-- A name that normalises to nothing keeps its printed form as the key, so unnameable
-- vendors stay distinct instead of all colliding on ''.
UPDATE vendors SET normalised_name = lower(name) WHERE normalised_name IS NULL OR normalised_name = '';

-- ---------------------------------------------------------------- merge duplicates
--
-- Oldest row per (tenant, key) wins. Everything referencing a loser is repointed before the
-- loser is deleted, so no invoice or purchase order is orphaned.
CREATE TEMP TABLE vendor_merge AS
SELECT v.id AS loser_id, w.winner_id
  FROM vendors v
  JOIN (
    SELECT tenant_id, normalised_name,
           (array_agg(id ORDER BY created_at, id))[1] AS winner_id
      FROM vendors
     GROUP BY tenant_id, normalised_name
    HAVING count(*) > 1
  ) w ON w.tenant_id = v.tenant_id AND w.normalised_name = v.normalised_name
 WHERE v.id <> w.winner_id;

UPDATE invoices i SET vendor_id = m.winner_id
  FROM vendor_merge m WHERE i.vendor_id = m.loser_id;

UPDATE purchase_orders p SET vendor_id = m.winner_id
  FROM vendor_merge m WHERE p.vendor_id = m.loser_id;

DELETE FROM vendors v USING vendor_merge m WHERE v.id = m.loser_id;

DROP TABLE vendor_merge;

-- ---------------------------------------------------------------- constraints
ALTER TABLE vendors ALTER COLUMN normalised_name SET NOT NULL;

-- The old key allowed one row per printed spelling, which is exactly the fragmentation
-- this replaces.
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_tenant_id_name_unique;
ALTER TABLE vendors DROP CONSTRAINT IF EXISTS vendors_tenant_id_name_key;

DO $$ BEGIN
  ALTER TABLE vendors
    ADD CONSTRAINT vendors_tenant_id_normalised_name_unique
    UNIQUE (tenant_id, normalised_name);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

COMMIT;
