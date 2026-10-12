import { describe, expect, it } from 'vitest';
import {
  AI_CONNECTION_KINDS,
  AI_CONNECTION_ROW_KINDS,
  AI_DISPATCHABLE_CONNECTION_KINDS,
  ANTHROPIC_API_CONNECTION_KINDS,
  BYO_MODEL_ID_PATTERN,
  GATEWAY_CONNECTION_KINDS,
  envManagementState,
  envStateDtoFields,
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

describe('one source for every connection-kind list (#7779)', () => {
  it('AI_CONNECTION_KINDS is the implicit platform connection plus every row kind', () => {
    expect([...AI_CONNECTION_KINDS]).toEqual(['platform', ...AI_CONNECTION_ROW_KINDS]);
  });

  it('every row kind is exactly one of Anthropic-API or gateway (no kind falls between the lists)', () => {
    for (const k of AI_CONNECTION_ROW_KINDS) {
      expect(Number(isAnthropicApiConnectionKind(k)) + Number(isGatewayConnectionKind(k))).toBe(1);
    }
    expect([...ANTHROPIC_API_CONNECTION_KINDS, ...GATEWAY_CONNECTION_KINDS].sort())
      .toEqual([...AI_CONNECTION_ROW_KINDS].sort());
  });

  it('dispatchable kinds are platform + Anthropic-API + gateway kinds', () => {
    expect([...AI_DISPATCHABLE_CONNECTION_KINDS])
      .toEqual(['platform', ...ANTHROPIC_API_CONNECTION_KINDS, ...GATEWAY_CONNECTION_KINDS]);
  });
});

describe('env-management state (#7779)', () => {
  it('maps provider_config to managed / released / null', () => {
    expect(envManagementState(null)).toBeNull();
    expect(envManagementState({})).toBeNull();
    expect(envManagementState({ managedBy: 'env' })).toBe('managed');
    expect(envManagementState({ managedBy: 'env', envReleasedAt: '2026-01-01T00:00:00.000Z' })).toBe('released');
    expect(envManagementState({ envReleasedAt: '2026-01-01T00:00:00.000Z' })).toBeNull();
  });

  it('derives the DTO fields from the state', () => {
    expect(envStateDtoFields('managed')).toEqual({ managedBy: 'env', envReleased: false });
    expect(envStateDtoFields('released')).toEqual({ managedBy: 'env', envReleased: true });
    expect(envStateDtoFields(null)).toEqual({ managedBy: null, envReleased: false });
  });
});
