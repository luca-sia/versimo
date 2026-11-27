import type postgres from 'postgres';

import type { AuditEntry, GithubLink, Identity, PosthogStored, Project, Store, StoredModule, User } from './store.js';

type Sql = postgres.Sql;

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

const toProject = (r: postgres.Row): Project => ({
  id: r.id,
  name: r.name,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toModule = (r: postgres.Row): StoredModule => ({
  module: r.module,
  last: r.last,
  current: r.current,
  next: r.next,
  rollout: r.rollout,
  healthy: r.healthy,
  updatedAt: iso(r.updated_at),
});

const toEntry = (r: postgres.Row): AuditEntry => ({
  module: r.module,
  at: iso(r.at),
  action: r.action,
  from: r.from_version,
  to: r.to_version,
  by: r.by_name,
});

/** The Store on Postgres 18, through Hyperdrive in the Worker or a plain URL in tests. */
export class PgStore implements Store {
  constructor(private sql: Sql) {}

  async upsertUser(identity: Identity): Promise<User> {
    const [row] = await this.sql`
      insert into users (issuer, subject, email, name)
      values (${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name})
      on conflict (issuer, subject)
      do update set email = excluded.email, name = excluded.name, seen_at = now()
      returning id, email, name`;
    return { id: row!.id, email: row!.email, name: row!.name };
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    const rows = await this.sql`
      select id, name, created_at, updated_at from projects
      where owner_id = ${ownerId} order by created_at, id`;
    return rows.map(toProject);
  }

  async createProject(ownerId: string, name: string): Promise<Project> {
    const [row] = await this.sql`
      insert into projects (owner_id, name) values (${ownerId}, ${name})
      returning id, name, created_at, updated_at`;
    return toProject(row!);
  }

  async getProject(ownerId: string, projectId: string): Promise<Project | null> {
    const [row] = await this.sql`
      select id, name, created_at, updated_at from projects
      where id = ${projectId} and owner_id = ${ownerId}`;
    return row ? toProject(row) : null;
  }

  async renameProject(ownerId: string, projectId: string, name: string): Promise<Project | null> {
    const [row] = await this.sql`
      update projects set name = ${name}, updated_at = now()
      where id = ${projectId} and owner_id = ${ownerId}
      returning id, name, created_at, updated_at`;
    return row ? toProject(row) : null;
  }

  async deleteProject(ownerId: string, projectId: string): Promise<boolean> {
    const rows = await this.sql`
      delete from projects where id = ${projectId} and owner_id = ${ownerId} returning id`;
    return rows.length > 0;
  }

  async getGithub(ownerId: string, projectId: string): Promise<GithubLink | null> {
    const [row] = await this.sql`
      select github_installation_id, github_repo from projects
      where id = ${projectId} and owner_id = ${ownerId} and github_installation_id is not null`;
    return row ? { installationId: Number(row.github_installation_id), repo: row.github_repo } : null;
  }

  async setGithub(ownerId: string, projectId: string, link: GithubLink | null): Promise<boolean> {
    const rows = await this.sql`
      update projects set github_installation_id = ${link?.installationId ?? null},
        github_repo = ${link?.repo ?? null}, updated_at = now()
      where id = ${projectId} and owner_id = ${ownerId}
      returning id`;
    return rows.length > 0;
  }

  async getPosthog(ownerId: string, projectId: string): Promise<PosthogStored | null> {
    const [row] = await this.sql`
      select posthog_region, posthog_project_id, posthog_key from projects
      where id = ${projectId} and owner_id = ${ownerId} and posthog_key is not null`;
    return row
      ? { region: row.posthog_region, projectId: Number(row.posthog_project_id), sealedKey: row.posthog_key }
      : null;
  }

  async setPosthog(ownerId: string, projectId: string, link: PosthogStored | null): Promise<boolean> {
    const rows = await this.sql`
      update projects set posthog_region = ${link?.region ?? null},
        posthog_project_id = ${link?.projectId ?? null}, posthog_key = ${link?.sealedKey ?? null}, updated_at = now()
      where id = ${projectId} and owner_id = ${ownerId}
      returning id`;
    return rows.length > 0;
  }

  async projectsForRepo(installationId: number, repo: string): Promise<string[]> {
    const rows = await this.sql`
      select id from projects
      where github_installation_id = ${installationId} and lower(github_repo) = lower(${repo})
      order by created_at, id`;
    return rows.map((r) => r.id as string);
  }

  async clearInstallation(installationId: number): Promise<number> {
    const rows = await this.sql`
      update projects set github_installation_id = null, github_repo = null, updated_at = now()
      where github_installation_id = ${installationId}
      returning id`;
    return rows.length;
  }

  async listModules(projectId: string): Promise<StoredModule[]> {
    const rows = await this.sql`
      select module, last, current, next, rollout, healthy, updated_at from modules
      where project_id = ${projectId} order by module`;
    return rows.map(toModule);
  }

  async createModule(projectId: string, m: StoredModule, entry: AuditEntry, byUser: string | null): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into modules (project_id, module, last, current, next, rollout, healthy, updated_at)
        values (${projectId}, ${m.module}, ${m.last}, ${m.current}, ${m.next}, ${m.rollout}, ${m.healthy}, ${m.updatedAt})
        on conflict do nothing
        returning module`;
      if (rows.length === 0) return false;
      await insertEntries(tx, projectId, [entry], byUser);
      await touch(tx, projectId);
      return true;
    }) as Promise<boolean>;
  }

  async updateModule(
    projectId: string,
    module: string,
    change: (record: StoredModule) => { record: StoredModule; entries: AuditEntry[] },
    byUser: string,
  ): Promise<StoredModule | null> {
    return this.sql.begin(async (tx) => {
      const [row] = await tx`
        select module, last, current, next, rollout, healthy, updated_at from modules
        where project_id = ${projectId} and module = ${module}
        for update`;
      if (!row) return null;
      const { record: m, entries } = change(toModule(row));
      await tx`
        update modules set last = ${m.last}, current = ${m.current}, next = ${m.next},
          rollout = ${m.rollout}, healthy = ${m.healthy}, updated_at = ${m.updatedAt}
        where project_id = ${projectId} and module = ${module}`;
      await insertEntries(tx, projectId, entries, byUser);
      await touch(tx, projectId);
      return m;
    }) as Promise<StoredModule | null>;
  }

  async listHistory(projectId: string, limit: number): Promise<AuditEntry[]> {
    const rows = await this.sql`
      select module, at, action, from_version, to_version, by_name from history
      where project_id = ${projectId} order by id desc limit ${limit}`;
    return rows.map(toEntry);
  }
}

async function insertEntries(tx: postgres.TransactionSql, projectId: string, entries: AuditEntry[], byUser: string | null) {
  for (const e of entries) {
    await tx`
      insert into history (project_id, module, at, action, from_version, to_version, by_user, by_name)
      values (${projectId}, ${e.module}, ${e.at}, ${e.action}, ${e.from}, ${e.to}, ${byUser}, ${e.by})`;
  }
}

async function touch(tx: postgres.TransactionSql, projectId: string) {
  await tx`update projects set updated_at = now() where id = ${projectId}`;
}
