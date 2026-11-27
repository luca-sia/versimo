-- Versimo app: a read key per project, so apps can fetch their records without a session.
-- Run after 0002 with: psql "$DATABASE_URL" -f migrations/0003_read_key.sql

begin;

-- SHA-256 of the key, hex. The key itself is shown once and never stored.
alter table projects add column if not exists read_key_hash text unique check (read_key_hash ~ '^[0-9a-f]{64}$');

commit;
