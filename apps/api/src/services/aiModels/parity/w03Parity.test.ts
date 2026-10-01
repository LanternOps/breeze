import { describe, expect, it } from 'vitest';
import { queryKey } from './w03Parity';

describe('w03Parity helpers', () => {
  it('query keys are stable and distinct per kind', () => {
    expect(queryKey({ kind: 'surface', surface: 'chat', orgId: 'o1' })).toBe('surface:chat:o1');
    expect(queryKey({ kind: 'agent', agentKind: 'triage', orgId: 'o1' })).toBe('agent:triage:o1');
    expect(queryKey({ kind: 'session', sessionId: 's1' })).toBe('session:s1');
  });
});
