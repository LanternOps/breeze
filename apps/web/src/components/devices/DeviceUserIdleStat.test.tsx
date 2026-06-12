import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DeviceUserIdleStat, { selectIdleSession, formatIdle, type ActiveSession } from './DeviceUserIdleStat';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '../../stores/auth';

function session(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    id: 's-1',
    username: 'alice',
    sessionType: 'console',
    osSessionId: '2',
    loginAt: '2026-06-11T08:00:00Z',
    idleMinutes: null,
    activityState: 'active',
    lastActivityAt: null,
    updatedAt: '2026-06-11T12:00:00Z',
    ...overrides,
  };
}

describe('selectIdleSession', () => {
  it('returns null for no sessions', () => {
    expect(selectIdleSession([])).toBeNull();
  });

  it('prefers the console session over less-idle remote sessions', () => {
    const console_ = session({ id: 'c', sessionType: 'console', idleMinutes: 60 });
    const rdp = session({ id: 'r', sessionType: 'rdp', idleMinutes: 1 });
    expect(selectIdleSession([rdp, console_])?.id).toBe('c');
  });

  it('falls back to the least-idle session when no console session exists', () => {
    const a = session({ id: 'a', sessionType: 'rdp', idleMinutes: 45 });
    const b = session({ id: 'b', sessionType: 'ssh', idleMinutes: 5 });
    expect(selectIdleSession([a, b])?.id).toBe('b');
  });
});

describe('formatIdle', () => {
  it('shows em dash for no session', () => {
    expect(formatIdle(null)).toBe('—');
  });

  it('shows Locked for locked sessions regardless of idle', () => {
    expect(formatIdle(session({ activityState: 'locked', idleMinutes: 42 }))).toBe('Locked');
  });

  it('shows em dash when idle is unknown', () => {
    expect(formatIdle(session({ idleMinutes: null }))).toBe('—');
  });

  it('shows Active for under a minute', () => {
    expect(formatIdle(session({ idleMinutes: 0 }))).toBe('Active');
  });

  it('formats minutes', () => {
    expect(formatIdle(session({ idleMinutes: 23 }))).toBe('23m');
  });

  it('formats hours and minutes', () => {
    expect(formatIdle(session({ idleMinutes: 65 }))).toBe('1h 5m');
  });

  it('drops the zero-minute remainder at exact hours', () => {
    expect(formatIdle(session({ idleMinutes: 60 }))).toBe('1h');
  });
});

describe('DeviceUserIdleStat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the idle duration from the active sessions endpoint', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { activeUsers: [session({ idleMinutes: 23 })], count: 1 } }),
    } as Response);

    render(<DeviceUserIdleStat deviceId="dev-1" />);

    await waitFor(() => expect(screen.getByText('23m')).toBeTruthy());
    expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledWith('/devices/dev-1/sessions/active');
  });

  it('renders em dash when the fetch fails', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('network'));

    render(<DeviceUserIdleStat deviceId="dev-1" />);

    await waitFor(() => expect(screen.getByText('—')).toBeTruthy());
  });
});
