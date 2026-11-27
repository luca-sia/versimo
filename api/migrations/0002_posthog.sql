-- Versimo app: a project can drive its PostHog flags (V3).
-- Run after 0001 with: psql "$DATABASE_URL" -f migrations/0002_posthog.sql

begin;

alter table projects add column if not exists posthog_region text check (posthog_region in ('eu', 'us'));
alter table projects add column if not exists posthog_project_id bigint check (posthog_project_id > 0);
-- The person's PostHog personal API key, sealed with AES-GCM under a key derived from SESSION_SECRET.
alter table projects add column if not exists posthog_key text;

commit;
