import type { AuditEntry, GithubLink, Identity, PosthogStored, Project, Store, StoredModule, User } from './store.js';

interface ProjectRow extends Project {
  ownerId: string;
  github?: GithubLink | null;
  posthog?: PosthogStored | null;
}

/** An in-memory Store for tests and local runs. Same rules as the Postgres one. */
export class MemoryStore implements Store {
  private users = new Map<string, User>();
  private projects = new Map<string, ProjectRow>();
  private modules = new Map<string, Map<string, StoredModule>>();
  private history: (AuditEntry & { projectId: string })[] = [];
  private ids = 0;

  private id(): string {
    this.ids += 1;
    return `00000000-0000-4000-8000-${String(this.ids).padStart(12, '0')}`;
  }

  async upsertUser(identity: Identity): Promise<User> {
    const key = `${identity.issuer} ${identity.subject}`;
    const existing = this.users.get(key);
    const user: User = { id: existing?.id ?? this.id(), email: identity.email, name: identity.name };
    this.users.set(key, user);
    return user;
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    return [...this.projects.values()].filter((p) => p.ownerId === ownerId).map(strip);
  }

  async createProject(ownerId: string, name: string): Promise<Project> {
    const now = new Date().toISOString();
    const row: ProjectRow = { id: this.id(), ownerId, name, createdAt: now, updatedAt: now };
    this.projects.set(row.id, row);
    this.modules.set(row.id, new Map());
    return strip(row);
  }

  async getProject(ownerId: string, projectId: string): Promise<Project | null> {
    const row = this.projects.get(projectId);
    return row && row.ownerId === ownerId ? strip(row) : null;
  }

  async renameProject(ownerId: string, projectId: string, name: string): Promise<Project | null> {
    const row = this.projects.get(projectId);
    if (!row || row.ownerId !== ownerId) return null;
    row.name = name;
    row.updatedAt = new Date().toISOString();
    return strip(row);
  }

  async deleteProject(ownerId: string, projectId: string): Promise<boolean> {
    const row = this.projects.get(projectId);
    if (!row || row.ownerId !== ownerId) return false;
    this.projects.delete(projectId);
    this.modules.delete(projectId);
    this.history = this.history.filter((h) => h.projectId !== projectId);
    return true;
  }

  async getGithub(ownerId: string, projectId: string): Promise<GithubLink | null> {
    const row = this.projects.get(projectId);
    return row && row.ownerId === ownerId && row.github ? { ...row.github } : null;
  }

  async setGithub(ownerId: string, projectId: string, link: GithubLink | null): Promise<boolean> {
    const row = this.projects.get(projectId);
    if (!row || row.ownerId !== ownerId) return false;
    row.github = link ? { ...link } : null;
    row.updatedAt = new Date().toISOString();
    return true;
  }

  async getPosthog(ownerId: string, projectId: string): Promise<PosthogStored | null> {
    const row = this.projects.get(projectId);
    return row && row.ownerId === ownerId && row.posthog ? { ...row.posthog } : null;
  }

  async setPosthog(ownerId: string, projectId: string, link: PosthogStored | null): Promise<boolean> {
    const row = this.projects.get(projectId);
    if (!row || row.ownerId !== ownerId) return false;
    row.posthog = link ? { ...link } : null;
    row.updatedAt = new Date().toISOString();
    return true;
  }

  async projectsForRepo(installationId: number, repo: string): Promise<string[]> {
    const key = repo.toLowerCase();
    return [...this.projects.values()]
      .filter((p) => p.github?.installationId === installationId && p.github.repo?.toLowerCase() === key)
      .map((p) => p.id);
  }

  async clearInstallation(installationId: number): Promise<number> {
    let n = 0;
    for (const p of this.projects.values()) {
      if (p.github?.installationId === installationId) {
        p.github = null;
        n += 1;
      }
    }
    return n;
  }

  async listModules(projectId: string): Promise<StoredModule[]> {
    return [...(this.modules.get(projectId)?.values() ?? [])]
      .sort((a, b) => a.module.localeCompare(b.module))
      .map((m) => ({ ...m }));
  }

  async createModule(projectId: string, module: StoredModule, entry: AuditEntry): Promise<boolean> {
    const set = this.modules.get(projectId);
    if (!set || set.has(module.module)) return false;
    set.set(module.module, { ...module });
    this.history.push({ ...entry, projectId });
    return true;
  }

  async updateModule(
    projectId: string,
    module: string,
    change: (record: StoredModule) => { record: StoredModule; entries: AuditEntry[] },
  ): Promise<StoredModule | null> {
    const current = this.modules.get(projectId)?.get(module);
    if (!current) return null;
    const { record, entries } = change({ ...current });
    this.modules.get(projectId)!.set(module, { ...record });
    for (const entry of entries) this.history.push({ ...entry, projectId });
    return { ...record };
  }

  async listHistory(projectId: string, limit: number): Promise<AuditEntry[]> {
    return this.history
      .filter((h) => h.projectId === projectId)
      .slice(-limit)
      .reverse()
      .map(({ projectId: _, ...entry }) => entry);
  }
}

function strip({ ownerId: _, github: __, posthog: ___, ...project }: ProjectRow): Project {
  return { ...project };
}
