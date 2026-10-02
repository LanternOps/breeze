/**
 * Provider output → per-model token components + outcome. Deliberately has NO
 * cost in its output: the only billing number is priceInvocation() over these
 * components (settleInvocation.ts). `sdkReportedCostUsd` is telemetry and the
 * ONLY reader of `total_cost_usd` in the codebase (contract-tested, Task 17).
 *
 * Agent SDK facts this relies on (W05 spike, 2026-10-01, SDK 0.3.286):
 * - `result.modelUsage` is keyed by the REQUESTED model id and is CUMULATIVE
 *   across the turns of one streaming query AND across `resume` (the resumed
 *   query starts from the totals its transcript saved). So it is billed as a
 *   per-key delta against the last snapshot persisted for the breeze session.
 * - `result.usage` is main-loop only and was verified per-turn only for the
 *   first result of a freshly created/resumed query. It is used only when
 *   there is no snapshot, capped by modelUsage.
 * - `total_cost_usd` / `costUSD` are cumulative estimates: telemetry only.
 * - The CLI can switch the session model on its own (refusal fallback, even
 *   with no `fallbackModel` configured) and silently retries fast mode as
 *   standard on a 429. Requested ≠ served; SDK usage is billed fast only when
 *   the result reports `fast_mode_state: 'on'` and no frame of the turn
 *   reported cooldown/off (W05; carried only after lab gate L1).
 * - Interrupted turns under-count and aborted turns emit no result. Both are
 *   billed short (never double): an aborted turn leaves the snapshot alone so
 *   the next turn's delta picks up whatever the CLI persisted.
 */
import { z } from 'zod';
import { classifySdkAssistantError, type ProviderFailureCause } from './failover';
import type { TokenComponents } from './pricing';
import type { TurnBinding } from './turnBinding';

export type SpeedServed = 'standard' | 'fast';

export interface BilledUsage {
  /** The model the tokens are billed under: the requested id the binding's rates are keyed by. */
  model: string;
  tokens: TokenComponents;
  webSearchRequests: number;
  /**
   * 'fast' only when the provider confirmed it: the Messages API's `usage.speed`,
   * or on the Agent SDK the result's `fast_mode_state: 'on'` with no cooldown/off
   * seen during the turn, and only on the bound wire model (W05).
   */
  speedServed: SpeedServed;
  /** The model id the provider reported serving, when it reports one (Messages API). Null for the SDK. */
  providerModel: string | null;
  /**
   * Set only when ONE settlement spans several separate Messages API calls
   * (a retry loop): the 0-based call this row belongs to, and that call's own
   * outcome. Refusal / fallback labels are a property of a single call's
   * attempts, so the ledger labels the row from `callOutcome`, never from the
   * merged turn outcome. Plain data: it survives the pending-settlement JSON.
   */
  call?: number;
  callOutcome?: TurnOutcome;
}

export interface TurnOutcome {
  stopReason: string;              // 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'error' | provider value
  refused: boolean;                // the FINAL answer is a refusal (after any fallback)
  refusalCategory: string | null;
  fallbackUsed: boolean;           // the main loop ended on a model other than binding.wireModel
  servedModel: string;             // main-loop model at turn end (a requested id, comparable to the binding)
  providerModel: string | null;    // the provider-reported id of the final response (Messages API only)
  sdkReportedCostUsd: number | null;   // telemetry only; cumulative as the SDK reports it
  fastDowngraded: boolean;         // fast was requested but not (confirmed) served (W05)
}

// ---------------------------------------------------------------------------
// Agent SDK
// ---------------------------------------------------------------------------

export interface SdkTurnObservation {
  /** fallbackModel is null when the CLI swapped without naming the model (it then shows up as a new modelUsage key). */
  refusalFallback: { fallbackModel: string | null; category: string | null } | null;
  refusalNoFallback: { category: string | null } | null;
  /** W05: some frame of the turn reported fast mode not serving (cooldown / off). */
  fastNotOnSeen: boolean;
  /** W09 (#7607): the last failover-eligible provider failure the CLI reported this turn. */
  providerFailure: { cause: ProviderFailureCause; status: number | null; retries: number } | null;
  /** W09: assistant content (text / thinking / tool_use) was produced this turn: never fail over after it. */
  sawOutput: boolean;
}

