/**
 * Real-PostgreSQL proof for the restore-point request chokepoint (#4756, W05 of
 * #4751): runs as the unprivileged `breeze_app` role under forced RLS.
 *
 *  - policy ON  -> the real script dispatch stamps `payload.restorePoint` AND a
 *                  `requested` ledger row exists, readable under the org's RLS;
 *  - no policy  -> no key on the payload and no ledger row;
 *  - a PARTNER-WIDE policy assigned at partner level stamps a device in a
 *    child org (resolution escapes the caller's narrower context);
 *  - an expired snapshot is superseded and re-stamped at the delivery claim,
 *    with only the `restorePoint` key written back to the command row.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceCommands,
  devices,
} from '../../db/schema';
import { deviceRestorePointAttempts } from '../../db/schema/deviceRestorePointAttempts';
import { dispatchScriptToDevice } from '../../services/scriptDispatch';
import {
  RESTORE_POINT_SUPERSEDED_MESSAGE,
  buildRestorePointRequest,
  refreshRestorePointForDelivery,
} from '../../services/restorePointRequest';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const createdPolicies: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
  createdPolicies.length = 0;
});

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `rp-${randomUUID()}`,
      hostname: `rp-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '0.99.0',
      // Offline: the dispatch queues the command row without a websocket push.
      status: 'offline',
      deviceRole: 'workstation',
    }).returning();
    return d!;
  });
  return { partner, org, site, device };
}

async function seedSystemProtection(
  owner: { orgId: string | null; partnerId: string | null },
  level: 'partner' | 'organization',
  targetId: string,
  inlineSettings: Record<string, unknown>,
): Promise<void> {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db.insert(configurationPolicies).values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      name: `system protection ${randomUUID()}`,
      status: 'active',
    }).returning();
    createdPolicies.push(policy!.id);
    await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'system_protection',
      inlineSettings,
    });
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id,
      level,
      targetId,
      priority: 0,
    });
  });
}

async function dispatchRawScript(ctx: DbAccessContext, device: typeof devices.$inferSelect) {
  return withDbAccessContext(ctx, () =>
    dispatchScriptToDevice({
      device,
      source: { kind: 'raw', content: 'Write-Output ok', language: 'powershell', provenance: 'restore-point-it' },
    }),
  );
}

async function commandPayload(ctx: DbAccessContext, commandId: string): Promise<Record<string, unknown>> {
  return withDbAccessContext(ctx, async () => {
    const [row] = await db
      .select({ payload: deviceCommands.payload })
      .from(deviceCommands)
      .where(eq(deviceCommands.id, commandId));
    return row!.payload as Record<string, unknown>;
  });
}

async function attemptsFor(ctx: DbAccessContext, deviceId: string) {
  return withDbAccessContext(ctx, () =>
    db.select().from(deviceRestorePointAttempts).where(eq(deviceRestorePointAttempts.deviceId, deviceId)),
  );
}

describe('restore-point request chokepoint against real Postgres', () => {
  runDb('runs as breeze_app (no superuser / BYPASSRLS), so RLS assertions are not vacuous', async () => {
    const role = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `)) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });
  });

  runDb('policy ON: the dispatched script payload carries the block and a requested row exists under org RLS', async () => {
    const { partner, org, device } = await seedTenant();
    await seedSystemProtection({ orgId: org.id, partnerId: null }, 'organization', org.id, {
      beforeScripts: true,
      labelPrefix: 'Acme',
    });
    const ctx = orgContext(org.id, partner.id);

    const result = await dispatchRawScript(ctx, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = await commandPayload(ctx, result.commandId);
    const block = payload.restorePoint as Record<string, unknown>;
    expect(Object.keys(block).sort()).toEqual(
      ['enabled', 'label', 'policyRevision', 'requestId', 'resolvedAt', 'v', 'validUntil'],
    );
    expect(block).toMatchObject({ v: 1, enabled: true, label: 'Acme: run command' });

    const rows = await attemptsFor(ctx, device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: block.requestId,
      orgId: org.id,
      deviceCommandId: result.commandId,
      trigger: 'script',
      status: 'requested',
    });
  });

  runDb('no policy anywhere: no restorePoint key and no ledger row', async () => {
    const { partner, org, device } = await seedTenant();
    const ctx = orgContext(org.id, partner.id);

    const result = await dispatchRawScript(ctx, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = await commandPayload(ctx, result.commandId);
    expect('restorePoint' in payload).toBe(false);
    expect(await attemptsFor(SYSTEM_CTX, device.id)).toHaveLength(0);
  });

  runDb('a partner-wide policy assigned at partner level stamps a device in a child org', async () => {
    const { partner, org, device } = await seedTenant();
    await seedSystemProtection({ orgId: null, partnerId: partner.id }, 'partner', partner.id, {
      beforeScripts: true,
    });
    const ctx = orgContext(org.id, partner.id);

    const result = await dispatchRawScript(ctx, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const payload = await commandPayload(ctx, result.commandId);
    expect(payload.restorePoint).toMatchObject({ v: 1, enabled: true, label: 'Breeze: run command' });
    const rows = await attemptsFor(ctx, device.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBe(org.id);
  });

  runDb('an expired snapshot is superseded and re-stamped at the delivery claim, persisting only that key', async () => {
    const { partner, org, device } = await seedTenant();
    await seedSystemProtection({ orgId: org.id, partnerId: null }, 'organization', org.id, {
      beforeScripts: true,
    });
    const ctx = orgContext(org.id, partner.id);
    const result = await dispatchRawScript(ctx, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const original = (await commandPayload(ctx, result.commandId)).restorePoint as Record<string, unknown>;

    // Age the snapshot and model the claim (status sent + claim timestamp).
    const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      UPDATE device_commands
      SET payload = jsonb_set(payload, '{restorePoint,validUntil}', '"2020-01-01T00:00:00.000Z"'::jsonb),
          status = 'sent', executed_at = ${claimedAt.toISOString()}::timestamptz
      WHERE id = ${result.commandId}::uuid
    `));
    const aged = await commandPayload(ctx, result.commandId);

    const delivered = await withDbAccessContext(ctx, () =>
      refreshRestorePointForDelivery(aged, {
        commandId: result.commandId,
        deviceId: device.id,
        type: 'script',
        claimedAt,
      }),
    );

    const fresh = delivered.restorePoint as Record<string, unknown>;
    expect(fresh.requestId).not.toBe(original.requestId);
    expect(Date.parse(fresh.validUntil as string)).toBeGreaterThan(Date.now());

    // Only restorePoint changed on the stored row.
    const stored = await commandPayload(ctx, result.commandId);
    expect(stored.restorePoint).toEqual(fresh);
    const { restorePoint: _a, ...storedRest } = stored;
    const { restorePoint: _b, ...agedRest } = aged;
    expect(storedRest).toEqual(agedRest);

    const rows = await attemptsFor(ctx, device.id);
    const old = rows.find((r) => r.requestId === original.requestId);
    const next = rows.find((r) => r.requestId === fresh.requestId);
    expect(old).toMatchObject({ status: 'failed', message: RESTORE_POINT_SUPERSEDED_MESSAGE });
    expect(next).toMatchObject({ status: 'requested', deviceCommandId: result.commandId });

    // A second delivery of the same command reuses the persisted snapshot.
    const again = await withDbAccessContext(ctx, () =>
      refreshRestorePointForDelivery(stored, {
        commandId: result.commandId,
        deviceId: device.id,
        type: 'script',
        claimedAt,
      }),
    );
    expect(again).toBe(stored);
    expect(await attemptsFor(ctx, device.id)).toHaveLength(2);

    // Housekeeping for the next test's assertions on this device is not needed
    // (fresh tenant per test); confirm nothing leaked to another org's view.
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const leaked = await withDbAccessContext(orgContext(otherOrg.id, partner.id), () =>
      db.select().from(deviceRestorePointAttempts).where(and(
        eq(deviceRestorePointAttempts.deviceId, device.id),
      )),
    );
    expect(leaked).toHaveLength(0);
  });

  runDb('an explicit beforePatching:false stamps enabled:false for patch through the real resolver, with no row', async () => {
    const { partner, org, device } = await seedTenant();
    await seedSystemProtection({ orgId: org.id, partnerId: null }, 'organization', org.id, { beforePatching: false });
    const block = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      buildRestorePointRequest({ deviceId: device.id, orgId: org.id, osType: device.osType, trigger: 'patch', label: 'install 1 update' }),
    );
    expect(block).toMatchObject({ v: 1, enabled: false });
    expect(await attemptsFor(SYSTEM_CTX, device.id)).toHaveLength(0);
  });

  runDb('a re-stamp whose claim no longer matches throws, leaves the payload untouched, and discards the new row', async () => {
    const { partner, org, device } = await seedTenant();
    await seedSystemProtection({ orgId: org.id, partnerId: null }, 'organization', org.id, { beforeScripts: true });
    const ctx = orgContext(org.id, partner.id);
    const result = await dispatchRawScript(ctx, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const claimedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      UPDATE device_commands
      SET payload = jsonb_set(payload, '{restorePoint,validUntil}', '"2020-01-01T00:00:00.000Z"'::jsonb),
          status = 'sent', executed_at = ${claimedAt.toISOString()}::timestamptz
      WHERE id = ${result.commandId}::uuid
    `));
    const aged = await commandPayload(ctx, result.commandId);

    await expect(withDbAccessContext(ctx, () =>
      refreshRestorePointForDelivery(aged, {
        commandId: result.commandId,
        deviceId: device.id,
        type: 'script',
        claimedAt: new Date(claimedAt.getTime() - 60_000), // a different (older) claim
      }),
    )).rejects.toThrow(/no longer held by this claim/);

    expect(await commandPayload(ctx, result.commandId)).toEqual(aged);
    const rows = await attemptsFor(ctx, device.id);
    // the original row (superseded) remains; the would-be replacement was discarded
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', message: RESTORE_POINT_SUPERSEDED_MESSAGE });
  });
});
