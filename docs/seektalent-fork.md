# SeekTalent OpenCLI Fork

This branch starts from upstream OpenCLI `v1.8.6` at commit `cad35e7a6a5ff3f7d6b859bfa4c45195c0390260`.

The fork remains a generic browser bridge. It does not contain Liepin URLs, source-run state, the controlled-page overlay, countdown rendering, or SeekTalent cleanup orchestration.

## Added browser contract

- `browser <session> tab find <urlPrefix>` finds existing user tabs without binding, activating, navigating, or claiming them.
- `browser <session> tab new <url> --host-page <page>` creates one inactive owned tab in that existing user window. The host tab and window remain user-owned.
- `browser <session> tab close <page>` closes only the exact tab owned by that session and returns `closed`, `already_missing`, or `failed`. A failure retains ownership evidence for the idle reclaimer.
- `browser <session> control activate <controlKey>` atomically allocates a fencing token. Later page commands carry it through `OPENCLI_CONTROL_KEY` and `OPENCLI_FENCE_TOKEN`; stale commands are rejected before touching a page. Exact close remains allowed for a superseded scope.
- Page-scoped responses include the extension's actual `idleDeadlineAt` after command completion.
- Daemon status reports the daemon and extension implementation, `bridgeBuildId`, protocol version, and capabilities.

Borrowed-host sessions intentionally own exactly one tab. This is not a global tab limit: SeekTalent creates a distinct opaque session for every controlled tab.

## Local development

```bash
npm ci --ignore-scripts
npm --prefix extension ci --ignore-scripts
npm run typecheck
npm --prefix extension run typecheck
npm test
npm run build
npm --prefix extension run build
```

Loading `extension/` as an unpacked Chrome extension is an internal-development
workflow only. It is not a production distribution mechanism: Chrome requires
an explicit activation when an unpacked extension is first loaded and does not
silently activate behind-the-back file replacement.

`npm --prefix extension run package:release` produces the reviewable extension
directory used by the paired bundle. That artifact is suitable for store
submission or another Chrome-supported signed distribution channel, but this
repository does not publish it. Ordinary-user delivery must require at most one
initial Chrome confirmation; later runtime starts, extension reconnects, and
extension updates must not require Developer Mode, manual daemon launch, or
repeated reloads. Enterprise policy is optional, never a prerequisite.

Example protocol sequence:

```bash
opencli browser scope-1 control activate profile-lane-1

OPENCLI_CONTROL_KEY=profile-lane-1 OPENCLI_FENCE_TOKEN=1 \
  OPENCLI_BROWSER_IDLE_TIMEOUT=60 \
  opencli browser host-probe tab find https://example.com/

OPENCLI_CONTROL_KEY=profile-lane-1 OPENCLI_FENCE_TOKEN=1 \
  OPENCLI_BROWSER_IDLE_TIMEOUT=60 \
  opencli browser tab-1 tab new https://example.com/ --host-page '<host-page-id>'

opencli browser tab-1 tab close '<owned-page-id>'
```

The `find` session is not bound and creates no browser resource. The `tab-1` session owns only the newly created tab. Close does not require the current fence so a superseded scope can still clean up its own exact tab.

## Reproducible paired bundle

Build only from a clean committed revision:

```bash
npm run build:seektalent-bundle -- --out /absolute/output/path
```

The command temporarily derives `bridgeBuildId` from the exact fork commit, builds both sides with that identity, and emits:

```text
output/
  runtime/<npm-package>.tgz
  extension/
  bridge-manifest.json
```

`bridge-manifest.json` records the upstream base, full fork commit, paired build ID, protocol, capabilities, runtime SHA-256, extension manifest SHA-256, and a deterministic extension tree hash with per-file hashes. The build restores the development identity and generated extension file afterward.

The product installer must stage and verify this complete directory before switching versions. Runtime and extension are upgraded and rolled back together; neither side may be selected independently.

## Offline production rules

- Never run `npm install`, `npm update`, or a GitHub download on a user machine.
- This fork hard-disables the upstream npm/GitHub update checker and update notices.
- SeekTalent installs the runtime bundle and extension directory from its signed installer assets.
- Unpacked extension loading is internal-test-only. A production release must
  select and validate a Chrome-supported distribution channel before claiming
  silent updates for ordinary Windows/macOS users.
- SeekTalent must compare daemon and extension implementation, build ID, protocol major, and required capabilities before the first provider browser command.
- A mismatch disables only the current browser-backed source. It does not cancel other sources or the whole run.
