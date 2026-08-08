/**
 * Fleet hygiene findings — end-to-end integration suite (Task 11).
 *
 * Exercises the full pipeline against a REAL Postgres + Redis: producers ->
 * reconcileOrgFindings -> the findings feed (partner/org/foreign-partner/
 * site-restricted reads) -> remediation dispatch against the real
 * `device_commands` table -> RLS forge on `fleet_findings` itself.
 *
 * Route calls go through the real Hono app + authMiddleware (mirroring
 * vulnerabilitiesRemediate.integration.test.ts's `buildApp()`/`mfaHeaders()`
 * pattern) so `listFleetFindings`/`createRemediationRun` are exercised with a
 * genuine, request-shaped AuthContext (org-axis closures, site allowlist,
 * MFA gate) rather than a hand-built stand-in. `dispatchRunChunk` and
 * `pollRunProgress` have no HTTP route (per dispatch.ts's own docstring they
 * are BullMQ-worker-only functions) — those are called directly, wrapped in
 * `withSystemDbAccessContext`, exactly like `jobs/fleetRemediationDispatch.ts`
 * wraps them in production.
 */
import './setup';

import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  deviceCommands,
  devices,
  fleetFindingDevices,
  fleetFindings,
  fleetRemediationRunTargets,
  fleetRemediationRuns,
  organizationUsers,
} from '../../db/schema';
import { metricAnomalies } from '../../db/schema/analytics';
import { logCorrelationRules, logCorrelations } from '../../db/schema/eventLogs';
import { deviceReliability } from '../../db/schema/reliability';
import { fleetFindingsRoutes } from '../../routes/fleetFindings';
import { dispatchRunChunk, pollRunProgress } from '../../services/fleetFindings/dispatch';
import {
  produceLogCorrelationFindings,
  produceMetricAnomalyPatterns,
  produceReliabilityOffenders,
} from '../../services/fleetFindings/producers';
import { reconcileOrgFindings } from '../../services/fleetFindings/reconcile';
import { createAccessToken } from '../../services/jwt';
import { getTestDb } from './setup';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/fleet/findings', fleetFindingsRoutes);
  return app;
}

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

interface TokenSubject {
  userId: string;
  email: string;
  roleId: string;
  orgId: string | null;
  partnerId: string | null;
  scope: 'system' | 'partner' | 'organization';
}

