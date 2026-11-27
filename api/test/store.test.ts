import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import postgres from 'postgres';

import { MemoryStore } from '../src/memory-store.js';
import { PgStore } from '../src/pg-store.js';
import type { AuditEntry, Store, StoredModule } from '../src/store.js';

const identity = (subject: string) => ({ issuer: 'https://accounts.example', subject, email: null, name: subject });

const billing: StoredModule = {
  module: 'billing',
  last: null,
  current: '1.0.0',
  next: null,
  rollout: 0,
  healthy: true,
  updatedAt: '2026-11-25T10:00:00.000Z',
};

const entry = (action: AuditEntry['action'], to: string): AuditEntry => ({
  module: 'billing',
  at: '2026-11-25T10:00:00.000Z',
  action,
  from: null,
  to,
  by: 'Catalin',
});

/** The same contract for every Store, so the memory one in tests behaves like Postgres. */
function contract(name: string, make: () => Promise<Store>) {
  describe(`${name} store`, () => {
    it('keeps one user per issuer and subject', async () => {
      const store = await make();
      const first = await store.upsertUser(identity('same'));
      const again = await store.upsertUser({ ...identity('same'), email: 'new@example.com' });
      assert.equal(first.id, again.id);
      assert.equal(again.email, 'new@example.com');
      const other = await store.upsertUser(identity('other'));
      assert.notEqual(first.id, other.id);
    });

    it('scopes projects to their owner', async () => {
      const store = await make();
      const a = await store.upsertUser(identity('owner-a'));
      const b = await store.upsertUser(identity('owner-b'));
      const p = await store.createProject(a.id, 'Shop');
      assert.equal((await store.getProject(a.id, p.id))?.name, 'Shop');
      assert.equal(await store.getProject(b.id, p.id), null);
      assert.equal(await store.renameProject(b.id, p.id, 'X'), null);
      assert.equal(await store.deleteProject(b.id, p.id), false);
      assert.deepEqual(
        (await store.listProjects(a.id)).map((x) => x.id),
        [p.id],
      );
      assert.deepEqual(await store.listProjects(b.id), []);
    });

    it('creates a module once and writes modules and history together', async () => {
      const store = await make();
      const u = await store.upsertUser(identity('mods'));
      const p = await store.createProject(u.id, 'Shop');
      assert.equal(await store.createModule(p.id, billing, entry('create', '1.0.0'), u.id), true);
      assert.equal(await store.createModule(p.id, billing, entry('create', '1.0.0'), u.id), false);

      const updated = await store.updateModule(
        p.id,
        'billing',
        (m) => ({
          record: { ...m, next: '1.1.0', updatedAt: '2026-11-25T11:00:00.000Z' },
          entries: [{ ...entry('draft', '1.1.0'), at: '2026-11-25T11:00:00.000Z' }],
        }),
        u.id,
      );
      assert.equal(updated?.next, '1.1.0');
      assert.equal(await store.updateModule(p.id, 'search', (m) => ({ record: m, entries: [] }), u.id), null);

      const [mod] = await store.listModules(p.id);
      assert.deepEqual(mod, { ...billing, next: '1.1.0', updatedAt: '2026-11-25T11:00:00.000Z' });
      const history = await store.listHistory(p.id, 10);
      assert.deepEqual(
        history.map((h) => [h.action, h.to, h.by]),
        [
          ['draft', '1.1.0', 'Catalin'],
          ['create', '1.0.0', 'Catalin'],
        ],
      );
    });

    it('connects a repository to the owner\'s project only', async () => {
      const store = await make();
      const a = await store.upsertUser(identity('gh-a'));
      const b = await store.upsertUser(identity('gh-b'));
      const p = await store.createProject(a.id, 'Shop');
      assert.equal(await store.getGithub(a.id, p.id), null);
      assert.equal(await store.setGithub(b.id, p.id, { installationId: 7, repo: 'acme/shop' }), false);
      assert.equal(await store.setGithub(a.id, p.id, { installationId: 7, repo: null }), true);
      assert.deepEqual(await store.getGithub(a.id, p.id), { installationId: 7, repo: null });
      assert.deepEqual(await store.projectsForRepo(7, 'acme/shop'), []);
      assert.equal(await store.setGithub(a.id, p.id, { installationId: 7, repo: 'Acme/Shop' }), true);
      assert.equal(await store.getGithub(b.id, p.id), null);
      assert.deepEqual(await store.projectsForRepo(7, 'acme/shop'), [p.id]);
      assert.deepEqual(await store.projectsForRepo(8, 'acme/shop'), []);
      assert.deepEqual((await store.getProject(a.id, p.id))?.name, 'Shop');
      assert.equal(await store.setGithub(a.id, p.id, null), true);
      assert.equal(await store.getGithub(a.id, p.id), null);
    });

    it('keeps one PostHog connection per project, for its owner only', async () => {
      const store = await make();
      const a = await store.upsertUser(identity('ph-a'));
      const b = await store.upsertUser(identity('ph-b'));
      const p = await store.createProject(a.id, 'Shop');
      assert.equal(await store.getPosthog(a.id, p.id), null);
      const link = { region: 'eu' as const, projectId: 256908, sealedKey: 'v1.iv.data' };
      assert.equal(await store.setPosthog(b.id, p.id, link), false);
      assert.equal(await store.setPosthog(a.id, p.id, link), true);
      assert.deepEqual(await store.getPosthog(a.id, p.id), link);
      assert.equal(await store.getPosthog(b.id, p.id), null);
      assert.deepEqual(await store.getProject(a.id, p.id).then((x) => Object.keys(x!).sort()), ['createdAt', 'id', 'name', 'updatedAt']);
      assert.equal(await store.setPosthog(a.id, p.id, null), true);
      assert.equal(await store.getPosthog(a.id, p.id), null);
    });

    it('keeps one read and one deploy key hash per project, for its owner only', async () => {
      const store = await make();
      const a = await store.upsertUser(identity('rk-a'));
      const b = await store.upsertUser(identity('rk-b'));
      const p = await store.createProject(a.id, 'Shop');
      const read = 'a'.repeat(64);
      const deploy = 'b'.repeat(64);
      assert.equal(await store.hasKey(a.id, p.id, 'read'), false);
      assert.equal(await store.hasKey(b.id, p.id, 'read'), null);
      assert.equal(await store.setKey(b.id, p.id, 'read', read), false);
      assert.equal(await store.projectForKey('read', read), null);
      assert.equal(await store.setKey(a.id, p.id, 'read', read), true);
      assert.equal(await store.setKey(a.id, p.id, 'deploy', deploy), true);
      assert.equal(await store.hasKey(a.id, p.id, 'read'), true);
      assert.deepEqual(await store.projectForKey('read', read), { projectId: p.id, ownerId: a.id });
      assert.deepEqual(await store.projectForKey('deploy', deploy), { projectId: p.id, ownerId: a.id });
      assert.equal(await store.projectForKey('deploy', read), null);
      assert.deepEqual(await store.getProject(a.id, p.id).then((x) => Object.keys(x!).sort()), ['createdAt', 'id', 'name', 'updatedAt']);
      assert.equal(await store.setKey(a.id, p.id, 'read', null), true);
      assert.equal(await store.projectForKey('read', read), null);
      assert.equal(await store.hasKey(a.id, p.id, 'deploy'), true);
    });

    it('clears every project of a removed installation', async () => {
      const store = await make();
      const u = await store.upsertUser(identity('gh-clear'));
      const p = await store.createProject(u.id, 'Shop');
      const q = await store.createProject(u.id, 'Blog');
      await store.setGithub(u.id, p.id, { installationId: 99, repo: 'acme/shop' });
      await store.setGithub(u.id, q.id, { installationId: 99, repo: 'acme/blog' });
      assert.equal(await store.clearInstallation(99), 2);
      assert.equal(await store.getGithub(u.id, p.id), null);
      assert.equal(await store.clearInstallation(99), 0);
    });

    it('records a module the GitHub app created, with no user', async () => {
      const store = await make();
      const u = await store.upsertUser(identity('gh-mod'));
      const p = await store.createProject(u.id, 'Shop');
      assert.equal(await store.createModule(p.id, billing, { ...entry('create', '1.0.0'), by: 'GitHub' }, null), true);
      assert.deepEqual((await store.listHistory(p.id, 10)).map((h) => h.by), ['GitHub']);
    });

    it('deletes a project with its modules and history', async () => {
      const store = await make();
      const u = await store.upsertUser(identity('gone'));
      const p = await store.createProject(u.id, 'Shop');
      await store.createModule(p.id, billing, entry('create', '1.0.0'), u.id);
      assert.equal(await store.deleteProject(u.id, p.id), true);
      assert.deepEqual(await store.listModules(p.id), []);
      assert.deepEqual(await store.listHistory(p.id, 10), []);
    });
  });
}

