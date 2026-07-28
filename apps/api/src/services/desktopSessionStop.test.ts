import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  insertedValues: null as Record<string, unknown> | null,
}));
const rearmMock = vi.hoisted(() => vi.fn());
const selectLimitMock = vi.hoisted(() => vi.fn());
const withSystemMock = vi.hoisted(() => vi.fn());

vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'device_commands.id',
  },
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: withSystemMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        commandState.insertedValues = values;
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: selectLimitMock,
        })),
      })),
    })),
  },
}));

vi.mock('./commandQueue', () => ({
  rearmIdempotentCommandForDelivery: rearmMock,
}));

import {
  ensureDesktopStreamStopped,
  type DesktopStopProof,
} from './desktopSessionStop';
import type { DesktopSessionFinalizationInput } from './desktopSessionFinalization';

const input: DesktopSessionFinalizationInput = {
  version: 1,
  finalizationId: '22222222-2222-4222-8222-222222222222',
  sessionId: '11111111-1111-4111-8111-111111111111',
  connection: {
    connectionId: '33333333-3333-4333-8333-333333333333',
    generation: 1,
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
  inputEvents: 1,
  frameBytes: 2,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: input.finalizationId,
    deviceId: input.deviceId,
    type: 'desktop_stream_stop',
    payload: {
      sessionId: input.sessionId,
      finalizationId: input.finalizationId,
    },
    status: 'pending',
    targetRole: 'agent',
    result: null,
    ...overrides,
  };
}

describe('ensureDesktopStreamStopped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commandState.rows = [row()];
    commandState.insertedValues = null;
    selectLimitMock.mockImplementation(async () => commandState.rows);
    withSystemMock.mockImplementation(async (fn: () => Promise<unknown>) => fn());
    rearmMock.mockResolvedValue({ delivered: false, reason: 'agent_disconnected' });
  });

  it('creates or reuses the finalization UUID as the exact durable command identity', async () => {
    const proof = await ensureDesktopStreamStopped(input);

    expect(commandState.insertedValues).toMatchObject({
      id: input.finalizationId,
      deviceId: input.deviceId,
      type: 'desktop_stream_stop',
      status: 'pending',
      payload: {
        sessionId: input.sessionId,
        finalizationId: input.finalizationId,
      },
    });
    expect(rearmMock).toHaveBeenCalledWith({
      commandId: input.finalizationId,
      deviceId: input.deviceId,
      type: 'desktop_stream_stop',
      payload: {
        sessionId: input.sessionId,
        finalizationId: input.finalizationId,
      },
    });
    expect(proof).toEqual<DesktopStopProof>({
      state: 'pending',
      commandId: input.finalizationId,
      reason: 'agent_disconnected',
    });
  });

  it('accepts only an exact completed stopped/already_absent result as proof', async () => {
    for (const outcome of ['stopped', 'already_absent'] as const) {
      commandState.rows = [row({
        status: 'completed',
        result: {
          status: 'completed',
          stdout: JSON.stringify({
            sessionId: input.sessionId,
            finalizationId: input.finalizationId,
            outcome,
          }),
        },
      })];

      await expect(ensureDesktopStreamStopped(input)).resolves.toEqual({
        state: 'confirmed',
        commandId: input.finalizationId,
        outcome,
      });
    }
    expect(rearmMock).not.toHaveBeenCalled();
  });

  it.each([
    ['generic duplicate', { status: 'failed', result: { status: 'duplicate' } }],
    ['send success without result', { status: 'sent', result: null }],
    ['legacy completed stop without ID-bound proof', {
      status: 'completed',
      result: {
        status: 'completed',
        stdout: JSON.stringify({
          sessionId: input.sessionId,
          stopped: true,
        }),
      },
    }],
    ['malformed result', { status: 'completed', result: { status: 'completed', stdout: '{}' } }],
    ['wrong finalization', {
      status: 'completed',
      result: {
        status: 'completed',
        stdout: JSON.stringify({
          sessionId: input.sessionId,
          finalizationId: '99999999-9999-4999-8999-999999999999',
          outcome: 'stopped',
        }),
      },
    }],
  ])('does not treat %s as terminal-safe stop proof', async (_name, overrides) => {
    commandState.rows = [row(overrides)];

    const proof = await ensureDesktopStreamStopped(input);

    expect(proof.state).toBe('pending');
    expect(rearmMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the stable command ID belongs to different immutable fields', async () => {
    commandState.rows = [row({ deviceId: '99999999-9999-4999-8999-999999999999' })];

    await expect(ensureDesktopStreamStopped(input)).rejects.toThrow('conflict');
    expect(rearmMock).not.toHaveBeenCalled();
  });
});
