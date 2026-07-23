import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  daemonLifecycleHooks,
  ensureBrowserBridgeReady,
} from '../../src/browser/daemon-lifecycle.js';
import { WTSCLI_RUNTIME_IDENTITY } from '../../src/runtime-identity.js';
import { parseJsonOutput, runCli } from './helpers.js';

// Match the running CLI's package version so BrowserBridge does not classify
// this fake daemon as stale (PR #1399 auto-restarts daemons whose
// daemonVersion does not match PKG_VERSION; the fake daemon does not implement
// /shutdown, so a mismatch makes every test exit with code 1).
const PKG_VERSION: string = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // tests/e2e -> repo root: ../..
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch {
    return '0.0.0';
  }
})();

type FakeTab = {
  page: string;
  url: string;
  title: string;
  active: boolean;
};

type FakeDaemon = {
  close: () => Promise<void>;
  env: Record<string, string>;
  legacyRequests: () => number;
  maxInFlightExec: () => number;
  wtsRequests: () => number;
};

const LEGACY_DAEMON_PORT = 19825;
const DAEMON_PORT = WTSCLI_RUNTIME_IDENTITY.endpoint.port;
const REQUEST_MARKER = WTSCLI_RUNTIME_IDENTITY.transport.requestHeader;
const RESPONSE_MARKER = WTSCLI_RUNTIME_IDENTITY.transport.responseHeader;
const OWNER_PROOF_HEADER = WTSCLI_RUNTIME_IDENTITY.transport.ownerProofHeader.name;
const OWNERSHIP_HEADER = WTSCLI_RUNTIME_IDENTITY.transport.ownershipHeader.name;

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(
  res: ServerResponse,
  status: number,
  payload: unknown,
  identityHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...identityHeaders });
  res.end(JSON.stringify(payload));
}

