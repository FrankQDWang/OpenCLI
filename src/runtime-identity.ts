import * as os from 'node:os';
import * as path from 'node:path';

import { RUNTIME_IDENTITY } from './bridge-identity.js';

export const WTSCLI_RUNTIME_IDENTITY = RUNTIME_IDENTITY;
export const DEFAULT_DAEMON_HOST = RUNTIME_IDENTITY.endpoint.host;
export const DEFAULT_DAEMON_PORT = RUNTIME_IDENTITY.endpoint.port;
export const WTS_EXTENSION_ID = RUNTIME_IDENTITY.extension.id;
export const WTS_EXTENSION_ORIGIN = RUNTIME_IDENTITY.extension.origin;

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function resolveIdentityStateRoot(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function rejectLegacyOpenCliPath(candidate: string, authority: string): string {
  const legacyRoot = path.resolve(os.homedir(), '.opencli');
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const normalizedLegacyRoot = process.platform === 'win32' ? legacyRoot.toLowerCase() : legacyRoot;
  if (
    normalizedCandidate === normalizedLegacyRoot
    || normalizedCandidate.startsWith(`${normalizedLegacyRoot}${path.sep}`)
  ) {
    throw new Error(`${authority} must not point to the legacy OpenCLI state directory ${legacyRoot}.`);
  }
  return candidate;
}

export function getWtscliStateRoot(): string {
  const override = nonEmptyEnv(RUNTIME_IDENTITY.state.configDirEnv);
  return rejectLegacyOpenCliPath(
    resolveIdentityStateRoot(override ?? RUNTIME_IDENTITY.state.rootDir),
    RUNTIME_IDENTITY.state.configDirEnv,
  );
}

export function getWtscliConfigDir(): string {
  return getWtscliStateRoot();
}

export function getWtscliCacheDir(): string {
  const override = nonEmptyEnv(RUNTIME_IDENTITY.state.cacheDirEnv);
  return override
    ? rejectLegacyOpenCliPath(
      resolveIdentityStateRoot(override),
      RUNTIME_IDENTITY.state.cacheDirEnv,
    )
    : path.join(getWtscliStateRoot(), 'cache');
}

export function getWtscliStatePath(...segments: string[]): string {
  return path.join(getWtscliStateRoot(), ...segments);
}

export function getDaemonOwnershipPath(): string {
  return getWtscliStatePath(...RUNTIME_IDENTITY.state.ownershipFile.split('/'));
}
