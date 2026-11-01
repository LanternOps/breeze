import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W5 PR C (#5220), Task C5 — `checkAgentGuardrails(..., { resolvedTier })`:
 * a flow tool (`flow__<slug>`) is absent from `TOOL_TIERS`, so the agent path
 * passes the flow's LIVE invocation tier. Only a flow tool name may carry
 * one; every other gate of the agent guardrail still applies.
 */

import { checkAgentGuardrails, type AgentGuardrailPolicy } from './aiGuardrails';

const policy = (over: Partial<AgentGuardrailPolicy> = {}): AgentGuardrailPolicy => ({
  enabled: true,
  mode: 'shadow',
  toolAllowlist: ['flow__report'],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  deviceId: null,
  deviceSiteId: null,
  ...over,
} as AgentGuardrailPolicy);

beforeEach(() => vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

describe('checkAgentGuardrails — resolved tier for flow tools', () => {
  it('checkAgentGuardrails without resolvedTier still denies an unknown name', () => {
    expect(checkAgentGuardrails('flow__report', {}, policy())).toMatchObject({ disposition: 'deny' });
  });

  it('a tier-1 flow tool with its resolved tier is allowed (read-only)', () => {
    expect(checkAgentGuardrails('flow__report', {}, policy(), undefined, { resolvedTier: 1 }))
      .toMatchObject({ disposition: 'allow', tier: 1, readOnly: true });
  });

  it('mode off, a disabled agent and the env kill switch still deny a flow tool', () => {
    expect(checkAgentGuardrails('flow__report', {}, policy({ mode: 'off' }), undefined, { resolvedTier: 1 })).toMatchObject({ disposition: 'deny' });
    expect(checkAgentGuardrails('flow__report', {}, policy({ enabled: false }), undefined, { resolvedTier: 1 })).toMatchObject({ disposition: 'deny' });
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');
    expect(checkAgentGuardrails('flow__report', {}, policy(), undefined, { resolvedTier: 1 })).toMatchObject({ disposition: 'deny' });
  });

  it('a resolved tier is ignored for a name that is not a flow tool', () => {
    expect(checkAgentGuardrails('not_a_tool', {}, policy({ toolAllowlist: ['not_a_tool'] }), undefined, { resolvedTier: 1 }))
      .toMatchObject({ disposition: 'deny' });
  });

  it('only a Tier-1 resolved tier exists for agents (Decision 9): a higher one is not expressible', () => {
    // @ts-expect-error — agents never pass a Tier ≥ 2 flow; the gate refuses it first.
    const check = checkAgentGuardrails('flow__report', {}, policy({ mode: 'act' }), undefined, { resolvedTier: 2 });
    expect(check.disposition).toBe('deny');
  });
});
