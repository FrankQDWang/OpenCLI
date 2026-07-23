import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_DAEMON_PORT, isIgnorableDaemonPortEnv } from './constants.js';
import {
  bashCompletionScript,
  fishCompletionScript,
  zshCompletionScript,
} from './completion-shared.js';
import { getResponseCorsHeaders } from './daemon-utils.js';
import * as daemonUtils from './daemon-utils.js';
import { loadProfileConfig } from './browser/profile.js';
import { getWtscliCacheDir, getWtscliStateRoot } from './runtime-identity.js';
import { DAEMON_PORT as EXTENSION_DAEMON_PORT } from '../extension/src/protocol.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WTS_EXTENSION_ID = 'aijmoehobdolindhgdljiaiimngpghcn';
const WTS_EXTENSION_ORIGIN = `chrome-extension://${WTS_EXTENSION_ID}`;

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')) as Record<string, any>;
}

function productionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionFiles(absolute));
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
      && !entry.name.includes('.test.')
    ) {
      files.push(absolute);
    }
  }
  return files;
}

describe('WTSCLI product identity boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the distinct fixed WTS endpoint in both runtime and extension', () => {
    expect(DEFAULT_DAEMON_PORT).toBe(19826);
    expect(EXTENSION_DAEMON_PORT).toBe(19826);
    expect(isIgnorableDaemonPortEnv(undefined)).toBe(true);
    expect(isIgnorableDaemonPortEnv('19826')).toBe(true);
    expect(isIgnorableDaemonPortEnv('19825')).toBe(false);
  });

  it('publishes only the canonical wtscli package and executable', () => {
    const pkg = readJson('package.json');
    expect(pkg.name).toBe('wtscli');
    expect(pkg.bin).toEqual({ wtscli: 'dist/src/main.js' });
    expect(pkg.scripts.prebuildManifest ?? pkg.scripts['prebuild-manifest']).toContain(
      'install-internal-compat.js --compat-only',
    );
    expect(pkg.scripts.preuninstall).not.toContain('19825');
    expect(pkg.scripts.preuninstall).not.toContain('X-OpenCLI');

    const internalCompat = readJson('internal/opencli-compat/package.json');
    expect(internalCompat).toMatchObject({
      name: '@jackwener/opencli',
      private: true,
    });
    expect(internalCompat.bin).toBeUndefined();

    for (const completion of [
      bashCompletionScript(),
      zshCompletionScript(),
      fishCompletionScript(),
    ]) {
      expect(completion).toContain('wtscli');
      expect(completion).not.toMatch(/\bopencli(?:\s|$)/m);
    }
  });

  it('keeps every consumer-facing identity field in the versioned bridge source of truth', () => {
    const identity = readJson('bridge-identity.json');
    expect(identity).toMatchObject({
      schemaVersion: 'wtscli.bridge_identity.v1',
      implementation: 'seektalent-wtscli',
      runtimeIdentity: {
        endpoint: { host: '127.0.0.1', port: 19826 },
        transport: {
          requestHeader: { name: 'X-WTSCLI', value: '1' },
          responseHeader: {
            name: 'X-WTSCLI-Bridge',
            value: 'wtscli.browser-bridge.v1',
          },
          protocol: {
            name: 'wtscli.browser-bridge',
            version: { major: 1, minor: 0 },
          },
        },
        extension: {
          id: WTS_EXTENSION_ID,
          origin: WTS_EXTENSION_ORIGIN,
        },
        state: {
          rootDir: '~/.seektalent/wtscli',
          envPrefix: 'WTSCLI_',
          configDirEnv: 'WTSCLI_CONFIG_DIR',
          cacheDirEnv: 'WTSCLI_CACHE_DIR',
          ownershipFile: 'daemon/ownership.json',
        },
        package: {
          name: 'wtscli',
          entrypoint: 'wtscli',
        },
      },
    });
  });

  it('binds the exact accepted extension id to the packaged manifest key', () => {
    const manifest = readJson('extension/manifest.json');
    const digest = createHash('sha256')
      .update(Buffer.from(String(manifest.key), 'base64'))
      .digest()
      .subarray(0, 16);
    const extensionId = [...digest]
      .flatMap((byte) => [byte >> 4, byte & 0x0f])
      .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
      .join('');

    expect(extensionId).toBe(WTS_EXTENSION_ID);
  });

  it('allows CORS and WebSocket admission only for the exact WTS extension origin', () => {
    expect(getResponseCorsHeaders('/ping', WTS_EXTENSION_ORIGIN)).toEqual(expect.objectContaining({
      'Access-Control-Allow-Origin': WTS_EXTENSION_ORIGIN,
    }));
    expect(getResponseCorsHeaders('/ping', 'chrome-extension://legacyopencliid')).toBeUndefined();
    expect(getResponseCorsHeaders('/ping', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')).toBeUndefined();
    expect(getResponseCorsHeaders('/ping')).toBeUndefined();

    const exactOriginCheck = (daemonUtils as Record<string, unknown>).isAllowedWtsExtensionOrigin;
    expect(exactOriginCheck).toBeTypeOf('function');
    expect((exactOriginCheck as (origin: string | undefined) => boolean)(WTS_EXTENSION_ORIGIN)).toBe(true);
    expect((exactOriginCheck as (origin: string | undefined) => boolean)(undefined)).toBe(false);
    expect((exactOriginCheck as (origin: string | undefined) => boolean)('chrome-extension://legacyopencliid')).toBe(false);
    expect((exactOriginCheck as (origin: string | undefined) => boolean)('chrome-extension://')).toBe(false);
  });

  it('uses WTSCLI config authority and ignores the legacy OPENCLI namespace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wtscli-state-red-'));
    const wtsConfig = path.join(root, 'wts');
    const legacyConfig = path.join(root, 'legacy');
    fs.mkdirSync(wtsConfig, { recursive: true });
    fs.mkdirSync(legacyConfig, { recursive: true });
    fs.writeFileSync(
      path.join(wtsConfig, 'browser-profiles.json'),
      JSON.stringify({ version: 1, defaultContextId: 'wts-profile', aliases: {} }),
    );
    fs.writeFileSync(
      path.join(legacyConfig, 'browser-profiles.json'),
      JSON.stringify({ version: 1, defaultContextId: 'legacy-profile', aliases: {} }),
    );
    vi.stubEnv('WTSCLI_CONFIG_DIR', wtsConfig);
    vi.stubEnv('OPENCLI_CONFIG_DIR', legacyConfig);

    expect(loadProfileConfig().defaultContextId).toBe('wts-profile');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('derives runtime and installer state paths from the versioned identity', () => {
    const identity = readJson('bridge-identity.json');
    expect(identity.runtimeIdentity.state.rootDir).toBe('~/.seektalent/wtscli');
    expect(getWtscliStateRoot()).toBe(path.join(os.homedir(), '.seektalent', 'wtscli'));

    for (const installer of ['scripts/fetch-adapters.js', 'scripts/postinstall.js']) {
      const source = fs.readFileSync(path.join(ROOT, installer), 'utf8');
      expect(source).toContain(`from './runtime-identity.js'`);
      expect(source).not.toContain(`join(homedir(), '.seektalent'`);
    }
  });

  it('rejects WTS state overrides that target the legacy OpenCLI directory', () => {
    vi.stubEnv('WTSCLI_CONFIG_DIR', path.join(os.homedir(), '.opencli'));
    expect(() => getWtscliStateRoot()).toThrow('must not point to the legacy OpenCLI state directory');

    vi.stubEnv('WTSCLI_CONFIG_DIR', '');
    vi.stubEnv('WTSCLI_CACHE_DIR', path.join(os.homedir(), '.opencli', 'cache'));
    expect(() => getWtscliCacheDir()).toThrow('must not point to the legacy OpenCLI state directory');
  });

  it('has no production state or environment authority in the legacy namespace', () => {
    const files = [
      ...productionFiles(path.join(ROOT, 'src')),
      ...productionFiles(path.join(ROOT, 'scripts')),
    ];
    const violations: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const relative = path.relative(ROOT, file);
      const isLegacyPathRejectionGuard = (
        relative === 'src/runtime-identity.ts'
        || relative === 'scripts/runtime-identity.js'
      ) && source.includes('must not point to the legacy OpenCLI state directory');
      if (/process\.env(?:\.OPENCLI_|\[['"]OPENCLI_)/.test(source)) {
        violations.push(`${relative}: legacy env authority`);
      }
      if (
        !isLegacyPathRejectionGuard
        && /(?:homedir\(\)|getHomeDir\(\)|\bhome\b)[^\n]{0,100}['"]\.opencli['"]/.test(source)
      ) {
        violations.push(`${relative}: legacy state path`);
      }
      if (
        !isLegacyPathRejectionGuard
        && (
          /(?:path\.)?join\([^\n]*['"]\.opencli['"]/.test(source)
          || /homedir\(\)\}\/\.opencli/.test(source)
        )
      ) {
        violations.push(`${relative}: legacy state path`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('has no legacy endpoint, transport marker, or storage authority in WTS extension production code', () => {
    const files = productionFiles(path.join(ROOT, 'extension', 'src'));
    const violations = files.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      const reasons: string[] = [];
      if (/\b19825\b/.test(source)) reasons.push('legacy port');
      if (/X-OpenCLI/i.test(source)) reasons.push('legacy transport marker');
      if (/['"]opencli_(?:context|command_journal|target_lease|control)/.test(source)) {
        reasons.push('legacy extension storage key');
      }
      return reasons.map((reason) => `${path.relative(ROOT, file)}: ${reason}`);
    });
    expect(violations).toEqual([]);
  });
});
