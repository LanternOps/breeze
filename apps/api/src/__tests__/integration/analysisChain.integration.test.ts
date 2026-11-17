/**
 * Wisp analysis sessions W03 (#11847) - analysis-run chains against real
 * Postgres.
 *
 * Pins what a unit test with a mocked `../../db` cannot:
 *   - the lineage columns' composite same-org FKs, `ai_agent_runs_chain_chk`,
 *     and `ON DELETE SET NULL (continued_from_run_id)` (migration
 *     2027-01-27-130000-ai-analysis-run-lineage.sql);
 *   - `analysisContinuationOf` / `deriveChainHandles` over real rows;
 *   - the chain bounds enforced inside `createAndEnqueueAgentRun` step 4d
 *     under the real (agent, org) and analysis-compute advisory locks, where
 *     two concurrent continuations of one chain must serialise on the chain
 *     sum (a mocked lock cannot show that).
 *
 * Seeding goes through `getTestDb()` (the superuser pool) so fixtures bypass
 * RLS; every function under test runs on the application pool as in prod.
 * Each test seeds a fresh tenant (`./setup` truncates between tests).
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});
// Admission step 1c: the sandbox circuit breaker reads Redis; keep it closed.
vi.mock('../../services/workspace/workspaceBreaker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/workspace/workspaceBreaker')>();
  return { ...actual, isWorkspaceBreakerOpen: async () => false };
});
// Admission step 4b: platform credit check. Everything else in the cost
// tracker (notably `reserveComputeCents`) stays real.
vi.mock('../../services/aiCostTracker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiCostTracker')>();
  return { ...actual, checkComputeCredits: async () => null };
});

import { aiAgentRuns, aiAgents, wispGrantRevisions, wispGrants } from '../../db/schema';
import { aiRunArtifacts } from '../../db/schema/aiWorkspace';
import type { AiRunExportGrants } from '../../db/schema/aiAgents';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import {
  createAndEnqueueAgentRun,
  registerAgentRunEnqueuer,
  type CreateAgentRunInput,
  type CreateAgentRunResult,
} from '../../services/aiAgents/runService';
import { analysisContinuationOf, deriveChainHandles } from '../../services/aiAgents/analysisContinuation';
import { admitAnalysisRun } from '../../services/aiAgents/analysisAdmission';
import { WORKSPACE_TOOL_NAMES } from '../../services/workspace/workspaceToolNames';
import { getTestDb } from './setup';
import { db as appDb, withSystemDbAccessContext } from '../../db';
import {
  assignUserToPartner, createDevice, createOrganization, createPartner, createRole, createSite, createUser,
  grantRolePermissions,
} from './db-utils';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

usePlatformAiKeyPlaceholder();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

interface Tenant {
  partnerId: string;
  orgA: string;
  orgB: string;
  deviceA: string;
  userId: string;
  agentId: string;
  /** Two live grants of the partner, each with one revision. */
  grantG: { grantId: string; revisionId: string };
  grantG2: { grantId: string; revisionId: string };
}

/** What each grantor holds, live and pinned on its revision (the ceiling is their intersection). */
const GRANTOR_PERMS = [
  { resource: 'devices', action: 'read' }, { resource: 'ai_workspace', action: 'execute' }, { resource: 'ai_sessions', action: 'use' },
];
const GRANTOR_PERMISSION_KEYS = GRANTOR_PERMS.map((p) => `${p.resource}:${p.action}`);

