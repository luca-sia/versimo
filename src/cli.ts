#!/usr/bin/env node
import { createDeployClient } from './deploy.js';

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
};

const USAGE = `Usage: versimo <command> [args]

  list
  create <module> <current> [last]
  draft <module> <version> [--patch]
  rollout <module> <0-100>
  promote <module>
  rollback <module>

Needs VERSIMO_DEPLOY_KEY. VERSIMO_BASE defaults to https://versimo.dev.
`;

async function main(args: string[]): Promise<number> {
  const [command, module, value, extra] = args;
  const key = process.env.VERSIMO_DEPLOY_KEY;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }
  if (!key) {
    process.stderr.write('Set VERSIMO_DEPLOY_KEY to the project deploy key.\n');
    return 2;
  }
  const versimo = createDeployClient({ key, base: process.env.VERSIMO_BASE });
  const need = (v: string | undefined): string => {
    if (!v) throw new Error(USAGE);
    return v;
  };
  const out = (x: unknown) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
  switch (command) {
    case 'list':
      out(await versimo.list());
      return 0;
    case 'create':
      out(await versimo.create(need(module), need(value), extra));
      return 0;
    case 'draft':
      out(await versimo.draft(need(module), need(value), { patch: extra === '--patch' }));
      return 0;
    case 'rollout':
      out(await versimo.rollout(need(module), Number(need(value))));
      return 0;
    case 'promote':
      out(await versimo.promote(need(module)));
      return 0;
    case 'rollback':
      out(await versimo.rollback(need(module)));
      return 0;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  },
);
