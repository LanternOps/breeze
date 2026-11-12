/**
 * AI artifact visibility for site-restricted callers, against real Postgres.
 *
 * Organization RLS does not cover sites, so `findArtifactForAuth` and
 * `listArtifactsForAuth` carry the site rule themselves:
 *   - a run artifact follows its run: the run device's current site, or, for a
 *     device-less analysis run, the site recorded when it was requested;
 *   - an artifact with no run but a chat session is visible to the session's
 *     creator, and only while the session's device (if it has one) is in an
 *     allowed site;
 *   - an artifact with neither stays hidden from restricted callers;
 *   - unrestricted callers keep organization-wide visibility.
 *
 * The queries run in a system DB context on purpose: RLS (the org axis) is
 * not under test here, the application-layer site predicate is.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgents, aiAgentRuns, aiSessions } from '../../db/schema';
import { aiRunArtifacts } from '../../db/schema/aiWorkspace';
import type { AuthContext } from '../../middleware/auth';
import { findArtifactForAuth, listArtifactsForAuth } from '../../services/artifacts/artifactService';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const SHA = 'a'.repeat(64);

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const user = await createUser({ orgId: org.id, partnerId: partner.id, email: `owner-${randomUUID()}@example.com` });
  const other = await createUser({ orgId: org.id, partnerId: partner.id, email: `other-${randomUUID()}@example.com` });
  const deviceA = await createDevice({ orgId: org.id, siteId: siteA.id });
  const deviceB = await createDevice({ orgId: org.id, siteId: siteB.id });

  return withSystemDbAccessContext(async () => {
    const [agent] = await db.insert(aiAgents).values({
      orgId: org.id,
      partnerId: null,
      kind: 'triage',
      name: 'Artifact site fixture',
      createdBy: user.id,
    }).returning({ id: aiAgents.id });

    const run = async (values: Partial<typeof aiAgentRuns.$inferInsert>) => {
      const [row] = await db.insert(aiAgentRuns).values({
        agentId: agent!.id,
        orgId: org.id,
        triggerKind: 'manual',
        dedupeKey: `artifact-site-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 } as never,
        ...values,
      }).returning({ id: aiAgentRuns.id });
      return row!.id;
    };
    const session = async (values: Partial<typeof aiSessions.$inferInsert>) => {
      const [row] = await db.insert(aiSessions).values({
        orgId: org.id,
        type: 'general',
        model: 'claude-sonnet-5-5',
        ...values,
      }).returning({ id: aiSessions.id });
      return row!.id;
    };
    const artifact = async (name: string, runId: string | null, sessionId: string | null) => {
      const [row] = await db.insert(aiRunArtifacts).values({
        orgId: org.id,
        runId,
        sessionId,
        kind: 'output',
        name,
        contentType: 'text/plain',
        bytes: 10,
        sha256: SHA,
        blobKey: `us/2026/11/${randomUUID()}`,
        createdByTool: 'fixture',
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      }).returning({ id: aiRunArtifacts.id });
      return row!.id;
    };

    const runDeviceA = await run({ deviceId: deviceA.id });
    const runDeviceB = await run({ deviceId: deviceB.id });
    const runAnalysisA = await run({ profile: 'analysis', triggerRef: { source: 'chat_analysis', siteId: siteA.id } });
    const runAnalysisB = await run({ profile: 'analysis', triggerRef: { source: 'chat_analysis', siteId: siteB.id } });
    const runAnalysisNoSite = await run({ profile: 'analysis', triggerRef: { source: 'chat_analysis', siteId: null } });
    const runDesignA = await run({ profile: 'design', triggerRef: { siteId: siteA.id } });

    const sessionOwnNoDevice = await session({ userId: user.id });
    const sessionOwnDeviceA = await session({ userId: user.id, deviceId: deviceA.id });
    const sessionOwnDeviceB = await session({ userId: user.id, deviceId: deviceB.id });
    const sessionOtherDeviceA = await session({ userId: other.id, deviceId: deviceA.id });

    const artifacts = {
      runDeviceA: await artifact('run-device-a', runDeviceA, null),
      runDeviceB: await artifact('run-device-b', runDeviceB, null),
      runAnalysisA: await artifact('run-analysis-a', runAnalysisA, null),
      runAnalysisB: await artifact('run-analysis-b', runAnalysisB, null),
      runAnalysisNoSite: await artifact('run-analysis-no-site', runAnalysisNoSite, null),
      runDesignA: await artifact('run-design-a', runDesignA, null),
      sessionOwnNoDevice: await artifact('session-own', null, sessionOwnNoDevice),
      sessionOwnDeviceA: await artifact('session-own-device-a', null, sessionOwnDeviceA),
      sessionOwnDeviceB: await artifact('session-own-device-b', null, sessionOwnDeviceB),
      sessionOtherDeviceA: await artifact('session-other-device-a', null, sessionOtherDeviceA),
      neither: await artifact('neither', null, null),
    };

    return {
      orgId: org.id,
      siteA: siteA.id,
      siteB: siteB.id,
      userId: user.id,
      deviceA: deviceA.id,
      deviceB: deviceB.id,
      runs: { runDeviceA, runDeviceB, runAnalysisA, runAnalysisB },
      artifacts,
    };
  });
}

type Seed = Awaited<ReturnType<typeof seed>>;

function authFor(ids: Seed, ceiling: { allowedSiteIds?: string[]; allowedDeviceIds?: string[] }): AuthContext {
  return {
    scope: 'organization',
    orgId: ids.orgId,
    partnerId: null,
    accessibleOrgIds: [ids.orgId],
    user: { id: ids.userId, email: 'owner@example.com', name: 'Owner', isPlatformAdmin: false },
    orgCondition: (column: Parameters<AuthContext['orgCondition']>[0]) => eq(column, ids.orgId),
    canAccessOrg: (orgId: string) => orgId === ids.orgId,
    ...ceiling,
  } as unknown as AuthContext;
}

async function visibleNames(ids: Seed, auth: AuthContext): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const names: string[] = [];
    for (const handle of Object.values(ids.artifacts)) {
      const record = await findArtifactForAuth(handle, auth);
      if (record) names.push(record.name);
    }
    return names.sort();
  });
}

describe('AI artifact site access (live DB)', () => {
  let ids: Seed;

  beforeEach(async () => {
    ids = await seed();
  });

  runDb('an unrestricted user sees every artifact in the organization', async () => {
    expect(await visibleNames(ids, authFor(ids, {}))).toEqual([
      'neither', 'run-analysis-a', 'run-analysis-b', 'run-analysis-no-site', 'run-design-a',
      'run-device-a', 'run-device-b', 'session-other-device-a', 'session-own',
      'session-own-device-a', 'session-own-device-b',
    ]);
  });

  runDb('a site-restricted user sees run artifacts of their sites and their own chat artifacts', async () => {
    expect(await visibleNames(ids, authFor(ids, { allowedSiteIds: [ids.siteA] }))).toEqual([
      'run-analysis-a', 'run-device-a', 'session-own', 'session-own-device-a',
    ]);
  });

  runDb('a run artifact follows the run device when the device moves site', async () => {
    const auth = authFor(ids, { allowedSiteIds: [ids.siteA] });
    await withSystemDbAccessContext(() => db.execute(
      sql`UPDATE devices SET site_id = ${ids.siteB} WHERE id = ${ids.deviceA}`,
    ));
    const names = await visibleNames(ids, auth);
    expect(names).not.toContain('run-device-a');
    expect(names).not.toContain('session-own-device-a');
    expect(names).toContain('session-own');
  });

  runDb('a user with no allowed sites sees no artifacts', async () => {
    expect(await visibleNames(ids, authFor(ids, { allowedSiteIds: [] }))).toEqual([]);
  });

  runDb('an exact-device caller sees only artifacts tied to its devices', async () => {
    expect(await visibleNames(ids, authFor(ids, { allowedDeviceIds: [ids.deviceA] }))).toEqual([
      'run-device-a', 'session-own-device-a',
    ]);
  });

  runDb('the run artifact list applies the same rule', async () => {
    const auth = authFor(ids, { allowedSiteIds: [ids.siteA] });
    const list = (runId: string) => withSystemDbAccessContext(() => listArtifactsForAuth(runId, auth));
    expect((await list(ids.runs.runDeviceA)).map((r) => r.name)).toEqual(['run-device-a']);
    expect(await list(ids.runs.runDeviceB)).toEqual([]);
    expect((await list(ids.runs.runAnalysisA)).map((r) => r.name)).toEqual(['run-analysis-a']);
    expect(await list(ids.runs.runAnalysisB)).toEqual([]);
    const unrestricted = await withSystemDbAccessContext(() => listArtifactsForAuth(ids.runs.runDeviceB, authFor(ids, {})));
    expect(unrestricted.map((r) => r.name)).toEqual(['run-device-b']);
  });
});
