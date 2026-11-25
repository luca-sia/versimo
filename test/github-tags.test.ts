import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modulesFromTags, parseModuleTag, recordFromTags } from '../src/github/index.js';
import { validateRecord } from '../src/index.js';

test('parseModuleTag reads module/vX.Y.Z', () => {
  assert.deepEqual(parseModuleTag('billing/v2.4.0'), { module: 'billing', version: '2.4.0' });
  assert.deepEqual(parseModuleTag('refs/tags/sign-in/v1.0.0-rc.1'), { module: 'sign-in', version: '1.0.0-rc.1' });
});

test('parseModuleTag ignores everything else', () => {
  for (const tag of ['v1.0.0', 'billing/1.0.0', 'Billing/v1.0.0', 'packages/go/v0.2.0', 'billing/v1.0', '/v1.0.0', 'billing/vx']) {
    assert.equal(parseModuleTag(tag), null, tag);
  }
});

test('modulesFromTags groups, sorts newest first and drops duplicates', () => {
  const tags = ['billing/v2.3.1', 'v0.2.0', 'billing/v2.10.0', 'search/v1.0.0', 'billing/v2.4.0', 'billing/v2.4.0', 'billing/v2.5.0-rc.1'];
  assert.deepEqual(modulesFromTags(tags), {
    billing: ['2.10.0', '2.5.0-rc.1', '2.4.0', '2.3.1'],
    search: ['1.0.0'],
  });
});

test('recordFromTags takes the two newest stable versions', () => {
  const record = recordFromTags('billing', ['2.5.0-rc.1', '2.3.1', '2.4.0', '2.0.0+build-1'], '2026-11-25T23:00:00Z');
  assert.deepEqual(record, {
    module: 'billing',
    last: '2.3.1',
    current: '2.4.0',
    next: null,
    rollout: 0,
    healthy: true,
    updatedAt: '2026-11-25T23:00:00.000Z',
  });
  assert.equal(validateRecord(record).ok, true);
});

test('recordFromTags with one version has no last', () => {
  assert.equal(recordFromTags('search', ['1.0.0'])?.last, null);
});

test('recordFromTags gives null with no stable version', () => {
  assert.equal(recordFromTags('search', ['1.0.0-beta.1']), null);
  assert.equal(recordFromTags('search', []), null);
});
