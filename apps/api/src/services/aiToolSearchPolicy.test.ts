import { describe, expect, it } from 'vitest';
import {
  SDK_TOOL_SEARCH_BUILTIN,
  TOOL_SEARCH_MIN_REMAINING_TURNS,
  isSdkBuiltinToolUse,
  resolveToolSearchPolicy,
  toolSearchOverride,
} from './aiToolSearchPolicy';

const firstParty = { ANTHROPIC_API_KEY: 'k' };
const base = { surfaceSearch: true, childEnv: firstParty, remainingTurns: 50 };

describe('resolveToolSearchPolicy', () => {
  it('enables search on a first-party host with no base URL', () => {
    expect(resolveToolSearchPolicy(base)).toEqual({
      enabled: true,
      reason: 'first_party_host',
      tools: [SDK_TOOL_SEARCH_BUILTIN],
      env: { ENABLE_TOOL_SEARCH: 'true' },
    });
  });

  it('treats an explicit api.anthropic.com base URL as first-party', () => {
    const policy = resolveToolSearchPolicy({ ...base, childEnv: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } });
    expect(policy.enabled).toBe(true);
    expect(policy.reason).toBe('first_party_host');
  });

  it.each([
    'https://openrouter.ai/api',
    'http://litellm.internal:4000',
    'https://api.anthropic.com.evil.example',
    'not a url',
  ])('keeps the full tool list on a non-first-party base URL (%s)', (url) => {
    const policy = resolveToolSearchPolicy({ ...base, childEnv: { ANTHROPIC_BASE_URL: url } });
    expect(policy).toEqual({
      enabled: false,
      reason: 'non_first_party_host',
      tools: [],
      env: { ENABLE_TOOL_SEARCH: 'false' },
    });
  });

  it('lets an operator force search on for a proxy that forwards tool_reference', () => {
    const policy = resolveToolSearchPolicy({ ...base, childEnv: { ANTHROPIC_BASE_URL: 'http://litellm:4000' }, override: 'on' });
    expect(policy.enabled).toBe(true);
    expect(policy.reason).toBe('operator_forced');
    expect(policy.env.ENABLE_TOOL_SEARCH).toBe('true');
  });

  it('lets an operator turn search off everywhere', () => {
    const policy = resolveToolSearchPolicy({ ...base, override: 'off' });
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toBe('operator_off');
    expect(policy.tools).toEqual([]);
  });

  it('never enables search on a static-subset surface, even when the operator forces it', () => {
    const policy = resolveToolSearchPolicy({ ...base, surfaceSearch: false, override: 'on' });
    expect(policy.enabled).toBe(false);
    expect(policy.reason).toBe('surface_static');
    expect(policy.env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('turns search off when too few turns remain for a search round-trip', () => {
    const low = resolveToolSearchPolicy({ ...base, remainingTurns: TOOL_SEARCH_MIN_REMAINING_TURNS - 1 });
    expect(low.enabled).toBe(false);
    expect(low.reason).toBe('low_turn_budget');
    expect(resolveToolSearchPolicy({ ...base, remainingTurns: TOOL_SEARCH_MIN_REMAINING_TURNS }).enabled).toBe(true);
  });
});

describe('toolSearchOverride', () => {
  it.each([
    [undefined, 'auto'],
    ['', 'auto'],
    ['auto', 'auto'],
    ['on', 'on'],
    [' OFF ', 'off'],
    ['true', 'auto'],
  ])('AI_TOOL_SEARCH=%j → %s', (value, expected) => {
    expect(toolSearchOverride({ AI_TOOL_SEARCH: value })).toBe(expected);
  });
});

describe('isSdkBuiltinToolUse', () => {
  it('recognises ToolSearch and nothing MCP-prefixed', () => {
    expect(isSdkBuiltinToolUse('ToolSearch')).toBe(true);
    expect(isSdkBuiltinToolUse('mcp__breeze__query_devices')).toBe(false);
    expect(isSdkBuiltinToolUse('query_devices')).toBe(false);
  });
});
