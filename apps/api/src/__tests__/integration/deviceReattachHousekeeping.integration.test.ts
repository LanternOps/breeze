/**
 * Reattach intent expiry and retention, and the holding-area housekeeping
 * that must leave an open reattach alone (#8318 wave 1b, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §4.3 "Retention", §6.5 "Expiry", "Holding-area housekeeping", "Competing
 * reattachments").
 *
 * Proven here:
 *   - the sweep expires a requested intent past 60 minutes and a staged one
 *     past 15, discarding the staged hashes but keeping the confirmation hash
 *     (a later confirm gets the typed `expired`), and demotes the pending
 *     certificate; an unexpired intent is untouched;
 *   - terminal intents older than 30 days are pruned; open and recent ones
 *     stay; the ledger is not touched;
 *   - scheduled parked expiry and purge skip a device in an open intent;
 *     the deploy-key incident cancels the intent (`key_revoked`) and then
 *     expires the source, and a later confirm gets 409 cancelled;
 *   - a confirm racing parked expiry: one wins, never both, in both orders.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceReattachHousekeeping.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLogs, deviceMtlsCertificates, devicePoolAssignmentEvents, deviceReattachIntents, deviceReattachments, devices } from '../../db/schema';
import { confirmRebindIntent } from '../../services/deviceReattach/confirm';
import { runReattachIntentSweepOnce } from '../../services/deviceReattach/expirySweep';
import { cancelReattachIntent, requestDeviceReattach } from '../../services/deviceReattach/requestIntent';
import { stageRebindIntent } from '../../services/deviceReattach/stage';
import { expireParkedDevice, purgeExpiredParkedDevice } from '../../services/unassignedPool/parkedExpiry';
import {
  ageIntent,
  parkedSource,
  readDevice,
  readIntent,
  seedReattachTenant,
  silentTarget,
  stagedSet,
  type ReattachTenant,
  type SeededAgentDevice,
} from './deviceReattachFixtures';
import { getTestDb } from './setup';

const NO_CERT = { assertionTrusted: false, assertedVerified: false, assertedSerial: null };

async function requested(tenant: ReattachTenant, source: SeededAgentDevice, target: SeededAgentDevice, now?: Date) {
  const result = await requestDeviceReattach({
    actor: { userId: tenant.admin.id }, sourceDeviceId: source.id, targetDeviceId: target.id,
    evidenceLevel: 'hint', restoreDecommissioned: false, ...(now ? { now } : {}),
  });
  if (!result.ok) throw new Error(`request refused: ${result.code}`);
  return result.intent;
}

async function staged(source: SeededAgentDevice, intentId: string, now?: Date) {
  const set = stagedSet();
  const result = await stageRebindIntent({
    caller: { deviceId: source.id, agentId: source.agentId }, intentId, ...set.hashes, ...(now ? { now } : {}),
  });
  if (!result.ok) throw new Error(`stage refused: ${result.code}`);
  return set;
}

/** A pending_activation certificate row on the target, recorded as the intent's staged one. */
async function attachPendingCertificate(target: SeededAgentDevice, intentId: string) {
  const [cert] = await getTestDb().insert(deviceMtlsCertificates).values({
    orgId: target.orgId, deviceId: target.id, providerCertificateId: `cf-${randomUUID()}`,
    serialNumber: randomUUID().replace(/-/g, '').toUpperCase(), legacyProvenance: true,
    state: 'pending_activation', issuedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000),
    activationExpiresAt: new Date(Date.now() + 15 * 60_000),
  }).returning({ id: deviceMtlsCertificates.id });
  await getTestDb().update(deviceReattachIntents).set({ stagedMtlsCertificateId: cert!.id }).where(eq(deviceReattachIntents.id, intentId));
  return cert!.id;
}

