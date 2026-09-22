// apps/api/src/services/aiAgents/fleetDesignReport.test.ts
/**
 * Fleet Designer W01 (#5651), Task 8 — the persistence of a design run's
 * outcome as a SYSTEM-authored `reports` definition + one `report_runs`
 * artifact, and the safe run-detail projection of it.
 *
 * Mock idiom copied from `narrativeReport.test.ts` (a hand-rolled `../../db`
 * double that records every builder call) plus COMPILED-SQL assertions
 * through `PgDialect`: a `.where(...)` captured as an opaque object can only
 * be substring-matched on column names, which cannot tell `eq` from a bare
 * `sql` fragment nor notice a dropped org pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DesignEvidence } from './designEvidence';
import type { FleetDesignDrift, FleetDesignOutcome } from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000b1';
const RUN_ID = '00000000-0000-4000-8000-0000000000b2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000b3';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000b4';
const REPORT_ID = '00000000-0000-4000-8000-0000000000b5';
const REPORT_RUN_ID = '00000000-0000-4000-8000-0000000000b6';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000b7';

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  selectWheres: [] as unknown[],
  selectForUpdate: [] as boolean[],
  insertValues: [] as Record<string, unknown>[],
  insertConflicts: [] as (Record<string, unknown> | undefined)[],
  insertReturningQueue: [] as (unknown[] | undefined)[],
  updateSets: [] as Record<string, unknown>[],
  updateWheres: [] as unknown[],
  updateReturningQueue: [] as (unknown[] | undefined)[],
  selectCount: 0,
  insertCount: 0,
  updateCount: 0,
  ambientContext: undefined as { scope: string } | undefined,
  /** The DB scope each statement actually ran under — proves the whole write
   *  happens inside ONE system context (= one transaction). */
  statementScopes: [] as Array<string | undefined>,
}));

function resetDbState(): void {
  state.selectQueue = [];
  state.selectWheres = [];
  state.selectForUpdate = [];
  state.insertValues = [];
  state.insertConflicts = [];
  state.insertReturningQueue = [];
  state.updateSets = [];
  state.updateWheres = [];
  state.updateReturningQueue = [];
  state.selectCount = 0;
  state.insertCount = 0;
  state.updateCount = 0;
  state.ambientContext = undefined;
  state.statementScopes = [];
}

vi.mock('../../db', () => {
  function selectBuilder() {
    state.selectCount += 1;
    let forUpdate = false;
    const builder: Record<string, unknown> = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn((w: unknown) => {
        state.selectWheres.push(w);
        return builder;
      }),
      limit: vi.fn(() => builder),
      for: vi.fn((mode: string) => {
        forUpdate = mode === 'update';
        return builder;
      }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            state.statementScopes.push(state.ambientContext?.scope);
            state.selectForUpdate.push(forUpdate);
            if (state.selectQueue.length === 0) throw new Error('no queued select rows');
            return state.selectQueue.shift();
          })
          .then(resolve, reject),
    };
    return builder;
  }

  function insertBuilder() {
    state.insertCount += 1;
    const builder: Record<string, unknown> = {
      values: vi.fn((v: Record<string, unknown>) => {
        state.insertValues.push(v);
        state.insertConflicts.push(undefined);
        return builder;
      }),
      onConflictDoNothing: vi.fn((cfg?: Record<string, unknown>) => {
        state.insertConflicts[state.insertConflicts.length - 1] = cfg ?? {};
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              state.statementScopes.push(state.ambientContext?.scope);
              return state.insertReturningQueue.shift() ?? [];
            })
            .then(resolve, reject),
      })),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            state.statementScopes.push(state.ambientContext?.scope);
            return [];
          })
          .then(resolve, reject),
    };
    return builder;
  }

  function updateBuilder() {
    state.updateCount += 1;
    const builder: Record<string, unknown> = {
      set: vi.fn((v: Record<string, unknown>) => {
        state.updateSets.push(v);
        return builder;
      }),
      where: vi.fn((w: unknown) => {
        state.updateWheres.push(w);
        return builder;
      }),
      returning: vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              state.statementScopes.push(state.ambientContext?.scope);
              return state.updateReturningQueue.shift() ?? [];
            })
            .then(resolve, reject),
      })),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            state.statementScopes.push(state.ambientContext?.scope);
            return [];
          })
          .then(resolve, reject),
    };
    return builder;
  }

  return {
    db: {
      select: vi.fn(() => selectBuilder()),
      insert: vi.fn(() => insertBuilder()),
      update: vi.fn(() => updateBuilder()),
    },
    getCurrentDbAccessContext: vi.fn(() => state.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = state.ambientContext;
      state.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        state.ambientContext = previous;
      }
    }),
  };
});

