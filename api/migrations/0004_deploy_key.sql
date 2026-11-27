-- Versimo app: a deploy key per project, so CI can draft, roll out, promote and roll back.
-- Run after 0003 with: psql "$DATABASE_URL" -f migrations/0004_deploy_key.sql

begin;

-- SHA-256 of the key, hex. The key itself is shown once and never stored.
alter table projects add column if not exists deploy_key_hash text unique check (deploy_key_hash ~ '^[0-9a-f]{64}$');

commit;