async function poolEvents(deviceId: string) {
  return getTestDb().select({ eventType: devicePoolAssignmentEvents.eventType })
    .from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.deviceId, deviceId));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the reattach intent sweep (#8318 §6.5 "Expiry", §4.3 "Retention")', () => {
  it('expires requested (60 min) and staged (15 min) intents, keeps the confirmation hash, demotes the pending certificate, leaves live ones alone', async () => {
    const tenant = await seedReattachTenant();
    const now = Date.now();

    // Requested 2 h ago: past its 60 minutes.
    const s1 = await parkedSource(tenant);
    // (Its target must have been silent at that past request time too.)
    const staleTarget = await silentTarget(tenant.orgA, { lastSeenAt: new Date(now - 4 * 3_600_000) });
    const stale = await requested(tenant, s1, staleTarget, new Date(now - 2 * 3_600_000));
    // Requested 40 min ago, staged 20 min ago: past its 15 minutes.
    const s2 = await parkedSource(tenant);
    const t2 = await silentTarget(tenant.orgA);
    const stagedIntent = await requested(tenant, s2, t2, new Date(now - 40 * 60_000));
    const set = await staged(s2, stagedIntent.id, new Date(now - 20 * 60_000));
    const certId = await attachPendingCertificate(t2, stagedIntent.id);
    // Live: requested now.
    const live = await requested(tenant, await parkedSource(tenant), await silentTarget(tenant.orgA));

    const summary = await runReattachIntentSweepOnce(new Date(now));
    expect(summary).toMatchObject({ candidates: 2, expired: 2, failed: 0 });

    expect(await readIntent(stale.id)).toMatchObject({ state: 'expired', cancelReason: null });
    expect(await readIntent(stagedIntent.id)).toMatchObject({
      state: 'expired', stagedTokenHash: null, stagedWatchdogTokenHash: null, stagedHelperTokenHash: null,
      confirmationTokenHash: set.hashes.confirmationTokenHash,
    });
    const [cert] = await getTestDb().select({ state: deviceMtlsCertificates.state }).from(deviceMtlsCertificates).where(eq(deviceMtlsCertificates.id, certId));
    expect(cert?.state).toMatch(/^(pending_revocation|revoked)$/);
    expect(await readIntent(live.id)).toMatchObject({ state: 'requested' });

    const audits = await getTestDb().select({ orgId: auditLogs.orgId }).from(auditLogs)
      .where(and(eq(auditLogs.action, 'device.reinstall.expired'), eq(auditLogs.resourceId, t2.id)));
    expect(audits).toHaveLength(2);

    // The staged set is never activated after expiry: the confirm gets the typed answer.
    const late = await confirmRebindIntent({ sourceAgentId: s2.agentId, token: set.tokens.confirmationToken, assertion: NO_CERT });
    expect(late).toMatchObject({ ok: false, status: 409, code: 'expired', state: 'expired' });
    expect((await readDevice(t2.id))!.installIncarnation).toBe(1);

    // A second pass finds nothing to do.
    expect(await runReattachIntentSweepOnce(new Date(now))).toMatchObject({ candidates: 0, expired: 0 });
  });

  it('prunes terminal intents older than 30 days, never open or recent ones, never the ledger', async () => {
    const tenant = await seedReattachTenant();
    const old = await requested(tenant, await parkedSource(tenant), await silentTarget(tenant.orgA));
    await cancelReattachIntent(old.id, 'admin');
    await ageIntent(old.id, 31 * 86_400_000);
    const recent = await requested(tenant, await parkedSource(tenant), await silentTarget(tenant.orgA));
    await cancelReattachIntent(recent.id, 'admin');
    const open = await requested(tenant, await parkedSource(tenant), await silentTarget(tenant.orgA));
    await getTestDb().insert(deviceReattachments).values({
      partnerId: tenant.partnerId, intentId: old.id, sourceDeviceId: old.sourceDeviceId, sourceAgentId: old.sourceAgentId,
      sourceOrgId: old.sourceOrgId, sourceParked: true, targetDeviceId: old.targetDeviceId, targetOrgId: old.targetOrgId,
      targetSiteId: tenant.orgA.siteId, targetPreviousAgentId: old.targetAgentId, stagedAgentId: 'x'.repeat(64),
      targetPreviousIncarnation: 1, targetNewIncarnation: 2, actorUserId: tenant.admin.id, evidenceLevel: 'hint',
      confirmationTokenHash: 'c'.repeat(64),
    });

    const summary = await runReattachIntentSweepOnce();
    expect(summary.pruned).toBe(1);
    expect(await readIntent(old.id)).toBeUndefined();
    expect(await readIntent(recent.id)).toMatchObject({ state: 'cancelled' });
    expect(await readIntent(open.id)).toMatchObject({ state: 'requested' });
    const ledger = await getTestDb().select().from(deviceReattachments).where(eq(deviceReattachments.intentId, old.id));
    expect(ledger).toHaveLength(1);
  });
});

