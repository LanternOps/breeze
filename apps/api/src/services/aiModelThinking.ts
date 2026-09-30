// INTERIM — replaced by the model registry's capabilities (model-control feature)
//
// #7587: every Claude Agent SDK `query()` used to hard-code
// `thinking: { type: 'disabled' }`. Sonnet 5.5, Opus 5.5 and Fable 5.x reject
// that with a 400, and it left chat answering with no reasoning step. This is
// the ONE place that decides the thinking/effort options for a model id; the
// model registry feature deletes it in favour of per-model capabilities.
//
// Keyed on the id that actually goes on the wire. Anything that is not a
// recognised first-party Anthropic id (catalog wire ids such as
// `anthropic/claude-…`, BYO gateways, a self-host `ANTHROPIC_MODEL`) keeps the
// pre-#7587 `disabled`, so non-Anthropic backends see exactly what they saw
// before.
//
// Option shapes verified against @anthropic-ai/claude-agent-sdk 0.3.286
// `Options` (sdk.d.ts): `thinking?: ThinkingConfig` and `effort?: EffortLevel`.
import type { Options } from '@anthropic-ai/claude-agent-sdk';

export type ModelThinkingOptions = Pick<Options, 'thinking' | 'effort'>;

// `claude-<family>-<major>[-<minor>][-<YYYYMMDD>]`. The minor is 1–2 digits and
// a dated snapshot suffix is exactly 8, so `claude-opus-4-6-20260101` parses
// as Opus 4.6 and nothing else can ride in on a trailing segment.
const FIRST_PARTY_MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;

export function resolveModelThinking(model: string): ModelThinkingOptions {
  const match = FIRST_PARTY_MODEL_ID.exec(model);
  if (!match) return { thinking: { type: 'disabled' } };

  const family = match[1];
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);

  // Fable 5.x, Opus/Sonnet 5+, Opus 4.6–4.8, Sonnet 4.6: adaptive thinking
  // with effort `medium` (never `xhigh`, which 4.6 does not accept).
  const adaptive =
    family === 'fable' ||
    ((family === 'opus' || family === 'sonnet') && (major >= 5 || (major === 4 && minor >= 6)));
  if (adaptive) return { thinking: { type: 'adaptive' }, effort: 'medium' };

  // Haiku 4.5 and older Opus/Sonnet (4.5 and below) accept `disabled`: keep
  // today's behavior. For Haiku this must be an explicit `disabled`, not an
  // omitted param — with no `thinking` option the Agent SDK CLI turns extended
  // thinking ON for Haiku 4.5 (live-checked on 0.3.286: ~11x the output tokens).
  return { thinking: { type: 'disabled' } };
}

/**
 * Thinking/effort for raw `client.messages.create` one-shots (effort travels
 * as `output_config.effort` there). Those surfaces never sent a thinking
 * param, so this only ever REDUCES thinking: params are added solely for
 * models that already run adaptive when the param is omitted (Fable, Opus /
 * Sonnet 5+), to cap them at the table's effort. Opus/Sonnet 4.6–4.8 do not
 * think by default on the Messages API and keep sending nothing, as does
 * every other id. Without this, Sonnet 5.5 ran adaptive at the API's default
 * effort and a 512-token JSON one-shot hit `max_tokens` with truncated output
 * (live-checked, 1 run in 3).
 */
export function resolveMessagesApiThinking(
  model: string,
): { thinking?: { type: 'adaptive' }; output_config?: { effort: NonNullable<Options['effort']> } } {
  const match = FIRST_PARTY_MODEL_ID.exec(model);
  if (!match) return {};
  const family = match[1];
  const thinksByDefault = family === 'fable' || ((family === 'opus' || family === 'sonnet') && Number(match[2]) >= 5);
  if (!thinksByDefault) return {};
  const { effort } = resolveModelThinking(model);
  return effort ? { thinking: { type: 'adaptive' }, output_config: { effort } } : {};
}
