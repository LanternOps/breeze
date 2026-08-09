/**
 * psa_connections + psa_ticket_mappings RLS — dual-axis (org OR partner)
 * enforcement (epic #2135).
 *
 * Migration under test: 2026-08-17-psa-connections-partner-ownership.sql.
 *
 * A PSA connection is owned by EITHER a partner (partner_id set, org_id NULL —
 * the MSP's own ConnectWise/Autotask/Jira, shared by every org) OR an org
 * (org_id set, partner_id NULL — a customer's own Jira/Zendesk in a co-managed
 * engagement). psa_ticket_mappings has NO owner column of its own; its policy
 * joins through psa_connections and must carry the parent's partner branch.
 *
 * The rls-coverage contract test proves a *policy string* mentions
 * breeze_has_partner_access; it does NOT prove the branch behaves. This
 * functional suite runs through the REAL postgres.js driver as `breeze_app`:
 *   - cross-partner forge -> 42501
 *   - XOR violations (both axes / neither axis) -> 23514
 *   - org isolation (org tokens never see partner-wide rows)
 *   - the partner-scope READ proof: a partner-owned row IS visible to its own
 *     partner. That is the bug class the reader sweep existed to kill — an
 *     org-only `org_id IN (...)` filter hid partner-wide connections from the
 *     very partner that created them.
 *   - the psa_ticket_mappings device arm, which keeps deleteDeviceCascade from
 *     silently matching zero rows under an org-scope context.
 *
 * No fan-out test: nothing evaluates psa_connections against devices on a
 * schedule (there is no PSA sync worker — POST /connections/:id/sync is an
 * honest 501), so playbook step 5 has nothing to assert here.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, psaConnections, psaTicketMappings } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

const CREDENTIALS = { baseUrl: 'https://acme.atlassian.net', apiToken: 'tok' };

async function seedPartnerConnection(partnerId: string, name = 'MSP Jira') {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(psaConnections)
      .values({ name, provider: 'jira', orgId: null, partnerId, credentials: CREDENTIALS })
      .returning(),
  );
  return rows[0]!.id;
}

async function seedOrgConnection(orgId: string, name = 'Customer Jira') {
  const rows = await withDbAccessContext(orgContext(orgId), () =>
    db
      .insert(psaConnections)
      .values({ name, provider: 'jira', orgId, partnerId: null, credentials: CREDENTIALS })
      .returning(),
  );
  return rows[0]!.id;
}

describe('psa_connections RLS — dual-axis (2026-08-17 migration)', () => {
  it('PARTNER READ PROOF: a partner sees its own partner-wide connection', async () => {
    const partner = await createPartner();
    const id = await seedPartnerConnection(partner.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db.select({ id: psaConnections.id }).from(psaConnections).where(eq(psaConnections.id, id)),
    );

    expect(visible.map((r) => r.id)).toContain(id);
  });

  it('a different partner can neither see nor forge a connection attributed to the first partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerConnection(partnerA.id);

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.select({ id: psaConnections.id }).from(psaConnections).where(eq(psaConnections.id, id)),
    );
    expect(visibleToB).toEqual([]);

    // Cross-partner forge: WITH CHECK rejects the write outright.
    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(psaConnections)
          .values({
            name: 'Forged',
            provider: 'jira',
            orgId: null,
            partnerId: partnerA.id,
            credentials: CREDENTIALS,
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a different partner cannot UPDATE or DELETE the first partner\'s connection', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const id = await seedPartnerConnection(partnerA.id);

    // Invisible rows simply do not match — no error, but zero effect.
    const updated = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.update(psaConnections).set({ name: 'Hijacked' }).where(eq(psaConnections.id, id)).returning(),
    );
    expect(updated).toEqual([]);

    const deleted = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db.delete(psaConnections).where(eq(psaConnections.id, id)).returning(),
    );
    expect(deleted).toEqual([]);

    const stillThere = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ name: psaConnections.name }).from(psaConnections).where(eq(psaConnections.id, id)),
    );
    expect(stillThere[0]?.name).toBe('MSP Jira');
  });

  it('ORG ISOLATION: an org token cannot see a partner-wide connection, even under its own partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const partnerConnId = await seedPartnerConnection(partner.id);

    // RLS is STRICTER than the app layer: an org token carries a partnerId but
    // never passes breeze_has_partner_access. Never claim parity.
    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: psaConnections.id })
        .from(psaConnections)
        .where(eq(psaConnections.id, partnerConnId)),
    );
    expect(visibleToOrg).toEqual([]);

    // ...but its own org-owned connection round-trips fine.
    const orgConnId = await seedOrgConnection(org.id);
    const ownVisible = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ id: psaConnections.id }).from(psaConnections).where(eq(psaConnections.id, orgConnId)),
    );
    expect(ownVisible.map((r) => r.id)).toEqual([orgConnId]);
  });

  it('one org cannot see another org\'s connection under the same partner', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const orgAConnId = await seedOrgConnection(orgA.id);

    const visibleToB = await withDbAccessContext(orgContext(orgB.id), () =>
      db.select({ id: psaConnections.id }).from(psaConnections).where(eq(psaConnections.id, orgAConnId)),
    );
    expect(visibleToB).toEqual([]);
  });

  it('a partner sees BOTH its partner-wide row and its orgs\' rows in one query', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const partnerConnId = await seedPartnerConnection(partner.id);
    const orgConnId = await seedOrgConnection(org.id);

    const visible = await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.select({ id: psaConnections.id }).from(psaConnections),
    );
    const ids = visible.map((r) => r.id);
    expect(ids).toContain(partnerConnId);
    expect(ids).toContain(orgConnId);
  });

  it('the one-owner CHECK rejects BOTH axes and NEITHER axis', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(psaConnections)
          .values({
            name: 'Both',
            provider: 'jira',
            orgId: org.id,
            partnerId: partner.id,
            credentials: CREDENTIALS,
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(psaConnections)
          .values({
            name: 'Neither',
            provider: 'jira',
            orgId: null,
            partnerId: null,
            credentials: CREDENTIALS,
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('psa_ticket_mappings RLS — dual-axis join through psa_connections', () => {
  async function seedDevice(orgId: string) {
    const site = await createSite({ orgId });
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(devices)
        .values({
          orgId,
          siteId: site.id,
          agentId: `psa-rls-${site.id.slice(0, 18)}`,
          hostname: 'psa-rls-host',
          osType: 'windows',
          osVersion: '10.0',
          architecture: 'x64',
          agentVersion: '1.0.0',
        })
        .returning(),
    );
    return rows[0]!.id;
  }

  it('a mapping under a partner-wide connection is visible to its partner', async () => {
    const partner = await createPartner();
    const connectionId = await seedPartnerConnection(partner.id);

    const inserted = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .insert(psaTicketMappings)
        .values({ connectionId, externalTicketId: 'OPS-1' })
        .returning(),
    );
    expect(inserted).toHaveLength(1);

    const visible = await withDbAccessContext(partnerContext(partner.id, []), () =>
      db
        .select({ id: psaTicketMappings.id })
        .from(psaTicketMappings)
        .where(eq(psaTicketMappings.id, inserted[0]!.id)),
    );
    expect(visible).toHaveLength(1);
  });

  it('a different partner can neither see nor forge a mapping under the first partner\'s connection', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const connectionId = await seedPartnerConnection(partnerA.id);
    const [mapping] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(psaTicketMappings).values({ connectionId, externalTicketId: 'OPS-2' }).returning(),
    );

    const visibleToB = await withDbAccessContext(partnerContext(partnerB.id, []), () =>
      db
        .select({ id: psaTicketMappings.id })
        .from(psaTicketMappings)
        .where(eq(psaTicketMappings.id, mapping!.id)),
    );
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(partnerB.id, []), () =>
        db
          .insert(psaTicketMappings)
          .values({ connectionId, externalTicketId: 'FORGED' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('DEVICE ARM: an org token can see and DELETE a mapping on its own device under a PARTNER-wide connection', async () => {
    // Regression guard for the deleteDeviceCascade hazard: that cascade runs in
    // the REQUEST context. Without the device arm on the policy this DELETE
    // matches zero rows and the subsequent `DELETE FROM devices` fails 23503.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const connectionId = await seedPartnerConnection(partner.id);
    const deviceId = await seedDevice(org.id);

    const [mapping] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(psaTicketMappings)
        .values({ connectionId, deviceId, externalTicketId: 'OPS-3' })
        .returning(),
    );

    const visibleToOrg = await withDbAccessContext(orgContext(org.id), () =>
      db
        .select({ id: psaTicketMappings.id })
        .from(psaTicketMappings)
        .where(eq(psaTicketMappings.id, mapping!.id)),
    );
    expect(visibleToOrg).toHaveLength(1);

    const deleted = await withDbAccessContext(orgContext(org.id), () =>
      db.delete(psaTicketMappings).where(eq(psaTicketMappings.deviceId, deviceId)).returning(),
    );
    expect(deleted).toHaveLength(1);
  });

  it('the device arm does NOT leak a mapping to an unrelated org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const connectionId = await seedPartnerConnection(partner.id);
    const deviceId = await seedDevice(orgA.id);

    const [mapping] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(psaTicketMappings)
        .values({ connectionId, deviceId, externalTicketId: 'OPS-4' })
        .returning(),
    );

    const visibleToB = await withDbAccessContext(orgContext(orgB.id), () =>
      db
        .select({ id: psaTicketMappings.id })
        .from(psaTicketMappings)
        .where(eq(psaTicketMappings.id, mapping!.id)),
    );
    expect(visibleToB).toEqual([]);
  });
});
