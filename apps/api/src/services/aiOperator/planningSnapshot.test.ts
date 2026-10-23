/**
 * planningSnapshot — the frozen facts `buildPlan` reads (Recipe Library W06
 * R1a-0, plan Amendment A.4 "Seal semantics").
 *
 * The loader runs in SYSTEM scope (RLS bypassed), so its `org_id` / `task_id`
 * predicates ARE the tenant isolation. The db stub below records the WHERE
 * clause through a mocked `and`/`eq`, and every read case asserts both
 * predicates are present — not only that the stub returned a row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Cond = { op: 'eq'; col: unknown; val: unknown } | { op: 'and'; parts: Cond[] };

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  throwOnRead: null as Error | null,
  wheres: [] as unknown[],
  froms: [] as unknown[],
}));

vi.mock('drizzle-orm', async (orig) => ({
  ...(await orig<typeof import('drizzle-orm')>()),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...parts: unknown[]) => ({ op: 'and', parts }),
}));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        h.froms.push(table);
        return {
          where: (cond: unknown) => {
            h.wheres.push(cond);
            return {
              limit: async () => {
                if (h.throwOnRead) throw h.throwOnRead;
                return h.rows;
              },
            };
          },
        };
      },
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { aiOperatorTaskSteps } from '../../db/schema/aiOperatorTaskGraph';
import {
  PLANNING_SNAPSHOT_VERSION,
  loadPlanningFacts,
  sealPlanningSnapshot,
} from './planningSnapshot';

const ORG = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000a1';
const STEP_ID = '00000000-0000-4000-8000-0000000000f1';
const task = { id: TASK, orgId: ORG };
const recipe = { key: 'fixture', planningSnapshotStepKey: 'discover', steps: { discover: { kind: 'probe', phase: 'plan' } } } as never;
const noSnapshotRecipe = { key: 'fixture', steps: {} } as never;

const facts = { targets: { contactTargetId: '00000000-0000-4000-8000-0000000000c1' }, groups: ['a', 'b'], degraded: [] };
const sealed = sealPlanningSnapshot(facts, new Date('2026-10-20T09:00:00.000Z'));
const checkpoint = (ref: unknown = { stepId: STEP_ID, digest: sealed.digest }) =>
  ({ recipeInput: {}, ...(ref ? { planningSnapshot: ref } : {}) }) as never;
const stepRow = (over: Record<string, unknown> = {}) => ({
  id: STEP_ID, orgId: ORG, taskId: TASK, stepKey: 'discover', state: 'succeeded',
  checkpoint: { planningSnapshot: sealed.envelope }, ...over,
});

/** Flatten the recorded WHERE into column → value for its eq() parts. */
function predicates(cond: unknown): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>();
  const walk = (c: Cond) => {
    if (c.op === 'eq') out.set(c.col, c.val);
    else c.parts.forEach(walk);
  };
  walk(cond as Cond);
  return out;
}
function expectScopedRead(): void {
  expect(h.froms).toEqual([aiOperatorTaskSteps]);
  const p = predicates(h.wheres[0]);
  expect(p.get(aiOperatorTaskSteps.orgId)).toBe(ORG);
  expect(p.get(aiOperatorTaskSteps.taskId)).toBe(TASK);
  expect(p.get(aiOperatorTaskSteps.id)).toBe(STEP_ID);
}

beforeEach(() => {
  h.rows = []; h.throwOnRead = null; h.wheres = []; h.froms = [];
});

describe('sealPlanningSnapshot', () => {
  it('is key-order independent: {a,b} and {b,a} produce one digest', () => {
    const at = new Date('2026-10-20T09:00:00.000Z');
    const one = sealPlanningSnapshot({ a: 1, b: { x: 1, y: [2, 3] } }, at);
    const two = sealPlanningSnapshot({ b: { y: [2, 3], x: 1 }, a: 1 }, at);
    expect(one.digest).toBe(two.digest);
    expect(one.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sealPlanningSnapshot({ a: 2, b: { x: 1, y: [2, 3] } }, at).digest).not.toBe(one.digest);
  });

  it('builds a versioned envelope with an ISO capture time', () => {
    expect(sealed.envelope).toEqual({ version: PLANNING_SNAPSHOT_VERSION, capturedAt: '2026-10-20T09:00:00.000Z', facts });
  });
});

