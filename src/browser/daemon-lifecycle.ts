import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_DAEMON_PORT } from '../constants.js';
import { BrowserConnectError } from '../errors.js';
import { PKG_VERSION } from '../version.js';
import { waitForBridgeReady } from './bridge-readiness.js';
import { fetchDaemonStatus, getDaemonHealth, requestDaemonShutdown, type DaemonHealth, type DaemonStatus } from './daemon-transport.js';
import {
  DAEMON_OWNERSHIP_TOKEN_ENV,
  bindDaemonOwnershipPid,
  prepareDaemonOwnership,
  removeDaemonOwnershipRecord,
} from './daemon-ownership.js';

export interface DaemonLaunchSpec {
  binary: string;
  args: string[];
  scriptPath: string;
}

export interface DaemonRestartResult {
  previousStatus: DaemonStatus | null;
  status: DaemonStatus | null;
  stopped: boolean;
  spawned: boolean;
}

export interface EnsureBrowserBridgeReadyResult {
  health: DaemonHealth;
  spawnedProcess: ChildProcess | null;
}

export function resolveDaemonLaunchSpec(): DaemonLaunchSpec {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const parentDir = path.resolve(__dirname, '..');
  const daemonTs = path.join(parentDir, 'daemon.ts');
  const daemonJs = path.join(parentDir, 'daemon.js');
  const isTs = fs.existsSync(daemonTs);
  const scriptPath = isTs ? daemonTs : daemonJs;
  return {
    binary: process.execPath,
    args: isTs ? ['--import', 'tsx/esm', scriptPath] : [scriptPath],
    scriptPath,
  };
}

export function spawnDaemonProcess(): ChildProcess {
  const launch = resolveDaemonLaunchSpec();
  const ownership = prepareDaemonOwnership();
  try {
    const proc = spawn(launch.binary, launch.args, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        [DAEMON_OWNERSHIP_TOKEN_ENV]: ownership.token,
      },
    });
    bindDaemonOwnershipPid(ownership.token, proc.pid);
    proc.once('error', () => removeDaemonOwnershipRecord(ownership.token));
    proc.once('exit', () => removeDaemonOwnershipRecord(ownership.token));
    proc.unref();
    return proc;
  } catch (error) {
    removeDaemonOwnershipRecord(ownership.token);
    throw error;
  }
}

export async function waitForDaemonStop(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const h = await getDaemonHealth();
    if (h.state === 'stopped') return true;
  }
  return false;
}

export async function waitForDaemonStatus(timeoutMs: number): Promise<DaemonStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetchDaemonStatus({ timeout: Math.min(1000, Math.max(100, deadline - Date.now())) });
    if (status) return status;
    await sleep(200);
  }
  return null;
}

export const daemonLifecycleHooks = {
  requestDaemonShutdown,
  spawnDaemonProcess,
  waitForDaemonStop,
};

export async function restartDaemon(opts: { stopTimeoutMs?: number; startTimeoutMs?: number } = {}): Promise<DaemonRestartResult> {
  const previousStatus = await fetchDaemonStatus();
  let stopped = previousStatus === null;
  if (previousStatus) {
    const shutdownAccepted = await requestDaemonShutdown();
    stopped = shutdownAccepted && await waitForDaemonStop(opts.stopTimeoutMs ?? 3000);
    if (!stopped) {
      return { previousStatus, status: previousStatus, stopped: false, spawned: false };
    }
  }

  spawnDaemonProcess();
  const status = await waitForDaemonStatus(opts.startTimeoutMs ?? 5000);
  return { previousStatus, status, stopped, spawned: true };
}

