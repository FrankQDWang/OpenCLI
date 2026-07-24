import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BridgeIdentity {
  schemaVersion: 'wtscli.bridge_identity.v1';
  implementation: string;
  bridgeBuildId: string;
  runtimeIdentity: {
    endpoint: {
      host: '127.0.0.1';
      port: number;
    };
    transport: {
      requestHeader: {
        name: string;
        value: string;
      };
      responseHeader: {
        name: string;
        value: string;
      };
      ownerProofHeader: {
        name: string;
      };
      ownershipHeader: {
        name: string;
      };
      protocol: {
        name: string;
        version: {
          major: number;
          minor: number;
        };
      };
    };
    extension: {
      id: string;
      origin: string;
    };
    state: {
      rootDir: string;
      envPrefix: 'WTSCLI_';
      configDirEnv: 'WTSCLI_CONFIG_DIR';
      cacheDirEnv: 'WTSCLI_CACHE_DIR';
      ownershipFile: string;
    };
    package: {
      name: 'wtscli';
      entrypoint: 'wtscli';
    };
  };
  protocolVersion: {
    major: number;
    minor: number;
  };
  capabilities: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findBridgeIdentityPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'bridge-identity.json'),
    path.resolve(__dirname, '..', '..', 'bridge-identity.json'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Missing bridge-identity.json');
  return found;
}

function readBridgeIdentity(): BridgeIdentity {
  const parsed = JSON.parse(fs.readFileSync(findBridgeIdentityPath(), 'utf-8')) as Partial<BridgeIdentity>;
  if (
    parsed.schemaVersion !== 'wtscli.bridge_identity.v1'
    || typeof parsed.implementation !== 'string'
    || typeof parsed.bridgeBuildId !== 'string'
    || parsed.runtimeIdentity?.endpoint?.host !== '127.0.0.1'
    || typeof parsed.runtimeIdentity.endpoint.port !== 'number'
    || typeof parsed.runtimeIdentity.transport?.requestHeader?.name !== 'string'
    || typeof parsed.runtimeIdentity.transport.requestHeader.value !== 'string'
    || typeof parsed.runtimeIdentity.transport?.responseHeader?.name !== 'string'
    || typeof parsed.runtimeIdentity.transport.responseHeader.value !== 'string'
    || typeof parsed.runtimeIdentity.transport?.ownerProofHeader?.name !== 'string'
    || typeof parsed.runtimeIdentity.transport?.ownershipHeader?.name !== 'string'
    || typeof parsed.runtimeIdentity.transport?.protocol?.name !== 'string'
    || typeof parsed.runtimeIdentity.transport.protocol.version?.major !== 'number'
    || typeof parsed.runtimeIdentity.transport.protocol.version?.minor !== 'number'
    || typeof parsed.runtimeIdentity.extension?.id !== 'string'
    || parsed.runtimeIdentity.extension.origin !== `chrome-extension://${parsed.runtimeIdentity.extension.id}`
    || parsed.runtimeIdentity.state?.envPrefix !== 'WTSCLI_'
    || parsed.runtimeIdentity.state.configDirEnv !== 'WTSCLI_CONFIG_DIR'
    || parsed.runtimeIdentity.state.cacheDirEnv !== 'WTSCLI_CACHE_DIR'
    || typeof parsed.runtimeIdentity.state.rootDir !== 'string'
    || typeof parsed.runtimeIdentity.state.ownershipFile !== 'string'
    || parsed.runtimeIdentity.package?.name !== 'wtscli'
    || parsed.runtimeIdentity.package.entrypoint !== 'wtscli'
    || typeof parsed.protocolVersion?.major !== 'number'
    || typeof parsed.protocolVersion?.minor !== 'number'
    || !Array.isArray(parsed.capabilities)
    || parsed.capabilities.some((capability) => typeof capability !== 'string')
  ) {
    throw new Error('Invalid bridge-identity.json');
  }
  return parsed as BridgeIdentity;
}

export const BRIDGE_IDENTITY = Object.freeze(readBridgeIdentity());
export const RUNTIME_IDENTITY = Object.freeze(BRIDGE_IDENTITY.runtimeIdentity);
