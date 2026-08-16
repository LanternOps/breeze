// #3553: the manual-remediation authorization record is a security control on
// the destructive software-uninstall worker. These tests prove, against real
// Postgres + RLS + the generic device-move trigger, the three properties a
// mocked unit test cannot:
//   1. Cross-partner RLS forge: partner B cannot see partner A's request.
//   2. Device-move invalidation: a request authorized for org A's policy on a
//      device that then moves to org B must NOT consume (the ownership-coherence
//      re-check closes the retenanting hole even though the device-move trigger
//      rewrites the request's org_id).
//   3. System-context single-use consume: a coherent request consumes exactly
//      once.
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, softwarePolicies, softwareRemediationRequests } from '../../db/schema';
import { consumeManualRemediationAuthorization } from '../../jobs/softwareRemediationWorker';
import { pruneExpiredRemediationRequests } from '../../jobs/softwareRemediationRequestCleanup';
import { createOrganization, createPartner, createSite } from './db-utils';

const createdRequests: string[] = [];
const createdPolicies: string[] = [];
const createdDevices: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
}

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdRequests) await db.delete(softwareRemediationRequests).where(eq(softwareRemediationRequests.id, id));
    for (const id of createdDevices) await db.delete(devices).where(eq(devices.id, id));
    for (const id of createdPolicies) await db.delete(softwarePolicies).where(eq(softwarePolicies.id, id));
  });
  createdRequests.length = 0;
  createdDevices.length = 0;
  createdPolicies.length = 0;
});

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(devices).values({
      orgId, siteId, agentId: randomUUID(), hostname: `dev-${randomUUID().slice(0, 8)}`,
      osType: 'windows', osVersion: '11', architecture: 'x64', agentVersion: '1.0.0',
    }).returning({ id: devices.id }),
  );
  createdDevices.push(row!.id);
  return row!.id;
}

async function seedOrgPolicy(orgId: string): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(softwarePolicies).values({
      name: 'Blocklist', mode: 'blocklist', orgId, partnerId: null,
      rules: { software: [{ name: 'BitTorrent' }] },
    }).returning({ id: softwarePolicies.id }),
  );
  createdPolicies.push(row!.id);
  return row!.id;
}

async function seedRequest(fields: { orgId: string | null; partnerId: string | null; policyId: string; deviceId: string; consumed?: boolean; expiresAt?: Date }): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(softwareRemediationRequests).values({
      orgId: fields.orgId, partnerId: fields.partnerId, policyId: fields.policyId, deviceId: fields.deviceId,
      requestedByUserId: null,
      expiresAt: fields.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      consumedAt: fields.consumed ? new Date() : null,
    }).returning({ id: softwareRemediationRequests.id }),
  );
  createdRequests.push(row!.id);
  return row!.id;
}

