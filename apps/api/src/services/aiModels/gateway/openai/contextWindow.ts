/**
 * Fits `max_tokens` to an OpenAI-compatible endpoint's context window (#10577).
 *
 * These endpoints reject prompt + max_tokens over their window with a 400, and
 * the Agent SDK CLI asks for a large fixed max_tokens on every call. Nothing
 * stored says how large a BYO model's window is, so the gateway learns it from
 * the rejection itself: the endpoint states its window and usually its exact
 * prompt count. The request is retried once with a max_tokens that fits, and
 * the window is remembered so that later requests are capped up front.
 *
 * The memo is per process, per connection version and model, and expires, so an
 * endpoint restarted with a larger window recovers on its own. Only numbers are
 * taken from the endpoint's text, and they can only lower what is requested.
 */

/** The smallest answer worth asking for: reasoning models can spend less than this before any visible text. */
export const CONTEXT_MIN_OUTPUT_TOKENS = 1024;
export const CONTEXT_WINDOW_MEMO_TTL_MS = 60 * 60_000;
export const CONTEXT_WINDOW_MEMO_MAX_ENTRIES = 1_000;
/** Refusing with no provider call needs a window the endpoint stated this recently; past it the endpoint is asked again. */
export const CONTEXT_WINDOW_REFUSAL_FRESH_MS = 10 * 60_000;

const MIN_PLAUSIBLE_WINDOW = 1024;
const MAX_PLAUSIBLE_TOKENS = 100_000_000;
const MIN_SAFETY_MARGIN = 256;
const SAFETY_MARGIN_RATIO = 0.01;
/**
 * The estimate is bytes / 3, and its error depends on the mix of tool schemas
 * and prose. Below this multiple of the window it may still be wrong, so the
 * endpoint, whose count is exact, decides.
 */
const CLEARLY_OVER_WINDOW_FACTOR = 1.2;
const MIN_ESTIMATE_RATIO = 0.25;
const MAX_ESTIMATE_RATIO = 4;

const REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);
const WINDOW_PATTERNS = [
  /context[ _](?:length|size|window)\s+(?:is|of)\s+(?:only\s+)?([\d,]+)/i,
  /"n_ctx"\s*:\s*(\d+)/,
];
const PROMPT_PATTERNS = [
  /([\d,]+)\s+prompt tokens/i,
  /([\d,]+)\s+in the messages/i,
  /([\d,]+)\s+input tokens/i,
  /messages resulted in\s+([\d,]+)\s+tokens/i,
  /"n_prompt_tokens"\s*:\s*(\d+)/,
];
const TOTAL_PATTERN = /(?:requested|needs an?)\s+([\d,]+)(?:\s+tokens|-token)/i;

export interface ContextWindowKey { connectionId: string; configVersion: number; model: string }
export interface ReportedContextLimit { contextWindow: number; promptTokens: number | null }

export type RequestPlan =
  | { kind: 'send'; maxTokens: number }
  | { kind: 'too_large'; contextWindow: number; promptTokens: number };

export type RejectionPlan =
  | { kind: 'retry'; maxTokens: number }
  | { kind: 'too_large'; contextWindow: number; promptTokens: number }
  /** A cap would not change the request, so the endpoint's own reason stands. */
  | { kind: 'surface' };

interface MemoEntry { contextWindow: number; estimateRatio: number; at: number; capLogged: boolean }

const memo = new Map<string, MemoEntry>();
const unknownLogged = new Set<string>();

const keyOf = (k: ContextWindowKey): string => JSON.stringify([k.connectionId, k.configVersion, k.model]);

function readCount(pattern: RegExp, text: string): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

function firstCount(patterns: readonly RegExp[], text: string): number | null {
  for (const pattern of patterns) {
    const value = readCount(pattern, text);
    if (value !== null) return value;
  }
  return null;
}

/** The limit an endpoint's context-length rejection states, or null when this is any other failure. */
export function parseContextLimitRejection(status: number, text: string, sentMaxTokens: number): ReportedContextLimit | null {
  if (!REJECTION_STATUSES.has(status)) return null;
  const contextWindow = firstCount(WINDOW_PATTERNS, text);
  if (contextWindow === null || contextWindow < MIN_PLAUSIBLE_WINDOW || contextWindow > MAX_PLAUSIBLE_TOKENS) return null;
  const total = readCount(TOTAL_PATTERN, text);
  const promptTokens = firstCount(PROMPT_PATTERNS, text) ?? (total !== null ? total - sentMaxTokens : null);
  const plausible = promptTokens !== null && promptTokens > 0 && promptTokens <= MAX_PLAUSIBLE_TOKENS;
  return { contextWindow, promptTokens: plausible ? promptTokens : null };
}

