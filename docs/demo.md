# Demo tour

![Synthetic workspace](demo.png)

The screenshot uses fictional **Atlas** and **Research** projects and an **Assistant** agent. It contains no imported conversations or personal workspace data.

Try this short tour after installing:

1. Create a project named **Atlas**. Add a brief: “Plan, build and review the next release.” Attach a folder you deliberately want this agent to access.
2. Start a conversation. It inherits the project folders; use its context panel to choose different folders for that conversation.
3. Send “Help me plan the next release.” Paste an image with ⌘V or drag a file into the composer. Image understanding requires a model that accepts images.
4. Open the session scratchpad. Keep the goal, decisions and next action there; inspect its revisions as the overview updates in the background.
5. Open Settings to explore themes, text size, agent models and API connection metadata.
6. In project settings, mute notifications for Atlas. Session overrides let you keep a particular conversation audible; global and device gates always apply.
7. On an iPhone connected to Tailscale, pair through Settings → Access and add the app to the Home Screen. Enable notifications from that installed app.

The screenshot is a visual demo, not evidence of live inference or device push delivery. Those features use your own configured NanoClaw, model provider and device permissions.

Do not publish output from `workspace:preview`: that operator preview copies local history. Use a separate clean installation and fictional content for any screenshots or recordings you contribute.