describe('loadPlanningFacts — one case per reason', () => {
  it('ok: returns the frozen facts from a settled, matching row read by (org_id, task_id, id)', async () => {
    h.rows = [stepRow()];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toEqual({ ok: true, facts });
    expectScopedRead();
  });

  it('a recipe with no snapshot step and a checkpoint with none gets {} and reads nothing', async () => {
    await expect(loadPlanningFacts(task, noSnapshotRecipe, checkpoint(null))).resolves.toEqual({ ok: true, facts: {} });
    expect(h.froms).toEqual([]);
  });

  it('snapshot_required: the recipe declares a snapshot step but the checkpoint has none', async () => {
    await expect(loadPlanningFacts(task, recipe, checkpoint(null))).resolves.toMatchObject({ ok: false, reason: 'snapshot_required' });
    expect(h.froms).toEqual([]);
  });

  it('snapshot_unexpected: the checkpoint carries a snapshot but the recipe declares no snapshot step', async () => {
    await expect(loadPlanningFacts(task, noSnapshotRecipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_unexpected' });
    expect(h.froms).toEqual([]);
  });

  it('snapshot_missing: no row matches (org_id, task_id, id) — another task or org cannot be loaded', async () => {
    h.rows = [];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_missing' });
    expectScopedRead();
  });

  it('snapshot_missing: a returned row from another task or org is refused even if the store returned it', async () => {
    h.rows = [stepRow({ taskId: '00000000-0000-4000-8000-0000000000a2' })];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_missing' });
    h.rows = [stepRow({ orgId: '00000000-0000-4000-8000-0000000000b2' })];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_missing' });
  });

  it('snapshot_wrong_step: the row is not the recipe\'s snapshot step', async () => {
    h.rows = [stepRow({ stepKey: 'review' })];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_wrong_step' });
    expectScopedRead();
  });

  it.each(['pending', 'running', 'waiting', 'failed', 'skipped'])('snapshot_not_settled: a %s row', async (state) => {
    h.rows = [stepRow({ state })];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_not_settled' });
  });

  it.each([
    ['no envelope', {}],
    ['wrong version', { planningSnapshot: { ...sealed.envelope, version: 2 } }],
    ['facts not an object', { planningSnapshot: { ...sealed.envelope, facts: [1, 2] } }],
    ['bad capturedAt', { planningSnapshot: { ...sealed.envelope, capturedAt: 'monday' } }],
    ['extra key', { planningSnapshot: { ...sealed.envelope, extra: true } }],
  ])('snapshot_malformed: %s', async (_label, rowCheckpoint) => {
    h.rows = [stepRow({ checkpoint: rowCheckpoint })];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_malformed' });
  });

  it('snapshot_digest_mismatch: the stored facts no longer hash to the checkpoint digest', async () => {
    h.rows = [stepRow({ checkpoint: { planningSnapshot: { ...sealed.envelope, facts: { ...facts, groups: ['a'] } } } })];
    await expect(loadPlanningFacts(task, recipe, checkpoint())).resolves.toMatchObject({ ok: false, reason: 'snapshot_digest_mismatch' });
    h.rows = [stepRow()];
    await expect(loadPlanningFacts(task, recipe, checkpoint({ stepId: STEP_ID, digest: 'f'.repeat(64) })))
      .resolves.toMatchObject({ ok: false, reason: 'snapshot_digest_mismatch' });
  });

  it('an I/O error propagates (the wake retries); it is never a settled reason', async () => {
    h.throwOnRead = new Error('pool timeout');
    await expect(loadPlanningFacts(task, recipe, checkpoint())).rejects.toThrow('pool timeout');
  });
});
