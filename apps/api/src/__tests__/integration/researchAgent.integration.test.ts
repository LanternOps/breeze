import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiAgentRuns, aiAgents, alerts, deviceCommands, deviceFilesystemCleanupRuns, devices, fixOutcomes, remediationSuggestions, scripts,
} from '../../db/schema';
import { advanceOutcome } from '../../services/fixMemory/outcomeWatcher';
import { recordBuiltinOutcome } from '../../services/fixMemory/outcomeRecorder';
import { handleAlertTriggeredForFixMemory } from '../../services/fixMemory/attach';
import { requestResearch } from '../../services/fixMemory/research';
import { registerAgentRunEnqueuer } from '../../services/aiAgents/runService';
import { loadResearchContext } from '../../services/aiAgents/researchContext';
import type { AuthContext } from '../../middleware/auth';
import { updateAgent } from '../../services/aiAgents/agentService';
import {
  ensureResearchAgent, ResearchAgentEditError, ResearchBaselineConflictError,
} from '../../services/aiAgents/researchProvisioning';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

// requestResearch/admission resolve the agent's model first; the platform default needs a key.
usePlatformAiKeyPlaceholder();

const baselineRows = (partnerId: string) => withSystemDbAccessContext(() => db.select().from(aiAgents)
  .where(and(eq(aiAgents.partnerId, partnerId), eq(aiAgents.kind, 'research'), isNull(aiAgents.disabledAt))));

describe('research agent provisioning (real Postgres)', () => {
  it('ten concurrent first-admissions create exactly one partner baseline', async () => {
    const partner = await createPartner();
    const results = await Promise.all(Array.from({ length: 10 }, () => ensureResearchAgent(partner.id)));
    expect(new Set(results.map((r) => r.agentId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await baselineRows(partner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdBy: null, provisionedBy: 'system:remediation_research', mode: 'act', enabled: true });
  });

  it('a later call is a no-op that returns the same row', async () => {
    const partner = await createPartner();
    const first = await ensureResearchAgent(partner.id);
    await expect(ensureResearchAgent(partner.id)).resolves.toEqual({ agentId: first.agentId, created: false });
  });

  it('fails closed on a pre-existing user-created partner research row and does not touch it', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const [squat] = await withSystemDbAccessContext(() => db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'research', name: 'squatter', createdBy: user.id,
    }).returning());
    await expect(ensureResearchAgent(partner.id)).rejects.toBeInstanceOf(ResearchBaselineConflictError);
    const rows = await baselineRows(partner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: squat!.id, createdBy: user.id, provisionedBy: null, name: 'squatter' });
  });

  it('the provisioned agent can be disabled, re-enabled and capped through the real agentService', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const { agentId } = await ensureResearchAgent(partner.id);
    const auth = {
      principal: { kind: 'user_session' }, user: { id: user.id, email: user.email, name: 'Tech', isPlatformAdmin: false },
      partnerId: partner.id, orgId: null, scope: 'partner', accessibleOrgIds: [org.id], partnerOrgAccess: 'all',
      canAccessOrg: (id: string) => id === org.id, orgCondition: () => undefined,
    } as unknown as AuthContext;
    const ctx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: user.id, currentPartnerId: partner.id,
    };
    await withDbAccessContext(ctx, () => updateAgent(auth, agentId, { enabled: false } as never));
    await withDbAccessContext(ctx, () => updateAgent(auth, agentId, { enabled: true, limits: { researchDeepBudgetCentsPerRun: 40 } } as never));
    await expect(withDbAccessContext(ctx, () => updateAgent(auth, agentId, { mode: 'off' } as never)))
      .rejects.toBeInstanceOf(ResearchAgentEditError);
    const [row] = await withSystemDbAccessContext(() => db.select().from(aiAgents).where(eq(aiAgents.id, agentId)));
    expect(row).toMatchObject({ enabled: true, mode: 'act', createdBy: null, provisionedBy: 'system:remediation_research' });
    expect((row!.limits as Record<string, number>).researchDeepBudgetCentsPerRun).toBe(40);
  });
});

