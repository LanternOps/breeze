/**
 * #12626: the executor's snapshot schema for a ring category rule must keep
 * every field the ring stores and the evaluator reads. zod strips undeclared
 * keys, so a missing one disables that control in patch jobs without an error.
 *
 * The first suite drives the real path: the snapshot builder, the executor's
 * parsing, `resolveApprovedPatchesForDevice`, and the evaluator. Only the
 * database and the queue are doubles.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ approvedIds: null as string[] | null, configs: [] as any[] }));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
  DelayedError: class DelayedError extends Error {},
}));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  withSystemDbAccessContextIsolated: async (fn: () => unknown) => fn(),
  withDbTransaction: async (fn: () => unknown) => fn(),
  withDbTransactionIfHeld: async (fn: () => unknown) => fn(),
}));

// Record what the real resolver approves, then hand the executor an empty list
// so the run ends on its skip branch and dispatches nothing.
vi.mock('../services/patchEligibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/patchEligibility')>();
  return {
    ...actual,
    resolveApprovedPatchesForDevice: vi.fn(async (...args: Parameters<typeof actual.resolveApprovedPatchesForDevice>) => {
      captured.configs.push(args[2]);
      captured.approvedIds = (await actual.resolveApprovedPatchesForDevice(...args)).map((p) => p.patchId);
      return [];
    }),
    areAllPendingPatchesManagedByVendorLane: vi.fn(async () => false),
  };
});

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/dispatchDeviceCommand', () => ({ dispatchDeviceCommand: vi.fn() }));

import type { z } from 'zod';
import { db } from '../db';
import { categoryRuleSchema } from '../routes/updateRings';
import { storedCategoryRuleSchema } from '../services/patchEligibility';
import type { CategoryRule } from '../services/patchApprovalEvaluator';
import { buildPatchesSnapshot } from '../services/patchJobSnapshot';
import { jobCategoryRuleSchema, __testOnly } from './patchJobExecutor';

const RING = '33333333-3333-3333-3333-333333333333';
const PARTNER = '44444444-4444-4444-4444-444444444444';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function selectResult(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'for', 'orderBy']) chain[m] = () => chain;
  chain.then = (ok: (r: unknown[]) => unknown, fail: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, fail);
  return chain;
}

const driver = (patchId: string, severity: string | null, releaseDate = daysAgo(60)) => ({
  devicePatchId: `dp-${patchId}`, patchId, externalId: patchId, title: patchId, status: 'pending',
  category: 'driver', severity, releaseDate, requiresReboot: false, source: 'microsoft',
  packageId: null, version: null, supersededBy: null, firstSeenAt: null, scope: null,
  reportedUpdateType: null, reportedUpdateOwner: null,
});

/** One device run of a job whose snapshot carries `rule`; resolves to the approved patch ids. */
async function runJob(rule: Record<string, unknown>): Promise<string[] | null> {
  const patches = buildPatchesSnapshot({
    settings: { sources: ['os'] },
    ring: {
      classification: 'valid_ring', valid: true, ringId: RING, ringName: 'Ring',
      categoryRules: [rule], categories: [], excludeCategories: [],
      // Ring-level opt-in on: a matching category rule is terminal, so this must not decide.
      autoApprove: {
        enabled: true, severities: ['critical', 'important', 'moderate', 'low'],
        deferralDays: 0, thirdPartyApps: false, autoApproveUnrated: true,
      },
      appRules: [], featureUpdates: { mode: 'block' },
    },
  });
  const results = [
    // JSONB round trip, as the job row stores it.
    [{ id: 'job-1', orgId: 'org-1', status: 'running', patches: JSON.parse(JSON.stringify(patches)), targets: { deviceIds: ['device-1'] } }],
    [{ id: 'device-1', osType: 'windows' }],
    [{ deferralDays: 0, partnerId: PARTNER, enabled: true }],
    [{ partnerId: PARTNER }],
    [
      driver('unknown-past-hold', 'unknown'),
      driver('null-past-hold', null),
      driver('unknown-in-hold', 'unknown', daysAgo(2)),
      driver('rated-in-allowlist', 'critical'),
      driver('rated-outside-allowlist', 'low'),
      // No matching rule: falls through to the ring-level unrated opt-in.
      { ...driver('security-unrated', null), category: 'security' },
    ],
    [], // manual decisions
    [], // checkAndFinalizeJob, after the device is marked skipped
  ];
  vi.mocked(db.select).mockImplementation((() => {
    const next = results.shift();
    if (!next) throw new Error('unexpected extra select: the executor query order changed');
    return selectResult(next);
  }) as never);

  const outcome = await __testOnly.processExecuteDevice({
    type: 'execute-patch-job-device', patchJobId: 'job-1', deviceId: 'device-1', orgId: 'org-1',
  } as never);
  expect(outcome).toMatchObject({ skipped: true, reason: 'No approved patches' });
  return captured.approvedIds;
}