export function newSdkTurnObservation(): SdkTurnObservation {
  return { refusalFallback: null, refusalNoFallback: null, fastNotOnSeen: false, providerFailure: null, sawOutput: false };
}

const OUTPUT_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);

/** Feed EVERY SDK message of the turn through this. */
export function observeSdkMessage(obs: SdkTurnObservation, message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const m = message as {
    type?: unknown; subtype?: unknown; scope?: unknown; fallback_model?: unknown; api_refusal_category?: unknown;
    error?: unknown; error_status?: unknown; attempt?: unknown; api_error_status?: unknown;
    message?: { content?: unknown }; event?: { type?: unknown };
  };
  // W05: any frame that reports fast mode not serving (rate-limit cooldown,
  // or off) during the turn means at least part of it ran at standard.
  const fastState = (message as { fast_mode_state?: unknown }).fast_mode_state;
  if (fastState === 'cooldown' || fastState === 'off') obs.fastNotOnSeen = true;

  // W09: a classified provider status failure (D8). An error the classifier
  // does not recognise (a timeout or reset after send, an invalid request, an
  // unknown model, …) CLEARS any earlier cause: the latest failure decides,
  // and a turn must never fail over on a stale 529 after an unknown outcome.
  const recordFailure = (error: unknown, status: unknown, attempt: unknown) => {
    const httpStatus = typeof status === 'number' ? status : null;
    const cause = classifySdkAssistantError(typeof error === 'string' ? error : null, httpStatus);
    if (!cause) { obs.providerFailure = null; return; }
    const retries = typeof attempt === 'number' ? attempt : (obs.providerFailure?.retries ?? 0);
    obs.providerFailure = { cause, status: httpStatus, retries };
  };
  if (m.type === 'assistant') {
    // A synthetic API-error assistant message carries `error`: a failure, not
    // output. Anything else with a content block is output.
    if (typeof m.error === 'string') { recordFailure(m.error, null, undefined); return; }
    const content = Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type?: unknown }>) : [];
    if (content.some((b) => typeof b?.type === 'string' && OUTPUT_BLOCKS.has(b.type))) obs.sawOutput = true;
    return;
  }
  if (m.type === 'stream_event') {
    if (m.event?.type === 'content_block_start') obs.sawOutput = true;
    return;
  }
  if (m.type === 'result') {
    if (typeof m.api_error_status === 'number') recordFailure(null, m.api_error_status, undefined);
    return;
  }
  if (m.type !== 'system') return;
  if (m.subtype === 'api_retry') { recordFailure(m.error, m.error_status, m.attempt); return; }
  const category = typeof m.api_refusal_category === 'string' ? m.api_refusal_category : null;
  if (m.subtype === 'model_refusal_fallback') {
    // 'local' = a subagent / side question fell back; the main loop did not.
    // Absent scope (older CLI) means 'session'.
    if (m.scope === 'local') return;
    const fallbackModel = typeof m.fallback_model === 'string' && m.fallback_model.length > 0 ? m.fallback_model : null;
    obs.refusalFallback = { fallbackModel, category };
  } else if (m.subtype === 'model_refusal_no_fallback') {
    obs.refusalNoFallback = { category };
  }
}

/** One `ModelUsage` entry of the SDK result (only the fields billing reads). */
export interface SdkModelUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;   // never read
}

/** Structural subset of `SDKResultMessage`; the real type is assignable to it. */
export interface SdkResultLike {
  subtype: string;
  is_error?: boolean;
  stop_reason?: string | null;
  total_cost_usd?: number | null;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    server_tool_use?: { web_search_requests?: number | null } | null;
  } | null;
  modelUsage?: Record<string, SdkModelUsageLike> | null;
  startup_failure_reason?: unknown;
  /** W05: the served-speed signal (sdk.d.ts, verified on VERIFIED_AGENT_SDK_VERSION). */
  fast_mode_state?: 'off' | 'cooldown' | 'on' | null;
}

