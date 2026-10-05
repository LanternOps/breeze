import { describe, expect, it } from 'vitest';
import {
  AI_CONNECTION_ROW_KINDS,
  ANTHROPIC_API_CONNECTION_KINDS,
  BYO_MODEL_ID_PATTERN,
  GATEWAY_CONNECTION_KINDS,
  isAnthropicApiConnectionKind,
  isGatewayConnectionKind,
} from './aiConnectionKinds';

describe('aiConnectionKinds', () => {
  it('every gateway kind is a row kind', () => {
    for (const k of GATEWAY_CONNECTION_KINDS) expect(AI_CONNECTION_ROW_KINDS).toContain(k);
  });

  it('Anthropic-dialect kinds are never gateway kinds', () => {
    expect(isGatewayConnectionKind('anthropic_byok')).toBe(false);
    expect(isGatewayConnectionKind('catalog')).toBe(false);
    expect(isGatewayConnectionKind('platform')).toBe(false);
    expect(isGatewayConnectionKind('openai_compatible')).toBe(true);
  });

  it.each([
    ['qwen2.5-coder:7b', true],
    ['meta-llama/Llama-3.3-70B-Instruct', true],
    ['openrouter/anthropic/claude-sonnet', true],
    ['hf.co/InternScience/Agents-A1-4B-Q4_K_M-GGUF', true],
    ['gpt-4o@2024-08-06', true],
    ['', false],
    ['-leading-dash', false],
    ['has space', false],
    ['line\nbreak', false],
    ['<script>', false],
    ['x'.repeat(201), false],
  ])('BYO_MODEL_ID_PATTERN %j → %s', (id, ok) => {
    expect(BYO_MODEL_ID_PATTERN.test(id)).toBe(ok);
  });
});

describe('Anthropic API connection kinds (W08)', () => {
  it('are the two kinds that carry a stored Anthropic key: direct BYOK and a catalog gateway', () => {
    expect([...ANTHROPIC_API_CONNECTION_KINDS]).toEqual(['anthropic_byok', 'catalog']);
    expect(isAnthropicApiConnectionKind('anthropic_byok')).toBe(true);
    expect(isAnthropicApiConnectionKind('catalog')).toBe(true);
    expect(isAnthropicApiConnectionKind('openai_compatible')).toBe(false);
    expect(isAnthropicApiConnectionKind('bedrock')).toBe(false);
  });

  it('every Anthropic API kind is a row kind and never a gateway kind', () => {
    for (const k of ANTHROPIC_API_CONNECTION_KINDS) {
      expect(AI_CONNECTION_ROW_KINDS).toContain(k);
      expect(isGatewayConnectionKind(k)).toBe(false);
    }
  });
});
