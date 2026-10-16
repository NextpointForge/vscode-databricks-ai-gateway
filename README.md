# AI Gateway Models for VS Code

> [!WARNING]
> **Experimental and unofficial.** This extension is an unofficial side project.
> It is not affiliated with, endorsed by or supported by Databricks. Its
> behaviour and settings may change or break without notice, and it is not
> covered by any support or security review process. Use it at your own risk,
> and prefer your organisation's official setup tooling for anything you depend
> on.

Signs in to a Databricks AI Gateway and makes the approved Claude models usable
inside VS Code — in the chat model picker, and in Claude Code.

One browser sign-in. No Databricks CLI, no local relay process, no personal
access token.

## What it does

| | |
| --- | --- |
| **Sign-in** | Databricks account OAuth (authorization code + PKCE) straight from VS Code. The refresh token goes into VS Code's `SecretStorage`; access tokens are minted on demand and never written to disk. |
| **Workspace** | Lists the workspaces your login can see, keeps the ones whose name matches `aiGateway.workspaceFilter` (default `costcenter`), and asks which to use when there is more than one. |
| **Models** | Discovered live from the workspace gateway. Nothing is hard-coded, so a newly enabled model shows up without an extension update. Models that support the 1M context window also get a second **(1M context)** entry. |
| **VS Code chat** | Registers an `ai-gateway` model provider, so the Claude models appear in the chat model picker and are available to any extension through `vscode.lm`. |
| **Claude Code** | Points `ANTHROPIC_BASE_URL` at the gateway and installs an `apiKeyHelper` that keeps the hourly token fresh. |
| **UI** | A status bar item opens a quick pick with the sign-in state, the workspace, the live model list and every action. The credential also shows up in VS Code's **Accounts** menu. |

Only Anthropic Claude models are surfaced. Anything else the gateway reports is
dropped.

## Install

Requires VS Code 1.104 or newer (the language model provider API).

Install it from the Visual Studio Marketplace (search for **NextpointForge AI
Gateway Models**), or from the command line:

```bash
code --install-extension NextpointForge.aigw-models
```

To build and install from source instead:

```bash
npm install
npm run package
code --install-extension aigw-models.vsix
```

Set `aiGateway.accountId` to your Databricks account UUID — the extension will
prompt for it on first sign-in if it is unset — then run **AI Gateway: Sign In**
from the command palette.

## Using it

Everything is reachable from the **cat status bar item** on the right,
which opens a single quick pick:

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

Rows are actionable: the workspace row switches workspace, a model row copies its
id, and when Claude Code is not yet wired up its row writes the settings.

The Databricks credential is also registered as a VS Code **authentication
provider**, so the account appears under the Accounts gear in the activity bar
with its own **Sign Out** entry — which runs the full sign-out, including
reverting the Claude Code settings. Other extensions can request the same
credential through `vscode.authentication.getSession('ai-gateway', …)`;
VS Code prompts for consent per extension before handing it over. Note that the
Accounts menu only lists credentials that already exist, so the *first* sign-in
still comes from the status bar or the command palette.

## Commands

| Command | What it does |
| --- | --- |
| `AI Gateway: Sign In` | Runs the browser sign-in, picks a workspace, discovers models, and wires up Claude Code. |
| `AI Gateway: Select Workspace` | Switches workspace and re-discovers models. |
| `AI Gateway: Configure Claude Code` | Re-applies the Claude Code wiring on its own. |
| `AI Gateway: Status and Actions` | Opens the quick pick above. Same as clicking the status bar item. |
| `AI Gateway: Sign Out` | Deletes the stored refresh token and removes the keys it added to the Claude settings. |
| `AI Gateway: Show Log` | Opens the output channel. |

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `aiGateway.accountHost` | `https://accounts.cloud.databricks.com` | Databricks account console. |
| `aiGateway.accountId` | Databricks account UUID | Same account the setup scripts use. |
| `aiGateway.workspaceFilter` | `costcenter` | Case-insensitive substring. Empty lists every workspace. |
| `aiGateway.redirectPort` | `8020` | Loopback OAuth redirect port. Databricks allowlists this for the `databricks-cli` public client, so changing it will usually break sign-in. |
| `aiGateway.maxInputTokens` | `200000` | Context window advertised to VS Code for the base models. **The gateway reports `0` for its own limits**, so this is a local declaration. The `(1M context)` entries declare `872000` and ignore this. |
| `aiGateway.maxOutputTokens` | `64000` | Output cap advertised to VS Code for the base models. The `(1M context)` entries declare `128000`. |
| `aiGateway.offerOneMContext` | `true` | Offer the `(1M context)` entries. Set `false` on a workspace that is not entitled to the 1M window. |
| `aiGateway.configureClaudeCodeOnSignIn` | `true` | Set `false` to leave `~/.claude/settings.json` alone. |
| `aiGateway.tokenServicePort` | `0` | `0` picks a free loopback port per session. |

Both entries are listed, so the picker looks like this:

