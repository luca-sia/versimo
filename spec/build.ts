import {
  bucketFor,
  checkHealth,
  compareSemver,
  draftNext,
  isSemver,
  promote,
  resolve,
  rollback,
  rolloutFromFlag,
  setRollout,
  validateRecord,
  VersimoError,
  type ModuleRecord,
} from '../src/index.js';

const NOW = '2026-04-01T10:00:00.000Z';

const record = (o: Record<string, unknown> = {}): ModuleRecord =>
  ({
    module: 'billing',
    last: '2.3.1',
    current: '2.4.0',
    next: '2.5.0',
    rollout: 10,
    healthy: true,
    updatedAt: '2026-03-12T09:30:00Z',
    ...o,
  }) as ModuleRecord;

function buckets() {
  const pairs: [string, string][] = [
    ['billing', 'user-42'],
    ['billing', 'alice'],
    ['billing', 'bob'],
    ['billing', ''],
    ['', 'user-42'],
    ['', ''],
    ['sign-in', 'user-42'],
    ['search', 'user-42'],
    ['checkout', 'user-42'],
    ['a', 'b'],
    ['a-b', 'c'],
    ['a', 'b-c'],
    ['billing', '0'],
    ['billing', '123456'],
    ['billing', 'user\n'],
    ['billing', ' user'],
    ['billing', 'a\u0000b'],
    ['billing', 'é'],
    ['billing', 'é'],
    ['billing', 'ß'],
    ['billing', '😀'],
    ['billing', '👨‍👩‍👧'],
    ['billing', '🇬🇧'],
    ['billing', '日本語'],
    ['billing', '用户-123'],
    ['billing', 'Привет'],
    ['billing', 'مرحبا'],
    ['billing', '\u{10FFFF}'],
    ['billing', 'x'.repeat(1000)],
    ['billing', 'é'.repeat(300)],
    ['sign-in', '日本語'],
    ['search', '😀'],
    ['é', 'user-42'],
  ];
  for (let i = 0; i < 10; i++) pairs.push(['billing', `user-${i}`]);
  return pairs.map(([module, userId]) => ({ module, userId, bucket: bucketFor(module, userId) }));
}

function resolves() {
  const cases: { name: string; record: ModuleRecord; userId: string | null; expected: unknown }[] = [];
  const add = (name: string, rec: ModuleRecord, userId: string | null) =>
    cases.push({ name, record: rec, userId, expected: resolve(rec, userId === null ? {} : { userId }) });

  for (let i = 0; i < 12; i++) add(`rollout 50, user-${i}`, record({ rollout: 50 }), `user-${i}`);
  add('rollout 0 never reaches next', record({ rollout: 0 }), 'user-1');
  add('rollout 100 always reaches next', record({ rollout: 100 }), 'user-1');
  add('rollout 100 with unicode id', record({ rollout: 100 }), '日本語');
  add('no next, rollout 0', record({ next: null, rollout: 0 }), 'user-1');
  add('no last, no next', record({ last: null, next: null, rollout: 0 }), 'user-1');
  add('no user id (null)', record(), null);
  add('empty user id', record(), '');
  add('unhealthy falls back to last', record({ healthy: false }), 'user-1');
  add('unhealthy beats rollout 100', record({ healthy: false, rollout: 100 }), 'user-1');
  add('unhealthy with no last stays on current', record({ healthy: false, last: null }), 'user-1');
  add('unhealthy with no user', record({ healthy: false }), null);
  return cases;
}

type Op = 'promote' | 'rollback' | 'setRollout' | 'draftNext';