import {
  FleetDesignPersistConflictError,
  loadFleetDesignReport,
  persistFleetDesignReport,
  projectFleetDesign,
  type FleetDesignPersistInput,
} from './fleetDesignReport';
import { siteScopeFingerprint } from '../siteScope';

const dialect = new PgDialect();
function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

function evidence(overrides: Partial<DesignEvidence> = {}): DesignEvidence {
  return {
    org: { name: 'Acme Dental', partnerName: 'Northwind IT', timezone: 'Europe/Berlin', siteName: null },
    window: { start: '2026-06-14T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z' },
    devices: [{
      id: DEVICE_ID, hostname: 'FS-01', osType: 'windows', osVersion: '2022', role: 'server',
      roleSource: 'agent', lastSeenAt: '2026-09-11T00:00:00.000Z', status: 'online', siteName: 'HQ',
      groupNames: [], tags: [], customFields: '', pendingReboot: false, reliabilityScore: 0.98,
    }],
    deviceIds: new Set([DEVICE_ID]),
    devicesTotal: 1,
    devicesNotAssessed: 0,
    software: [],
    services: [],
    network: { assets: [], topology: [], baselines: 0, openChanges: [] },
    posture: [],
    health: { reliabilityWorst: [], fleetFindings: [], vulnerability: null, patching: null, backups: null, cis: null },
    configuration: { policies: [], assignments: [], alertTemplates: [] },
    automation: { playbooks: [], scripts: [] },
    logs: [],
    counts: { alerts90d: 0, tickets90d: 0, endpoints: 1 },
    precursors: {
      diskOver: 0, rebootPending: 0, rebootPendingOver: 0, patchAgeOver: 0,
      certificateExpiring: null, backupMissed: 0, serviceRestartsOver: 0,
    },
    thresholds: {
      diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2,
    },
    unavailable: [],
    truncated: false,
    approvedDesign: null,
    driftLive: null,
    ...overrides,
  };
}

function outcome(overrides: Partial<FleetDesignOutcome> = {}): FleetDesignOutcome {
  return {
    schemaVersion: 1,
    sections: {
      found: { summary: ['12 devices across 2 sites.'], findings: [] },
      functions: [{
        functionKey: 'file_server', deviceIds: [DEVICE_ID], confidence: 0.9,
        evidence: ['SMB listener'], itemRef: 'functions:file_server',
      }],
      monitoring: [{
        functionKey: 'file_server',
        watches: [{
          watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true,
          rationale: 'SMB is the function.', itemRef: 'monitoring:file_server:watch:0',
        }],
        alertRules: [{
          name: 'Disk over 85%', severity: 'high', conditions: [], cooldownMinutes: 60,
          rationale: 'Data growth is the failure mode.', action: 'none', paging: 'business_hours',
          itemRef: 'monitoring:file_server:rule:0',
        }],
      }],
      retired: [],
      automation: [],
      legacy: [],
      baseline: { notes: ['Alert rate dominated by disk warnings.'], numbers: { alertsPer100EndpointsPerMonth: 42, ticketsPerMonth: 7, precursors: [] } },
      unsure: { lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [] },
    },
    thresholds: { confidence: 0.6, precursors: { diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2 } },
    generatedAt: '2026-09-12T00:00:00.000Z',
    markdown: '## What was found\n\n- 12 devices across 2 sites.\n',
    ...overrides,
  };
}