/** A partner member with a live, permissioned partner-wide role: a grant's live term needs one. */
async function seedGrantor(partnerId: string, tag: string): Promise<string> {
  const grantor = await createUser({ partnerId, email: `chain-${tag}-${randomUUID()}@chain.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, GRANTOR_PERMS);
  await assignUserToPartner(grantor.id, partnerId, role.id, 'all');
  return grantor.id;
}

async function seedGrant(partnerId: string, grantorUserId: string, orgIds: string[]) {
  // Through the app pool under system scope, as wispSpecialists.integration
  // does: `wisp_grants_update_guard` lets only the system scope set the
  // current revision.
  return withSystemDbAccessContext(() => seedGrantRows(partnerId, grantorUserId, orgIds));
}

async function seedGrantRows(partnerId: string, grantorUserId: string, orgIds: string[]) {
  const db = appDb;
  const [g] = await db.insert(wispGrants).values({
    partnerId, orgId: null, grantorUserId, status: 'active',
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
  }).returning({ id: wispGrants.id });
  const snapshot: WispCeilingSnapshot = {
    version: 1, permissionKeys: GRANTOR_PERMISSION_KEYS, orgIds, siteIds: null, toolAllowlist: null, deniedTools: [],
  };
  const [r] = await db.insert(wispGrantRevisions).values({
    grantId: g!.id, partnerId, revision: 1, ceilingSnapshot: snapshot,
    factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
  }).returning({ id: wispGrantRevisions.id });
  await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
  return { grantId: g!.id, revisionId: r!.id };
}

/**
 * A partner with two orgs, a device in org A, a partner-baseline triage agent
 * that can admit analysis runs, and two grants. Org A has external processing
 * on (admission step 4d(a)). `limits` are WIDE on the volume caps so only the
 * chain bound a test is about can trip.
 */
async function seedTenant(limits: Record<string, number> = {}): Promise<Tenant> {
  const db = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  // organizations.ai_external_processing: per-org opt-in the analysis gate reads.
  await db.execute(sql`update organizations set ai_external_processing = true where id = ${orgA.id}`);
  const site = await createSite({ orgId: orgA.id });
  const device = await createDevice({ orgId: orgA.id, siteId: site.id });
  const user = await createUser({
    partnerId: partner.id, email: `analysis-chain-${randomUUID()}@analysischain.test`,
  });
  const [agent] = await db.insert(aiAgents).values({
    partnerId: partner.id, orgId: null, kind: 'triage', name: 'Chain Triage', enabled: true, mode: 'shadow', model: null,
    toolAllowlist: ['query_devices', ...WORKSPACE_TOOL_NAMES],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {
      maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000,
      analysisMaxConcurrentRuns: 5, analysisMaxRunsPerHour: 100,
      ...limits,
    },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy: user.id,
  } as never).returning({ id: aiAgents.id });
  // One live grant per (grantor, partner, scope): each grant has its own grantor.
  const grantG = await seedGrant(partner.id, await seedGrantor(partner.id, 'g1'), [orgA.id, orgB.id]);
  const grantG2 = await seedGrant(partner.id, await seedGrantor(partner.id, 'g2'), [orgA.id, orgB.id]);
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, deviceA: device.id, userId: user.id,
    agentId: agent!.id, grantG, grantG2,
  };
}

type RunOverrides = Partial<{
  profile: string;
  status: string;
  grant: { grantId: string; revisionId: string } | null;
  continuedFromRunId: string | null;
  chainRootRunId: string | null;
  chainDepth: number;
  triggerRef: Record<string, unknown>;
  stagedInputs: { handles: string[]; deviceIds: string[]; region: 'eu' | 'us'; exportGrants?: unknown } | null;
  /** The run's frozen export grants, written into `staged_inputs.exportGrants`. Default: none held (a subset of any launch). */
  exportGrants: unknown;
  policySnapshot: Record<string, unknown>;
}>;

const UNSETTLED = new Set(['queued', 'running']);

/** A run row inserted directly (no admission). Defaults: a settled analysis run, depth 0, no grant. */
async function insertRun(t: Tenant, orgId: string, o: RunOverrides = {}): Promise<string> {
  const status = o.status ?? 'completed';
  const [row] = await getTestDb().insert(aiAgentRuns).values({
    agentId: t.agentId,
    orgId,
    triggerKind: 'manual',
    dedupeKey: `chain-it-${randomUUID()}`,
    modeAtStart: 'shadow',
    policySnapshot: (o.policySnapshot ?? { schemaVersion: 1 }) as never,
    status: status as never,
    finishedAt: UNSETTLED.has(status) ? null : new Date(),
    profile: (o.profile ?? 'analysis') as never,
    grantId: o.grant?.grantId ?? null,
    grantRevisionId: o.grant?.revisionId ?? null,
    continuedFromRunId: o.continuedFromRunId ?? null,
    chainRootRunId: o.chainRootRunId ?? null,
    chainDepth: o.chainDepth ?? 0,
    triggerRef: (o.triggerRef ?? {}) as never,
    stagedInputs: (o.stagedInputs === null ? null : {
      ...(o.stagedInputs ?? { handles: [], deviceIds: [], region: 'us' }),
      exportGrants: 'exportGrants' in o ? o.exportGrants : { datasets: [], sensitiveGates: [] },
    }) as never,
  } as never).returning({ id: aiAgentRuns.id });
  return row!.id;
}

async function readRun(runId: string) {
  const [row] = await getTestDb().select().from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)).limit(1);
  return row;
}

/** Postgres SQLSTATE of a rejected statement (drizzle wraps the driver error in `cause`). */
async function pgCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

async function insertArtifact(
  orgId: string,
  runId: string,
  o: { kind: string; createdByTool: string; dataset?: string | null; expiresAt?: Date },
): Promise<string> {
  const [row] = await getTestDb().insert(aiRunArtifacts).values({
    orgId,
    runId,
    kind: o.kind as never,
    name: `artifact-${randomUUID().slice(0, 8)}`,
    contentType: 'application/json',
    bytes: 10,
    sha256: 'a'.repeat(64),
    blobKey: `us/2027/01/${randomUUID()}`,
    createdByTool: o.createdByTool,
    dataset: o.dataset ?? null,
    expiresAt: o.expiresAt ?? new Date(Date.now() + 30 * DAY_MS),
  } as never).returning({ id: aiRunArtifacts.id });
  return row!.id;
}

const sorted = (xs: string[]) => [...xs].sort();

// ---------------------------------------------------------------------------

let enqueued: string[] = [];

beforeEach(() => {
  // Analysis admission needs the kill switch, a hosted deploy, the workspace
  // flag (steps 1, 1b) and a valid region (4d(c); `breezeRegion()` otherwise
  // defaults to 'us', stubbed so the test does not depend on that default).
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_WORKSPACE_ENABLED', 'true');
  // Grant-bearing admission resolves the live ceiling, which needs Wisp on.
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
  vi.stubEnv('BREEZE_REGION', 'us');
  enqueued = [];
  // Without an enqueuer every admitted run is marked failed/enqueue_failed,
  // which the chain sum excludes and which would invalidate the counts below.
  registerAgentRunEnqueuer(async (runId) => {
    enqueued.push(runId);
    return { enqueued: true, jobId: `agent-run:${runId}` };
  });
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe('lineage columns', () => {
  it("a continuation naming another org's run is rejected by the composite FK (23503)", async () => {
    const t = await seedTenant();
    const runInOrgB = await insertRun(t, t.orgB);
    // (continued_from_run_id, org_id) must match an (id, org_id) of ONE org:
    // runInOrgB exists, but not under org A.
    expect(await pgCode(insertRun(t, t.orgA, {
      continuedFromRunId: runInOrgB, chainRootRunId: runInOrgB, chainDepth: 1,
    }))).toBe('23503');
    // The same shape inside one org is accepted (control: the FK is the only thing refusing).
    const rootB = runInOrgB;
    await expect(insertRun(t, t.orgB, { continuedFromRunId: rootB, chainRootRunId: rootB, chainDepth: 1 }))
      .resolves.toEqual(expect.any(String));
  });

  it('depth 0 with lineage violates ai_agent_runs_chain_chk (23514)', async () => {
    const t = await seedTenant();
    const root = await insertRun(t, t.orgA);
    expect(await pgCode(insertRun(t, t.orgA, {
      continuedFromRunId: root, chainRootRunId: root, chainDepth: 0,
    }))).toBe('23514');
    // Only one pointer set at depth 0 is just as illegal.
    expect(await pgCode(insertRun(t, t.orgA, { chainRootRunId: root, chainDepth: 0 }))).toBe('23514');
    // Control: the same pointers at depth 1 are legal.
    await expect(insertRun(t, t.orgA, { continuedFromRunId: root, chainRootRunId: root, chainDepth: 1 }))
      .resolves.toEqual(expect.any(String));
  });

  it('deleting the prior clears only the pointer; the continuation keeps its org, root and depth', async () => {
    const t = await seedTenant();
    const root = await insertRun(t, t.orgA);
    const mid = await insertRun(t, t.orgA, { continuedFromRunId: root, chainRootRunId: root, chainDepth: 1 });
    const leaf = await insertRun(t, t.orgA, { continuedFromRunId: mid, chainRootRunId: root, chainDepth: 2 });
    await getTestDb().delete(aiAgentRuns).where(eq(aiAgentRuns.id, mid));
    expect(await readRun(leaf)).toMatchObject({
      orgId: t.orgA, continuedFromRunId: null, chainRootRunId: root, chainDepth: 2,
    });
  });
});

// ---------------------------------------------------------------------------

describe('continuation validation', () => {
  it("another org's run returns exactly the not-found answer", async () => {
    const t = await seedTenant();
    const settledRunInOrgB = await insertRun(t, t.orgB, { grant: t.grantG });
    const foreign = await analysisContinuationOf({ orgId: t.orgA, runId: settledRunInOrgB, grantId: t.grantG.grantId });
    const missing = await analysisContinuationOf({ orgId: t.orgA, runId: randomUUID(), grantId: t.grantG.grantId });
    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({ ok: false, refusal: 'analysis_continuation_not_found' });
  });

  it('thread rule: a prior launched from chat session S1 is continuable under the same grant; a run under another grant is refused', async () => {
    const t = await seedTenant();
    const S1 = randomUUID();
    const prior = await insertRun(t, t.orgA, {
      grant: t.grantG, triggerRef: { originSessionId: S1, goal: 'find stale agents' },
    });
    // The caller is a SECOND chat session under the same grant. Validation
    // takes no session at all, so S1 is carried for display only.
    expect(await analysisContinuationOf({ orgId: t.orgA, runId: prior, grantId: t.grantG.grantId }))
      .toMatchObject({ ok: true, prior: { id: prior, originSessionId: S1, goal: 'find stale agents', chainDepth: 0 } });
    expect(await analysisContinuationOf({ orgId: t.orgA, runId: prior, grantId: t.grantG2.grantId }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_other_grant' });
  });

  it('refuses a grant-less run, a non-analysis run and an unsettled run, in spec order', async () => {
    const t = await seedTenant();
    const grantless = await insertRun(t, t.orgA);
    const notAnalysis = await insertRun(t, t.orgA, { profile: 'full', grant: t.grantG });
    const running = await insertRun(t, t.orgA, { status: 'running', grant: t.grantG });
    const expired = await insertRun(t, t.orgA, { status: 'expired', grant: t.grantG });
    const g = t.grantG.grantId;
    // A grant-less run is never continuable, even on the advisory (grant-less) precheck.
    expect(await analysisContinuationOf({ orgId: t.orgA, runId: grantless, grantId: g }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_other_grant' });
    expect(await analysisContinuationOf({ orgId: t.orgA, runId: grantless }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_other_grant' });
    expect(await analysisContinuationOf({ orgId: t.orgA, runId: notAnalysis, grantId: g }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_wrong_kind' });
    expect(await analysisContinuationOf({ orgId: t.orgA, runId: running, grantId: g }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_not_settled' });
    // 'expired' is terminal but is not a continuable status (completed/failed/cancelled only).
    expect(await analysisContinuationOf({ orgId: t.orgA, runId: expired, grantId: g }))
      .toEqual({ ok: false, refusal: 'analysis_continuation_not_settled' });
  });
});

// ---------------------------------------------------------------------------

describe('handle derivation', () => {
  const EXPORTS: AiRunExportGrants = { datasets: ['devices'], sensitiveGates: [] };

  it('accumulates across three runs and excludes step kinds and non-export captures', async () => {
    const t = await seedTenant();
    const g = t.grantG;
    // run1 (root) produced: export A, output B, step_script C, capture D by another tool.
    const run1 = await insertRun(t, t.orgA, { grant: g });
    const A = await insertArtifact(t.orgA, run1, { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'devices' });
    const B = await insertArtifact(t.orgA, run1, { kind: 'output', createdByTool: 'workspace_collect' });
    await insertArtifact(t.orgA, run1, { kind: 'step_script', createdByTool: 'workspace_run' });
    await insertArtifact(t.orgA, run1, { kind: 'input_capture', createdByTool: 'search_logs' });
    // run2 (depth 1) staged [A, B] and produced output E plus a step_stdout and a non-export capture.
    const run2 = await insertRun(t, t.orgA, {
      grant: g, continuedFromRunId: run1, chainRootRunId: run1, chainDepth: 1,
      stagedInputs: { handles: [A, B], deviceIds: [], region: 'us' },
    });
    const E = await insertArtifact(t.orgA, run2, { kind: 'output', createdByTool: 'workspace_collect' });
    await insertArtifact(t.orgA, run2, { kind: 'step_stdout', createdByTool: 'workspace_run' });
    await insertArtifact(t.orgA, run2, { kind: 'input_capture', createdByTool: 'search_logs' });

    const prior2 = await analysisContinuationOf({ orgId: t.orgA, runId: run2, grantId: g.grantId });
    if (!prior2.ok) throw new Error(`prior2 refused: ${prior2.refusal}`);
    const d2 = await deriveChainHandles({ orgId: t.orgA, prior: prior2.prior, grantId: g.grantId, exportGrants: EXPORTS });
    expect(sorted(d2.handles)).toEqual(sorted([A, B, E]));
    expect(d2.dropped).toEqual([]);

    // run3 (depth 2) stages everything derived so far and produces output F.
    const run3 = await insertRun(t, t.orgA, {
      grant: g, continuedFromRunId: run2, chainRootRunId: run1, chainDepth: 2,
      stagedInputs: { handles: d2.handles, deviceIds: [], region: 'us' },
    });
    const F = await insertArtifact(t.orgA, run3, { kind: 'output', createdByTool: 'workspace_collect' });
    const prior3 = await analysisContinuationOf({ orgId: t.orgA, runId: run3, grantId: g.grantId });
    if (!prior3.ok) throw new Error(`prior3 refused: ${prior3.refusal}`);
    const d3 = await deriveChainHandles({ orgId: t.orgA, prior: prior3.prior, grantId: g.grantId, exportGrants: EXPORTS });
    expect(sorted(d3.handles)).toEqual(sorted([A, B, E, F]));
    expect(d3.dropped).toEqual([]);
  });

  it('drops a handle produced under another grant or outside the chain (and kind, expired, swept)', async () => {
    const t = await seedTenant();
    const g = t.grantG;
    const root = await insertRun(t, t.orgA, { grant: g });
    // A stranger: same grant, but a different chain.
    const stranger = await insertRun(t, t.orgA, { grant: g });
    const X = await insertArtifact(t.orgA, stranger, { kind: 'output', createdByTool: 'workspace_collect' });
    // In this chain but produced under ANOTHER grant.
    const otherGrantRun = await insertRun(t, t.orgA, {
      grant: t.grantG2, continuedFromRunId: root, chainRootRunId: root, chainDepth: 1,
    });
    const Y = await insertArtifact(t.orgA, otherGrantRun, { kind: 'output', createdByTool: 'workspace_collect' });
    // In this chain and grant, but the wrong kind / already expired.
    const Z = await insertArtifact(t.orgA, root, { kind: 'step_script', createdByTool: 'workspace_run' });
    const W = await insertArtifact(t.orgA, root, {
      kind: 'output', createdByTool: 'workspace_collect', expiresAt: new Date(Date.now() - DAY_MS),
    });
    const V = randomUUID(); // a handle whose row was swept
    const prior = await insertRun(t, t.orgA, {
      grant: g, continuedFromRunId: root, chainRootRunId: root, chainDepth: 1,
      stagedInputs: { handles: [X, Y, Z, W, V], deviceIds: [], region: 'us' },
    });
    const P = await insertArtifact(t.orgA, prior, { kind: 'output', createdByTool: 'workspace_collect' });

    const p = await analysisContinuationOf({ orgId: t.orgA, runId: prior, grantId: g.grantId });
    if (!p.ok) throw new Error(`prior refused: ${p.refusal}`);
    const d = await deriveChainHandles({ orgId: t.orgA, prior: p.prior, grantId: g.grantId, exportGrants: EXPORTS });
    expect(d.handles).toEqual([P]);
    expect(sorted(d.dropped.map((x) => `${x.handle}:${x.reason}`))).toEqual(sorted([
      `${X}:outside_chain`,
      `${Y}:other_grant`,
      `${Z}:kind`,
      `${W}:expired`,
      `${V}:expired`,
    ]));
  });

  it("drops an inherited export whose dataset this launch's exportGrants no longer permit", async () => {
    const t = await seedTenant();
    const g = t.grantG;
    const root = await insertRun(t, t.orgA, { grant: g });
    const permitted = await insertArtifact(t.orgA, root, { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'devices' });
    const notPermitted = await insertArtifact(t.orgA, root, { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'alerts' });
    // A pre-W03 export: no dataset recorded, so it can never be proven permitted.
    const preW03 = await insertArtifact(t.orgA, root, { kind: 'input_capture', createdByTool: 'export_dataset', dataset: null });
    const prior = await insertRun(t, t.orgA, {
      grant: g, continuedFromRunId: root, chainRootRunId: root, chainDepth: 1,
      stagedInputs: { handles: [permitted, notPermitted, preW03], deviceIds: [], region: 'us' },
    });
    const p = await analysisContinuationOf({ orgId: t.orgA, runId: prior, grantId: g.grantId });
    if (!p.ok) throw new Error(`prior refused: ${p.refusal}`);

    const d = await deriveChainHandles({ orgId: t.orgA, prior: p.prior, grantId: g.grantId, exportGrants: EXPORTS });
    expect(d.handles).toEqual([permitted]);
    expect(sorted(d.dropped.map((x) => `${x.handle}:${x.reason}`))).toEqual(sorted([
      `${notPermitted}:dataset_not_permitted`,
      `${preW03}:dataset_not_permitted`,
    ]));

    // The launch's grants shrank to nothing: even the formerly permitted export goes.
    const none = await deriveChainHandles({
      orgId: t.orgA, prior: p.prior, grantId: g.grantId, exportGrants: { datasets: [], sensitiveGates: [] },
    });
    expect(none.handles).toEqual([]);
    expect(none.dropped).toHaveLength(3);
    expect(none.dropped.every((x) => x.reason === 'dataset_not_permitted')).toBe(true);
  });
});

describe('handle derivation: the producer run\'s frozen export grants', () => {
  it('a later launch with a narrower gate set does not inherit a file exported or derived under the wider one', async () => {
    const t = await seedTenant();
    const g = t.grantG;
    const WIDE: AiRunExportGrants = { datasets: ['event_logs'], sensitiveGates: ['security_events'] };
    const NARROW: AiRunExportGrants = { datasets: ['event_logs'], sensitiveGates: [] };
    // The root ran under the security_events gate and exported event_logs, then derived an output.
    const root = await insertRun(t, t.orgA, { grant: g, exportGrants: WIDE });
    const exported = await insertArtifact(t.orgA, root, { kind: 'input_capture', createdByTool: 'export_dataset', dataset: 'event_logs' });
    const derived = await insertArtifact(t.orgA, root, { kind: 'output', createdByTool: 'workspace_collect' });
    // A first continuation still held the gate, so it inherited both, and produced its own output.
    const run2 = await insertRun(t, t.orgA, {
      grant: g, continuedFromRunId: root, chainRootRunId: root, chainDepth: 1, exportGrants: WIDE,
      stagedInputs: { handles: [exported, derived], deviceIds: [], region: 'us' },
    });
    const own = await insertArtifact(t.orgA, run2, { kind: 'output', createdByTool: 'workspace_collect' });
    const p = await analysisContinuationOf({ orgId: t.orgA, runId: run2, grantId: g.grantId });
    if (!p.ok) throw new Error(`prior refused: ${p.refusal}`);

    const wide = await deriveChainHandles({ orgId: t.orgA, prior: p.prior, grantId: g.grantId, exportGrants: WIDE });
    expect(sorted(wide.handles)).toEqual(sorted([exported, derived, own]));
    expect(wide.dropped).toEqual([]);

    // The live ceiling has since lost the gate: the same dataset list, no security_events.
    const narrow = await deriveChainHandles({ orgId: t.orgA, prior: p.prior, grantId: g.grantId, exportGrants: NARROW });
    expect(narrow.handles).toEqual([]);
    expect(sorted(narrow.dropped.map((x) => `${x.handle}:${x.reason}`))).toEqual(sorted([
      `${exported}:grants_not_covered`, `${derived}:grants_not_covered`, `${own}:grants_not_covered`,
    ]));
  });

  it('a producer with no frozen grants recorded fails closed', async () => {
    const t = await seedTenant();
    const g = t.grantG;
    const root = await insertRun(t, t.orgA, { grant: g, stagedInputs: null });
    const out = await insertArtifact(t.orgA, root, { kind: 'output', createdByTool: 'workspace_collect' });
    const p = await analysisContinuationOf({ orgId: t.orgA, runId: root, grantId: g.grantId });
    if (!p.ok) throw new Error(`prior refused: ${p.refusal}`);
    const d = await deriveChainHandles({
      orgId: t.orgA, prior: p.prior, grantId: g.grantId,
      exportGrants: { datasets: ['event_logs'], sensitiveGates: ['security_events'] },
    });
    expect(d).toEqual({ handles: [], dropped: [{ handle: out, reason: 'grants_not_covered' }] });
  });
});

// ---------------------------------------------------------------------------

describe('chain bounds (real Postgres, real advisory locks)', () => {
  let t: Tenant;
  const GRANTS: AiRunExportGrants = { datasets: ['event_logs', 'metrics'], sensitiveGates: [] };

  const frame = (tt: Tenant) => ({
    scope: 'devices' as const, siteId: null, deviceIds: [tt.deviceA], inputHandles: [] as string[], exportGrants: GRANTS,
  });
  /** Every chain run is grant-bearing, as in production: a grant-less run is never continued. */
  const grantRef = (g: { grantId: string; revisionId: string }) => ({ grantId: g.grantId, grantRevisionId: g.revisionId });
  const analysisInput = (over: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput => ({
    orgId: t.orgA,
    kind: 'triage',
    triggerKind: 'manual',
    deviceId: null,
    dedupeKey: `manual:chain:${randomUUID()}`,
    profile: 'analysis',
    triggerRef: { source: 'chat_analysis' },
    analysis: frame(t),
    grant: grantRef(t.grantG),
    ...over,
  });
  /** A continuation of `fromRunId` (depth `depth`) of the chain rooted at `root`, as admitAnalysisRun builds it. */
  const next = (root: string, fromRunId = root, depth = 1, grant = t.grantG) => createAndEnqueueAgentRun(analysisInput({
    grant: grantRef(grant),
    triggerRef: { source: 'chat_analysis', continuation: { fromRunId, seed: 'S', dropped: [] } },
    analysis: { ...frame(t), continuation: { fromRunId, chainRootRunId: root, chainDepth: depth } },
  }));
  const admitted = (r: CreateAgentRunResult) => {
    if (!r.created) throw new Error(`expected admission, got skip "${r.skipped}"`);
    return r.run;
  };
  const skipped = (r: CreateAgentRunResult) => (r.created ? null : r.skipped);
  /** Settle a run directly: only a settled analysis run can be continued. */
  const settle = (runId: string, costCents = 0, computeCents = 0) => getTestDb().update(aiAgentRuns)
    .set({ status: 'completed', costCents, computeCents, finishedAt: new Date() } as never)
    .where(eq(aiAgentRuns.id, runId));
  /** Admit the chain root under grant G and settle it at `cost` + `compute`. */
  const admitSettledRoot = async (costCents = 0, computeCents = 0) => {
    const root = admitted(await createAndEnqueueAgentRun(analysisInput())).id;
    await settle(root, costCents, computeCents);
    return root;
  };
  /** A sibling inserted directly into the chain of `root`, still queued, with the given snapshot. */
  const insertQueuedSibling = (root: string, policySnapshot: Record<string, unknown>) => insertRun(t, t.orgA, {
    status: 'queued', grant: t.grantG, continuedFromRunId: root, chainRootRunId: root, chainDepth: 1, policySnapshot,
  });

  it('two continuations at the run-count limit admit exactly one', async () => {
    // analysisMaxChainRuns: 2. The (settled) root is run 1 of 2. Whichever
    // continuation takes the lock first sees runCount 1 (< 2) and is admitted;
    // the second sees runCount 2 (>= 2) and is refused analysis_chain_too_long.
    t = await seedTenant({ analysisMaxChainRuns: 2 });
    const root = await admitSettledRoot();
    const results = await Promise.all([next(root), next(root)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => skipped(r) === 'analysis_chain_too_long')).toHaveLength(1);
  });

  it('an unsettled sibling counts at its full allowance: two at the budget limit admit exactly one', async () => {
    // analysisMaxChainBudgetCents: 300; per-run allowance = 150 + 25 = 175 (defaults).
    // Root settled at 0. First continuation: 0 + 175 = 175 <= 300, admitted
    // (queued). Second: committed 0 + 175 (queued sibling at its allowance)
    // = 175, + 175 = 350 > 300, refused. Counted at actual spend (0) instead,
    // the second would see 0 + 0 + 175 = 175 <= 300 and both would admit.
    t = await seedTenant({ analysisMaxChainBudgetCents: 300 });
    const root = await admitSettledRoot();
    const results = await Promise.all([next(root), next(root)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.filter((r) => skipped(r) === 'analysis_chain_budget_exceeded')).toHaveLength(1);
  });

  it('a settled run counts its actual cost_cents + compute_cents', async () => {
    // analysisMaxChainBudgetCents: 400; allowance 175. The root settles at
    // cost 10 + compute 5 = 15 (compute_cents wins over its 25 reservation).
    //   continuation 1: 15 + 175 = 190 <= 400 -> admitted (now queued, counts 175)
    //   continuation 2: (15 + 175) + 175 = 365 <= 400 -> admitted
    //   continuation 3: (15 + 175 + 175) + 175 = 540 > 400 -> analysis_chain_budget_exceeded
    // Counted at its allowance (175) the root would refuse continuation 2
    // (175 + 175 + 175 = 525 > 400), so this pins settled-at-actual.
    t = await seedTenant({ analysisMaxChainBudgetCents: 400 });
    const root = await admitSettledRoot(10, 5);
    admitted(await next(root));
    admitted(await next(root));
    expect(skipped(await next(root))).toBe('analysis_chain_budget_exceeded');
  });

  it('a sibling whose snapshot lacks or garbles the analysis limits counts at the default allowance', async () => {
    // analysisMaxChainBudgetCents: 525; default allowance 150 + 25 = 175.
    // Root settled at 0. Siblings: A (limits are strings) = 175; B (no
    // `effective` at all) = 175. Committed 350.
    //   continuation 1: 350 + 175 = 525, not > 525 -> admitted, with no cast
    //   error from the non-numeric value (admission would throw otherwise).
    //   continuation 2: (350 + 175) + 175 = 700 > 525 -> analysis_chain_budget_exceeded.
    // Had A counted 0, continuation 2 would see (0 + 175 + 175) + 175 = 525
    // and admit too; had a sibling counted above 175, continuation 1 would be refused.
    t = await seedTenant({ analysisMaxChainBudgetCents: 525 });
    const root = await admitSettledRoot();
    await insertQueuedSibling(root, {
      schemaVersion: 1,
      effective: { limits: { analysisMaxBudgetCentsPerRun: 'abc', analysisMaxComputeCentsPerRun: 'xyz' } },
    });
    await insertQueuedSibling(root, { schemaVersion: 1 });
    const first = await next(root);
    expect(skipped(first)).toBeNull();
    admitted(first);
    expect(skipped(await next(root))).toBe('analysis_chain_budget_exceeded');
  });

  it('the admitted continuation carries continued_from_run_id, chain_root_run_id and chain_depth', async () => {
    t = await seedTenant();
    const root = await admitSettledRoot();
    expect(await readRun(root)).toMatchObject({ continuedFromRunId: null, chainRootRunId: null, chainDepth: 0 });
    const c1 = admitted(await next(root));
    expect(await readRun(c1.id)).toMatchObject({
      orgId: t.orgA, continuedFromRunId: root, chainRootRunId: root, chainDepth: 1,
    });
    // An unsettled prior cannot be continued, even under the lock.
    expect(skipped(await next(root, c1.id, 2))).toBe('analysis_continuation_not_found');
    await settle(c1.id);
    // A continuation of a continuation: pointer to its prior, root stays the
    // chain root, depth is prior depth + 1.
    const c2 = admitted(await next(root, c1.id, 2));
    expect(await readRun(c2.id)).toMatchObject({
      orgId: t.orgA, continuedFromRunId: c1.id, chainRootRunId: root, chainDepth: 2,
    });
    // A lineage that disagrees with the prior's is refused and writes no row.
    expect(skipped(await next(c1.id, c1.id, 2))).toBe('analysis_continuation_not_found'); // wrong root (c1 is not the root)
    expect(skipped(await next(root, c1.id, 5))).toBe('analysis_continuation_not_found');  // wrong depth (prior depth 1 + 1 != 5)
  });

  it('a continuation under another grant than the prior is refused under the lock', async () => {
    t = await seedTenant();
    const root = await admitSettledRoot();
    expect(skipped(await next(root, root, 1, t.grantG2))).toBe('analysis_continuation_not_found');
    admitted(await next(root, root, 1, t.grantG));
  });

  it('a prior whose chain root was deleted keeps its depth and refuses analysis_chain_too_long', async () => {
    // Built directly (no admission rows hang off it), so the root can be deleted.
    t = await seedTenant();
    const root = await insertRun(t, t.orgA, { grant: t.grantG });
    const mid = await insertRun(t, t.orgA, { grant: t.grantG, continuedFromRunId: root, chainRootRunId: root, chainDepth: 1 });
    await getTestDb().delete(aiAgentRuns).where(eq(aiAgentRuns.id, root));
    // ON DELETE SET NULL (<pointer>) cleared both pointers; org and depth survive, the CHECK holds.
    expect(await readRun(mid)).toMatchObject({ orgId: t.orgA, continuedFromRunId: null, chainRootRunId: null, chainDepth: 1 });
    // Treating it as a new root would reset every chain bound.
    expect(skipped(await next(root, mid, 2))).toBe('analysis_chain_too_long');
    expect(skipped(await next(mid, mid, 2))).toBe('analysis_chain_too_long');
  });
});

describe('admitAnalysisRun with inherited handles (real forced RLS)', () => {
  it('resolves staged handles in a system context, so a real derived handle admits', async () => {
    const t = await seedTenant();
    const prior = await insertRun(t, t.orgA, { grant: t.grantG });
    const handle = await insertArtifact(t.orgA, prior, { kind: 'output', createdByTool: 'workspace_collect' });
    // The launcher calls admission outside any request DB context; a
    // contextless read under forced RLS would see no artifact rows.
    const result = await admitAnalysisRun({
      orgId: t.orgA,
      requestedByUserId: t.userId,
      sessionId: null,
      goal: 'continue',
      scope: 'devices',
      deviceIds: [t.deviceA],
      siteId: null,
      stagedHandles: [handle],
      dedupeKey: `chain-it-admit-${randomUUID()}`,
      grant: { grantId: t.grantG.grantId, grantRevisionId: t.grantG.revisionId },
      exportGrants: { datasets: ['event_logs'], sensitiveGates: [] },
      continuation: { fromRunId: prior, chainRootRunId: prior, chainDepth: 1, seed: 'S', dropped: [] },
    });
    expect(result).toMatchObject({ created: true });
    const run = await readRun((result as { runId: string }).runId);
    expect(run).toMatchObject({ continuedFromRunId: prior, chainRootRunId: prior, chainDepth: 1 });
    expect((run!.stagedInputs as { handles: string[] }).handles).toEqual([handle]);
    expect((run!.triggerRef as { continuation: unknown }).continuation).toEqual({ fromRunId: prior, seed: 'S', dropped: [] });
  });

  it('refuses a handle of another org as artifact_forbidden', async () => {
    const t = await seedTenant();
    const foreignRun = await insertRun(t, t.orgB, {});
    const foreign = await insertArtifact(t.orgB, foreignRun, { kind: 'output', createdByTool: 'workspace_collect' });
    await expect(admitAnalysisRun({
      orgId: t.orgA, requestedByUserId: t.userId, sessionId: null, goal: 'g', scope: 'devices',
      deviceIds: [t.deviceA], siteId: null, stagedHandles: [foreign], dedupeKey: `chain-it-admit-${randomUUID()}`,
      grant: { grantId: t.grantG.grantId, grantRevisionId: t.grantG.revisionId },
      exportGrants: { datasets: ['event_logs'], sensitiveGates: [] },
    })).resolves.toEqual({ created: false, refusal: 'artifact_forbidden' });
  });
});
