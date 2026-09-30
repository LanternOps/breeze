import { describe, expect, it } from 'vitest';
import { resolveModelThinking } from './aiModelThinking';

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

  it.each(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'])(
    '%s → no thinking param at all',
    (model) => {
      const out = resolveModelThinking(model);
      expect(out).toEqual({});
      expect('thinking' in out).toBe(false);
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
