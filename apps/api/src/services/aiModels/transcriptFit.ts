/**
 * Spike constraint 1 (W05, docs/superpowers/specs/ai-mcp/2026-10-01-ai-model-registry-w05-resume-spike-findings.md Q3):
 * before resuming a session on another model, count the persisted
 * transcript with the TARGET model's tokenizer, through the target's own
 * connection. A transcript over the target's window makes the CLI
 * auto-compact lossily — it dropped the user's prompt and still reported
 * `success` — so anything that is not a positive count under the limit is
 * treated as "does not fit" by the caller (continuation, never resume).
 */
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { anthropicClientFor } from './connectionFactory';
import type { ResolvedModel } from './resolveModel';

export const TRANSCRIPT_FIT_MIN_HEADROOM_TOKENS = 32_000;
export const TRANSCRIPT_FIT_HEADROOM_RATIO = 0.1;
/** The CLI's per-request output ceiling the fit must leave room for (spike: 32 000 on Haiku 4.5). */
export const TRANSCRIPT_FIT_OUTPUT_ALLOWANCE_CAP = 32_000;
/** Connection kinds whose endpoint can count tokens for the target model. W06/W07 add theirs. */
/**
 * The token count runs on the request path before anything is reserved: a
 * slow or failing count endpoint must not stall the message (the SDK default
 * is 10 minutes with 2 retries). A failure reads as unverifiable → continue.
 */
export const TRANSCRIPT_FIT_COUNT_TIMEOUT_MS = 10_000;
export const COUNTABLE_KINDS: ReadonlySet<string> = new Set(['platform', 'anthropic_byok', 'catalog']);

export type TranscriptFit =
  | { kind: 'fits'; countedTokens: number; limitTokens: number }
  | { kind: 'too_large'; countedTokens: number; limitTokens: number }
  | { kind: 'unverifiable'; reason: 'no_window' | 'no_transcript' | 'count_failed' | 'connection_kind' };

type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; source: unknown };
export interface CountMessage { role: 'user' | 'assistant'; content: Array<TextBlock | ImageBlock> }
type Entry = { type: string; message?: unknown; subtype?: unknown };

export interface TranscriptFitDeps {
  readTranscript(sdkSessionId: string): Promise<ReadonlyArray<Entry>>;
  countTokens(target: ResolvedModel, body: { system: string; messages: CountMessage[] }, orgId: string): Promise<number>;
}

export const defaultTranscriptFitDeps: TranscriptFitDeps = {
  readTranscript: (id) => getSessionMessages(id, { includeSystemMessages: true }) as Promise<ReadonlyArray<Entry>>,
  countTokens: async (target, body, orgId) => {
    const client = anthropicClientFor(target, { surface: 'one_shot_token_count', orgId });
    const counted = await client.messages.countTokens({
      model: target.wireModel,
      system: body.system,
      messages: body.messages as never,
    }, { timeout: TRANSCRIPT_FIT_COUNT_TIMEOUT_MS, maxRetries: 0 });
    return counted.input_tokens;
  },
};

export function fitLimit(maxInputTokens: number, maxOutputTokens: number | null): number {
  const headroom = Math.max(TRANSCRIPT_FIT_MIN_HEADROOM_TOKENS, Math.ceil(maxInputTokens * TRANSCRIPT_FIT_HEADROOM_RATIO));
  const output = Math.min(maxOutputTokens ?? TRANSCRIPT_FIT_OUTPUT_ALLOWANCE_CAP, TRANSCRIPT_FIT_OUTPUT_ALLOWANCE_CAP);
  return Math.max(0, maxInputTokens - headroom - output);
}

function subtypeOf(e: Entry): string | undefined {
  if (typeof e.subtype === 'string') return e.subtype;
  const inner = (e.message as { subtype?: unknown } | undefined)?.subtype;
  return typeof inner === 'string' ? inner : undefined;
}

const text = (t: string): TextBlock => ({ type: 'text', text: t });

function sameModel(served: unknown, target: string): boolean {
  // The transcript records the SERVED id (`claude-haiku-4-5-20251001`) while
  // the binding uses the requested one (spike Q5).
  return typeof served === 'string' && (served === target || served.startsWith(`${target}-`));
}

