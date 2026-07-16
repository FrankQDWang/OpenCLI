import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function parseOutDir(argv) {
  const index = argv.indexOf('--out');
  if (index !== -1 && argv[index + 1]) return path.resolve(argv[index + 1]);
  return path.join(repoRoot, 'seektalent-bundle');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

function git(...args) {
  return run('git', args, { capture: true });
}

async function sha256(filePath) {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

function extensionIdFromManifestKey(key) {
  if (typeof key !== 'string' || !key) throw new Error('Extension manifest must define a stable key.');
  const digest = createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

async function collectFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle output contains an unsupported symlink: ${absolutePath}`);
    if (entry.isDirectory()) files.push(...await collectFiles(rootDir, absolutePath));
    else if (entry.isFile()) files.push(path.relative(rootDir, absolutePath).split(path.sep).join('/'));
  }
  return files;
}

async function describeTree(rootDir) {
  const files = [];
  for (const relativePath of await collectFiles(rootDir)) {
    const absolutePath = path.join(rootDir, relativePath);
    const stats = await fs.stat(absolutePath);
    files.push({ path: relativePath, size: stats.size, sha256: await sha256(absolutePath) });
  }
  const treeSha256 = createHash('sha256')
    .update(files.map((file) => `${file.sha256}  ${file.path}\n`).join(''))
    .digest('hex');
  return { treeSha256, files };
}

async function main() {
  if (git('status', '--porcelain')) {
    throw new Error('Refusing to build a release bundle from a dirty worktree. Commit or stash changes first.');
  }

  const outDir = parseOutDir(process.argv.slice(2));
  const runtimeDir = path.join(outDir, 'runtime');
  const extensionDir = path.join(outDir, 'extension');
  const identityPath = path.join(repoRoot, 'bridge-identity.json');
  const originalIdentityText = await fs.readFile(identityPath, 'utf-8');
  const identity = JSON.parse(originalIdentityText);
  const packageMetadata = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf-8'));
  const cliVersion = packageMetadata.version;
  const forkCommit = git('rev-parse', 'HEAD');
  const bridgeBuildId = `seektalent-opencli-${cliVersion}+${forkCommit.slice(0, 12)}`;
  const releaseIdentity = { ...identity, bridgeBuildId };

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(runtimeDir, { recursive: true });

  try {
    await fs.writeFile(identityPath, `${JSON.stringify(releaseIdentity, null, 2)}\n`, 'utf-8');
    run(npmCommand, ['run', 'typecheck']);
    run(npmCommand, ['--prefix', 'extension', 'run', 'typecheck']);
    run(npmCommand, ['run', 'build']);
    run(npmCommand, ['--prefix', 'extension', 'run', 'build']);
    run(npmCommand, ['--prefix', 'extension', 'run', 'package:release', '--', '--out', extensionDir]);
    run(npmCommand, ['pack', '--ignore-scripts', '--pack-destination', runtimeDir]);

    const packedRuntimeFiles = await collectFiles(runtimeDir);
    if (packedRuntimeFiles.length !== 1 || !packedRuntimeFiles[0].endsWith('.tgz')) {
      throw new Error(`Expected one runtime .tgz, found: ${packedRuntimeFiles.join(', ')}`);
    }
    const runtimeAsset = `wtscli-${cliVersion}.tgz`;
    if (packedRuntimeFiles[0] !== runtimeAsset) {
      await fs.rename(path.join(runtimeDir, packedRuntimeFiles[0]), path.join(runtimeDir, runtimeAsset));
    }
    const runtimePath = path.join(runtimeDir, runtimeAsset);
    const runtimeStats = await fs.stat(runtimePath);
    const extensionTree = await describeTree(extensionDir);
    const extensionManifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf-8'));

    const manifest = {
      schemaVersion: 'seektalent.browser_bridge_bundle.v1',
      implementation: releaseIdentity.implementation,
      upstreamBase: {
        tag: 'v1.8.6',
        commit: 'cad35e7a6a5ff3f7d6b859bfa4c45195c0390260',
      },
      forkCommit,
      bridgeBuildId,
      protocolVersion: releaseIdentity.protocolVersion,
      capabilities: releaseIdentity.capabilities,
      cli: {
        version: cliVersion,
        asset: `runtime/${runtimeAsset}`,
        size: runtimeStats.size,
        sha256: await sha256(runtimePath),
      },
      extension: {
        version: extensionManifest.version,
        id: extensionIdFromManifestKey(extensionManifest.key),
        directory: 'extension',
        treeSha256: extensionTree.treeSha256,
        manifestSha256: await sha256(path.join(extensionDir, 'manifest.json')),
        files: extensionTree.files,
      },
    };
    await fs.writeFile(
      path.join(outDir, 'bridge-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf-8',
    );
    process.stdout.write(`WTSCLI browser bridge bundle created at ${outDir}\n`);
  } finally {
    await fs.writeFile(identityPath, originalIdentityText, 'utf-8');
    run(npmCommand, ['--prefix', 'extension', 'run', 'build']);
  }
}

await main();
