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
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates ownership only in the isolated WTS state namespace', () => {
    const ownership = prepareDaemonOwnership();

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

  it('requires the exact local token for control and cleanup', () => {
    const ownership = prepareDaemonOwnership();
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
    prepareDaemonOwnership();
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
