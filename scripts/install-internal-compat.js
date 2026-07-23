#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const source = resolve(packageRoot, 'internal', 'opencli-compat');
const target = resolve(packageRoot, 'node_modules', '@jackwener', 'opencli');
const compatOnly = process.argv.includes('--compat-only');

if (!existsSync(source)) {
  throw new Error(`Missing WTSCLI internal compatibility package: ${source}`);
}

mkdirSync(dirname(target), { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

if (!compatOnly) {
  // Optional user conveniences remain best-effort and operate only in the
  // WTSCLI-owned state namespace.
  await import('./postinstall.js').catch(() => {});
  await import('./fetch-adapters.js').catch(() => {});
}
