import { describe, expect, it } from 'vitest';

// The string → offering path (bindAgentModel) was retired in W08 (#7606): the
// validator rejects a policy `model`, and agentOfferingBinding.test.ts covers
// the only binding left.
import { AgentModelNotAllowedError } from './agentModelBinding';

describe('AgentModelNotAllowedError status mapping (W05)', () => {
  it.each([
    ['invalid_model', 400], ['not_permitted', 400], ['model_unavailable', 400],
    ['permission_required', 403], ['registry_unavailable', 503],
  ] as const)('%s → %i', (code, status) => {
    expect(new AgentModelNotAllowedError('x', code).status).toBe(status);
  });
});
