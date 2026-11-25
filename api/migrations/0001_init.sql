-- Versimo app: people, projects, modules and an append only history.
-- Postgres 18. Run once with: psql "$DATABASE_URL" -f migrations/0001_init.sql

begin;

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  issuer      text not null,
  subject     text not null,
  email       text,
  name        text,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz not null default now(),
  unique (issuer, subject)
);

create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references users (id) on delete cascade,
  name        text not null check (length(name) between 1 and 80),
  -- Filled by the GitHub app (V2): the installation and the repo, as owner/name.
  github_installation_id bigint,
  github_repo text check (github_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists projects_owner on projects (owner_id, created_at);

create table if not exists modules (
  project_id  uuid not null references projects (id) on delete cascade,
  module      text not null check (module ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  last        text,
  current     text not null,
  next        text,
  rollout     integer not null default 0 check (rollout between 0 and 100),
  healthy     boolean not null default true,
  updated_at  timestamptz not null,
  primary key (project_id, module)
);

-- The audit trail. Rows are only ever added.
create table if not exists history (
  id          bigint generated always as identity primary key,
  project_id  uuid not null references projects (id) on delete cascade,
  module      text not null,
  at          timestamptz not null,
  action      text not null check (action in ('create', 'draft', 'promote', 'rollback', 'rollout', 'patch')),
  from_version text,
  to_version  text,
  by_user     uuid references users (id) on delete set null,
  by_name     text
);

create index if not exists history_project on history (project_id, id desc);

commit;
