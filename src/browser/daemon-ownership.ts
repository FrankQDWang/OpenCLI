import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PortOccupiedByForeignProcessError } from '../errors.js';
import {
  DEFAULT_DAEMON_PORT,
  WTSCLI_RUNTIME_IDENTITY,
  getDaemonOwnershipPath,
} from '../runtime-identity.js';

export const DAEMON_OWNERSHIP_SCHEMA = 'wtscli.daemon_ownership.v1' as const;
export const DAEMON_OWNERSHIP_TOKEN_ENV = 'WTSCLI_DAEMON_OWNERSHIP_TOKEN';

export interface DaemonOwnershipRecord {
  schemaVersion: typeof DAEMON_OWNERSHIP_SCHEMA;
  endpoint: {
    host: '127.0.0.1';
    port: number;
  };
  token: string;
  tokenHash: string;
  pid?: number;
  createdAt: string;
}

function isOwnershipToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function daemonOwnershipTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function loadDaemonOwnershipRecord(): DaemonOwnershipRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDaemonOwnershipPath(), 'utf8')) as Partial<DaemonOwnershipRecord>;
    if (
      parsed.schemaVersion !== DAEMON_OWNERSHIP_SCHEMA
      || parsed.endpoint?.host !== '127.0.0.1'
      || parsed.endpoint.port !== DEFAULT_DAEMON_PORT
      || !isOwnershipToken(parsed.token)
      || parsed.tokenHash !== daemonOwnershipTokenHash(parsed.token)
      || typeof parsed.createdAt !== 'string'
      || (parsed.pid !== undefined && (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0))
    ) {
      return null;
    }
    return parsed as DaemonOwnershipRecord;
  } catch {
    return null;
  }
}

function writeRecord(record: DaemonOwnershipRecord): void {
  const target = getDaemonOwnershipPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.chmodSync(temp, 0o600);
    // copyFileSync replaces an existing target on every supported platform.
    // Windows renameSync does not reliably replace the current ownership file,
    // which would break the same-token PID bind performed just after spawn.
    // A partial read fails closed because loadDaemonOwnershipRecord validates
    // the complete schema, endpoint, token, and token hash before trusting it.
    fs.copyFileSync(temp, target);
    fs.chmodSync(target, 0o600);
  } finally {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best-effort cleanup of a never-authoritative temporary file.
    }
  }
}

export function prepareDaemonOwnership(): DaemonOwnershipRecord {
  const token = randomBytes(32).toString('hex');
  const record: DaemonOwnershipRecord = {
    schemaVersion: DAEMON_OWNERSHIP_SCHEMA,
    endpoint: {
      host: WTSCLI_RUNTIME_IDENTITY.endpoint.host,
      port: WTSCLI_RUNTIME_IDENTITY.endpoint.port,
    },
    token,
    tokenHash: daemonOwnershipTokenHash(token),
    createdAt: new Date().toISOString(),
  };
  writeRecord(record);
  return record;
}

export function bindDaemonOwnershipPid(token: string, pid: number | undefined): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  const current = loadDaemonOwnershipRecord();
  if (!current || current.token !== token) return;
  writeRecord({ ...current, pid });
}

export function removeDaemonOwnershipRecord(token: string): boolean {
  const current = loadDaemonOwnershipRecord();
  if (!current || current.token !== token) return false;
  try {
    fs.rmSync(getDaemonOwnershipPath());
    return true;
  } catch {
    return false;
  }
}

export function requireDaemonOwnershipFromEnv(): DaemonOwnershipRecord {
  const token = process.env[DAEMON_OWNERSHIP_TOKEN_ENV];
  const record = loadDaemonOwnershipRecord();
  if (!isOwnershipToken(token) || !record || record.token !== token) {
    throw new PortOccupiedByForeignProcessError(
      `WTSCLI daemon startup requires a matching ${DAEMON_OWNERSHIP_TOKEN_ENV} and ownership record.`,
    );
  }
  return record;
}

export function daemonOwnershipResponseHeaders(): Record<string, string> {
  const record = requireDaemonOwnershipFromEnv();
  return {
    [WTSCLI_RUNTIME_IDENTITY.transport.ownerProofHeader.name]: record.tokenHash,
  };
}

export function expectedDaemonOwnerHash(): string | null {
  return loadDaemonOwnershipRecord()?.tokenHash ?? null;
}

export function daemonOwnershipRequestHeaders(): Record<string, string> {
  const token = loadDaemonOwnershipRecord()?.token;
  return token
    ? { [WTSCLI_RUNTIME_IDENTITY.transport.ownershipHeader.name]: token }
    : {};
}

export function requestHasDaemonOwnership(headers: Record<string, string | string[] | undefined>): boolean {
  const expected = process.env[DAEMON_OWNERSHIP_TOKEN_ENV];
  const actualValue = headers[WTSCLI_RUNTIME_IDENTITY.transport.ownershipHeader.name.toLowerCase()];
  const actual = Array.isArray(actualValue) ? actualValue[0] : actualValue;
  if (!isOwnershipToken(expected) || !isOwnershipToken(actual)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
