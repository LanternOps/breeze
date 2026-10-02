import { describe, expect, it } from 'vitest';
import { projectW03SurfaceUse, queryKey } from './w03Parity';
import type { RegistrySnapshot } from './storeProjection';

describe('w03Parity helpers', () => {
  it('query keys are stable and distinct per kind', () => {
    expect(queryKey({ kind: 'surface', surface: 'chat', orgId: 'o1' })).toBe('surface:chat:o1');
    expect(queryKey({ kind: 'agent', agentKind: 'triage', orgId: 'o1' })).toBe('agent:triage:o1');
    expect(queryKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
  });
});

describe('projectW03SurfaceUse: spec §9.1 bounded fallback for an agent policy offering (W03 Task 12)', () => {
  type Offering = RegistrySnapshot['offerings'][number];
  const DEFAULT: Offering = { id: 'off-default', connectionId: null, modelId: null, platformModelId: 'pm-sonnet', enabled: true };
  // Platform offerings only, so no connection key material is involved.
  const store = (offerings: Offering[], connections: RegistrySnapshot['connections'] = []): RegistrySnapshot => ({
    partnerId: 'p1',
    connections,
    offerings,
    platformModels: [{ id: 'pm-sonnet', modelId: 'claude-sonnet-5-5' }, { id: 'pm-opus', modelId: 'claude-opus-5-5' }],
    assignments: [{
      id: 'as-1', orgId: null, surface: 'ai_agents', role: 'default', defaultOfferingId: 'off-default',
      permittedOfferingIds: null, allowUserChoice: null, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null,
    } as unknown as RegistrySnapshot['assignments'][number]],
    agents: [{ id: 'ag', kind: 'triage', orgId: null, offeringId: 'off-policy' }],
    sessions: [],
    catalogProvider: null,
  });
  const q = { kind: 'agent' as const, agentKind: 'triage', orgId: 'o1' };

  it('an ineligible policy offering falls back to the default on the same route', () => {
    const s = store([DEFAULT, { id: 'off-policy', connectionId: null, modelId: null, platformModelId: 'pm-opus', enabled: false }]);
    expect(projectW03SurfaceUse(s, q)).toEqual({
      outcome: 'ok', destination: 'platform', funding: 'platform', logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5',
    });
  });

  it('never falls back across a connection (or funding): stays unavailable', () => {
    const s = store(
      [DEFAULT, { id: 'off-policy', connectionId: 'conn-1', modelId: 'claude-opus-5-5', platformModelId: null, enabled: true }],
      [{ id: 'conn-1', kind: 'anthropic_byok', status: 'error', apiKeyEncrypted: null }],
    );
    expect(projectW03SurfaceUse(s, q).outcome).toBe('unavailable');
  });

  it('an eligible policy offering is projected as is (no fallback)', () => {
    const s = store([DEFAULT, { id: 'off-policy', connectionId: null, modelId: null, platformModelId: 'pm-opus', enabled: true }]);
    expect(projectW03SurfaceUse(s, q)).toMatchObject({ outcome: 'ok', logicalModel: 'claude-opus-5-5' });
  });
});