describe('research refs (real Postgres, system scope like loadRunContext)', () => {
  it('include own partner-wide and own-org scripts for the device OS; exclude other orgs and other OSes', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const site = await createSite({ orgId: orgA.id });
    const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: orgA.id, siteId: site.id, agentId: randomUUID(), hostname: 'WS-REF', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', enrolledAt: new Date(),
    }).returning({ id: devices.id }));
    const [alert] = await withSystemDbAccessContext(() => db.insert(alerts).values({
      orgId: orgA.id, deviceId: device!.id, severity: 'high', title: 'Spooler stopped',
    }).returning({ id: alerts.id }));
    const mk = (name: string, v: Partial<typeof scripts.$inferInsert>) =>
      ({ name, language: 'powershell' as const, content: 'x', osTypes: ['windows'], ...v });
    const inserted = await withSystemDbAccessContext(() => db.insert(scripts).values([
      mk('partner-win', { partnerId: partner.id }),
      mk('orgA-win', { orgId: orgA.id, partnerId: partner.id }),
      mk('orgB-win', { orgId: orgB.id, partnerId: partner.id }),
      mk('otherPartner-win', { partnerId: otherPartner.id }),
      mk('partner-linux', { partnerId: partner.id, osTypes: ['linux'], language: 'bash' }),
    ]).returning({ id: scripts.id, name: scripts.name }));
    const id = (n: string) => inserted.find((r) => r.name === n)!.id;

    const ctx = await withSystemDbAccessContext(() => loadResearchContext({
      orgId: orgA.id, partnerId: partner.id, deviceId: device!.id,
      triggerRef: { depth: 'quick', sourceType: 'alert', sourceId: alert!.id },
    }));
    expect(ctx.device.osType).toBe('windows');
    expect(ctx.refs.scriptIds.has(id('partner-win'))).toBe(true);
    expect(ctx.refs.scriptIds.has(id('orgA-win'))).toBe(true);
    expect(ctx.refs.scriptIds.has(id('orgB-win'))).toBe(false);
    expect(ctx.refs.scriptIds.has(id('otherPartner-win'))).toBe(false);
    expect(ctx.refs.scriptIds.has(id('partner-linux'))).toBe(false);
    expect(ctx.refs.scriptIdsAnyOs.has(id('partner-linux'))).toBe(true);
    expect(ctx.refs.scriptIdsAnyOs.has(id('orgB-win'))).toBe(false);
    expect(ctx.catalog.scripts.map((s) => s.id)).toEqual(expect.arrayContaining([id('partner-win'), id('orgA-win')]));
    expect(ctx.catalog.scripts.map((s) => s.id)).not.toContain(id('partner-linux'));
  });
});

async function orgWithDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  await withSystemDbAccessContext(() => db.execute(sql`UPDATE organizations SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{mlFeatureFlags}', '{"ml.remediation_suggestions.enabled": true}'::jsonb) WHERE id = ${org.id}`));
  const site = await createSite({ orgId: org.id });
  const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'WS-RES', osType: 'windows', osVersion: '11',
    architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  const mkAlert = async () => (await withSystemDbAccessContext(() => db.insert(alerts).values({
    orgId: org.id, deviceId: device!.id, severity: 'high', title: 't',
  }).returning({ id: alerts.id })))[0]!.id;
  return { partnerId: partner.id, orgId: org.id, mkAlert };
}

// The background contract: no wrapping context, reads in a short system tx (requestResearch asserts none is held).
const request = (orgId: string, sourceId: string, trigger: 'auto' | 'manual') => requestResearch({
  orgId, sourceType: 'alert', sourceId, depth: 'quick', trigger, actorUserId: null, runReads: (fn) => withSystemDbAccessContext(fn),
});

