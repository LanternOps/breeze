import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_AGENT_RUN_STATUSES } from '@breeze/shared';

import { CUTOFF, NOW, render } from './testHelpers';

vi.mock('../../db', async () => (await import('./testHelpers')).dbMock());
vi.mock('../../services/sentry', async () => (await import('./testHelpers')).sentryMock());

const load = () => import('./aiAgentRuns');

describe('ai_agent_runs target (#4342 W5)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('has its own metric and flag, default 400 d (cap 1095), report-only', async () => {
    const { AI_AGENT_RUN_TARGETS } = await load();
    expect(AI_AGENT_RUN_TARGETS).toHaveLength(1);
    const [e] = AI_AGENT_RUN_TARGETS;
    expect(e!.target).toMatchObject({ table: 'ai_agent_runs', metricName: 'ai_agent_run_retention', action: { kind: 'delete' } });
    expect(e!.enforceVar).toBe('AI_AGENT_RUN_RETENTION_ENFORCE');
    expect(e!.knobs).toEqual({ retentionDays: 400, batchSize: 1000, maxBatches: 100, enforce: false });
    expect(e!.maxRetentionDays).toBe(1095);
  });

  it('the terminal list is every shared status except the three live ones', async () => {
    const { AI_AGENT_RUN_TERMINAL_STATUSES } = await load();
    const live = AI_AGENT_RUN_STATUSES.filter((s) => !(AI_AGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(s));
    expect(live.sort()).toEqual(['awaiting_approval', 'queued', 'running']);
  });

  it('renders terminal + finished_at (timestamptz) + the four exclusion guards on their FK columns', async () => {
    const { AI_AGENT_RUN_RETENTION_TARGET: t } = await load();
    const { sql, params } = render(t.where(CUTOFF, NOW));
    expect(sql).toMatch(/^status IN \('completed', 'failed', 'cancelled', 'expired', 'skipped', 'blocked'\) AND finished_at < \$1::timestamptz AND /);
    expect(sql).not.toMatch(/'queued'|'running'|'awaiting_approval'/);
    expect(sql).not.toContain('AT TIME ZONE');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM action_intents i WHERE i.requesting_agent_run_id = ai_agent_runs.id AND i.org_id = ai_agent_runs.org_id)');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM ticket_drafts d WHERE d.run_id = ai_agent_runs.id AND d.org_id = ai_agent_runs.org_id)');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM ai_run_artifacts ra WHERE ra.run_id = ai_agent_runs.id AND ra.org_id = ai_agent_runs.org_id)');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM ai_run_workspaces rw WHERE rw.run_id = ai_agent_runs.id AND rw.org_id = ai_agent_runs.org_id)');
    expect(params).toEqual([CUTOFF]);
  });

  it('enforces only on an explicit true', async () => {
    vi.stubEnv('AI_AGENT_RUN_RETENTION_ENFORCE', 'true');
    vi.stubEnv('AI_AGENT_RUN_RETENTION_DAYS', '500');
    const { AI_AGENT_RUN_TARGETS: [e] } = await load();
    expect(e!.knobs).toMatchObject({ retentionDays: 500, enforce: true });
  });
});
