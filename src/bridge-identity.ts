import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BridgeIdentity {
  implementation: string;
  bridgeBuildId: string;
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
    typeof parsed.implementation !== 'string'
    || typeof parsed.bridgeBuildId !== 'string'
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