function transitions() {
  const cases: unknown[] = [];
  const add = (
    name: string,
    op: Op,
    rec: ModuleRecord,
    args: Record<string, unknown> = {},
    by?: string,
    reason?: string,
  ) => {
    const opts: { now: string; by?: string; patch?: boolean; reason?: string } = { now: NOW };
    if (by !== undefined) opts.by = by;
    if (reason !== undefined) opts.reason = reason;
    if (args.patch) opts.patch = true;
    const c: Record<string, unknown> = { name, op, args, record: rec, now: NOW };
    if (by !== undefined) c.by = by;
    if (reason !== undefined) c.reason = reason;
    try {
      let out: ModuleRecord;
      if (op === 'promote') out = promote(rec, opts);
      else if (op === 'rollback') out = rollback(rec, opts);
      else if (op === 'setRollout') out = setRollout(rec, args.n as number, opts);
      else out = draftNext(rec, args.version as string, opts);
      c.expected = out;
    } catch (err) {
      if (!(err instanceof VersimoError)) throw err;
      c.error = err.code;
    }
    cases.push(c);
  };
  const hist = [{ at: '2026-03-12T09:30:00.000Z', action: 'promote', from: '2.3.1', to: '2.4.0', by: 'sam' }];

  add('promote', 'promote', record({ rollout: 100 }), {}, 'alex');
  add('promote without by', 'promote', record());
  add('promote clears unhealthy', 'promote', record({ healthy: false }));
  add('promote appends to history', 'promote', record({ history: hist }), {}, 'alex');
  add('promote with no last', 'promote', record({ last: null }));
  add('promote with empty next', 'promote', record({ next: null, rollout: 0 }));
  add('promote keeps $schema', 'promote', record({ $schema: 'https://versimo.dev/schema/module-record.schema.json' }));

  add('rollback', 'rollback', record(), {}, 'alex');
  add('rollback clears unhealthy', 'rollback', record({ healthy: false, next: null, rollout: 0 }));
  add('rollback without last', 'rollback', record({ last: null }));
  add('rollback appends to history', 'rollback', record({ history: hist }));
  add('rollback with a reason', 'rollback', record(), {}, 'alex', 'error rate too high');
  add('promote with a reason', 'promote', record(), {}, undefined, 'UAT signed off');

  add('setRollout 25', 'setRollout', record(), { n: 25 }, 'alex');
  add('setRollout 100', 'setRollout', record(), { n: 100 });
  add('setRollout 0', 'setRollout', record(), { n: 0 });
  add('setRollout 0 with no next', 'setRollout', record({ next: null, rollout: 0 }), { n: 0 });
  add('setRollout above 0 with no next', 'setRollout', record({ next: null, rollout: 0 }), { n: 5 });
  add('setRollout 101', 'setRollout', record(), { n: 101 });
  add('setRollout -1', 'setRollout', record(), { n: -1 });
  add('setRollout 1.5', 'setRollout', record(), { n: 1.5 });
  add('setRollout appends to history', 'setRollout', record({ history: hist }), { n: 40 });

  add('draftNext', 'draftNext', record({ next: null, rollout: 0 }), { version: '2.6.0' }, 'alex');
  add('draftNext replaces next and resets rollout', 'draftNext', record(), { version: '2.7.0' });
  add('draftNext patch', 'draftNext', record({ healthy: false }), { version: '2.4.1', patch: true }, 'health-check');
  add('draftNext prerelease above current', 'draftNext', record({ next: null, rollout: 0 }), { version: '2.5.0-beta.1' });
  add('draftNext equal to current', 'draftNext', record(), { version: '2.4.0' });
  add('draftNext below current', 'draftNext', record(), { version: '2.3.0' });
  add('draftNext prerelease of current', 'draftNext', record(), { version: '2.4.0-rc.1' });
  add('draftNext not semver', 'draftNext', record(), { version: 'v2.6.0' });
  add('draftNext empty', 'draftNext', record(), { version: '' });
  add('draftNext appends to history', 'draftNext', record({ history: hist }), { version: '3.0.0' });
  return cases;
}