contract('memory', async () => new MemoryStore());

// Runs when DATABASE_URL points at an empty Postgres. CI starts Postgres 18 for it.
const url = process.env.DATABASE_URL;
if (url) {
  const sql = postgres(url, { onnotice: () => {} });
  // The migration has its own begin and commit, so it runs on a single connection.
  const migrate = async () => {
    const one = postgres(url, { max: 1, onnotice: () => {} });
    for (const file of ['0001_init.sql', '0002_posthog.sql', '0003_read_key.sql', '0004_deploy_key.sql']) {
      await one.unsafe(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')).simple();
    }
    await one.end();
  };
  before(async () => {
    await sql.unsafe('drop table if exists history, modules, projects, users cascade');
    await migrate();
  });
  after(() => sql.end());
  contract('postgres', async () => new PgStore(sql));

  describe('postgres schema', () => {
    it('rejects a bad slug and a rollout over 100 at the database too', async () => {
      const store = new PgStore(sql);
      const u = await store.upsertUser(identity('schema'));
      const p = await store.createProject(u.id, 'Shop');
      await assert.rejects(store.createModule(p.id, { ...billing, module: 'Bad Slug' }, entry('create', '1.0.0'), u.id));
      await assert.rejects(store.createModule(p.id, { ...billing, rollout: 101 }, entry('create', '1.0.0'), u.id));
    });

    it('applies the migration twice without error', async () => {
      await migrate();
    });
  });
} else {
  it.skip('postgres store (set DATABASE_URL to run)');
}
