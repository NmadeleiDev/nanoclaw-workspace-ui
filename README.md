# NanoClaw Workspace UI

**A calmer place to work with your agents.**

[![CI](https://github.com/NmadeleiDev/nanoclaw-workspace-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/NmadeleiDev/nanoclaw-workspace-ui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-a99be7.svg)](LICENSE)

Organize NanoClaw conversations into projects, give agents the right working folders, and pick up where you left off with living scratchpads. Use it on localhost or install it on your iPhone through your private tailnet.

![Workspace with synthetic projects and a demo conversation](docs/demo.png)

[Installation](docs/installation.md) · [Demo tour](docs/demo.md) · [User guide](docs/workspace-ui.md) · [Contributing](CONTRIBUTING.md)

## What you get

| | |
| --- | --- |
| **Projects with context** | A name, brief, working folders and shared scratchpad that travel with your conversations. |
| **Flexible conversations** | Inherit project folders or choose your own. Select a model, paste images, or drop files into chat. |
| **Living notes** | Session and project scratchpads with background summaries and revision history. |
| **Your agents, your models** | Edit agent defaults and API connection metadata in Settings. Credentials stay in NanoClaw’s gateway. |
| **Made for daily use** | Search, activity, readable system fonts, text-size controls, themes and responsive layouts. |
| **Private mobile access** | Optional Tailscale HTTPS, single-use device pairing, an installable PWA and scoped notifications. |
| **Bring your history** | Read-only OpenClaw history import with explicit agent mapping. |

## Get started

This is an **early source add-on for NanoClaw v2**, supporting its Docker runtime. It applies a reviewed integration patch to an existing configured checkout; it is not a standalone agent server. The tested upstream revision is pinned in [compatibility.json](compatibility.json). Other revisions require validation.

```sh
git clone https://github.com/NmadeleiDev/nanoclaw-workspace-ui.git
cd nanoclaw-workspace-ui
node install.mjs --target /path/to/nanoclaw --check
```

Then follow the [installation guide](docs/installation.md) to stop the target host, apply the add-on, build, and pair with your existing owner account. Preflight refuses conflicting source edits; the installer does not restart services. Node 22.18+, pnpm, Docker and a configured NanoClaw credential gateway are required.

Once installed:

```sh
ncl workspace enable
ncl workspace open
```

For iPhone access, use **Settings → Access** to enable Tailscale and create a device link. Open it in Safari, add the app to your Home Screen, then enable notifications inside the installed app. Notifications start disabled; global, device, agent, project and session controls govern delivery.

## A source add-on with clear boundaries

The UI reuses NanoClaw’s agents, routing, session mailboxes and credential gateway. Its own module owns projects, scratchpads, access and notification preferences. The [source manifest](manifest.json) and [integration patch](integration.patch) make that coupling inspectable.

This repository contains synthetic demo data and public source only. It ships no personal workspace, credentials, session databases, imported conversations or native execution backend. The optional Apple utility helper only generates summaries on supported Macs.

Release archives use an explicit allowlist, checksums and normalized metadata. Installation and [removal](REMOVE.md) protect edited source and retain user data. See [verification](docs/verification.md) for observed test coverage and its limits.

## Development

```sh
node release.mjs --check
WORKSPACE_UI_UPSTREAM=/path/to/nanoclaw node --test tests/*.test.mjs
node release.mjs --build
```

The test checkout must contain the pinned upstream commit and installed dependencies. CI reconstructs a clean upstream checkout and exercises installation, host/frontend builds and the focused regression suite. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

MIT licensed. Built on [NanoClaw](https://github.com/nanocoai/nanoclaw); independent community add-on, not an official NanoClaw release. Third-party credits are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