async function tokenHeaders(subject: TokenSubject, opts: { mfa?: boolean } = {}): Promise<Record<string, string>> {
  const token = await createAccessToken({
    sub: subject.userId,
    email: subject.email,
    roleId: subject.roleId,
    orgId: subject.orgId,
    partnerId: subject.partnerId,
    scope: subject.scope,
    mfa: opts.mfa ?? false,
    aep: 1,
    mep: 1,
    sid: uniq('it-session'),
  });
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** Full fixture: one partner with two member orgs + a foreign partner/org. */
interface Fixture {
  partner: Awaited<ReturnType<typeof createPartner>>;
  orgA: Awaited<ReturnType<typeof createOrganization>>;
  orgB: Awaited<ReturnType<typeof createOrganization>>;
  siteA1: Awaited<ReturnType<typeof createSite>>;
  siteA2: Awaited<ReturnType<typeof createSite>>;
  siteB1: Awaited<ReturnType<typeof createSite>>;
  foreignPartner: Awaited<ReturnType<typeof createPartner>>;
  orgC: Awaited<ReturnType<typeof createOrganization>>;
  partnerUser: TokenSubject;
  orgAUser: TokenSubject;
  /** Org-A user whose organization_users.site_ids restricts them to siteA1. */
  siteRestrictedUser: TokenSubject;
  foreignUser: TokenSubject;
  devA1: string; // site A1 — reliability offender member
  devA2: string; // site A1 — metric anomaly member
  devA3: string; // site A2 — metric anomaly member (pairs with devA2)
  devA4: string; // site A2 — sole log-correlation member
  devB1: string; // org B — reliability offender member
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: uniq('ff-agent'),
      hostname: uniq('ff-host'),
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('failed to seed device');
  return device.id;
}

async function seedMetricAnomaly(
  orgId: string,
  deviceId: string,
  opts: { metricName: string; anomalyType: string; score: number }
): Promise<void> {
  const windowStart = new Date();
  const windowEnd = new Date(windowStart.getTime() + 5 * 60_000);
  await getTestDb().insert(metricAnomalies).values({
    orgId,
    deviceId,
    metricType: 'cpu',
    metricName: opts.metricName,
    anomalyType: opts.anomalyType,
    status: 'open',
    windowStart,
    windowEnd,
    observedValue: 95,
    baselineValue: 20,
    score: opts.score,
    confidence: 0.95,
  });
}

async function seedLogCorrelationFinding(
  orgId: string,
  deviceId: string,
  hostname: string
): Promise<void> {
  const now = new Date();
  const [rule] = await getTestDb()
    .insert(logCorrelationRules)
    .values({
      orgId,
      name: uniq('disk-full-pattern'),
      pattern: 'disk is full',
    })
    .returning({ id: logCorrelationRules.id });
  if (!rule) throw new Error('failed to seed log correlation rule');

  await getTestDb().insert(logCorrelations).values({
    orgId,
    ruleId: rule.id,
    pattern: 'disk is full',
    firstSeen: now,
    lastSeen: now,
    occurrences: 12,
    affectedDevices: [{ deviceId, hostname, count: 12 }],
    status: 'active',
  });
}

async function seedReliabilityOffender(orgId: string, deviceId: string, score: number): Promise<void> {
  await getTestDb().insert(deviceReliability).values({
    deviceId,
    orgId,
    reliabilityScore: score,
    uptimeScore: 50,
    crashScore: 50,
    hangScore: 50,
    serviceFailureScore: 50,
    hardwareErrorScore: 50,
    uptime7d: 90,
    uptime30d: 90,
    uptime90d: 90,
    trendDirection: 'stable',
  });
}

async function runProducersAndReconcile(orgId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const candidates = [
      ...(await produceMetricAnomalyPatterns(orgId)),
      ...(await produceLogCorrelationFindings(orgId)),
      ...(await produceReliabilityOffenders(orgId)),
    ];
    await reconcileOrgFindings(orgId, candidates);
  });
}

async function createTenantUser(opts: {
  partnerId: string;
  orgId: string | null;
  scope: 'partner' | 'organization';
}): Promise<TokenSubject> {
  const user = await createUser({ partnerId: opts.partnerId, orgId: opts.orgId, withMembership: false });
  const role = await createRole({
    scope: opts.scope,
    partnerId: opts.scope === 'partner' ? opts.partnerId : undefined,
    orgId: opts.scope === 'organization' ? (opts.orgId ?? undefined) : undefined,
  });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);

  if (opts.scope === 'partner') {
    await assignUserToPartner(user.id, opts.partnerId, role.id, 'all');
  } else {
    await assignUserToOrganization(user.id, opts.orgId!, role.id);
  }

  return {
    userId: user.id,
    email: user.email,
    roleId: role.id,
    orgId: opts.scope === 'organization' ? opts.orgId : null,
    partnerId: opts.partnerId,
    scope: opts.scope,
  };
}

