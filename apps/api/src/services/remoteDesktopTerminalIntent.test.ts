/**
 * Unit coverage for the terminal-intent contract (#5534).
 *
 * The interleaving properties — a terminal committed before a start refuses
 * the start, every writer bumping the same generation against a real row,
 * pending → confirmed on the agent's stop result — live in
 * `src/__tests__/integration/remoteDesktopTerminalIntent.integration.test.ts`
 * because they need real Postgres. What is pinned here is the SHAPE of the
 * contract: the set clause every writer must use, the wire encoding of the
 * stop command, and the parse rules that decide whether a result may confirm.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SQL } from 'drizzle-orm';

const { returningMock, whereMock, setMock } = vi.hoisted(() => ({
  returningMock: vi.fn(),
  whereMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('../db', () => ({
  // No context held in a unit run: the savepoint helper just runs fn.
  withDbTransactionIfHeld: <T>(fn: () => Promise<T>) => fn(),
  db: {
    update: vi.fn(() => ({
      set: setMock.mockImplementation(() => ({
        where: whereMock.mockImplementation(() => ({ returning: returningMock })),
      })),
    })),
  },
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remoteSessions.id',
    type: 'remoteSessions.type',
    status: 'remoteSessions.status',
    deviceId: 'remoteSessions.deviceId',
    endedAt: 'remoteSessions.endedAt',
    errorMessage: 'remoteSessions.errorMessage',
    desktopStartGeneration: 'remoteSessions.desktopStartGeneration',
    terminalGeneration: 'remoteSessions.terminalGeneration',
    terminationPhase: 'remoteSessions.terminationPhase',
    endReason: 'remoteSessions.endReason',
  },
}));

import {
  __resetEndReasonFallbackWarningForTest,
  buildStopDesktopCommand,
  commitDesktopTerminalIntent,
  confirmDesktopTerminalIntent,
  parseDesktopStopCommandId,
  terminalIntentSet,
} from './remoteDesktopTerminalIntent';

/** A postgres.js CHECK violation as Drizzle wraps it (SQLSTATE on the cause). */
function checkViolation(constraint: string): Error {
  return Object.assign(new Error('Failed query: update "remote_sessions" ...'), {
    cause: Object.assign(new Error(`new row for relation "remote_sessions" violates check constraint "${constraint}"`), {
      code: '23514',
      constraint_name: constraint,
    }),
  });
}

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

function sqlText(value: unknown): string {
  if (value instanceof SQL) {
    return value.queryChunks.map(sqlText).join('');
  }
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (value && typeof value === 'object' && 'value' in value) return sqlText((value as { value: unknown }).value);
  if (value && typeof value === 'object' && 'queryChunks' in value) return sqlText((value as { queryChunks: unknown }).queryChunks);
  return String(value);
}

describe('terminalIntentSet', () => {
  it('bumps the shared generation, records it as terminal, and sets the phase — on top of the caller columns', () => {
    const endedAt = new Date('2026-09-12T00:00:00Z');
    const set = terminalIntentSet({ status: 'disconnected', endedAt, endReason: 'operator_ended' }, 'pending');

    expect(set.status).toBe('disconnected');
    expect(set.endedAt).toBe(endedAt);
    // Both expressions read the OLD generation, so they land on the same number.
    expect(sqlText(set.desktopStartGeneration)).toContain('+ 1');
    expect(sqlText(set.terminalGeneration)).toContain('+ 1');
    expect(sqlText(set.terminalGeneration)).toContain('remoteSessions.desktopStartGeneration');
    // 'pending' is only meaningful for a desktop row (there is an endpoint to
    // confirm it); every other session type is terminal the moment it commits.
    expect(sqlText(set.terminationPhase)).toMatch(/CASE WHEN .*desktop.* THEN .*pending.* ELSE .*confirmed/);
  });

  it('writes confirmed directly when the endpoint is the source of the terminal fact', () => {
    const set = terminalIntentSet({ status: 'failed', endedAt: new Date(), endReason: 'start_failed' }, 'confirmed');
    expect(set.terminationPhase).toBe('confirmed');
  });

  it('#11839: records the end reason, keeping one already on the row (first reason wins)', () => {
    const set = terminalIntentSet({ status: 'disconnected', endedAt: new Date(), endReason: 'never_connected' }, 'pending');
    const text = sqlText(set.endReason);
    // COALESCE(existing, new): an 'ended_by_user' recorded while the row was
    // still live survives the terminal write that follows it.
    expect(text).toMatch(/^COALESCE\(remoteSessions\.endReason, never_connected\)$/);
  });

  it('#11839: refuses an end reason outside the closed set (the CHECK would reject it at runtime)', () => {
    expect(() => terminalIntentSet(
      { status: 'disconnected', endedAt: new Date(), endReason: 'lease_expired' as never },
      'pending',
    )).toThrow(/end reason/i);
  });

  it('refuses a non-terminal status: the contract is for terminal writers only', () => {
    expect(() => terminalIntentSet({ status: 'active' as never, endedAt: new Date(), endReason: 'operator_ended' }, 'pending')).toThrow(/terminal/i);
  });
});

