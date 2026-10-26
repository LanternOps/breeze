/**
 * W5 PR C (#5220), Task C6 — flows as tools against REAL Postgres: the
 * owner predicate of the flow-tool read (an org caller never sees a sibling
 * org's flow), a partner-wide flow tool started from org B runs in org B, the
 * release of a chat Tier-3 invoked-flow intent creates a `tool` run as the
 * approver, an agent Tier-1 call creates an `ai_agent` tool run, and the W5
 * flow_runs CHECKs + the invoked_flow_id immutability hold in SQL. The branch
 * logic is unit-tested (flowTools / toolRuns / flowToolRelease tests).
 */
import './setup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice: vi.fn(async () => 'job') }));

// The live tier recompute reads the core tool registry (as the running API
// does): populate it.
import '../../services/aiTools';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents, flowRuns, flows, type ActionIntent } from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { resolveFlowToolForCall, resolveFlowTools } from '../../services/flows/flowTools';
import { startToolRun } from '../../services/flows/toolRuns';
import { releaseFlowToolIntent } from '../../services/flows/flowToolRelease';
import {
  assignUserToOrganization, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';
import { seedEnabledFlow } from './helpers/flowSeed';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// A real Tier-1 step (the `set` built-in): the live tier recompute resolves
// it against the owner's catalog, so a vanished tool would read as Tier 3.
const PIN = { stepId: 'look', tool: 'set', source: 'builtin', tier: 1, approvalScope: null } as const;
const STEP = { id: 'look', tool: 'set', input: { values: { greeting: 'hi' } }, approval: 'default', onFailure: 'stop', timeoutSec: 300 };
const manualDoc = (name: string) => ({ version: 1, name, trigger: { type: 'manual' }, inputs: [], steps: [STEP] });

function orgAuth(userId: string, orgId: string, partnerId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    scope: 'organization',
    orgId,
    partnerId,
    partnerOrgAccess: null,
    accessibleOrgIds: [orgId],
    ...buildOrgAccessClosures([orgId]),
    user: { id: userId, email: `${userId}@flowtools.test` },
  } as unknown as AuthContext;
}

async function orgUser(partnerId: string, orgId: string): Promise<string> {
  const user = await createUser({ partnerId, orgId, email: `u-${randomUUID()}@flowtools.test` });
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  await assignUserToOrganization(user.id, orgId, role.id);
  return user.id;
}

async function tenant() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const userA = await orgUser(partner.id, orgA.id);
  const userB = await orgUser(partner.id, orgB.id);
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, userA, userB };
}

async function slugOf(flowId: string): Promise<string> {
  const [row] = await withSystemDbAccessContext(() => db.select({ slug: flows.slug }).from(flows).where(eq(flows.id, flowId)));
  return row!.slug;
}