export function contextSafetyMargin(contextWindow: number): number {
  return Math.max(MIN_SAFETY_MARGIN, Math.ceil(contextWindow * SAFETY_MARGIN_RATIO));
}

const roomFor = (contextWindow: number, promptTokens: number): number =>
  contextWindow - promptTokens - contextSafetyMargin(contextWindow);

/** What to do about one context-length rejection. Never raises what was sent. */
export function planAfterRejection(reported: ReportedContextLimit, sentMaxTokens: number, estimatedPromptTokens: number): RejectionPlan {
  const promptTokens = reported.promptTokens ?? estimatedPromptTokens;
  const room = roomFor(reported.contextWindow, promptTokens);
  if (room >= sentMaxTokens) return { kind: 'surface' };
  if (room < CONTEXT_MIN_OUTPUT_TOKENS) return { kind: 'too_large', contextWindow: reported.contextWindow, promptTokens };
  return { kind: 'retry', maxTokens: room };
}

/** Remember a rejection's window, and how the endpoint's prompt count compares with the gateway's estimate. */
export function rememberContextLimit(key: ContextWindowKey, reported: ReportedContextLimit, estimatedPromptTokens: number): void {
  const k = keyOf(key);
  const previous = memo.get(k);
  const estimateRatio = reported.promptTokens !== null && estimatedPromptTokens > 0
    ? Math.min(MAX_ESTIMATE_RATIO, Math.max(MIN_ESTIMATE_RATIO, reported.promptTokens / estimatedPromptTokens))
    : previous?.estimateRatio ?? 1;
  memo.delete(k); // re-insert so Map order stays oldest-first
  memo.set(k, { contextWindow: reported.contextWindow, estimateRatio, at: Date.now(), capLogged: false });
  while (memo.size > CONTEXT_WINDOW_MEMO_MAX_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }
}

function logUnknownOnce(key: ContextWindowKey, k: string, requestedMaxTokens: number): void {
  if (unknownLogged.has(k)) return;
  if (unknownLogged.size >= CONTEXT_WINDOW_MEMO_MAX_ENTRIES) unknownLogged.clear();
  unknownLogged.add(k);
  console.warn(`[modelGateway] no context window known yet for connection ${key.connectionId}, `
    + `model ${JSON.stringify(key.model)}; forwarding max_tokens ${requestedMaxTokens} unchanged.`);
}

/** The max_tokens to send first, from what is remembered for this connection and model. */
export function planRequest(key: ContextWindowKey, requestedMaxTokens: number, estimatedPromptTokens: number): RequestPlan {
  const k = keyOf(key);
  let entry = memo.get(k);
  if (entry && Date.now() - entry.at > CONTEXT_WINDOW_MEMO_TTL_MS) {
    memo.delete(k);
    entry = undefined;
  }
  if (!entry) {
    logUnknownOnce(key, k, requestedMaxTokens);
    return { kind: 'send', maxTokens: requestedMaxTokens };
  }
  const promptTokens = Math.round(estimatedPromptTokens * entry.estimateRatio);
  const confirmedRecently = Date.now() - entry.at <= CONTEXT_WINDOW_REFUSAL_FRESH_MS;
  if (confirmedRecently && promptTokens >= entry.contextWindow * CLEARLY_OVER_WINDOW_FACTOR) {
    return { kind: 'too_large', contextWindow: entry.contextWindow, promptTokens };
  }
  const room = Math.max(roomFor(entry.contextWindow, promptTokens), CONTEXT_MIN_OUTPUT_TOKENS);
  const maxTokens = Math.min(requestedMaxTokens, room);
  if (maxTokens < requestedMaxTokens && !entry.capLogged) {
    entry.capLogged = true;
    console.warn(`[modelGateway] capping max_tokens ${requestedMaxTokens} to ${maxTokens} for connection ${key.connectionId}, `
      + `model ${JSON.stringify(key.model)} (context_window ${entry.contextWindow}, prompt_tokens_est ${promptTokens}).`);
  }
  return { kind: 'send', maxTokens };
}

/** Client-safe: built only from the two counts. */
export function contextWindowExceededMessage(contextWindow: number, promptTokens: number): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  return `This request is about ${n(promptTokens)} tokens, which does not fit this model's ${n(contextWindow)}-token context window. `
    + 'Start a new chat, or choose a model with a larger context window.';
}

export function __resetContextWindowsForTests(): void {
  memo.clear();
  unknownLogged.clear();
}