describe('software_remediation_requests — RLS + device-move + consume (#3553)', () => {
  it('cross-partner forge: partner B cannot SELECT partner A\'s request', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const siteA = await createSite({ orgId: orgA.id });
    const deviceD = await seedDevice(orgA.id, siteA.id);
    const policyP = await seedOrgPolicy(orgA.id);
    const requestId = await seedRequest({ orgId: orgA.id, partnerId: null, policyId: policyP, deviceId: deviceD });

    const visibleToA = await withDbAccessContext(partnerContext(partnerA.id, [orgA.id]), () =>
      db.select({ id: softwareRemediationRequests.id }).from(softwareRemediationRequests).where(eq(softwareRemediationRequests.id, requestId)),
    );
    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: softwareRemediationRequests.id }).from(softwareRemediationRequests).where(eq(softwareRemediationRequests.id, requestId)),
    );

    expect(visibleToA.map((r) => r.id)).toContain(requestId);
    expect(visibleToB).toHaveLength(0);
  });

  it('device-move invalidation: a request does NOT consume after its device leaves the policy\'s org', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceD = await seedDevice(orgA.id, siteA.id);
    const policyP = await seedOrgPolicy(orgA.id);
    const requestId = await seedRequest({ orgId: orgA.id, partnerId: null, policyId: policyP, deviceId: deviceD });

    // Move device D from org A to org B (fires the generic device-move trigger,
    // which rewrites child rows' org_id — including this request's).
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(devices).set({ orgId: orgB.id, siteId: siteB.id }).where(eq(devices.id, deviceD)),
    );

    // The consume reads the device's CURRENT org (orgB) inside the UPDATE and
    // compares it to the policy's org (orgA): incoherent -> no row -> refuse. It
    // must NOT consume. (This exercises the real fresh-read, not a cached scalar.)
    const result = await withDbAccessContext(SYSTEM_CTX, () =>
      consumeManualRemediationAuthorization({ manualRequestId: requestId, policyId: policyP, deviceId: deviceD }),
    );
    const [after] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ consumedAt: softwareRemediationRequests.consumedAt }).from(softwareRemediationRequests).where(eq(softwareRemediationRequests.id, requestId)),
    );

    expect(result.authorized).toBe(false);
    expect(after?.consumedAt).toBeNull();
  });

  it('system-context consume is single-use for a coherent request', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const siteA = await createSite({ orgId: orgA.id });
    const deviceD = await seedDevice(orgA.id, siteA.id);
    const policyP = await seedOrgPolicy(orgA.id);
    const requestId = await seedRequest({ orgId: orgA.id, partnerId: null, policyId: policyP, deviceId: deviceD });

    const first = await withDbAccessContext(SYSTEM_CTX, () =>
      consumeManualRemediationAuthorization({ manualRequestId: requestId, policyId: policyP, deviceId: deviceD }),
    );
    const second = await withDbAccessContext(SYSTEM_CTX, () =>
      consumeManualRemediationAuthorization({ manualRequestId: requestId, policyId: policyP, deviceId: deviceD }),
    );

    expect(first.authorized).toBe(true);
    expect(second.authorized).toBe(false); // already consumed
  });

  // #3614 follow-up 4: the sequential case above proves single-use only AFTER
  // the first consume has committed. The property that actually matters is that
  // two consumes racing on the SAME row cannot both win. That holds because the
  // consume is one atomic `UPDATE ... WHERE consumed_at IS NULL ... RETURNING`,
  // so the second UPDATE blocks on the first's row lock and then matches zero
  // rows. Pinning it here means a future refactor to read-then-write — which
  // would still pass the sequential test — fails instead.
  it('concurrent consumes of the same request: exactly one wins', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const siteA = await createSite({ orgId: orgA.id });
    const deviceD = await seedDevice(orgA.id, siteA.id);
    const policyP = await seedOrgPolicy(orgA.id);
    const requestId = await seedRequest({ orgId: orgA.id, partnerId: null, policyId: policyP, deviceId: deviceD });

    // Started together, not awaited in sequence: both are in flight before
    // either resolves.
    const [a, b] = await Promise.all([
      withDbAccessContext(SYSTEM_CTX, () =>
        consumeManualRemediationAuthorization({ manualRequestId: requestId, policyId: policyP, deviceId: deviceD }),
      ),
      withDbAccessContext(SYSTEM_CTX, () =>
        consumeManualRemediationAuthorization({ manualRequestId: requestId, policyId: policyP, deviceId: deviceD }),
      ),
    ]);

    // Exactly one authorized — never both (double uninstall dispatch), never
    // neither (a burned token that queued nothing).
    expect([a.authorized, b.authorized].filter(Boolean)).toHaveLength(1);
  });

  // #3553 finding 4: prove the PARTNER axis of the dual RLS + consume, not just
  // the org axis. A partner-wide policy's request is visible to its partner and
  // NOT to another partner, and consumes while the device stays under the partner.
  it('partner-wide request: partner-axis RLS isolation + consume under the partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const siteA = await createSite({ orgId: orgA.id });
    const deviceD = await seedDevice(orgA.id, siteA.id);
    // Partner-wide policy: partner_id set, org_id null.
    const [policyRow] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(softwarePolicies).values({
        name: 'Partner-wide blocklist', mode: 'blocklist', orgId: null, partnerId: partnerA.id,
        rules: { software: [{ name: 'BitTorrent' }] },
      }).returning({ id: softwarePolicies.id }),
    );
    createdPolicies.push(policyRow!.id);
    // Request carries the device's org (org axis) AND the policy's partner (partner axis).
    const requestId = await seedRequest({ orgId: orgA.id, partnerId: partnerA.id, policyId: policyRow!.id, deviceId: deviceD });

    // Partner A with NO accessible orgs: a successful read can only come through
    // the breeze_has_partner_access branch, proving the partner axis (not org).
    const visibleToA = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db.select({ id: softwareRemediationRequests.id }).from(softwareRemediationRequests).where(eq(softwareRemediationRequests.id, requestId)),
    );
    // Partner B has no accessible orgs here, so only the PARTNER axis could leak it.
    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: softwareRemediationRequests.id }).from(softwareRemediationRequests).where(eq(softwareRemediationRequests.id, requestId)),
    );
    const consumed = await withDbAccessContext(SYSTEM_CTX, () =>
      consumeManualRemediationAuthorization({ manualRequestId: requestId, policyId: policyRow!.id, deviceId: deviceD }),
    );

    expect(visibleToA.map((r) => r.id)).toContain(requestId);
    expect(visibleToB).toHaveLength(0);
    expect(consumed.authorized).toBe(true); // device still under partner A
  });

  // #3614 review: the unit suite asserts query SHAPE, which cannot express this.
  // Todd demonstrated the gap by inverting `lt` -> `gt` on the cutoff — turning
  // the sweep into one that deletes every UNEXPIRED authorization — and the unit
  // tests still passed 6/6. The failure mode is a row count, so it is checked
  // here against real Postgres.
  it('prune deletes only rows past the retention grace, across orgs, and spares live ones', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerA.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceA = await seedDevice(orgA.id, siteA.id);
    const deviceB = await seedDevice(orgB.id, siteB.id);
    const policyA = await seedOrgPolicy(orgA.id);
    const policyB = await seedOrgPolicy(orgB.id);

    const HOUR = 60 * 60 * 1000;
    // Live: expires in an hour. Must survive.
    const live = await seedRequest({
      orgId: orgA.id, partnerId: null, policyId: policyA, deviceId: deviceA,
      expiresAt: new Date(Date.now() + HOUR),
    });
    // Expired 1h ago — past expiry but INSIDE the 72h grace. Must survive.
    const recentlyExpired = await seedRequest({
      orgId: orgA.id, partnerId: null, policyId: policyA, deviceId: deviceA,
      expiresAt: new Date(Date.now() - HOUR),
    });
    // Expired 100h ago, in a DIFFERENT org — past the grace. Must be deleted,
    // and the sweep must not be org-scoped.
    const longExpired = await seedRequest({
      orgId: orgB.id, partnerId: null, policyId: policyB, deviceId: deviceB,
      expiresAt: new Date(Date.now() - 100 * HOUR),
    });

    // Called with NO ambient context on purpose: the prune establishes its own
    // system context per batch, so it must sweep the whole table unaided.
    const result = await pruneExpiredRemediationRequests();
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    const survivors = await withDbAccessContext(SYSTEM_CTX, async () => {
      const rows = await db
        .select({ id: softwareRemediationRequests.id })
        .from(softwareRemediationRequests);
      return new Set(rows.map((r) => r.id));
    });

    // An inverted comparison would invert exactly these three assertions.
    expect(survivors.has(live)).toBe(true);
    expect(survivors.has(recentlyExpired)).toBe(true);
    expect(survivors.has(longExpired)).toBe(false);
  });

});
