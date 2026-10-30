# Local workspace

A private, owner-paired web channel for the existing NanoClaw agents. Projects organize work across agents; sessions belong to one agent. Projects are context, not an isolation or authorization boundary. Agent-wide memory remains shared as before.

## Build and review

```sh
pnpm run build
pnpm run workspace:build
pnpm run workspace:build-native # macOS with FoundationModels SDK; needed only for Apple utilities
pnpm run workspace:preview
```

Preview binds `127.0.0.1:3211`, copies the central database using SQLite's online backup, copies session mailboxes, and never connects its chat bridge to the live host. The printed pairing URL expires after two minutes. A fresh URL is written every minute to `<preview directory>/preview.json` (mode 0600). Preview data stays inside `.workspace-preview-*`, ignored by Git. Resume a review with `WORKSPACE_PREVIEW_RESUME=.workspace-preview-<suffix> pnpm run workspace:preview`. Ctrl+C closes task-owned listeners; the review data remains available.

Preview supports project editing, scratchpads, revision history, local model tests, and OpenClaw imports. Chat, container reconfiguration, and folder grants deliberately require the real host. Automatic summaries are disabled in preview; manual updates still work. No mock responses are substituted.

## Activate

The module is disabled by default. After reviewing the isolated preview, obtain the operator's explicit approval before restarting the live host/containers or granting host folders. Take an online database backup first. Restart this install through its existing service configuration; do not guess its launchd label. Then run the installed admin CLI:

```sh
ncl workspace enable --port 3210
ncl workspace open
ncl workspace status
```

`workspace open --owner <existing-owner-id>` chooses a particular owner. Open the returned one-time localhost link in the desired browser. Pairing creates a 12-hour HttpOnly, SameSite=Strict browser session; mutations require a separate CSRF token. Host, Origin and owner role are checked on every request. The application stays bound to loopback. Optional private HTTPS access is provided by a dedicated Tailscale Serve listener. Re-pair after a host restart.

Existing Telegram conversations appear automatically. Web messages go to that exact native session, through the normal owner command gate and mailbox, and agent replies remain visible on the original channel and the web. A new web session has its own reserved thread and cannot become the shared messaging hub. Existing running containers need a restart between turns to load new runner code. Do not interrupt active work without permission.

## Tailscale and iPhone access

Workspace Settings → Access has an immediate **Tailscale access** switch. It keeps localhost available and exposes this workspace through a private HTTPS device URL on tailnet port 8443. Tailscale must already be installed, connected, and permitted to use Serve/HTTPS. Existing tailnet ACLs still apply.

The workspace owns one foreground `tailscale serve --https=8443` process, supervised by the host. It never resets Serve configuration, replaces an occupied port, enables Funnel, or changes another service. The enabled preference is stored in the workspace DB and is restored when the host starts. If Serve exits, the route changes, or public exposure is detected, remote authorization is removed and an error is displayed; localhost continues working. While enabled, the host retries a safe private connection after Tailscale becomes available again. A supervisor releases the owned Serve process group even if the host disappears unexpectedly.

Connect the iPhone to Tailscale. On the paired Mac browser, open **Settings → Access → Create device link**, copy it, and open it in Safari on the phone. Each link works once, expires after two minutes, and is tied to the exact HTTPS address. The resulting browser cookie is Secure and HttpOnly, and CSRF protection remains enforced. Turning Tailscale access off revokes remote browser sessions and outstanding remote pairing links. Local browser sessions remain valid.

Host CLI equivalents:

```sh
ncl workspace tailnet --enable
ncl workspace tailnet
ncl workspace open --tailnet
ncl workspace tailnet --disable
```

[Official Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve) describes tailnet HTTPS and access control. If HTTPS permissions need operator action, the UI shows the CLI diagnostic instead of substituting an insecure connection. Tailnet access is disabled in isolated preview copies.

## Appearance and readable text

Settings → Appearance offers four complete presets, each with Light, Dark and System modes:

- **Cosmic Night** (default): indigo and lilac, sparse stars and violet clouds.
- **Ember**: charcoal and copper, amber stars and warm dusk clouds.
- **Northern Lights**: cool slate, green accents and blue-green aurora.
- **Classic**: the familiar neutral workspace with a plain background.

Selecting a preset or appearance mode previews the whole workspace immediately. Save settings keeps it; Close, Escape and backdrop dismissal discard the preview. Failed saves keep the draft open. Appearance is shared across this installation's paired browsers, using the existing workspace settings. System mode follows device changes while the page is open. Text size previews and saves with the theme. The browser favicon follows the active palette, including draft previews, discarded changes and system appearance changes.

