import { DEFAULT_DAEMON_PORT, isIgnorableDaemonPortEnv, unsupportedDaemonPortEnvMessage } from '../constants.js';
import { PortOccupiedByForeignProcessError } from '../errors.js';
import {
  DEFAULT_DAEMON_HOST,
  WTSCLI_RUNTIME_IDENTITY,
} from '../runtime-identity.js';
import {
  daemonOwnershipRequestHeaders,
  expectedDaemonOwnerHash,
} from './daemon-ownership.js';

const DAEMON_PORT = DEFAULT_DAEMON_PORT;
const DAEMON_URL = `http://${DEFAULT_DAEMON_HOST}:${DAEMON_PORT}`;
const WTSCLI_HEADERS = {
  [WTSCLI_RUNTIME_IDENTITY.transport.requestHeader.name]:
    WTSCLI_RUNTIME_IDENTITY.transport.requestHeader.value,
};

class UnsupportedDaemonPortEnvError extends Error {
  constructor(value: string) {
    super(unsupportedDaemonPortEnvMessage(value));
    this.name = 'UnsupportedDaemonPortEnvError';
  }
}

function assertSupportedDaemonPortEnv(): void {
  const value = process.env.WTSCLI_DAEMON_PORT;
  if (!isIgnorableDaemonPortEnv(value)) throw new UnsupportedDaemonPortEnvError(value!);
}

function errorChainHasCode(error: unknown, expected: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ((current as NodeJS.ErrnoException).code === expected || current.message.includes(expected)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export interface DaemonStatus {
  ok: boolean;
  pid: number;
  uptime: number;
  daemonVersion?: string;
  implementation?: string;
  bridgeBuildId?: string;
  protocolVersion?: { major: number; minor: number };
  transportProtocol?: {
    name: string;
    version: { major: number; minor: number };
  };
  ownerTokenHash?: string;
  capabilities?: string[];
  extensionConnected: boolean;
  extensionVersion?: string;
  extensionCompatRange?: string;
  extensionImplementation?: string;
  extensionBridgeBuildId?: string;
  extensionProtocolVersion?: { major: number; minor: number };
  extensionCapabilities?: string[];
  contextId?: string;
  profileRequired?: boolean;
  profileDisconnected?: boolean;
  profiles?: BrowserProfileStatus[];
  pending: number;
  commandResultUnknown?: number;
  memoryMB: number;
  port: number;
}

export interface BrowserProfileStatus {
  contextId: string;
  extensionConnected: boolean;
  extensionVersion?: string;
  extensionCompatRange?: string;
  implementation?: string;
  bridgeBuildId?: string;
  protocolVersion?: { major: number; minor: number };
  capabilities?: string[];
  pending: number;
  lastSeenAt?: number;
}

export type DaemonHealth =
  | { state: 'stopped'; status: null }
  | { state: 'no-extension'; status: DaemonStatus }
  | { state: 'profile-required'; status: DaemonStatus }
  | { state: 'profile-disconnected'; status: DaemonStatus }
  | { state: 'ready'; status: DaemonStatus };

export async function requestDaemon(pathname: string, init?: RequestInit & { timeout?: number }): Promise<Response> {
  assertSupportedDaemonPortEnv();
  const { timeout = 2000, headers, ...rest } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const expectedOwner = expectedDaemonOwnerHash();
  try {
    const response = await fetch(`${DAEMON_URL}${pathname}`, {
      ...rest,
      headers: {
        ...headers,
        ...WTSCLI_HEADERS,
        ...daemonOwnershipRequestHeaders(),
      },
      signal: controller.signal,
    });
    // Real fetch Response objects always expose Headers. A few unit-test
    // doubles intentionally omit it; production transport never does.
    if (response.headers && typeof response.headers.get === 'function') {
      const marker = response.headers.get(WTSCLI_RUNTIME_IDENTITY.transport.responseHeader.name);
      const owner = response.headers.get(WTSCLI_RUNTIME_IDENTITY.transport.ownerProofHeader.name);
      if (
        marker !== WTSCLI_RUNTIME_IDENTITY.transport.responseHeader.value
        || !expectedOwner
        || owner !== expectedOwner
      ) {
        throw new PortOccupiedByForeignProcessError(
          'The endpoint did not return the exact WTS transport marker and local ownership proof.',
        );
      }
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDaemonStatus(opts?: { timeout?: number; contextId?: string }): Promise<DaemonStatus | null> {
  try {
    const params = opts?.contextId ? `?contextId=${encodeURIComponent(opts.contextId)}` : '';
    const res = await requestDaemon(`/status${params}`, { timeout: opts?.timeout ?? 2000 });
    if (!res.ok) return null;
    return await res.json() as DaemonStatus;
  } catch (err) {
    if (err instanceof UnsupportedDaemonPortEnvError) throw err;
    if (err instanceof PortOccupiedByForeignProcessError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new PortOccupiedByForeignProcessError('The endpoint accepted a connection but did not return a WTS identity before timeout.');
    }
    if (errorChainHasCode(err, 'ECONNREFUSED')) return null;
    throw new PortOccupiedByForeignProcessError(
      `The endpoint failed the WTS identity handshake: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}

export async function getDaemonHealth(opts?: { timeout?: number; contextId?: string }): Promise<DaemonHealth> {
  const status = await fetchDaemonStatus(opts);
  if (!status) return { state: 'stopped', status: null };
  if (status.profileRequired) return { state: 'profile-required', status };
  if (status.profileDisconnected) return { state: 'profile-disconnected', status };
  if (!status.extensionConnected) return { state: 'no-extension', status };
  return { state: 'ready', status };
}

export async function requestDaemonShutdown(opts?: { timeout?: number }): Promise<boolean> {
  try {
    const res = await requestDaemon('/shutdown', { method: 'POST', timeout: opts?.timeout ?? 5000 });
    return res.ok;
  } catch (err) {
    if (err instanceof UnsupportedDaemonPortEnvError) throw err;
    return false;
  }
}
