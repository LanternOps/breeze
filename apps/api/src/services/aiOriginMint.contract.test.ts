import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
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

  // ---------------------------------------------------------------------
  // #5789 review fix: the previous version of this test compared a
  // hardcoded Set to itself (`[...covered].sort()` against the very same
  // literal), which can never fail no matter what the mint sites actually
  // do. Replaced with a REAL source scan: each AiInitiatorKind mint site
  // must exist and mint aiOrigin UNCONDITIONALLY (never behind an `if
  // (auth.aiOrigin)` guard that could leave it undefined on some path).
  // ---------------------------------------------------------------------
  const REPO_ROOT = path.resolve(__dirname, '../../../..');

  function read(file: string): string {
    return readFileSync(path.join(REPO_ROOT, file), 'utf8');
  }

  const MINT_SITES: Record<string, { file: string; pattern: RegExp; describe: string }> = {
    agent_run: {
      file: 'apps/api/src/services/aiAgents/agentAuthContext.ts',
      // buildAgentAuthContext's returned object literal — see the two tests
      // above for the live behaviour this pattern locks in.
      pattern: /aiOrigin:\s*\{\s*kind:\s*'ai_agent' as const,/,
      describe: "buildAgentAuthContext's returned AuthContext literal",
    },
    chat_session: {
      file: 'apps/api/src/services/streamingSessionManager.ts',
      // withChatAiOrigin's unconditional stamp (the early return above it is
      // an identity short-circuit for an ALREADY-correct origin, not a path
      // that produces no origin at all).
      pattern: /aiOrigin:\s*\{\s*kind:\s*'ai_assistant',\s*sessionId:\s*breezeSessionId\s*\}/,
      describe: "withChatAiOrigin's unconditional stamp",
    },
    mcp_ledger: {
      file: 'apps/api/src/services/mcpToolExecutionLedger.ts',
      // createMcpToolExecutionLedger's returned object — every MCP tool
      // execution mints a fresh ai_sessions row and origin, unconditionally.
      pattern: /aiOrigin:\s*\{\s*kind:\s*'ai_assistant',\s*sessionId\s*\}/,
      describe: "createMcpToolExecutionLedger's returned mint",
    },
  };

  it('sees more than zero mint sites, so this scan cannot rot into a vacuous pass', () => {
    expect(Object.keys(MINT_SITES).length).toBeGreaterThan(0);
  });

  for (const [kind, site] of Object.entries(MINT_SITES)) {
    it(`${kind}: ${site.describe} mints aiOrigin unconditionally`, () => {
      expect(read(site.file), `${site.file} no longer matches the mint pattern for ${kind}`).toMatch(site.pattern);
    });
  }
});
