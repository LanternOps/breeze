/**
 * #4248 W03 (Task 9) — pins the report worker's exclusion of the
 * system-managed report types. The narrative's delivery is
 * `report_run_deliveries` + `reportNarrativeDelivery.ts`, never this worker;
 * if the exclusion ever loosened, the worker would generate a second, empty
 * "narrative" run and email it to `report_schedule_recipients` nobody can add.
 *
 * Source-text assertions on purpose: the worker's own unit suite mocks the
 * predicate away, so only the text can prove BOTH enforcement sites exist.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn(); close = vi.fn(); },
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));
vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn() }));
vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn(() => false), getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../config/env', () => ({ breezeRole: () => 'all' }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { WORKER_EXCLUDED_REPORT_TYPES } from './reportScheduleWorker';
import { INTERNAL_REPORT_TYPES } from '../routes/reports/schemas';

describe('report worker exclusion of system-managed report types (#4248 W03)', () => {
  it('the report worker still excludes the AI narrative', () => {
    expect([...WORKER_EXCLUDED_REPORT_TYPES]).toContain('ai_org_narrative');
  });

  it('the exclusion list and the route-side INTERNAL_REPORT_TYPES name the same types', () => {
    // The recipient writers refuse on INTERNAL_REPORT_TYPES; the worker skips
    // on WORKER_EXCLUDED_REPORT_TYPES. A type in one but not the other is a
    // definition that is either silently never delivered or delivered twice.
    expect(new Set(WORKER_EXCLUDED_REPORT_TYPES)).toEqual(INTERNAL_REPORT_TYPES);
  });

  it('the exclusion is enforced in BOTH places, not just findDueReports', () => {
    const src = readFileSync(path.join(__dirname, 'reportScheduleWorker.ts'), 'utf8');
    const uses = src.match(/WORKER_EXCLUDED_REPORT_TYPES/g) ?? [];
    expect(uses.length, 'expected the definition plus findDueReports and processRunScheduledReport')
      .toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/notInArray\(reports\.type, \[\.\.\.WORKER_EXCLUDED_REPORT_TYPES\]\)/);
    expect(src).toMatch(/WORKER_EXCLUDED_REPORT_TYPES as readonly string\[\]\)\.includes\(report\.type\)/);
  });
});
