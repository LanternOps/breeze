import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Tool catalog W04 (#5219), Decision 6 — the four-eyes exclusions are read
 * from the run and its PINNED publication, never from the flow's current
 * state: the delegator is flow_versions.enabled_by_user_id of the run's own
 * flow_version_id (a later re-enable by someone else must not change who is
 * excluded from approving this run's intents), and null once that user is
 * deleted (the FK's ON DELETE SET NULL). The db is mocked at the module
 * boundary; the query shape (which column, which join) is asserted on the
 * builder calls, and the real-DB behaviour by intentSupervisedFourEyes.
 */
const h = vi.hoisted(() => ({
  selects: [] as Array<{ fields: Record<string, unknown>; joins: Array<{ table: unknown; on: unknown }>; where: unknown }>,
  results: [] as unknown[][],
  outsideContext: 0,
  systemLabels: [] as string[],
}));

vi.mock('../../db', () => {
  const select = (fields: Record<string, unknown>) => {
    const rec = { fields, joins: [] as Array<{ table: unknown; on: unknown }>, where: undefined as unknown };
    h.selects.push(rec);
    const chain = {
      from: () => chain,
      innerJoin: (table: unknown, on: unknown) => { rec.joins.push({ table, on }); return chain; },
      where: (w: unknown) => { rec.where = w; return chain; },
      limit: async () => h.results.shift() ?? [],
    };
    return chain;
  };
  return {
    db: { select },
    runOutsideDbContext: (fn: () => unknown) => { h.outsideContext += 1; return fn(); },
    withSystemDbAccessContext: (fn: () => unknown, label: string) => { h.systemLabels.push(label); return fn(); },
  };
});

import { loadFlowIntentPeople, loadFlowIntentRun } from './intentRun';
import { flowRuns, flowRunSteps, flowVersions } from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';

const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, ' ');

const RUN = 'bbbbbbbb-0000-4000-8000-000000000001';
const ORG = 'cccccccc-0000-4000-8000-000000000001';
const FLOW = 'eeeeeeee-0000-4000-8000-000000000001';
const PIN_DELEGATOR = '11111111-0000-4000-8000-000000000001';
const TRIGGERER = '22222222-0000-4000-8000-000000000002';

function runRow(over: Record<string, unknown> = {}) {
  return {
    runId: RUN, orgId: ORG, flowId: FLOW, status: 'awaiting_approval', chainDepth: 0,
    triggeredByUserId: TRIGGERER, delegatorUserId: PIN_DELEGATOR, flowName: 'Disk cleanup', ...over,
  };
}

beforeEach(() => {
  h.selects.length = 0;
  h.results.length = 0;
  h.outsideContext = 0;
  h.systemLabels.length = 0;
});

describe('loadFlowIntentRun', () => {
  it("reads the delegator from the run's PINNED publication, not the flow's current enabled_by", async () => {
    h.results.push([runRow()]);
    const facts = await loadFlowIntentRun(RUN);
    expect(facts).toMatchObject({ runId: RUN, delegatorUserId: PIN_DELEGATOR, triggeredByUserId: TRIGGERER, step: null });

    const q = h.selects[0]!;
    // The column, by identity: flow_versions.enabled_by_user_id, never flows.enabled_by_user_id.
    expect(q.fields.delegatorUserId).toBe(flowVersions.enabledByUserId);
    expect(q.fields.delegatorUserId).not.toBe(flows.enabledByUserId);
    expect(q.fields.triggeredByUserId).toBe(flowRuns.triggeredByUserId);
    // The publication is the run's own pinned one: joined on flow_runs.flow_version_id
    // (plus flow_id), never on the flow's live enabled_publication_seq.
    const pubJoin = q.joins.find((j) => j.table === flowVersions);
    expect(pubJoin).toBeDefined();
    const on = render(pubJoin!.on);
    expect(on).toContain('"flow_versions"."id" = "flow_runs"."flow_version_id"');
    expect(on).toContain('"flow_versions"."flow_id" = "flow_runs"."flow_id"');
    expect(on).not.toContain('enabled_publication_seq');
    expect(render(q.where)).toContain('"flow_runs"."id" = $1');
  });

  it('delegator is null once the publishing user was deleted (ON DELETE SET NULL)', async () => {
    h.results.push([runRow({ delegatorUserId: null })]);
    const facts = await loadFlowIntentRun(RUN);
    expect(facts?.delegatorUserId).toBeNull();
    expect(facts?.triggeredByUserId).toBe(TRIGGERER);
  });

  it('unknown run ⇒ null, and no step read', async () => {
    h.results.push([]);
    expect(await loadFlowIntentRun(RUN, 'step-row')).toBeNull();
    expect(h.selects).toHaveLength(1);
  });

  it('the step row is read only within this run', async () => {
    h.results.push([runRow()], [{ id: 'step-row', stepId: 'fix', status: 'running' }]);
    const facts = await loadFlowIntentRun(RUN, 'step-row');
    expect(facts?.step).toEqual({ id: 'step-row', stepId: 'fix', status: 'running' });
    expect(h.selects[1]!.fields.id).toBe(flowRunSteps.id);
    const where = render(h.selects[1]!.where);
    expect(where).toContain('"flow_run_steps"."id" = $1');
    expect(where).toContain('"flow_run_steps"."run_id" = $2');
  });

  it('a step row of another run ⇒ step null (the facts still load)', async () => {
    h.results.push([runRow()], []);
    const facts = await loadFlowIntentRun(RUN, 'other-run-step');
    expect(facts?.step).toBeNull();
    expect(facts?.runId).toBe(RUN);
  });

  it('reads in a fresh system context opened outside any ambient one', async () => {
    h.results.push([runRow()]);
    await loadFlowIntentRun(RUN);
    expect(h.outsideContext).toBe(1);
    expect(h.systemLabels).toEqual(['flows.loadFlowIntentRun']);
  });
});

describe('loadFlowIntentPeople', () => {
  it('returns exactly the two exclusions from the pinned facts', async () => {
    h.results.push([runRow()]);
    expect(await loadFlowIntentPeople(RUN)).toEqual({ delegatorUserId: PIN_DELEGATOR, triggeredByUserId: TRIGGERER });
  });

  it('deleted delegator and a schedule run ⇒ both null', async () => {
    h.results.push([runRow({ delegatorUserId: null, triggeredByUserId: null })]);
    expect(await loadFlowIntentPeople(RUN)).toEqual({ delegatorUserId: null, triggeredByUserId: null });
  });

  it('unknown run ⇒ null', async () => {
    h.results.push([]);
    expect(await loadFlowIntentPeople(RUN)).toBeNull();
  });
});
