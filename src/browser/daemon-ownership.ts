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
export const DAEMON_LAUNCH_RESERVATION_SCHEMA = 'wtscli.daemon_launch_reservation.v1' as const;
export const DAEMON_OWNERSHIP_TOKEN_ENV = 'WTSCLI_DAEMON_OWNERSHIP_TOKEN';
const ABANDONED_LAUNCH_RESERVATION_MS = 30_000;

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

interface DaemonLaunchReservation {
  schemaVersion: typeof DAEMON_LAUNCH_RESERVATION_SCHEMA;
  endpoint: DaemonOwnershipRecord['endpoint'];
  token: string;
  launcherPid: number;
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

function getDaemonLaunchReservationPath(): string {
  return path.join(path.dirname(getDaemonOwnershipPath()), 'launch-reservation.json');
}

function writeTempFile(target: string, value: unknown): string {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.chmodSync(temp, 0o600);
  return temp;
}

function removeTempFile(temp: string): void {
  try {
    fs.rmSync(temp, { force: true });
  } catch {
    // Best-effort cleanup of a never-authoritative temporary file.
  }
}

function writeRecord(record: DaemonOwnershipRecord): void {
  const target = getDaemonOwnershipPath();
  const temp = writeTempFile(target, record);
  try {
    // Only the process holding launch-reservation.json may replace ownership.
    // copyFileSync is used because Windows renameSync does not reliably replace
    // an existing target. Readers still validate the complete record and fail
    // closed if they observe the short replacement window.
    fs.copyFileSync(temp, target);
    fs.chmodSync(target, 0o600);
  } finally {
    removeTempFile(temp);
  }
}

function claimLaunchReservation(reservation: DaemonLaunchReservation): boolean {
  const target = getDaemonLaunchReservationPath();
  const temp = writeTempFile(target, reservation);
  try {
    try {
      // Publishing a hard link is an atomic create-if-absent operation on all
      // supported local filesystems. Unlike copy/rename it can never replace a
      // competing daemon owner's lifetime reservation.
      fs.linkSync(temp, target);
      fs.chmodSync(target, 0o600);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    removeTempFile(temp);
  }
}

function loadLaunchReservation(): DaemonLaunchReservation | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDaemonLaunchReservationPath(), 'utf8')) as Partial<DaemonLaunchReservation>;
    if (
      parsed.schemaVersion !== DAEMON_LAUNCH_RESERVATION_SCHEMA
      || parsed.endpoint?.host !== '127.0.0.1'
      || parsed.endpoint.port !== DEFAULT_DAEMON_PORT
      || !isOwnershipToken(parsed.token)
      || !Number.isSafeInteger(parsed.launcherPid)
      || parsed.launcherPid! <= 0
      || typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return parsed as DaemonLaunchReservation;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function releaseDaemonLaunchReservation(token: string): boolean {
  const reservation = loadLaunchReservation();
  if (!reservation || reservation.token !== token) return false;
  try {
    fs.rmSync(getDaemonLaunchReservationPath());
    return true;
  } catch {
    return false;
  }
}

function recoverAbandonedLaunchReservation(): boolean {
  const reservation = loadLaunchReservation();
  if (!reservation) return false;
  const createdAt = Date.parse(reservation.createdAt);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt < ABANDONED_LAUNCH_RESERVATION_MS) {
    return false;
  }
  const ownership = loadDaemonOwnershipRecord();
  if (ownership && ownership.token !== reservation.token) return false;
  // The reservation remains for the daemon owner's entire lifetime, closing
  // the stale-observation window where a second CLI saw "stopped" just before
  // the first daemon began listening. PIDs are only conservative liveness
  // signals: they are never kill authority, and a live/reused PID merely keeps
  // recovery fail-closed.
  if (processIsAlive(reservation.launcherPid)) return false;
  if (ownership?.pid && processIsAlive(ownership.pid)) return false;

  if (ownership?.token === reservation.token) {
    try {
      fs.rmSync(getDaemonOwnershipPath());
    } catch {
      return false;
    }
  }
  return releaseDaemonLaunchReservation(reservation.token);
}

export function prepareDaemonOwnership(): DaemonOwnershipRecord | null {
  const token = randomBytes(32).toString('hex');
  const createdAt = new Date().toISOString();
  const record: DaemonOwnershipRecord = {
    schemaVersion: DAEMON_OWNERSHIP_SCHEMA,
    endpoint: {
      host: WTSCLI_RUNTIME_IDENTITY.endpoint.host,
      port: WTSCLI_RUNTIME_IDENTITY.endpoint.port,
    },
    token,
    tokenHash: daemonOwnershipTokenHash(token),
    createdAt,
  };
  const reservation: DaemonLaunchReservation = {
    schemaVersion: DAEMON_LAUNCH_RESERVATION_SCHEMA,
    endpoint: record.endpoint,
    token,
    launcherPid: process.pid,
    createdAt,
  };
  if (
    !claimLaunchReservation(reservation)
    && (!recoverAbandonedLaunchReservation() || !claimLaunchReservation(reservation))
  ) {
    return null;
  }
  try {
    writeRecord(record);
    return record;
  } catch (error) {
    releaseDaemonLaunchReservation(token);
    throw error;
  }
}

export function bindDaemonOwnershipPid(token: string, pid: number | undefined): void {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  const current = loadDaemonOwnershipRecord();
  if (!current || current.token !== token) return;
  writeRecord({ ...current, pid });
}

export function removeDaemonOwnershipRecord(token: string): boolean {
  const current = loadDaemonOwnershipRecord();
  let removed = false;
  if (current?.token === token) {
    try {
      fs.rmSync(getDaemonOwnershipPath());
      removed = true;
    } catch {
      removed = false;
    }
  }
  releaseDaemonLaunchReservation(token);
  return removed;
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
