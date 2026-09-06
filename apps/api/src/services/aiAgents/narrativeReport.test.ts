// apps/api/src/services/aiAgents/narrativeReport.test.ts
/**
 * Phase 2 wave P2-3 (weekly org narrative), Task A7 — the persistence of a
 * narrative run's outcome as a SYSTEM-authored `reports` definition + one
 * `report_runs` artifact, and the safe run-detail projection of it.
 *
 * Mock idiom is `alertVerdicts.test.ts`'s (a hand-rolled `../../db` double
 * that records every builder call) plus COMPILED-SQL assertions through
 * `PgDialect`: a `.where(...)` captured as an opaque object can only be
 * substring-matched on column names, which cannot tell `eq` from `isNull` nor
 * notice a dropped org pin — and the org pin is the whole cross-tenant story
 * for the final CAS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS,
  NARRATIVE_MARKDOWN_MAX_CHARS,
  NARRATIVE_SECTION_KEYS,
  NARRATIVE_SECTION_TITLES,
  type NarrativeOutcome,
  type NarrativeSection,
} from '@breeze/shared';

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';
const RUN_ID = '00000000-0000-4000-8000-0000000000a2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000a3';
const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000a4';
const REPORT_ID = '00000000-0000-4000-8000-0000000000a5';
const REPORT_RUN_ID = '00000000-0000-4000-8000-0000000000a6';

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
  NarrativePersistConflictError,
  persistNarrativeReport,
  projectNarrative,
  type NarrativePersistInput,
} from './narrativeReport';
import { siteScopeFingerprint } from '../siteScope';
import type { NarrativeContext } from './narrativeContext';

const dialect = new PgDialect();
function sqlText(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

function sections(): NarrativeSection[] {
  return NARRATIVE_SECTION_KEYS.map((key) => ({
    key,
    title: NARRATIVE_SECTION_TITLES[key],
    bullets: [`Something happened in ${key}.`],
  }));
}

function outcome(overrides: Partial<NarrativeOutcome> = {}): NarrativeOutcome {
  const built = sections();
  return {
    version: 1,
    headline: 'A quiet week: alert volume down, one backup still failing.',
    sections: built,
    markdown: '# stored markdown',
    ...overrides,
  };
}

/** Only the fields `persistNarrativeReport` actually reads off the context. */
function context(overrides: Partial<NarrativeContext> = {}): NarrativeContext {
  return {
    org: {
      name: 'Acme Dental', partnerName: 'Northwind IT', timezone: 'Europe/Berlin', deviceCount: 52, siteCount: 3,
    },
    period: { start: '2026-08-24T07:00:00+02:00', end: '2026-08-31T07:00:00+02:00' },
    truncated: false,
    ...overrides,
  } as unknown as NarrativeContext;
}