describe('holding-area housekeeping leaves an open reattach alone (#8318 §6.5)', () => {
  it('scheduled parked expiry skips the source of an open intent, and expires it once the intent ended', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    const intent = await requested(tenant, source, await silentTarget(tenant.orgA));
    const skipped = await expireParkedDevice({ partnerId: tenant.partnerId, deviceId: source.id, actorUserId: null, reason: 'parking_window' });
    expect(skipped).toEqual({ expired: false, deviceId: source.id, reason: 'IN_REATTACH' });
    expect((await readDevice(source.id))!.status).not.toBe('decommissioned');
    expect(await readIntent(intent.id)).toMatchObject({ state: 'requested' });

    await cancelReattachIntent(intent.id, 'admin');
    const expired = await expireParkedDevice({ partnerId: tenant.partnerId, deviceId: source.id, actorUserId: null, reason: 'parking_window' });
    expect(expired).toMatchObject({ expired: true, deviceId: source.id });
  });

  it('a deploy-key incident cancels the open intent (key_revoked), then expires the source; a later confirm gets 409 cancelled', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    const target = await silentTarget(tenant.orgA);
    const intent = await requested(tenant, source, target);
    const set = await staged(source, intent.id);

    const outcome = await expireParkedDevice({
      partnerId: tenant.partnerId, deviceId: source.id, actorUserId: tenant.admin.id, reason: 'deploy_key_incident',
    });
    expect(outcome).toMatchObject({ expired: true });
    expect(await readIntent(intent.id)).toMatchObject({ state: 'cancelled', cancelReason: 'key_revoked', stagedTokenHash: null });
    expect((await readDevice(source.id))!.status).toBe('decommissioned');
    const audits = await getTestDb().select({ details: auditLogs.details }).from(auditLogs)
      .where(and(eq(auditLogs.action, 'device.reinstall.cancelled'), eq(auditLogs.resourceId, target.id)));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect((audits[0]!.details as Record<string, unknown>).cancelReason).toBe('key_revoked');

    const late = await confirmRebindIntent({ sourceAgentId: source.agentId, token: set.tokens.confirmationToken, assertion: NO_CERT });
    expect(late).toMatchObject({ ok: false, status: 409, code: 'cancelled', cancelReason: 'key_revoked' });
    expect((await readDevice(target.id))!.installIncarnation).toBe(1);
  });

  it('scheduled purge skips a removed parked device an open intent still names', async () => {
    const tenant = await seedReattachTenant();
    const source = await parkedSource(tenant);
    await requested(tenant, source, await silentTarget(tenant.orgA));
    await getTestDb().update(devices).set({ status: 'decommissioned', decommissionedAt: new Date(Date.now() - 86_400_000) })
      .where(eq(devices.id, source.id));
    const outcome = await purgeExpiredParkedDevice({ partnerId: tenant.partnerId, deviceId: source.id, cutoff: new Date() });
    expect(outcome).toEqual({ purged: false, deviceId: source.id, reason: 'IN_REATTACH' });
    expect(await readDevice(source.id)).toBeDefined();
  });

  describe('a confirm racing parked expiry: one wins, never both', () => {
    it('confirm holds the locks first: the expiry waits, then finds the source already retired', async () => {
      const tenant = await seedReattachTenant();
      const source = await parkedSource(tenant);
      const target = await silentTarget(tenant.orgA);
      const intent = await requested(tenant, source, target);
      const set = await staged(source, intent.id);

      let expiry: Promise<unknown> | null = null;
      const confirmed = await confirmRebindIntent({
        sourceAgentId: source.agentId,
        token: set.tokens.confirmationToken,
        assertion: NO_CERT,
        hooks: {
          afterLocks: async () => {
            expiry = expireParkedDevice({ partnerId: tenant.partnerId, deviceId: source.id, actorUserId: tenant.admin.id, reason: 'deploy_key_incident' });
            await sleep(300); // the expiry is now queued on the holding-area lock
          },
        },
      });
      expect(confirmed).toMatchObject({ ok: true, replay: false });
      await expect(expiry!).resolves.toMatchObject({ expired: false, reason: 'ALREADY_REMOVED' });
      expect((await poolEvents(source.id)).map((e) => e.eventType)).toEqual(['reattached']);
      expect(await readIntent(intent.id)).toMatchObject({ state: 'confirmed' });
    });

    it('expiry holds the locks first (incident): it cancels the intent and expires the source; the waiting confirm gets 409 cancelled', async () => {
      const tenant = await seedReattachTenant();
      const source = await parkedSource(tenant);
      const target = await silentTarget(tenant.orgA);
      const intent = await requested(tenant, source, target);
      const set = await staged(source, intent.id);

      let confirm: Promise<unknown> | null = null;
      const outcome = await expireParkedDevice(
        { partnerId: tenant.partnerId, deviceId: source.id, actorUserId: tenant.admin.id, reason: 'deploy_key_incident' },
        {
          hooks: {
            afterDeviceLock: async () => {
              confirm = confirmRebindIntent({ sourceAgentId: source.agentId, token: set.tokens.confirmationToken, assertion: NO_CERT });
              await sleep(300); // the confirm is now queued on the holding-area lock
            },
          },
        },
      );
      expect(outcome).toMatchObject({ expired: true });
      await expect(confirm!).resolves.toMatchObject({ ok: false, status: 409, code: 'cancelled', cancelReason: 'key_revoked' });
      expect((await poolEvents(source.id)).map((e) => e.eventType)).toEqual(['expired']);
      expect((await readDevice(target.id))!.installIncarnation).toBe(1);
    });

    it('scheduled expiry holds the locks first: it skips the source (IN_REATTACH) and the confirm then commits', async () => {
      const tenant = await seedReattachTenant();
      const source = await parkedSource(tenant);
      const target = await silentTarget(tenant.orgA);
      const intent = await requested(tenant, source, target);
      const set = await staged(source, intent.id);

      let confirm: Promise<unknown> | null = null;
      const outcome = await expireParkedDevice(
        { partnerId: tenant.partnerId, deviceId: source.id, actorUserId: null, reason: 'parking_window' },
        {
          hooks: {
            afterDeviceLock: async () => {
              confirm = confirmRebindIntent({ sourceAgentId: source.agentId, token: set.tokens.confirmationToken, assertion: NO_CERT });
              await sleep(300);
            },
          },
        },
      );
      expect(outcome).toMatchObject({ expired: false, reason: 'IN_REATTACH' });
      await expect(confirm!).resolves.toMatchObject({ ok: true });
      expect((await poolEvents(source.id)).map((e) => e.eventType)).toEqual(['reattached']);
      expect(await readIntent(intent.id)).toMatchObject({ state: 'confirmed' });
    });
  });
});
