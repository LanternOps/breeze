import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// beginMcpToolExecutionLedger — tenant-isolation defense-in-depth (security)
//
// The ledger opens an RLS context scoped to input.orgId and inserts ai_sessions
// / ai_tool_executions rows under it. If an upstream org-resolution bug ever
// passed an org the caller cannot access, those rows would land in another
// tenant. The ledger must assert input.orgId is within input.accessibleOrgIds
// (null = system scope = all orgs) BEFORE opening the context / writing rows.
//
// db is mocked so the throw is observable as "no insert happened". The two
// pure util modules (auditPayloadSanitizer, aiToolOutput) run for real.
// ============================================================================

vi.mock('../db', () => {
  // values() must be awaitable (aiSessions insert) AND expose .returning()
  // (aiToolExecutions insert) — model both with a resolved promise carrying a
  // .returning method.
  const makeValuesResult = () => {
    const p: any = Promise.resolve(undefined);
    p.returning = () => Promise.resolve([{ id: '00000000-0000-4000-8000-00000000c0de' }]);
    return p;
  };
  return {
    db: { insert: vi.fn(() => ({ values: vi.fn(() => makeValuesResult()) })) },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('../db/schema', () => ({
  aiSessions: {},
  aiToolExecutions: { id: 'aiToolExecutions.id' },
}));

import { beginMcpToolExecutionLedger, type BeginMcpToolExecutionLedgerInput } from './mcpToolExecutionLedger';
import { db } from '../db';

const OWN_ORG = '11111111-1111-4111-8111-111111111111';
const VICTIM_ORG = '99999999-9999-4999-8999-999999999999';

function baseInput(overrides: Partial<BeginMcpToolExecutionLedgerInput> = {}): BeginMcpToolExecutionLedgerInput {
  return {
    orgId: OWN_ORG,
    accessibleOrgIds: [OWN_ORG],
    toolName: 'list_remote_sessions',
    tier: 3,
    toolInput: { orgId: OWN_ORG },
    principal: { apiKeyId: 'key-1', oauthGrantId: null, partnerId: 'p-1', actorUserId: null },
    transportSessionId: null,
    transportRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    era: 'legacy',
    ...overrides,
  };
}

describe('beginMcpToolExecutionLedger — tenant isolation (defense-in-depth)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws WITHOUT writing any ledger row when orgId is outside the caller accessible set', async () => {
    await expect(
      beginMcpToolExecutionLedger(baseInput({ orgId: VICTIM_ORG, accessibleOrgIds: [OWN_ORG] })),
    ).rejects.toThrow(/outside caller tenancy/i);
    // Critical: the RLS context must never be opened nor any row inserted.
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('proceeds when orgId is within the caller accessible set', async () => {
    const handle = await beginMcpToolExecutionLedger(
      baseInput({ orgId: OWN_ORG, accessibleOrgIds: [OWN_ORG] }),
    );
    expect(handle.orgId).toBe(OWN_ORG);
    expect(handle.executionId).toBe('00000000-0000-4000-8000-00000000c0de');
    expect(db.insert).toHaveBeenCalled();
  });

  it('proceeds for a system-scope caller (accessibleOrgIds = null) targeting any org', async () => {
    const handle = await beginMcpToolExecutionLedger(
      baseInput({ orgId: VICTIM_ORG, accessibleOrgIds: null }),
    );
    expect(handle.orgId).toBe(VICTIM_ORG);
    expect(db.insert).toHaveBeenCalled();
  });
});

describe('beginMcpToolExecutionLedger — AI origin (#5022 W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an ai_assistant origin naming the PERSISTED ai_sessions row, not the transport session', async () => {
    const handle = await beginMcpToolExecutionLedger(
      baseInput({ transportSessionId: 'mcp-transport-abc' }),
    );

    expect(handle.aiOrigin.kind).toBe('ai_assistant');
    expect(handle.aiOrigin.sessionId).toBe(handle.sessionId);
    expect(handle.aiOrigin.sessionId).not.toBe('mcp-transport-abc');
    expect(handle.aiOrigin.agentRunId).toBeUndefined();
  });
});

describe('beginMcpToolExecutionLedger — request correlation (B-W03 #6157)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records the server-minted transportRequestId and era in BOTH ledger representations', async () => {
    await beginMcpToolExecutionLedger(
      baseInput({ transportSessionId: null, transportRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', era: 'modern' }),
    );
    const insertMock = db.insert as unknown as ReturnType<typeof vi.fn>;
    const valuesCalls = insertMock.mock.results.map((r) => (r.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0]);
    const sessionRow = valuesCalls[0] as { contextSnapshot: Record<string, unknown> };
    const execRow = valuesCalls[1] as { toolInput: { transport: Record<string, unknown> } };
    expect(sessionRow.contextSnapshot).toMatchObject({
      transportSessionId: null,
      transportRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      era: 'modern',
    });
    expect(execRow.toolInput.transport).toEqual({
      sessionId: null,
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      era: 'modern',
    });
  });
});
