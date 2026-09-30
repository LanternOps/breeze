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

  // Haiku: no thinking param at all.
  if (family === 'haiku') return {};

  // Fable 5.x, Opus/Sonnet 5+, Opus 4.6–4.8, Sonnet 4.6: adaptive thinking
  // with effort `medium` (never `xhigh`, which 4.6 does not accept).
  const adaptive =
    family === 'fable' ||
    major >= 5 ||
    (major === 4 && minor >= 6 && (family === 'opus' || family === 'sonnet'));
  if (adaptive) return { thinking: { type: 'adaptive' }, effort: 'medium' };

  // Older Opus/Sonnet (4.5 and below) accept `disabled`: keep today's behavior.
  return { thinking: { type: 'disabled' } };
}
