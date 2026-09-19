import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('./aiAgent', () => ({
  getSession: vi.fn(),
}));

vi.mock('./aiAgentRunSiteScope', () => ({
  runSiteScopeCondition: vi.fn(() => undefined),
}));

import { db } from '../db';
import { getSession } from './aiAgent';
import { AiOriginSourceNotFoundError, resolveAiOriginSummary } from './aiOriginSummary';

const DEV = 'device-1';
const EXEC = 'exec-1';
const SESSION_ID = 'sess-1';
const RUN_ID = 'run-1';

function authFor(userId: string): any {
  return {
    user: { id: userId },
    scope: 'organization',
    orgId: 'org-123',
    accessibleOrgIds: ['org-123'],
    canAccessOrg: (orgId: string) => orgId === 'org-123',
    orgCondition: () => undefined,
    allowedSiteIds: undefined,
  };
}

/** Queues the source-row select (script_executions) as the NEXT db.select() call. */
function queueSourceRow(row: Record<string, unknown> | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as never);
}

/** Queues the agent-run join select as the NEXT db.select() call. */
function queueAgentRunRow(row: Record<string, unknown> | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
        }),
      }),
    }),
  } as never);
}

/** Queues the best-effort audit-log lookup as the NEXT db.select() call. */
function queueAuditRow(row: Record<string, unknown> | undefined) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
        }),
      }),
    }),
  } as never);
}

describe('resolveAiOriginSummary (#5022 W02, OD-9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes the session id for the session owner', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: SESSION_ID,
      aiAgentRunId: null,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, title: 'Support chat' } as never);
    queueAuditRow(undefined);

    const dto = await resolveAiOriginSummary(authFor('owner-user'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto).toMatchObject({ kind: 'ai_assistant', resolvable: true, session: { id: SESSION_ID } });
    // getSession must be called WITHOUT allowAnyOwnerInOrg (owner-bound).
    expect(getSession).toHaveBeenCalledWith(SESSION_ID, expect.anything());
    const call = vi.mocked(getSession).mock.calls[0];
    expect(call?.[2]).toBeUndefined();
  });

  it('OMITS the session id for a technician who cannot open the transcript', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: SESSION_ID,
      aiAgentRunId: null,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    vi.mocked(getSession).mockResolvedValueOnce(null); // not the owner
    queueAuditRow(undefined);

    const dto = await resolveAiOriginSummary(authFor('other-tech'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto).toMatchObject({ kind: 'ai_assistant', resolvable: false });
    expect(dto).not.toHaveProperty('session');
    expect(JSON.stringify(dto)).not.toContain(SESSION_ID);
  });

  it('OMITS a run id that the caller cannot see (site scope / foreign tenant)', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_agent',
      aiSessionId: null,
      aiAgentRunId: RUN_ID,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    queueAgentRunRow(undefined); // run-site-scope / org join finds nothing
    queueAuditRow(undefined);

    const dto = await resolveAiOriginSummary(authFor('tech'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto!.resolvable).toBe(false);
    expect(dto).not.toHaveProperty('agentRun');
    expect(JSON.stringify(dto)).not.toContain(RUN_ID);
  });

  it('still reports the KIND when the id is unresolvable — the fact survives', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: SESSION_ID,
      aiAgentRunId: null,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    vi.mocked(getSession).mockResolvedValueOnce(null);
    queueAuditRow(undefined);

    const dto = await resolveAiOriginSummary(authFor('other-tech'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto!.kind).toBe('ai_assistant');
  });

  it('returns null for a row with no AI marker at all', async () => {
    queueSourceRow({ aiInitiatorKind: null, aiSessionId: null, aiAgentRunId: null, createdAt: new Date() });

    const dto = await resolveAiOriginSummary(authFor('tech'), { kind: 'execution', id: 'human-exec', deviceId: DEV });

    expect(dto).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('throws AiOriginSourceNotFoundError when the source row is not found (wrong device or not visible) — the route 404s on this, distinct from the legitimate no-marker null', async () => {
    queueSourceRow(undefined);

    await expect(
      resolveAiOriginSummary(authFor('tech'), { kind: 'execution', id: 'missing', deviceId: DEV }),
    ).rejects.toThrow(AiOriginSourceNotFoundError);
  });

  it('resolves an agent run for a caller within site scope', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_agent',
      aiSessionId: null,
      aiAgentRunId: RUN_ID,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    queueAgentRunRow({ id: RUN_ID, agentName: 'Patch Sentinel' });
    queueAuditRow(undefined);

    const dto = await resolveAiOriginSummary(authFor('tech'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto).toMatchObject({ kind: 'ai_agent', resolvable: true, agentRun: { id: RUN_ID }, label: 'Patch Sentinel' });
  });

  // #5022 W02 code review finding: nothing in the schema prevents a row from
  // carrying BOTH aiSessionId and aiAgentRunId. `kind` must be the sole
  // discriminator for which one gets resolved, so a dual-marker row never
  // mixes an agent-run label with a session-open link or vice versa.
  it('resolves ONLY the session for a dual-marker row whose kind is ai_assistant, even though aiAgentRunId is also set', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: SESSION_ID,
      aiAgentRunId: RUN_ID,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, title: 'Support chat' } as never);
    queueAuditRow(undefined);

    const dto = await resolveAiOriginSummary(authFor('owner-user'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto).toMatchObject({ kind: 'ai_assistant', resolvable: true, session: { id: SESSION_ID } });
    expect(dto).not.toHaveProperty('agentRun');
    expect(JSON.stringify(dto)).not.toContain(RUN_ID);
  });

  it('resolves ONLY the agent run for a dual-marker row whose kind is ai_agent, even though aiSessionId is also set', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_agent',
      aiSessionId: SESSION_ID,
      aiAgentRunId: RUN_ID,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    queueAgentRunRow({ id: RUN_ID, agentName: 'Patch Sentinel' });
    queueAuditRow(undefined);

    const dto = await resolveAiOriginSummary(authFor('tech'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto).toMatchObject({ kind: 'ai_agent', resolvable: true, agentRun: { id: RUN_ID } });
    expect(dto).not.toHaveProperty('session');
    expect(getSession).not.toHaveBeenCalled();
    expect(JSON.stringify(dto)).not.toContain(SESSION_ID);
  });

  it('does not fail the summary when the audit row is missing (best-effort, OD-10 A)', async () => {
    queueSourceRow({
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: SESSION_ID,
      aiAgentRunId: null,
      createdAt: new Date('2026-02-08T00:00:00.000Z'),
    });
    vi.mocked(getSession).mockResolvedValueOnce({ id: SESSION_ID, title: 'Support chat' } as never);
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('audit_logs unavailable');
    });

    const dto = await resolveAiOriginSummary(authFor('owner-user'), { kind: 'execution', id: EXEC, deviceId: DEV });

    expect(dto).toMatchObject({ kind: 'ai_assistant', resolvable: true, toolName: null });
  });
});
