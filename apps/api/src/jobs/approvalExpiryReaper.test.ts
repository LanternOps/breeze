import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, updateMock, aiToolExecutionsTable } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  updateMock: vi.fn(),
  aiToolExecutionsTable: {
    id: 'ai_tool_executions.id',
    status: 'ai_tool_executions.status',
    completedAt: 'ai_tool_executions.completed_at',
    errorMessage: 'ai_tool_executions.error_message',
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../db/schema/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema/ai')>();
  return {
    ...actual,
    aiToolExecutions: aiToolExecutionsTable,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { reapExpiredApprovals } from './approvalExpiryReaper';
import { writeAuditEvent } from '../services/auditEvents';

function makeUpdateChain(returningValue: unknown[] = []) {
  const where = vi.fn(() => Promise.resolve(returningValue));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

describe('approvalExpiryReaper.reapExpiredApprovals', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('transitions rows whose expires_at is in the past to expired', async () => {
    const past = new Date(Date.now() - 60_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'approval-1',
          user_id: 'user-1',
          execution_id: null,
          action_label: 'Run risky tool',
          action_tool_name: 'breeze.runScript',
          risk_tier: 'high',
          requesting_client_label: 'Claude Desktop',
          expires_at: past,
        },
      ],
    });

    const reaped = await reapExpiredApprovals();

    expect(reaped).toBe(1);
    // The single SQL UPDATE was issued
    expect(executeMock).toHaveBeenCalledTimes(1);
    // No execution_id → no aiToolExecutions update
    expect(updateMock).not.toHaveBeenCalled();
    // Audit emitted with the expected action name
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'security.approval.expired',
        resourceType: 'approval_request',
        resourceId: 'approval-1',
        actorType: 'system',
        result: 'success',
      }),
    );
  });

  it('leaves future-expiring rows alone (returns 0 when nothing matches)', async () => {
    // Empty result set simulates the SQL filter excluding rows whose
    // expires_at is still in the future.
    executeMock.mockResolvedValueOnce({ rows: [] });

    const reaped = await reapExpiredApprovals();

    expect(reaped).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(updateMock).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('mirrors linked ai_tool_executions to rejected when execution_id is set', async () => {
    const past = new Date(Date.now() - 5_000);
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'approval-2',
          user_id: 'user-2',
          execution_id: 'exec-2',
          action_label: 'Tool',
          action_tool_name: 'breeze.x',
          risk_tier: 'critical',
          requesting_client_label: 'Helper',
          expires_at: past,
        },
        {
          id: 'approval-3',
          user_id: 'user-3',
          execution_id: 'exec-3',
          action_label: 'Tool',
          action_tool_name: 'breeze.y',
          risk_tier: 'medium',
          requesting_client_label: 'Helper',
          expires_at: past,
        },
        {
          id: 'approval-4',
          user_id: 'user-4',
          execution_id: null,
          action_label: 'Tool',
          action_tool_name: 'breeze.z',
          risk_tier: 'low',
          requesting_client_label: 'Helper',
          expires_at: past,
        },
      ],
    });

    const aiToolChain = makeUpdateChain([]);
    updateMock.mockImplementation((table: unknown) => {
      if (table === aiToolExecutionsTable) {
        return { set: aiToolChain.set };
      }
      throw new Error(`Unexpected table update: ${String(table)}`);
    });

    const reaped = await reapExpiredApprovals();

    expect(reaped).toBe(3);
    // ai_tool_executions update was issued exactly once for the two
    // approvals that had a non-null execution_id (single batched UPDATE).
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(aiToolExecutionsTable);
    expect(aiToolChain.set).toHaveBeenCalledTimes(1);
    const firstCall = aiToolChain.set.mock.calls[0] as unknown as unknown[];
    const setArg = firstCall[0] as Record<string, unknown>;
    expect(setArg.status).toBe('rejected');
    expect(setArg.errorMessage).toBe('Approval request expired');
    // Audit row per transitioned approval (3 total)
    expect(writeAuditEvent).toHaveBeenCalledTimes(3);
  });
});
