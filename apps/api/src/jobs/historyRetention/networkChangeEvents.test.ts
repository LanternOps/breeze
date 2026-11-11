import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./networkChangeEvents');

describe('network_change_events target (#4342 W5)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('has its own metric and flag, default 90 d (cap 365), report-only', async () => {
    const { NETWORK_CHANGE_EVENT_TARGETS } = await load();
    expect(NETWORK_CHANGE_EVENT_TARGETS).toHaveLength(1);
    const [e] = NETWORK_CHANGE_EVENT_TARGETS;
    expect(e!.target).toMatchObject({ table: 'network_change_events', metricName: 'network_change_event_retention', action: { kind: 'delete' } });
    expect(e!.enforceVar).toBe('NETWORK_CHANGE_EVENT_RETENTION_ENFORCE');
    expect(e!.knobs).toEqual({ retentionDays: 90, batchSize: 1000, maxBatches: 100, enforce: false });
    expect(e!.maxRetentionDays).toBe(365);
  });

  it('ages each event by its profile\'s changeRetentionDays, tolerant of junk, falling back to the job cutoff', async () => {
    const { NETWORK_CHANGE_EVENT_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toBe(
      'detected_at < COALESCE(('
      // Per-profile window, counted back from the run instant (UTC wall time).
      + `SELECT ($1::timestamptz AT TIME ZONE 'UTC') - make_interval(days => LEAST(365, GREATEST(1, (p.alert_settings->>'changeRetentionDays')::int))) `
      + 'FROM discovery_profiles p WHERE p.id = network_change_events.profile_id '
      // Only a 1-3 digit value is ever cast, so "abc", "-5", "1e9" or true can
      // never make the statement throw: those rows fall back to the job cutoff.
      + `AND p.alert_settings->>'changeRetentionDays' ~ '^[0-9]{1,3}$'`
      // No profile (profile_id NULL or the profile deleted): the job cutoff.
      + `), ($2::timestamptz AT TIME ZONE 'UTC'))`,
    );
    // The dead handler only swept profiles with alerts enabled; the target does not.
    expect(sql).not.toContain(`'enabled'`);
    expect(params).toEqual([NOW, CUTOFF]);
  });

  it('reads its default window from NETWORK_CHANGE_EVENT_RETENTION_DAYS', async () => {
    vi.stubEnv('NETWORK_CHANGE_EVENT_RETENTION_DAYS', '45');
    const { NETWORK_CHANGE_EVENT_TARGETS } = await load();
    expect(NETWORK_CHANGE_EVENT_TARGETS[0]!.knobs.retentionDays).toBe(45);
  });

  it('removes the dead prune-change-events job type from networkBaselineWorker', () => {
    const src = readFileSync(resolve(__dirname, '../networkBaselineWorker.ts'), 'utf8');
    expect(src).not.toContain('prune-change-events');
    expect(src).not.toContain('handlePruneChangeEvents');
  });
});
