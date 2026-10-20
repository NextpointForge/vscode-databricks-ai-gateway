import { randomBytes } from 'node:crypto';
import { AuthManager, withFreshToken } from './auth';
import { CODING_AGENT_HEADER, anthropicBaseUrl } from './config';
import { log } from './log';
import { describe } from './oauth';

/**
 * Which thinking API a model accepts.
 *
 * The gateway serves two incompatible shapes and rejects the wrong one:
 * `adaptive` wants `thinking.type:"adaptive"` plus `output_config.effort`,
 * `budget` wants `thinking.type:"enabled"` plus `thinking.budget_tokens`.
 */
export type ThinkingStyle = 'adaptive' | 'budget';

export interface GatewayModel {
  id: string;
  displayName: string;
  /**
   * Set when {@link probeModelLimits} measured the limit. Unset entries fall
   * back to the configured values.
   */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  thinkingStyle?: ThinkingStyle;
  /** Effort levels the gateway accepts, strongest last. Only for `adaptive`. */
  effortLevels?: string[];
}

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const isUnauthorized = (error: unknown) =>
  error instanceof HttpStatusError && (error.status === 401 || error.status === 403);

/** Ranks the families strongest first. */
const FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * Payload that overshoots every context window the gateway serves.
 *
 * Random base64 is the densest filler the tokenizer accepts (~1.15 wire bytes
 * per token), which keeps the upload near 1.1 MB rather than the ~5 MB plain
 * prose would need to clear a 1M window.
 */
const CONTEXT_PROBE_BYTES = 900_000;

/** Absurd enough that no model's output cap can satisfy it. */
const OUTPUT_PROBE_TOKENS = 9_000_000;

export interface ModelLimits {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  thinkingStyle?: ThinkingStyle;
  effortLevels?: string[];
}

/**
 * The slice of `vscode.ExtensionContext.globalState` the cache needs.
 *
 * Narrowed to a two-method shape so this module stays free of a `vscode`
 * import and the cache can be exercised with a plain object in tests.
 */
export interface LimitStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** Bumped when the cached shape changes, so old entries are ignored rather than mistrusted. */
const LIMIT_CACHE_KEY = 'aiGateway.modelLimits.v2';

/**
 * How long a partly unreadable measurement is trusted before being retried.
 *
 * A model whose rejection wording cannot be parsed is still cached, otherwise
 * every launch would re-upload the full context probe for it forever. A day is
 * short enough that a gateway-side wording fix is picked up on its own.
 */
const UNRESOLVED_RETRY_MS = 24 * 60 * 60 * 1000;

interface CachedLimits extends ModelLimits {
  /** Dates the entry so a partly unreadable one can expire; see {@link UNRESOLVED_RETRY_MS}. */
  measuredAt: number;
}

type LimitCache = Record<string, CachedLimits>;

/**
 * Limits are entitlement-dependent, so a model's cache entry is scoped to the
 * workspace that reported it rather than shared across them.
 */
function cacheKey(workspaceOrigin: string, modelId: string): string {
  return `${workspaceOrigin}|${modelId.toLowerCase()}`;
}

/**
 * Reads a limit out of the gateway's rejection text.
 *
 * The wording differs per model and upstream provider, so each known phrasing
 * gets a pattern; an unrecognised one leaves the limit unset rather than
 * guessing, and the caller falls back to configuration.
 */
function parseLimit(message: string): number | undefined {
  const patterns = [
    /prompt is too long: \d+ tokens > (\d+) maximum/i,
    /> (\d+), which is the maximum allowed number of output tokens/i,
    /maximum tokens you requested exceeds the model limit of (\d+)/i,
    /exceeds the model limit of (\d+)/i,
  ];
  for (const pattern of patterns) {
    const value = Number(pattern.exec(message)?.[1]);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Sends one deliberately impossible request and returns the gateway's reply.
 *
 * The request is rejected during validation, so no inference runs: the reply
 * carries no `usage` and no message id, and nothing is billed. That is what
 * makes measuring affordable at all.
 */
async function askImpossible(
  auth: AuthManager,
  workspaceOrigin: string,
  body: unknown,
): Promise<string> {
  const url = `${anthropicBaseUrl(workspaceOrigin)}/v1/messages`;
  return withFreshToken(
    auth,
    async (token) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          [CODING_AGENT_HEADER]: 'true',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new HttpStatusError(response.status, `Limit probe returned HTTP ${response.status}.`);
      }
      return await response.text();
    },
    isUnauthorized,
  );
}

