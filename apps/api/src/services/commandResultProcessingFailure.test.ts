import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { updateMock, setMock, whereMock, returningMock } = vi.hoisted(() => {
  const returningMock = vi.fn();
  const whereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: whereMock }));
  const updateMock = vi.fn(() => ({ set: setMock }));
  return { updateMock, setMock, whereMock, returningMock };
});
vi.mock('../db', () => ({ db: { update: updateMock } }));

import {
  markCommandResultProcessingFailed,
  RESULT_PROCESSING_FAILED_MESSAGE,
} from './commandResultProcessingFailure';
import {
  RESULT_PROCESSING_FAILED_RESULT_STATUS,
  commandAcceptsAgentResult,
} from './commandResultAcceptance';
import { deviceCommands } from '../db/schema';

const CMD = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';

describe('markCommandResultProcessingFailed (#3530)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    returningMock.mockResolvedValue([{ id: CMD }]);
  });

  it('parks the row failed + reopenable, keeping the agent result and never raw error text', async () => {
    const at = new Date('2026-09-28T12:00:00.000Z');
    const parked = await markCommandResultProcessingFailed({
      commandId: CMD,
      deviceId: DEV,
      targetRole: 'agent',
      storedResult: { status: 'completed', exitCode: 0, stdout: 'hello', error: undefined },
      failedAt: at,
    });

    expect(parked).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(deviceCommands);
    const patch = (setMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(patch.status).toBe('failed');
    expect(patch.completedAt).toBe(at);
    const result = patch.result as Record<string, unknown>;
    expect(result).toMatchObject({
      status: RESULT_PROCESSING_FAILED_RESULT_STATUS,
      agentStatus: 'completed',
      exitCode: 0,
      stdout: 'hello',
      processingFailedAt: at.toISOString(),
      processingError: RESULT_PROCESSING_FAILED_MESSAGE,
      error: RESULT_PROCESSING_FAILED_MESSAGE,
    });
    // The row it writes is exactly the row the acceptance predicate reopens.
    expect(commandAcceptsAgentResult('failed', result, 'script')).toBe(true);
    // Payload secrets are erased like every other terminal writer.
    expect(patch.payload).toBeDefined();
  });

  it("keeps the agent's own error rather than overwriting it", async () => {
    await markCommandResultProcessingFailed({
      commandId: CMD,
      deviceId: DEV,
      targetRole: 'agent',
      storedResult: { status: 'failed', exitCode: 3, error: 'disk full' },
    });
    const result = ((setMock.mock.calls[0] as unknown[])[0] as { result: Record<string, unknown> }).result;
    expect(result.error).toBe('disk full');
    expect(result.agentStatus).toBe('failed');
    expect(result.processingError).toBe(RESULT_PROCESSING_FAILED_MESSAGE);
  });

  it('is a guarded CAS: only a row that still accepts a result is parked', async () => {
    returningMock.mockResolvedValue([]);
    const parked = await markCommandResultProcessingFailed({
      commandId: CMD,
      deviceId: DEV,
      targetRole: 'agent',
      storedResult: { status: 'completed' },
    });
    expect(parked).toBe(false);
    const where = (whereMock.mock.calls[0] as unknown[])[0] as SQL;
    const { sql: text, params } = new PgDialect().sqlToQuery(where);
    expect(params).toEqual(expect.arrayContaining([CMD, DEV, 'agent', 'pending', 'sent']));
    expect(text).toContain(`"result"->>'processingFailedAt' IS NOT NULL`);
  });
});