function runsOf(flowId: string) {
  return withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

let prevFlag: string | undefined;
beforeAll(() => {
  prevFlag = process.env.FLOWS_ENABLED;
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.FLOWS_ENABLED;
  else process.env.FLOWS_ENABLED = prevFlag;
});

describe('flows as tools (real Postgres)', () => {
  runDb('resolveFlowTools for an org token returns no flow of a sibling org; partner-wide flows of its partner are listed', async () => {
    const t = await tenant();
    const own = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.userA, definition: manualDoc('Own'), pins: [PIN] });
    const sibling = await seedEnabledFlow({ orgId: t.orgB, partnerId: t.partnerId, delegatorUserId: t.userB, definition: manualDoc('Sibling'), pins: [PIN] });
    const pw = await seedEnabledFlow({ owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.userA, definition: manualDoc('Partner wide'), pins: [PIN] });

    const names = (await resolveFlowTools(orgAuth(t.userA, t.orgA, t.partnerId), t.orgA)).map((d) => d.name);
    expect(names).toContain(`flow__${await slugOf(own.flowId)}`);
    expect(names).toContain(`flow__${await slugOf(pw.flowId)}`);
    expect(names).not.toContain(`flow__${await slugOf(sibling.flowId)}`);
    // The sibling's flow does not resolve by name either.
    expect(await resolveFlowToolForCall(orgAuth(t.userA, t.orgA, t.partnerId), `flow__${await slugOf(sibling.flowId)}`, t.orgA)).toBeNull();
  });

  runDb('a partner-wide flow tool started by an org-B session runs in org B (tool / ai_tool, no pre-approvals)', async () => {
    const t = await tenant();
    const pw = await seedEnabledFlow({ owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.userA, definition: manualDoc('Partner wide'), pins: [PIN] });
    const authB = orgAuth(t.userB, t.orgB, t.partnerId);
    const d = await resolveFlowToolForCall(authB, `flow__${await slugOf(pw.flowId)}`, t.orgB);
    expect(d).toMatchObject({ tier: 1, partnerWide: true, publicationId: pw.publicationId });

    const r = await startToolRun(d!, {}, 'ai_tool', { kind: 'user', auth: authB }, { defaultOrgId: t.orgB });
    expect(r).toMatchObject({ ok: true, duplicate: false });
    const [row] = await runsOf(pw.flowId);
    expect(row).toMatchObject({
      orgId: t.orgB, triggerKind: 'tool', triggeredVia: 'ai_tool', preApprovalsHonored: false,
      triggeredByUserId: t.userB, parentAgentRunId: null, triggeredByApiKeyId: null, flowVersionId: pw.publicationId,
    });
  });

  runDb('releaseFlowToolIntent on a real chat intent creates a tool run as the approver; invoked_flow_id is immutable', async () => {
    const t = await tenant();
    const own = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.userA, definition: manualDoc('Approved'), pins: [PIN] });
    const toolName = `flow__${await slugOf(own.flowId)}`;
    const args = { inputs: {}, orgId: t.orgA, idempotencyKey: null };
    const [intent] = await withSystemDbAccessContext(() => db.insert(actionIntents).values({
      orgId: t.orgA,
      partnerId: t.partnerId,
      requestedByUserId: t.userA,
      requestingApiKeyId: null,
      source: 'chat',
      originPrincipalKind: 'user_session',
      originPrincipalId: t.userA,
      actionName: toolName,
      actionVersion: 1,
      arguments: args,
      argumentDigest: 'b'.repeat(64),
      targetSummary: `Run flow "Approved" (${toolName})`,
      impactSummary: 'Starts flow "Approved" with inputs: (none).',
      reason: null,
      riskTier: 3,
      approvalScope: 'supervised',
      invokedFlowId: own.flowId,
      toolRevision: `flowpub:${own.publicationId}`,
      idempotencyKey: `flowtool-${randomUUID()}`,
      correlationId: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      decidedByUserId: t.userA,
    } as never).returning());

    const released = await releaseFlowToolIntent(intent as ActionIntent, orgAuth(t.userA, t.orgA, t.partnerId));
    expect(released).toMatchObject({ ok: true });
    const [row] = await runsOf(own.flowId);
    expect(row).toMatchObject({ orgId: t.orgA, triggerKind: 'tool', triggeredVia: 'ai_tool', triggeredByUserId: t.userA, preApprovalsHonored: false });
    // A redelivered release dedupes onto the same run (the intent id is the key).
    const again = await releaseFlowToolIntent(intent as ActionIntent, orgAuth(t.userA, t.orgA, t.partnerId));
    expect(again).toMatchObject({ ok: true, result: { runId: (released as { result: { runId: string } }).result.runId, duplicate: true } });

    let caught: unknown;
    try {
      await withSystemDbAccessContext(() => db.update(actionIntents).set({ invokedFlowId: randomUUID() }).where(eq(actionIntents.id, intent!.id)));
    } catch (err) {
      caught = err;
    }
    expect(caught, 'invoked_flow_id must be immutable').toBeDefined();
  });

  runDb('an agent tier-1 call creates a tool run with triggered_via ai_agent and its parent run', async () => {
    const t = await tenant();
    const own = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.userA, definition: manualDoc('Agent read'), pins: [PIN] });
    const agentRunId = randomUUID();
    const agentAuth = { principal: { kind: 'ai_agent', agentId: randomUUID(), runId: agentRunId }, scope: 'organization', orgId: t.orgA, partnerId: t.partnerId, ...buildOrgAccessClosures([t.orgA]), accessibleOrgIds: [t.orgA], user: { id: randomUUID() } } as unknown as AuthContext;
    const d = await resolveFlowToolForCall(agentAuth, `flow__${await slugOf(own.flowId)}`, t.orgA);
    expect(d?.tier).toBe(1);
    const r = await startToolRun(d!, {}, 'ai_agent', { kind: 'agent_tier1', agentRunId, orgId: t.orgA }, { parentAgentRunId: agentRunId });
    expect(r).toMatchObject({ ok: true });
    const [row] = await runsOf(own.flowId);
    expect(row).toMatchObject({ triggerKind: 'tool', triggeredVia: 'ai_agent', parentAgentRunId: agentRunId, triggeredByUserId: null, preApprovalsHonored: false });
  });

  runDb('the W5 CHECKs refuse an ai_agent run without its parent and an mcp lane on a manual run (23514)', async () => {
    const t = await tenant();
    const own = await seedEnabledFlow({ orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.userA, definition: manualDoc('Checks'), pins: [PIN] });
    const insert = (kind: string, via: string, parent: string | null) => withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO flow_runs (org_id, flow_id, flow_version_id, definition_version, trigger_kind, triggered_via,
        trigger_payload, inputs, status, pre_approvals_honored, dedupe_key, chain_depth, parent_agent_run_id)
      VALUES (${t.orgA}, ${own.flowId}, ${own.publicationId}, 1, ${kind}, ${via},
        '{}'::jsonb, '{}'::jsonb, 'queued', false, ${`chk:${randomUUID()}`}, 0, ${parent})`));
    for (const [kind, via, parent] of [['tool', 'ai_agent', null], ['manual', 'mcp', null]] as const) {
      let caught: unknown;
      try {
        await insert(kind, via, parent);
      } catch (err) {
        caught = err;
      }
      expect(pgCode(caught), `${kind}/${via}`).toBe('23514');
    }
    // Control: the valid shape inserts.
    await expect(insert('tool', 'ai_agent', randomUUID())).resolves.toBeDefined();
  });
});
