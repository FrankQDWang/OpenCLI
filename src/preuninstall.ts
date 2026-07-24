import { fetchDaemonStatus, requestDaemonShutdown } from './browser/daemon-transport.js';
import { waitForDaemonStop } from './browser/daemon-lifecycle.js';

async function main(): Promise<void> {
  try {
    const status = await fetchDaemonStatus({ timeout: 1000 });
    if (!status) return;
    const accepted = await requestDaemonShutdown({ timeout: 3000 });
    if (!accepted || !await waitForDaemonStop(3000)) {
      process.stderr.write(
        'WTSCLI uninstall left the daemon untouched because authenticated graceful shutdown could not be proven.\n',
      );
    }
  } catch (error) {
    process.stderr.write(
      `WTSCLI uninstall left the endpoint occupant untouched: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

await main();
