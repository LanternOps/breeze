/**
 * Real-driver cross-tenant forge test for device_link_groups (#2138).
 *
 * device_link_groups is a direct org-axis table (Shape 1: org_id + the four
 * breeze_has_org_access policies). Membership lives on devices.link_group_id,
 * pinned to the group's org by the composite FK
 * devices(link_group_id, org_id) -> device_link_groups(id, org_id).
 *
 * This proves, as the unprivileged breeze_app role:
 *   1. same-org create + link is allowed,
 *   2. a forged cross-org group insert is rejected by RLS (42501),
 *   3. an org cannot read another org's link groups, and
 *   4. the composite FK forbids linking a device to a group in a DIFFERENT org
 *      (23503) — the same-org invariant, enforced structurally.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceLinkGroups, devices, sites } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import {
  deleteLinkGroup,
  dissolveLinkGroupIfBelowMinimum,
} from '../../services/deviceLinkGroups';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seedDevice(orgId: string, siteId: string, tag: string) {
  const [device] = await db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `link-rls-agent-${tag}`,
      hostname: `link-rls-host-${tag}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error(`failed to seed device ${tag}`);
  return device;
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partner = await createPartner();
    let orgA = await createOrganization({ partnerId: partner.id });
    let orgB = await createOrganization({ partnerId: partner.id });
    // Partner-export org locks must be acquired in ascending UUID order
    // within one transaction, and this whole seed runs in a single system
    // context. Keep the A-then-B write order ascending by construction.
    if (orgB.id < orgA.id) [orgA, orgB] = [orgB, orgA];

    const [siteA] = await db
      .insert(sites)
      .values({ orgId: orgA.id, name: `Link RLS Site A ${unique}` })
      .returning({ id: sites.id });
    const [siteB] = await db
      .insert(sites)
      .values({ orgId: orgB.id, name: `Link RLS Site B ${unique}` })
      .returning({ id: sites.id });
    if (!siteA || !siteB) throw new Error('failed to seed sites');

    const deviceA1 = await seedDevice(orgA.id, siteA.id, `${unique}-a1`);
    const deviceA2 = await seedDevice(orgA.id, siteA.id, `${unique}-a2`);
    const deviceB = await seedDevice(orgB.id, siteB.id, `${unique}-b`);

    return { orgA, orgB, siteA, siteB, deviceA1, deviceA2, deviceB };
  });
}

describe('device_link_groups RLS (breeze_app)', () => {
  runDb('allows same-org create + link and rejects forged cross-org insert', async () => {
    const { orgA, orgB, deviceA1, deviceA2 } = await seed();

    // Same-org: create a group and link both org-A profiles.
    const groupId = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [group] = await db
        .insert(deviceLinkGroups)
        .values({ orgId: orgA.id, name: 'multi-boot A' })
        .returning({ id: deviceLinkGroups.id });
      expect(group?.id).toBeDefined();
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA1.id));
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA2.id));
      return group!.id;
    });

    const membersProbe = await withSystemDbAccessContext(() =>
      db.select({ id: devices.id }).from(devices).where(eq(devices.linkGroupId, groupId)),
    );
    expect(membersProbe).toHaveLength(2);

    // Forge: org B inserts a group claiming org A — RLS WITH CHECK rejects it.
    let caught: unknown;
    try {
      await withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(deviceLinkGroups).values({ orgId: orgA.id, name: 'forged' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'cross-org insert must be rejected by RLS').toBeDefined();
    const cause = (caught as { cause?: { message?: string; code?: string } } | undefined)?.cause;
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "device_link_groups"/,
    );

    // Read isolation: org B cannot see org A's group.
    const orgBView = await withDbAccessContext(orgCtx(orgB.id), () =>
      db.select({ id: deviceLinkGroups.id }).from(deviceLinkGroups).where(eq(deviceLinkGroups.id, groupId)),
    );
    expect(orgBView).toHaveLength(0);
  });

  runDb('composite FK forbids linking a device to a group in another org', async () => {
    const { orgA, orgB, deviceB } = await seed();

    // A real group in org A.
    const groupA = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [group] = await db
        .insert(deviceLinkGroups)
        .values({ orgId: orgA.id, name: 'org A group' })
        .returning({ id: deviceLinkGroups.id });
      return group!.id;
    });

    // Under SYSTEM context (RLS bypassed) so the FK is the sole guard: try to
    // point an org-B device at org-A's group. (link_group_id=groupA, org_id=B)
    // has no matching (id, org_id) in device_link_groups -> FK violation.
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        db.update(devices).set({ linkGroupId: groupA }).where(eq(devices.id, deviceB.id)),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'cross-org link must be rejected by the composite FK').toBeDefined();
    const cause = (caught as { cause?: { code?: string } } | undefined)?.cause;
    expect(cause?.code).toBe('23503'); // foreign_key_violation
  });
});

describe('device link-group dissolution', () => {
  runDb('dissolveLinkGroupIfBelowMinimum keeps a full group but dissolves a lone survivor', async () => {
    const { orgA, deviceA1, deviceA2 } = await seed();

    const groupId = await withSystemDbAccessContext(async () => {
      const [group] = await db
        .insert(deviceLinkGroups)
        .values({ orgId: orgA.id, name: 'dissolve-test' })
        .returning({ id: deviceLinkGroups.id });
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA1.id));
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA2.id));
      return group!.id;
    });

    // Two members: no dissolution.
    const keptOpen = await withSystemDbAccessContext(() => dissolveLinkGroupIfBelowMinimum(db, groupId));
    expect(keptOpen).toBe(false);

    // Drop to one member, then dissolve: the survivor is unlinked and the group deleted.
    await withSystemDbAccessContext(() =>
      db.update(devices).set({ linkGroupId: null }).where(eq(devices.id, deviceA2.id)),
    );
    const dissolved = await withSystemDbAccessContext(() => dissolveLinkGroupIfBelowMinimum(db, groupId));
    expect(dissolved).toBe(true);

    const remaining = await withSystemDbAccessContext(() =>
      db.select({ id: deviceLinkGroups.id }).from(deviceLinkGroups).where(eq(deviceLinkGroups.id, groupId)),
    );
    expect(remaining).toHaveLength(0);

    const survivor = await withSystemDbAccessContext(() =>
      db.select({ linkGroupId: devices.linkGroupId }).from(devices).where(eq(devices.id, deviceA1.id)),
    );
    expect(survivor[0]?.linkGroupId).toBeNull();
  });

  runDb('org flip on a linked device requires unlinking first, then dissolves the orphan (move-org contract)', async () => {
    const { orgA, orgB, siteB, deviceA1, deviceA2 } = await seed();

    const groupId = await withSystemDbAccessContext(async () => {
      const [group] = await db
        .insert(deviceLinkGroups)
        .values({ orgId: orgA.id, name: 'move-org-test' })
        .returning({ id: deviceLinkGroups.id });
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA1.id));
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA2.id));
      return group!.id;
    });

    // Flipping org_id while still linked violates the composite FK — this is
    // exactly why moveOrg nulls link_group_id in the same UPDATE.
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        db.update(devices).set({ orgId: orgB.id }).where(eq(devices.id, deviceA1.id)),
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { cause?: { code?: string } } | undefined)?.cause?.code).toBe('23503');

    // Unlink + flip in one shot (as moveOrg does — including the target site,
    // since devices_site_org_fk requires the site to belong to the new org),
    // then dissolve the orphan.
    await withSystemDbAccessContext(async () => {
      await db
        .update(devices)
        .set({ orgId: orgB.id, siteId: siteB.id, linkGroupId: null })
        .where(eq(devices.id, deviceA1.id));
      await dissolveLinkGroupIfBelowMinimum(db, groupId);
    });

    const group = await withSystemDbAccessContext(() =>
      db.select({ id: deviceLinkGroups.id }).from(deviceLinkGroups).where(eq(deviceLinkGroups.id, groupId)),
    );
    expect(group).toHaveLength(0);
    const survivor = await withSystemDbAccessContext(() =>
      db.select({ linkGroupId: devices.linkGroupId }).from(devices).where(eq(devices.id, deviceA2.id)),
    );
    expect(survivor[0]?.linkGroupId).toBeNull();
  });

  runDb('vm_host group survives guest loss but dissolves headless when the host unlinks (#2308)', async () => {
    const { orgA, deviceA1, deviceA2 } = await seed();

    // deviceA1 = host, deviceA2 = guest.
    const groupId = await withSystemDbAccessContext(async () => {
      const [group] = await db
        .insert(deviceLinkGroups)
        .values({ orgId: orgA.id, kind: 'vm_host', name: 'hv-01' })
        .returning({ id: deviceLinkGroups.id });
      await db
        .update(devices)
        .set({ linkGroupId: group!.id, linkGroupRole: 'host' })
        .where(eq(devices.id, deviceA1.id));
      await db
        .update(devices)
        .set({ linkGroupId: group!.id, linkGroupRole: 'guest' })
        .where(eq(devices.id, deviceA2.id));
      return group!.id;
    });

    // Host + guest present: no dissolution.
    const keptOpen = await withSystemDbAccessContext(() => dissolveLinkGroupIfBelowMinimum(db, groupId));
    expect(keptOpen).toBe(false);

    // Unlink the HOST (as a PATCH remove / move-org would): the guest remains
    // but the group is headless — the dissolve check must remove it and clear
    // the guest's membership AND role.
    await withSystemDbAccessContext(async () => {
      await db
        .update(devices)
        .set({ linkGroupId: null, linkGroupRole: null })
        .where(eq(devices.id, deviceA1.id));
      // Re-seed a second guest so the member count stays >= 2 and ONLY the
      // headless rule (not the below-minimum rule) can dissolve the group.
      const extra = await seedDevice(orgA.id, (await db.select({ siteId: devices.siteId }).from(devices).where(eq(devices.id, deviceA2.id)))[0]!.siteId!, `extra-${Date.now()}`);
      await db
        .update(devices)
        .set({ linkGroupId: groupId, linkGroupRole: 'guest' })
        .where(eq(devices.id, extra.id));
    });

    const dissolved = await withSystemDbAccessContext(() => dissolveLinkGroupIfBelowMinimum(db, groupId));
    expect(dissolved).toBe(true);

    const remaining = await withSystemDbAccessContext(() =>
      db.select({ id: deviceLinkGroups.id }).from(deviceLinkGroups).where(eq(deviceLinkGroups.id, groupId)),
    );
    expect(remaining).toHaveLength(0);

    const exGuest = await withSystemDbAccessContext(() =>
      db
        .select({ linkGroupId: devices.linkGroupId, linkGroupRole: devices.linkGroupRole })
        .from(devices)
        .where(eq(devices.id, deviceA2.id)),
    );
    expect(exGuest[0]?.linkGroupId).toBeNull();
    expect(exGuest[0]?.linkGroupRole).toBeNull();
  });

  runDb('deleteLinkGroup unlinks every member and removes the group row', async () => {
    const { orgA, deviceA1, deviceA2 } = await seed();

    const groupId = await withSystemDbAccessContext(async () => {
      const [group] = await db
        .insert(deviceLinkGroups)
        .values({ orgId: orgA.id, name: 'delete-test' })
        .returning({ id: deviceLinkGroups.id });
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA1.id));
      await db.update(devices).set({ linkGroupId: group!.id }).where(eq(devices.id, deviceA2.id));
      return group!.id;
    });

    await withSystemDbAccessContext(() => deleteLinkGroup(db, groupId));

    const remaining = await withSystemDbAccessContext(() =>
      db.select({ id: deviceLinkGroups.id }).from(deviceLinkGroups).where(eq(deviceLinkGroups.id, groupId)),
    );
    expect(remaining).toHaveLength(0);

    const stillLinked = await withSystemDbAccessContext(() =>
      db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.linkGroupId, groupId)),
    );
    expect(stillLinked).toHaveLength(0);
  });
});
