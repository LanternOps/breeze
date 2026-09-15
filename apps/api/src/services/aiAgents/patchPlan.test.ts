/**
 * AI patch agent W01 — the patch plan membership gate, persistence and safe
 * projection — and W02 (#5748), the minting branch after those gates: an
 * `install` item becomes ONE device-scoped Tier-3 supervised approval card
 * carrying only currently-eligible patch ids, under a problem-derived
 * idempotency key and a cross-occurrence suppression read.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PATCH_CHASE_MAX_ATTEMPTS, type PatchFailedWorkRef, type PatchPlanOutcome, type PatchPlanOutcomeRefs, type PatchRebootPlanRef } from '@breeze/shared';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
  selects: 0,
  fail: null as Error | null,
  scopes: [] as Array<string | undefined>,
  ambient: undefined as { scope: string } | undefined,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      state.selects += 1;
      state.scopes.push(state.ambient?.scope);
      const builder: Record<string, unknown> = {
        from: vi.fn(() => builder),
        where: vi.fn((w: unknown) => { state.wheres.push(w); return builder; }),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => {
            if (state.fail) throw state.fail;
            return state.rows.shift() ?? [];
          }).then(resolve, reject),
      };
      return builder;
    }),
  },
  getCurrentDbAccessContext: vi.fn(() => state.ambient),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const prev = state.ambient;
    state.ambient = { scope: 'system' };
    try { return await fn(); } finally { state.ambient = prev; }
  }),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

const w02 = vi.hoisted(() => ({
  createActionIntent: vi.fn(),
  resolveEligibility: vi.fn(),
  findIntents: vi.fn(),
}));
vi.mock('../actionIntents/intentService', () => ({ createActionIntent: w02.createActionIntent }));
vi.mock('../patchEligibility', () => ({ resolvePatchInstallEligibility: w02.resolveEligibility }));
vi.mock('../actionIntents/intentQuery', () => ({ findIntentsByIdempotencyKey: w02.findIntents }));

import type { AuthContext } from '../../middleware/auth';
import { patchPlanDeviceIds, persistPatchPlan, projectPatch } from './patchPlan';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const D1 = '00000000-0000-4000-8000-0000000000d1';
const D2 = '00000000-0000-4000-8000-0000000000d2';
const GHOST = '00000000-0000-4000-8000-0000000000d9';
const P1 = '00000000-0000-4000-8000-0000000000e1';
const P9 = '00000000-0000-4000-8000-0000000000e9';
const WIN = '00000000-0000-4000-8000-0000000000f1';
const JR = '00000000-0000-4000-8000-0000000000f2';

const refs: PatchPlanOutcomeRefs = {
  deviceIds: new Set([D1, D2]),
  patchIdsByDevice: new Map([[D1, new Set([P1])]]),
  windowIds: new Set(),
  jobResultIds: new Set(),
};

function plan(items: PatchPlanOutcome['items']): PatchPlanOutcome {
  return {
    schemaVersion: 1,
    summary: 'Plan.',
    posture: { compliancePct: 80, devicesAtRisk: 1, oldestOutstandingDays: 10 },
    items,
    dispositions: [],
    evidenceTruncated: false,
    generatedAt: '2026-09-14T02:00:00.000Z',
  };
}
const base = { severity: 'high' as const, title: 't', detail: 'd', evidenceRef: 'e' };
const RUN_ID = '00000000-0000-4000-8000-00000000ab01';
const agentAuth = { user: { id: 'agent-user' } } as unknown as AuthContext;
// W01 shape plus the W02 fields the finalizer threads (sweepFindings precedent).
const run = { id: RUN_ID, orgId: ORG, agentId: 'agent-1', scheduleId: null, toolAllowlist: ['manage_patches:install'], maxActionsPerRun: 5 };
const dialect = new PgDialect();

const eligible = (ids: string[]) => ids.map((patchId) => ({
  patchId, devicePatchId: `dp-${patchId}`, externalId: 'KB', title: 't', category: null, severity: null, requiresReboot: false, approvalReason: 'manual' as const,
}));

beforeEach(() => {
  state.rows = [];
  state.wheres = [];
  state.selects = 0;
  state.fail = null;
  state.scopes = [];
  state.ambient = undefined;
  w02.createActionIntent.mockReset();
  w02.resolveEligibility.mockReset();
  w02.findIntents.mockReset();
  w02.createActionIntent.mockResolvedValue({ id: 'intent-1', status: 'pending_approval' });
  w02.resolveEligibility.mockResolvedValue({ eligible: eligible([P1]), ineligible: [], ringId: 'ring-1', resolvedAt: '2026-09-14T02:00:00.000Z' });
  w02.findIntents.mockResolvedValue([]);
});

describe('persistPatchPlan', () => {
  it('refuses a device absent from the evidence BEFORE any DB work', async () => {
    const { dispositions } = await persistPatchPlan(run, plan([{ ...base, class: 'install', deviceId: GHOST, patchIds: [P1] }]), refs, agentAuth);
    expect(dispositions).toEqual([{ index: 0, class: 'install', deviceId: GHOST, disposition: 'refused', reason: 'device_not_in_evidence' }]);
    expect(state.selects).toBe(0);
  });

  it('refuses a patch that is not outstanding on that device in the evidence', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([{ ...base, class: 'install', deviceId: D1, patchIds: [P9] }]), refs, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'patch_not_in_evidence' });
  });

  it('refuses every reboot_plan (no window resolves in W01) and every chase (no failure evidence in W01)', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'reboot_plan', deviceId: D1, windowId: WIN },
      { ...base, class: 'chase', deviceId: D1, patchIds: [P1], jobResultIds: [JR] },
    ]), refs, agentAuth);
    expect(dispositions.map((d) => d.reason)).toEqual(['window_not_resolved', 'job_result_not_in_evidence']);
  });

  it('records a valid install and a device-less advisory, checking org membership in ONE batched, org-pinned read', async () => {
    state.rows = [[{ id: D1 }, { id: D2 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'escalation', deviceId: D2 },
      { ...base, class: 'approval_advisory', patchIds: [P1] },
    ]), refs, agentAuth);
    expect(dispositions.map((d) => d.disposition)).toEqual(['intent_created', 'recorded', 'recorded']);
    expect(state.selects).toBe(1);
    expect(state.scopes).toEqual(['system']);
    const compiled = dialect.sqlToQuery(state.wheres[0] as SQL);
    expect(compiled.sql).toContain('"org_id" = ');
    expect(compiled.sql).toContain('"is_ephemeral" = ');
    expect(compiled.params).toContain(ORG);
  });

  it('refuses a device that cleared gate 1 but is no longer in the org (moved / ephemeral)', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'escalation', deviceId: D2 },
    ]), refs, agentAuth);
    expect(dispositions[1]).toMatchObject({ disposition: 'refused', reason: 'device_not_in_org' });
  });

  it('propagates a membership-read failure so the finalizer can report it', async () => {
    state.fail = new Error('db down');
    await expect(persistPatchPlan(run, plan([{ ...base, class: 'escalation', deviceId: D1 }]), refs, agentAuth)).rejects.toThrow('db down');
  });

  it('never calls manage_patches:approve — approvals stay advisory (OD-3 A), asserted on the source', () => {
    // Code only — the header documents these invariants by name.
    const src = readFileSync(join(__dirname, 'patchPlan.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/['"]approve['"]|bulk_approve|patchApprovals|patch_approvals/);
    // The ONLY minted action is install; rollback is never proposed.
    expect(src).not.toMatch(/rollback/);
    expect(src).toMatch(/action: 'install'/);
  });
});

describe('persistPatchPlan — W02 minting branch', () => {
  const install = (deviceId: string, patchIds: string[], title = 'Install 2 critical updates on WS-014') =>
    ({ ...base, class: 'install' as const, deviceId, patchIds, title });
  const refs2: PatchPlanOutcomeRefs = { ...refs, patchIdsByDevice: new Map([[D1, new Set([P1, P9])], [D2, new Set([P1])]]) };

  it('mints ONE device-scoped Tier-3 intent per eligible install item', async () => {
    state.rows = [[{ id: D1 }]];
    w02.resolveEligibility.mockResolvedValue({ eligible: eligible([P1, P9]), ineligible: [], ringId: 'ring-1', resolvedAt: 'x' });
    const { dispositions, intentIds } = await persistPatchPlan(run, plan([install(D1, [P1, P9])]), refs2, agentAuth);
    expect(w02.createActionIntent).toHaveBeenCalledTimes(1);
    expect(w02.createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      toolName: 'manage_patches',
      // The tool's install action takes `deviceIds` (one, equal to the scope) and `patchIds`.
      input: { action: 'install', deviceIds: [D1], patchIds: [P1, P9] },
      source: 'ai_agent',
      orgId: ORG,
      reason: 'Install 2 critical updates on WS-014',
      idempotencyKey: `patch:${ORG}:${D1}:${P1}`,
      scope: { deviceId: D1 },
      trigger: expect.objectContaining({ refId: RUN_ID }),
    }));
    expect(intentIds).toEqual(['intent-1']);
    expect(dispositions[0]).toEqual({
      index: 0, class: 'install', deviceId: D1, disposition: 'intent_created', intentId: 'intent-1', mintedPatchIds: [P1, P9],
    });
  });

  it('drops ineligible patchIds from the card and records why, instead of refusing the whole item', async () => {
    state.rows = [[{ id: D1 }]];
    w02.resolveEligibility.mockResolvedValue({ eligible: eligible([P1]), ineligible: [{ patchId: P9, reason: 'held_by_deferral' }], ringId: 'ring-1', resolvedAt: 'x' });
    const { dispositions } = await persistPatchPlan(run, plan([install(D1, [P1, P9])]), refs2, agentAuth);
    const minted = w02.createActionIntent.mock.calls[0]![1] as { input: { patchIds: string[] } };
    expect(minted.input.patchIds).toEqual([P1]);
    expect(dispositions[0]).toMatchObject({ disposition: 'intent_created', droppedPatchIds: [{ patchId: P9, reason: 'held_by_deferral' }], mintedPatchIds: [P1] });
  });

  it('refuses the item entirely when NOTHING is eligible', async () => {
    state.rows = [[{ id: D1 }]];
    w02.resolveEligibility.mockResolvedValue({ eligible: [], ineligible: [{ patchId: P1, reason: 'superseded' }], ringId: null, resolvedAt: 'x' });
    const { dispositions } = await persistPatchPlan(run, plan([install(D1, [P1])]), refs2, agentAuth);
    expect(w02.createActionIntent).not.toHaveBeenCalled();
    expect(w02.findIntents).not.toHaveBeenCalled();
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'no_eligible_patches', droppedPatchIds: [{ patchId: P1, reason: 'superseded' }] });
  });

  it('suppresses a repeat proposal for the same (device, patch) on the next occurrence', async () => {
    state.rows = [[{ id: D1 }]];
    w02.findIntents.mockResolvedValue([{ idempotencyKey: `patch:${ORG}:${D1}:${P1}`, status: 'pending_approval', createdAt: new Date(), decidedAt: null }]);
    const { dispositions } = await persistPatchPlan(run, plan([install(D1, [P1])]), refs2, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'suppressed', reason: 'live_intent_exists' });
    expect(w02.createActionIntent).not.toHaveBeenCalled();
  });

  it('does ONE suppression read for the whole run, keyed by every surviving patch id', async () => {
    state.rows = [[{ id: D1 }, { id: D2 }]];
    w02.resolveEligibility
      .mockResolvedValueOnce({ eligible: eligible([P1, P9]), ineligible: [], ringId: 'r', resolvedAt: 'x' })
      .mockResolvedValueOnce({ eligible: eligible([P1]), ineligible: [], ringId: 'r', resolvedAt: 'x' });
    await persistPatchPlan(run, plan([install(D1, [P1, P9]), install(D2, [P1])]), refs2, agentAuth);
    expect(w02.findIntents).toHaveBeenCalledTimes(1);
    const call = w02.findIntents.mock.calls[0]![0] as { orgId: string; keys: string[]; since: Date };
    expect(call.orgId).toBe(ORG);
    expect(new Set(call.keys)).toEqual(new Set([`patch:${ORG}:${D1}:${P1}`, `patch:${ORG}:${D1}:${P9}`, `patch:${ORG}:${D2}:${P1}`]));
    expect(call.since).toBeInstanceOf(Date);
    // A live card on a BUNDLED id (P9, not the card's own key) still suppresses the whole card.
    w02.findIntents.mockResolvedValue([{ idempotencyKey: `patch:${ORG}:${D1}:${P9}`, status: 'approved', createdAt: new Date(), decidedAt: null }]);
    w02.resolveEligibility.mockResolvedValue({ eligible: eligible([P1, P9]), ineligible: [], ringId: 'r', resolvedAt: 'x' });
    state.rows = [[{ id: D1 }]];
    w02.createActionIntent.mockClear();
    const { dispositions } = await persistPatchPlan(run, plan([install(D1, [P1, P9])]), refs2, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'suppressed', reason: 'live_intent_exists' });
    expect(w02.createActionIntent).not.toHaveBeenCalled();
  });

  it('stops at the run action cap and records cap_reached', async () => {
    state.rows = [[{ id: D1 }, { id: D2 }]];
    w02.createActionIntent
      .mockResolvedValueOnce({ id: 'intent-1', status: 'pending_approval' })
      .mockResolvedValueOnce({ id: 'intent-2', status: 'pending_approval' });
    const { dispositions, intentIds } = await persistPatchPlan(
      { ...run, maxActionsPerRun: 1 }, plan([install(D1, [P1]), install(D2, [P1])]), refs2, agentAuth,
    );
    expect(w02.createActionIntent).toHaveBeenCalledTimes(1);
    expect(intentIds).toEqual(['intent-1']);
    expect(dispositions[1]).toMatchObject({ disposition: 'cap_reached', reason: 'max_actions_per_run' });
  });

  it('refuses without any eligibility read when manage_patches:install is not in the agent allowlist', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan({ ...run, toolAllowlist: ['manage_patches:list'] }, plan([install(D1, [P1])]), refs2, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'not_allowlisted' });
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
    expect(w02.createActionIntent).not.toHaveBeenCalled();
  });

  it('a bare `manage_patches` allowlist entry admits install (isToolAllowlisted semantics)', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan({ ...run, toolAllowlist: ['manage_patches'] }, plan([install(D1, [P1])]), refs2, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'intent_created' });
  });

  it('never mints for an approval_advisory item (OD-3 A) nor for any other class', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'approval_advisory', patchIds: [P1] },
      { ...base, class: 'escalation', deviceId: D1 },
    ]), refs2, agentAuth);
    expect(dispositions.map((d) => d.disposition)).toEqual(['recorded', 'recorded']);
    expect(w02.createActionIntent).not.toHaveBeenCalled();
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
  });

  it('never links a cancelled snapshot', async () => {
    state.rows = [[{ id: D1 }]];
    w02.createActionIntent.mockResolvedValue({ id: 'i1', status: 'cancelled', errorCode: 'no_eligible_approvers' });
    const { dispositions, intentIds } = await persistPatchPlan(run, plan([install(D1, [P1])]), refs2, agentAuth);
    expect(intentIds).toEqual([]);
    expect(dispositions[0]).toMatchObject({ disposition: 'error', reason: 'no_eligible_approvers' });
    expect(dispositions[0]!.intentId).toBeUndefined();
  });

  it('logs but never persists an intent error message', async () => {
    state.rows = [[{ id: D1 }]];
    w02.createActionIntent.mockRejectedValue(new Error('agent_policy_denied: secret device name'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { dispositions, intentIds } = await persistPatchPlan(run, plan([install(D1, [P1])]), refs2, agentAuth);
    expect(intentIds).toEqual([]);
    expect(dispositions[0]).toMatchObject({ disposition: 'error', reason: 'intent_error' });
    expect(JSON.stringify(dispositions)).not.toContain('secret device name');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('resolves eligibility ONCE per device, not once per patch or per item', async () => {
    state.rows = [[{ id: D1 }]];
    await persistPatchPlan(run, plan([install(D1, [P1]), install(D1, [P9])]), refs2, agentAuth);
    expect(w02.resolveEligibility).toHaveBeenCalledTimes(1);
    expect(w02.resolveEligibility).toHaveBeenCalledWith({ deviceId: D1, orgId: ORG, patchIds: [P1, P9] });
  });

  it('runs the eligibility resolution AFTER the W01 membership gates', async () => {
    state.rows = [[]];
    const { dispositions } = await persistPatchPlan(run, plan([install(D1, [P1]), install(GHOST, [P1])]), refs2, agentAuth);
    expect(dispositions.map((d) => d.reason)).toEqual(['device_not_in_org', 'device_not_in_evidence']);
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// W03 (#5749) — chase proposals and escalation items
// ---------------------------------------------------------------------------
describe('persistPatchPlan — W03 chase gates', () => {
  const JR2 = '00000000-0000-4000-8000-0000000000f3';
  const JR3 = '00000000-0000-4000-8000-0000000000f4';
  const group = (over: Partial<PatchFailedWorkRef> = {}): PatchFailedWorkRef =>
    ({ deviceId: D1, patchId: P1, failureClass: 'transient', attemptCount: 1, truncated: false, jobResultIds: [JR], ...over });
  const refsWith = (...groups: PatchFailedWorkRef[]): PatchPlanOutcomeRefs => {
    const byJob = new Map<string, PatchFailedWorkRef>();
    for (const g of groups) for (const id of g.jobResultIds) byJob.set(id, g);
    return {
      deviceIds: new Set([D1, D2]),
      patchIdsByDevice: new Map([[D1, new Set([P1, P9])], [D2, new Set([P1])]]),
      windowIds: new Set(),
      jobResultIds: new Set(byJob.keys()),
      failedWorkByJobResult: byJob,
    };
  };
  const chase = (over: Record<string, unknown> = {}) => ({
    ...base, class: 'chase' as const, deviceId: D1, patchIds: [P1], jobResultIds: [JR], failureClass: 'transient' as const, attemptCount: 1,
    title: 'Retry KB1 on WS-01', ...over,
  });

  it('a chase item flows through the SAME eligibility intersection and episode suppression as an install', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions, intentIds } = await persistPatchPlan(run, plan([chase()]), refsWith(group()), agentAuth);
    // one path, not two — a chase that skipped the eligibility gate would
    // install a patch the ring no longer approves
    expect(w02.resolveEligibility).toHaveBeenCalledWith({ deviceId: D1, orgId: ORG, patchIds: [P1] });
    expect(w02.findIntents).toHaveBeenCalledTimes(1);
    expect(w02.createActionIntent).toHaveBeenCalledWith(agentAuth, expect.objectContaining({
      toolName: 'manage_patches',
      input: { action: 'install', deviceIds: [D1], patchIds: [P1] },
      idempotencyKey: `patch:${ORG}:${D1}:${P1}`,
      scope: { deviceId: D1 },
    }));
    expect(intentIds).toEqual(['intent-1']);
    expect(dispositions[0]).toMatchObject({ class: 'chase', disposition: 'intent_created', intentId: 'intent-1', mintedPatchIds: [P1] });
  });

  it('carries the attempt history and the class into the intent reason', async () => {
    state.rows = [[{ id: D1 }]];
    await persistPatchPlan(run, plan([chase()]), refsWith(group()), agentAuth);
    const minted = w02.createActionIntent.mock.calls[0]![1] as { reason: string };
    expect(minted.reason).toMatch(/attempt 2 of 2/);
    expect(minted.reason).toContain('transient');
    expect(minted.reason).toContain('Retry KB1 on WS-01');
  });

  it('refuses a chase whose jobResultIds are not in the evidence', async () => {
    const { dispositions } = await persistPatchPlan(run, plan([chase({ jobResultIds: [JR2] })]), refsWith(group()), agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'job_result_not_in_evidence' });
    expect(state.selects).toBe(0);
  });

  it('refuses a chase whose job results belong to a different device or patch than the item names', async () => {
    const other = group({ deviceId: D2, jobResultIds: [JR2] });
    const { dispositions } = await persistPatchPlan(run, plan([
      chase({ jobResultIds: [JR2] }),                  // D2's result on a D1 item
      chase({ patchIds: [P9] }),                       // P1's result on a P9 item
      chase({ jobResultIds: [JR, JR2] }),              // two different groups
    ]), refsWith(group(), other), agentAuth);
    expect(dispositions.map((d) => d.reason)).toEqual(['job_result_not_in_evidence', 'job_result_not_in_evidence', 'job_result_not_in_evidence']);
  });

  it('refuses a chase whose cited failureClass disagrees with the evidence — the model may quote a class, never assign one', async () => {
    const { dispositions } = await persistPatchPlan(run, plan([
      chase({ failureClass: 'disk_space' }),
      chase({ failureClass: undefined }),
    ]), refsWith(group()), agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'failure_class_mismatch' });
    expect(dispositions[1]).toMatchObject({ disposition: 'refused', reason: 'failure_class_mismatch' });
    expect(w02.createActionIntent).not.toHaveBeenCalled();
  });

  it('refuses a chase whose cited attemptCount disagrees with the evidence', async () => {
    const { dispositions } = await persistPatchPlan(run, plan([chase({ attemptCount: 5 })]), refsWith(group()), agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'attempt_count_mismatch' });
  });

  it('mints a chase for EVERY retryable class, not just transient', async () => {
    for (const cls of ['transient', 'disk_space', 'store_corrupt'] as const) {
      w02.createActionIntent.mockClear();
      w02.resolveEligibility.mockClear();
      state.rows = [[{ id: D1 }]];
      const g = group({ failureClass: cls });
      const { dispositions, intentIds } = await persistPatchPlan(run, plan([chase({ failureClass: cls })]), refsWith(g), agentAuth);
      expect(dispositions[0], cls).toMatchObject({ class: 'chase', disposition: 'intent_created', mintedPatchIds: [P1] });
      expect(intentIds, cls).toEqual(['intent-1']);
      expect((w02.createActionIntent.mock.calls[0]![1] as { reason: string }).reason, cls).toContain(cls);
    }
  });

  it('refuses a chase off a TRUNCATED failure history — the attempt count is a floor, not a total', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([chase()]), refsWith(group({ truncated: true })), agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'failure_history_truncated' });
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
    expect(w02.createActionIntent).not.toHaveBeenCalled();
  });

  it('records an ESCALATION off a truncated history — only a chase is bounded by the count', async () => {
    state.rows = [[{ id: D1 }]];
    const g = group({ truncated: true });
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'escalation', deviceId: D1, jobResultIds: [JR], failureClass: 'transient', attemptCount: 1 },
    ]), refsWith(g), agentAuth);
    expect(dispositions[0]).toMatchObject({ class: 'escalation', disposition: 'recorded' });
  });

  it('names the field that actually disagreed when only attemptCount is quoted', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'escalation', deviceId: D1, jobResultIds: [JR], attemptCount: 9 },
      // Nothing to check against at all: the quoted field is the one named.
      { ...base, class: 'escalation', deviceId: D1, attemptCount: 9 },
      { ...base, class: 'escalation', deviceId: D1, failureClass: 'permanent' },
    ]), refsWith(group()), agentAuth);
    expect(dispositions.map((d) => d.reason)).toEqual(['attempt_count_mismatch', 'attempt_count_mismatch', 'failure_class_mismatch']);
  });

  it('refuses a chase on a non-retryable class', async () => {
    for (const cls of ['needs_reboot', 'permanent', 'unknown'] as const) {
      w02.createActionIntent.mockClear();
      const { dispositions } = await persistPatchPlan(run, plan([chase({ failureClass: cls })]), refsWith(group({ failureClass: cls })), agentAuth);
      expect(dispositions[0], cls).toMatchObject({ disposition: 'refused', reason: 'class_not_retryable' });
      expect(w02.createActionIntent).not.toHaveBeenCalled();
    }
  });

  it('refuses a chase once attemptCount >= PATCH_CHASE_MAX_ATTEMPTS and expects an escalation instead', async () => {
    expect(PATCH_CHASE_MAX_ATTEMPTS).toBe(2);
    const { dispositions } = await persistPatchPlan(run, plan([
      chase({ attemptCount: 2, jobResultIds: [JR, JR2] }),
    ]), refsWith(group({ attemptCount: 2, jobResultIds: [JR, JR2] })), agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'chase_attempts_exhausted' });
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
    expect(w02.createActionIntent).not.toHaveBeenCalled();
  });

  it('runs the chase gates BEFORE the W02 gates — a refused chase never costs an eligibility read', async () => {
    const { dispositions } = await persistPatchPlan(run, plan([chase({ failureClass: 'disk_space' })]), refsWith(group()), agentAuth);
    expect(dispositions[0]!.disposition).toBe('refused');
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
    expect(w02.findIntents).not.toHaveBeenCalled();
  });

  it('a chase is suppressed on the next occurrence like any other install (same episode key)', async () => {
    state.rows = [[{ id: D1 }]];
    w02.findIntents.mockResolvedValue([{ idempotencyKey: `patch:${ORG}:${D1}:${P1}`, status: 'pending_approval', createdAt: new Date(), decidedAt: null }]);
    const { dispositions } = await persistPatchPlan(run, plan([chase()]), refsWith(group()), agentAuth);
    expect(dispositions[0]).toMatchObject({ class: 'chase', disposition: 'suppressed', reason: 'live_intent_exists' });
  });

  it('never mints for an escalation item — recorded only', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions, intentIds } = await persistPatchPlan(run, plan([
      { ...base, class: 'escalation', deviceId: D1, patchIds: [P1], jobResultIds: [JR, JR2, JR3], failureClass: 'permanent', attemptCount: 3 },
      { ...base, class: 'escalation', deviceId: null },
    ]), refsWith(group({ failureClass: 'permanent', attemptCount: 3, jobResultIds: [JR, JR2, JR3] })), agentAuth);
    expect(dispositions.map((d) => d.disposition)).toEqual(['recorded', 'recorded']);
    expect(intentIds).toEqual([]);
    expect(w02.createActionIntent).not.toHaveBeenCalled();
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
  });

  it('refuses an escalation whose quoted class/attempts cannot be checked against cited job results, or disagree with them', async () => {
    state.rows = [[{ id: D1 }]];
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'escalation', deviceId: D1, failureClass: 'permanent' },                                   // no jobResultIds to check against
      { ...base, class: 'escalation', deviceId: D1, jobResultIds: [JR], failureClass: 'permanent', attemptCount: 1 }, // evidence says transient
      { ...base, class: 'escalation', deviceId: D1, jobResultIds: [JR], failureClass: 'transient', attemptCount: 9 },
    ]), refsWith(group()), agentAuth);
    expect(dispositions.map((d) => d.reason)).toEqual(['failure_class_mismatch', 'failure_class_mismatch', 'attempt_count_mismatch']);
  });

  it('never chases a queued-offline install — there is no failure evidence row to cite', async () => {
    // queuedOffline is a rollup scalar, not a failedWork row: nothing to key
    // a chase on, so the only possible citation is out of evidence.
    const { dispositions } = await persistPatchPlan(run, plan([chase()]), { ...refs, failedWorkByJobResult: new Map() }, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'job_result_not_in_evidence' });
  });
});

// ---------------------------------------------------------------------------
// W04 (#5750): reboot plan items against resolved windows
// ---------------------------------------------------------------------------
describe('persistPatchPlan — W04 reboot_plan gates', () => {
  const WIN_A = '00000000-0000-4000-8000-00000000c001@2026-09-16T02:00:00.000Z';
  const WIN_B = '00000000-0000-4000-8000-00000000c002@2026-09-17T02:00:00.000Z';
  const D3 = '00000000-0000-4000-8000-0000000000d3';
  const D4 = '00000000-0000-4000-8000-0000000000d4';
  const D5 = '00000000-0000-4000-8000-0000000000d5';
  const rebootRef = (deviceId: string, over: Partial<PatchRebootPlanRef> = {}): PatchRebootPlanRef => ({
    deviceId, windowId: WIN_A, windowStartsAt: '2026-09-16T02:00:00.000Z', windowEndsAt: '2026-09-16T04:00:00.000Z',
    rebootPolicy: 'maintenance_window', redundancyGroup: 'dc', unplannableReason: null, ...over,
  });
  const w04refs: PatchPlanOutcomeRefs = {
    deviceIds: new Set([D1, D2, D3, D4, D5]),
    patchIdsByDevice: new Map(),
    windowIds: new Set([WIN_A, WIN_B]),
    jobResultIds: new Set(),
    rebootPlanByDevice: new Map([
      [D1, rebootRef(D1)],
      [D2, rebootRef(D2)],                                   // same group + window as D1 → collision
      [D3, rebootRef(D3, { windowId: WIN_B, windowStartsAt: '2026-09-17T02:00:00.000Z', windowEndsAt: '2026-09-17T04:00:00.000Z' })],
      [D4, rebootRef(D4, { rebootPolicy: 'if_required', unplannableReason: 'reboot_policy_not_window_gated' })],
      [D5, rebootRef(D5, { redundancyGroup: null, unplannableReason: 'redundancy_unknown' })],
    ]),
  };
  const ok = () => { state.rows = [[{ id: D1 }, { id: D2 }, { id: D3 }, { id: D4 }, { id: D5 }]]; };

  it('accepts a reboot_plan whose windowId is the one the evidence resolved for THAT device, carrying the window and group', async () => {
    ok();
    const { dispositions, intentIds } = await persistPatchPlan(run, plan([{ ...base, class: 'reboot_plan', deviceId: D1, windowId: WIN_A }]), w04refs, agentAuth);
    expect(dispositions[0]).toEqual({
      index: 0, class: 'reboot_plan', deviceId: D1, disposition: 'recorded',
      windowStartsAt: '2026-09-16T02:00:00.000Z', windowEndsAt: '2026-09-16T04:00:00.000Z', redundancyGroup: 'dc',
    });
    expect(intentIds).toEqual([]);
  });

  it('refuses a windowId the evidence did not resolve, and one resolved for a DIFFERENT device', async () => {
    ok();
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'reboot_plan', deviceId: D1, windowId: '00000000-0000-4000-8000-00000000c009@2026-09-16T02:00:00.000Z' },
      { ...base, class: 'reboot_plan', deviceId: D1, windowId: WIN_B },
    ]), w04refs, agentAuth);
    expect(dispositions.map((d) => d.reason)).toEqual(['window_not_resolved', 'window_not_resolved']);
  });

  it('refuses a reboot_plan for a device whose policy is if_required or always (the system reboots those with no window check)', async () => {
    ok();
    const { dispositions } = await persistPatchPlan(run, plan([{ ...base, class: 'reboot_plan', deviceId: D4, windowId: WIN_A }]), w04refs, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'reboot_policy_not_window_gated' });
  });

  it('refuses a reboot_plan for a device whose redundancy group is unknown', async () => {
    ok();
    const { dispositions } = await persistPatchPlan(run, plan([{ ...base, class: 'reboot_plan', deviceId: D5, windowId: WIN_A }]), w04refs, agentAuth);
    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'redundancy_unknown' });
  });

  it('refuses the SECOND of two accepted items that put the same redundancy group in the same window; a different window is fine', async () => {
    ok();
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'reboot_plan', deviceId: D1, windowId: WIN_A },
      { ...base, class: 'reboot_plan', deviceId: D2, windowId: WIN_A },
      { ...base, class: 'reboot_plan', deviceId: D3, windowId: WIN_B },
    ]), w04refs, agentAuth);
    expect(dispositions.map((d) => [d.disposition, d.reason ?? null])).toEqual([
      ['recorded', null], ['refused', 'redundancy_collision'], ['recorded', null],
    ]);
  });

  it('mints NO intent for any reboot_plan item and dispatches nothing', async () => {
    ok();
    await persistPatchPlan(run, plan([
      { ...base, class: 'reboot_plan', deviceId: D1, windowId: WIN_A },
      { ...base, class: 'reboot_plan', deviceId: D3, windowId: WIN_B },
    ]), w04refs, agentAuth);
    expect(w02.createActionIntent).not.toHaveBeenCalled();
    expect(w02.resolveEligibility).not.toHaveBeenCalled();
  });

  it('an escalation for an unplannable device is recorded (visible), never refused for being unplannable', async () => {
    ok();
    const { dispositions } = await persistPatchPlan(run, plan([
      { ...base, class: 'escalation', deviceId: D4 },
      { ...base, class: 'escalation', deviceId: D5 },
    ]), w04refs, agentAuth);
    expect(dispositions.map((d) => d.disposition)).toEqual(['recorded', 'recorded']);
  });

  it('never dispatches a reboot or creates a window — asserted on the source', () => {
    const src = readFileSync(join(__dirname, 'patchPlan.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/executeReboot|queueCommandForExecution|schedule_reboot|maintenanceWindows\)|insert\(/);
  });
});

describe('projectPatch', () => {
  it('returns null when there is no patchPlan at all', () => {
    expect(projectPatch({ scheduleId: null, triggerRef: {} }, {}, new Map())).toBeNull();
    expect(projectPatch({ scheduleId: null, triggerRef: {} }, { patchPlan: 'nope' } as never, new Map())).toBeNull();
  });

  it('tolerates a maximally corrupt outcome', () => {
    const out = projectPatch({ scheduleId: null, triggerRef: {} }, { patchPlan: { items: 7, summary: 3, dispositions: 'x' } } as never, new Map());
    expect(out).toMatchObject({ summary: '', items: [], posture: null, recordedCount: 0, refusedCount: 0 });
  });

  it('projects the quoted failure class / attempt count and counts recorded escalations (W03)', () => {
    const outcome = {
      patchPlan: {
        items: [
          { class: 'chase', severity: 'high', deviceId: D1, patchIds: [P1], jobResultIds: [JR], failureClass: 'transient', attemptCount: 1, title: 't', detail: 'd', evidenceRef: 'e' },
          { class: 'escalation', severity: 'high', deviceId: D1, failureClass: 'permanent', attemptCount: 3, title: 't', detail: 'd', evidenceRef: 'e' },
          { class: 'escalation', severity: 'low', title: 't', detail: 'd', evidenceRef: 'e' },
        ],
        dispositions: [
          { index: 0, class: 'chase', deviceId: D1, disposition: 'intent_created', intentId: 'i' },
          { index: 1, class: 'escalation', deviceId: D1, disposition: 'recorded' },
          { index: 2, class: 'escalation', deviceId: null, disposition: 'refused', reason: 'device_not_in_evidence' },
        ],
      },
    };
    const dto = projectPatch({ scheduleId: null, triggerRef: null }, outcome, new Map())!;
    expect(dto.items[0]).toMatchObject({ failureClass: 'transient', attemptCount: 1 });
    expect(dto.items[1]).toMatchObject({ failureClass: 'permanent', attemptCount: 3 });
    expect(dto.items[2]).toMatchObject({ failureClass: null, attemptCount: null });
    expect(dto.escalationCount).toBe(1);
    expect(JSON.stringify(dto)).not.toContain(JR);
  });

  it('projects items with hostname, disposition and refusal reason — never the raw ids list', () => {
    const outcome = plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'reboot_plan', deviceId: D2, windowId: WIN },
    ]);
    outcome.dispositions = [
      { index: 0, class: 'install', deviceId: D1, disposition: 'recorded' },
      { index: 1, class: 'reboot_plan', deviceId: D2, disposition: 'refused', reason: 'window_not_resolved' },
    ];
    const dto = projectPatch(
      { scheduleId: 'sched-1', triggerRef: { occurrenceKey: '2026-09-14T02:00:00Z' } },
      { patchPlan: outcome },
      new Map([[D1, 'WS-01']]),
    )!;
    expect(dto).toMatchObject({ scheduleId: 'sched-1', occurrenceKey: '2026-09-14T02:00:00Z', recordedCount: 1, refusedCount: 1 });
    expect(dto.items[0]).toMatchObject({ index: 0, deviceHostname: 'WS-01', patchCount: 1, disposition: 'recorded', reason: null });
    expect(dto.items[1]).toMatchObject({ deviceHostname: null, disposition: 'refused', reason: 'window_not_resolved' });
    expect(JSON.stringify(dto)).not.toContain(P1);
  });
});

describe('projectPatch — W04 reboot plan fields', () => {
  it('projects windowId and the recorded window/redundancy fields for a reboot_plan item, null elsewhere', () => {
    const WIN_A = '00000000-0000-4000-8000-00000000c001@2026-09-16T02:00:00.000Z';
    const outcome = plan([
      { ...base, class: 'reboot_plan', deviceId: D1, windowId: WIN_A },
      { ...base, class: 'escalation', deviceId: D2 },
    ]);
    outcome.dispositions = [
      { index: 0, class: 'reboot_plan', deviceId: D1, disposition: 'recorded', windowStartsAt: '2026-09-16T02:00:00.000Z', windowEndsAt: '2026-09-16T04:00:00.000Z', redundancyGroup: 'dc' },
      { index: 1, class: 'escalation', deviceId: D2, disposition: 'recorded' },
    ];
    const dto = projectPatch({ scheduleId: null, triggerRef: null }, { patchPlan: outcome }, new Map())!;
    expect(dto.items[0]).toMatchObject({ windowId: WIN_A, windowStartsAt: '2026-09-16T02:00:00.000Z', windowEndsAt: '2026-09-16T04:00:00.000Z', redundancyGroup: 'dc' });
    expect(dto.items[1]).toMatchObject({ windowId: null, windowStartsAt: null, windowEndsAt: null, redundancyGroup: null });
  });
});

describe('patchPlanDeviceIds', () => {
  it('collects the distinct device ids a plan names, tolerating garbage', () => {
    expect(patchPlanDeviceIds({ patchPlan: plan([
      { ...base, class: 'install', deviceId: D1, patchIds: [P1] },
      { ...base, class: 'escalation', deviceId: D1 },
      { ...base, class: 'approval_advisory', patchIds: [P1] },
    ]) }).sort()).toEqual([D1]);
    expect(patchPlanDeviceIds({})).toEqual([]);
    expect(patchPlanDeviceIds({ patchPlan: { items: 'x' } })).toEqual([]);
  });
});
