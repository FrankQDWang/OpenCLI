import rawBridgeIdentity from '../../bridge-identity.json';

type ExtensionBridgeIdentity = {
  implementation: string;
  bridgeBuildId: string;
  protocolVersion: { major: number; minor: number };
  capabilities: string[];
  runtimeIdentity: {
    endpoint: { host: string; port: number };
    transport: {
      requestHeader: { name: string; value: string };
      responseHeader: { name: string; value: string };
      protocol: {
        name: string;
        version: { major: number; minor: number };
      };
    };
    extension: { id: string; origin: string };
  };
};

export const EXTENSION_BRIDGE_IDENTITY = rawBridgeIdentity as ExtensionBridgeIdentity;
