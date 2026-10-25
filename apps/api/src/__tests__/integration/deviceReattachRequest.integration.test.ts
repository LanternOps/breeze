/**
 * Creating and cancelling reattach intents against real PostgreSQL (#8318
 * wave 1b, spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §4.3, §6.5 "Competing reattachments", §8 "Gates" and "Refusals").
 *
 * No HTTP route creates an intent in wave 1b (that is wave 2, §8): the
 * service is driven directly, as the wave 2 route will call it.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceReattachRequest.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLogs, deviceReattachments, devices, organizations } from '../../db/schema';
import { cancelReattachIntent, requestDeviceReattach } from '../../services/deviceReattach/requestIntent';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import {
  parkedSource,
  readIntent,
  seedAgentDevice,
  seedReattachTenant,
  silentTarget,
  type ReattachTenant,
} from './deviceReattachFixtures';
import { getTestDb } from './setup';

async function request(tenant: ReattachTenant, sourceDeviceId: string, targetDeviceId: string, overrides: Partial<Parameters<typeof requestDeviceReattach>[0]> = {}) {
  return requestDeviceReattach({
    actor: { userId: tenant.admin.id },
    sourceDeviceId,
    targetDeviceId,
    evidenceLevel: 'hint',
    restoreDecommissioned: false,
    ...overrides,
  });
}

async function auditRows(action: string, resourceId: string) {
  return getTestDb().select({ orgId: auditLogs.orgId, actorId: auditLogs.actorId, details: auditLogs.details })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)));
}

describe('requestDeviceReattach (#8318 §8)', () => {
  it('creates a requested intent with the versions the human authorized, audited in both orgs', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const before = Date.now();

    const result = await request(tenant, source.id, target.id, { stepUpGrantRef: 'grant-ref-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const intent = await readIntent(result.intent.id);
    expect(intent).toMatchObject({
      partnerId: tenant.partnerId,
      sourceDeviceId: source.id,
      targetDeviceId: target.id,
      state: 'requested',
      evidenceLevel: 'hint',
      restoreDecommissioned: false,
      requestedBy: tenant.admin.id,
      stepUpGrantRef: 'grant-ref-1',
      sourceAgentId: source.agentId,
      sourceOrgId: tenant.pool.orgId,
      sourceParked: true,
      targetAgentId: target.agentId,
      targetIncarnation: 1,
      targetOrgId: tenant.orgA.orgId,
      stagedAgentId: null,
      confirmationTokenHash: null,
    });
    const ttl = intent!.expiresAt.getTime() - intent!.requestedAt.getTime();
    expect(ttl).toBe(60 * 60 * 1000);
    expect(intent!.requestedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const audits = await auditRows('device.reinstall.requested', target.id);
    expect(audits.map((a) => a.orgId).sort()).toEqual([tenant.orgA.orgId, tenant.pool.orgId].sort());
    expect(audits.every((a) => a.actorId === tenant.admin.id)).toBe(true);
  });

  it('a second request for the same target is refused at creation (409 device_in_open_intent)', async () => {
    const tenant = await seedReattachTenant();
    const target = await silentTarget(tenant.orgA);
    const first = await request(tenant, (await parkedSource(tenant)).id, target.id);
    expect(first.ok).toBe(true);
    const second = await request(tenant, (await parkedSource(tenant)).id, target.id);
    expect(second).toMatchObject({ ok: false, status: 409, code: 'device_in_open_intent' });
  });

  it('a device that is the source of an open intent cannot be requested as a target (409), nor as a source again', async () => {
    const tenant = await seedReattachTenant();
    const source = await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 });
    const first = await request(tenant, source.id, (await silentTarget(tenant.orgA)).id);
    expect(first.ok).toBe(true);
    const asTarget = await request(tenant, (await parkedSource(tenant)).id, source.id);
    expect(asTarget).toMatchObject({ ok: false, status: 409, code: 'device_in_open_intent' });
    const asSourceAgain = await request(tenant, source.id, (await silentTarget(tenant.orgA)).id);
    expect(asSourceAgain).toMatchObject({ ok: false, status: 409, code: 'device_in_open_intent' });
  });

  it('two racing requests for one target: exactly one succeeds', async () => {
    const tenant = await seedReattachTenant();
    const target = await silentTarget(tenant.orgA);
    const [s1, s2] = [await parkedSource(tenant), await parkedSource(tenant)];
    const results = await Promise.all([request(tenant, s1.id, target.id), request(tenant, s2.id, target.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ status: 409, code: 'device_in_open_intent' });
  });

  it('refuses a source that does not speak the rebind protocol', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant, { rebindProtocolVersion: 0 });
    expect(await request(tenant, source.id, (await silentTarget(tenant.orgA)).id))
      .toMatchObject({ ok: false, status: 409, code: 'rebind_unsupported' });
  });

  it.each([
    ['a quarantined target', 'target', { status: 'quarantined' as const }, 'device_quarantined'],
    ['an ephemeral target', 'target', { isEphemeral: true }, 'target_ephemeral'],
    ['a decommissioned target without restoreDecommissioned', 'target', { status: 'decommissioned' as const }, 'target_decommissioned'],
    ['a quarantined source', 'source', { status: 'quarantined' as const }, 'device_quarantined'],
    ['a decommissioned source', 'source', { status: 'decommissioned' as const }, 'source_decommissioned'],
  ])('refuses %s', async (_label, role, options, code) => {
    const tenant = await seedReattachTenant();
    const source = role === 'source' ? await parkedSource(tenant, options) : await parkedSource(tenant);
    const target = role === 'target' ? await silentTarget(tenant.orgA, options) : await silentTarget(tenant.orgA);
    expect(await request(tenant, source.id, target.id)).toMatchObject({ ok: false, status: 409, code });
  });

  it('refuses a device whose agent credentials are suspended', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    await getTestDb().update(devices).set({ agentTokenSuspendedAt: new Date(), agentTokenSuspendedReason: 'cross-tenant-probe' })
      .where(eq(devices.id, target.id));
    expect(await request(tenant, source.id, target.id)).toMatchObject({ ok: false, status: 409, code: 'device_suspended' });
  });

  it('restores a decommissioned target only when asked to', async () => {
    const tenant = await seedReattachTenant();
    const target = await silentTarget(tenant.orgA, { status: 'decommissioned' });
    const result = await request(tenant, (await parkedSource(tenant)).id, target.id, { restoreDecommissioned: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.intent.restoreDecommissioned).toBe(true);
  });

  it('refuses when either org is draining', async () => {
    const tenant = await seedReattachTenant();
    const target = await silentTarget(tenant.orgA);
    await getTestDb().update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, tenant.orgA.orgId));
    expect(await request(tenant, (await parkedSource(tenant)).id, target.id))
      .toMatchObject({ ok: false, status: 409, code: 'org_draining' });
  });

  it('refuses a target in a hidden org (a parked device is never a target)', async () => {
    const tenant = await seedReattachTenant();
    const parkedTarget = await parkedSource(tenant);
    expect(await request(tenant, (await parkedSource(tenant)).id, parkedTarget.id))
      .toMatchObject({ ok: false, status: 409, code: 'target_ineligible' });
  });

  it('refuses a target that was the source of a confirmed reattach (retired)', async () => {
    const tenant = await seedReattachTenant();
    const target = await silentTarget(tenant.orgA);
    await getTestDb().insert(deviceReattachments).values({
      partnerId: tenant.partnerId,
      intentId: randomUUID(),
      sourceDeviceId: target.id,
      sourceAgentId: target.agentId,
      sourceOrgId: tenant.orgA.orgId,
      sourceParked: false,
      targetDeviceId: randomUUID(),
      targetOrgId: tenant.orgA.orgId,
      targetSiteId: tenant.orgA.siteId,
      targetPreviousAgentId: 'old',
      stagedAgentId: 'new',
      targetPreviousIncarnation: 1,
      targetNewIncarnation: 2,
      actorUserId: tenant.admin.id,
      evidenceLevel: 'hint',
      confirmationTokenHash: 'a'.repeat(64),
    });
    expect(await request(tenant, (await parkedSource(tenant)).id, target.id))
      .toMatchObject({ ok: false, status: 409, code: 'target_retired' });
  });

  it('refuses a source and a target that are not both in the requester\'s partner (partner_mismatch)', async () => {
    const tenant = await seedReattachTenant();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const otherSite = await createSite({ orgId: otherOrg.id });
    const foreignTarget = await silentTarget({ orgId: otherOrg.id, siteId: otherSite.id });
    expect(await request(tenant, (await parkedSource(tenant)).id, foreignTarget.id))
      .toMatchObject({ ok: false, status: 409, code: 'partner_mismatch' });
  });

  it('refuses the same device as source and target, and an unknown device', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    expect(await request(tenant, source.id, source.id)).toMatchObject({ ok: false, status: 400, code: 'same_device' });
    expect(await request(tenant, source.id, randomUUID())).toMatchObject({ ok: false, status: 404, code: 'device_not_found' });
  });

  describe('the §8 access rule', () => {
    it('a technician limited to org A may reattach a real org A source onto an org A target', async () => {
      const tenant = await seedReattachTenant();
      const source = await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 });
      const target = await silentTarget(tenant.orgA);
      const result = await request(tenant, source.id, target.id, { actor: { userId: tenant.techA.id } });
      expect(result.ok).toBe(true);
    });

    it('refuses the technician a real source in an org they lack (403 org_access_denied)', async () => {
      const tenant = await seedReattachTenant();
      const source = await seedAgentDevice(tenant.orgB, { rebindProtocolVersion: 1 });
      const target = await silentTarget(tenant.orgA);
      expect(await request(tenant, source.id, target.id, { actor: { userId: tenant.techA.id } }))
        .toMatchObject({ ok: false, status: 403, code: 'org_access_denied' });
    });

    it('refuses the technician a target in an org they lack (403 org_access_denied)', async () => {
      const tenant = await seedReattachTenant();
      const source = await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 });
      const target = await silentTarget(tenant.orgB);
      expect(await request(tenant, source.id, target.id, { actor: { userId: tenant.techA.id } }))
        .toMatchObject({ ok: false, status: 403, code: 'org_access_denied' });
    });

    it('a parked source needs a full partner admin until wave H (403 full_admin_required)', async () => {
      const tenant = await seedReattachTenant();
      const target = await silentTarget(tenant.orgA);
      expect(await request(tenant, (await parkedSource(tenant)).id, target.id, { actor: { userId: tenant.techA.id } }))
        .toMatchObject({ ok: false, status: 403, code: 'full_admin_required' });
    });

    it('a customer-org user never can (403 not_partner_user)', async () => {
      const tenant = await seedReattachTenant();
      const customer = await createUser({ partnerId: tenant.partnerId, orgId: tenant.orgA.orgId, email: `cust-${randomUUID()}@reattach.test`, withMembership: true });
      const source = await seedAgentDevice(tenant.orgA, { rebindProtocolVersion: 1 });
      expect(await request(tenant, source.id, (await silentTarget(tenant.orgA)).id, { actor: { userId: customer.id } }))
        .toMatchObject({ ok: false, status: 403, code: 'not_partner_user' });
    });

    it('a user of another partner is refused (409 partner_mismatch)', async () => {
      const tenant = await seedReattachTenant();
      const other = await seedReattachTenant();
      expect(await request(tenant, (await parkedSource(tenant)).id, (await silentTarget(tenant.orgA)).id, { actor: { userId: other.admin.id } }))
        .toMatchObject({ ok: false, status: 409, code: 'partner_mismatch' });
    });
  });
});

describe('cancelReattachIntent', () => {
  it('cancels an open intent once, keeps it terminal, and audits it', async () => {
    const tenant = await seedReattachTenant();
    const target = await silentTarget(tenant.orgA);
    const created = await request(tenant, (await parkedSource(tenant)).id, target.id);
    if (!created.ok) throw new Error('setup');

    expect(await cancelReattachIntent(created.intent.id, 'admin', { actorUserId: tenant.admin.id }))
      .toEqual({ cancelled: true, intentId: created.intent.id });
    expect(await readIntent(created.intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'admin' });
    expect(await cancelReattachIntent(created.intent.id, 'admin'))
      .toEqual({ cancelled: false, intentId: created.intent.id, reason: 'not_open', state: 'cancelled' });
    expect(await cancelReattachIntent(randomUUID(), 'admin')).toMatchObject({ cancelled: false, reason: 'not_found' });

    const audits = await auditRows('device.reinstall.cancelled', target.id);
    expect(audits).toHaveLength(2); // target org + holding org
    expect(audits.every((a) => (a.details as Record<string, unknown>).cancelReason === 'admin')).toBe(true);

    // The target is free again.
    const again = await request(tenant, (await parkedSource(tenant)).id, target.id);
    expect(again.ok).toBe(true);
  });

  it('frees both devices for a later request (no open intent left)', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const created = await request(tenant, source.id, target.id);
    if (!created.ok) throw new Error('setup');
    await cancelReattachIntent(created.intent.id, 'key_revoked');
    const rows = await getTestDb().select({ id: devices.id }).from(devices).where(inArray(devices.id, [source.id, target.id]));
    expect(rows).toHaveLength(2);
    expect((await request(tenant, source.id, target.id)).ok).toBe(true);
  });
});