function input(overrides: Partial<FleetDesignPersistInput> = {}): FleetDesignPersistInput {
  return {
    run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, scheduleId: SCHEDULE_ID },
    agent: { id: AGENT_ID, name: 'Fleet Designer' },
    evidence: evidence(),
    outcome: outcome(),
    ...overrides,
  };
}

/** Queues the happy-path statement results in the order the function issues
 *  them: run lock -> definition upsert -> definition read -> artifact insert
 *  -> output_url -> last_generated_at -> run CAS. */
function queueHappyPath(): void {
  state.selectQueue.push([{ id: RUN_ID, status: 'running', reportRunId: null }]);
  state.selectQueue.push([{ id: REPORT_ID }]);
  state.insertReturningQueue.push([{ id: REPORT_RUN_ID }]);
  state.updateReturningQueue.push([{ id: RUN_ID }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('persistFleetDesignReport', () => {
  it('writes the whole artifact inside ONE system DB context and returns the download path', async () => {
    queueHappyPath();

    const result = await persistFleetDesignReport(input());

    expect(result).toEqual({
      reportId: REPORT_ID,
      reportRunId: REPORT_RUN_ID,
      downloadPath: `/api/reports/runs/${REPORT_RUN_ID}/download`,
    });
    expect(state.statementScopes.length).toBeGreaterThan(0);
    expect(new Set(state.statementScopes)).toEqual(new Set(['system']));
  });

  it('locks the run row FOR UPDATE, pinned by id AND org_id', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    expect(state.selectForUpdate[0]).toBe(true);
    const where = sqlText(state.selectWheres[0]);
    expect(where).toContain('"id"');
    expect(where).toContain('"org_id"');
  });

  it('inserts the definition as a SYSTEM principal, one_time schedule, with an unrestricted fingerprint', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    const values = state.insertValues[0]!;
    expect(values).toMatchObject({
      orgId: ORG_ID,
      name: 'Fleet Design',
      type: 'ai_fleet_design',
      schedule: 'one_time',
      format: 'pdf',
      createdBy: null,
      sourceAiAgentScheduleId: SCHEDULE_ID,
      executionScopePrincipalKind: 'system',
      executionScopeKind: 'unrestricted',
      executionScopeUserId: null,
      executionScopeSiteIds: null,
      executionScopeVersion: 1,
      executionScopeFingerprint: siteScopeFingerprint({
        version: 1, kind: 'unrestricted', orgId: ORG_ID,
      }),
    });
    expect(values.config).toEqual({ source: 'ai_agent', agentId: AGENT_ID, scheduleId: SCHEDULE_ID });
  });

  it('upserts the definition against the ORG-KEYED partial unique index, not the schedule-keyed one', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    const conflict = state.insertConflicts[0];
    expect(conflict, 'the definition insert must carry ON CONFLICT DO NOTHING').toBeDefined();
    const target = (conflict!.target as Array<{ name: string }>).map((column) => column.name);
    expect(target).toEqual(['org_id']);
    // The index is partial (`WHERE type = 'ai_fleet_design'`); without the
    // matching predicate Postgres cannot infer it and raises 42P10 instead
    // of doing nothing.
    expect(sqlText(conflict!.where)).toContain('ai_fleet_design');
  });

  it('re-reads the winning definition by (org_id, type)', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    const where = sqlText(state.selectWheres[1]);
    expect(where).toContain('"org_id"');
    expect(where).toContain('"type"');
  });

  it('a manually triggered run (scheduleId null) still upserts and links normally', async () => {
    queueHappyPath();

    const result = await persistFleetDesignReport(input({ run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, scheduleId: null } }));

    expect(result.reportId).toBe(REPORT_ID);
    expect(state.insertValues[0]!.sourceAiAgentScheduleId).toBeNull();
  });

  it('stores the fleet design snapshot on the artifact — outcome, provenance, evidence flags', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    const values = state.insertValues[1]!;
    expect(values).toMatchObject({
      reportId: REPORT_ID,
      status: 'completed',
      rowCount: 0,
      executionScopePrincipalKind: 'system',
      executionScopeUserId: null,
      requestedByKind: 'system',
      requestedByUserId: null,
      requestedByPortalUserId: null,
    });
    const result = values.result as { rows: unknown[]; rowCount: number; summary: { fleetDesign: Record<string, unknown> } };
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    const fleetDesign = result.summary.fleetDesign;
    expect(fleetDesign.schemaVersion).toBe(1);
    expect(fleetDesign.outcome).toMatchObject({ schemaVersion: 1 });
    expect(fleetDesign).toMatchObject({
      orgName: 'Acme Dental',
      partnerName: 'Northwind IT',
      siteName: null,
      runId: RUN_ID,
      agentName: 'Fleet Designer',
      evidenceTruncated: false,
      devicesNotAssessed: 0,
      unavailable: [],
    });
    expect(typeof fleetDesign.generatedAt).toBe('string');
  });

  it('stores drift on the snapshot when the caller supplies one', async () => {
    queueHappyPath();
    const drift: FleetDesignDrift = {
      approvedReportRunId: RUN_ID,
      appliedAt: '2026-09-01T10:00:00.000Z',
      missing: [{ functionKey: 'file_server', kind: 'watch', name: 'LanmanServer' }],
      extra: [],
      changed: [],
    };

    await persistFleetDesignReport(input({ drift }));

    const result = state.insertValues[1]!.result as { summary: { fleetDesign: { drift: unknown } } };
    expect(result.summary.fleetDesign.drift).toEqual(drift);
  });

  it('stores drift as null on the snapshot when the caller omits it', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    const result = state.insertValues[1]!.result as { summary: { fleetDesign: { drift: unknown } } };
    expect(result.summary.fleetDesign.drift).toBeNull();
  });

  it('stamps output_url on the artifact and last_generated_at on the definition (org-pinned)', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    expect(state.updateSets[0]).toEqual({ outputUrl: `/api/reports/runs/${REPORT_RUN_ID}/download` });
    expect(state.updateSets[1]).toMatchObject({ lastGeneratedAt: expect.any(Date) });
    const definitionWhere = sqlText(state.updateWheres[1]);
    expect(definitionWhere).toContain('"id"');
    expect(definitionWhere).toContain('"org_id"');
  });

  it('links the run with a CAS pinned by org_id AND report_run_id IS NULL', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input());

    expect(state.updateSets[2]).toEqual({ reportRunId: REPORT_RUN_ID });
    const where = sqlText(state.updateWheres[2]);
    expect(where).toContain('"org_id"');
    expect(where).toContain('"report_run_id"');
    expect(where.toLowerCase()).toContain('is null');
  });

  it('rejects with a conflict — before ANY write — when the run already left `running`', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'failed', reportRunId: null }]);

    await expect(persistFleetDesignReport(input())).rejects.toBeInstanceOf(FleetDesignPersistConflictError);
    expect(state.insertCount).toBe(0);
    expect(state.updateCount).toBe(0);
  });

  it('rejects with a conflict — before ANY write — when the run already carries an artifact', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'running', reportRunId: REPORT_RUN_ID }]);

    await expect(persistFleetDesignReport(input())).rejects.toBeInstanceOf(FleetDesignPersistConflictError);
    expect(state.insertCount).toBe(0);
    expect(state.updateCount).toBe(0);
  });

  it('rejects with a conflict when the run row is not visible at all', async () => {
    state.selectQueue.push([]);

    await expect(persistFleetDesignReport(input())).rejects.toBeInstanceOf(FleetDesignPersistConflictError);
    expect(state.insertCount).toBe(0);
  });

  it('rejects with a conflict when the link CAS matches zero rows, so the transaction rolls the artifact back', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'running', reportRunId: null }]);
    state.selectQueue.push([{ id: REPORT_ID }]);
    state.insertReturningQueue.push([{ id: REPORT_RUN_ID }]);
    state.updateReturningQueue.push([]); // the CAS lost

    await expect(persistFleetDesignReport(input())).rejects.toBeInstanceOf(FleetDesignPersistConflictError);
    // The artifact WAS written before the CAS ran — the rollback is the
    // enclosing transaction's job, which is exactly why this must throw.
    expect(state.insertCount).toBe(2);
  });

  it('throws (not a conflict) when the definition upsert leaves no winner to read back', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'running', reportRunId: null }]);
    state.selectQueue.push([]);

    const error = await persistFleetDesignReport(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(FleetDesignPersistConflictError);
  });

  it('flattens a control-character-bearing org/partner name into the customer-facing snapshot', async () => {
    queueHappyPath();

    await persistFleetDesignReport(input({
      evidence: evidence({ org: { name: 'Acme\nDental  ## forged', partnerName: 'North‮wind', timezone: 'UTC', siteName: null } }),
    }));

    const result = state.insertValues[1]!.result as { summary: { fleetDesign: Record<string, unknown> } };
    expect(result.summary.fleetDesign.orgName).toBe('Acme Dental ## forged');
    expect(result.summary.fleetDesign.partnerName).toBe('North wind');
  });
});

