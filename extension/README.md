# OpenCLI Browser Bridge Extension

The extension connects Chrome tabs to the local OpenCLI daemon. It uses Chrome
extension APIs only as a transport and browser-control layer for explicit CLI
commands.

## Distribution boundary

The unpacked-extension workflow is for internal testing only. Replacing files
under an already loaded unpacked directory does not activate a new MV3 worker.
The release package is intended for review and a Chrome-supported signed
distribution path; creating it does not publish to the Chrome Web Store.

The product contract is one initial Chrome confirmation at most for an ordinary
user. After activation, daemon start/restart and extension reconnect happen
automatically. Developer Mode, repeated reloads, and manual daemon launch are
not supported production steps. Enterprise policy may automate distribution
but is not required by the product contract.

## Permission Notes

- `debugger`: sends CDP commands to OpenCLI-controlled or bound tabs.
- `tabs` / `tabGroups`: manages the dedicated OpenCLI automation container and
  reports selected tab metadata back to the CLI.
- `cookies`: reads cookies for browser-backed adapters that need authenticated
  fetches.
- `downloads`: surfaces download lifecycle to `opencli browser wait download`.
  The extension observes started / in-progress / completed / failed downloads so
  the CLI can wait for a file triggered by an automation command. OpenCLI
  filters by the command's filename/URL pattern and timeout, and does not modify,
  redirect, or persist browser download history.

Suggested Chrome Web Store justification for `downloads`:

> This extension uses `chrome.downloads` to surface download lifecycle
> (started / in-progress / completed / failed) to the OpenCLI command-line tool,
> so agents can wait for downloads triggered during an automation workflow. The
> command filters by a user-provided filename or URL pattern and timeout. We do
> not modify, redirect, or persist user download history.