function input(overrides: Partial<NarrativePersistInput> = {}): NarrativePersistInput {
  return {
    run: { id: RUN_ID, orgId: ORG_ID, agentId: AGENT_ID, scheduleId: SCHEDULE_ID },
    agent: { id: AGENT_ID, name: 'Weekly Narrator' },
    occurrenceKey: '2026-08-31T07:00:00+02:00',
    context: context(),
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

describe('persistNarrativeReport', () => {
  it('writes the whole artifact inside ONE system DB context and returns the download path', async () => {
    queueHappyPath();

    const result = await persistNarrativeReport(input());

    expect(result).toEqual({
      reportId: REPORT_ID,
      reportRunId: REPORT_RUN_ID,
      downloadPath: `/api/reports/runs/${REPORT_RUN_ID}/download`,
    });
    // Every statement ran under the same system scope — a single
    // `withSystemDbAccessContext` transaction, never a second connection.
    expect(state.statementScopes.length).toBeGreaterThan(0);
    expect(new Set(state.statementScopes)).toEqual(new Set(['system']));
  });

  it('locks the run row FOR UPDATE, pinned by id AND org_id', async () => {
    queueHappyPath();

    await persistNarrativeReport(input());

    expect(state.selectForUpdate[0]).toBe(true);
    const where = sqlText(state.selectWheres[0]);
    expect(where).toContain('"id"');
    expect(where).toContain('"org_id"');
  });

  it('inserts the definition as a SYSTEM principal with the schedule identity and an unrestricted fingerprint', async () => {
    queueHappyPath();

    await persistNarrativeReport(input());

    const values = state.insertValues[0]!;
    expect(values).toMatchObject({
      orgId: ORG_ID,
      name: 'Weekly AI operations narrative',
      type: 'ai_org_narrative',
      schedule: 'weekly',
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

  it('upserts the definition against the PARTIAL unique index, not a bare column pair', async () => {
    queueHappyPath();

    await persistNarrativeReport(input());

    const conflict = state.insertConflicts[0];
    expect(conflict, 'the definition insert must carry ON CONFLICT DO NOTHING').toBeDefined();
    const target = (conflict!.target as Array<{ name: string }>).map((column) => column.name);
    expect(target).toEqual(['org_id', 'source_ai_agent_schedule_id']);
    // The index is partial (`WHERE source_ai_agent_schedule_id IS NOT NULL`);
    // without the matching predicate Postgres cannot infer it and raises
    // 42P10 instead of doing nothing.
    expect(sqlText(conflict!.where).toLowerCase()).toContain('is not null');
    expect(sqlText(conflict!.where)).toContain('"source_ai_agent_schedule_id"');
  });

  it('re-reads the winning definition by (org_id, source_ai_agent_schedule_id)', async () => {
    queueHappyPath();

    await persistNarrativeReport(input());

    const where = sqlText(state.selectWheres[1]);
    expect(where).toContain('"org_id"');
    expect(where).toContain('"source_ai_agent_schedule_id"');
  });

  it('stores the narrative snapshot on the artifact — titles, capped derived markdown, provenance', async () => {
    queueHappyPath();

    await persistNarrativeReport(input());

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
    const result = values.result as {
      rows: unknown[]; rowCount: number;
      summary: { narrative: Record<string, unknown> };
    };
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    const narrative = result.summary.narrative;
    expect(narrative.headline).toBe(outcome().headline);
    expect((narrative.sections as NarrativeSection[]).map((s) => s.title))
      .toEqual(NARRATIVE_SECTION_KEYS.map((key) => NARRATIVE_SECTION_TITLES[key]));
    expect(String(narrative.markdown).length).toBeLessThanOrEqual(NARRATIVE_MARKDOWN_MAX_CHARS);
    expect(String(narrative.markdown)).toContain('## Sweeps & fixes');
    expect(narrative).toMatchObject({
      version: 1,
      orgName: 'Acme Dental',
      partnerName: 'Northwind IT',
      periodStart: '2026-08-24T07:00:00+02:00',
      periodEnd: '2026-08-31T07:00:00+02:00',
      runId: RUN_ID,
      agentName: 'Weekly Narrator',
      contextTruncated: false,
    });
    expect(typeof narrative.generatedAt).toBe('string');
  });

  it('caps a hand-built over-long narrative rather than storing the outcome markdown verbatim', async () => {
    queueHappyPath();
    const huge: NarrativeSection[] = NARRATIVE_SECTION_KEYS.map((key) => ({
      key,
      title: NARRATIVE_SECTION_TITLES[key],
      bullets: Array.from({ length: 40 }, (_, i) => `${'x'.repeat(200)} ${key} ${i}`),
    }));

    await persistNarrativeReport(input({
      outcome: outcome({ sections: huge, markdown: 'y'.repeat(NARRATIVE_MARKDOWN_MAX_CHARS * 2) }),
    }));

    const result = state.insertValues[1]!.result as { summary: { narrative: { markdown: string } } };
    expect(result.summary.narrative.markdown.length).toBeLessThanOrEqual(NARRATIVE_MARKDOWN_MAX_CHARS);
    expect(result.summary.narrative.markdown).not.toContain('yyyy');
  });

  it('stamps output_url on the artifact and last_generated_at on the definition (org-pinned)', async () => {
    queueHappyPath();

    await persistNarrativeReport(input());

    expect(state.updateSets[0]).toEqual({ outputUrl: `/api/reports/runs/${REPORT_RUN_ID}/download` });
    expect(state.updateSets[1]).toMatchObject({ lastGeneratedAt: expect.any(Date) });
    const definitionWhere = sqlText(state.updateWheres[1]);
    expect(definitionWhere).toContain('"id"');
    expect(definitionWhere).toContain('"org_id"');
  });

  it('links the run with a CAS pinned by org_id AND report_run_id IS NULL', async () => {
    queueHappyPath();

    await persistNarrativeReport(input());

    expect(state.updateSets[2]).toEqual({ reportRunId: REPORT_RUN_ID });
    const where = sqlText(state.updateWheres[2]);
    expect(where).toContain('"org_id"');
    expect(where).toContain('"report_run_id"');
    expect(where.toLowerCase()).toContain('is null');
  });

  it('rejects with a conflict — before ANY write — when the run already left `running`', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'failed', reportRunId: null }]);

    await expect(persistNarrativeReport(input())).rejects.toBeInstanceOf(NarrativePersistConflictError);
    expect(state.insertCount).toBe(0);
    expect(state.updateCount).toBe(0);
  });

  it('rejects with a conflict — before ANY write — when the run already carries an artifact', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'running', reportRunId: REPORT_RUN_ID }]);

    await expect(persistNarrativeReport(input())).rejects.toBeInstanceOf(NarrativePersistConflictError);
    expect(state.insertCount).toBe(0);
    expect(state.updateCount).toBe(0);
  });

  it('rejects with a conflict when the run row is not visible at all', async () => {
    state.selectQueue.push([]);

    await expect(persistNarrativeReport(input())).rejects.toBeInstanceOf(NarrativePersistConflictError);
    expect(state.insertCount).toBe(0);
  });

  it('rejects with a conflict when the link CAS matches zero rows, so the transaction rolls the artifact back', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'running', reportRunId: null }]);
    state.selectQueue.push([{ id: REPORT_ID }]);
    state.insertReturningQueue.push([{ id: REPORT_RUN_ID }]);
    state.updateReturningQueue.push([]); // the CAS lost

    await expect(persistNarrativeReport(input())).rejects.toBeInstanceOf(NarrativePersistConflictError);
    // The artifact WAS written before the CAS ran — the rollback is the
    // enclosing transaction's job, which is exactly why this must throw.
    expect(state.insertCount).toBe(2);
  });

  it('throws (not a conflict) when the definition upsert leaves no winner to read back', async () => {
    state.selectQueue.push([{ id: RUN_ID, status: 'running', reportRunId: null }]);
    state.selectQueue.push([]);

    const error = await persistNarrativeReport(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NarrativePersistConflictError);
  });

  it('flattens a control-character-bearing org/partner name into the customer-facing snapshot', async () => {
    queueHappyPath();

    await persistNarrativeReport(input({
      context: context({
        org: {
          name: 'Acme\nDental  ## forged', partnerName: 'North‮wind', timezone: 'UTC',
          deviceCount: 1, siteCount: 1,
        },
      } as Partial<NarrativeContext>),
    }));

    const result = state.insertValues[1]!.result as { summary: { narrative: Record<string, unknown> } };
    expect(result.summary.narrative.orgName).toBe('Acme Dental ## forged');
    // The bidi override is replaced by a space (never deleted), exactly as
    // `flattenNarrativeLine` treats it — a silent deletion would rewrite what
    // the name says.
    expect(result.summary.narrative.partnerName).toBe('North wind');
  });
});