/**
 * The last cumulative `modelUsage` seen for a breeze session (persisted as
 * jsonb by settlement, carried across `resume`). Holds counts only, no cost.
 */
export type SdkUsageSnapshot = {
  version: 1;
  models: Record<string, { tokens: TokenComponents; webSearchRequests: number }>;
};

const count = z.number().finite().nonnegative();
const sdkUsageSnapshotSchema = z.object({
  version: z.literal(1),
  models: z.record(z.string().min(1), z.object({
    tokens: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count }).strict(),
    webSearchRequests: count,
  }).strict()),
}).strict();

/** Strict: anything malformed is null (treated as "no snapshot", which never over-bills). */
export function parseSdkUsageSnapshot(raw: unknown): SdkUsageSnapshot | null {
  const parsed = sdkUsageSnapshotSchema.safeParse(raw);
  return parsed.success ? (parsed.data as SdkUsageSnapshot) : null;
}

export type SdkUsageNote =
  | 'delta'               // snapshot present, nothing decreased: per-key deltas billed
  | 'first_result'        // no snapshot: result.usage billed, capped by modelUsage
  | 'snapshot_regressed'  // a component decreased (counters restarted): snapshot re-baselined to the current reading, this turn's result.usage billed capped by modelUsage, unconfirmed (Sentry: ai_usage_snapshot_regressed)
  | 'no_result'           // aborted / untrustworthy result: billed ZERO, snapshot unchanged
  | 'empty_usage';        // the turn made no model call: nothing billed, snapshot unchanged

export interface SdkTurnUsageResult {
  usage: BilledUsage[];
  outcome: TurnOutcome;
  /** Persist this for the breeze session (null = leave/keep no snapshot). */
  nextSnapshot: SdkUsageSnapshot | null;
  /** False when the billed numbers are known or suspected to be short (settle as usage_unconfirmed). */
  usageConfirmed: boolean;
  usageNote: SdkUsageNote;
}

type Entry = { tokens: TokenComponents; webSearchRequests: number };
const ZERO: Entry = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 };
const COMPONENTS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function readCount(v: unknown): number | 'invalid' {
  if (v === undefined || v === null) return 0;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 'invalid';
}

