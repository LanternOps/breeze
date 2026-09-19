import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, updateWheres, updateSets, updateReturnResults, selectResults, selectWheres, selectLocks, publishEventMock } =
  vi.hoisted(() => {
    const updateWheres: unknown[] = [];
    const updateSets: Record<string, unknown>[] = [];
    const updateReturnResults: unknown[][] = [];
    const selectResults: unknown[][] = [];
    const selectWheres: unknown[] = [];
    const selectLocks: unknown[] = [];
    const dbMock = {
      select: vi.fn(() => {
        const chain: Record<string, unknown> = {};
        for (const m of ['from', 'limit']) chain[m] = () => chain;
        chain.where = (w: unknown) => { selectWheres.push(w); return chain; };
        // Record rather than swallow: `for` being an identity passthrough is
        // what let a deleted FOR UPDATE SKIP LOCKED pass green.
        chain.for = (mode: unknown, opts: unknown) => { selectLocks.push({ mode, opts }); return chain; };
        (chain as { then: unknown }).then = (res: (v: unknown) => unknown) =>
          res(selectResults.shift() ?? []);
        return chain;
      }),
      update: vi.fn(() => ({
        set: (s: Record<string, unknown>) => {
          updateSets.push(s);
          return {
            where: (w: unknown) => {
              updateWheres.push(w);
              const done = Promise.resolve(updateReturnResults.shift() ?? []);
              return Object.assign(done, { returning: () => done });
            }
          };
        }
      }))
    };
    return {
      dbMock, updateWheres, updateSets, updateReturnResults, selectResults, selectWheres, selectLocks,
      publishEventMock: vi.fn(() => Promise.resolve('evt'))
    };
  });

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...a: unknown[]) => ({ op: 'and', a }),
  or: (...a: unknown[]) => ({ op: 'or', a }),
  ne: (col: unknown, val: unknown) => ({ op: 'ne', col, val }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
  sql: Object.assign((s: unknown) => s, { raw: (s: unknown) => s })
}));

vi.mock('../db', () => ({
  db: dbMock,
  withSystemDbAccessContext: (fn: () => unknown) => fn()
}));

vi.mock('../db/schema', () => ({
  incidents: {
    id: 'incidents.id',
    status: 'incidents.status',
    severity: 'incidents.severity',
    timeline: 'incidents.timeline',
    detectedAt: 'incidents.detectedAt',
    timelineEnrichedAt: 'incidents.timelineEnrichedAt',
    escalatedAt: 'incidents.escalatedAt'
  }
}));

vi.mock('../services/eventBus', () => ({ publishEvent: publishEventMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { __testOnly } from './incidentJobs';

const STALE = {
  id: 'inc-1', orgId: 'org-1', title: 'DB down', status: 'detected',
  severity: 'p1', detectedAt: new Date('2026-08-01T00:00:00Z'), timeline: []
};

describe('incident background passes pick a winner in the database', () => {
  beforeEach(() => {
    updateWheres.length = 0;
    updateSets.length = 0;
    updateReturnResults.length = 0;
    selectResults.length = 0;
    selectWheres.length = 0;
    selectLocks.length = 0;
    publishEventMock.mockClear();
  });

  it('claims incidents for enrichment on the marker column, not by id alone', async () => {
    updateReturnResults.push([{ id: 'inc-1', status: 'detected', timeline: [] }]);

    await __testOnly.runIncidentTimelineEnrichmentPass();

    // The claim targets an id set chosen by a subquery, not a blanket update.
    expect(JSON.stringify(updateWheres[0])).toContain('inArray');
    // ...and that subquery only picks rows nobody else has claimed.
    expect(JSON.stringify(selectWheres[0])).toContain('timelineEnrichedAt');
    expect(JSON.stringify(selectWheres[0])).toContain('isNull');
    // Claiming means writing the marker in the same statement.
    expect(updateSets[0]).toHaveProperty('timelineEnrichedAt');
    // The ENTIRE cross-process safety of this claim is the row lock: the outer
    // UPDATE's where is only `id IN (subquery)` and does NOT repeat the marker
    // predicate, so without SKIP LOCKED two processes claim the same batch.
    expect(selectLocks).toEqual([{ mode: 'update', opts: { skipLocked: true } }]);
  });

  it('publishes incident.escalated only for the pass that won the swap', async () => {
    selectResults.push([STALE]);
    updateReturnResults.push([{ id: 'inc-1' }]);   // won the CAS
    updateReturnResults.push([]);                  // timeline append (no rows needed)
    await __testOnly.runIncidentSlaMonitorPass();

    selectResults.push([STALE]);
    updateReturnResults.push([]);                  // lost the CAS
    await __testOnly.runIncidentSlaMonitorPass();

    // Two passes over the same stale incident, one page to on-call.
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the page fails, so the next pass retries it', async () => {
    selectResults.push([STALE]);
    updateReturnResults.push([{ id: 'inc-1' }]);   // won the CAS
    updateReturnResults.push([]);                  // timeline append
    publishEventMock.mockRejectedValueOnce(new Error('redis down'));

    await __testOnly.runIncidentSlaMonitorPass();

    // Without the release, escalated_at stays set and NOBODY is ever paged for
    // this breach — the failure mode this codebase rates worse than a duplicate.
    const release = updateSets.at(-1) as { escalatedAt?: unknown } | undefined;
    expect(release).toHaveProperty('escalatedAt', null);
  });

  it('scopes the escalation swap to incidents not already escalated', async () => {
    selectResults.push([STALE]);
    updateReturnResults.push([{ id: 'inc-1' }]);
    updateReturnResults.push([]);

    await __testOnly.runIncidentSlaMonitorPass();

    const cas = JSON.stringify(updateWheres[0]);
    expect(cas).toContain('escalatedAt');
    expect(cas).toContain('isNull');
  });
});
