import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));

import {
  DESKTOP_ENDED_BY_USER_ACTION,
  USER_END_RECENT_WINDOW_MS,
  recordDesktopSessionEndedByUser,
  type DesktopUserEndDeps,
} from './desktopUserEnd';

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function deps(recorded: boolean): DesktopUserEndDeps & { markEndedByUser: ReturnType<typeof vi.fn> } {
  return { markEndedByUser: vi.fn(async () => recorded) };
}

describe('recordDesktopSessionEndedByUser (#10190 W06)', () => {
  it('uses the audit action the plan names', () => {
    expect(DESKTOP_ENDED_BY_USER_ACTION).toBe('remote.session.ended_by_user');
  });

  it('records the end reason and the audit row, bound to the reporting device', async () => {
    const d = deps(true);
    await expect(recordDesktopSessionEndedByUser({ sessionId: SESSION, deviceId: 'dev-1' }, d)).resolves.toBe('recorded');
    expect(d.markEndedByUser).toHaveBeenCalledWith({
      sessionId: SESSION,
      deviceId: 'dev-1',
      recentWindowMs: USER_END_RECENT_WINDOW_MS,
    });
  });

  it('is not_recorded when no live or just-ended session of this device matches (unknown, foreign, stale or already recorded)', async () => {
    const d = deps(false);
    await expect(recordDesktopSessionEndedByUser({ sessionId: SESSION, deviceId: 'dev-1' }, d)).resolves.toBe('not_recorded');
  });

  it('accepts a just-ended session (the peer_disconnected result can arrive first) for ten minutes', () => {
    expect(USER_END_RECENT_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});