describe('requestResearch (real Postgres)', () => {
  beforeEach(() => {
    process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
    registerAgentRunEnqueuer(async () => ({ enqueued: true }));
  });
  afterEach(() => registerAgentRunEnqueuer(null));

  it('dedupe: concurrent manual requests for one (source, depth) create one run', async () => {
    const w = await orgWithDevice();
    const alertId = await w.mkAlert();
    const results = await Promise.all(Array.from({ length: 5 }, () => request(w.orgId, alertId, 'manual')));
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, w.orgId)));
    expect(runs.filter((r) => r.profile === 'remediation_research')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'started')).toHaveLength(1);
    expect(results.every((r) => r.status === 'started' || r.status === 'already_running')).toBe(true);
  });

  it('a partner with no research baseline: the first automatic request provisions it AND is admitted', async () => {
    const w = await orgWithDevice();
    const alertId = await w.mkAlert();
    const result = await request(w.orgId, alertId, 'auto');
    expect(result).toMatchObject({ status: 'started' });
    const agents = await withSystemDbAccessContext(() => db.select().from(aiAgents).where(and(eq(aiAgents.partnerId, w.partnerId), eq(aiAgents.kind, 'research'))));
    expect(agents).toHaveLength(1);
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, w.orgId)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ profile: 'remediation_research', triggerKind: 'alert', status: 'queued' });
  });

  it('the alert.triggered subscriber provisions and admits research for a partner with no baseline', async () => {
    const w = await orgWithDevice();
    const alertId = await w.mkAlert();
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: w.orgId, source: 's', priority: 'normal', payload: { alertId, severity: 'high' }, metadata: { timestamp: '' } } as never);
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, w.orgId)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ profile: 'remediation_research', triggerKind: 'alert' });
  });

  it('A1/A3: auto research enqueues only after the run row has COMMITTED (a separate connection sees it queued)', async () => {
    const w = await orgWithDevice();
    const alertId = await w.mkAlert();
    const seenAtEnqueue: Array<{ runId: string; status: string | null }> = [];
    registerAgentRunEnqueuer(async (runId) => {
      // runOutsideDbContext forces a NEW pooled connection even if the enqueue were
      // (wrongly) running inside the admission transaction: an uncommitted row is invisible here.
      const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
        .select({ status: aiAgentRuns.status }).from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)).limit(1)));
      seenAtEnqueue.push({ runId, status: row?.status ?? null });
      return { enqueued: true };
    });
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: w.orgId, source: 's', priority: 'normal', payload: { alertId, severity: 'critical' }, metadata: { timestamp: '' } } as never);
    expect(seenAtEnqueue).toHaveLength(1);
    expect(seenAtEnqueue[0]!.status).toBe('queued');
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, w.orgId)));
    expect(runs.map((r) => r.id)).toEqual([seenAtEnqueue[0]!.runId]);
  });

  it('A1: requestResearch refuses to run under a held DB context and starts nothing', async () => {
    const w = await orgWithDevice();
    const alertId = await w.mkAlert();
    await expect(withSystemDbAccessContext(() => request(w.orgId, alertId, 'manual'))).rejects.toThrow(/no DB context/);
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, w.orgId)));
    expect(runs).toHaveLength(0);
  });

  it('an org-level research override row is not a baseline: provisioning still happens for the partner', async () => {
    const w = await orgWithDevice();
    const user = await createUser({ partnerId: w.partnerId, orgId: w.orgId });
    await withSystemDbAccessContext(() => db.insert(aiAgents).values({
      partnerId: null, orgId: w.orgId, kind: 'research', name: 'org override', createdBy: user.id,
    }));
    const result = await request(w.orgId, await w.mkAlert(), 'manual');
    // The org row is a (default-disabled) override, so admission denies agent_disabled; the point is the baseline.
    expect(result).toMatchObject({ status: 'denied', code: 'agent_disabled' });
    const baseline = await baselineRows(w.partnerId);
    expect(baseline.filter((a) => a.orgId === null)).toHaveLength(1);
  });

  it('two concurrent automatic requests at cap-1 admit exactly one (auto cap under the admission lock)', async () => {
    const w = await orgWithDevice();
    const { agentId } = await ensureResearchAgent(w.partnerId);
    await withSystemDbAccessContext(() => db.update(aiAgents).set({
      limits: sql`coalesce(${aiAgents.limits}, '{}'::jsonb) || '{"maxConcurrentResearchRuns":10,"maxResearchRunsPerHour":100,"maxAutoResearchRunsPerHour":6}'::jsonb`,
    }).where(eq(aiAgents.id, agentId)));
    for (let i = 0; i < 5; i += 1) expect((await request(w.orgId, await w.mkAlert(), 'auto')).status).toBe('started');
    const [a, b] = [await w.mkAlert(), await w.mkAlert()];
    const results = await Promise.all([request(w.orgId, a, 'auto'), request(w.orgId, b, 'auto')]);
    expect(results.map((r) => r.status).sort()).toEqual(['denied', 'started']);
    expect(results.find((r) => r.status === 'denied')).toMatchObject({ code: 'auto_cap' });
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(and(eq(aiAgentRuns.orgId, w.orgId), eq(aiAgentRuns.triggerKind, 'alert'))));
    expect(runs).toHaveLength(6);
  });

  it('a failed run is retryable once per manual click, never automatically', async () => {
    const w = await orgWithDevice();
    const alertId = await w.mkAlert();
    const first = await request(w.orgId, alertId, 'manual');
    expect(first.status).toBe('started');
    await withSystemDbAccessContext(() => db.update(aiAgentRuns).set({ status: 'failed' }).where(eq(aiAgentRuns.orgId, w.orgId)));
    expect(await request(w.orgId, alertId, 'auto')).toMatchObject({ status: 'already_done' });
    const retry = await request(w.orgId, alertId, 'manual');
    expect(retry.status).toBe('started');
    const again = await request(w.orgId, alertId, 'manual');
    expect(again).toMatchObject({ status: 'already_running' });
  });
  it('under an org-scoped request context, another org\'s source is not found', async () => {
    const a = await orgWithDevice();
    const b = await orgWithDevice();
    const aAlert = await a.mkAlert();
    const ctx: DbAccessContext = {
      scope: 'organization', orgId: b.orgId, accessibleOrgIds: [b.orgId], accessiblePartnerIds: [b.partnerId], userId: null, currentPartnerId: b.partnerId,
    };
    // The route contract: reads run in the caller's RLS context, nothing wraps the call.
    const result = await requestResearch({
      orgId: b.orgId, sourceType: 'alert', sourceId: aAlert, depth: 'quick', trigger: 'manual', actorUserId: null,
      runReads: (fn) => withDbAccessContext(ctx, fn),
    });
    expect(result).toMatchObject({ status: 'denied', code: 'source_not_found' });
    const runs = await withSystemDbAccessContext(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, a.orgId)));
    expect(runs).toHaveLength(0);
  });
});

