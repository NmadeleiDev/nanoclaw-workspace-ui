# Remove Workspace UI

Follow README.md. Disable this add-on's dedicated Tailscale Serve route while the target is running. Stop only that target's host with operator authorization. Run the original release's `install.mjs --target <checkout> --check-remove`, then `--remove`.

Conflicting source edits stop removal before changes. Unchanged owned files are deleted; core changes are reversed by patch and other non-overlapping edits survive. The installer never deletes a provider module, user data, configuration records, memory, attachments, subscriptions or private keys. Reconcile the dependency lockfile and rebuild before restarting. Inspect generated build outputs separately. Removing user data requires a separate explicit decision.