```
  ✦ Claude Opus 5                                        …claude-opus-5
  ✦ Claude Opus 5 (1M context)                       …claude-opus-5[1m]
  ✦ Claude Haiku 4.5                                  …claude-haiku-4-5
```

The `[1m]` suffix is this extension's own label and never reaches the gateway,
which 404s every suffixed spelling. A request for a `(1M context)` entry is sent
against the **base** model id with the `anthropic-beta: context-1m-2025-08-07`
header, which is how the gateway opens the wider window.

Haiku, older models and anything the gateway newly reports get no variant — the
allowlist is deliberately a closed list rather than a guess.

Listing both rather than switching a global setting keeps the choice per request:
the 1M window is charged at a higher rate, so it is worth spending deliberately.
If a workspace is not entitled to it, set `aiGateway.offerOneMContext` to
`false` to keep the variants out of the picker.

## How it works

```
VS Code chat ──▶ LanguageModelChatProvider ──▶ https://<workspace>/ai-gateway/anthropic/v1/messages
                         │
Claude Code  ──▶ apiKeyHelper ──▶ 127.0.0.1 token service ──▶ AuthManager ──▶ Databricks OAuth
```

The gateway speaks the **native Anthropic Messages wire format**, so requests go
through the official `@anthropic-ai/sdk` with `baseURL` pointed at the gateway and
the Databricks OAuth token as the bearer credential. There is no translation
through an OpenAI-compatible shim and no local proxy in the request path.

One account-level token covers everything: the same token lists the account's
workspaces *and* authenticates against each workspace's gateway. That is why
sign-in is a single browser round trip rather than one per workspace.

### Tokens

- The refresh token lives in VS Code `SecretStorage` (OS keychain).
- Access tokens are held in memory, renewed ~2 minutes before expiry, and shared
  across concurrent chat requests so a fan-out does not trigger parallel refreshes.
- A `401` mid-request triggers exactly one retry with a freshly minted token.
- Claude Code runs outside the extension host and so cannot read `SecretStorage`.
  It gets tokens from a loopback service bound to `127.0.0.1`, gated on a
  per-session shared secret. The token is never written to disk.

### What it writes

| Path | Contents |
| --- | --- |
| `~/.claude/settings.json` | Adds `apiKeyHelper` and `env` keys: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, and an `ANTHROPIC_DEFAULT_*_MODEL` pin for each model family the gateway reports. Everything else is preserved, and the file is backed up to `settings.json.ai-gateway.bak` first. A file that is present but unparseable aborts the write instead of being replaced. |
| Extension global storage | The `apiKeyHelper` script, created user-only (`0700`). |

`Sign Out` removes those keys again and leaves the rest of the file untouched.

Claude Code's own `opus`/`sonnet`/`haiku`/`fable` aliases move to newer model
names on Claude Code's release schedule, independent of what a given gateway has
rolled out. Without a pin, Claude Code sends whatever name the alias currently
resolves to, which a gateway that hasn't caught up rejects with a 403 such as
`'claude-sonnet-5-5' is no longer available`. Pinning each `ANTHROPIC_DEFAULT_*_MODEL`
to the strongest version the gateway's `/v1/models` actually reports keeps Claude
Code on an id the gateway accepts. The pins are refreshed every time the
extension writes the Claude Code settings, so a newly rolled-out model is picked
up automatically; `AI Gateway: Configure Claude Code` re-applies them
on demand.

## Relationship to the setup scripts

This extension is a **self-contained alternative** to the platform setup scripts
for the VS Code case. It implements Databricks OAuth directly instead of driving
`databricks auth login` and `ug configure`.

Two consequences worth knowing:

- It does **not** apply Unity Gateway's machine-wide managed Claude settings
  (`/etc/claude-code/managed-settings.json`) or its live validation step. If your
  environment depends on those, run the platform script as well.
- It writes only the user-level Claude settings file, so it never needs sudo.

The scripts remain the path for Claude Desktop, Zed, and the other agents `ug`
supports.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run test          # typecheck + unit tests
npm run watch         # rebuild on change, then F5 in VS Code
```

`npm run test:live` exercises the real gateway — streaming, tool-call
reassembly, a `tool_result` round trip, and 401 handling. It takes the token on
stdin so the credential never lands in the process list or on disk:

```bash
ug auth-token --host "$WORKSPACE" --profile "$PROFILE" \
  | node test/live-gateway.mjs "$WORKSPACE"
```

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Models missing from the picker | Not signed in, or no workspace selected. Open the status bar menu and use **Refresh models**. |
| `Port 8020 is already in use` | Another Databricks or Azure CLI login is holding the redirect port. |
| Browser redirect never returns | The browser cannot reach the extension's listener (common on SSH remotes and some container setups). Click **Paste redirect URL instead** and paste the `http://localhost:8020/?code=...` address from the browser. |
| Claude Code still uses the wrong endpoint | Restart the `claude` session; it reads settings at startup. Check for a machine-wide `managed-settings.json` from a previous `ug` run, which outranks the user file. |

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Databricks is a trademark of Databricks, Inc. This project is not affiliated
with, endorsed by or supported by Databricks. Claude is a trademark of Anthropic,
PBC.