describe('buildStopDesktopCommand / parseDesktopStopCommandId', () => {
  it('binds the terminal generation into both the command id and the payload as a decimal string', () => {
    const command = buildStopDesktopCommand(SESSION_ID, 9007199254740993n);
    expect(command).toEqual({
      id: `desk-stop-${SESSION_ID}-9007199254740993`,
      type: 'stop_desktop',
      payload: { sessionId: SESSION_ID, terminalGeneration: '9007199254740993' },
    });
    expect(typeof command.payload.terminalGeneration).toBe('string');
  });

  it('round-trips the identity and never widens the generation through a Number', () => {
    const command = buildStopDesktopCommand(SESSION_ID, 9007199254740993n);
    expect(parseDesktopStopCommandId(command.id)).toEqual({
      sessionId: SESSION_ID,
      terminalGeneration: 9007199254740993n,
    });
  });

  it('fails closed on a legacy or malformed stop identity', () => {
    // Pre-W03 stop ids carried no generation: they cannot confirm anything.
    expect(parseDesktopStopCommandId(`desk-stop-${SESSION_ID}`)).toBeNull();
    expect(parseDesktopStopCommandId(`desk-stop-${SESSION_ID}-`)).toBeNull();
    expect(parseDesktopStopCommandId(`desk-stop-${SESSION_ID}-0`)).toBeNull();
    expect(parseDesktopStopCommandId(`desk-stop-${SESSION_ID}--1`)).toBeNull();
    expect(parseDesktopStopCommandId(`desk-stop-${SESSION_ID}-1e3`)).toBeNull();
    expect(parseDesktopStopCommandId(`desk-stop-${SESSION_ID}-01`)).toBeNull();
    expect(parseDesktopStopCommandId(`desk-start-${SESSION_ID}-1`)).toBeNull();
    expect(parseDesktopStopCommandId(`desk-stop-not-a-uuid-1`)).toBeNull();
  });
});

describe('commitDesktopTerminalIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    returningMock.mockResolvedValue([{ id: SESSION_ID, type: 'desktop', deviceId: DEVICE_ID, terminalGeneration: 5n, terminationPhase: 'pending', status: 'disconnected' }]);
  });

  it('commits through the shared set clause and returns the terminal generation as a bigint', async () => {
    const result = await commitDesktopTerminalIntent({
      sessionId: SESSION_ID,
      write: { status: 'disconnected', endedAt: new Date(), endReason: 'operator_ended' },
      phase: 'pending',
    });
    expect(result).toMatchObject({ ok: true, terminalGeneration: 5n, row: { id: SESSION_ID, type: 'desktop' } });
    const set = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sqlText(set.desktopStartGeneration)).toContain('+ 1');
    expect(sqlText(set.terminalGeneration)).toContain('+ 1');
  });

  it('reports not_live when no live row matched', async () => {
    returningMock.mockResolvedValue([]);
    await expect(commitDesktopTerminalIntent({
      sessionId: SESSION_ID,
      write: { status: 'disconnected', endedAt: new Date(), endReason: 'operator_ended' },
      phase: 'pending',
    })).resolves.toEqual({ ok: false, reason: 'not_live' });
  });

  it('parses a string-typed bigint from the driver', async () => {
    returningMock.mockResolvedValue([{ id: SESSION_ID, type: 'desktop', deviceId: DEVICE_ID, terminalGeneration: '9007199254740993', terminationPhase: 'pending', status: 'disconnected' }]);
    const result = await commitDesktopTerminalIntent({
      sessionId: SESSION_ID,
      write: { status: 'disconnected', endedAt: new Date(), endReason: 'operator_ended' },
      phase: 'pending',
    });
    expect(result).toMatchObject({ ok: true, terminalGeneration: 9007199254740993n });
  });
});

