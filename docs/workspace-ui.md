# Workspace UI architecture

The React frontend communicates with an owner-authenticated HTTP API in `src/modules/workspace-ui`. NanoClaw remains the canonical agent/router/runtime. The add-on registers an optional host module, channel and session-context hook. Its `ws_*` metadata lives in the central database. Durable inbound messages and outbound events use NanoClaw's existing single-writer mailbox split; SSE only signals changes.

Project briefs, scratchpads and attached directories enter the current session's context. Per-session container configuration is materialized separately so one session's model or folders cannot overwrite a sibling's configuration. Folder permissions reuse NanoClaw's mount allowlist. Idle reconfiguration uses a runner acknowledgement; active turns are not interrupted by settings saves.

The public integration targets Docker. No OS-policy store, native process driver, host browser exception or runtime switching schema is installed. The UI and HTTP API expose no native runtime controls. `nativeSessionId` in legacy metadata means the underlying NanoClaw session ID, not a native operating-system backend.

API connection metadata uses the add-on's model catalog. A small contribution hook applies OpenCode connection metadata at spawn without replacing its host module. The optional provider patch selects the declared API protocol and prevents summary utility sessions from using tools, MCP or project instructions. Other provider refreshes remain independently owned and need compatibility checks.

Pairing is owner-only, origin-bound, single-use and rate-limited. Device credentials are stored as hashes, with port-scoped HttpOnly cookies. Revocation also disconnects event streams and push delivery. Tailnet access uses a dedicated owned HTTPS Serve route. Push signing identity and subscriptions are created per installation and are excluded from the release.

OpenClaw import is explicit, local and read-only at source. Agent mapping uses unique IDs/names; ambiguous sources require an operator choice. No owner-specific agent name or project path is built into mapping. Imported histories are metadata and messages, never permission to run old instructions.

Development previews contain copied private state and are never release artifacts. Release generation reads only the allowlist and validates SHA-256 integrity; it does not collect files from a running installation.

## Speech input

Use the microphone beside Send to dictate a message. Stop to transcribe, review the resulting text, then send it normally. It never sends a message automatically. Cancel discards the recording. Failed transcription keeps the recording in browser memory for Retry until cancelled or the conversation is closed.

Settings → Speech controls enablement, model, language and an optional absolute MyWhispr CLI path. The host discovers `mywhispr` in its user-local bin directory or PATH. This integration requires the existing MyWhispr CLI and a compatible Mac host; it does not bundle or install a transcription engine. Choose a model already installed in MyWhispr. The CLI may download missing models on first use.

Desktop localhost and Tailscale HTTPS both support microphone capture. An iPhone records locally and sends audio through the paired workspace connection to the Mac for transcription. Browser microphone permission is required. Chrome/Safari audio is decoded and converted to mono 16 kHz PCM WAV in the browser. The host accepts recordings up to two minutes, serializes inference, bounds its runtime, and removes temporary audio on success, failure or cancellation. Raw recordings are not chat attachments or conversation history. Transcription is local; sending its text uses the agent’s normal provider.

## Connection recovery

If the workspace connection drops, background refresh shows a persistent reconnecting banner instead of repeated error toasts. Your draft stays in the composer. The app retries failed reads twice, then resumes its normal refresh cycle; Retry now checks immediately. A plain-text proxy 404 is reported as an address/routing failure, rather than proof that NanoClaw is down.

Messages and other changes are never automatically retried. If their response is lost, check the conversation or setting before trying again: the action may already have completed.

Tailscale health-check failures pause remote authorization while preserving the owned Serve process. Access resumes only after the private route is verified. A confirmed route change or Funnel exposure still releases that process immediately. Host logs record failed CLI checks, Serve exits and recovery; browser diagnostics record the failed request method, path and status without query strings, response bodies, credentials or message text.
