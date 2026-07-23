import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep, resolve } from 'node:path';

const identity = JSON.parse(
  readFileSync(new URL('../bridge-identity.json', import.meta.url), 'utf8'),
).runtimeIdentity;

if (
  !identity
  || typeof identity.state?.rootDir !== 'string'
  || typeof identity.state?.configDirEnv !== 'string'
) {
  throw new Error('bridge-identity.json is missing the WTSCLI state identity.');
}

function resolveIdentityStateRoot(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function rejectLegacyOpenCliPath(candidate, authority) {
  const legacyRoot = resolve(homedir(), '.opencli');
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const normalizedLegacyRoot = process.platform === 'win32' ? legacyRoot.toLowerCase() : legacyRoot;
  if (
    normalizedCandidate === normalizedLegacyRoot
    || normalizedCandidate.startsWith(`${normalizedLegacyRoot}${sep}`)
  ) {
    throw new Error(`${authority} must not point to the legacy OpenCLI state directory ${legacyRoot}.`);
  }
  return candidate;
}

export function getWtscliConfigDir() {
  const override = process.env[identity.state.configDirEnv]?.trim();
  return rejectLegacyOpenCliPath(
    resolveIdentityStateRoot(override || identity.state.rootDir),
    identity.state.configDirEnv,
  );
}
