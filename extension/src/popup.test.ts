import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));
const popupHtml = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
const popupScript = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');

describe('popup connection status', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes from reconnecting to connected while the same popup stays open', async () => {
    vi.useFakeTimers();
    const responses = [
      {
        connected: false,
        reconnecting: true,
        contextId: 'profile-1',
        extensionVersion: '0.1.0',
        daemonVersion: null,
      },
      {
        connected: true,
        reconnecting: false,
        contextId: 'profile-1',
        extensionVersion: '0.1.0',
        daemonVersion: '0.1.0',
      },
    ];
    const sendMessage = vi.fn(
      (_message: unknown, respond: (value: unknown) => void) => {
        respond(responses.shift() ?? responses.at(-1));
      },
    );
    const dom = new JSDOM(popupHtml, {
      runScripts: 'outside-only',
      url: 'chrome-extension://aijmoehobdolindhgdljiaiimngpghcn/popup.html',
    });
    Object.defineProperty(dom.window, 'chrome', {
      value: {
        runtime: {
          lastError: null,
          sendMessage,
        },
      },
    });

    dom.window.eval(popupScript);
    expect(dom.window.document.getElementById('status')?.textContent).toBe('Reconnecting...');

    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(dom.window.document.getElementById('status')?.textContent).toBe('Connected to daemon');
    expect(dom.window.document.getElementById('daemonVersion')?.textContent).toBe('daemon v0.1.0');
    dom.window.close();
  });
});