async function buildFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA1 = await createSite({ orgId: orgA.id });
  const siteA2 = await createSite({ orgId: orgA.id });
  const siteB1 = await createSite({ orgId: orgB.id });

  const foreignPartner = await createPartner();
  const orgC = await createOrganization({ partnerId: foreignPartner.id });
  await createSite({ orgId: orgC.id });

  const partnerUser = await createTenantUser({ partnerId: partner.id, orgId: null, scope: 'partner' });
  const orgAUser = await createTenantUser({ partnerId: partner.id, orgId: orgA.id, scope: 'organization' });
  const foreignUser = await createTenantUser({ partnerId: foreignPartner.id, orgId: orgC.id, scope: 'organization' });

  // Site-restricted org-A user: a fresh membership row with site_ids narrowed
  // to siteA1 only (services/permissions.ts populates allowedSiteIds from
  // organization_users.site_ids).
  const siteRestrictedUserRow = await createUser({ partnerId: partner.id, orgId: orgA.id, withMembership: false });
  const siteRestrictedRole = await createRole({ scope: 'organization', orgId: orgA.id });
  await grantRolePermissions(siteRestrictedRole.id, [{ resource: '*', action: '*' }]);
  const membership = await assignUserToOrganization(siteRestrictedUserRow.id, orgA.id, siteRestrictedRole.id);
  await getTestDb()
    .update(organizationUsers)
    .set({ siteIds: [siteA1.id] })
    .where(eq(organizationUsers.id, membership.id));
  const siteRestrictedUser: TokenSubject = {
    userId: siteRestrictedUserRow.id,
    email: siteRestrictedUserRow.email,
    roleId: siteRestrictedRole.id,
    orgId: orgA.id,
    partnerId: partner.id,
    scope: 'organization',
  };

  const devA1 = await seedDevice(orgA.id, siteA1.id);
  const devA2 = await seedDevice(orgA.id, siteA1.id);
  const devA3 = await seedDevice(orgA.id, siteA2.id);
  const devA4 = await seedDevice(orgA.id, siteA2.id);
  const devB1 = await seedDevice(orgB.id, siteB1.id);

  // Reliability offender: devA1 only (score < 50).
  await seedReliabilityOffender(orgA.id, devA1, 30);
  // Metric anomaly pattern: devA2 (site A1) + devA3 (site A2) — >=2 devices
  // on the same (metric_name, anomaly_type), producer's hard minimum.
  await seedMetricAnomaly(orgA.id, devA2, { metricName: 'cpu_percent', anomalyType: 'spike', score: 3 });
  await seedMetricAnomaly(orgA.id, devA3, { metricName: 'cpu_percent', anomalyType: 'spike', score: 3.5 });
  // Log correlation: devA4 (site A2) only — sole member, entirely outside site A1.
  await seedLogCorrelationFinding(orgA.id, devA4, 'devA4-host');

  // Org B: one reliability offender so the partner-scope read has a
  // second org's finding to prove visibility across both member orgs.
  await seedReliabilityOffender(orgB.id, devB1, 20);

  await runProducersAndReconcile(orgA.id);
  await runProducersAndReconcile(orgB.id);

  return {
    partner,
    orgA,
    orgB,
    siteA1,
    siteA2,
    siteB1,
    foreignPartner,
    orgC,
    partnerUser,
    orgAUser,
    siteRestrictedUser,
    foreignUser,
    devA1,
    devA2,
    devA3,
    devA4,
    devB1,
  };
}

interface ListedFinding {
  id: string;
  orgId: string;
  kind: string;
  deviceCount: number;
}

