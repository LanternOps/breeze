/**
 * Integration (#10408): query_devices and manage_alerts list rows carry their
 * organization for a caller whose reach spans several orgs.
 *
 * Real Postgres, real RLS (`breeze_app` via `withDbAccessContext`): proves the
 * `orgName` correlated subquery (aiToolOrgLegend.orgNameOf) is valid SQL,
 * resolves names under the caller's partner-scoped RLS, and that a
 * single-org caller's rows stay unchanged.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext } from '../../db';
import { alerts, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { registerDeviceTools } from '../../services/aiToolsDevice';
import { registerAlertTools } from '../../services/aiToolsAlerts';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

function handlerFor(register: (m: Map<string, AiTool>) => void, name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  register(reg);
  return reg.get(name)!.handler;
}

function partnerAuth(partnerId: string, accessibleOrgIds: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: randomUUID(), email: 'partner-op@example.com', name: 'Partner Op', isPlatformAdmin: false },
    token: {} as never,
    partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds,
    // Real RLS enforces the org axis; the app condition stays a no-op so the
    // test proves the real gate.
    orgCondition: () => undefined,
    canAccessOrg: (o: string) => accessibleOrgIds.includes(o),
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

const asPartner = <T>(partnerId: string, orgIds: string[], fn: () => Promise<T>) => withDbAccessContext(
  { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId },
  fn,
);

async function seed() {
  const marker = randomUUID().slice(0, 8);
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: `Bullet Ltd ${marker}` });
  const orgB = await createOrganization({ partnerId: partner.id, name: `Acme ${marker}` });
  const otherPartner = await createPartner();
  const orgOther = await createOrganization({ partnerId: otherPartner.id, name: `Foreign ${marker}` });
  const ids: Record<string, string> = {};
  for (const [key, org] of [['a', orgA], ['b', orgB], ['other', orgOther]] as const) {
    const site = await createSite({ orgId: org.id });
    const [d] = await getTestDb().insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `agent-${randomUUID()}`, hostname: `orgrows-${marker}-${key}`,
      osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
    }).returning();
    await getTestDb().insert(alerts).values({
      orgId: org.id, deviceId: d!.id, severity: 'high', status: 'active', title: `orgrows ${marker} ${key}`,
    });
    ids[key] = d!.id;
  }
  return { marker, partner, orgA, orgB, orgOther, ids };
}

describe('#10408 — list rows carry their organization for a multi-org caller', () => {
  it('query_devices: orgId per row + organizations legend, names resolved under partner RLS', async () => {
    const fx = await seed();
    const orgIds = [fx.orgA.id, fx.orgB.id];
    const handler = handlerFor(registerDeviceTools, 'query_devices');
    const out = JSON.parse(await asPartner(fx.partner.id, orgIds, () =>
      handler({ search: `orgrows-${fx.marker}` }, partnerAuth(fx.partner.id, orgIds)))) as {
      devices: Array<{ id: string; orgId: string; orgName?: unknown }>;
      organizations: Array<{ orgId: string; orgName: string | null }>;
      error?: string;
    };

    expect(out.error).toBeUndefined();
    expect(out.devices.map((d) => [d.id, d.orgId])).toEqual([[fx.ids.a, fx.orgA.id], [fx.ids.b, fx.orgB.id]]);
    expect(out.devices.every((d) => d.orgName === undefined)).toBe(true);
    expect(out.organizations).toEqual([
      { orgId: fx.orgA.id, orgName: fx.orgA.name },
      { orgId: fx.orgB.id, orgName: fx.orgB.name },
    ]);
  });

  it('manage_alerts list: orgId per row + organizations legend; another partner\'s alert never appears', async () => {
    const fx = await seed();
    const orgIds = [fx.orgA.id, fx.orgB.id];
    const handler = handlerFor(registerAlertTools, 'manage_alerts');
    const out = JSON.parse(await asPartner(fx.partner.id, orgIds, () =>
      handler({ action: 'list', limit: 100 }, partnerAuth(fx.partner.id, orgIds)))) as {
      alerts: Array<{ title: string; orgId: string }>;
      organizations: Array<{ orgId: string; orgName: string | null }>;
      error?: string;
    };

    expect(out.error).toBeUndefined();
    const mine = out.alerts.filter((a) => a.title.startsWith(`orgrows ${fx.marker}`));
    expect(mine.map((a) => [a.title, a.orgId]).sort()).toEqual([
      [`orgrows ${fx.marker} a`, fx.orgA.id],
      [`orgrows ${fx.marker} b`, fx.orgB.id],
    ]);
    const names = new Map(out.organizations.map((o) => [o.orgId, o.orgName]));
    expect(names.get(fx.orgA.id)).toBe(fx.orgA.name);
    expect(names.get(fx.orgB.id)).toBe(fx.orgB.name);
    expect(names.has(fx.orgOther.id)).toBe(false);
  });

  it('a single-org caller gets the unchanged row shape', async () => {
    const fx = await seed();
    const handler = handlerFor(registerDeviceTools, 'query_devices');
    const out = JSON.parse(await asPartner(fx.partner.id, [fx.orgA.id], () =>
      handler({ search: `orgrows-${fx.marker}` }, partnerAuth(fx.partner.id, [fx.orgA.id])))) as Record<string, unknown> & {
      devices: Array<Record<string, unknown>>;
    };
    expect(out.devices.map((d) => d.id)).toEqual([fx.ids.a]);
    expect(out.devices[0]).not.toHaveProperty('orgId');
    expect(out).not.toHaveProperty('organizations');
  });
});
