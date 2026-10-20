# Changelog

## 0.2.2

- Each response now reports the gateway's token usage to Copilot Chat, so the
  context window indicator in the chat input shows real usage instead of 0%.
  Cached input counts toward the prompt. This relies on an undocumented Copilot
  convention (a `usage` data part); session cost is still not shown, because
  that field only holds Copilot credits.

## 0.2.1

- Per-model token limits are now measured from the gateway instead of declared
  locally. The limits genuinely differ between models — 1,000,000/128,000 for
  Opus 5.x and Sonnet 4.6+, 200,000/64,000 for Opus 4.5 and Haiku 4.5 — so the
  single pair of settings was wrong for most of them. Both probes are rejected
  during validation, so nothing is billed.
- Measurements are remembered in global state, keyed by workspace and model, so
  only a newly served model is ever probed. Added a "Re-measure token limits"
  action to the status menu.
- Models are grouped by output cap so the large context probe is sent once per
  group rather than once per model, cutting a first sign-in from 12.6 MB to
  3.4 MB with identical measured limits.
- Each model's thinking API and effort levels are measured the same way, and the
  adaptive models now offer a "Thinking Effort" dropdown in the chat model
  picker. The gateway serves two incompatible thinking shapes and rejects the
  wrong one, so the style is read rather than assumed; models whose style could
  not be read are sent no thinking parameters.
- Removed the `(1M context)` picker entries, the `[1m]` id suffix and the
  `aiGateway.offerOneMContext` setting. The gateway serves the full window on
  the base model id: the `anthropic-beta: context-1m-2025-08-07` header made no
  difference to any model's measured limit, and the hardcoded allowlist both
  omitted models that do serve 1M and listed models this gateway does not serve.
- `aiGateway.maxInputTokens` and `aiGateway.maxOutputTokens` are now fallbacks,
  applied only when a model's limit cannot be read.

## 0.2.0

First Visual Studio Marketplace release, published as
`NextpointForge.aigw-models`.
The extension was renamed to drop the Databricks branding; it remains an
unofficial project with no affiliation to Databricks.

Breaking changes — a fresh install is treated as a new extension, so nothing
carries over from a previously side-loaded VSIX:

- The extension identifier changed from `databricks-aigw-models` to
  `aigw-models`. Uninstall the old extension to avoid two copies registering a
  chat provider and competing over `~/.claude/settings.json`.
- All settings moved from the `databricksAigw.*` section to `aiGateway.*`. The
  old values are not migrated and must be set again, including
  `aiGateway.accountId`.
- All commands moved from `databricksAigw.*` to `aiGateway.*` and are now
  listed under the "AI Gateway" category.
- The authentication provider and chat model vendor id changed from
  `databricks-aigw` to `ai-gateway`, so one re-sign-in is required.
- The Claude Code helper script is now `ai-gateway-token.sh` (`.cmd` on
  Windows) and the settings backup suffix is `.ai-gateway.bak`. Sign-out still
  cleans up a helper left behind by an older version.

Other changes:

- Licensed under Apache-2.0 and a `LICENSE` file is now included.
- Corrected the `aiGateway.maxInputTokens` description, which claimed the 1M
  entries declare 1000000 input tokens rather than 872000.

## 0.1.3

- Quote the Claude Code `apiKeyHelper` path for shells when it contains spaces.
- Disable Claude Code experimental betas that the gateway rejects.

## 0.1.2

- Fix prompt caching and add token usage logging.

## 0.1.0

- Initial release: Databricks account OAuth sign-in, live Claude model discovery,
  VS Code chat model provider and Claude Code configuration.