describe('built-in attempts follow their command or cleanup run (real Postgres, W2 Task 15)', () => {
  async function fixture() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'WS-B', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id }));
    const [alert] = await withSystemDbAccessContext(() => db.insert(alerts).values({
      orgId: org.id, deviceId: device!.id, severity: 'high', title: 'exit 3',
      context: { source: 'script_exit_code', scriptId: randomUUID(), exitCode: 3 },
    }).returning({ id: alerts.id }));
    return { partner, org, device: device!, alert: alert! };
  }
  type Fx = Awaited<ReturnType<typeof fixture>>;
  const outcome = (fx: Fx, extra: Record<string, unknown>) => withSystemDbAccessContext(async () => {
    const [o] = await db.insert(fixOutcomes).values({
      orgId: fx.org.id, partnerId: fx.partner.id, deviceId: fx.device.id, sourceType: 'alert', sourceId: fx.alert.id, alertId: fx.alert.id,
      fixKind: 'builtin_action', state: 'pending', deadlineAt: new Date(Date.now() + 86_400_000), ...extra,
    } as never).returning({ id: fixOutcomes.id });
    return o!.id;
  });

  it('a completed restart_service command moves the attempt to awaiting_recovery; failed counts as failed; sent stays pending', async () => {
    const fx = await fixture();
    const mk = async (status: string) => {
      const [cmd] = await withSystemDbAccessContext(() => db.insert(deviceCommands)
        .values({ deviceId: fx.device.id, type: 'restart_service', payload: { name: 'Spooler' }, status, executedAt: new Date() } as never)
        .returning({ id: deviceCommands.id }));
      return outcome(fx, { fixIdentity: 'builtin:restart_service', builtinAction: 'restart_service', actionCommandId: cmd!.id });
    };
    expect(await advanceOutcome(await mk('completed'))).toBe('awaiting_recovery');
    expect(await advanceOutcome(await mk('failed'))).toBe('failed');
    expect(await advanceOutcome(await mk('sent'))).toBe('pending');
  });

  it('a command the reaper expired on its delivery clock is inconclusive (never reached the device), a real failure is failed', async () => {
    const fx = await fixture();
    const mk = async (result: Record<string, unknown>, executedAt: Date | null) => {
      const [cmd] = await withSystemDbAccessContext(() => db.insert(deviceCommands)
        .values({ deviceId: fx.device.id, type: 'reboot', payload: {}, status: 'failed', result, executedAt } as never)
        .returning({ id: deviceCommands.id }));
      return outcome(fx, { fixIdentity: 'builtin:reboot', builtinAction: 'reboot', actionCommandId: cmd!.id });
    };
    expect(await advanceOutcome(await mk({ clock: 'delivery', error: 'expired' }, null))).toBe('inconclusive');
    expect(await advanceOutcome(await mk({ error: 'agent said no' }, new Date()))).toBe('failed');
  });

  it('a disk_cleanup attempt follows the cleanup run row, not the command', async () => {
    const fx = await fixture();
    const mk = async (status: 'executed' | 'failed' | 'running') => {
      const [run] = await withSystemDbAccessContext(() => db.insert(deviceFilesystemCleanupRuns)
        .values({ deviceId: fx.device.id, orgId: fx.org.id, status } as never).returning({ id: deviceFilesystemCleanupRuns.id }));
      return outcome(fx, { fixIdentity: 'builtin:disk_cleanup', builtinAction: 'disk_cleanup', actionCommandId: randomUUID(), actionCleanupRunId: run!.id });
    };
    expect(await advanceOutcome(await mk('executed'))).toBe('awaiting_recovery');
    expect(await advanceOutcome(await mk('failed'))).toBe('failed');
    expect(await advanceOutcome(await mk('running'))).toBe('pending');
  });

  it('recordBuiltinOutcome writes one pending builtin_action row per suggestion (idempotent), partner-owned by the org', async () => {
    const fx = await fixture();
    const [sg] = await withSystemDbAccessContext(() => db.insert(remediationSuggestions).values({
      orgId: fx.org.id, sourceType: 'alert', sourceId: fx.alert.id, alertId: fx.alert.id, deviceId: fx.device.id,
      targetDeviceIds: [fx.device.id], targetType: 'builtin_action', builtinAction: 'restart_service', title: 'Restart spooler',
      rationale: 'r', expectedAction: 'e', status: 'executed', parameters: { serviceName: 'Spooler' },
    } as never).returning());
    const [cmd] = await withSystemDbAccessContext(() => db.insert(deviceCommands)
      .values({ deviceId: fx.device.id, type: 'restart_service', payload: { name: 'Spooler' }, status: 'sent' } as never)
      .returning({ id: deviceCommands.id }));
    const input = { suggestion: sg!, deviceId: fx.device.id, commandId: cmd!.id, cleanupRunId: null };
    const first = await withSystemDbAccessContext(() => recordBuiltinOutcome(input));
    expect(first).toEqual({ state: 'pending', stateReason: null, humanVote: null });
    await withSystemDbAccessContext(() => recordBuiltinOutcome(input));
    const rows = await withSystemDbAccessContext(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.suggestionId, sg!.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fixKind: 'builtin_action', fixIdentity: 'builtin:restart_service', builtinAction: 'restart_service',
      actionCommandId: cmd!.id, actionCleanupRunId: null, partnerId: fx.partner.id, scriptExecutionId: null, state: 'pending',
    });
  });
});
