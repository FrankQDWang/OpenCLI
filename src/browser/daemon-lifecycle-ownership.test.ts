import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WTSCLI_RUNTIME_IDENTITY } from '../runtime-identity.js';
import { PKG_VERSION } from '../version.js';
import {
  daemonProcessHooks,
  daemonLifecycleHooks,
  ensureBrowserBridgeReady,
} from './daemon-lifecycle.js';
import {
  DAEMON_OWNERSHIP_TOKEN_ENV,
  bindDaemonOwnershipPid,
  daemonOwnershipTokenHash,
  loadDaemonOwnershipRecord,
  removeDaemonOwnershipRecord,
} from './daemon-ownership.js';
import { getDaemonHealth, requestDaemonShutdown } from './daemon-transport.js';

describe('WTSCLI daemon lifecycle ownership', () => {
  const originalHooks = { ...daemonLifecycleHooks };
  const originalProcessHooks = { ...daemonProcessHooks };
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtscli-lifecycle-ownership-'));
    vi.stubEnv('WTSCLI_CONFIG_DIR', root);
  });

  afterEach(() => {
    Object.assign(daemonLifecycleHooks, originalHooks);
    Object.assign(daemonProcessHooks, originalProcessHooks);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never kills a stale process by trusting only the PID from a status response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        pid: 424242,
        uptime: 10,
        daemonVersion: `${PKG_VERSION}-stale`,
        extensionConnected: false,
        pending: 0,
        memoryMB: 1,
        port: 19826,
      }),
    })));
    daemonLifecycleHooks.requestDaemonShutdown = vi.fn(async () => false);
    daemonLifecycleHooks.waitForDaemonStop = vi.fn(async () => false);
    daemonLifecycleHooks.spawnDaemonProcess = vi.fn();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await expect(ensureBrowserBridgeReady({ timeoutSeconds: 1, verbose: false }))
      .rejects.toBeInstanceOf(Error);

    expect(kill).not.toHaveBeenCalled();
    expect(daemonLifecycleHooks.spawnDaemonProcess).not.toHaveBeenCalled();
  });

  it('converges concurrent first starts on exactly one authenticated daemon owner', async () => {
    const harness = createDaemonHarness();
    const childSpawn = vi.fn((_binary: string, _args: readonly string[], options: SpawnOptions) => {
      return harness.startOwnedChild(options, 41001);
    });
    daemonProcessHooks.spawn = childSpawn;
    vi.stubGlobal('fetch', harness.fetch);

    const [first, second] = await Promise.all([
      ensureBrowserBridgeReady({ timeoutSeconds: 2, verbose: false }),
      ensureBrowserBridgeReady({ timeoutSeconds: 2, verbose: false }),
    ]);

    expect(childSpawn).toHaveBeenCalledTimes(1);
    expect(first.health.state).toBe('ready');
    expect(second.health.state).toBe('ready');
    expect([first.spawnedProcess, second.spawnedProcess].filter(Boolean)).toHaveLength(1);
    const record = loadDaemonOwnershipRecord();
    expect(record?.tokenHash).toBe(harness.ownerHash());
    expect(first.health.status?.ownerTokenHash).toBe(record?.tokenHash);
    expect(second.health.status?.ownerTokenHash).toBe(record?.tokenHash);

    expect(await requestDaemonShutdown()).toBe(true);
    expect((await getDaemonHealth()).state).toBe('stopped');
    expect(loadDaemonOwnershipRecord()).toBeNull();
  });

  it('releases a failed winner reservation and lets one waiter safely take over', async () => {
    const harness = createDaemonHarness();
    let attempt = 0;
    const childSpawn = vi.fn((_binary: string, _args: readonly string[], options: SpawnOptions) => {
      attempt += 1;
      if (attempt === 1) {
        const failed = harness.newChild(42001);
        queueMicrotask(() => failed.emit('error', new Error('controlled launch failure')));
        return failed as unknown as ChildProcess;
      }
      return harness.startOwnedChild(options, 42002);
    });
    daemonProcessHooks.spawn = childSpawn;
    vi.stubGlobal('fetch', harness.fetch);

    const [first, second] = await Promise.all([
      ensureBrowserBridgeReady({ timeoutSeconds: 2, verbose: false }),
      ensureBrowserBridgeReady({ timeoutSeconds: 2, verbose: false }),
    ]);

    expect(childSpawn).toHaveBeenCalledTimes(2);
    expect(first.health.state).toBe('ready');
    expect(second.health.state).toBe('ready');
    expect(loadDaemonOwnershipRecord()?.tokenHash).toBe(harness.ownerHash());

    expect(await requestDaemonShutdown()).toBe(true);
    expect((await getDaemonHealth()).state).toBe('stopped');
    expect(loadDaemonOwnershipRecord()).toBeNull();
  });
});

function createDaemonHarness() {
  let initialRequests = 0;
  let releaseInitial!: () => void;
  const initialBarrier = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  let running = false;
  let ownerToken: string | null = null;

  const stoppedError = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:19826'), {
    code: 'ECONNREFUSED',
  });
  const response = (body: unknown, ownerHash: string) => new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      [WTSCLI_RUNTIME_IDENTITY.transport.responseHeader.name]:
        WTSCLI_RUNTIME_IDENTITY.transport.responseHeader.value,
      [WTSCLI_RUNTIME_IDENTITY.transport.ownerProofHeader.name]: ownerHash,
    },
  });
  const newChild = (pid: number) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      unref: ReturnType<typeof vi.fn>;
    };
    child.pid = pid;
    child.unref = vi.fn();
    return child;
  };

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (initialRequests < 2) {
      initialRequests += 1;
      if (initialRequests === 2) releaseInitial();
      await initialBarrier;
      throw stoppedError();
    }
    if (!running || !ownerToken) throw stoppedError();
    const ownerHash = daemonOwnershipTokenHash(ownerToken);
    if (url.endsWith('/shutdown')) {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.[WTSCLI_RUNTIME_IDENTITY.transport.ownershipHeader.name]).toBe(ownerToken);
      running = false;
      removeDaemonOwnershipRecord(ownerToken);
      return response({ ok: true }, ownerHash);
    }
    return response({
      ok: true,
      pid: loadDaemonOwnershipRecord()?.pid ?? 0,
      uptime: 1,
      daemonVersion: PKG_VERSION,
      ownerTokenHash: ownerHash,
      extensionConnected: true,
      pending: 0,
      memoryMB: 1,
      port: WTSCLI_RUNTIME_IDENTITY.endpoint.port,
    }, ownerHash);
  });

  return {
    fetch,
    newChild,
    startOwnedChild(options: SpawnOptions, pid: number): ChildProcess {
      const token = options.env?.[DAEMON_OWNERSHIP_TOKEN_ENV];
      if (typeof token !== 'string') throw new Error('Missing daemon ownership token');
      ownerToken = token;
      bindDaemonOwnershipPid(token, pid);
      running = true;
      return newChild(pid) as unknown as ChildProcess;
    },
    ownerHash: () => ownerToken ? daemonOwnershipTokenHash(ownerToken) : null,
  };
}