describe('projectFleetDesign', () => {
  it('returns null for a run that produced no design', () => {
    expect(projectFleetDesign({ reportRunId: null }, {}, null)).toBeNull();
  });

  it('projects counts, the artifact linkage and evidenceTruncated off the artifact snapshot', () => {
    const dto = projectFleetDesign(
      { reportRunId: REPORT_RUN_ID },
      { fleetDesign: outcome() },
      { reportId: REPORT_ID, evidenceTruncated: true },
    );

    expect(dto).not.toBeNull();
    expect(dto!.reportRunId).toBe(REPORT_RUN_ID);
    expect(dto!.reportId).toBe(REPORT_ID);
    expect(dto!.downloadPath).toBe(`/api/reports/runs/${REPORT_RUN_ID}/download`);
    expect(dto!.generatedAt).toBe(outcome().generatedAt);
    expect(dto!.functionCount).toBe(1);
    expect(dto!.watchCount).toBe(1);
    expect(dto!.ruleCount).toBe(1);
    expect(dto!.evidenceTruncated).toBe(true);
  });

  it('defaults evidenceTruncated to false when there is no artifact yet', () => {
    const dto = projectFleetDesign({ reportRunId: null }, { fleetDesign: outcome() }, null);
    expect(dto!.evidenceTruncated).toBe(false);
  });
});

describe('loadFleetDesignReport', () => {
  const PARTNER_ID = '00000000-0000-4000-8000-0000000000c1';

  it('refuses a partner-owned row (#3198 W01) instead of coercing orgId: null into a string', async () => {
    state.selectQueue.push([{
      reportRunId: REPORT_RUN_ID,
      reportId: REPORT_ID,
      orgId: null,
      partnerId: PARTNER_ID,
      summary: outcome(),
      generatedAt: outcome().generatedAt,
    }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadFleetDesignReport(REPORT_RUN_ID, () => undefined);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing partner-owned report row'));
  });

  it('returns the artifact for an org-owned row', async () => {
    state.selectQueue.push([{
      reportRunId: REPORT_RUN_ID,
      reportId: REPORT_ID,
      orgId: ORG_ID,
      partnerId: null,
      summary: outcome(),
      generatedAt: outcome().generatedAt,
    }]);

    const result = await loadFleetDesignReport(REPORT_RUN_ID, () => undefined);

    expect(result).toEqual({
      reportRunId: REPORT_RUN_ID,
      reportId: REPORT_ID,
      orgId: ORG_ID,
      summary: outcome(),
      generatedAt: outcome().generatedAt,
    });
  });
});