function healths() {
  const cases: Record<string, unknown>[] = [];
  const add = (
    name: string,
    checks: Record<string, unknown>,
    observation: Record<string, unknown>,
    rec: ModuleRecord = record(),
    by?: string,
  ) => {
    const c: Record<string, unknown> = { name, record: rec, checks, observation, now: NOW };
    if (by !== undefined) c.by = by;
    try {
      const opts: { now: string; by?: string } = { now: NOW };
      if (by !== undefined) opts.by = by;
      c.expected = checkHealth(rec, checks, observation, opts);
    } catch (err) {
      if (!(err instanceof VersimoError)) throw err;
      c.error = err.code;
    }
    cases.push(c);
  };
  const all = { maxErrorRate: 0.05, maxLatencyMs: 800, url: 'https://billing.example.com/health' };

  add('no checks is healthy', {}, { requests: 100, errors: 100, latencyMs: 9000, urlStatus: 500 });
  add('all passing', all, { requests: 1000, errors: 50, latencyMs: 800, urlStatus: 204 });
  add('error rate at the limit passes', { maxErrorRate: 0.05 }, { requests: 20, errors: 1 });
  add('error rate above the limit rolls back', { maxErrorRate: 0.05 }, { requests: 40, errors: 3 });
  add('error rate one third', { maxErrorRate: 0.3 }, { requests: 3, errors: 1 });
  add('error rate limit 0 fails on one error', { maxErrorRate: 0 }, { requests: 1000, errors: 1 });
  add('error rate limit 1 never fails', { maxErrorRate: 1 }, { requests: 10, errors: 10 });
  add('error rate skipped below minRequests', { maxErrorRate: 0.05, minRequests: 50 }, { requests: 49, errors: 49 });
  add('error rate judged at minRequests', { maxErrorRate: 0.05, minRequests: 50 }, { requests: 50, errors: 3 });
  add('error rate skipped with no requests', { maxErrorRate: 0.05 }, { requests: 0, errors: 0 });
  add('minRequests 0 still needs one request', { maxErrorRate: 0, minRequests: 0 }, { requests: 0, errors: 0 });
  add('error rate skipped without errors', { maxErrorRate: 0.05 }, { requests: 100 });
  add('error rate skipped without requests', { maxErrorRate: 0.05 }, { errors: 5 });
  add('latency at the limit passes', { maxLatencyMs: 800 }, { latencyMs: 800 });
  add('latency above the limit rolls back', { maxLatencyMs: 800 }, { latencyMs: 800.5 });
  add('latency skipped when not measured', { maxLatencyMs: 800 }, { requests: 10 });
  add('url 200 passes', { url: all.url }, { urlStatus: 200 });
  add('url 299 passes', { url: all.url }, { urlStatus: 299 });
  add('url 300 fails', { url: all.url }, { urlStatus: 300 });
  add('url 199 fails', { url: all.url }, { urlStatus: 199 });
  add('url 503 fails', { url: all.url }, { urlStatus: 503 });
  add('url unreachable fails', { url: all.url }, { urlStatus: 0 });
  add('url skipped when not measured', { url: all.url }, {});
  add('measured but not checked is ignored', {}, { latencyMs: 5000 });
  add('every check fails, in order', all, { requests: 10, errors: 9, latencyMs: 2000, urlStatus: 500 });
  add('failure records by', { maxLatencyMs: 100 }, { latencyMs: 200 }, record(), 'ops-bot');
  add('failure appends to history', { maxLatencyMs: 100 }, { latencyMs: 200 }, record({
    history: [{ at: '2026-03-12T09:30:00.000Z', action: 'promote', from: '2.3.1', to: '2.4.0' }],
  }));
  add('failure with no last leaves the record', { maxLatencyMs: 100 }, { latencyMs: 200 }, record({ last: null }));
  add('failure while unhealthy still rolls back', { maxLatencyMs: 100 }, { latencyMs: 200 }, record({ healthy: false }));
  add('passing leaves an unhealthy record alone', { maxLatencyMs: 100 }, { latencyMs: 50 }, record({ healthy: false }));
  add('failure drops next and rollout', { maxErrorRate: 0.01 }, { requests: 100, errors: 2 }, record({ rollout: 60 }));

  add('maxErrorRate above 1', { maxErrorRate: 1.5 }, {});
  add('maxErrorRate below 0', { maxErrorRate: -0.1 }, {});
  add('maxErrorRate not a number', { maxErrorRate: '0.1' }, {});
  add('maxLatencyMs below 0', { maxLatencyMs: -1 }, {});
  add('url empty', { url: '' }, {});
  add('minRequests fractional', { minRequests: 1.5 }, {});
  add('requests fractional', {}, { requests: 2.5 });
  add('errors below 0', {}, { errors: -1 });
  add('errors above requests', {}, { requests: 1, errors: 2 });
  add('latencyMs below 0', {}, { latencyMs: -5 });
  add('urlStatus fractional', {}, { urlStatus: 200.5 });
  return cases;
}

