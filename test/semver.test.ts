import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSemver, isSemver, parseSemver } from '../src/index.js';

test('isSemver accepts valid and rejects invalid versions', () => {
  for (const v of ['0.0.0', '1.2.3', '10.20.30', '1.0.0-alpha.1', '1.0.0+build.5', '1.0.0-rc.1+sha.abc']) {
    assert.equal(isSemver(v), true, v);
  }
  for (const v of ['1', '1.2', '01.2.3', '1.2.3.4', 'v1.2.3', '1.2.3-', '', 42, null]) {
    assert.equal(isSemver(v), false, String(v));
  }
});

test('parseSemver throws on invalid input', () => {
  assert.throws(() => parseSemver('nope'), TypeError);
  assert.deepEqual(parseSemver('1.2.3-beta.2'), { major: 1, minor: 2, patch: 3, prerelease: ['beta', '2'] });
});

test('compareSemver orders numerically, not as text', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('2.0.0', '10.0.0'), -1);
  assert.equal(compareSemver('1.0.1', '1.0.0'), 1);
});

test('compareSemver follows the prerelease rules of the spec', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareSemver(ordered[i]!, ordered[i + 1]!), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareSemver(ordered[i + 1]!, ordered[i]!), 1);
  }
});

test('compareSemver ignores build metadata', () => {
  assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
});
