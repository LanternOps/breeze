/**
 * Unit coverage for the terminal-intent contract (SEC-038 W03, #5534).
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
  },
}));

import {
  buildStopDesktopCommand,
  commitDesktopTerminalIntent,
  confirmDesktopTerminalIntent,
  parseDesktopStopCommandId,
  terminalIntentSet,
} from './remoteDesktopTerminalIntent';

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
    const set = terminalIntentSet({ status: 'disconnected', endedAt }, 'pending');

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
    const set = terminalIntentSet({ status: 'failed', endedAt: new Date() }, 'confirmed');
    expect(set.terminationPhase).toBe('confirmed');
  });

  it('refuses a non-terminal status: the contract is for terminal writers only', () => {
    expect(() => terminalIntentSet({ status: 'active' as never, endedAt: new Date() }, 'pending')).toThrow(/terminal/i);
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
      write: { status: 'disconnected', endedAt: new Date() },
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
      write: { status: 'disconnected', endedAt: new Date() },
      phase: 'pending',
    })).resolves.toEqual({ ok: false, reason: 'not_live' });
  });

  it('parses a string-typed bigint from the driver', async () => {
    returningMock.mockResolvedValue([{ id: SESSION_ID, type: 'desktop', deviceId: DEVICE_ID, terminalGeneration: '9007199254740993', terminationPhase: 'pending', status: 'disconnected' }]);
    const result = await commitDesktopTerminalIntent({
      sessionId: SESSION_ID,
      write: { status: 'disconnected', endedAt: new Date() },
      phase: 'pending',
    });
    expect(result).toMatchObject({ ok: true, terminalGeneration: 9007199254740993n });
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
