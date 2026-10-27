# Workspace UI architecture

The React frontend communicates with an owner-authenticated HTTP API in `src/modules/workspace-ui`. NanoClaw remains the canonical agent/router/runtime. The add-on registers an optional host module, channel and session-context hook. Its `ws_*` metadata lives in the central database. Durable inbound messages and outbound events use NanoClaw's existing single-writer mailbox split; SSE only signals changes.

Project briefs, scratchpads and attached directories enter the current session's context. Per-session container configuration is materialized separately so one session's model or folders cannot overwrite a sibling's configuration. Folder permissions reuse NanoClaw's mount allowlist. Idle reconfiguration uses a runner acknowledgement; active turns are not interrupted by settings saves.

The public integration targets Docker. No OS-policy store, native process driver, host browser exception or runtime switching schema is installed. The UI and HTTP API expose no native runtime controls. `nativeSessionId` in legacy metadata means the underlying NanoClaw session ID, not a native operating-system backend.

API connection metadata uses the add-on's model catalog. A small contribution hook applies OpenCode connection metadata at spawn without replacing its host module. The optional provider patch selects the declared API protocol and prevents summary utility sessions from using tools, MCP or project instructions. Other provider refreshes remain independently owned and need compatibility checks.

Pairing is owner-only, origin-bound, single-use and rate-limited. Device credentials are stored as hashes, with port-scoped HttpOnly cookies. Revocation also disconnects event streams and push delivery. Tailnet access uses a dedicated owned HTTPS Serve route. Push signing identity and subscriptions are created per installation and are excluded from the release.

OpenClaw import is explicit, local and read-only at source. Agent mapping uses unique IDs/names; ambiguous sources require an operator choice. No owner-specific agent name or project path is built into mapping. Imported histories are metadata and messages, never permission to run old instructions.

Development previews contain copied private state and are never release artifacts. Release generation reads only the allowlist and validates SHA-256 integrity; it does not collect files from a running installation.
