import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WTSCLI_RUNTIME_IDENTITY, getDaemonOwnershipPath } from '../runtime-identity.js';
import {
  DAEMON_OWNERSHIP_TOKEN_ENV,
  bindDaemonOwnershipPid,
  daemonOwnershipRequestHeaders,
  expectedDaemonOwnerHash,
  loadDaemonOwnershipRecord,
  prepareDaemonOwnership,
  removeDaemonOwnershipRecord,
  requestHasDaemonOwnership,
  requireDaemonOwnershipFromEnv,
} from './daemon-ownership.js';

describe('WTSCLI daemon ownership record', () => {
  let root: string;
  let wtsConfigDir: string;
  let legacyConfigDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtscli-ownership-'));
    wtsConfigDir = path.join(root, 'wts');
    legacyConfigDir = path.join(root, 'legacy-opencli');
    fs.mkdirSync(legacyConfigDir, { recursive: true });
    fs.writeFileSync(path.join(legacyConfigDir, 'sentinel'), 'legacy-owned\n');
    vi.stubEnv('WTSCLI_CONFIG_DIR', wtsConfigDir);
    vi.stubEnv('OPENCLI_CONFIG_DIR', legacyConfigDir);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates ownership only in the isolated WTS state namespace', () => {
    const ownership = prepareDaemonOwnership();

    expect(ownership).not.toBeNull();
    if (!ownership) throw new Error('Expected the first launch reservation to win');
    expect(getDaemonOwnershipPath()).toBe(path.join(wtsConfigDir, 'daemon', 'ownership.json'));
    expect(loadDaemonOwnershipRecord()).toEqual(ownership);
    bindDaemonOwnershipPid(ownership.token, 424242);
    expect(loadDaemonOwnershipRecord()).toEqual({ ...ownership, pid: 424242 });
    expect(expectedDaemonOwnerHash()).toBe(ownership.tokenHash);
    expect(fs.readFileSync(path.join(legacyConfigDir, 'sentinel'), 'utf8')).toBe('legacy-owned\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(getDaemonOwnershipPath()).mode & 0o777).toBe(0o600);
    }
  });

  it('claims the launch reservation exclusively without overwriting the first owner', () => {
    const first = prepareDaemonOwnership();
    const second = prepareDaemonOwnership();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(loadDaemonOwnershipRecord()).toEqual(first);
  });

  it('recovers an aged reservation only after its launcher is confirmed gone', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
    const first = prepareDaemonOwnership();
    if (!first) throw new Error('Expected the first launch reservation to win');
    vi.setSystemTime(new Date('2026-07-24T00:00:31.000Z'));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
    });

    const recovered = prepareDaemonOwnership();

    expect(recovered).not.toBeNull();
    expect(recovered?.token).not.toBe(first.token);
    expect(loadDaemonOwnershipRecord()).toEqual(recovered);
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
  });

  it('keeps an aged reservation fail-closed while its bound daemon PID is alive', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
    const first = prepareDaemonOwnership();
    if (!first) throw new Error('Expected the first launch reservation to win');
    bindDaemonOwnershipPid(first.token, 424242);
    vi.setSystemTime(new Date('2026-07-24T00:00:31.000Z'));
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === process.pid) {
        throw Object.assign(new Error('launcher not found'), { code: 'ESRCH' });
      }
      return true;
    });

    expect(prepareDaemonOwnership()).toBeNull();
    expect(loadDaemonOwnershipRecord()).toEqual({ ...first, pid: 424242 });
    expect(kill).toHaveBeenNthCalledWith(1, process.pid, 0);
    expect(kill).toHaveBeenNthCalledWith(2, 424242, 0);
  });

  it('requires the exact local token for control and cleanup', () => {
    const ownership = prepareDaemonOwnership();
    if (!ownership) throw new Error('Expected the launch reservation to be available');
    vi.stubEnv(DAEMON_OWNERSHIP_TOKEN_ENV, ownership.token);

    expect(requireDaemonOwnershipFromEnv()).toEqual(ownership);
    expect(daemonOwnershipRequestHeaders()).toEqual({
      [WTSCLI_RUNTIME_IDENTITY.transport.ownershipHeader.name]: ownership.token,
    });
    expect(requestHasDaemonOwnership({
      [WTSCLI_RUNTIME_IDENTITY.transport.ownershipHeader.name.toLowerCase()]: ownership.token,
    })).toBe(true);
    expect(requestHasDaemonOwnership({
      [WTSCLI_RUNTIME_IDENTITY.transport.ownershipHeader.name.toLowerCase()]: '0'.repeat(64),
    })).toBe(false);
    expect(removeDaemonOwnershipRecord('0'.repeat(64))).toBe(false);
    expect(loadDaemonOwnershipRecord()).not.toBeNull();
    expect(removeDaemonOwnershipRecord(ownership.token)).toBe(true);
    expect(loadDaemonOwnershipRecord()).toBeNull();
  });

  it('rejects a daemon process whose launch token does not match the record', () => {
    expect(prepareDaemonOwnership()).not.toBeNull();
    vi.stubEnv(DAEMON_OWNERSHIP_TOKEN_ENV, '0'.repeat(64));

    expect(() => requireDaemonOwnershipFromEnv()).toThrow(
      'not proven to be the WTS-owned daemon',
    );
    try {
      requireDaemonOwnershipFromEnv();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'port_occupied_by_foreign_process',
        hint: expect.stringContaining(`matching ${DAEMON_OWNERSHIP_TOKEN_ENV} and ownership record`),
      });
    }
  });
});