/**
 * Asks for more output than any model can produce; ~100 bytes on the wire.
 *
 * `/v1/models` reports both limits as 0 and the gateway has no `count_tokens`
 * endpoint, so provoking an error is the only way to learn them.
 */
async function probeOutputCap(
  auth: AuthManager,
  workspaceOrigin: string,
  modelId: string,
): Promise<number | undefined> {
  try {
    const text = await askImpossible(auth, workspaceOrigin, {
      model: modelId,
      max_tokens: OUTPUT_PROBE_TOKENS,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return parseLimit(text);
  } catch (error) {
    log.debug(`Output-limit probe for ${modelId} failed: ${describe(error)}`);
    return undefined;
  }
}

/**
 * Reads which thinking API a model accepts, and its effort levels.
 *
 * Both halves come from refusals. Asking for an impossible `budget_tokens`
 * makes an adaptive-only model name the API it wants instead, and an invalid
 * effort makes an adaptive model enumerate the levels it accepts — which is
 * the only accurate source, since `/openapi` advertises the same four levels
 * for every model and omits the `xhigh` that actually works.
 */
async function probeThinking(
  auth: AuthManager,
  workspaceOrigin: string,
  modelId: string,
): Promise<{ thinkingStyle?: ThinkingStyle; effortLevels?: string[] }> {
  let style: ThinkingStyle | undefined;
  try {
    const text = await askImpossible(auth, workspaceOrigin, {
      model: modelId,
      max_tokens: 2048,
      thinking: { type: 'enabled', budget_tokens: OUTPUT_PROBE_TOKENS },
      messages: [{ role: 'user', content: 'hi' }],
    });
    // The reply is JSON-escaped, so these phrases are separated by `\"` runs.
    if (/thinking\.type\.enabled.{0,40}not supported/is.test(text)) {
      style = 'adaptive';
    } else if (/greater than.{0,20}thinking\.budget_tokens/is.test(text)) {
      style = 'budget';
    }
  } catch (error) {
    log.debug(`Thinking-style probe for ${modelId} failed: ${describe(error)}`);
  }
  if (style !== 'adaptive') {
    return style ? { thinkingStyle: style } : {};
  }

  try {
    const text = await askImpossible(auth, workspaceOrigin, {
      model: modelId,
      max_tokens: 40,
      thinking: { type: 'adaptive' },
      // Invalid on purpose: the refusal lists the values that are valid.
      output_config: { effort: '\u0000' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    const listed = /expected one of ([^"]*?)(?:, `Unhandled`)? at line/i.exec(text)?.[1];
    const levels = listed
      ?.split(',')
      .map((value) => value.trim().replace(/`/g, ''))
      .filter((value) => /^[a-z]+$/.test(value) && value !== 'Unhandled');
    if (levels?.length) {
      return { thinkingStyle: style, effortLevels: levels };
    }
  } catch (error) {
    log.debug(`Effort-level probe for ${modelId} failed: ${describe(error)}`);
  }
  return { thinkingStyle: style };
}

/** Overshoots every window the gateway serves, which costs ~1.1 MB to upload. */
async function probeContextWindow(
  auth: AuthManager,
  workspaceOrigin: string,
  modelId: string,
): Promise<number | undefined> {
  try {
    const text = await askImpossible(auth, workspaceOrigin, {
      model: modelId,
      max_tokens: 8,
      messages: [{ role: 'user', content: randomBytes(CONTEXT_PROBE_BYTES).toString('base64') }],
    });
    return parseLimit(text);
  } catch (error) {
    log.debug(`Context-limit probe for ${modelId} failed: ${describe(error)}`);
    return undefined;
  }
}

/**
 * Fills in the limits the gateway refuses to advertise, probing only what is new.
 *
 * A model's limits change only when Databricks re-provisions it, so results are
 * remembered in global state and reused on every later sign-in: a returning user
 * spends nothing, and a model Databricks adds later is measured on its own.
 *
 * Probes are rejected rather than answered, so none of them is billed, but the
 * context probe still has to upload ~1.1 MB to overshoot a 1M window. Models are
 * therefore grouped by their output cap — which costs ~100 bytes to read — and
 * only one context probe is sent per group. On the workspace this was developed
 * against that turns 11 large uploads into 2.
 *
 * Anything that cannot be measured is left unset and falls back to the configured
 * defaults, so a model stays usable either way.
 */
export async function probeModelLimits(
  auth: AuthManager,
  workspaceOrigin: string,
  models: GatewayModel[],
  store?: LimitStore,
): Promise<GatewayModel[]> {
  // Copied, never mutated in place: `get` may hand back the stored object
  // itself, and writing through it would persist entries this function
  // deliberately keeps out of the cache.
  const remembered: LimitCache = { ...(store?.get<LimitCache>(LIMIT_CACHE_KEY) ?? {}) };
  const now = Date.now();
  const isFresh = (entry: CachedLimits) =>
    entry.maxInputTokens !== undefined && entry.maxOutputTokens !== undefined
      ? true
      : now - entry.measuredAt < UNRESOLVED_RETRY_MS;

  const stale = models.filter((model) => {
    const entry = remembered[cacheKey(workspaceOrigin, model.id)];
    return entry === undefined || !isFresh(entry);
  });

  if (stale.length > 0) {
    // Both are small requests, so every unknown model gets its own.
    const caps = await Promise.all(
      stale.map(async (model) => ({
        model,
        cap: await probeOutputCap(auth, workspaceOrigin, model.id),
        thinking: await probeThinking(auth, workspaceOrigin, model.id),
      })),
    );
    const thinkingByModel = new Map(caps.map(({ model, thinking }) => [model.id, thinking]));

    // The context probe is not cheap, so it runs once per distinct cap and the
    // answer is shared. Models that agree on their output cap have so far always
    // agreed on their window; a cap that cannot be read gets its own probe
    // rather than being lumped in with an unrelated tier.
    const byCap = new Map<number, GatewayModel[]>();
    const alone: GatewayModel[] = [];
    for (const { model, cap } of caps) {
      if (cap === undefined) {
        alone.push(model);
      } else {
        byCap.set(cap, [...(byCap.get(cap) ?? []), model]);
      }
    }

    const windows = await Promise.all([
      ...[...byCap.entries()].map(async ([cap, group]) => ({
        models: group,
        window: await probeContextWindow(auth, workspaceOrigin, group[0]!.id),
        cap,
      })),
      ...alone.map(async (model) => ({
        models: [model],
        window: await probeContextWindow(auth, workspaceOrigin, model.id),
        cap: undefined,
      })),
    ]);

    for (const { models: group, window, cap } of windows) {
      for (const model of group) {
        const thinking = thinkingByModel.get(model.id) ?? {};
        remembered[cacheKey(workspaceOrigin, model.id)] = {
          ...(window !== undefined ? { maxInputTokens: window } : {}),
          ...(cap !== undefined ? { maxOutputTokens: cap } : {}),
          ...thinking,
          measuredAt: now,
        };
      }
    }
    log.debug(
      `Probed ${stale.length} model(s) with ${byCap.size + alone.length} context probe(s): ` +
        [...byCap.entries()].map(([cap, group]) => `${cap}→${group.length} model(s)`).join(', '),
    );
    if (store) {
      await store.update(LIMIT_CACHE_KEY, remembered);
    }
  }

  const resolved = models.map((model) => {
    const limits = remembered[cacheKey(workspaceOrigin, model.id)];
    return {
      ...model,
      ...(limits?.maxInputTokens !== undefined ? { maxInputTokens: limits.maxInputTokens } : {}),
      ...(limits?.maxOutputTokens !== undefined ? { maxOutputTokens: limits.maxOutputTokens } : {}),
      ...(limits?.thinkingStyle !== undefined ? { thinkingStyle: limits.thinkingStyle } : {}),
      ...(limits?.effortLevels !== undefined ? { effortLevels: limits.effortLevels } : {}),
    };
  });

  const unresolved = resolved.filter(
    (model) => model.maxInputTokens === undefined || model.maxOutputTokens === undefined,
  );
  log.info(
    `Model limits: ${models.length - stale.length} remembered, ${stale.length} probed` +
      (unresolved.length > 0
        ? `; falling back to settings for ${unresolved.map((model) => model.id).join(', ')}.`
        : '.'),
  );
  return resolved;
}

/** Drops every remembered limit, so the next discovery measures them again. */
export async function forgetModelLimits(store: LimitStore): Promise<void> {
  await store.update(LIMIT_CACHE_KEY, undefined);
}

/**
 * Lists the Claude models this workspace's gateway will actually serve.
 *
 * Only Anthropic Claude is approved on the gateway, so anything else the endpoint
 * reports is dropped rather than surfaced in the picker.
 * The endpoint reports `max_input_tokens`/`max_tokens` as 0, so the real limits
 * are measured separately by {@link probeModelLimits} — do not treat those
 * fields as usable.
 */
export async function discoverModels(
  auth: AuthManager,
  workspaceOrigin: string,
  store?: LimitStore,
): Promise<GatewayModel[]> {
  const url = `${anthropicBaseUrl(workspaceOrigin)}/v1/models`;
  const payload = await withFreshToken(
    auth,
    async (token) => {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new HttpStatusError(
          response.status,
          `Model discovery returned HTTP ${response.status} from ${url}.`,
        );
      }
      return (await response.json()) as unknown;
    },
    isUnauthorized,
  );

  const entries =
    typeof payload === 'object' && payload !== null && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : undefined;
  if (!entries) {
    throw new Error('The gateway model list did not contain a "data" array.');
  }

  const models: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
    if (!id || !id.toLowerCase().includes('claude')) {
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const displayName =
      typeof record['display_name'] === 'string' && record['display_name'].trim()
        ? record['display_name'].trim()
        : prettifyId(id);
    models.push({ id, displayName });
  }

  if (models.length === 0) {
    throw new Error(
      'The gateway reported no Claude models for this workspace. Check whether AI Gateway is enabled on it.',
    );
  }

  log.info(`Discovered ${models.length} Claude model(s) on the gateway.`);
  const measured = await probeModelLimits(auth, workspaceOrigin, models, store);
  return sortModels(measured);
}

/** Exported for tests: orders a model list the way the picker presents it. */
export function sortModels(models: GatewayModel[]): GatewayModel[] {
  return [...models].sort(compareModels);
}

/** Env var that pins each family's Claude Code alias (`opus`, `sonnet`, ...). */
const CLAUDE_CODE_PIN_ENV_BY_FAMILY: Record<string, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

/** The `ANTHROPIC_DEFAULT_*_MODEL` variables {@link claudeCodeModelPins} can set. */
export const CLAUDE_CODE_PIN_ENV_KEYS = Object.values(CLAUDE_CODE_PIN_ENV_BY_FAMILY);

/**
 * Pins Claude Code's `opus`/`sonnet`/`haiku`/`fable` aliases to the strongest
 * model this gateway actually serves in each family.
 *
 * Claude Code's own release schedule moves those aliases to newer model names
 * independent of what a given gateway has rolled out. Left unpinned, Claude Code
 * sends whatever name the alias currently resolves to, which the gateway can
 * reject with "... is no longer available. Use Unity Catalog model services."
 * Pinning sends the gateway's own id instead, matching what the VS Code chat
 * picker already requests for the same model.
 */
export function claudeCodeModelPins(models: GatewayModel[]): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const model of sortModels(models)) {
    const family = FAMILY_ORDER.find((name) => model.id.toLowerCase().includes(name));
    const envVar = family ? CLAUDE_CODE_PIN_ENV_BY_FAMILY[family] : undefined;
    if (envVar && !(envVar in pins)) {
      pins[envVar] = model.id;
    }
  }
  return pins;
}

/** Strongest family first, then newest version first within a family. */
function compareModels(left: GatewayModel, right: GatewayModel): number {
  const leftFamily = familyRank(left.id);
  const rightFamily = familyRank(right.id);
  if (leftFamily !== rightFamily) {
    return leftFamily - rightFamily;
  }
  const versionDelta = versionKey(right.id) - versionKey(left.id);
  if (versionDelta !== 0) {
    return versionDelta;
  }
  return left.id.localeCompare(right.id);
}

function familyRank(id: string): number {
  const lower = id.toLowerCase();
  const index = FAMILY_ORDER.findIndex((family) => lower.includes(family));
  return index === -1 ? FAMILY_ORDER.length : index;
}

/**
 * `claude-opus-4-5` -> 4.5, so 5 sorts above 4.8 above 4.5.
 *
 * The `[1m]` suffix is stripped first: it ends in a digit, and this reads the
 * *last* number in the id, so leaving it on would rank Opus 5[1m] as version 1.
 */
function versionKey(id: string): number {
  const match = /(\d+)(?:-(\d+))?(?!.*\d)/.exec(id.replace(/\[1m\]$/i, ''));
  if (!match?.[1]) {
    return 0;
  }
  const major = Number(match[1]);
  const minor = match[2] ? Number(match[2]) : 0;
  return major * 1000 + minor;
}

function prettifyId(id: string): string {
  const fromClaude = /claude.*/i.exec(id)?.[0] ?? id;
  return fromClaude
    .split(/[._:/-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
