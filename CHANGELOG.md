# Changelog

## Unreleased

- Refresh the README and demo with all four themes, utility model options, mobile access and current chat features.
- Keep session overviews concise, follow the latest conversational language and replace stale status with newer evidence.

- Focus the title when renaming a conversation and support Enter to save, retaining edits on failure.

- Retain completed tool activity for every native turn and pin it after the corresponding agent reply, with idempotent recovery from retained events.

- Quote selected agent text or entire replies into an existing draft, with keyboard and touch controls.

- Use the first message as a provisional conversation title while awaiting utility-model naming.

- Add a standalone whisper.cpp speech backend with readiness checks, while preserving existing MyWhispr installations and settings.

- Add cached, bounded utility-model summaries to completed tool activity, with per-task model selection and on-demand summaries for older blocks.

- Keep mobile composer controls aligned, with a single-line folder path and 44-pixel touch targets.

- Recover safely from connection interruptions with read-only retries, a persistent status banner and privacy-conscious request diagnostics.
- Preserve Tailscale Serve during temporary verification failures while keeping remote authorization paused until the private route is verified.

- Dictate messages locally with the optional MyWhispr CLI, including review before sending and retry after transcription failures.
- Show recent conversations first, with latest-message previews and clearer unread badges.
- Keep project scratchpads scrollable within a bounded preview, with a full-view option.
- Remove disconnected devices from notification settings.
- Avoid duplicate Web labels and explain non-JSON server errors clearly.

## 0.1.0

Initial public preview: projects, conversations, folder context, revisioned scratchpads, image/file attachments, agent and model settings, responsive themes and text sizing, URL navigation, PWA installation, Tailscale pairing and scoped notifications.

Includes a conflict-aware installer, reversible integration patch, explicit source/release manifests, integrity and privacy checks, synthetic demo screenshot and clean-upstream tests. Docker runtime only; upstream compatibility is pinned in `compatibility.json`.
