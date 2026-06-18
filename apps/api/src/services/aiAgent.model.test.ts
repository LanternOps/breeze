import { describe, expect, it } from 'vitest';
import { resolveDefaultModel, BREEZE_FALLBACK_MODEL } from './aiAgent';

// #1412: ANTHROPIC_MODEL lets a self-hosted operator override the default model
// id for a raw vLLM backend whose served id differs from the Anthropic alias.
describe('resolveDefaultModel (#1412)', () => {
  it('returns the Anthropic fallback when ANTHROPIC_MODEL is unset', () => {
    expect(resolveDefaultModel({})).toBe(BREEZE_FALLBACK_MODEL);
  });

  it('uses ANTHROPIC_MODEL when set', () => {
    expect(resolveDefaultModel({ ANTHROPIC_MODEL: 'my-vllm-model' })).toBe('my-vllm-model');
  });

  it('trims surrounding whitespace from ANTHROPIC_MODEL', () => {
    expect(resolveDefaultModel({ ANTHROPIC_MODEL: '  my-vllm-model  ' })).toBe('my-vllm-model');
  });

  it.each(['', '   '])(
    'falls back to the default when ANTHROPIC_MODEL is empty/whitespace-only (%j) — never an empty model id',
    (value) => {
      expect(resolveDefaultModel({ ANTHROPIC_MODEL: value })).toBe(BREEZE_FALLBACK_MODEL);
    },
  );
});
