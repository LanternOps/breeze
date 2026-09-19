/**
 * Unit coverage for the parts of the start-intent service that are NOT about
 * interleaving — the ordering properties live in
 * `src/__tests__/integration/remoteDesktopStartFence.integration.test.ts`,
 * because a mocked Drizzle cannot hold a row lock.
 *
 * What is worth pinning here is the context requirement. The FOR UPDATE lock
 * and the generation bump are atomic ONLY because an outer db access context
 * has a transaction open; without one they would be two autocommit statements
 * and the lock would be released between them — a silent correctness hole with
 * no symptom until two sessions race in production. So the absence of a context
 * must be a throw, and that is asserted here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { hasDbAccessContextMock, forUpdateMock, returningMock } = vi.hoisted(() => ({
  hasDbAccessContextMock: vi.fn(() => true),
  forUpdateMock: vi.fn(),
  returningMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ for: forUpdateMock })),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: returningMock })),
      })),
    })),
  },
  hasDbAccessContext: hasDbAccessContextMock,
}));

vi.mock('../db/schema', () => ({
  remoteSessions: {
    id: 'remoteSessions.id',
    status: 'remoteSessions.status',
    webrtcOffer: 'remoteSessions.webrtcOffer',
    webrtcAnswer: 'remoteSessions.webrtcAnswer',
    endedAt: 'remoteSessions.endedAt',
    startedAt: 'remoteSessions.startedAt',
    desktopStartCommandId: 'remoteSessions.desktopStartCommandId',
    desktopPromptMode: 'remoteSessions.desktopPromptMode',
    desktopStartGeneration: 'remoteSessions.desktopStartGeneration',
    terminalGeneration: 'remoteSessions.terminalGeneration',
    terminationPhase: 'remoteSessions.terminationPhase',
  },
}));

import {
  commitDesktopStartIntent,
  commitDesktopStreamStartIntent,
  formatDesktopGeneration,
} from './remoteDesktopStartIntent';

const INPUT = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  startCommandId: 'desk-start-11111111-1111-4111-8111-111111111111-22222222-2222-4222-8222-222222222222',
  promptMode: 'off' as const,
  offer: 'v=0\r\n',
};

describe('remoteDesktopStartIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasDbAccessContextMock.mockReturnValue(true);
    forUpdateMock.mockResolvedValue([{ status: 'pending', terminationPhase: 'none', generation: 0n }]);
    returningMock.mockResolvedValue([{ generation: 1n }]);
  });

  it('refuses to run without an open db access context rather than downgrading the row lock', async () => {
    hasDbAccessContextMock.mockReturnValue(false);

    await expect(commitDesktopStartIntent(INPUT)).rejects.toThrow(/db access context/i);
    await expect(commitDesktopStreamStartIntent(INPUT.sessionId)).rejects.toThrow(/db access context/i);
    expect(forUpdateMock).not.toHaveBeenCalled();
  });

  it('takes the row lock before writing', async () => {
    await commitDesktopStartIntent(INPUT);
    expect(forUpdateMock).toHaveBeenCalledWith('update');
  });

  it('reports a terminal session as terminal, not as a generic state change', async () => {
    forUpdateMock.mockResolvedValue([
      // Status still live — the phase is the only signal, and it must win.
      { status: 'connecting', terminationPhase: 'pending', generation: 4n },
    ]);

    await expect(commitDesktopStartIntent(INPUT)).resolves.toEqual({ ok: false, reason: 'terminal' });
    await expect(commitDesktopStreamStartIntent(INPUT.sessionId)).resolves.toEqual({
      ok: false,
      reason: 'terminal',
    });
    expect(returningMock).not.toHaveBeenCalled();
  });

  it('refuses a start from a status outside the live set', async () => {
    forUpdateMock.mockResolvedValue([{ status: 'failed', terminationPhase: 'none', generation: 2n }]);
    await expect(commitDesktopStartIntent(INPUT)).resolves.toEqual({
      ok: false,
      reason: 'state_changed',
    });

    // The WS fallback is stricter still: it activates, so 'active' is not a
    // status it may start from.
    forUpdateMock.mockResolvedValue([{ status: 'active', terminationPhase: 'none', generation: 2n }]);
    await expect(commitDesktopStreamStartIntent(INPUT.sessionId)).resolves.toEqual({
      ok: false,
      reason: 'state_changed',
    });
  });

  it('reports a missing session as not_found', async () => {
    forUpdateMock.mockResolvedValue([]);
    await expect(commitDesktopStartIntent(INPUT)).resolves.toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports state_changed when the guarded UPDATE matches no row', async () => {
    returningMock.mockResolvedValue([]);
    await expect(commitDesktopStartIntent(INPUT)).resolves.toEqual({
      ok: false,
      reason: 'state_changed',
    });
  });

  it('returns the committed generation as a bigint and formats it as a decimal string', async () => {
    returningMock.mockResolvedValue([{ generation: '9007199254740993' }]);
    const result = await commitDesktopStartIntent(INPUT);
    expect(result).toEqual({ ok: true, generation: 9007199254740993n, previousStatus: 'pending' });
    expect(formatDesktopGeneration(9007199254740993n)).toBe('9007199254740993');
  });
});
