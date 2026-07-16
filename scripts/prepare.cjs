const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

if (process.env.WTSCLI_SKIP_PREPARE_BUILD === '1' || !fs.existsSync('src')) {
  process.exit(0);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'build'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
