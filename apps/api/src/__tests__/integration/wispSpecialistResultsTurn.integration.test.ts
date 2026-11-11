/**
 * #11671 — a specialist's result reaches the chat that handed the work off,
 * from the run row, once per session. Pins the read's SQL against Postgres:
 * the `trigger_ref.originSessionId` the real launcher writes, the grant, the
 * settled statuses, the 24 h window, and the pending-step count.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'evt') };
});

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, devices, wispGrantRevisions, wispGrants } from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { registerAgentRunEnqueuer } from '../../services/aiAgents/runService';
import { requestSpecialist } from '../../services/wisp/coordinator';
import { specialistDedupeKey } from '../../services/wisp/specialistLaunchers';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { markSpecialistResultsDelivered, specialistResultsForTurn } from '../../services/wisp/specialistResultsTurn';
import { getRedis } from '../../services/redis';
import type { AuthContext } from '../../middleware/auth';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

usePlatformAiKeyPlaceholder();

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const PERMS = [
  { resource: 'ai_sessions', action: 'use' },
  { resource: 'ai_agents', action: 'write' },
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'execute' },
];

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-sr-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, PERMS);
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');

  const site = await createSite({ orgId: org.id });
  const unique = randomUUID().slice(0, 8);
  const [device] = await sys(() => db.insert(devices).values({
    orgId: org.id, siteId: site.id, agentId: `wisp-sr-${unique}`, hostname: `wisp-sr-${unique}`,
    osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id, siteId: devices.siteId }));
  await sys(() => db.insert(aiAgents).values({
    partnerId: partner.id, orgId: null, kind: 'triage', name: 'Wisp Triage', enabled: true, mode: 'shadow', model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] }, instructions: null, cooldownSeconds: 0, createdBy: grantor.id,
  } as never));

  const grant = await sys(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: grantor.id, status: 'active',
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const snapshot: WispCeilingSnapshot = {
      version: 1, permissionKeys: PERMS.map((p) => `${p.resource}:${p.action}`), orgIds: [org.id], siteIds: null, toolAllowlist: null, deniedTools: [],
    };
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });

  /** The technician chatting in Wisp session `sessionId` (what `launch_specialist` runs under). */
  const chatAuth = (sessionId: string) => ({
    principal: { kind: 'user_session' },
    user: { id: grantor.id, email: 'tech@wisp.test', name: 'Tech', isPlatformAdmin: false },
    token: null, partnerId: partner.id, orgId: null, scope: 'partner',
    accessibleOrgIds: [org.id], partnerOrgAccess: 'all',
    orgCondition: () => undefined, canAccessOrg: (id: string) => id === org.id,
    wispGrant: { grantId: grant.grantId, grantRevisionId: grant.revisionId, sessionId },
  }) as unknown as AuthContext;

  /** Hand the device to the troubleshooting specialist from chat session `sessionId`; returns the run id. */
  const handOff = async (sessionId: string): Promise<string> => {
    const requestId = randomUUID();
    const result = await requestSpecialist(
      {
        grantId: grant.grantId, grantRevisionId: grant.revisionId, orgId: org.id, kind: 'device_troubleshooting',
        params: { deviceId: device!.id, goal: 'The workstation is crawling' }, requestedByRunId: null,
      },
      { requester: { kind: 'user', auth: chatAuth(sessionId) }, requestId },
    );
    expect(result).toMatchObject({ admitted: true });
    const [run] = await sys(() => db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, org.id), eq(aiAgentRuns.dedupeKey, specialistDedupeKey(requestId)))));
    return run!.id;
  };

  const settle = (runId: string, set: Record<string, unknown>) =>
    sys(() => db.update(aiAgentRuns).set({ finishedAt: new Date(), ...set } as never).where(eq(aiAgentRuns.id, runId)));

  return { partner, org, grantor, device: device!, grant, handOff, settle };
}

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
  vi.stubEnv('BREEZE_AI_WORKSPACE_ENABLED', 'true');
  registerAgentRunEnqueuer(async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` }));
});
afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

describe('specialistResultsForTurn (#11671)', () => {
  it('gives the session that handed off its settled run once, and nothing to another session', async () => {
    const t = await seedTenant();
    const session = randomUUID();
    const other = randomUUID();
    const runId = await t.handOff(session);
    const otherRunId = await t.handOff(other);
    const input = { grantId: t.grant.grantId, revisionId: t.grant.revisionId, sessionId: session };

    const [row] = await sys(() => db.select({ triggerRef: aiAgentRuns.triggerRef, profile: aiAgentRuns.profile, grantId: aiAgentRuns.grantId })
      .from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)));
    expect(row).toMatchObject({ profile: 'device_troubleshooting', grantId: t.grant.grantId, triggerRef: expect.objectContaining({ originSessionId: session }) });

    // Still running: nothing to give.
    expect(await specialistResultsForTurn(input)).toBeNull();

    await t.settle(runId, { status: 'completed', summary: 'RAM 36-61%; the imaging service pins a core.' });
    await t.settle(otherRunId, { status: 'completed', summary: 'Another chat\'s run.' });

    const turn = await specialistResultsForTurn(input);
    expect(turn).toEqual({
      results: [{ runId, status: 'completed', profile: 'device_troubleshooting', summary: 'RAM 36-61%; the imaging service pins a core.', artifacts: [] }],
      keys: [`${runId}:completed`],
    });

    await markSpecialistResultsDelivered(session, turn!.keys);
    expect(getRedis(), 'the integration stack has Redis').not.toBeNull();
    expect(await specialistResultsForTurn(input)).toBeNull();

    // The other session gets its own, and only its own.
    const theirs = await specialistResultsForTurn({ ...input, sessionId: other });
    expect(theirs?.results.map((r) => r.runId)).toEqual([otherRunId]);
  });

  it('counts the steps still waiting on a run that settled for approval', async () => {
    const t = await seedTenant();
    const session = randomUUID();
    const runId = await t.handOff(session);
    const [run] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, runId)));
    const [agent] = await sys(() => db.select().from(aiAgents).where(eq(aiAgents.id, run!.agentId)));
    const agentAuth = buildAgentAuthContext(
      agent!,
      { id: runId, orgId: t.org.id, deviceId: t.device.id, deviceSiteId: t.device.siteId },
      { id: t.org.id, partnerId: t.partner.id },
    );
    const intent = await createActionIntent(agentAuth, {
      toolName: 'set_device_context',
      input: { deviceId: t.device.id, contextType: 'issue', summary: 'The imaging service needs a restart' },
      source: 'ai_agent',
      orgId: t.org.id,
    });
    expect(intent.status).toBe('pending_approval');
    await t.settle(runId, { status: 'awaiting_approval', summary: 'One fix proposed', intentIds: [intent.id] });

    const turn = await specialistResultsForTurn({ grantId: t.grant.grantId, revisionId: t.grant.revisionId, sessionId: session });
    expect(turn?.results).toEqual([expect.objectContaining({ runId, status: 'awaiting_approval', pendingIntentCount: 1 })]);
    expect(turn?.keys).toEqual([`${runId}:awaiting_approval`]);
  });

  it('does not give a run that settled before the session could have existed', async () => {
    const t = await seedTenant();
    const session = randomUUID();
    const runId = await t.handOff(session);
    await t.settle(runId, { status: 'failed', summary: 'Old.' });
    await sys(() => db.update(aiAgentRuns).set({ finishedAt: new Date(Date.now() - 25 * 3_600_000) } as never).where(eq(aiAgentRuns.id, runId)));
    expect(await specialistResultsForTurn({ grantId: t.grant.grantId, revisionId: t.grant.revisionId, sessionId: session })).toBeNull();
  });
});
