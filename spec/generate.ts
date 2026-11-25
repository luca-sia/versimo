import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVectors } from './build.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = `${JSON.stringify(buildVectors(), null, 2)}\n`;

// The Swift tests load vectors through Bundle.module, so they need their own copy.
const targets = ['spec/vectors.json', 'packages/swift/Tests/VersimoTests/Resources/vectors.json'];
for (const target of targets) {
  const file = resolve(root, target);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, json);
  console.log(`wrote ${target}`);
}
