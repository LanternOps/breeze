import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./sessionExpiry');

describe('session expiry targets (#4342 W6.c, report-only)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('exposes three report-only targets in a fixed order with their defaults', async () => {
    const { SESSION_EXPIRY_TARGETS } = await load();
    expect(SESSION_EXPIRY_TARGETS.map((e) => [e.target.table, e.target.metricName, e.daysVar, e.knobs.retentionDays, e.maxRetentionDays])).toEqual([
      ['sso_sessions', 'sso_session_retention', 'SSO_SESSION_RETENTION_DAYS', 7, 365],
      ['c2c_consent_sessions', 'c2c_consent_session_retention', 'C2C_CONSENT_SESSION_RETENTION_DAYS', 7, 365],
      ['tunnel_sessions', 'tunnel_session_retention', 'TUNNEL_SESSION_RETENTION_DAYS', 365, 1095],
    ]);
    for (const e of SESSION_EXPIRY_TARGETS) {
      // No delete path and no enforce switch: the runner can only count these.
      expect(e.target.action).toEqual({ kind: 'reportOnly' });
      expect(e.knobs).toMatchObject({ batchSize: 1000, maxBatches: 100, enforce: false });
      expect(e).not.toHaveProperty('enforceVar');
    }
  });

  it('an _ENFORCE variable does not exist for them: setting one changes nothing', async () => {
    vi.stubEnv('SSO_SESSION_RETENTION_ENFORCE', 'true');
    vi.stubEnv('TUNNEL_SESSION_RETENTION_ENFORCE', '1');
    const { SESSION_EXPIRY_TARGETS } = await load();
    for (const e of SESSION_EXPIRY_TARGETS) {
      expect(e.knobs.enforce).toBe(false);
      expect(e.target.action.kind).toBe('reportOnly');
    }
  });

  it('sso_sessions: expired more than the window ago, compared as UTC wall time', async () => {
    const { SSO_SESSION_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe(`expires_at < ($1::timestamptz AT TIME ZONE 'UTC')`);
    expect(params).toEqual([CUTOFF]);
  });

  it('c2c_consent_sessions: expired more than the window ago, compared as UTC wall time', async () => {
    const { C2C_CONSENT_SESSION_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe(`expires_at < ($1::timestamptz AT TIME ZONE 'UTC')`);
    expect(params).toEqual([CUTOFF]);
  });

  it('tunnel_sessions: ended sessions only, by end time (creation when no end), as UTC wall time', async () => {
    const { TUNNEL_SESSION_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe(`status IN ('disconnected', 'failed') AND COALESCE(ended_at, created_at) < ($1::timestamptz AT TIME ZONE 'UTC')`);
    expect(sql).not.toMatch(/'pending'|'connecting'|'active'/);
    expect(params).toEqual([CUTOFF]);
  });

  it('reads each window from its own literal variable, capped at its max', async () => {
    vi.stubEnv('SSO_SESSION_RETENTION_DAYS', '2');
    vi.stubEnv('C2C_CONSENT_SESSION_RETENTION_DAYS', '900');
    vi.stubEnv('TUNNEL_SESSION_RETENTION_DAYS', '30');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { SESSION_EXPIRY_TARGETS: [sso, c2c, tunnel] } = await load();
    expect(sso!.knobs.retentionDays).toBe(2);
    expect(c2c!.knobs.retentionDays).toBe(365);
    expect(tunnel!.knobs.retentionDays).toBe(30);
  });
});
