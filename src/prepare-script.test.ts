import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type NpmInvocation = {
  command: string;
  args: string[];
  options: {
    shell?: boolean;
    stdio: 'inherit';
  };
};

type ResolveNpmInvocation = (input: {
  platform: NodeJS.Platform;
  nodeExecPath: string;
  npmExecPath?: string;
}) => NpmInvocation;

const { resolveNpmInvocation } = require('../scripts/npm-invocation.cjs') as {
  resolveNpmInvocation: ResolveNpmInvocation;
};

describe('prepare npm invocation', () => {
  it('runs npm through Node on Windows when npm exposes its CLI path', () => {
    expect(resolveNpmInvocation({
      platform: 'win32',
      nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      npmExecPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    })).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
        'run',
        'build',
      ],
      options: {
        stdio: 'inherit',
      },
    });
  });

  it('uses a shell only for the Windows fallback without npm_execpath', () => {
    expect(resolveNpmInvocation({
      platform: 'win32',
      nodeExecPath: 'node.exe',
    })).toEqual({
      command: 'npm.cmd',
      args: ['run', 'build'],
      options: {
        shell: true,
        stdio: 'inherit',
      },
    });
  });
});
