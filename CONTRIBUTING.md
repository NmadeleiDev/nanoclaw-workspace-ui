# Contributing

Bug fixes, accessibility improvements and portability work are welcome. For substantial behavior changes, open an issue first so we can agree on the goal and ownership.

## Scope

This repository owns the workspace UI and its explicit NanoClaw integration. The public runtime is Docker. Keep native execution engines, personal configuration and credential handling out of this package. Provider integrations should extend the installed provider rather than replace its source wholesale.

## Local checks

Use the Node version supported in `package.json`. Keep a separate NanoClaw checkout containing the commit in `compatibility.json`, with its dependencies installed.

```sh
node release.mjs --check
WORKSPACE_UI_UPSTREAM=/path/to/nanoclaw node --test tests/*.test.mjs
node install.mjs --target /path/to/disposable-nanoclaw --check
node install.mjs --target /path/to/disposable-nanoclaw --apply
```

In the disposable target, resolve the lockfile, install frozen dependencies, then run the host and frontend builds and focused tests shown in the installation guide. Runner changes also require the runner typecheck and Bun regression tests. UI changes need desktop and narrow-screen browser verification, keyboard access, readable text and a real workflow test.

Installer tests create Unix sockets. On deeply nested checkout paths, set `WORKSPACE_UI_TEST_ROOT` to a short temporary directory you own; each fixture is removed after its test.

Edit owned source in `payload/`. Keep integration changes in `integration.patch`; optional provider compatibility belongs in `optional/`. New owned files must be listed in `manifest.json`; every distributable file must be listed in `release-files.json`.

After reviewing intentional source changes, run `node release.mjs --refresh`, then the checks and `node release.mjs --build`. Checksum refresh is not a substitute for reviewing the diff.

## Pull requests

Explain the user-visible problem, resulting behavior, compatibility impact and checks you actually ran. Keep changes focused. Include fictional screenshots for visual changes. Never attach databases, logs with personal content, pairing links, push subscriptions, credentials or real conversation history.

Report exploitable vulnerabilities privately using the process in [SECURITY.md](SECURITY.md).
