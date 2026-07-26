import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserBridge } from './bridge.js';
import * as daemonLifecycle from './daemon-lifecycle.js';


describe('BrowserBridge readiness deadline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates the default timeout to the daemon lifecycle single source of truth', async () => {
    const unavailable = new Error('readiness probe stopped');
    const ensureReady = vi
      .spyOn(daemonLifecycle, 'ensureBrowserBridgeReady')
      .mockRejectedValue(unavailable);

    await expect(new BrowserBridge().connect({ session: 'default-deadline' }))
      .rejects.toBe(unavailable);

    expect(ensureReady).toHaveBeenCalledWith({ contextId: undefined });
  });

  it('preserves an explicit caller timeout', async () => {
    const unavailable = new Error('readiness probe stopped');
    const ensureReady = vi
      .spyOn(daemonLifecycle, 'ensureBrowserBridgeReady')
      .mockRejectedValue(unavailable);

    await expect(new BrowserBridge().connect({
      session: 'explicit-deadline',
      timeout: 7,
    })).rejects.toBe(unavailable);

    expect(ensureReady).toHaveBeenCalledWith({
      timeoutSeconds: 7,
      contextId: undefined,
    });
  });
});
