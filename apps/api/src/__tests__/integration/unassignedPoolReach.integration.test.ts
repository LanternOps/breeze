/**
 * Holding org — behavioural reach proofs
 * against real Postgres for the org-reach computations that the static
 * contract (unassignedPoolContracts.test.ts) can only check by name.
 *
 * Every case seeds a partner with one regular org and its holding org, then
 * drives the real code path and asserts the holding org never comes back. Each
 * case also carries a control (the same fixture with only the regular org)
 * proving the fixture can succeed, so a refusal is attributable to the
 * holding-org exclusion and not to a broken fixture.
 *
 * Covered: partnerOrgSelection.partnerMemberMayReachOrg, partner API principal
 * discovery (middleware/partnerApiAuth.ts), every eventWs org-reach block
 * (legacy ticket, system ticket, partner ticket, system ticket minting by
 * partner and by org), AI live-session authority and report-history reach.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    // Only the ws-ticket route test drives this; it injects a system-scope
    // caller and opens the same system DB context the real middleware would,
    // so the route's own org-resolution queries run for real.
    authMiddleware: async (c: any, next: () => Promise<void>) => {
      if (!authState.current) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', authState.current);
      const { withDbAccessContext } = await import('../../db');
      return withDbAccessContext(
        { scope: 'system', orgId: null, accessibleOrgIds: null, userId: (authState.current.user as { id: string }).id },
        () => next(),
      );
    },
  };
});

import type { Database } from '../../db';
import { organizations, partnerServicePrincipals, partnerUsers, users } from '../../db/schema';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';
import {
  _clearTicketStore,
  _storeLegacyTicketForTests,
  consumeTicket,
  createEventWsTicketRoute,
  resolveLiveEventAuthorization,
  type EventTicketV3,
} from '../../routes/eventWs';
import { resolveLiveSessionToolAuthority } from '../../services/aiSessionLiveAuthority';
import { partnerMemberMayReachOrg } from '../../services/partnerOrgSelection';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { computeReportHistoryReach } from '../../services/reportHistoryAccess';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
  userEpochs,
} from './db-utils';
import { getTestDb } from './setup';
import { seedHoldingOrg } from './unassignedPoolFixtures';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

let partnerId: string;
let regularOrgId: string;
let holdingOrgId: string;

beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  authState.current = null;
  _clearTicketStore();
  const partner = await createPartner();
  partnerId = partner.id;
  regularOrgId = (await createOrganization({ partnerId })).id;
  holdingOrgId = (await seedHoldingOrg(partnerId)).orgId;
});

async function partnerMember(orgAccess: 'all' | 'selected', perms: Array<{ resource: string; action: string }> = []) {
  const role = await createRole({ scope: 'partner', partnerId });
  if (perms.length > 0) await grantRolePermissions(role.id, perms);
  const user = await createUser({ partnerId, email: `reach-${randomUUID()}@example.com` });
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  return user;
}

async function platformAdmin() {
  const user = await createUser({ partnerId, email: `reach-admin-${randomUUID()}@example.com` });
  await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, user.id));
  return user;
}

async function epochOf(userId: string): Promise<number> {
  const [row] = await getTestDb().select({ epoch: users.permissionsEpoch }).from(users).where(eq(users.id, userId));
  return row!.epoch;
}

describe('partnerMemberMayReachOrg', () => {
  runDb("refuses the holding org for org_access='all' and admits a regular org", async () => {
    const user = await partnerMember('all');
    const auth = { scope: 'partner' as const, partnerId, partnerOrgAccess: 'all' as const, user: { id: user.id } };
    expect(await partnerMemberMayReachOrg(auth, regularOrgId)).toBe(true);
    expect(await partnerMemberMayReachOrg(auth, holdingOrgId)).toBe(false);
  });

  runDb('refuses the holding org even when it sits in a curated selection', async () => {
    const user = await partnerMember('selected');
    await getTestDb().update(partnerUsers).set({ orgIds: [regularOrgId, holdingOrgId] })
      .where(eq(partnerUsers.userId, user.id));
    const auth = { scope: 'partner' as const, partnerId, partnerOrgAccess: 'selected' as const, user: { id: user.id } };
    expect(await partnerMemberMayReachOrg(auth, regularOrgId)).toBe(true);
    expect(await partnerMemberMayReachOrg(auth, holdingOrgId)).toBe(false);
  });

  runDb("refuses another partner's org for org_access='all'", async () => {
    const user = await partnerMember('all');
    const foreign = await createOrganization({ partnerId: (await createPartner()).id });
    const auth = { scope: 'partner' as const, partnerId, partnerOrgAccess: 'all' as const, user: { id: user.id } };
    expect(await partnerMemberMayReachOrg(auth, foreign.id)).toBe(false);
  });
});

describe('partner API principal discovery', () => {
  runDb('the accessible org list never contains the holding org', async () => {
    const user = await createUser({ partnerId });
    const db = getTestDb();
    const [principal] = await db.insert(partnerServicePrincipals).values({
      partnerId,
      name: `holding reach ${randomUUID()}`,
      scopes: ['organizations:read'],
      createdBy: user.id,
      updatedBy: user.id,
    }).returning();
    const { rawKey } = await issuePartnerServicePrincipalKey(db as unknown as Database, {
      partnerServicePrincipalId: principal!.id,
      partnerId,
      name: 'holding reach key',
      actorId: user.id,
      actorSessionEpochs: await userEpochs(user.id),
    });
    const app = new Hono();
    app.use('*', partnerApiAuthMiddleware);
    app.get('/reach', (c) => c.json({ orgIds: c.get('partnerApiPrincipal').accessibleOrgIds }));

    const res = await app.request('/reach', { headers: { 'X-API-Key': rawKey } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { orgIds: string[] }).orgIds).toEqual([regularOrgId]);
  });
});

describe('event WebSocket org reach', () => {
  function v3(userId: string, epoch: number, allowedOrgIds: string[], extra: Partial<EventTicketV3> = {}): EventTicketV3 {
    return {
      version: 3,
      userId,
      orgId: null,
      partnerId,
      allowedOrgIds,
      allowedSiteIds: null,
      permissionsEpoch: epoch,
      mobileDeviceId: null,
      expiresAt: Date.now() + 60_000,
      ...extra,
    };
  }

  runDb('legacy partner ticket naming the holding org is refused', async () => {
    const user = await partnerMember('all');
    const control = _storeLegacyTicketForTests({ userId: user.id, orgIds: [regularOrgId], expiresAt: Date.now() + 60_000 });
    expect((await consumeTicket(control, 'compat'))?.allowedOrgIds).toEqual([regularOrgId]);

    const ticket = _storeLegacyTicketForTests({ userId: user.id, orgIds: [regularOrgId, holdingOrgId], expiresAt: Date.now() + 60_000 });
    expect(await consumeTicket(ticket, 'compat')).toBeNull();
  });

  runDb('partner ticket naming the holding org is refused', async () => {
    const user = await partnerMember('all');
    const epoch = await epochOf(user.id);
    expect((await resolveLiveEventAuthorization(v3(user.id, epoch, [regularOrgId]))).ok).toBe(true);
    expect(await resolveLiveEventAuthorization(v3(user.id, epoch, [regularOrgId, holdingOrgId])))
      .toEqual({ ok: false, reason: 'membership_removed' });
  });

  runDb('system ticket naming the holding org is refused', async () => {
    const admin = await platformAdmin();
    const epoch = await epochOf(admin.id);
    expect((await resolveLiveEventAuthorization(v3(admin.id, epoch, [regularOrgId], { system: true }))).ok).toBe(true);
    expect(await resolveLiveEventAuthorization(v3(admin.id, epoch, [regularOrgId, holdingOrgId], { system: true })))
      .toEqual({ ok: false, reason: 'membership_removed' });
  });

  function systemAuth(userId: string) {
    return {
      user: { id: userId, email: 'admin@example.com', name: 'Admin', isPlatformAdmin: true },
      token: null,
      scope: 'system',
      orgId: null,
      partnerId: null,
      accessibleOrgIds: null,
      allowedSiteIds: null,
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    };
  }

  runDb('a system ticket minted for a partner leaves the holding org out', async () => {
    const admin = await platformAdmin();
    authState.current = systemAuth(admin.id);
    const app = createEventWsTicketRoute();
    const res = await app.request(`/ws-ticket?partnerId=${partnerId}`, { method: 'POST' });
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    const identity = await consumeTicket(ticket, 'enforce');
    expect(identity?.allowedOrgIds).toEqual([regularOrgId]);
  });

  runDb('a system ticket cannot be minted for the holding org itself', async () => {
    const admin = await platformAdmin();
    authState.current = systemAuth(admin.id);
    const app = createEventWsTicketRoute();
    expect((await app.request(`/ws-ticket?orgId=${regularOrgId}`, { method: 'POST' })).status).toBe(200);
    expect((await app.request(`/ws-ticket?orgId=${holdingOrgId}`, { method: 'POST' })).status).toBe(400);
  });
});

describe('AI live-session authority', () => {
  async function orgMemberSession(orgId: string) {
    const role = await createRole({ scope: 'organization', orgId, partnerId });
    await grantRolePermissions(role.id, [{ resource: 'devices', action: 'read' }]);
    const user = await createUser({ partnerId, orgId, email: `reach-org-${randomUUID()}@example.com` });
    await assignUserToOrganization(user.id, orgId, role.id);
    const auth = {
      principal: { kind: 'user_session' },
      user: { id: user.id, email: user.email, name: user.name, isPlatformAdmin: false },
      token: null,
      scope: 'organization',
      orgId,
      partnerId,
      accessibleOrgIds: [orgId],
      allowedSiteIds: null,
      canAccessOrg: () => true,
      canAccessSite: () => true,
      orgCondition: () => undefined,
    };
    return { auth, toolAuth: auth, orgId, deviceId: null } as any;
  }

  runDb('a session bound to the holding org is refused', async () => {
    const control = await resolveLiveSessionToolAuthority(await orgMemberSession(regularOrgId), 'query_devices', {});
    expect(control.ok).toBe(true);

    const result = await resolveLiveSessionToolAuthority(await orgMemberSession(holdingOrgId), 'query_devices', {});
    expect(result).toEqual({ ok: false, reason: 'Organization authority was removed' });
  });
});

describe('report-history reach', () => {
  runDb('a holding org in an out-of-service status is never reachable', async () => {
    // Holding-org status is deliberately not trigger-guarded (erasure and
    // offboarding still write it), so the reach query must exclude it by type.
    const suspendedOrgId = (await createOrganization({ partnerId, status: 'suspended' })).id;
    await getTestDb().update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, holdingOrgId));
    const user = await partnerMember('all', [{ resource: 'reports', action: 'read' }]);

    const reach = await computeReportHistoryReach({ partnerId, userId: user.id });
    expect([...reach.orgIds]).toEqual([suspendedOrgId]);
  });
});
