# Security

This add-on can send messages to agents with access to working folders. Treat it as a privileged local application. Keep localhost access private; use the supported Tailscale HTTPS and device pairing flow for remote devices.

For a suspected vulnerability, use [GitHub private vulnerability reporting](https://github.com/NmadeleiDev/nanoclaw-workspace-ui/security/advisories/new). Do not post credentials, pairing links, private conversation content or exploit details in public issues. Include the add-on version, upstream commit, affected boundary and a minimal reproduction using fictional data.

The initial 0.1 release is a preview. Only the latest published revision is maintained; compatibility is explicitly pinned, not promised for every NanoClaw revision. Dependency review is dated evidence, not a permanent security guarantee. Audit the resolved target lockfile and review source changes before upgrading.

Public bug reports should omit secrets and installation-specific logs. We do not need your API keys to investigate a report.
