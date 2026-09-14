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
});
