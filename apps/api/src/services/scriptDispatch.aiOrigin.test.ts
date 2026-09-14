import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// #5022 W01 — the aiOrigin conduit through scriptDispatch.
//
// `dispatchScriptToDevice` is two of the five insert chokepoints: it writes the
// `script_executions` row itself and queues the `device_commands` row through
// `queueCommand`. BOTH must carry the origin, and both must leave all three
// columns explicitly NULL when there is none.
//
// Mocks mirror scriptDispatch.aiAuditProvenance.test.ts.
// ============================================================================
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./commandQueue', async () => {
  const { CommandTypes } = await import('./commandTypes');
  return { CommandTypes, queueCommand: vi.fn() };
});
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
  toAgentCommandFrame: vi.fn((c: { id: string; type: string; payload: unknown }) => ({
    id: c.id,
    type: c.type,
    payload: c.payload,
  })),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
vi.mock('./scriptSecretDelivery', () => ({
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'Agent upgrade required: mocked message',
  SECRET_GATE_UNAVAILABLE_MESSAGE: 'Secret gate unavailable: mocked message',
  secretDeliveryPreflight: vi.fn().mockResolvedValue({ ok: true }),
  failClaimedSecretCommandsForUnsupportedAgent: vi.fn((claimed: unknown[]) => Promise.resolve(claimed)),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./scriptMaintenanceGate', () => ({
  checkScriptMaintenanceSuppression: vi.fn().mockResolvedValue({ suppressed: false }),
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { dispatchScriptToDevice } from './scriptDispatch';
import { captureException } from './sentry';

const device = () =>
  ({
    id: 'device-1',
    orgId: 'org-a',
    osType: 'linux',
    status: 'online',
    agentId: null,
    hostname: 'host-1',
    siteId: 'site-1',
    customFields: {},
  }) as never;

const savedSource = () =>
  ({
    kind: 'saved',
    script: {
      id: 'script-1',
      orgId: 'org-a',
      partnerId: null,
      isSystem: false,
      osTypes: ['linux'],
      language: 'bash',
      content: 'echo hi',
      timeoutSeconds: 60,
      runAs: 'system',
      deletedAt: null,
      acknowledgedSecurityPatterns: [],
    },
  }) as never;

let executionInsertValues: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  executionInsertValues = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]),
  });
  vi.mocked(db.insert).mockReturnValue({ values: executionInsertValues } as never);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as never);
  // The users-FK probe: the caller IS a real user.
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'user-1' }]) }),
    }),
  } as never);
});

describe('dispatchScriptToDevice — aiOrigin conduit (#5022 W01)', () => {
  it('stamps the origin on BOTH the script_executions row and its device_commands row', async () => {
    const result = await dispatchScriptToDevice({
      device: device(),
      source: savedSource(),
      triggeredBy: 'user-1',
      createdBy: 'user-1',
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    } as never);

    expect(result.ok).toBe(true);

    expect(executionInsertValues).toHaveBeenCalledTimes(1);
    expect(executionInsertValues.mock.calls[0]![0]).toMatchObject({
      aiInitiatorKind: 'ai_assistant',
      aiSessionId: 'sess-1',
      aiAgentRunId: null,
    });

    expect(queueCommand).toHaveBeenCalledWith(
      'device-1',
      'script',
      expect.anything(),
      'user-1',
      expect.objectContaining({ aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' } }),
    );
  });

  it('leaves all three execution columns NULL for an ordinary human dispatch', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: savedSource(),
      triggeredBy: 'user-1',
      createdBy: 'user-1',
    } as never);

    expect(executionInsertValues.mock.calls[0]![0]).toMatchObject({
      aiInitiatorKind: null,
      aiSessionId: null,
      aiAgentRunId: null,
    });
    expect(vi.mocked(queueCommand).mock.calls[0]![4]).not.toHaveProperty('aiOrigin');
  });

  it('a raw-source AI dispatch never gets a script_executions row, so it must NOT suppress the ai.command.executed fallback', async () => {
    const result = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'raw', content: 'ipconfig', language: 'powershell', provenance: 'automation:auto-1' },
      triggeredBy: 'user-1',
      createdBy: 'user-1',
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    } as never);

    expect(result.ok).toBe(true);
    // No execution row for a raw source: the ai.script.executed write below
    // is gated on `executionId`, which is never set for 'raw'.
    expect(executionInsertValues).not.toHaveBeenCalled();

    // Must NOT suppress commandQueue's own ai.command.executed write, or a
    // raw-source AI dispatch writes ZERO `ai.` audit rows.
    expect(queueCommand).toHaveBeenCalledWith(
      'device-1',
      'script',
      expect.anything(),
      'user-1',
      expect.objectContaining({
        aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
        suppressAiCommandAudit: false,
      }),
    );
  });

  it('a saved/proposal AI dispatch suppresses commandQueue audit and relies on its own ai.script.executed write', async () => {
    const { createAuditLogAsync } = await import('./auditService');

    await dispatchScriptToDevice({
      device: device(),
      source: savedSource(),
      triggeredBy: 'user-1',
      createdBy: 'user-1',
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    } as never);

    expect(queueCommand).toHaveBeenCalledWith(
      'device-1',
      'script',
      expect.anything(),
      'user-1',
      expect.objectContaining({ suppressAiCommandAudit: true }),
    );
    expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAuditLogAsync).mock.calls[0]![0]).toMatchObject({
      action: 'ai.script.executed',
    });
  });
});

// Review fix (#5789): the triggered_by/created_by degrade warn now branches on
// hasAiOrigin — an expected ai_agent degrade stays console-only, but an
// ANOMALOUS one (a plain actor id that just doesn't resolve — a stale or
// deleted user) also reports to Sentry.
describe('dispatchScriptToDevice — degraded actor reporting (#5789)', () => {
  function mockMissingUserProbe() {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);
  }

  it('does NOT captureException for the expected ai_agent degrade', async () => {
    mockMissingUserProbe();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await dispatchScriptToDevice({
      device: device(),
      source: savedSource(),
      triggeredBy: 'agent-synthetic-1',
      createdBy: 'agent-synthetic-1',
      aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
    } as never);
    warn.mockRestore();

    expect(captureException).not.toHaveBeenCalled();
  });

  it('DOES captureException for an anomalous degrade with no aiOrigin (stale/deleted user id)', async () => {
    mockMissingUserProbe();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await dispatchScriptToDevice({
      device: device(),
      source: savedSource(),
      triggeredBy: 'stale-user-1',
      createdBy: 'stale-user-1',
    } as never);
    warn.mockRestore();

    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
