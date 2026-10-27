# NanoClaw Workspace UI

A project-oriented web workspace for NanoClaw v2. This is a source add-on with an explicit integration patch, not a replacement NanoClaw distribution.

Projects carry a name, brief, folders and shared scratchpad. Conversations inherit project folders, can choose their own folders and model, and keep a revisioned scratchpad. The UI includes clipboard/drop attachments, search, history import, agent/model settings, readable system typography and adjustable text size, responsive layouts, installable PWA, private Tailscale HTTPS access, activity history and scoped notifications.

## Scope and compatibility

The public package supports NanoClaw's existing Docker runtime. It contains no native execution backend, OS permission engine, host browser integration, user configuration, databases, credentials, imported history or screenshots from a real installation. Native execution controls are absent from this frontend.

The tested upstream source revision is recorded in `compatibility.json`. Incompatible patch hunks and source ownership conflicts fail preflight before mutation. A different upstream revision needs maintainer validation even if its patch preflight passes; no compatibility with an arbitrary future version is implied. Claude uses the existing provider. If OpenCode is already installed from the upstream skill at the tested revision, an optional narrow patch adds API transport selection and isolated utility mode. Provider modules remain owned by their provider installer.

Requirements: a configured NanoClaw v2 source checkout with its existing credential gateway, Docker and installed pnpm dependencies; Node 22.18+ (Node 24 LTS recommended); Bun for runner validation. The installer adds the frontend workspace and Web Push dependencies without changing gateway credentials or supply-chain gates. It selects the maintained Vitest 4.1.12 security backport for the upstream test suite; conflicting pinned or different-major test versions require explicit reconciliation. Optional Apple utility inference requires a supported Mac; Ollama and a configured agent are alternatives on other hosts. No utility model is downloaded automatically.



## Install

Unpack this add-on outside the target checkout, or keep it in a separate directory. Read the target's instructions and preserve local changes first.

```sh
node /path/to/workspace-ui/install.mjs --target /path/to/nanoclaw --check
# Stop that target's NanoClaw host through its normal service manager.
node /path/to/workspace-ui/install.mjs --target /path/to/nanoclaw --apply
cd /path/to/nanoclaw
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm run build
pnpm run workspace:build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm exec vitest run src/modules/workspace-ui src/model-connections.test.ts web/workspace/tests
```

Rebuild the target's existing agent image through `./container/build.sh` so its dependency tree and runner source agree, then restart that target using its normal service manager. For optional Apple utility inference also run `pnpm run workspace:build-native` on the supported Mac. The installer never installs or restarts services.

Enable and pair using the existing owner:

```sh
ncl workspace enable
ncl workspace open
```

Open the printed localhost URL. Device links are short-lived and single-use. Choose utility inference in Settings. API connection settings store endpoint/model metadata; real credentials stay in the selected credential gateway. On an uninstalled runner the UI cannot select its models.

Use Settings → Access for optional Tailscale HTTPS access and pairing another device. The add-on owns only its dedicated Serve port and checks that it does not replace another service. On iPhone, open the HTTPS address in Safari, add it to the Home Screen, open the installed app, then enable notifications through its settings. Push requires the host and tailnet route to remain available.

Notification resolution is session → project → agent; global and device delivery gates remain absolute. Global delivery starts off. Private previews are optional. Never publish device links, push subscriptions or VAPID signing identity from your installed `data/` directory.

## Updates and removal

An identical installation is idempotent. Source changes in owned files cause an explicit conflict; reconcile them before refreshing or removing. If you refresh an optional provider later, rerun compatibility checks and reconcile the optional patch before running this UI. There is no automatic forced overwrite.

Disable tailnet access while the target is running, then stop the host before removal:

```sh
ncl workspace tailnet --disable
node /path/to/workspace-ui/install.mjs --target /path/to/nanoclaw --check-remove
node /path/to/workspace-ui/install.mjs --target /path/to/nanoclaw --remove
```

Removal reverses only matching integration changes and deletes unchanged add-on-owned source. It preserves provider source and user databases, project/session metadata, attachments, keys, model configuration and agent memory. Other package settings and non-overlapping core edits are retained. Reconcile the dependency lockfile, rebuild the host, and restart using the normal service manager. Already-built frontend/native utility outputs can be removed separately after inspecting their paths. Data deletion is intentionally outside this operation.

## Release contents and privacy

`manifest.json` enumerates installed source. `release-files.json` enumerates the distribution archive. `checksums.json` covers those distributable files. `node release.mjs --check` validates integrity, package boundaries, personal-path patterns and recognizable credential signatures. `node release.mjs --build` builds an allowlisted archive in `dist/`. Archive ownership, timestamps and modes are normalized; host usernames, extended attributes and platform metadata are not exported. Nothing is uploaded.

Do not zip an installed NanoClaw checkout. `.env`, `data/`, `groups/`, logs, caches, previews and generated frontend output are not distribution input. A preview made with `workspace:preview` copies private local history for review and must never be published.

Run packaging tests with `WORKSPACE_UI_UPSTREAM=/path/to/clean-or-local/upstream node --test tests/install.test.mjs`. They reconstruct the pinned commit with `git archive`; no current installation state is copied. See `verification.md` for observed coverage and limits. License and design attributions are in `LICENSE` and `THIRD_PARTY_NOTICES.md`.
