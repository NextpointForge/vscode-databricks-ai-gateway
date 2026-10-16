# Changelog

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
