import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./accessHistory');

describe('access history targets (#4342 W5)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('exposes five targets in a fixed order with their defaults, report-only', async () => {
    const { ACCESS_HISTORY_TARGETS } = await load();
    expect(ACCESS_HISTORY_TARGETS.map((e) => [e.target.table, e.target.metricName, e.enforceVar, e.knobs.retentionDays, e.maxRetentionDays])).toEqual([
      ['user_notifications', 'user_notification_read_retention', 'USER_NOTIFICATION_READ_RETENTION_ENFORCE', 90, 365],
      ['user_notifications', 'user_notification_retention', 'USER_NOTIFICATION_RETENTION_ENFORCE', 365, 1095],
      ['remote_sessions', 'remote_session_retention', 'REMOTE_SESSION_RETENTION_ENFORCE', 365, 1095],
      ['support_sessions', 'support_session_retention', 'SUPPORT_SESSION_RETENTION_ENFORCE', 365, 1095],
      ['sessions', 'auth_session_retention', 'AUTH_SESSION_RETENTION_ENFORCE', 30, 365],
    ]);
    for (const e of ACCESS_HISTORY_TARGETS) {
      expect(e.target.action).toEqual({ kind: 'delete' });
      expect(e.knobs).toMatchObject({ batchSize: 1000, maxBatches: 100, enforce: false });
    }
  });

  it('read notifications age by read_at', async () => {
    const { USER_NOTIFICATION_READ_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^read = true AND read_at < \(/);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(params).toEqual([CUTOFF]);
  });

  it('every notification ages by created_at, except an unread approval', async () => {
    const { USER_NOTIFICATION_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^created_at < \(/);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(sql).toContain(`NOT (type = 'approval' AND read = false)`);
    expect(params).toEqual([CUTOFF]);
  });

  it('remote_sessions: ended sessions only', async () => {
    const { REMOTE_SESSION_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^status IN \('disconnected', 'failed', 'denied'\) AND COALESCE\(ended_at, created_at\) < \(/);
    expect(sql).not.toMatch(/'pending'|'connecting'|'active'/);
    expect(sql).toContain(`::timestamptz AT TIME ZONE 'UTC'`);
    expect(params).toEqual([CUTOFF]);
  });

  it('support_sessions: ended or expired, compared as timestamptz (the columns carry a zone)', async () => {
    const { SUPPORT_SESSION_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe(`status IN ('ended', 'expired') AND COALESCE(ended_at, created_at) < $1::timestamptz`);
    expect(sql).not.toContain('AT TIME ZONE');
    expect(params).toEqual([CUTOFF]);
  });

  it('auth sessions: created before the window AND already expired at the run instant', async () => {
    const { AUTH_SESSION_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe(`created_at < ($1::timestamptz AT TIME ZONE 'UTC') AND expires_at < ($2::timestamptz AT TIME ZONE 'UTC')`);
    expect(params).toEqual([CUTOFF, NOW]);
  });

  it('auth sessions floor at the user-risk lookback, with a warning', async () => {
    const { USER_RISK_SESSION_LOOKBACK_DAYS } = await import('../../services/userRiskScoring');
    expect(USER_RISK_SESSION_LOOKBACK_DAYS).toBe(30);
    vi.stubEnv('AUTH_SESSION_RETENTION_DAYS', '7');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ACCESS_HISTORY_TARGETS } = await load();
    expect(ACCESS_HISTORY_TARGETS.find((e) => e.target.table === 'sessions')!.knobs.retentionDays).toBe(30);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AUTH_SESSION_RETENTION_DAYS'));
  });

  it('caps the read-notification window at 365', async () => {
    vi.stubEnv('USER_NOTIFICATION_READ_RETENTION_DAYS', '400');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ACCESS_HISTORY_TARGETS: [read] } = await load();
    expect(read!.knobs.retentionDays).toBe(365);
  });
});