describe('a category rule autoApproveUnrated in a patch job snapshot (#12626)', () => {
  const rule = {
    category: 'driver', autoApprove: true,
    autoApproveSeverities: ['critical', 'important'], deferralDaysOverride: 14,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    captured.approvedIds = null;
    captured.configs = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(db.insert).mockReturnValue({ values: async () => undefined } as never);
    vi.mocked(db.update).mockReturnValue({ set: () => ({ where: async () => undefined }) } as never);
  });

  it('true approves unknown and NULL severity past the hold, and nothing else extra', async () => {
    expect(await runJob({ ...rule, autoApproveUnrated: true }))
      .toEqual(['unknown-past-hold', 'null-past-hold', 'rated-in-allowlist', 'security-unrated']);
  });

  it.each([
    ['absent', {}],
    ['false', { autoApproveUnrated: false }],
  ])('%s approves only the rated driver in the allowlist', async (_label, flag) => {
    expect(await runJob({ ...rule, ...flag })).toEqual(['rated-in-allowlist', 'security-unrated']);
  });

  it.each([['string', 'true'], ['number', 1], ['null', null]])(
    'a malformed flag (%s) coerces the rule to a logged deny',
    async (_label, autoApproveUnrated) => {
      expect(await runJob({ ...rule, autoApproveUnrated })).toEqual(['security-unrated']);
      expect(captured.configs[0].categoryRules).toEqual([{ category: 'driver', autoApprove: false }]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('coercing malformed category rule to deny (fail-closed)'),
        expect.any(String),
      );
    },
  );
});

/**
 * Drift guard. Both read schemas (the job snapshot's and the live ring row's)
 * must keep every field of the write schema and of the evaluator's
 * `CategoryRule`. The samples are typed `Required<...>`, so adding a field to
 * either side fails the test typecheck until it is sampled here, and this
 * suite then fails until both read schemas declare it.
 *
 * Nothing is dropped on purpose today. If that changes, leave the field out of
 * the comparison by name, with the reason.
 */
describe('category rule schema drift', () => {
  const writeSample: Required<z.input<typeof categoryRuleSchema>> = {
    category: 'driver',
    autoApprove: true,
    autoApproveSeverities: ['critical', 'important', 'moderate', 'low'],
    autoApproveUnrated: true,
    deferralDaysOverride: 14,
  };
  const evaluatorSample: Required<CategoryRule> = {
    category: 'driver',
    autoApprove: true,
    autoApproveSeverities: ['critical'],
    severityFilter: ['important'],
    autoApproveUnrated: true,
    deferralDaysOverride: 14,
  };

  it('the write sample covers every field the write schema accepts', () => {
    expect(Object.keys(writeSample).sort()).toEqual(Object.keys(categoryRuleSchema.shape).sort());
    expect(categoryRuleSchema.parse(writeSample)).toEqual(writeSample);
  });

  it.each([
    ['job snapshot (patchJobExecutor)', jobCategoryRuleSchema],
    ['live ring row (patchEligibility)', storedCategoryRuleSchema],
  ])('%s keeps every write-schema and evaluator field', (_label, schema) => {
    expect(Object.keys(schema.shape)).toEqual(expect.arrayContaining(Object.keys(categoryRuleSchema.shape)));
    expect(schema.parse(writeSample)).toEqual(writeSample);
    expect(schema.parse(evaluatorSample)).toEqual(evaluatorSample);
  });
});
