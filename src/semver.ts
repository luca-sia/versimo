const IDENT = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
export const SEMVER_PATTERN =
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)` +
  `(?:-(${IDENT}(?:\\.${IDENT})*))?` +
  `(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`;

const SEMVER = new RegExp(SEMVER_PATTERN);

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

export function parseSemver(value: string): ParsedSemver {
  const m = SEMVER.exec(value);
  if (!m) throw new TypeError(`Invalid semver: ${JSON.stringify(value)}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

const isNumeric = (s: string) => /^\d+$/.test(s);

/** Returns -1, 0 or 1. Build metadata is ignored, as the semver spec says. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease.length === 0 && y.prerelease.length === 0) return 0;
  if (x.prerelease.length === 0) return 1;
  if (y.prerelease.length === 0) return -1;
  const len = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < len; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = isNumeric(p);
    const qn = isNumeric(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
