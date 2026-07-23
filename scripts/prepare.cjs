const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolveNpmInvocation } = require('./npm-invocation.cjs');

if (process.env.WTSCLI_SKIP_PREPARE_BUILD === '1' || !fs.existsSync('src')) {
  process.exit(0);
}

const invocation = resolveNpmInvocation({
  platform: process.platform,
  nodeExecPath: process.execPath,
  npmExecPath: process.env.npm_execpath,
});
const result = spawnSync(
  invocation.command,
  invocation.args,
  invocation.options,
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
