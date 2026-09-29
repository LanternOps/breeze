import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, sites, deviceTimeDaily } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { ingestTimeStatusSnapshot } from './ingest';
import { getDeviceTimeStatusView } from './view';
import { timeSnapshot } from './testSnapshot';
import { listFleetTimeStatus } from './fleet';
import { exportHistoryTimeCsv } from './exports';
const system: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};
async function fixture() {
  const partner = await createPartner();
  const a = await createOrganization({ partnerId: partner!.id }),
    b = await createOrganization({ partnerId: partner!.id });
  const sa = await createSite({ orgId: a!.id }),
    sb = await createSite({ orgId: b!.id });
  const add = async (orgId: string, siteId: string, hostname: string) => {
    const [row] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: randomUUID(),
        hostname,
        osType: 'windows',
        osVersion: 'Server',
        architecture: 'x64',
        agentVersion: '1.0.0',
      })
      .returning();
    return row!;
  };
  const member = await add(a!.id, sa!.id, 'Member A'),
    pdc = await add(a!.id, sa!.id, 'PDC A'),
    other = await add(b!.id, sb!.id, 'Member B');
  const today = new Date().toISOString().slice(0, 10),
    receivedAt = new Date();
  for (const device of [member, pdc, other]) {
    const snapshot = timeSnapshot({ collectedAt: `${today}T00:00:00Z` });
    snapshot.domain = {
      joinType: 'on_prem_ad',
      role: device.id === pdc.id ? 'pdc_emulator' : 'member',
      domainDns: 'example.com',
      forestDns: 'example.com',
      pdcName: 'PDC',
    };
    snapshot.config.type = 'NT5DS';
    snapshot.status.lastSuccessfulSyncAt = receivedAt.toISOString();
    await withDbAccessContext(system, () =>
      ingestTimeStatusSnapshot({
        deviceId: device.id,
        orgId: device.orgId,
        agentVersion: null,
        snapshot,
        receivedAt,
      }),
    );
  }
  const context: DbAccessContext = {
    scope: 'organization',
    orgId: a!.id,
    accessibleOrgIds: [a!.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner!.id,
  };
  const auth = {
    scope: 'organization',
    orgId: a!.id,
    accessibleOrgIds: [a!.id],
    orgCondition: (column: any) => eq(column, a!.id),
    canAccessOrg: (id: string) => id === a!.id,
  } as AuthContext;
  return {
    partner: partner!,
    a: a!,
    b: b!,
    sa: sa!,
    sb: sb!,
    member,
    pdc,
    other,
    today,
    context,
    auth,
  };
}
it('separates tenants with equal domains and preserves site/device authorization in metadata', async () => {
  const f = await fixture();
  await withDbAccessContext(f.context, async () => {
    const value = await listFleetTimeStatus(
      { role: 'member', limit: 1 },
      f.auth,
    );
    expect(value.data.map((r) => r.deviceId)).toEqual([f.member.id]);
    expect(value.domains).toMatchObject([
      {
        orgId: f.a.id,
        domainDns: 'example.com',
        pdcEnrolled: true,
        pdc: { deviceId: f.pdc.id },
      },
    ]);
    const pinned = await listFleetTimeStatus(
      { deviceId: f.member.id },
      { ...f.auth, allowedDeviceIds: [f.member.id] },
    );
    expect(pinned.domains).toMatchObject([{ pdcEnrolled: false, pdc: null }]);
    // Device axis alone (no deviceId filter): the domain metadata query must
    // still honour allowedDeviceIds, not just the display filter.
    const axisOnly = await listFleetTimeStatus(
      {},
      { ...f.auth, allowedDeviceIds: [f.member.id] },
    );
    expect(axisOnly.data.map((r) => r.deviceId)).toEqual([f.member.id]);
    expect(axisOnly.domains).toMatchObject([{ pdcEnrolled: false, pdc: null }]);
    expect(
      await listFleetTimeStatus({}, { ...f.auth, allowedSiteIds: [] }),
    ).toMatchObject({ total: 0, data: [], domains: [] });
  });
  const partnerContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [f.a.id, f.b.id],
    accessiblePartnerIds: [f.partner.id],
    currentPartnerId: f.partner.id,
  };
  const partnerAuth = {
    ...f.auth,
    scope: 'partner',
    orgId: null,
    orgCondition: (column: any) => inArray(column, [f.a.id, f.b.id]),
    canAccessOrg: (id: string) => [f.a.id, f.b.id].includes(id),
  } as AuthContext;
  await withDbAccessContext(partnerContext, async () => {
    const value = await listFleetTimeStatus({ role: 'member' }, partnerAuth);
    expect(new Set(value.domains.map((d) => d.orgId))).toEqual(
      new Set([f.a.id, f.b.id]),
    );
    expect(value.domains.find((d) => d.orgId === f.a.id)?.pdcEnrolled).toBe(
      true,
    );
    expect(value.domains.find((d) => d.orgId === f.b.id)?.pdcEnrolled).toBe(
      false,
    );
  });
});
it('matches the current view after both directions of a site edit without rewriting daily evidence', async () => {
  const f = await fixture();
  await withDbAccessContext(f.context, async () => {
    const [before] = await db
      .select()
      .from(deviceTimeDaily)
      .where(eq(deviceTimeDaily.deviceId, f.member.id));
    await db
      .update(sites)
      .set({ timezone: 'America/New_York' })
      .where(eq(sites.id, f.sa.id));
    const view = await getDeviceTimeStatusView(f.member.id);
    const mismatch = await listFleetTimeStatus(
      { deviceId: f.member.id, finding: 'timezone_mismatch' },
      f.auth,
    );
    expect(mismatch.total).toBe(1);
    expect(mismatch.data[0]!.view).toEqual(view);
    await db
      .update(sites)
      .set({ timezone: 'UTC' })
      .where(eq(sites.id, f.sa.id));
    expect(
      (
        await listFleetTimeStatus(
          { deviceId: f.member.id, finding: 'timezone_mismatch' },
          f.auth,
        )
      ).total,
    ).toBe(0);
    const [after] = await db
      .select()
      .from(deviceTimeDaily)
      .where(eq(deviceTimeDaily.deviceId, f.member.id));
    expect(after).toEqual(before);
  });
});
it('exports only authorized devices and explicit missing days', async () => {
  const f = await fixture();
  const yesterday = new Date(Date.parse(`${f.today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  await withDbAccessContext(f.context, async () => {
    let csv = '';
    for await (const chunk of exportHistoryTimeCsv(
      { deviceId: f.member.id },
      { from: yesterday, to: f.today },
      f.auth,
    ))
      csv += chunk;
    expect(csv).toContain(f.member.id);
    expect(csv).not.toContain(f.other.id);
    expect(csv).not.toContain(f.pdc.id);
    expect(csv).toContain(`"${yesterday}","gap"`);
    expect(csv).toContain(`"${f.today}","observed"`);
  });
});