const field = (message: string) => message.split(' ')[0] as string;

function validations() {
  const cases: { name: string; record: unknown; ok: boolean; errors: string[] }[] = [];
  const add = (name: string, rec: unknown) => {
    const r = validateRecord(rec);
    cases.push({ name, record: rec, ok: r.ok, errors: r.errors.map(field) });
  };
  const without = (key: string) => {
    const r: Record<string, unknown> = { ...record() };
    delete r[key];
    return r;
  };
  const entry = (o: Record<string, unknown> = {}) => ({
    at: '2026-03-12T09:30:00Z',
    action: 'promote',
    from: '2.3.1',
    to: '2.4.0',
    ...o,
  });

  add('valid', record());
  add('valid with no last and no next', record({ last: null, next: null, rollout: 0 }));
  add('valid with $schema and history', record({ $schema: 'x', history: [entry(), entry({ by: 'alex', from: null })] }));
  add('valid with empty history', record({ history: [] }));
  add('valid prerelease and build', record({ next: '2.5.0-rc.1+build.5' }));
  add('valid rollout 0 and 100', record({ rollout: 100 }));
  add('valid offset date', record({ updatedAt: '2026-03-12T09:30:00.123+01:00' }));

  add('null', null);
  add('array', []);
  add('string', 'billing');
  add('number', 7);
  add('empty object', {});

  add('unknown key', record({ extra: 1 }));
  add('missing module', without('module'));
  add('missing last', without('last'));
  add('missing next', without('next'));
  add('missing history is fine', without('history'));
  add('$schema not a string', record({ $schema: 3 }));

  add('module upper case', record({ module: 'Billing' }));
  add('module empty', record({ module: '' }));
  add('module with trailing newline', record({ module: 'billing\n' }));
  add('module with underscore', record({ module: 'sign_in' }));
  add('module with leading hyphen', record({ module: '-billing' }));
  add('module with double hyphen', record({ module: 'a--b' }));
  add('module not a string', record({ module: 5 }));

  add('current with leading zero', record({ current: '02.4.0' }));
  add('current two parts', record({ current: '2.4' }));
  add('current with v prefix', record({ current: 'v2.4.0' }));
  add('current with trailing newline', record({ current: '2.4.0\n' }));
  add('current with empty prerelease', record({ current: '2.4.0-' }));
  add('current null', record({ current: null }));
  add('last not semver', record({ last: 'old' }));
  add('next not semver', record({ next: '1' }));
  add('prerelease numeric with leading zero', record({ next: '2.5.0-01' }));
  add('unicode digits are not digits', record({ current: '٢.٤.٠' }));

  add('rollout 101', record({ rollout: 101 }));
  add('rollout -1', record({ rollout: -1 }));
  add('rollout 1.5', record({ rollout: 1.5 }));
  add('rollout string', record({ rollout: '10' }));
  add('rollout true', record({ rollout: true }));
  add('rollout null', record({ rollout: null }));
  add('healthy string', record({ healthy: 'true' }));
  add('healthy missing', without('healthy'));

  add('updatedAt date only', record({ updatedAt: '2026-03-12' }));
  add('updatedAt without zone', record({ updatedAt: '2026-03-12T09:30:00' }));
  add('updatedAt with space', record({ updatedAt: '2026-03-12 09:30:00Z' }));
  add('updatedAt month 13', record({ updatedAt: '2026-13-01T00:00:00Z' }));
  add('updatedAt day 32', record({ updatedAt: '2026-01-32T00:00:00Z' }));
  add('updatedAt hour 25', record({ updatedAt: '2026-03-12T25:00:00Z' }));
  add('updatedAt minute 60', record({ updatedAt: '2026-03-12T09:60:00Z' }));
  add('updatedAt second 60', record({ updatedAt: '2026-03-12T09:30:60Z' }));
  add('updatedAt 24:00:00 is accepted', record({ updatedAt: '2026-03-12T24:00:00Z' }));
  add('updatedAt 24:00:01', record({ updatedAt: '2026-03-12T24:00:01Z' }));
  add('updatedAt offset +23:59', record({ updatedAt: '2026-03-12T09:30:00+23:59' }));
  add('updatedAt offset +24:00', record({ updatedAt: '2026-03-12T09:30:00+24:00' }));
  add('updatedAt offset minutes 60', record({ updatedAt: '2026-03-12T09:30:00+00:60' }));
  add('updatedAt day 30 of February is accepted', record({ updatedAt: '2026-02-30T00:00:00Z' }));
  add('updatedAt with trailing newline', record({ updatedAt: '2026-03-12T09:30:00Z\n' }));
  add('updatedAt lower case z', record({ updatedAt: '2026-03-12T09:30:00z' }));
  add('updatedAt number', record({ updatedAt: 1773307800 }));
  add('updatedAt missing', without('updatedAt'));

  add('history not an array', record({ history: {} }));
  add('history entry not an object', record({ history: [1] }));
  add('history entry unknown key', record({ history: [entry({ why: 'x' })] }));
  add('history entry bad date', record({ history: [entry({ at: 'yesterday' })] }));
  add('history entry bad action', record({ history: [entry({ action: 'delete' })] }));
  add('history entry from a number', record({ history: [entry({ from: 2 })] }));
  add('history entry to missing', record({ history: [{ at: '2026-03-12T09:30:00Z', action: 'draft', from: null }] }));
  add('history entry by a number', record({ history: [entry({ by: 7 })] }));
  add('history entry with a reason', record({ history: [entry({ action: 'rollback', reason: 'health: errorRate' })] }));
  add('history entry reason a number', record({ history: [entry({ reason: 7 })] }));
  add('history second entry bad', record({ history: [entry(), entry({ action: 'x', at: 'y' })] }));

  add('next equal to current', record({ next: '2.4.0' }));
  add('next below current', record({ next: '2.3.0' }));
  add('next prerelease of current', record({ next: '2.4.0-rc.1' }));
  add('last equal to current', record({ last: '2.4.0' }));
  add('last above current', record({ last: '3.0.0' }));
  add('rollout above 0 with no next', record({ next: null, rollout: 5 }));
  add('several errors at once', { module: 'X', last: 1, current: 'x', next: 2, rollout: 200, healthy: 0, updatedAt: 'no', extra: true });
  add('ordering is skipped when fields are invalid', record({ rollout: 'x', next: '1.0.0' }));
  return cases;
}

