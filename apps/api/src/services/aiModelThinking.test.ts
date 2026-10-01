import { describe, expect, it } from 'vitest';
import { resolveMessagesApiThinking, resolveModelThinking } from './aiModelThinking';

const ADAPTIVE_MEDIUM = { thinking: { type: 'adaptive' }, effort: 'medium' };
const DISABLED = { thinking: { type: 'disabled' } };

// #7587 — every row of the interim resolver's table. Sonnet 5.5 / Opus 5.5 /
// Fable 5.x reject `thinking: disabled` with a 400, so a regression here is a
// broken chat, not a quality nit.
describe('resolveModelThinking (#7587 interim table)', () => {
  it.each([
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ])('%s → adaptive thinking + effort medium (never disabled)', (model) => {
    expect(resolveModelThinking(model)).toEqual(ADAPTIVE_MEDIUM);
  });

  it('accepts a dated snapshot of a current model', () => {
    expect(resolveModelThinking('claude-opus-4-6-20260101')).toEqual(ADAPTIVE_MEDIUM);
  });

  it('never returns xhigh (Opus/Sonnet 4.6 do not accept it)', () => {
    expect(resolveModelThinking('claude-opus-4-6').effort).toBe('medium');
    expect(resolveModelThinking('claude-sonnet-4-6').effort).toBe('medium');
  });

  // Haiku keeps today's behavior, which is an explicit `disabled`. Omitting the
  // param is NOT equivalent: live-checked on SDK 0.3.286, the CLI then turns
  // extended thinking ON for Haiku 4.5 (5,925 output tokens vs 272 on the same
  // prompt, ~11x the cost).
  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'])(
    '%s → thinking disabled, never omitted (#7587)',
    (model) => {
      const out = resolveModelThinking(model);
      expect(out).toEqual(DISABLED);
      expect('effort' in out).toBe(false);
    },
  );

  it.each([
    // Older Anthropic models: today's (working) behavior.
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5',
    'claude-opus-4-1',
    'claude-sonnet-4-0',
    // Unknown / BYO / catalog wire ids / self-host ANTHROPIC_MODEL.
    'my-vllm-model',
    'anthropic/claude-sonnet-5-5',
    'us.anthropic.claude-sonnet-5-5',
    'claude-sonnet-5-5-custom',
    'gpt-5',
    '',
  ])('%j → thinking disabled (today\'s behavior for unknown backends)', (model) => {
    expect(resolveModelThinking(model)).toEqual(DISABLED);
  });

  it('returns a fresh object per call (callers may spread/mutate it)', () => {
    const a = resolveModelThinking('claude-sonnet-5-5');
    const b = resolveModelThinking('claude-sonnet-5-5');
    expect(a).not.toBe(b);
  });
});

// Raw `client.messages.create` one-shots (script reviewer, patch-test analysis,
// ticket / email drafts). Live-checked: with NO thinking param Sonnet 5.5 runs
// adaptive at the API's default effort, and the 512-token patch-analysis call
// hit max_tokens 1 run in 3 with truncated JSON; adaptive + effort medium
// finished in ~240 tokens every time.
describe('resolveMessagesApiThinking (#7587)', () => {
  // Only models that ALREADY run adaptive when the param is omitted (Fable,
  // Opus/Sonnet 5+) get params here — the effort caps thinking they would do
  // anyway. A one-shot is never switched from no-thinking to thinking.
  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5'])(
    '%s → adaptive thinking + output_config.effort medium',
    (model) => {
      expect(resolveMessagesApiThinking(model)).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
      });
    },
  );

  // These one-shots never sent a thinking param before #7587; everything that
  // is not adaptive keeps sending nothing (no new field reaches a catalog/BYO
  // gateway, and the Messages API does not think by default on these models).
  it.each(['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'anthropic/claude-sonnet-5-5', 'my-vllm-model'])(
    '%s → no params (unchanged)',
    (model) => {
      expect(resolveMessagesApiThinking(model)).toEqual({});
    },
  );
});
