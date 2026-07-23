function resolveNpmInvocation({
  platform,
  nodeExecPath,
  npmExecPath,
}) {
  if (npmExecPath) {
    return {
      command: nodeExecPath,
      args: [npmExecPath, 'run', 'build'],
      options: {
        stdio: 'inherit',
      },
    };
  }

  const windows = platform === 'win32';
  return {
    command: windows ? 'npm.cmd' : 'npm',
    args: ['run', 'build'],
    options: {
      ...(windows ? { shell: true } : {}),
      stdio: 'inherit',
    },
  };
}

module.exports = {
  resolveNpmInvocation,
};
