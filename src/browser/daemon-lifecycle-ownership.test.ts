import { afterEach, describe, expect, it, vi } from 'vitest';

import { PKG_VERSION } from '../version.js';
import {
  daemonLifecycleHooks,
  ensureBrowserBridgeReady,
} from './daemon-lifecycle.js';

describe('WTSCLI daemon lifecycle ownership', () => {
  const originalHooks = { ...daemonLifecycleHooks };

  afterEach(() => {
    Object.assign(daemonLifecycleHooks, originalHooks);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
});