**Animate background** controls gentle drift (disabled for Classic). Reduced-motion preferences always stop ambient movement, and hidden tabs pause it. With motion off the scene stays visible. Backgrounds do not capture clicks or keyboard focus. Mobile uses fewer stars; canvas resolution and frame rate are bounded. Chat and the area around the composer share the selected sky with a light reading shade. The composer input, code blocks and forms retain solid surfaces. The app retains CSS clouds when canvas is unavailable, and opaque navigation/card surfaces when backdrop blur is unavailable.

`theme` retains its existing `light | dark | system` meaning. `themePreset` is `cosmic-night | ember | northern-lights | classic`; `ambientMotion` is boolean. Old settings receive Cosmic Night and motion enabled without changing their saved light/dark mode or utility configuration. No schema migration is required. A validated local appearance-only cache paints the last saved look before startup; server settings remain authoritative. The pre-paint script is a hashed external asset compatible with the existing Content Security Policy and shell service-worker cache.

The color systems adapt serafimcloud's 21st.dev [Cosmic Night](https://21st.dev/community/themes/cosmic-night), [Darkmatter](https://21st.dev/community/themes/darkmatter) and [Northern Lights](https://21st.dev/community/themes/northern-lights). The decorative canvas and clouds adapt the approach of designali-in's [Starfield](https://21st.dev/@designali-in/components/starfield-1) and pulkitxm's [Aurora Background](https://21st.dev/@pulkitxm/components/aurora-background), with Dessence's warm celestial treatment as a visual reference. The appearance selector draws on ncdai's [Theme Switcher](https://21st.dev/@ncdai/components/theme-switcher-1), adapted to native radio controls and existing icons. These adaptations add no dependencies or remote runtime requests. Semantic status colors and foreground contrast are adjusted for a working application; catalog CSS is not copied wholesale.


The default uses the Mac's system font stack, 16px chat text at the standard browser font size, and secondary text no smaller than 12px. Font sizes use relative units and retain heading/body/secondary hierarchy. Workspace Settings → Appearance → Text size previews a consistent 100–200% text scale before saving; Close cancels an unsaved preview. The saved workspace preference survives browser and host restarts. Standard browser zoom remains available.

Large text expands controls and uses the context panel as a dismissible drawer. Small screens use a labeled project/session drawer. Subdued text colors have readable contrast in both themes; native sliders, focus indicators and keyboard navigation remain available. Text sizing/reflow checks follow the intent of [WCAG Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html) and [Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html). This is targeted verification, not a claim that the whole application has undergone a full accessibility audit.

## Agent files

The agent overview shows **Agent files** above Skills. Open standing instructions (`instructions.prepend.md`), memory (`memory/index.md`), the memory system/guide, and the provider’s generated runtime instructions (for example `CLAUDE.md`). Only files that exist are listed. Conventional identity files present at the group root are labeled Reference; preserved `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `MEMORY.md`, `AGENTS.md`, `ROLE.md`, and `CREDO.md` under `memory/openclaw-reference/` appear separately as Imported references. They are not presented as the active source of the agent’s identity.

The viewer is read-only. Markdown links into the agent’s memory tree open in the same dialog; Back returns to the preceding file. Generated instructions are identified as generated at startup, and file modification times use the install timezone. Refresh files reloads the inventory; returning to the browser also refreshes it. Empty files, unavailable files and read errors have explicit states. Files over 1 MB are unavailable in this viewer.

The owner-paired API exposes only recognized root instruction files and `.md` files below that agent’s `memory/` directory. It refuses traversal, symlinks and arbitrary config/credential files. No file-writing endpoint is added. Isolated previews snapshot these Markdown files, including linked memory notes, without copying unrelated group files or provider state.

## Agent skills

The agent overview shows **Skills** below Projects. Filter by name or description, then select a skill to read its instructions. Shared skills follow the same selection and gateway rules as agent execution; private skills come from the selected provider’s group folders and override shared skills of the same directory name. Each row identifies its source. Missing or malformed files are marked unavailable, and unreadable folders show a warning.

This is the current agent configuration, not a record of what a running conversation loaded. Project-only and conversation-only skills are excluded. Refresh the list after changing skills; returning to the browser also refreshes it. Viewing instructions never installs, edits or enables a skill. Isolated previews snapshot only `SKILL.md` files into their private preview tree.

## Agent progress

Expand **Worked** or **Working** to inspect tool activity. Collapsed tool rows include a single-line command or argument preview; long previews truncate to fit, and expanding the row reveals the full input. Steps show the tool name and timestamp, with separate input/output sections and indented JSON. Outputs longer than six lines or 700 characters start as compact previews; **Show full output** reveals all stored text in a scrollable area, and **Collapse output** returns to the preview. The same controls apply to long inputs and errors.

Completed activity blocks are queued for automatic summaries as they are archived, even when the next turn starts immediately. Replayed completion events reuse the same jobs. Disabling automatic summaries keeps generation on demand.

## Archived chats

The **Show archived chats** switch below the sidebar chat list includes archived conversations alongside active chats in their projects and pinned list. Hover or focus a sidebar session to reveal its archive button; archived sessions show an unarchive button. These buttons remain visible on touch devices. Archived rows show an archive icon. The switch starts off and remembers your choice in this browser across reloads; hiding archived chats leaves the currently open conversation unchanged.

## Context and directories

The main sidebar **New conversation** button always creates in **Unassigned**, regardless of the open project or chat. The plus button beside each project in the sidebar creates and opens a new session in that project, including when its chat list is collapsed. Project defaults are snapshotted into new sessions. Editing a project's defaults does not move existing sessions. A session can attach several directories, remove all directories, choose a primary working directory, and override model/effort within the agent's installed provider. Docker folder/model changes wait for a runner acknowledgement at an idle boundary and refuse to proceed during an active turn. Native macOS permission/folder changes stop and resume execution under a new OS profile. New conversations open immediately using the agent's default Docker/native backend. Change it in the conversation's Access → Runtime selector before its first accepted message or execution. After that it is fixed, even if runner startup fails. Backend changes do not start a runner. Docker folder approval is required before sending, rather than before creating an empty conversation. See [Native macOS execution](native-execution.md) for permissions, approvals, and tested limitations. Older references here to a “native session” mean a NanoClaw session, independently of its execution runtime.

The folder picker shows host paths. Containers see `/workspace/extra/ws-<attachment-id>`. The host passes both paths, access mode, and primary-directory selection into context. Composed agent instructions still load when cwd changes. Agent workspace and capabilities stay under `/workspace/agent`.

Folder access uses NanoClaw's existing mount validation, allowlist and blocked-path checks. Attaching a path never grants it automatically. Review access, then explicitly confirm the exact read/write or read-only folders. Imported paths also require access review before continuation. The UI does not grant a whole home directory as a convenience fallback.

## Scratchpads and utility models

Each session and project has one editable Markdown document with immutable revisions. Saves compare revision numbers; a delayed background or agent write cannot overwrite a newer human edit. The UI preserves an editing draft and offers the latest revision for reconciliation. Restoring an old revision creates a new revision.

Project brief and attached paths refresh in each turn's context. Session and project scratchpad contents are not included automatically; both are available on demand through the `workspace_context` MCP tool (`scope: "session"` or `scope: "project"`), along with imported reference history. The tool can also update scoped scratchpads with revision checks.

Workspace Settings configures utility inference separately from agent chat models. The default is local Ollama `qwen3.8:27b-mlx`. Overrides are available for titles, session summaries and project summaries. Apple FoundationModels uses the compiled native helper and reports OS/model availability. The existing-agent option uses an isolated utility session with tools, MCP, standing instructions and memory hooks disabled; currently Claude/OpenCode support this route. There is no silent provider fallback.

Completed replies enqueue durable, debounced summaries. New evidence coalesces; conflicts retry against the latest document. After three inference failures the job remains visibly failed. Session summaries update project summaries. Long inputs use ordered chunking and reduction rather than dropping old messages. Local models can make factual mistakes; evidence and revision history remain accessible.

## OpenClaw import

Settings → Import history previews local groups and agent mappings before copying. OpenClaw databases are opened read-only. Shared groups become projects, preserving default paths. Custom conversation labels take precedence over generated/display names. Import includes normal, compressed and archived transcript events and locally available attachments; unavailable attachments are reported.

Re-running an import uses stable source keys and event IDs. It neither duplicates messages nor replays tool calls, approvals or pending actions. Imported conversations are reference-only. “Continue in NanoClaw” creates a new native session with an overview and a link to source history, not an incompatible provider-session resume.

## Storage and architecture

`src/modules/workspace-ui/` owns the HTTP server, auth, store, import and utility orchestration. `web/workspace/` owns the React frontend. Core hooks are in `src/session-workspace.ts`, the mailbox interfaces, host lifecycle, routing, and runner display events. The existing two-writer split is preserved: the host writes context/control to inbound; the runner writes display/state records to outbound. SSE only signals changes; durable messages remain canonical.

Central `ws_*` tables hold project/session metadata, projected history, scratchpads/revisions, cursors, jobs, files and import mappings. Captured outgoing attachment bytes live in `data/workspace-files`, independent of the delivery outbox cleanup. This includes private history; include it in encrypted backups and do not commit preview copies.

## Verification and troubleshooting

```sh
pnpm exec vitest run src/modules/workspace-ui
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
(cd container/agent-runner && bun test)
pnpm audit
```

Use `ncl workspace status` and host logs if the listener is unavailable. A port failure is reported without stopping messaging agents. Build frontend assets if the server reports they are missing. A failed utility connection stays visible; check the selected model and local endpoint. Apple must report available before use. Use revision history to inspect unexpected summary edits.

## Installable app and notifications

The private HTTPS address in **Settings → Access** is the canonical iPhone app address. In Safari, use **Share → Add to Home Screen**, then launch NanoClaw from its icon. On iOS versions offering **Open as Web App**, leave it enabled. iPhone push requires iOS 16.4 or newer and a Home Screen app; Safari, Chrome and Firefox desktop Web Push endpoints are supported. There is no public website, Funnel, Apple Developer account or external notification-management service.

Pairings now persist across host restarts, until revoked. The first upgrade from memory-only pairing requires one new pairing. Access displays a one-time link and a 12-character code; links last two minutes, manual codes last ten minutes, and either consumes the shared one-time pairing; the installed app can accept the code directly. Wrong attempts are rate-limited. Safari cookie copies become separate installation identities on first launch, so browser and installed-app devices can be revoked independently. HttpOnly origin-bound credentials are stored as hashes; the browser cookie renews for one year on authenticated requests. Browser storage removal can require re-pairing. Rename/disconnect devices in Access or Notifications; disconnection revokes authentication, SSE, presence and future push. This copy's private `data/` directory must retain owner-only access because it holds push subscriptions and the installation signing identity.

**Settings → Notifications** has the global switch (off until enabled), four event switches, preview privacy, reading behavior, and device enable/test controls. After enabling global notifications, tap **Enable notifications on this device** inside the installed app and accept the OS prompt. Nothing requests permission automatically. Denied permissions require enabling notifications in the device's settings. **Send test** reports acceptance by the push service; receipt on the target device is the delivery proof.

The global Activity button opens recent activity, unread state, mark-all-read and quick pause. On mobile it is available in the navigation drawer, and in the overview header. Agent picker bells, project menus/settings and the session header/settings expose the same scoped control. On narrow screens, session settings also expose pin/archive actions.

Preferences belong to the owner and synchronize across devices. Scope resolution is **session → project → agent → default on**; explicit On can override a parent's mute. Global off/pause, disabled event types, disabled devices and withdrawn tailnet access remain absolute gates. Projects are shared across agents, so a project override applies to its sessions across agents. Temporary pauses support 15 minutes, one hour and eight hours, retaining the underlying preference; expiry returns to that preference. iPhone Focus supplies recurring quiet time. Muted activity remains in the inbox/history.

Only native conversations started or continued in this UI generate events. Imported history, external-channel conversations, streaming text, tools, scratchpad/title updates and intentional cancellations do not generate pushes. Completed logical turns coalesce wrapped message blocks and corrective retries. Questions/approvals are deduplicated by request ID and checked for resolution before dispatch. Failures use a generic user-facing explanation, never runner diagnostics. Default previews include a bounded plain-text excerpt; Names only and Private modes are available.

Default reading suppression skips ordinary reply pushes while the exact session is visible, focused and at the latest messages on any device. Questions, approvals and failures still notify other devices; the reading device is suppressed. Settings can instead suppress only the reading device or always notify. Presence renews every ten seconds and expires after thirty seconds; opening a background tab does not establish reading presence. Activity is marked read when viewed or explicitly marked, not when a push service accepts it. App badge counts update on app refresh and visible pushes; cross-device silent badge updates are deliberately not used.

The Mac must be awake and NanoClaw running to send new events. Push delivery uses encrypted Web Push through Apple/Google/Mozilla infrastructure and can arrive while Tailscale is disconnected on the phone; opening the session requires Tailscale. Disabling access stops remote delivery. A notification opens its exact reply/request; requests already resolved show that state. Lock-screen actions never approve privileged operations.

The durable source cursor, activity and per-device outbox survive restarts. Transient failures retry up to eight attempts with exponential backoff and Retry-After support; 404/410 remove expired subscriptions. Policies, owner roles, presence, expiration and pending request state are rechecked at dispatch. Reply delivery expires after one hour; attention events after 24 hours or the request expiry. Activity retains 30 days. API/device health exposes failures without printing subscription endpoints, encryption keys, signing keys or cookie credentials.

The manifest uses a stable root ID and launch URL with no credentials. A versioned service worker caches only public shell/assets/icons. Chats, files, API responses and credentials are never service-worker cached; offline launch provides connection/retry and pairing controls, and messages require a live connection. Updates wait for **Update app** instead of reloading while typing. Existing local draft storage remains unchanged.

### Scrolling and pairing feedback

The pairing page owns its vertical scroll area; long instructions grow from the top instead of being centered outside the viewport. Safe-area padding protects content around iPhone browser chrome. The session list, conversation, context, settings, overview and form scroll regions support keyboard focus. Dialogs retain an outer scroll path when their content cannot fit a short or large-text viewport. Pairing submission shows busy state, aborts a stalled connection after 15 seconds, verifies that the browser retained its cookie, and focuses errors beside the submit button. The phone displays the tailnet-specific CLI command. Manual codes stay visible and valid for ten minutes independently of the two-minute URL.

### Form spacing and theme contract

The shared stylesheet is `web/workspace/src/style.css`. Use `ui-stack` for related
controls and `ui-stack settings-stack` for section boundaries. The parent owns
vertical spacing; direct children have no block margins. The spacing tokens are
`--space-field` (label/control), `--space-control` (related controls), and
`--space-section` (separate sections), in rem so they follow the text-size setting.
Keep component-specific styles scoped and avoid combining a grid gap with the
global label/control margin. Execution and notification fields explicitly reset
that margin. Use the existing surface, line, accent, and warning tokens so controls
and status messages follow both themes.

For form changes, build the workspace and inspect the real rendered form on desktop,
at 390px width, and at 200% text. Check section gaps, wrapped tabs, scroll access to
the final action, and horizontal overflow. Keep the matching source under
`.claude/skills/add-workspace-ui/payload/` synchronized; the replay test checks it.

### Private agent browser

Agent execution → Browser exposes the opt-in host Chrome exception, current status,
and **Open browser**. One persistent private profile per agent retains manual website
logins; native conversations share cookies and use separate automation tabs. Chrome
runs outside NanoClaw’s filesystem/network policy with its own sandbox enabled.
See [Native execution](native-execution.md#host-chrome-exception) for authority,
revocation, CLI controls, and profile retention.

## Agent models and API connections

Open **Settings → Agents** to choose each agent's installed runner, API connection,
default model, and reasoning effort. These are the real `container_configs`
defaults, shared with `ncl` and connected channels. Saving waits for idle runner
handoffs and refuses to interrupt active turns. Session model overrides remain
independent. Switching runners requires confirmation because provider-specific
conversation context cannot transfer; shared memory, files, and saved messages
remain. Review existing session overrides before switching runners.

**Settings → API connections** manages non-secret OpenCode endpoints and model
catalogs. Supported transports are Chat Completions, Responses, and Anthropic
Messages. Give each model its actual context/output token limits and image-input
capability. Endpoints must use HTTPS and cannot contain credentials or query
parameters. Connection IDs stay stable after creation. Existing agent/session
references prevent removing a selected model or connection; revisions prevent
stale tabs from overwriting newer settings. Endpoint/model changes use idle
handoffs before being saved. Other connection drafts do not affect live agents.

The existing environment-defined BytePlus connection is imported once into the
central `model_connections` table by workspace migration 3/startup. The database
record then owns edits; `.env` remains the compatibility default for installations
without a saved connection. Effective session model IDs select the connection at
spawn, including per-session overrides. Each selected model supplies its own
limits rather than inheriting another model's window.

Credentials stay in the selected gateway. **Manage credentials** hands off to its
operator console for the chosen agent. Saving an endpoint does not create, copy,
or grant a secret. Provider-managed runner credentials have a separate handoff in
Agents. The monitoring dashboard and utility models remain separate.

### Chat attachments

Attach files with the paperclip, paste an image or copied file into the message field (Cmd+V on Mac), or drop files onto an open conversation. Image thumbnails, filenames and sizes appear before sending; each attachment can be removed. Ordinary text paste stays unchanged. Up to 10 files and 20 MB total are allowed per message, enforced on both client and server. Sending waits until file preparation completes; changing conversations clears pending attachments. Folder drops direct you to working-directory controls instead.

Attachments use NanoClaw’s existing message delivery and retained-file storage. Same-named files in one message receive distinct numbered filenames (for example, `image.png` and `image (2).png`), so every attachment remains available in history and downloads. Image understanding depends on the selected model: the composer warns when its configured model explicitly lacks image input (including the current GLM-5.2 connection). Attaching an image does not change the model automatically.

### Loaded context, instruction history, and project access

The conversation context panel now includes **Loaded**, showing the last native
turn's supplied instructions and memory, source hashes, working directory, HOME,
and effective access. Missing snapshots are labeled rather than reconstructed as
model context. Agent overview includes standing-instruction history with comparison
and optimistic-concurrency restoration. Agents retain permission to edit their own
standing instructions; history stores observed versions outside their writable area.

Project settings include shared domains and local/listening ports. These apply to
linked native conversations, and project directories are inherited live. Inherited
folders are labeled Project in conversation settings and are edited at the project.
Existing explicit conversation attachments remain explicit. Main checkouts and host
executables remain the default; no automatic Git worktrees are created.

### View URLs

The URL tracks the selected agent and project or conversation using `agent`, `project`, and `session` query parameters. Copy the URL to reopen the same view on a paired device. Reload and browser Back/Forward restore that selection. Conversation links resolve their owning agent and project; missing IDs return to an available agent overview. Pairing and notification links preserve the selected view.

Session Access → Docker shows the inherited agent grant. “Change for <agent>” opens that agent’s editable Docker settings directly; changes apply across its native conversations. The session panel refreshes inherited status after an agent policy save.

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

Select text within an agent reply and choose **Quote** to append it as a Markdown blockquote in your draft, with space beneath for your response. Existing draft text is preserved and nothing is sent automatically. The quote icon beside Copy quotes the selected passage from that reply, or the whole reply when no passage is selected. Keyboard users can select text and press **Alt/Option+Q**. Tap **×** beside Quote to clear the selection without quoting. Tapping outside the selected message or document also clears it; keyboard users can press **Escape**. Quotes are scoped to the current conversation; imported reference-only chats cannot accept drafts.

## Tool activity history

Completed native turns retain a separate **Worked** block with their tool inputs, outputs and statuses. Each block is pinned after that turn’s last agent reply, before subsequent user messages; the active turn alone uses the live **Working** block. Independent replay cursors restore earlier completed turns from retained mailbox events without replaying messages, notifications or agent actions. Repeated collection and restarts do not duplicate blocks. Older activity without retained events cannot be reconstructed. Activity summaries remain attached to their original blocks, including when loading earlier messages.

The rename dialog focuses the title field. Press Enter or choose **Save title** to save and close it. Blank titles are rejected, repeated submissions are disabled while saving, and save failures leave the edited title available for retry.

Session scratchpad summaries target 50–90 words in the user’s latest substantive conversational language, with localized Goal, Now, and (when supported) Next or Blocked labels. They preserve human corrections, replace stale status with newer evidence, and omit historical recaps and nonessential metrics. This is a generation instruction, not a hard truncation limit. Existing notes change on the next automatic or manual refresh.

Tool activity uses the same evidence format while live and after archival. Saved summaries remain visible across later turns and reloads. Older archive-envelope summaries are reused only when all tool evidence still matches; real input, output, status or error changes invalidate them.

Expired approval cards show an Expired label and a dismiss control in both chat and the requests view. Dismissal persists across reloads and devices without approving, denying, or deleting the original approval record. Active requests cannot be dismissed.


## Approval decisions and history

The **Requests** button opens pending requests and **History**, even when nothing is waiting. Each request shows its absolute deadline, a countdown, and an optional comment field. Comments are limited to 2,000 characters and are sent only when you submit a decision. A typed draft stays visible after expiry and is never sent automatically.

Ordinary action approvals have a ten-minute decision window. A provider's earlier deadline remains authoritative. Native live connection requests keep their two-minute technical deadline: extending a card cannot keep a closed connection alive. Expired cards can be dismissed without changing their historical decision.

A decision and its application are recorded separately. **Approved** records your consent; **Applied** confirms that the handler finished. A failure or host restart during application can leave **Failed** or **Uncertain**. These states do not claim that a grant succeeded, and the host never automatically replays an operation whose outcome is uncertain.

History retains the decision, selected option, actor, submitted comment, application result and ordered lifecycle timestamps for 90 days. Uncertain applications remain available until reviewed rather than being pruned. Records retained from older versions are marked as imported; deleted historical records cannot be reconstructed.

**Ask agent again** on a rejected or expired request sends a new message asking the agent to reassess the current task. It neither renews the old approval nor replays a tool. The agent must request fresh approval if still needed.

For native permission requests, only the requesting conversation pauses. The host persists the wait and queues a durable outcome message. Approval resumes it after the permission is applied; denial or expiry resumes it without a grant so the agent can explain the blocker or use a permitted alternative. Stopping the task cancels its outstanding wait. Other agent conversations continue; an agent-wide policy addition is picked up by siblings at their next idle boundary. Tool activity before the pause remains in conversation history.

The runner negotiates durable waits with the host. During an update, a newer runner does not block waiting for a response protocol that an older host cannot provide. Startup reconciles persisted decisions and queued outcomes, and closes stale live-connection requests rather than reviving them.

Scheduled task sessions (`system:tasks:*`) are collected alongside conversations, including completed tasks. Their Workspace replies appear in their own session and notification activity. Retained mailbox history is recovered on the next collection after an upgrade; cursors prevent duplicate messages and notifications. Internal utility sessions remain excluded.

### Native permission batches and agent status

The native `request_access` tool accepts a `requests` array of up to 20 related permissions. Submit both app and simulator ports in the same call:

```json
{"requests":[{"kind":"listen","target":"18080","reason":"Run the app"},{"kind":"listen","target":"18099","reason":"Run the simulator"}]}
```

One decision validates the complete batch, writes one policy revision and replaces the requesting sandbox once. Existing pending cards are immutable: new permissions never silently expand an already displayed consent request. The legacy single-permission shape remains accepted. Concurrent identical batches reuse the same pending approval; order and reason wording do not change permission identity.

Before requesting consent, the tool checks current status. Permissions already available in the running sandbox return `already_available`; pending ones return `requested` and the existing `approvalId`. Grants saved for a future or failed sandbox replacement return `approved` with `appliedToRunningSandbox: false` (or `null` for an older runner without a launch snapshot). They do not trigger another consent request.

The read-only `get_access_status` tool accepts the same permission list. Each result includes the decision status, saved-policy `granted` flag, approval ID, application state and `appliedToRunningSandbox`. The response also includes desired and running policy revisions. The running result comes from the host-built sandbox launch snapshot, including implicit working-folder roots and mandatory denies, rather than inferring success from a permission error or restart notice. A saved approval alone is not proof of access in the current process. Queued outcomes also carry structured decision/application metadata to the resumed agent.

The session sidebar shows an accent spinner while an agent is working, including sessions you are not viewing. It stops on completion, failure, cancellation, a stopped runtime, or a question/approval awaiting input. The green dot continues to indicate an available running process. Reduced-motion settings keep the activity ring still; its accessible label and tooltip read “Agent working”.


## Context usage beneath the composer

The composer footer shows the latest backend-reported context occupancy, for example **Context ~42%**. Hover for used tokens and the reported context window. The estimate includes cached context; it is a snapshot of the latest model call, not the sum of token spending across the conversation. It remains visible on mobile, survives reloads, and decreases when the backend reports a smaller context after compaction.

OpenCode reports the main session's latest input, cache, output and reasoning token footprint, divided by that model's context window from the running backend's model catalog. Subagent usage does not replace the main session's reading. Claude uses the SDK's local summary of its effective context window without requesting a full per-category token count. Other backends, unreported model limits and new conversations show **Context —** until a supported reading is available. The display updates when telemetry arrives; unsent draft text is not included. Changing models hides the previous model's reading.

### Message commands

Type `/` at the start of the message input to list session commands; keep typing to filter. Use ↑/↓ to select, Enter or Tab to insert, and Escape to close. Clicking also inserts a command. Insertion never sends it; add any arguments and send normally. Shift+Enter still inserts a newline.

Claude sessions offer `/compact` (summarize older context and continue), `/context`, `/cost`, and `/files`. All providers offer `/clear`, which resets context without summarizing. OpenCode sessions also offer `/compact`: it calls native session summarization with the selected model, preserves the session ID, and confirms completion in chat. Use it without arguments. Automatic compaction remains enabled. The context meter waits for fresh usage after compaction. Failures leave the session ID intact and report an error so you can retry. Commands remain subject to the host's existing permission checks.

During manual compaction, the session shows as working; Stop cancels the operation. Success, failure, and cancellation end the working indicator. Commands handled without a model turn leave background session echoes pending until the next ordinary message; cross-session context sharing is unchanged.


## Runtime interruptions and access pauses

A stopped runtime ends its live activity even when it could not send a terminal event.
The collector drains retained events before reconciling stopped sessions, preserves tool
results and partial responses, and archives unfinished tools as interrupted. Runtime-end
notifications are incarnation-fenced; startup collection repairs legacy stale activity.
The sidebar, tool panel and Stop control then show the same stopped state.

A temporary Tailscale verification failure closes remote authorization and returns HTTP
503 with `workspace_access_paused` and `Retry-After` for the previously verified address.
Unknown hosts still receive HTTP 403. Pairings survive a pause. Access resumes only after
the private route is verified again; an explicitly disabled route is not treated as a pause.

Gateway transport and approval availability block session admission independently. A healthy
transport cannot reopen admission while approvals are unavailable, and vice versa. Transport
probes continue when no agent is running so recovery does not depend on starting a new session.
`Gateway health changed` logs record probe duration, source and event-loop delay without secrets.
Docker commands in session and egress-network management are asynchronous; observer processes
are owned by the host and terminate on IPC disconnect without stopping adoptable containers.


### Ordered model output

Messages sent while an OpenCode turn is working wait for the next turn. The current turn’s activity and replies stay above those queued messages, during live updates and after completion or reload.

OpenCode turns retain text, provider-reported reasoning and tool calls in arrival order. Reasoning and tool calls share one expandable Working/Worked block in arrival order; ordinary agent messages split those blocks. Step counts and summaries cover tools only. Reasoning shows a single-line running tail; expand it for the complete trace, including during generation. Long reasoning is fetched on expansion. Scrolling up in an expanded trace pauses following new text. Output survives completion, approval waits, cancellation and errors. Reasoning is never included in notification previews or activity summaries. Older retained mailbox events are replayed once; their text is unclassified because the former adapter did not retain reasoning metadata.

### Document drawer

Click an attachment in chat or Files to open the document drawer on the right. Its tabs are remembered per conversation in this browser. Context restores the previous context panel; closing the drawer keeps its tabs. Markdown, UTF-8 text/code, PDF and raster images are previewable. Unsupported formats remain downloadable. Text previews are limited to 2 MiB, other previews to 20 MiB. PDFs are rendered locally; no document bytes go to an external viewer.

Working text and Markdown documents have Edit and Save (Cmd/Ctrl+S). Attachments and read-only folders cannot be edited. Clean documents follow disk changes; unsaved drafts are preserved and stale saves rejected. Copy draft and Reload latest resolve a conflict. Drafts survive switching tabs or chats in the current page; leaving the page asks before discarding them. Prior disk bytes are retained under private workspace-files/.document-revisions before saves.

Agents use `workspace_viewer` with operation `open` and `path` or `attachmentId`, then `focus`/`refresh` with the returned `documentId`. `list` returns registered documents. The tool requests presentation in this conversation and does not confirm receipt by a user. Agents cannot close tabs or discard edits. Working files must be in the agent workspace or an explicitly accessible mounted folder. Hidden and runtime/credential files are excluded. Live saves are disabled in isolated previews.

Select a passage in a document preview and choose **Quote** (or Alt/Option+Q) to append it to the message draft. Quotes appear as styled blocks in the composer, with a source label and an individual remove button; type your reply below them. They are saved separately from reply text for this conversation in this browser. The text sent to the agent identifies the document name, working path or attachment ID, document ID and revision; PDF quotes also include the page. Unsaved preview edits are labeled as an unsaved draft. Nothing is sent automatically. Existing draft text stays intact. On small screens or in an expanded viewer, quoting returns to the composer while preserving document tabs. Read-only attachments support quoting.


### Runner replacement and Stop

An unfinished turn becomes **Interrupted** when its runner is replaced, including when the replacement is already idle or working. Retained output stays in history. Stop requests cancellation of an active turn; when the session is idle it refreshes activity and reports that nothing is running. A request acknowledgement is not proof that a command has terminated.
