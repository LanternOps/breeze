import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stopProof: {
    state: 'confirmed' as const,
    commandId: '22222222-2222-4222-8222-222222222222',
    outcome: 'stopped' as const,
  },
  updatedRows: [{ id: '11111111-1111-4111-8111-111111111111' }],
  auditFailure: null as Error | null,
  inSystemTransaction: false,
  updateValues: null as Record<string, unknown> | null,
  auditValues: [] as Array<Record<string, unknown>>,
  sessionRows: [{ status: 'active' }] as Array<Record<string, unknown>>,
  commandRows: [] as Array<Record<string, unknown>>,
}));

const ensureDesktopStreamStoppedMock = vi.hoisted(() => vi.fn());
const revokeViewerSessionMock = vi.hoisted(() => vi.fn());
const updateReturningMock = vi.hoisted(() => vi.fn());
const auditValuesMock = vi.hoisted(() => vi.fn());
const withSystemDbAccessContextMock = vi.hoisted(() => vi.fn());
const observeDesktopFinalizationMock = vi.hoisted(() => vi.fn());
const getDesktopSessionFinalizationJobStateMock = vi.hoisted(() => vi.fn());

vi.mock('./desktopSessionStop', () => ({
  ensureDesktopStreamStopped: ensureDesktopStreamStoppedMock,
}));

vi.mock('./viewerTokenRevocation', () => ({
  revokeViewerSession: revokeViewerSessionMock,
}));

vi.mock('./remoteWsSharedLease', () => ({
  getRemoteWsSharedLeaseManager: vi.fn(() => ({
    observeDesktopFinalization: observeDesktopFinalizationMock,
  })),
}));

vi.mock('../jobs/desktopSessionFinalizationWorker', () => ({
  getDesktopSessionFinalizationJobState: getDesktopSessionFinalizationJobStateMock,
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    _table: 'remote_sessions',
    id: 'remote_sessions.id',
    status: 'remote_sessions.status',
  },
  deviceCommands: {
    _table: 'device_commands',
    id: 'device_commands.id',
    status: 'device_commands.status',
    result: 'device_commands.result',
  },
  auditLogs: 'audit_logs',
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  db: {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updateValues = values;
        return {
          where: vi.fn(() => ({
            returning: updateReturningMock,
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: auditValuesMock,
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: { _table?: string }) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () =>
            table._table === 'device_commands'
              ? state.commandRows
              : state.sessionRows),
        })),
      })),
    })),
  },
}));

import {
  desktopSessionFinalizationInputSchema,
  finalizeDesktopSessionOnce,
  inspectDesktopFinalization,
  type DesktopSessionFinalizationInput,
} from './desktopSessionFinalization';

const input: DesktopSessionFinalizationInput = {
  version: 1,
  finalizationId: '22222222-2222-4222-8222-222222222222',
  sessionId: '11111111-1111-4111-8111-111111111111',
  connection: {
    connectionId: '33333333-3333-4333-8333-333333333333',
    generation: 7,
    instanceId: '44444444-4444-4444-8444-444444444444',
    leaseToken: '55555555-5555-4555-8555-555555555555',
  },
  orgId: '66666666-6666-4666-8666-666666666666',
  userId: '77777777-7777-4777-8777-777777777777',
  deviceId: '88888888-8888-4888-8888-888888888888',
  reason: 'client_close',
  terminalStatus: 'disconnected',
  endedAt: '2026-07-25T12:00:10.000Z',
  startedAt: '2026-07-25T12:00:00.000Z',
  inputEvents: 4,
  frameBytes: 1024,
};

