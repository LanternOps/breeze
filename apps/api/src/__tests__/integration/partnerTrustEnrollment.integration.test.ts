/**
 * Real-Postgres proof that the probation enrollment cap is a lifetime counter
 * serialized by the partner row lock, rather than a race-prone device count.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, enrollmentKeys, partners } from '../../db/schema';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function enrollmentApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

function enrollmentBody(rawKey: string, hostname: string) {
  return {
    enrollmentKey: rawKey,
    hostname,
    osType: 'linux' as const,
    osVersion: 'Integration Linux',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
  };
}

describe('partner trust probation enrollment cap — real Postgres (Task 4.4)', () => {
  const originalIsHosted = process.env.IS_HOSTED;
  const originalTrustMode = process.env.PARTNER_TRUST_MODE;
  const originalEnrollmentSecret = process.env.AGENT_ENROLLMENT_SECRET;

  beforeEach(() => {
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'enforce';
    // This suite exercises the probation-cap gate only, using enrollment-key
    // fixtures with no per-key secret (keySecretHash: null). Whether a global
    // AGENT_ENROLLMENT_SECRET is configured is orthogonal to that gate but
    // gets read from whatever .env happens to be loaded in this environment
    // (CI's integration-test job never sets it; a local worktree's .env
    // often does, per wt-stack). Force it unset so this test's outcome
    // doesn't depend on that unrelated, ambient configuration.
    delete process.env.AGENT_ENROLLMENT_SECRET;
  });

  afterEach(() => {
    if (originalIsHosted === undefined) delete process.env.IS_HOSTED;
    else process.env.IS_HOSTED = originalIsHosted;
    if (originalTrustMode === undefined) delete process.env.PARTNER_TRUST_MODE;
    else process.env.PARTNER_TRUST_MODE = originalTrustMode;
    if (originalEnrollmentSecret === undefined) delete process.env.AGENT_ENROLLMENT_SECRET;
    else process.env.AGENT_ENROLLMENT_SECRET = originalEnrollmentSecret;
  });

  runDb('admits exactly five concurrent enrollments and never recycles deleted-device quota', async () => {
    const suffix = randomUUID();
    const partner = await createPartner({ slug: `trust-enroll-${suffix}` });
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const rawKey = `trust-enrollment-${suffix}`;

    await withSystemDbAccessContext(async () => {
      await db
        .update(partners)
        .set({ trustState: 'probation', probationEnrollments: 0 })
        .where(eq(partners.id, partner.id));
      await db.insert(enrollmentKeys).values({
        orgId: org.id,
        siteId: site.id,
        name: 'Partner trust enrollment concurrency key',
        key: hashEnrollmentKey(rawKey),
        keySecretHash: null,
        usageCount: 0,
        maxUsage: null,
        expiresAt: null,
      });
    });

    const app = enrollmentApp();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(enrollmentBody(rawKey, `trust-host-${index}-${suffix}`)),
      })),
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 403)).toHaveLength(3);

    const successfulBodies = await Promise.all(
      responses
        .filter((response) => response.status === 201)
        .map((response) => response.json()),
    );
    expect(new Set(successfulBodies.map((body) => body.agentId))).toHaveProperty('size', 5);

    const stateAfterRace = await withSystemDbAccessContext(async () => {
      const partnerRows = await db
        .select({ probationEnrollments: partners.probationEnrollments })
        .from(partners)
        .where(eq(partners.id, partner.id));
      const deviceRows = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, org.id));
      return { probationEnrollments: partnerRows[0]?.probationEnrollments, deviceRows };
    });

    expect(stateAfterRace.deviceRows).toHaveLength(5);
    expect(stateAfterRace.probationEnrollments).toBe(5);

    await withSystemDbAccessContext(async () => {
      await db.delete(devices).where(and(
        eq(devices.orgId, org.id),
        eq(devices.id, stateAfterRace.deviceRows[0]!.id),
      ));
      await db.delete(devices).where(and(
        eq(devices.orgId, org.id),
        eq(devices.id, stateAfterRace.deviceRows[1]!.id),
      ));
    });

    const ninth = await app.request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(enrollmentBody(rawKey, `trust-host-9-${suffix}`)),
    });

    expect(ninth.status).toBe(403);
    expect(await ninth.json()).toEqual({
      error: 'TRUST_PROBATION',
      capability: 'agent_enroll',
      reason: 'probation_enrollment_cap',
      reviewRequested: false,
      meetingUrl: null,
    });

    const finalState = await withSystemDbAccessContext(async () => {
      const [partnerRow] = await db
        .select({ probationEnrollments: partners.probationEnrollments })
        .from(partners)
        .where(eq(partners.id, partner.id));
      const remainingDevices = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.orgId, org.id));
      return { partnerRow, remainingDevices };
    });
    expect(finalState.remainingDevices).toHaveLength(3);
    expect(finalState.partnerRow?.probationEnrollments).toBe(5);
  });
});