describe('#11839: an unmigrated end-reason CHECK never stops a session ending', () => {
  const ROW = { id: SESSION_ID, type: 'desktop', deviceId: DEVICE_ID, terminalGeneration: 5n, terminationPhase: 'pending', status: 'disconnected' };
  const WRITE = { status: 'disconnected' as const, endedAt: new Date(), endReason: 'operator_ended' as const };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetEndReasonFallbackWarningForTest();
  });

  it('retries once without the end reason when remote_sessions_end_reason_check refuses it, and warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    returningMock
      .mockRejectedValueOnce(checkViolation('remote_sessions_end_reason_check'))
      .mockResolvedValueOnce([ROW])
      .mockRejectedValueOnce(checkViolation('remote_sessions_end_reason_check'))
      .mockResolvedValueOnce([ROW]);

    const first = await commitDesktopTerminalIntent({ sessionId: SESSION_ID, write: WRITE, phase: 'pending' });
    expect(first).toMatchObject({ ok: true, terminalGeneration: 5n });
    expect(setMock).toHaveBeenCalledTimes(2);
    const labelled = setMock.mock.calls[0]![0] as Record<string, unknown>;
    const retried = setMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(sqlText(labelled.endReason)).toContain('COALESCE');
    // The retry still ends the session (same terminal columns and fence), it
    // just leaves end_reason alone.
    expect('endReason' in retried).toBe(false);
    expect(retried.status).toBe('disconnected');
    expect(sqlText(retried.terminalGeneration)).toContain('+ 1');

    await commitDesktopTerminalIntent({ sessionId: SESSION_ID, write: WRITE, phase: 'pending' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('2027-01-24-220000-remote-sessions-end-reason-widen.sql');
    // The ALS flag does not leak: a set clause built afterwards carries the reason.
    expect(terminalIntentSet(WRITE, 'pending').endReason).toBeDefined();
    warn.mockRestore();
  });

  it('does not retry a CHECK violation on any other constraint', async () => {
    returningMock.mockRejectedValueOnce(checkViolation('remote_sessions_termination_fence_check'));
    await expect(commitDesktopTerminalIntent({ sessionId: SESSION_ID, write: WRITE, phase: 'pending' }))
      .rejects.toThrow(/Failed query/);
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failure that is not a CHECK violation', async () => {
    returningMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { cause: { code: '40P01' } }));
    await expect(commitDesktopTerminalIntent({ sessionId: SESSION_ID, write: WRITE, phase: 'pending' }))
      .rejects.toThrow('boom');
    expect(setMock).toHaveBeenCalledTimes(1);
  });
});

describe('confirmDesktopTerminalIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    returningMock.mockResolvedValue([{ id: SESSION_ID }]);
  });

  it('moves pending → confirmed only for the exact terminal generation on the exact device', async () => {
    await expect(confirmDesktopTerminalIntent({
      sessionId: SESSION_ID,
      deviceId: DEVICE_ID,
      terminalGeneration: 5n,
    })).resolves.toBe('confirmed');
    expect(setMock).toHaveBeenCalledWith({ terminationPhase: 'confirmed' });
    const where = sqlText(whereMock.mock.calls[0]![0]);
    expect(where).toContain('remoteSessions.terminationPhase');
    expect(where).toContain('remoteSessions.terminalGeneration');
    expect(where).toContain('remoteSessions.deviceId');
  });

  it('reports no_match when the identity does not line up — a stale result cannot clear the intent', async () => {
    returningMock.mockResolvedValue([]);
    await expect(confirmDesktopTerminalIntent({
      sessionId: SESSION_ID,
      deviceId: DEVICE_ID,
      terminalGeneration: 4n,
    })).resolves.toBe('no_match');
  });
});
