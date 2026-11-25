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
  listModules(projectId: string): Promise<StoredModule[]>;
  /** Adds a module and its create entry. False when the slug is taken. */
  createModule(projectId: string, module: StoredModule, entry: AuditEntry, byUser: string): Promise<boolean>;
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