async function listenWithoutDisplacing(server: Server, port: number, label: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new Error(
        `Refusing to disturb the existing ${label} endpoint on 127.0.0.1:${port}; ` +
        'the fixed-port coexistence test requires an unused port.',
      );
    }
    throw error;
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function createTestOwnership(): {
  configDir: string;
  token: string;
  tokenHash: string;
  env: Record<string, string>;
} {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtscli-fixed-port-'));
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const ownershipPath = path.join(configDir, 'daemon', 'ownership.json');
  fs.mkdirSync(path.dirname(ownershipPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ownershipPath, `${JSON.stringify({
    schemaVersion: 'wtscli.daemon_ownership.v1',
    endpoint: { host: '127.0.0.1', port: DAEMON_PORT },
    token,
    tokenHash,
    createdAt: new Date(0).toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    configDir,
    token,
    tokenHash,
    env: {
      WTSCLI_CONFIG_DIR: configDir,
      WTSCLI_CACHE_DIR: path.join(configDir, 'cache'),
    },
  };
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const ownership = createTestOwnership();
  const identityHeaders = {
    [RESPONSE_MARKER.name]: RESPONSE_MARKER.value,
    [OWNER_PROOF_HEADER]: ownership.tokenHash,
  };
  let legacyRequestCount = 0;
  let wtsRequestCount = 0;
  const legacyServer = createServer((_req, res) => {
    legacyRequestCount++;
    json(res, 200, { ok: true, product: 'legacy-opencli' }, { 'X-OpenCLI': '1' });
  });

  const tabs = new Map<string, FakeTab>([
    ['tab-1', { page: 'tab-1', url: 'https://one.example/', title: 'tab-one', active: true }],
    ['tab-2', { page: 'tab-2', url: 'https://two.example/', title: 'tab-two', active: false }],
  ]);
  let nextId = 3;
  let inFlightExec = 0;
  let maxInFlightExec = 0;

  const server = createServer(async (req, res) => {
    wtsRequestCount++;
    const pathname = req.url?.split('?')[0] ?? '/';
    if (req.headers[REQUEST_MARKER.name.toLowerCase()] !== REQUEST_MARKER.value) {
      json(res, 403, { ok: false, error: 'missing WTS request marker' }, identityHeaders);
      return;
    }

    if (req.method === 'GET' && pathname === '/status') {
      json(res, 200, {
        ok: true,
        pid: process.pid,
        uptime: 1,
        daemonVersion: PKG_VERSION,
        extensionConnected: true,
        extensionVersion: 'test',
        pending: 0,
        memoryMB: 1,
        port: DAEMON_PORT,
      }, identityHeaders);
      return;
    }

    if (req.method !== 'POST' || pathname !== '/command') {
      json(res, 404, { ok: false, error: 'Not found' }, identityHeaders);
      return;
    }

    if (req.headers[OWNERSHIP_HEADER.toLowerCase()] !== ownership.token) {
      json(res, 409, {
        ok: false,
        errorCode: 'port_occupied_by_foreign_process',
        error: 'missing WTS ownership proof',
      }, identityHeaders);
      return;
    }

    const body = JSON.parse(await readBody(req)) as {
      id: string;
      action: string;
      op?: string;
      page?: string;
      index?: number;
      url?: string;
      code?: string;
    };

    const listTabs = () => [...tabs.values()].map((tab, index) => ({ index, ...tab }));
    const tabByIndex = (index?: number) => index === undefined ? undefined : listTabs()[index];

    switch (body.action) {
      case 'tabs': {
        switch (body.op) {
          case 'list':
            json(res, 200, { id: body.id, ok: true, data: listTabs() }, identityHeaders);
            return;
          case 'new': {
            const page = `tab-${nextId++}`;
            const url = body.url ?? 'about:blank';
            tabs.set(page, {
              page,
              url,
              title: page,
              active: true,
            });
            json(res, 200, { id: body.id, ok: true, page, data: { url } }, identityHeaders);
            return;
          }
          case 'close': {
            const targetPage = typeof body.page === 'string' ? body.page : tabByIndex(body.index)?.page;
            if (!targetPage || !tabs.has(targetPage)) {
              json(res, 200, { id: body.id, ok: false, error: 'Tab not found' }, identityHeaders);
              return;
            }
            tabs.delete(targetPage);
            json(res, 200, { id: body.id, ok: true, data: { closed: targetPage } }, identityHeaders);
            return;
          }
          case 'select': {
            const targetPage = typeof body.page === 'string' ? body.page : tabByIndex(body.index)?.page;
            if (!targetPage || !tabs.has(targetPage)) {
              json(res, 200, { id: body.id, ok: false, error: 'Tab not found' }, identityHeaders);
              return;
            }
            json(res, 200, { id: body.id, ok: true, page: targetPage, data: { selected: true } }, identityHeaders);
            return;
          }
          default:
            json(res, 200, { id: body.id, ok: false, error: `Unknown tabs op: ${body.op}` }, identityHeaders);
            return;
        }
      }
      case 'navigate': {
        const targetPage = typeof body.page === 'string' && tabs.has(body.page) ? body.page : 'tab-1';
        const target = tabs.get(targetPage)!;
        const url = body.url ?? target.url;
        target.url = url;
        target.title = url;
        json(res, 200, {
          id: body.id,
          ok: true,
          page: targetPage,
          data: { title: target.title, url: target.url, timedOut: false },
        }, identityHeaders);
        return;
      }
      case 'exec': {
        const targetPage = typeof body.page === 'string' ? body.page : 'tab-1';
        const target = tabs.get(targetPage);
        if (!target) {
          json(res, 200, { id: body.id, ok: false, error: `Unknown page: ${targetPage}` }, identityHeaders);
          return;
        }

        inFlightExec++;
        maxInFlightExec = Math.max(maxInFlightExec, inFlightExec);
        try {
          if ((body.code ?? '').includes('__delay')) {
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          json(res, 200, {
            id: body.id,
            ok: true,
            page: targetPage,
            data: {
              page: targetPage,
              title: target.title,
              url: target.url,
            },
          }, identityHeaders);
        } finally {
          inFlightExec--;
        }
        return;
      }
      default:
        json(res, 200, { id: body.id, ok: false, error: `Unknown action: ${body.action}` }, identityHeaders);
    }
  });

  try {
    await listenWithoutDisplacing(legacyServer, LEGACY_DAEMON_PORT, 'legacy OpenCLI');
    await listenWithoutDisplacing(server, DAEMON_PORT, 'WTSCLI');
  } catch (error) {
    await closeServer(server);
    await closeServer(legacyServer);
    fs.rmSync(ownership.configDir, { recursive: true, force: true });
    throw error;
  }

  return {
    close: async () => {
      await closeServer(server);
      await closeServer(legacyServer);
      fs.rmSync(ownership.configDir, { recursive: true, force: true });
    },
    env: ownership.env,
    legacyRequests: () => legacyRequestCount,
    maxInFlightExec: () => maxInFlightExec,
    wtsRequests: () => wtsRequestCount,
  };
}

describe('browser tab CLI e2e', () => {
  const daemons: FakeDaemon[] = [];
  const cacheDirs: string[] = [];
  const browserArgs = (session: string, ...args: string[]) => ['browser', session, ...args];
  const originalLifecycleHooks = { ...daemonLifecycleHooks };

  afterEach(async () => {
    while (daemons.length > 0) {
      await daemons.pop()!.close();
    }
    while (cacheDirs.length > 0) {
      fs.rmSync(cacheDirs.pop()!, { recursive: true, force: true });
    }
    Object.assign(daemonLifecycleHooks, originalLifecycleHooks);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fails closed on a foreign 19826 occupant without shutdown, restart, or kill', async () => {
    const ownership = createTestOwnership();
    const requests: Array<{ method: string; path: string }> = [];
    const foreignServer = createServer((req, res) => {
      requests.push({ method: req.method ?? '', path: req.url ?? '' });
      json(res, 200, {
        ok: true,
        pid: 99999,
        daemonVersion: PKG_VERSION,
        extensionConnected: true,
        port: DAEMON_PORT,
      }, { 'X-OpenCLI': '1' });
    });
    await listenWithoutDisplacing(foreignServer, DAEMON_PORT, 'foreign');
    vi.stubEnv('WTSCLI_CONFIG_DIR', ownership.configDir);
    vi.stubEnv('WTSCLI_CACHE_DIR', ownership.env.WTSCLI_CACHE_DIR);
    daemonLifecycleHooks.spawnDaemonProcess = vi.fn();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      await expect(ensureBrowserBridgeReady({ timeoutSeconds: 1, verbose: false }))
        .rejects.toMatchObject({ code: 'port_occupied_by_foreign_process' });
      expect(requests).toEqual([{ method: 'GET', path: '/status' }]);
      expect(daemonLifecycleHooks.spawnDaemonProcess).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await closeServer(foreignServer);
      fs.rmSync(ownership.configDir, { recursive: true, force: true });
    }
  });

  it('uses the WTS runtime while a legacy endpoint remains simultaneously available', async () => {
    const daemon = await startFakeDaemon();
    daemons.push(daemon);
    const session = 'tabs-basic';

    const listed = await runCli(browserArgs(session, 'tab', 'list'), { env: daemon.env });
    expect(listed.code).toBe(0);
    const listData = parseJsonOutput(listed.stdout);
    expect(listData).toEqual(expect.arrayContaining([
      expect.objectContaining({ page: 'tab-1', title: 'tab-one' }),
      expect.objectContaining({ page: 'tab-2', title: 'tab-two' }),
    ]));

    const created = await runCli(browserArgs(session, 'tab', 'new', 'https://three.example/'), { env: daemon.env });
    expect(created.code).toBe(0);
    const createdData = parseJsonOutput(created.stdout);
    expect(createdData).toEqual(expect.objectContaining({
      page: 'tab-3',
      url: 'https://three.example/',
    }));

    const closed = await runCli(browserArgs(session, 'tab', 'close', 'tab-3'), { env: daemon.env });
    expect(closed.code).toBe(0);
    const closedData = parseJsonOutput(closed.stdout);
    expect(closedData).toEqual({ closed: 'tab-3' });

    const relisted = await runCli(browserArgs(session, 'tab', 'list'), { env: daemon.env });
    expect(relisted.code).toBe(0);
    const relistedData = parseJsonOutput(relisted.stdout);
    expect(relistedData).toHaveLength(2);
    expect(relistedData.some((tab: { page: string }) => tab.page === 'tab-3')).toBe(false);
    expect(daemon.wtsRequests()).toBeGreaterThan(0);
    expect(daemon.legacyRequests()).toBe(0);
  }, 30_000);

  it('routes concurrent browser commands to their requested tabs', async () => {
    const daemon = await startFakeDaemon();
    daemons.push(daemon);
    const session = 'tabs-concurrent';

    const [left, right] = await Promise.all([
      runCli(browserArgs(session, 'eval', '--tab', 'tab-1', 'window.__delay = "left"'), { timeout: 30_000, env: daemon.env }),
      runCli(browserArgs(session, 'eval', '--tab', 'tab-2', 'window.__delay = "right"'), { timeout: 30_000, env: daemon.env }),
    ]);

    expect(left.code).toBe(0);
    expect(right.code).toBe(0);

    const leftData = parseJsonOutput(left.stdout);
    const rightData = parseJsonOutput(right.stdout);

    expect(leftData).toEqual(expect.objectContaining({ page: 'tab-1', title: 'tab-one' }));
    expect(rightData).toEqual(expect.objectContaining({ page: 'tab-2', title: 'tab-two' }));
    expect(daemon.maxInFlightExec()).toBe(2);
  }, 30_000);

  it('keeps untargeted browser commands on the default tab after creating a new tab', async () => {
    const daemon = await startFakeDaemon();
    daemons.push(daemon);
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtscli-browser-tabs-'));
    cacheDirs.push(cacheDir);
    const env = {
      ...daemon.env,
      WTSCLI_CACHE_DIR: cacheDir,
    };
    const session = 'tabs-default-new';

    const created = await runCli(browserArgs(session, 'tab', 'new', 'https://three.example/'), { env });
    expect(created.code).toBe(0);
    expect(parseJsonOutput(created.stdout)).toEqual(expect.objectContaining({ page: 'tab-3' }));

    const untargeted = await runCli(browserArgs(session, 'eval', 'document.title'), { env });
    expect(untargeted.code).toBe(0);
    expect(parseJsonOutput(untargeted.stdout)).toEqual(expect.objectContaining({ page: 'tab-1', title: 'tab-one' }));
  }, 30_000);

  it('uses an explicitly selected tab as the default target for later untargeted commands', async () => {
    const daemon = await startFakeDaemon();
    daemons.push(daemon);
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtscli-browser-tabs-'));
    cacheDirs.push(cacheDir);
    const env = {
      ...daemon.env,
      WTSCLI_CACHE_DIR: cacheDir,
    };
    const session = 'tabs-selected-default';

    const selected = await runCli(browserArgs(session, 'tab', 'select', 'tab-2'), { env });
    expect(selected.code).toBe(0);
    expect(parseJsonOutput(selected.stdout)).toEqual({ selected: 'tab-2' });

    const untargeted = await runCli(browserArgs(session, 'eval', 'document.title'), { env });
    expect(untargeted.code).toBe(0);
    expect(parseJsonOutput(untargeted.stdout)).toEqual(expect.objectContaining({ page: 'tab-2', title: 'tab-two' }));

    const closed = await runCli(browserArgs(session, 'tab', 'close', 'tab-2'), { env });
    expect(closed.code).toBe(0);
    expect(parseJsonOutput(closed.stdout)).toEqual({ closed: 'tab-2' });

    const fallback = await runCli(browserArgs(session, 'eval', 'document.title'), { env });
    expect(fallback.code).toBe(0);
    expect(parseJsonOutput(fallback.stdout)).toEqual(expect.objectContaining({ page: 'tab-1', title: 'tab-one' }));
  }, 30_000);
});
