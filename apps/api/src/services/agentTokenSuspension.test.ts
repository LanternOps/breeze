import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN_SUSPEND_REASON, type AgentTokenSuspendReason } from './agentTokenSuspension';

describe('isolation credential-suspension policy', () => {
  it.each([
    [AGENT_TOKEN_SUSPEND_REASON.tenantSuspended, false],
    [AGENT_TOKEN_SUSPEND_REASON.crossTenantProbe, false],
    ['operator_requested' as AgentTokenSuspendReason, true],
  ] as const)('%s blocks on unresolved isolation: %s', async (reason, expected) => {
    const { isolationBlocksTokenSuspension } = await import('./agentTokenSuspension');
    expect(isolationBlocksTokenSuspension(reason)).toBe(expected);
  });
});