function semvers() {
  const compare: { a: string; b: string; expected: number }[] = [];
  const pairs: [string, string][] = [
    ['1.0.0', '1.0.0'],
    ['1.0.0', '2.0.0'],
    ['2.0.0', '1.0.0'],
    ['1.2.0', '1.10.0'],
    ['1.0.9', '1.0.10'],
    ['1.0.0-alpha', '1.0.0'],
    ['1.0.0', '1.0.0-alpha'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
    ['1.0.0-alpha.beta', '1.0.0-beta'],
    ['1.0.0-beta', '1.0.0-beta.2'],
    ['1.0.0-beta.2', '1.0.0-beta.11'],
    ['1.0.0-beta.11', '1.0.0-rc.1'],
    ['1.0.0-rc.1', '1.0.0'],
    ['1.0.0-1', '1.0.0-a'],
    ['1.0.0-a', '1.0.0-B'],
    ['1.0.0+build.1', '1.0.0+build.2'],
    ['1.0.0-rc.1+a', '1.0.0-rc.1+b'],
    ['0.0.0', '0.0.1'],
    ['99999999999999999999.0.0', '1.0.0'],
  ];
  for (const [a, b] of pairs) {
    compare.push({ a, b, expected: compareSemver(a, b) });
    if (a !== b) compare.push({ a: b, b: a, expected: compareSemver(b, a) });
  }
  const values = [
    '0.0.0', '1.2.3', '10.20.30', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x.7.z.92', '1.0.0-x-y-z.--',
    '1.0.0+20130313144700', '1.0.0-beta+exp.sha.5114f85', '1.0.0+21AF26D3--117B344092BD', '1.0.0-0A.is.legal',
    '', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', '1.2.03', 'v1.2.3', '1.2.3-', '1.2.3+', '1.2.3-01', '1.2.3-a..b',
    '1.2.3-a.', '1.2.3+a..b', '1.2.3-é', ' 1.2.3', '1.2.3 ', '1.2.3\n', '1.2.-3', '١.٢.٣',
  ];
  return { compare, valid: values.map((value) => ({ value, valid: isSemver(value) })) };
}

function posthogFlags() {
  const flag = (enabled: unknown, payload?: unknown) =>
    payload === undefined ? { key: 'versimo-billing', enabled } : { key: 'versimo-billing', enabled, metadata: { payload } };
  const cases: [string, unknown][] = [
    ['no flag', null],
    ['flag off', flag(false)],
    ['flag off ignores payload', flag(false, '{"rollout":50}')],
    ['flag on, no payload', flag(true)],
    ['payload as JSON string', flag(true, '{"rollout":25}')],
    ['payload as object', flag(true, { rollout: 25 })],
    ['rollout 0', flag(true, '{"rollout":0}')],
    ['rollout 100', flag(true, '{"rollout":100}')],
    ['rollout 101 is ignored', flag(true, '{"rollout":101}')],
    ['rollout -1 is ignored', flag(true, '{"rollout":-1}')],
    ['rollout 25.0 counts as 25', flag(true, '{"rollout":25.0}')],
    ['rollout true is ignored', flag(true, '{"rollout":true}')],
    ['rollout 12.5 is ignored', flag(true, '{"rollout":12.5}')],
    ['rollout as text is ignored', flag(true, '{"rollout":"25"}')],
    ['payload not JSON', flag(true, 'rollout 25')],
    ['payload is a number', flag(true, '25')],
    ['payload has no rollout', flag(true, '{"share":25}')],
    ['payload null', flag(true, null)],
    ['whole record as payload', flag(true, JSON.stringify(record({ rollout: 30 })))],
    ['extra payload fields', flag(true, '{"rollout":40,"note":"Friday"}')],
    ['enabled missing', { key: 'versimo-billing', metadata: { payload: '{"rollout":25}' } }],
    ['enabled as text', flag('true', '{"rollout":25}')],
  ];
  return cases.map(([name, f]) => ({ name, flag: f, rollout: rolloutFromFlag(f) }));
}

export function buildVectors() {
  return {
    description:
      'Language-neutral test vectors for every Versimo port. Generated from Versimo for TypeScript by spec/generate.ts. Do not edit by hand.',
    format: 1,
    notes: {
      transitions:
        'Each case gives the input record, an op, its args, an optional by, and a fixed now. expected is the output record, or error is the error code.',
      resolve: 'userId null means no user id. An empty string also means no user.',
      posthog:
        'flag is one entry of a PostHog /flags?v=2 answer, or null when the flag is absent. rollout is the share on next it gives, or null to keep the record rollout.',
      validation: 'errors lists the field named at the start of each error message, in order.',
      health:
        'Each case gives the record, checks, observation, a fixed now and an optional by. expected has the record after the check, the verdict and rolledBack, or error is the error code. A missing key in checks or observation means it is not set.',
    },
    bucket: buckets(),
    resolve: resolves(),
    transitions: transitions(),
    validation: validations(),
    semver: semvers(),
    posthog: posthogFlags(),
    health: healths(),
  };
}
