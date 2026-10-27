# Workspace UI architecture

The React frontend communicates with an owner-authenticated HTTP API in `src/modules/workspace-ui`. NanoClaw remains the canonical agent/router/runtime. The add-on registers an optional host module, channel and session-context hook. Its `ws_*` metadata lives in the central database. Durable inbound messages and outbound events use NanoClaw's existing single-writer mailbox split; SSE only signals changes.

Project briefs, scratchpads and attached directories enter the current session's context. Per-session container configuration is materialized separately so one session's model or folders cannot overwrite a sibling's configuration. Folder permissions reuse NanoClaw's mount allowlist. Idle reconfiguration uses a runner acknowledgement; active turns are not interrupted by settings saves.

The public integration targets Docker. No OS-policy store, native process driver, host browser exception or runtime switching schema is installed. The UI and HTTP API expose no native runtime controls. `nativeSessionId` in legacy metadata means the underlying NanoClaw session ID, not a native operating-system backend.

API connection metadata uses the add-on's model catalog. A small contribution hook applies OpenCode connection metadata at spawn without replacing its host module. The optional provider patch selects the declared API protocol and prevents summary utility sessions from using tools, MCP or project instructions. Other provider refreshes remain independently owned and need compatibility checks.

Pairing is owner-only, origin-bound, single-use and rate-limited. Device credentials are stored as hashes, with port-scoped HttpOnly cookies. Revocation also disconnects event streams and push delivery. Tailnet access uses a dedicated owned HTTPS Serve route. Push signing identity and subscriptions are created per installation and are excluded from the release.

OpenClaw import is explicit, local and read-only at source. Agent mapping uses unique IDs/names; ambiguous sources require an operator choice. No owner-specific agent name or project path is built into mapping. Imported histories are metadata and messages, never permission to run old instructions.

Development previews contain copied private state and are never release artifacts. Release generation reads only the allowlist and validates SHA-256 integrity; it does not collect files from a running installation.

## Speech input

Use the microphone beside Send to dictate, review the transcript, then send normally. Cancel discards the recording; a failed transcription can be retried while the conversation stays open. Speech is optional and starts disabled in new installations.

Settings → Speech offers two independent backends:

- **whisper.cpp local server:** works without MyWhispr. Run the standalone server on the workspace host, select this backend, enter its loopback HTTP address, and choose Check backend. Its model is selected when starting the server.
- **MyWhispr macOS CLI:** keeps the existing CLI integration. Choose an installed model and optionally provide an absolute CLI path. Existing installations retain this backend, including their saved model, language and path; old installations using implicit defaults also retain MyWhispr.

For the standalone backend, follow the [official whisper.cpp server instructions](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5/examples/server). The integration contract is verified against the v1.9.5 documentation. Build a current supported release and obtain a trusted multilingual model, then start it bound to loopback, for example:

```sh
./build/bin/whisper-server --host 127.0.0.1 --port 8080 -m /path/to/ggml-base.bin --language auto
```

Enter `http://127.0.0.1:8080` in Settings → Speech, check readiness, enable speech input, and save. No API key is needed. The add-on calls `/health` and sends multipart WAV uploads to `/inference`; it does not install a server or download models. Keep the transcription server private on loopback. Redirects and non-loopback endpoints are rejected. Backend checks do not save settings or upload audio.

Desktop localhost and Tailscale HTTPS support microphone capture. An iPhone records on-device and sends audio through the paired workspace connection to the host. Browser microphone permission is required. The browser converts recordings to mono 16 kHz PCM WAV. Recordings are limited to two minutes, inference is serialized and time-bounded, and temporary CLI audio is removed on success, failure or cancellation. The HTTP backend uploads audio from memory. Recordings are not chat attachments or conversation history. Transcription is local; sending its text uses the agent’s normal provider.

## Connection recovery

If the workspace connection drops, background refresh shows a persistent reconnecting banner instead of repeated error toasts. Your draft stays in the composer. The app retries failed reads twice, then resumes its normal refresh cycle; Retry now checks immediately. A plain-text proxy 404 is reported as an address/routing failure, rather than proof that NanoClaw is down.

Messages and other changes are never automatically retried. If their response is lost, check the conversation or setting before trying again: the action may already have completed.

Tailscale health-check failures pause remote authorization while preserving the owned Serve process. Access resumes only after the private route is verified. A confirmed route change or Funnel exposure still releases that process immediately. Host logs record failed CLI checks, Serve exits and recovery; browser diagnostics record the failed request method, path and status without query strings, response bodies, credentials or message text.

## Tool activity summaries

Completed “Worked” blocks can show a short utility-generated sentence alongside the step count. Expand the block to inspect the original tool activity. Summaries describe observed actions, results and blockers; they are not a replacement for the tool record.

The latest completed block is summarized in the background when Automatic summaries is enabled. Expand an older block and choose Summarize activity to request one on demand. Each label is cached against its source evidence, limited to 24 words and 180 characters, and kept out of agent context and scratchpads. Failures have bounded retries and an explicit retry control.

Settings → Utility models selects the model, with an optional Tool activity summaries override. Existing utility providers are reused; no extra service or model is installed.

## Provisional conversation titles

After the first message is accepted, a new conversation uses that message as its provisional name: whitespace is collapsed and the title is capped at 80 Unicode characters, including an ellipsis when shortened. Attachment-only messages use the first filename. The utility model may replace this provisional name later; human names and imported history names are preserved. Existing unnamed conversations with a first message are filled in on startup.

## Quoting replies

Select text within an agent reply and choose **Quote** to append it as a Markdown blockquote in your draft, with space beneath for your response. Existing draft text is preserved and nothing is sent automatically. The quote icon beside Copy quotes the selected passage from that reply, or the whole reply when no passage is selected. Keyboard users can select text and press **Alt/Option+Q**. Quotes are scoped to the current conversation; imported reference-only chats cannot accept drafts.

## Tool activity history

Completed native turns retain a separate **Worked** block with their tool inputs, outputs and statuses. Each block is pinned after that turn’s last agent reply, before subsequent user messages; the active turn alone uses the live **Working** block. Independent replay cursors restore earlier completed turns from retained mailbox events without replaying messages, notifications or agent actions. Repeated collection and restarts do not duplicate blocks. Older activity without retained events cannot be reconstructed. Activity summaries remain attached to their original blocks, including when loading earlier messages.

The rename dialog focuses the title field. Press Enter or choose **Save title** to save and close it. Blank titles are rejected, repeated submissions are disabled while saving, and save failures leave the edited title available for retry.

Session scratchpad summaries target 50–90 words in the user’s latest substantive conversational language, with localized Goal, Now, and (when supported) Next or Blocked labels. They preserve human corrections, replace stale status with newer evidence, and omit historical recaps and nonessential metrics. This is a generation instruction, not a hard truncation limit. Existing notes change on the next automatic or manual refresh.
