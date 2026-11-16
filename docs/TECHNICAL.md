# Technical details

How the AI Gateway Models extension works under the hood. For installation and
everyday usage, see the [README](../README.md).

## Overview

| | |
| --- | --- |
| **Sign-in** | Databricks account OAuth (authorization code + PKCE) straight from VS Code. The refresh token goes into VS Code's `SecretStorage`; access tokens are minted on demand and never written to disk. |
| **Workspace** | Lists the workspaces your login can see, keeps the ones whose name matches `aiGateway.workspaceFilter` (default `costcenter`), and asks which to use when there is more than one. |
| **Models** | Discovered live from the workspace gateway. Nothing is hard-coded, so a newly enabled model shows up without an extension update. Models that support the 1M context window also get a second **(1M context)** entry. Only Anthropic Claude models are surfaced; anything else the gateway reports is dropped. |
| **VS Code chat** | Registers an `ai-gateway` model provider, so the Claude models appear in the chat model picker and are available to any extension through `vscode.lm`. |
| **Claude Code** | Points `ANTHROPIC_BASE_URL` at the gateway and installs an `apiKeyHelper` that keeps the hourly token fresh. |
| **Authentication provider** | The credential is registered as the `ai-gateway` authentication provider. Other extensions can request it through `vscode.authentication.getSession('ai-gateway', …)`; VS Code prompts for consent per extension before handing it over. |
| **Agents window** | The manifest declares `capabilities.agentsWindow.supported`, so the extension runs in the VS Code Agents window. That window has no status bar, so the status item is not shown there; the commands still work. |

## Architecture

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

## Tokens

- The refresh token lives in VS Code `SecretStorage` (OS keychain).
- Access tokens are held in memory, renewed ~2 minutes before expiry, and shared
  across concurrent chat requests so a fan-out does not trigger parallel refreshes.
- A `401` mid-request triggers exactly one retry with a freshly minted token.
- Claude Code runs outside the extension host and so cannot read `SecretStorage`.
  It gets tokens from a loopback service bound to `127.0.0.1`, gated on a
  per-session shared secret. The token is never written to disk.

## What it writes

| Path | Contents |
| --- | --- |
| `~/.claude/settings.json` | Adds `apiKeyHelper` and `env` keys: `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, and an `ANTHROPIC_DEFAULT_*_MODEL` pin for each model family the gateway reports. Everything else is preserved, and the file is backed up to `settings.json.ai-gateway.bak` first. A file that is present but unparseable aborts the write instead of being replaced. |
| Extension global storage | The `apiKeyHelper` script, created user-only (`0700`). |

`Sign Out` removes those keys again and leaves the rest of the file untouched.

### Model pins

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

## Token limits

`/v1/models` reports `max_input_tokens` and `max_tokens` as `0` for every model,
and the gateway has no `count_tokens` endpoint, so the real limits are measured
by asking for something impossible and reading the refusal:

```
max_tokens: 9000000 > 128000, which is the maximum allowed number of output tokens
prompt is too long: 1200000 tokens > 1000000 maximum
```

Both probes are rejected during validation, so no inference runs and no tokens
are billed. The limits genuinely vary — on the workspace this was developed
against, Opus 5.x and Sonnet 4.6+ serve a 1,000,000-token window with a 128,000
output cap, while Opus 4.5 and Haiku 4.5 serve 200,000 and 64,000 — which is why
they are measured rather than declared.

The output cap costs ~100 bytes to read, but the context probe has to upload
~1.1 MB to overshoot a 1M window. Models are therefore grouped by their output
cap and one context probe is shared per group, which on the workspace this was
developed against turns 11 large uploads into 2 — 3.4 MB rather than 12.6 MB,
with identical results.

Results are remembered in the extension's global state, keyed by workspace and
model id. A first sign-in measures; later ones spend nothing, and a model
Databricks adds later is measured on its own. Use **Re-measure token limits** in
the status menu to discard them and measure again.

A model whose refusal cannot be parsed falls back to the `aiGateway.maxInputTokens`
and `aiGateway.maxOutputTokens` settings and is retried after a day rather than
on every launch.

## Thinking effort

The same probing reads how each model expects thinking to be controlled, which
the gateway also refuses to advertise. Two incompatible shapes are served, and
sending the wrong one is rejected:

| Thinking API | Models (on the workspace this was developed against) |
| --- | --- |
| `thinking: {type: "adaptive"}` + `output_config.effort` | Opus 4.7, 4.8, 5, 5.5; Sonnet 5, 5.5 |
| `thinking: {type: "enabled"}` + `budget_tokens` | Opus 4.5, 4.6; Sonnet 4.5, 4.6; Haiku 4.5 |

For the adaptive models, the accepted effort levels are read from the gateway
(`low`, `medium`, `high`, `xhigh`, `max`) and offered as a **Thinking Effort**
dropdown on the model in the chat model picker. Effort measurably changes how
much the model thinks — on a trivial arithmetic prompt, `low` spent 32 thinking
tokens and `max` spent 116.

The dropdown relies on `configurationSchema`, which is still a proposed VS Code
API. A host that does not support it ignores the property, and requests are then
sent without an explicit effort so the gateway applies its own default.

Budget-style models are sent no thinking parameters at all: they already think
by default, and `budget_tokens` would only cap what they do anyway.

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

Build and install from source:

```bash
npm install
npm run package
code --install-extension aigw-models.vsix
```

Day-to-day:

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
