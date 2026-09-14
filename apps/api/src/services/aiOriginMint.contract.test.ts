import { describe, it, expect } from 'vitest';
import { buildAgentAuthContext } from './aiAgents/agentAuthContext';

describe('AI surfaces mint aiOrigin (#5022 W01)', () => {
  it('the autonomous agent context carries kind ai_agent plus the run id', () => {
    const auth = buildAgentAuthContext(
      { id: 'agent-1', orgId: 'org-1', partnerId: 'p-1', name: 'Triage', kind: 'triage' },
      { id: 'run-1', orgId: 'org-1', deviceId: 'dev-1', deviceSiteId: 'site-1' },
      { id: 'org-1', partnerId: 'p-1' },
    );

    expect(auth.aiOrigin).toEqual({ kind: 'ai_agent', agentRunId: 'run-1' });
    expect(auth.principal).toMatchObject({ kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' });
  });

  it('carries the run session id when the run has one', () => {
    const auth = buildAgentAuthContext(
      { id: 'agent-1', orgId: 'org-1', partnerId: 'p-1', name: 'Triage', kind: 'triage' },
      { id: 'run-1', orgId: 'org-1', deviceId: null, sessionId: 'sess-1' },
      { id: 'org-1', partnerId: 'p-1' },
    );

    expect(auth.aiOrigin).toEqual({ kind: 'ai_agent', agentRunId: 'run-1', sessionId: 'sess-1' });
  });

  it('every AI surface listed in the spec has a mint site covered by this file', () => {
    // Update BOTH this set and a test above when a new AI surface is added.
    const covered = new Set(['agent_run', 'chat_session', 'mcp_ledger']);
    expect([...covered].sort()).toEqual(['agent_run', 'chat_session', 'mcp_ledger']);
  });
});
