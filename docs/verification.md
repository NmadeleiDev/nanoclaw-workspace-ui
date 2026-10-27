# Verification

The tested source is pristine upstream `acc2b1c8f52a954368cfaf04b61c32f9a1efc280`, reconstructed with `git archive`. No database, configuration or source prerequisite was copied from a customized installation.

Initial clean-base verification on Node 24.18.1 and Bun 1.4.4: 119 host/UI tests, 51 runner tests, host and runner typechecks, and the frontend production build passed. Installer tests cover dry-run non-mutation, installation, idempotency, byte-exact source restoration, provider ownership, edited-file refusal, non-overlapping operator edits, and symlink rejection. Release tests cover allowlisting, integrity and private-path detection.

The optional provider fixture installs the upstream OpenCode payload before applying its narrow compatibility patch. It is checked separately from the Claude-only baseline. API connection credentials remain outside the package and are not required for source/build tests.

Dependency registry versions and direct-package OSV results are recorded in `dependency-review.json`; this is a dated check, not a permanent security guarantee or a full transitive audit. The installer preserves the target's release-age and build-script policies. Resolve and audit its final lockfile in the target environment.

No iPhone, live push service, real credential gateway account or external inference credential is bundled in fixtures. Those end-to-end flows require the installing operator's own configured services. The PWA/notification/auth HTTP contracts and UI are covered by local tests. Actual production inference and device permission prompts are outside the clean-install test.

Final core + UI regression scope: 2,285 passing tests and one upstream skip across 208 files (`src`, top-level `container` tests, and frontend tests). Focused post-cleanup tests additionally exercised the host module barrel and guard conformance, catching and removing native side-effect imports that TypeScript alone did not reject. No native runtime hooks remain in patch additions.

Installer/archive tests also passed in an isolated Linux container with Node 22.23.4 and networking disabled. The preview was exercised in Chrome using only synthetic project/chat data: project settings saved through HTTP; the 390 × 844 composer accepted a pasted PNG with no horizontal overflow; settings and context tabs contained no native execution controls; no console errors were observed. `demo.png` contains only synthetic content. Temporary preview services were stopped.

The all-repository invocation was not claimed as green: an upstream nested-pnpm test expected a warning that this pnpm did not print, and the run was interrupted during gateway-skill shell tests. Those setup/skill harnesses are outside the passing core/UI count.

A fresh dependency resolution and `pnpm install --frozen-lockfile` were exercised with the existing supply-chain gates. Initial inherited Vitest 4.1.11 advisories led to selecting maintained V4 backport 4.1.12; the resulting complete pnpm dependency audit reported zero known vulnerabilities. The newer V5 test-framework major is deliberately not introduced by this add-on.

Final frozen-install verification used independently installed dependencies (no dependency symlinks): both host and frontend builds passed, and 124 focused host/API/UI/guard tests passed across 24 files. The public source contains 78 owned files and a 30-file core integration patch. No provider implementation is owned or deleted by the UI manifest. The distribution is checked against personal reference patterns and recognizable credential signatures; tests are not a substitute for reviewing future release content.

Additional isolated runner verification passed 56 tests across configuration, Claude system/utility prompting, notification boundaries, workspace context and interactive tools. Optional upstream OpenCode configuration passed 32 tests and its host/runner typechecks. The maintained-V4 dependency choice is recorded with its reason in `dependency-review.json`.