export async function ensureBrowserBridgeReady(
  opts: { timeoutSeconds?: number; contextId?: string; verbose?: boolean } = {},
): Promise<EnsureBrowserBridgeReadyResult> {
  const timeoutSeconds = opts.timeoutSeconds && opts.timeoutSeconds > 0 ? opts.timeoutSeconds : 10;
  const timeoutMs = timeoutSeconds * 1000;
  const verbose = opts.verbose ?? true;
  const contextId = opts.contextId;

  const health = await getDaemonHealth({ contextId });
  const daemonVersion = health.status?.daemonVersion;
  const isStale = !!health.status && (!daemonVersion || daemonVersion !== PKG_VERSION);
  let staleDaemonReplaced = false;
  let spawnedProcess: ChildProcess | null = null;

  if (isStale) {
    const reason = daemonVersion
      ? `v${daemonVersion} ≠ v${PKG_VERSION}`
      : `pre-version daemon, CLI is v${PKG_VERSION}`;
    if (verbose && (process.env.WTSCLI_VERBOSE || process.stderr.isTTY)) {
      process.stderr.write(`⚠️  Stale daemon detected (${reason}). Restarting...\n`);
    }
    const shutdownAccepted = await daemonLifecycleHooks.requestDaemonShutdown();
    const portReleased = shutdownAccepted && await daemonLifecycleHooks.waitForDaemonStop(3000);

    if (!portReleased) {
      throw new BrowserConnectError(
        'Stale daemon could not be replaced',
        `A stale WTS-owned daemon (${reason}) did not accept authenticated graceful shutdown and was left untouched.\n` +
        '  Run manually: wtscli daemon stop',
        'daemon-not-running',
      );
    }
    staleDaemonReplaced = true;
  }

  if (!staleDaemonReplaced && health.state === 'ready') {
    return { health, spawnedProcess };
  }

  if (!staleDaemonReplaced && health.state === 'profile-required') {
    throw browserConnectErrorFromHealth(health, contextId);
  }

  if (staleDaemonReplaced || health.state === 'stopped') {
    if (verbose && (process.env.WTSCLI_VERBOSE || process.stderr.isTTY)) {
      process.stderr.write('⏳ Starting daemon...\n');
    }
    spawnedProcess = daemonLifecycleHooks.spawnDaemonProcess();
  } else if (verbose && (process.env.WTSCLI_VERBOSE || process.stderr.isTTY)) {
    process.stderr.write('⏳ Waiting for Chrome/Chromium extension to connect...\n');
    process.stderr.write('   Make sure Chrome or Chromium is open and the WTSCLI extension is enabled.\n');
  }

  const finalHealth = await waitForBridgeReady(getDaemonHealth, { timeoutMs, contextId });
  if (finalHealth.state === 'ready') return { health: finalHealth, spawnedProcess };
  throw browserConnectErrorFromHealth(finalHealth, contextId);
}

function browserConnectErrorFromHealth(health: DaemonHealth, contextId?: string): BrowserConnectError {
  if (health.state === 'profile-required') {
    return new BrowserConnectError(
      'Multiple Browser Bridge profiles are connected',
      'Select one with --profile <name>, WTSCLI_PROFILE=<name>, or wtscli profile use <name>.\n' +
      'Run wtscli profile list to see connected profiles.',
      'profile-required',
    );
  }
  if (health.state === 'profile-disconnected') {
    const label = contextId ?? health.status.contextId ?? 'unknown';
    return new BrowserConnectError(
      `Browser profile "${label}" is not connected`,
      'Open the matching Chrome profile and make sure the WTSCLI extension is enabled, or choose another profile with wtscli profile use <name>.',
      'profile-disconnected',
    );
  }
  if (health.state === 'no-extension') {
    return new BrowserConnectError(
      'Browser Bridge extension not connected',
      'Make sure Chrome/Chromium is open and the WTSCLI extension is enabled.\n' +
      'If not installed:\n' +
      '  1. Download the WTSCLI extension bundled with SeekTalent.\n' +
      '  2. Open chrome://extensions → Developer Mode → Load unpacked',
      'extension-not-connected',
    );
  }
  return new BrowserConnectError(
    'Failed to start WTSCLI daemon',
    `Run: wtscli daemon restart\nMake sure port ${DEFAULT_DAEMON_PORT} is available.`,
    'daemon-not-running',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { DEFAULT_DAEMON_PORT };