function flattenToolResult(content: unknown): Array<TextBlock | ImageBlock> {
  if (typeof content === 'string') return content ? [text(`[tool_result] ${content}`)] : [];
  if (!Array.isArray(content)) return [];
  const out: Array<TextBlock | ImageBlock> = [];
  for (const b of content as Array<{ type?: string; text?: string; source?: unknown }>) {
    if (b?.type === 'image' && b.source) out.push({ type: 'image', source: b.source });
    else if (b?.type === 'text' && b.text) out.push(text(`[tool_result] ${b.text}`));
  }
  return out;
}

function flatten(role: 'user' | 'assistant', content: unknown, keepThinking: boolean): Array<TextBlock | ImageBlock> {
  if (typeof content === 'string') return content ? [text(content)] : [];
  if (!Array.isArray(content)) return [];
  const out: Array<TextBlock | ImageBlock> = [];
  for (const raw of content as Array<Record<string, unknown>>) {
    switch (raw?.type) {
      case 'text':
        if (typeof raw.text === 'string' && raw.text) out.push(text(raw.text));
        break;
      case 'thinking':
        if (keepThinking && typeof raw.thinking === 'string' && raw.thinking) out.push(text(raw.thinking));
        break;
      case 'redacted_thinking':
        break;
      case 'tool_use':
        out.push(text(`[tool_use ${String(raw.name)}] ${JSON.stringify(raw.input ?? {})}`));
        break;
      case 'tool_result':
        out.push(...flattenToolResult(raw.content));
        break;
      case 'image':
        if (role === 'user' && raw.source) out.push({ type: 'image', source: raw.source });
        else out.push(text('[image]'));
        break;
      default:
        // Unknown block: count its JSON (over-counting is the safe direction).
        out.push(text(JSON.stringify(raw)));
    }
  }
  return out;
}

export function transcriptForCount(entries: ReadonlyArray<Entry>, targetWireModel: string): CountMessage[] {
  let start = 0;
  entries.forEach((e, i) => { if (e.type === 'system' && subtypeOf(e) === 'compact_boundary') start = i + 1; });
  const out: CountMessage[] = [];
  for (const e of entries.slice(start)) {
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const msg = (e.message ?? {}) as { content?: unknown; model?: unknown };
    const role = e.type;
    const blocks = flatten(role, msg.content, role === 'assistant' && sameModel(msg.model, targetWireModel));
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [text('(earlier conversation)')] });
  return out;
}

export async function checkTranscriptFit(
  input: { sdkSessionId: string; target: ResolvedModel; systemPrompt: string; pendingUserTurn: string; orgId: string },
  deps: TranscriptFitDeps = defaultTranscriptFitDeps,
): Promise<TranscriptFit> {
  const window = input.target.limits.maxInputTokens;
  if (!window || window <= 0) return { kind: 'unverifiable', reason: 'no_window' };
  if (!COUNTABLE_KINDS.has(input.target.connection.kind)) return { kind: 'unverifiable', reason: 'connection_kind' };
  let messages: CountMessage[];
  try {
    messages = transcriptForCount(await deps.readTranscript(input.sdkSessionId), input.target.wireModel);
  } catch (err) {
    console.warn('[transcriptFit] transcript unreadable; the switch will continue instead of resume', {
      sdkSessionId: input.sdkSessionId, error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unverifiable', reason: 'no_transcript' };
  }
  // No transcript on THIS replica (or none persisted) proves nothing about fit.
  if (messages.length === 0) return { kind: 'unverifiable', reason: 'no_transcript' };
  // The turn about to be sent counts too (Codex review finding 5).
  if (input.pendingUserTurn) {
    const last = messages[messages.length - 1]!;
    if (last.role === 'user') last.content.push(text(input.pendingUserTurn));
    else messages.push({ role: 'user', content: [text(input.pendingUserTurn)] });
  }
  let counted: number;
  try {
    counted = await deps.countTokens(input.target, { system: input.systemPrompt, messages }, input.orgId);
  } catch (err) {
    console.warn('[transcriptFit] token count failed; the switch will continue instead of resume', {
      wireModel: input.target.wireModel, error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'unverifiable', reason: 'count_failed' };
  }
  if (!Number.isFinite(counted) || counted < 0) return { kind: 'unverifiable', reason: 'count_failed' };
  const limitTokens = fitLimit(window, input.target.limits.maxOutputTokens);
  return counted <= limitTokens
    ? { kind: 'fits', countedTokens: counted, limitTokens }
    : { kind: 'too_large', countedTokens: counted, limitTokens };
}