describe('projectNarrative', () => {
  const report = {
    reportId: REPORT_ID,
    periodStart: '2026-08-24T07:00:00+02:00',
    periodEnd: '2026-08-31T07:00:00+02:00',
    contextTruncated: false,
  };

  it('returns null for a run that produced no narrative', () => {
    expect(projectNarrative({ reportRunId: null }, {}, null)).toBeNull();
  });

  it('projects the sections and the artifact linkage', () => {
    const dto = projectNarrative({ reportRunId: REPORT_RUN_ID }, { narrative: outcome() }, report);

    expect(dto).not.toBeNull();
    expect(dto!.headline).toBe(outcome().headline);
    expect(dto!.sections.map((s) => s.key)).toEqual([...NARRATIVE_SECTION_KEYS]);
    expect(dto!.reportRunId).toBe(REPORT_RUN_ID);
    expect(dto!.reportId).toBe(REPORT_ID);
    expect(dto!.downloadPath).toBe(`/api/reports/runs/${REPORT_RUN_ID}/download`);
    expect(dto!.periodStart).toBe(report.periodStart);
    expect(dto!.periodEnd).toBe(report.periodEnd);
    expect(dto!.contextTruncated).toBe(false);
    // The derived markdown is deliberately NOT shipped (see the DTO's docstring).
    expect(JSON.stringify(dto)).not.toContain('markdown');
  });

  it('nulls the linkage for a narrative that was never materialised', () => {
    const dto = projectNarrative({ reportRunId: null }, { narrative: outcome() }, null);

    expect(dto!.reportRunId).toBeNull();
    expect(dto!.reportId).toBeNull();
    expect(dto!.downloadPath).toBeNull();
    expect(dto!.periodStart).toBeNull();
    expect(dto!.contextTruncated).toBe(false);
  });

  it('drops a section whose title or key shadows a leak tripwire', () => {
    const forged = outcome({
      sections: [
        { key: 'overview', title: 'toolOutput', bullets: ['zzz-leak-marker-zzz'] },
        { key: 'ARGS' as never, title: 'Alerts', bullets: ['41 alerts fired.'] },
        { key: 'alerts', title: 'Alerts', bullets: ['41 alerts fired.'] },
      ],
    });

    const dto = projectNarrative({ reportRunId: REPORT_RUN_ID }, { narrative: forged }, report);

    expect(dto!.sections.map((s) => s.key)).toEqual(['alerts']);
    const json = JSON.stringify(dto);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
      expect(json).not.toContain(forbidden);
    }
    expect(json).not.toContain('zzz-leak-marker-zzz');
  });

  it('flattens a bullet that tries to forge document structure', () => {
    const forged = outcome({
      sections: [{ key: 'overview', title: 'Overview', bullets: ['## Forged\nheading'] }],
    });

    const dto = projectNarrative({ reportRunId: null }, { narrative: forged }, null);

    expect(dto!.sections[0]!.bullets).toEqual(['Forged heading']);
  });

  it('tolerates a maximally-corrupt stored outcome rather than throwing inside a read route', () => {
    const dto = projectNarrative(
      { reportRunId: null },
      { narrative: { version: 1, headline: 42, sections: 'nope', markdown: null } as never },
      null,
    );

    expect(dto).not.toBeNull();
    expect(dto!.headline).toBe('');
    expect(dto!.sections).toEqual([]);
  });
});