describe('fleet findings — end-to-end (Task 11)', () => {
  runDb('(a) partner/org/foreign-partner reads', async () => {
    const f = await buildFixture();
    const app = buildApp();

    // Partner-scope: sees both member orgs' findings (3 in org A + 1 in org B).
    const partnerRes = await app.request('/fleet/findings', { headers: await tokenHeaders(f.partnerUser) });
    expect(partnerRes.status).toBe(200);
    const partnerBody = (await partnerRes.json()) as { findings: ListedFinding[]; total: number };
    expect(partnerBody.total).toBe(4);
    const partnerOrgIds = new Set(partnerBody.findings.map((r) => r.orgId));
    expect(partnerOrgIds).toEqual(new Set([f.orgA.id, f.orgB.id]));

    // Org-scope: only its own org's findings (3: reliability, anomaly, log correlation).
    const orgRes = await app.request('/fleet/findings', { headers: await tokenHeaders(f.orgAUser) });
    expect(orgRes.status).toBe(200);
    const orgBody = (await orgRes.json()) as { findings: ListedFinding[]; total: number };
    expect(orgBody.total).toBe(3);
    expect(orgBody.findings.every((r) => r.orgId === f.orgA.id)).toBe(true);
    expect(new Set(orgBody.findings.map((r) => r.kind))).toEqual(
      new Set(['reliability_offenders', 'metric_anomaly_pattern', 'log_correlation'])
    );

    // Foreign partner: sees nothing from partner P1's orgs.
    const foreignRes = await app.request('/fleet/findings', { headers: await tokenHeaders(f.foreignUser) });
    expect(foreignRes.status).toBe(200);
    const foreignBody = (await foreignRes.json()) as { findings: ListedFinding[]; total: number };
    expect(foreignBody.total).toBe(0);
    expect(foreignBody.findings).toEqual([]);
  });

  runDb('(b) site-restricted read filters membership, recomputes deviceCount, omits zero-member findings', async () => {
    const f = await buildFixture();
    const app = buildApp();

    const res = await app.request('/fleet/findings', { headers: await tokenHeaders(f.siteRestrictedUser) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: ListedFinding[]; total: number };

    // log_correlation (sole member devA4, site A2) has zero members in site
    // A1 — omitted entirely, not just filtered down to deviceCount 0.
    expect(body.total).toBe(2);
    const byKind = new Map(body.findings.map((r) => [r.kind, r]));
    expect(byKind.has('log_correlation')).toBe(false);

    // reliability_offenders: sole member devA1 IS in site A1 — visible, deviceCount unchanged at 1.
    const reliability = byKind.get('reliability_offenders');
    expect(reliability?.deviceCount).toBe(1);

    // metric_anomaly_pattern: org-wide deviceCount is 2 (devA2 + devA3), but
    // only devA2 (site A1) is in scope — recomputed down to 1.
    const anomaly = byKind.get('metric_anomaly_pattern');
    expect(anomaly?.deviceCount).toBe(1);
  });

  runDb('(c) createRemediationRun + dispatchRunChunk against the real device_commands table', async () => {
    const f = await buildFixture();
    const app = buildApp();

    const [findingRow] = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(fleetFindings)
        .where(and(eq(fleetFindings.orgId, f.orgA.id), eq(fleetFindings.kind, 'reliability_offenders')))
    );
    if (!findingRow) throw new Error('reliability_offenders finding not found');

    const remediateRes = await app.request(`/fleet/findings/${findingRow.id}/remediate`, {
      method: 'POST',
      headers: await tokenHeaders(f.orgAUser, { mfa: true }),
      body: JSON.stringify({
        actionKind: 'command',
        commandType: 'restart_service',
        parameters: {},
        deviceIds: [f.devA1],
      }),
    });
    expect(remediateRes.status).toBe(202);
    const remediateBody = (await remediateRes.json()) as { runId: string; targetCount: number; skipped: unknown[] };
    expect(remediateBody.targetCount).toBe(1);
    expect(remediateBody.skipped).toEqual([]);

    const runId = remediateBody.runId;

    // Run created with the correct org + a target snapshot before dispatch.
    const [run] = await getTestDb().select().from(fleetRemediationRuns).where(eq(fleetRemediationRuns.id, runId));
    if (!run) throw new Error('remediation run not found');
    expect(run.orgId).toBe(f.orgA.id);
    expect(run.findingId).toBe(findingRow.id);
    expect(run.targetCount).toBe(1);
    expect(run.status).toBe('queued');

    const [targetBeforeDispatch] = await getTestDb()
      .select()
      .from(fleetRemediationRunTargets)
      .where(eq(fleetRemediationRunTargets.runId, runId));
    if (!targetBeforeDispatch) throw new Error('remediation run target not found');
    expect(targetBeforeDispatch.orgId).toBe(f.orgA.id);
    expect(targetBeforeDispatch.targetDeviceUuid).toBe(f.devA1);
    expect(targetBeforeDispatch.status).toBe('pending');

    // dispatchRunChunk fans out via queueCommandForExecution — a real
    // device_commands row lands, attributed to devA1 (an org-A device).
    await withSystemDbAccessContext(() => dispatchRunChunk(runId, 0));

    const cmds = await getTestDb()
      .select()
      .from(deviceCommands)
      .where(and(eq(deviceCommands.deviceId, f.devA1), eq(deviceCommands.type, 'restart_service')));
    expect(cmds.length).toBe(1);
    const command = cmds[0]!;

    const [targetAfterDispatch] = await getTestDb()
      .select()
      .from(fleetRemediationRunTargets)
      .where(eq(fleetRemediationRunTargets.runId, runId));
    expect(targetAfterDispatch?.status).toBe('queued');
    expect(targetAfterDispatch?.deviceCommandId).toBe(command.id);

    // Simulate the agent completing the command.
    await getTestDb()
      .update(deviceCommands)
      .set({ status: 'completed', result: { ok: true }, completedAt: new Date() })
      .where(eq(deviceCommands.id, command.id));

    await withSystemDbAccessContext(() => pollRunProgress(runId));

    const [targetFinal] = await getTestDb()
      .select()
      .from(fleetRemediationRunTargets)
      .where(eq(fleetRemediationRunTargets.runId, runId));
    expect(targetFinal?.status).toBe('succeeded');

    const [runFinal] = await getTestDb().select().from(fleetRemediationRuns).where(eq(fleetRemediationRuns.id, runId));
    expect(runFinal?.status).toBe('succeeded');
    expect(runFinal?.succeededCount).toBe(1);
    expect(runFinal?.failedCount).toBe(0);
    expect(runFinal?.completedAt).not.toBeNull();
  });

  runDb('(d) RLS forge: cross-tenant INSERT into fleet_findings fails with 42501', async () => {
    const f = await buildFixture();

    await expect(
      withDbAccessContext(orgContext(f.orgB.id), () =>
        db
          .insert(fleetFindings)
          .values({
            orgId: f.orgA.id,
            kind: 'reliability_offenders',
            semanticKey: 'reliability:forged',
            title: 'Forged finding',
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          })
          .returning()
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // Sanity: the legitimate org-A context CAN insert into its own org.
    const inserted = await withDbAccessContext(orgContext(f.orgA.id), () =>
      db
        .insert(fleetFindings)
        .values({
          orgId: f.orgA.id,
          kind: 'reliability_offenders',
          semanticKey: 'reliability:sanity-check',
          title: 'Sanity-check finding',
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        })
        .returning({ id: fleetFindings.id }),
    );
    expect(inserted).toHaveLength(1);

    // Cross-tenant SELECT of a real org-A finding is invisible to org B.
    const [realFinding] = await withSystemDbAccessContext(() =>
      db.select({ id: fleetFindings.id }).from(fleetFindings).where(eq(fleetFindings.orgId, f.orgA.id)).limit(1),
    );
    if (realFinding) {
      const visibleToOrgB = await withDbAccessContext(orgContext(f.orgB.id), () =>
        db.select({ id: fleetFindings.id }).from(fleetFindings).where(eq(fleetFindings.id, realFinding.id)),
      );
      expect(visibleToOrgB).toEqual([]);
    }

    // fleet_finding_devices carries the same shape-1 direct org_id policy —
    // forging membership under a mismatched org also fails 42501.
    await expect(
      withDbAccessContext(orgContext(f.orgB.id), () =>
        db
          .insert(fleetFindingDevices)
          .values({
            findingId: inserted[0]!.id,
            orgId: f.orgA.id,
            deviceId: f.devA1,
            sourceKind: 'device_reliability',
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
