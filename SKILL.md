---
name: add-workspace-ui
description: Install the public Docker-only project/session workspace UI, PWA, scoped notifications and optional OpenCode settings integration in a compatible NanoClaw v2 checkout.
---

# Add Workspace UI

Read README.md and the target's instructions. This directory is the complete public distribution; do not copy another installation's working directory or private replay recipe.

1. Run `node install.mjs --target <checkout> --check`. A compatibility or ownership conflict requires reconciliation, never a forced patch.
2. Stop the target through its normal service manager with the operator's authorization, then run `--apply`. It preserves existing provider modules and installs no native execution backend.
3. Follow README.md to resolve the lockfile without bypassing release-age/build-script gates, install frozen, build/typecheck/test, and rebuild the existing agent image.
4. Start the target with operator authorization. Enable/pair with `ncl workspace enable` and `ncl workspace open`. Let the operator configure real agents, folders, utility models, credentials and tailnet access in their own installation.
5. Use `--check-remove` and `--remove` for ownership-aware removal. Keep user data and provider installations. Never delete installation databases or attachments as part of removing UI source.
