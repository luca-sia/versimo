import type { ModuleRecord } from '../../src/index.js';

export interface User {
  id: string;
  email: string | null;
  name: string | null;
}

export interface Identity {
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type AuditAction = 'create' | 'draft' | 'promote' | 'rollback' | 'rollout' | 'patch';

export interface AuditEntry {
  module: string;
  at: string;
  action: AuditAction;
  from: string | null;
  to: string | null;
  by: string | null;
}

/** The repository a project is connected to through the GitHub app. */
export interface GithubLink {
  installationId: number;
  /** owner/name, or null while the person still has to pick a repository. */
  repo: string | null;
}

/** The PostHog project a project writes its flags to. The key stays sealed in the store. */
export interface PosthogStored {
  region: 'eu' | 'us';
  projectId: number;
  sealedKey: string;
}

/** A module as stored. The same shape as a Versimo record, without the history. */
export type StoredModule = Omit<ModuleRecord, 'history' | '$schema'>;

/**
 * Everything the API keeps. Every call that takes an owner id only sees that
 * owner's projects, so one person can never read or change another's.
 */
export interface Store {
  upsertUser(identity: Identity): Promise<User>;
  listProjects(ownerId: string): Promise<Project[]>;
  createProject(ownerId: string, name: string): Promise<Project>;
  /** Null when the project does not exist or belongs to someone else. */
  getProject(ownerId: string, projectId: string): Promise<Project | null>;
  renameProject(ownerId: string, projectId: string, name: string): Promise<Project | null>;
  deleteProject(ownerId: string, projectId: string): Promise<boolean>;
  /** Null when the project is not connected, does not exist or belongs to someone else. */
  getGithub(ownerId: string, projectId: string): Promise<GithubLink | null>;
  /** Connects or, with null, disconnects a repository. False when the project is not the owner's. */
  setGithub(ownerId: string, projectId: string, link: GithubLink | null): Promise<boolean>;
  /** Ids of every project connected to this repository through this installation. */
  projectsForRepo(installationId: number, repo: string): Promise<string[]>;
  /** Disconnects every project from an installation that was removed. Returns how many. */
  clearInstallation(installationId: number): Promise<number>;
  /** Null when the project has no PostHog, does not exist or belongs to someone else. */
  getPosthog(ownerId: string, projectId: string): Promise<PosthogStored | null>;
  /** Connects or, with null, disconnects PostHog. False when the project is not the owner's. */
  setPosthog(ownerId: string, projectId: string, link: PosthogStored | null): Promise<boolean>;
  /** Whether the project has a read key. Null when the project does not exist or belongs to someone else. */
  hasReadKey(ownerId: string, projectId: string): Promise<boolean | null>;
  /** Stores the hash of a new read key or, with null, removes it. False when the project is not the owner's. */
  setReadKey(ownerId: string, projectId: string, hash: string | null): Promise<boolean>;
  /** The id of the project whose read key has this hash, or null. */
  projectForReadKey(hash: string): Promise<string | null>;
  listModules(projectId: string): Promise<StoredModule[]>;
  /**
   * Adds a module and its create entry. False when the slug is taken.
   * byUser is null when the GitHub app made the change.
   */
  createModule(projectId: string, module: StoredModule, entry: AuditEntry, byUser: string | null): Promise<boolean>;
  /**
   * Reads the module, applies `change` and writes the result and the new
   * history entries in one transaction. Null when the module does not exist.
   */
  updateModule(
    projectId: string,
    module: string,
    change: (record: StoredModule) => { record: StoredModule; entries: AuditEntry[] },
    byUser: string,
  ): Promise<StoredModule | null>;
  listHistory(projectId: string, limit: number): Promise<AuditEntry[]>;
}
