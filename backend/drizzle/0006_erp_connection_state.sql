-- ERP connection: a name, and the outcome of the last test/sync.
--
-- The config column itself does not change shape, but what goes *into* it does: the
-- secret-bearing fields (clientSecret, password, apiKey) are now AES-256-GCM envelopes rather
-- than plaintext. See erp/credential-crypto.ts. Existing rows — of which there are none, since
-- nothing has ever written this table — would need re-entering.
--
-- The last_test_* columns exist so "is this connection working" is answerable from the
-- database rather than from whoever last ran the button and read the response.
ALTER TABLE erp_connections ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE erp_connections ADD COLUMN IF NOT EXISTS last_tested_at timestamp;
ALTER TABLE erp_connections ADD COLUMN IF NOT EXISTS last_test_ok boolean;
ALTER TABLE erp_connections ADD COLUMN IF NOT EXISTS last_test_message text;
ALTER TABLE erp_connections ADD COLUMN IF NOT EXISTS last_sync_at timestamp;
