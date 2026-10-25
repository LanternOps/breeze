/**
 * Tool catalog W04 (#5219) — real-Postgres seeding of an ENABLED flow, its
 * live publication, a run and the in-flight step row, plus the "park" write
 * the runner makes when a Tier-3 step's intent is minted. Shared by the A5
 * approval/claim integration cases and the A12 suites.
 *
 * Writes run in system scope (`withSystemDbAccessContext`), like the other
 * integration seeds. Every flow_runs / flow_run_steps CHECK is respected
 * (see migrations/2027-01-06-130000-flow-runs.sql).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../../db';
import { flowRuns, flowRunSteps, flowVersions, flows } from '../../../db/schema';
import type { FlowStepPin } from '../../../services/flowValidator';

export interface SeedFlowRunOptions {
  orgId: string;
  partnerId: string;
  /** The publication's delegator (flow_versions.enabled_by_user_id). */
  delegatorUserId: string;
  /** A manual run's human (flow_runs.triggered_by_user_id); null ⇒ a schedule run. */
  triggeredByUserId?: string | null;
  /** Owner: the org (default) or the partner (partner-wide flow). */
  owner?: 'org' | 'partner';
  stepId?: string;
  tool: string;
  stepInput?: Record<string, unknown>;
  pin: FlowStepPin;
  flowName?: string;
}

export interface SeededFlowRun {
  flowId: string;
  publicationId: string;
  runId: string;
  stepRowId: string;
  stepId: string;
  flowName: string;
}

export async function seedEnabledFlowRun(opts: SeedFlowRunOptions): Promise<SeededFlowRun> {
  const stepId = opts.stepId ?? 'cleanup';
  const flowName = opts.flowName ?? 'Disk cleanup';
  const partnerWide = opts.owner === 'partner';
  const definition = {
    version: 1,
    trigger: { kind: 'manual' },
    steps: [{ id: stepId, tool: opts.tool, input: opts.stepInput ?? {} }],
  };
  return withSystemDbAccessContext(async () => {
    const [flow] = await db
      .insert(flows)
      .values({
        orgId: partnerWide ? null : opts.orgId,
        partnerId: partnerWide ? opts.partnerId : null,
        slug: `seed_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        name: flowName,
        definition,
        effectiveTier: opts.pin.tier,
      })
      .returning({ id: flows.id });
    const [publication] = await db
      .insert(flowVersions)
      .values({
        flowId: flow!.id,
        orgId: partnerWide ? null : opts.orgId,
        partnerId: partnerWide ? opts.partnerId : null,
        publicationSeq: 1,
        definitionVersion: 1,
        definition,
        effectiveTier: opts.pin.tier,
        stepPins: [opts.pin as unknown as Record<string, unknown>],
        preApprovals: [],
        enabledByUserId: opts.delegatorUserId,
      })
      .returning({ id: flowVersions.id });
    await db
      .update(flows)
      .set({ status: 'enabled', enabledPublicationSeq: 1, enabledByUserId: opts.delegatorUserId, enabledAt: new Date() })
      .where(eq(flows.id, flow!.id));

    const triggeredBy = opts.triggeredByUserId ?? null;
    const [run] = await db
      .insert(flowRuns)
      .values({
        orgId: opts.orgId,
        flowId: flow!.id,
        flowVersionId: publication!.id,
        definitionVersion: 1,
        triggerKind: triggeredBy ? 'manual' : 'schedule',
        triggeredVia: triggeredBy ? 'ui' : 'scheduler',
        triggerPayload: {},
        inputs: {},
        status: 'running',
        preApprovalsHonored: false,
        dedupeKey: `seed:${randomUUID()}`,
        triggeredByUserId: triggeredBy,
        currentStepId: stepId,
        startedAt: new Date(),
      })
      .returning({ id: flowRuns.id });
    const [step] = await db
      .insert(flowRunSteps)
      .values({
        runId: run!.id,
        orgId: opts.orgId,
        stepId,
        tool: opts.tool,
        toolSource: opts.pin.source,
        tier: opts.pin.tier,
        status: 'running',
        renderedInput: opts.stepInput ?? {},
      })
      .returning({ id: flowRunSteps.id });
    return {
      flowId: flow!.id,
      publicationId: publication!.id,
      runId: run!.id,
      stepRowId: step!.id,
      stepId,
      flowName,
    };
  });
}

/**
 * Task A9 — an ENABLED flow with a live publication of `definition` and no
 * run (the trigger suites create the runs). Org-owned by default; `owner:
 * 'partner'` makes it partner-wide.
 */
export async function seedEnabledFlow(opts: {
  partnerId: string;
  orgId?: string;
  owner?: 'org' | 'partner';
  delegatorUserId: string;
  definition: Record<string, unknown>;
  pins: FlowStepPin[];
  enabledAt?: Date;
}): Promise<{ flowId: string; publicationId: string }> {
  const partnerWide = opts.owner === 'partner';
  if (!partnerWide && !opts.orgId) throw new Error('seedEnabledFlow: an org flow needs orgId');
  const tier = Math.max(1, ...opts.pins.map((p) => p.tier)) as 1 | 2 | 3;
  return withSystemDbAccessContext(async () => {
    const [flow] = await db
      .insert(flows)
      .values({
        orgId: partnerWide ? null : opts.orgId!,
        partnerId: partnerWide ? opts.partnerId : null,
        slug: `seed_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        name: String(opts.definition.name ?? 'Seeded flow'),
        definition: opts.definition,
        effectiveTier: tier,
      })
      .returning({ id: flows.id });
    const [publication] = await db
      .insert(flowVersions)
      .values({
        flowId: flow!.id,
        orgId: partnerWide ? null : opts.orgId!,
        partnerId: partnerWide ? opts.partnerId : null,
        publicationSeq: 1,
        definitionVersion: 1,
        definition: opts.definition,
        effectiveTier: tier,
        stepPins: opts.pins as unknown as Record<string, unknown>[],
        preApprovals: [],
        enabledByUserId: opts.delegatorUserId,
      })
      .returning({ id: flowVersions.id });
    await db
      .update(flows)
      .set({ status: 'enabled', enabledPublicationSeq: 1, enabledByUserId: opts.delegatorUserId, enabledAt: opts.enabledAt ?? new Date() })
      .where(eq(flows.id, flow!.id));
    return { flowId: flow!.id, publicationId: publication!.id };
  });
}

/** The runner's park write (Task A8 step 7, `park_approval`): step + run → awaiting_approval on `intentId`. */
export async function parkFlowRunOnIntent(seed: SeededFlowRun, intentId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db
      .update(flowRunSteps)
      .set({ status: 'awaiting_approval', approvalMode: 'intent', actionIntentId: intentId })
      .where(and(eq(flowRunSteps.id, seed.stepRowId), eq(flowRunSteps.runId, seed.runId)));
    await db
      .update(flowRuns)
      .set({ status: 'awaiting_approval', currentStepId: seed.stepId, resumeSeq: 1, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
      .where(eq(flowRuns.id, seed.runId));
  });
}

export async function readFlowRunState(seed: SeededFlowRun) {
  return withSystemDbAccessContext(async () => {
    const [run] = await db.select().from(flowRuns).where(eq(flowRuns.id, seed.runId)).limit(1);
    const [step] = await db.select().from(flowRunSteps).where(eq(flowRunSteps.id, seed.stepRowId)).limit(1);
    const [flow] = await db.select().from(flows).where(eq(flows.id, seed.flowId)).limit(1);
    return { run: run!, step: step!, flow: flow! };
  });
}
