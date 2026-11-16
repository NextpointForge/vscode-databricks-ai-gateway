# AI Gateway Models for VS Code

> [!WARNING]
> **Experimental and unofficial.** This extension is an unofficial side project.
> It is not affiliated with, endorsed by or supported by Databricks. Its
> behaviour and settings may change or break without notice, and it is not
> covered by any support or security review process. Use it at your own risk,
> and prefer your organisation's official setup tooling for anything you depend
> on.

Use your organisation's Databricks AI Gateway Claude models in VS Code: in the
chat model picker, in the Agents window, and in Claude Code.

You sign in once in the browser. You don't need the Databricks CLI, a local
relay process or a personal access token.

## Getting started

1. Install the extension. You need VS Code 1.104 or newer. Search the Visual
   Studio Marketplace for **NextpointForge AI Gateway Models**, or run:

   ```bash
   code --install-extension NextpointForge.aigw-models
   ```

2. Click the **cat icon** (**AI Gateway: sign in**) in the status bar at the
   bottom, then choose **Sign in**. If you haven't set your Databricks account
   ID (a UUID) yet, the extension asks for it.
3. Sign in in the browser. If you can use more than one workspace, pick one.
4. Open chat and pick a Claude model from the model picker.

Claude Code is set up as part of sign-in. Start a new `claude` session and it
goes through the gateway.

## Everyday use

Click the **cat icon** in the status bar to open a menu with everything in one
place. You don't need the command palette:

```
AI Gateway                               costcenter-prod — 4 Claude model(s)
─── Status ───
  ✔ Signed in                                          dev@example.com
  ⌸ costcenter-prod                  https://dbc-1234.cloud.databricks.com
  ❯ Claude Code: configured                 ~/.claude/settings.json
  ⇅ Token service                              http://127.0.0.1:41234
─── Models (4) · pick one to copy its id ───
  ✦ Claude Opus 5                                        claude-opus-5
  ✦ Claude Sonnet 5                                    claude-sonnet-5
  …
─── Actions ───
  ↻ Refresh models
  ⚒ Configure Claude Code
  ⇥ Sign out
  ▤ Show log
```

- Click the workspace to switch to another one.
- Click a model to copy its id.
- Click **Claude Code** to set up Claude Code if it isn't set up yet.

The model list comes straight from the gateway, so new models show up without
an extension update. Models that support it also get a **(1M context)** entry.
Newer models show a **Thinking Effort** option in the model picker.

Your account also appears in VS Code's **Accounts** menu, where you can sign out.

### Agents window

The extension also works in the VS Code **Agents window**. That window has no
status bar, so open the menu with **AI Gateway: Status and Actions** from the
command palette.

## Commands

The menu has everything you need. These commands are also in the command
palette, for example for keyboard shortcuts or in the Agents window.

| Command | What it does |
| --- | --- |
| `AI Gateway: Sign In` | Signs in, picks a workspace, loads the models and sets up Claude Code. |
| `AI Gateway: Select Workspace` | Switches to another workspace. |
| `AI Gateway: Status and Actions` | Opens the menu shown above. |
| `AI Gateway: Configure Claude Code` | Sets up Claude Code again. |
| `AI Gateway: Sign Out` | Signs out and removes the Claude Code setup. |
| `AI Gateway: Show Log` | Opens the log. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `aiGateway.accountId` | _(empty)_ | Your Databricks account ID (a UUID). Required. |
| `aiGateway.accountHost` | `https://accounts.cloud.databricks.com` | Databricks account console address. |
| `aiGateway.workspaceFilter` | `costcenter` | Only lists workspaces whose name contains this text. Leave it empty to list every workspace. |
| `aiGateway.configureClaudeCodeOnSignIn` | `true` | Set to `false` if you don't want the extension to change your Claude Code settings. |
| `aiGateway.redirectPort` | `8020` | Port used during sign-in. Leave it as is: other ports usually break sign-in. |
| `aiGateway.maxInputTokens` | `200000` | Fallback context size, used only if a model's real limit can't be read. |
| `aiGateway.maxOutputTokens` | `64000` | Fallback output size, used only if a model's real limit can't be read. |
| `aiGateway.tokenServicePort` | `0` | Port of the local token service for Claude Code. `0` picks a free port. |

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `AI Gateway budget exhausted` | The gateway's spending budget has run out, and signing in again won't help. Ask an administrator to raise the limit, then try again. Other models may use the same budget. |
| No models in the picker | Make sure you're signed in and have a workspace selected. Then use **Refresh models** in the menu. |
| `Port 8020 is already in use` | Another Databricks or Azure CLI sign-in is using the port. Finish or close it, then try again. |
| The browser never returns to VS Code | This is common on SSH remotes and in containers. Click **Paste redirect URL instead**, then paste the `http://localhost:8020/?code=...` address from your browser. |
| Claude Code still uses the wrong endpoint | Restart your `claude` session, because Claude Code reads its settings only at startup. If it still fails, check for a machine-wide `managed-settings.json` left by an earlier `ug` run. It takes priority over your user settings. |

## Learn more

[Technical details](docs/TECHNICAL.md) explains how sign-in and tokens work,
what the extension writes to disk, how model limits are measured, how it
relates to the platform setup scripts, and how to build from source.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Databricks is a trademark of Databricks, Inc. This project is not affiliated
with, endorsed by or supported by Databricks. Claude is a trademark of Anthropic,
PBC.