/** modelUsage → snapshot; 'invalid' if any entry is malformed; null when absent. */
function readModelUsage(modelUsage: unknown): SdkUsageSnapshot | 'invalid' | null {
  if (modelUsage === undefined || modelUsage === null) return null;
  if (typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return 'invalid';
  const models: SdkUsageSnapshot['models'] = Object.create(null) as SdkUsageSnapshot['models'];
  for (const [key, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!key || !raw || typeof raw !== 'object') return 'invalid';
    const e = raw as SdkModelUsageLike;
    const vals = [e.inputTokens, e.outputTokens, e.cacheReadInputTokens, e.cacheCreationInputTokens, e.webSearchRequests]
      .map(readCount);
    if (vals.some((v) => v === 'invalid')) return 'invalid';
    const [input, output, cacheRead, cacheWrite, webSearchRequests] = vals as number[];
    models[key] = { tokens: { input: input!, output: output!, cacheRead: cacheRead!, cacheWrite: cacheWrite! }, webSearchRequests: webSearchRequests! };
  }
  return { version: 1, models: { ...models } };
}

/**
 * Component-wise high-water mark of two snapshots (union of keys). How
 * settlement stores an ordinary (non-regressed) snapshot: monotone, so replay
 * order cannot regress it. A `snapshot_regressed` turn's re-baselined snapshot
 * is the one exception and is stored as-is (aiBudgetReservations).
 */
export function sdkUsageHighWater(a: SdkUsageSnapshot, b: SdkUsageSnapshot): SdkUsageSnapshot {
  return highWater(a, b);
}

function highWater(a: SdkUsageSnapshot, b: SdkUsageSnapshot): SdkUsageSnapshot {
  const keys = new Set([...Object.keys(a.models), ...Object.keys(b.models)]);
  const entries: Array<[string, Entry]> = [];
  for (const k of keys) {
    const x = Object.hasOwn(a.models, k) ? a.models[k]! : ZERO;
    const y = Object.hasOwn(b.models, k) ? b.models[k]! : ZERO;
    entries.push([k, {
      tokens: {
        input: Math.max(x.tokens.input, y.tokens.input),
        output: Math.max(x.tokens.output, y.tokens.output),
        cacheRead: Math.max(x.tokens.cacheRead, y.tokens.cacheRead),
        cacheWrite: Math.max(x.tokens.cacheWrite, y.tokens.cacheWrite),
      },
      webSearchRequests: Math.max(x.webSearchRequests, y.webSearchRequests),
    }]);
  }
  return { version: 1, models: Object.fromEntries(entries) };
}

function isZero(e: Entry): boolean {
  return e.webSearchRequests === 0 && COMPONENTS.every((c) => e.tokens[c] === 0);
}

function minus(cur: Entry, prev: Entry): Entry | 'decreased' {
  const tokens = { ...ZERO.tokens };
  for (const c of COMPONENTS) {
    if (cur.tokens[c] < prev.tokens[c]) return 'decreased';
    tokens[c] = cur.tokens[c] - prev.tokens[c];
  }
  if (cur.webSearchRequests < prev.webSearchRequests) return 'decreased';
  return { tokens, webSearchRequests: cur.webSearchRequests - prev.webSearchRequests };
}

/**
 * The main-loop model at turn end, from what was observed, never assumed:
 * the refusal-fallback message's model, else a key that appeared this turn
 * (the CLI's own refusal swap), else the only key that grew, else the bound
 * wire model if it grew, else the key that produced the most output.
 */
function servedModelOf(
  binding: TurnBinding,
  obs: SdkTurnObservation,
  grown: ReadonlyArray<[string, Entry]>,
  newKeys: ReadonlySet<string> | null,
): string {
  if (obs.refusalFallback?.fallbackModel) return obs.refusalFallback.fallbackModel;
  if (newKeys) {
    const appeared = grown.filter(([k]) => newKeys.has(k) && k !== binding.wireModel);
    if (appeared.length === 1) return appeared[0]![0];
  }
  // #7766: the CLI swapped to a refusal fallback this turn but named no model,
  // and there is no snapshot to say which key is new (a query's first turn).
  // The bound model is the one that REFUSED, so it is never "what served":
  // prefer the bound refusal fallback's key, else the one grown key that is
  // neither the bound model nor a model this session switched away from.
  if (obs.refusalFallback) {
    if (binding.refusalFallback && grown.some(([k]) => k === binding.refusalFallback!.wireModel)) {
      return binding.refusalFallback.wireModel;
    }
    const carried = new Set((binding.carriedRates ?? []).map((c) => c.wireModel));
    const others = grown.filter(([k]) => k !== binding.wireModel && !carried.has(k));
    if (others.length === 1) return others[0]![0];
  }
  if (grown.length === 1) return grown[0]![0];
  if (grown.some(([k]) => k === binding.wireModel)) return binding.wireModel;
  if (obs.refusalFallback && binding.refusalFallback && grown.some(([k]) => k === binding.refusalFallback!.wireModel)) {
    return binding.refusalFallback.wireModel;
  }
  let best: [string, Entry] | null = null;
  for (const g of grown) if (!best || g[1].tokens.output > best[1].tokens.output) best = g;
  return best ? best[0] : binding.wireModel;
}

function sdkOutcome(binding: TurnBinding, obs: SdkTurnObservation, result: SdkResultLike | null, servedModel: string): TurnOutcome {
  const sdkStop = result?.stop_reason ?? null;
  const refused = obs.refusalNoFallback !== null || sdkStop === 'refusal';
  const errored = !result || result.subtype !== 'success' || result.is_error === true;
  const stopReason = refused ? 'refusal' : errored ? 'error' : sdkStop ?? 'end_turn';
  const category = obs.refusalNoFallback?.category ?? obs.refusalFallback?.category ?? null;
  const fallbackUsed = obs.refusalFallback !== null || servedModel !== binding.wireModel;
  const cost = result?.total_cost_usd;
  return {
    stopReason,
    refused,
    refusalCategory: refused || obs.refusalFallback !== null ? category : null,
    fallbackUsed,
    servedModel,
    providerModel: null,
    sdkReportedCostUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
    fastDowngraded: sdkFastRequested(binding) && !sdkFastServed(binding, obs, result, servedModel),
  };
}

function sdkFastRequested(b: TurnBinding): boolean {
  return b.options.speed === 'fast';
}

/**
 * Fast was served for the WHOLE turn: requested, reported 'on' at the end,
 * never cooldown/off during it, and the main loop ended on the bound model
 * (a fallback model never runs fast — Codex review finding 15).
 */
function sdkFastServed(b: TurnBinding, obs: SdkTurnObservation, result: SdkResultLike | null, servedModel: string): boolean {
  return sdkFastRequested(b) && servedModel === b.wireModel && result?.fast_mode_state === 'on' && !obs.fastNotOnSeen;
}

/** Only the bound wire model can run fast; a fallback / helper model never bills the fast rate. */
function withServedSpeed(rows: BilledUsage[], b: TurnBinding, fastServed: boolean): BilledUsage[] {
  return fastServed ? rows.map((r) => (r.model === b.wireModel ? { ...r, speedServed: 'fast' as const } : r)) : rows;
}

function billed(model: string, e: Entry): BilledUsage {
  return { model, tokens: e.tokens, webSearchRequests: e.webSearchRequests, speedServed: 'standard', providerModel: null };
}

export function sdkTurnUsage(input: {
  binding: TurnBinding;
  observation: SdkTurnObservation;
  /** null = the turn ended with no result message (aborted / abandoned). */
  result: SdkResultLike | null;
  /** The session's last persisted snapshot (parseSdkUsageSnapshot), or null. */
  previousSnapshot: SdkUsageSnapshot | null;
}): SdkTurnUsageResult {
  const { binding, observation: obs, result, previousSnapshot: prev } = input;
  const errored = !result || result.subtype !== 'success' || result.is_error === true;

  const untrusted = (): SdkTurnUsageResult => ({
    usage: [],
    outcome: sdkOutcome(binding, obs, result, obs.refusalFallback?.fallbackModel ?? binding.wireModel),
    nextSnapshot: prev,
    usageConfirmed: false,
    usageNote: 'no_result',
  });

  if (!result || result.startup_failure_reason !== undefined) return untrusted();
  const current = readModelUsage(result.modelUsage);
  if (current === null || current === 'invalid') return untrusted();

  const entries = Object.entries(current.models);
  if (entries.every(([, e]) => isZero(e))) {
    // No model call recorded. An error result here is the SDK's zeroed crash
    // result; a success is a turn that never reached the model. Either way
    // nothing to bill and the snapshot must not be reset to zero.
    if (errored) return untrusted();
    return {
      usage: [],
      outcome: sdkOutcome(binding, obs, result, obs.refusalFallback?.fallbackModel ?? binding.wireModel),
      nextSnapshot: prev,
      usageConfirmed: true,
      usageNote: 'empty_usage',
    };
  }

  if (prev) {
    const deltas: Array<[string, Entry]> = [];
    // A key absent from this result is not a regression on its own: it bills
    // no delta and keeps its last total in the snapshot (so it can never be
    // re-billed if it reappears).
    let regressed = false;
    for (const [key, cur] of entries) {
      if (regressed) break;
      const d = minus(cur, Object.hasOwn(prev.models, key) ? prev.models[key]! : ZERO);
      if (d === 'decreased') regressed = true;
      else if (!isZero(d)) deltas.push([key, d]);
    }
    if (regressed) {
      // Review finding 3 (#7700): a decrease means the CLI's counters restarted
      // (a redeploy without ~/.claude, a resumed transcript…). Keeping the old
      // high-water mark would bill every later turn $0 until the new counters
      // overtook it. Re-baseline to what the CLI reports NOW — a key it no
      // longer reports keeps its last total — and bill this turn's own
      // result.usage the way a first result is billed (capped by modelUsage).
      // Unconfirmed: the reading may also be a glitch (Sentry: ai_usage_snapshot_regressed).
      const rebaselined: SdkUsageSnapshot = { version: 1, models: { ...prev.models, ...current.models } };
      const turn = thisTurnUsage(binding, obs, result, entries);
      return {
        usage: withServedSpeed(turn.usage, binding, sdkFastServed(binding, obs, result, turn.servedModel)),
        outcome: sdkOutcome(binding, obs, result, turn.servedModel),
        nextSnapshot: rebaselined,
        usageConfirmed: false,
        usageNote: 'snapshot_regressed',
      };
    }
    const newKeys = new Set(entries.map(([k]) => k).filter((k) => !Object.hasOwn(prev.models, k)));
    const servedModel = servedModelOf(binding, obs, deltas, newKeys);
    const fastServed = sdkFastServed(binding, obs, result, servedModel);
    return {
      usage: withServedSpeed(deltas.map(([k, d]) => billed(k, d)), binding, fastServed),
      outcome: sdkOutcome(binding, obs, result, servedModel),
      nextSnapshot: highWater(prev, current),
      usageConfirmed: !errored,
      usageNote: 'delta',
    };
  }

  // No snapshot: the first result of a query (or a session from before
  // snapshots). modelUsage may carry earlier turns from the transcript, so it
  // is only a ceiling; result.usage is this turn's main loop.
  const turn = thisTurnUsage(binding, obs, result, entries);
  const fastServed = sdkFastServed(binding, obs, result, turn.servedModel);
  return {
    usage: withServedSpeed(turn.usage, binding, fastServed),
    outcome: sdkOutcome(binding, obs, result, turn.servedModel),
    nextSnapshot: current,
    usageConfirmed: turn.turnValid && !errored && turn.nonZeroKeys <= 1,
    usageNote: 'first_result',
  };
}

/**
 * This turn's main-loop usage from result.usage, capped componentwise by the
 * summed modelUsage, attributed to the served model. The billing rule when no
 * trustworthy previous snapshot exists (first result, or a regressed one).
 */
function thisTurnUsage(
  binding: TurnBinding,
  obs: SdkTurnObservation,
  result: SdkResultLike,
  entries: ReadonlyArray<[string, Entry]>,
): { usage: BilledUsage[]; servedModel: string; turnValid: boolean; nonZeroKeys: number } {
  const nonZero = entries.filter(([, e]) => !isZero(e));
  const servedModel = servedModelOf(binding, obs, nonZero, null);
  const sum = entries.reduce<Entry>((acc, [, e]) => ({
    tokens: {
      input: acc.tokens.input + e.tokens.input,
      output: acc.tokens.output + e.tokens.output,
      cacheRead: acc.tokens.cacheRead + e.tokens.cacheRead,
      cacheWrite: acc.tokens.cacheWrite + e.tokens.cacheWrite,
    },
    webSearchRequests: acc.webSearchRequests + e.webSearchRequests,
  }), ZERO);
  const u = result.usage;
  const turnRaw = u
    ? [u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.server_tool_use?.web_search_requests]
      .map(readCount)
    : null;
  const turnValid = turnRaw !== null && turnRaw.every((v) => v !== 'invalid');
  let usage: BilledUsage[] = [];
  if (turnValid && obs.refusalFallback && nonZero.length > 1) {
    // #7766: a refusal swap on a query's first turn. When the per-key
    // modelUsage adds up EXACTLY to this turn's usage, it carries nothing from
    // earlier turns, so each model is billed on its own row at its own rate
    // (the refused attempt under the bound model, the answer under the
    // fallback). Otherwise the per-key split is only a ceiling and the capped
    // turn usage goes to the served model below.
    const [input, output, cacheRead, cacheWrite, web] = turnRaw as number[];
    const exact = input === sum.tokens.input && output === sum.tokens.output && cacheRead === sum.tokens.cacheRead
      && cacheWrite === sum.tokens.cacheWrite && web === sum.webSearchRequests;
    if (exact) return { usage: nonZero.map(([k, e]) => billed(k, e)), servedModel, turnValid, nonZeroKeys: nonZero.length };
  }
  if (turnValid) {
    const [input, output, cacheRead, cacheWrite, web] = turnRaw as number[];
    const capped: Entry = {
      tokens: {
        input: Math.min(input!, sum.tokens.input),
        output: Math.min(output!, sum.tokens.output),
        cacheRead: Math.min(cacheRead!, sum.tokens.cacheRead),
        cacheWrite: Math.min(cacheWrite!, sum.tokens.cacheWrite),
      },
      webSearchRequests: Math.min(web!, sum.webSearchRequests),
    };
    if (!isZero(capped)) usage = [billed(servedModel, capped)];
  }
  return { usage, servedModel, turnValid, nonZeroKeys: nonZero.length };
}

// ---------------------------------------------------------------------------
// Messages API
// ---------------------------------------------------------------------------

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Structural subset of `Message` / `BetaMessage`; the real types are assignable to it. */
export interface MessageLike {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: ReadonlyArray<{
    type: string;
    to?: { model?: string } | null;
    from?: { model?: string } | null;
    trigger?: { category?: string | null } | null;
  }>;
  usage: UsageLike & {
    server_tool_use?: { web_search_requests?: number | null } | null;
    iterations?: ReadonlyArray<UsageLike & { type?: string; model?: string | null }> | null;
    /** The served speed. Only an explicit 'fast' bills fast rates. */
    speed?: 'standard' | 'fast' | null;
  };
}

function tokensOf(u: UsageLike): TokenComponents {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

function addTokens(a: TokenComponents, b: TokenComponents): TokenComponents {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/**
 * ONE createMessage call's attempts (client-side fallback = several attempts). Without
 * `usage.iterations` an attempt is billed under the model it REQUESTED (the
 * id the binding's rates are keyed by) and the response's `model` is kept as
 * `providerModel`, so a mismatch is recorded rather than silently priced.
 */
function singleCallUsage(
  binding: TurnBinding,
  attempts: ReadonlyArray<MessageAttemptLike>,
): { usage: BilledUsage[]; outcome: TurnOutcome } {
  const usage: BilledUsage[] = [];
  for (const attempt of attempts) {
    const u = attempt.message.usage;
    const webSearches = u.server_tool_use?.web_search_requests ?? 0;
    const speedServed: SpeedServed = u.speed === 'fast' ? 'fast' : 'standard';
    const providerModel = typeof attempt.message.model === 'string' && attempt.message.model ? attempt.message.model : null;
    const iterations = (u.iterations ?? []).filter((i) => typeof i.input_tokens === 'number');
    if (iterations.length === 0) {
      usage.push({ model: attempt.wireModel, tokens: tokensOf(u), webSearchRequests: webSearches, speedServed, providerModel });
      continue;
    }
    // Iterations are the per-model split (compaction entries, which carry no
    // model, are billed at the attempt's model); pricing them and NOT the top
    // level avoids double counting.
    const byModel = new Map<string, TokenComponents>();
    for (const it of iterations) {
      const model = it.model ?? attempt.wireModel;
      byModel.set(model, addTokens(byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokensOf(it)));
    }
    let first = true;
    for (const [model, tokens] of byModel) {
      usage.push({ model, tokens, webSearchRequests: first ? webSearches : 0, speedServed, providerModel: model });
      first = false;
    }
  }

  const last = attempts[attempts.length - 1]!;
  const fallbackBlock = last.message.content.find((b) => b.type === 'fallback');
  const clientSide = attempts.length > 1;
  const fallbackUsed = clientSide || fallbackBlock !== undefined;
  const refused = last.message.stop_reason === 'refusal';
  const fallbackCategory = clientSide
    ? attempts[0]!.message.stop_details?.category ?? null
    : fallbackBlock?.trigger?.category ?? null;
  const servedModel = clientSide
    ? last.wireModel
    : fallbackBlock?.to?.model ?? last.wireModel;
  return {
    usage,
    outcome: {
      stopReason: last.message.stop_reason ?? 'end_turn',
      refused,
      refusalCategory: refused ? last.message.stop_details?.category ?? fallbackCategory : fallbackUsed ? fallbackCategory : null,
      fallbackUsed,
      servedModel,
      providerModel: typeof last.message.model === 'string' && last.message.model ? last.message.model : null,
      sdkReportedCostUsd: null,
      // W05: requested fast, but no attempt of this call was confirmed fast by the provider.
      fastDowngraded: binding.options.speed === 'fast' && !attempts.some((a) => a.message.usage?.speed === 'fast'),
    },
  };
}

export interface MessageAttemptLike {
  wireModel: string;
  message: MessageLike;
  /** Which createMessage call produced this attempt (retry loops); undefined = the only call. */
  call?: number;
}

/**
 * Usage + outcome for Messages API attempts. `attempts` may span several
 * separate createMessage calls (a JSON-parse retry): attempts with the same
 * `call` index (undefined = call 0) are ONE call, and fallback / refusal
 * semantics apply only within a call. A single call is returned exactly as
 * interpreted on its own; several calls are billed as ordinary separate
 * usage rows, each labelled from its own call, and the turn outcome is the
 * LAST call's (the answer delivered), with fallbackUsed true if any call fell back.
 */
export function messagesUsage(
  binding: TurnBinding,
  attempts: ReadonlyArray<MessageAttemptLike>,
): { usage: BilledUsage[]; outcome: TurnOutcome } {
  return callsUsage(binding, attempts, false);
}

function callsUsage(
  binding: TurnBinding,
  attempts: ReadonlyArray<MessageAttemptLike>,
  errored: boolean,
): { usage: BilledUsage[]; outcome: TurnOutcome } {
  if (attempts.length === 0) throw new Error('messagesUsage needs at least one attempt');
  const groups = new Map<number, MessageAttemptLike[]>();
  for (const a of attempts) {
    const k = a.call ?? 0;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const ordered = [...groups.entries()].sort((x, y) => x[0] - y[0]);
  const withError = (o: TurnOutcome, last: boolean): TurnOutcome => (errored && last ? { ...o, stopReason: 'error' } : o);
  if (ordered.length === 1) {
    const one = singleCallUsage(binding, ordered[0]![1]);
    return { usage: one.usage, outcome: withError(one.outcome, true) };
  }
  const usage: BilledUsage[] = [];
  let outcome!: TurnOutcome;
  let anyFallback = false;
  let anyFastDowngraded = false;
  ordered.forEach(([call, group], i) => {
    const one = singleCallUsage(binding, group);
    const callOutcome = withError(one.outcome, i === ordered.length - 1);
    anyFallback ||= callOutcome.fallbackUsed;
    anyFastDowngraded ||= callOutcome.fastDowngraded;
    usage.push(...one.usage.map((u) => ({ ...u, call, callOutcome })));
    outcome = callOutcome;
  });
  return { usage, outcome: { ...outcome, fallbackUsed: anyFallback, fastDowngraded: anyFastDowngraded } };
}

/**
 * Usage for a Messages API dispatch that FAILED after some provider calls
 * completed (createMessage's MessageDispatchError, or a caller's own retry
 * loop dying part-way): the completed attempts bill at their real counts (the
 * provider charged for them) and the turn's outcome is an error, not the last
 * completed answer.
 */
export function messagesUsageAfterDispatchError(
  binding: TurnBinding,
  attempts: ReadonlyArray<MessageAttemptLike>,
): { usage: BilledUsage[]; outcome: TurnOutcome } {
  return callsUsage(binding, attempts, true);
}