describe('finalizeDesktopSessionOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.stopProof = {
      state: 'confirmed',
      commandId: input.finalizationId,
      outcome: 'stopped',
    };
    state.updatedRows = [{ id: input.sessionId }];
    state.auditFailure = null;
    state.inSystemTransaction = false;
    state.updateValues = null;
    state.auditValues = [];
    state.sessionRows = [{ status: 'active' }];
    state.commandRows = [];

    ensureDesktopStreamStoppedMock.mockImplementation(async () => state.stopProof);
    revokeViewerSessionMock.mockResolvedValue(undefined);
    updateReturningMock.mockImplementation(async () => state.updatedRows);
    auditValuesMock.mockImplementation(async (values: Record<string, unknown>) => {
      expect(state.inSystemTransaction).toBe(true);
      state.auditValues.push(values);
      if (state.auditFailure) throw state.auditFailure;
    });
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      expect(state.inSystemTransaction).toBe(false);
      state.inSystemTransaction = true;
      try {
        return await fn();
      } finally {
        state.inSystemTransaction = false;
      }
    });
    observeDesktopFinalizationMock.mockResolvedValue({
      ownerPresent: false,
      finalizationId: input.finalizationId,
      canonicalPayload: JSON.stringify(input),
      consistent: true,
    });
    getDesktopSessionFinalizationJobStateMock.mockResolvedValue(null);
  });

  it('returns stop_pending with no revocation, database update, or summary audit', async () => {
    ensureDesktopStreamStoppedMock.mockResolvedValue({
      state: 'pending',
      commandId: input.finalizationId,
      reason: 'agent_disconnected',
    });

    await expect(finalizeDesktopSessionOnce(input)).resolves.toBe('stop_pending');

    expect(revokeViewerSessionMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(auditValuesMock).not.toHaveBeenCalled();
  });

  it('updates the session and inserts the summary audit in one system transaction', async () => {
    await expect(finalizeDesktopSessionOnce({
      ...input,
      inputEvents: -9,
      frameBytes: -100,
    })).resolves.toBe('finalized');

    expect(ensureDesktopStreamStoppedMock).toHaveBeenCalledTimes(1);
    expect(revokeViewerSessionMock).toHaveBeenCalledWith(input.sessionId);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(state.updateValues).toMatchObject({
      status: 'disconnected',
      durationSeconds: 10,
    });
    expect(state.auditValues).toHaveLength(1);
    expect(state.auditValues[0]).toMatchObject({
      action: 'desktop.session.summary',
      orgId: input.orgId,
      actorId: input.userId,
      result: 'success',
      details: expect.objectContaining({
        inputEvents: 0,
        frameBytes: 0,
        durationSeconds: 10,
        stopCommandId: input.finalizationId,
        stopOutcome: 'stopped',
      }),
    });
  });

  it('returns already_finalized and does not audit when UPDATE RETURNING yields no row', async () => {
    state.updatedRows = [];

    await expect(finalizeDesktopSessionOnce(input)).resolves.toBe('already_finalized');

    expect(auditValuesMock).not.toHaveBeenCalled();
  });

  it('propagates an audit failure so the enclosing transaction rolls back', async () => {
    state.auditFailure = new Error('audit insert failed');

    await expect(finalizeDesktopSessionOnce(input)).rejects.toThrow('audit insert failed');
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(state.auditValues).toHaveLength(1);
  });

  it('rejects invalid timestamps before any side effect', async () => {
    expect(() => desktopSessionFinalizationInputSchema.parse({
      ...input,
      startedAt: 'not-an-iso-timestamp',
    })).toThrow();

    await expect(finalizeDesktopSessionOnce({
      ...input,
      startedAt: 'not-an-iso-timestamp',
    })).rejects.toThrow();
    expect(ensureDesktopStreamStoppedMock).not.toHaveBeenCalled();
    expect(revokeViewerSessionMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });
});

describe('inspectDesktopFinalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.inSystemTransaction = false;
    state.sessionRows = [{ status: 'active' }];
    state.commandRows = [];
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      expect(state.inSystemTransaction).toBe(false);
      state.inSystemTransaction = true;
      try {
        return await fn();
      } finally {
        state.inSystemTransaction = false;
      }
    });
    observeDesktopFinalizationMock.mockResolvedValue({
      ownerPresent: false,
      finalizationId: input.finalizationId,
      canonicalPayload: JSON.stringify(input),
      consistent: true,
    });
    getDesktopSessionFinalizationJobStateMock.mockResolvedValue(null);
  });

  it('reports confirmed only for a result bound to the exact session and finalization IDs', async () => {
    state.commandRows = [{
      status: 'completed',
      result: {
        status: 'completed',
        stdout: JSON.stringify({
          sessionId: '99999999-9999-4999-8999-999999999999',
          finalizationId: input.finalizationId,
          outcome: 'stopped',
        }),
      },
    }];

    await expect(inspectDesktopFinalization(input.sessionId)).resolves.toMatchObject({
      state: 'persisted',
      stopState: 'pending',
    });
  });
});
