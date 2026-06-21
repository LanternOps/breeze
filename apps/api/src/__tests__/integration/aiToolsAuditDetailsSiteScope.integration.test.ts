/**
 * Integration test — query_audit_log site-narrowing of device-REFERENCING rows
 * (R3b residual).
 *
 * PR #1706 (R3b) site-narrowed `audit_logs` rows whose `resourceType` is
 * literally `'device'` (their `resourceId` is the device id). But a large class
 * of audit rows have a NON-device `resourceType` while still REFERENCING a
 * device id inside the `details` jsonb — overwhelmingly under the `details.deviceId`
 * key (the dominant write convention: device commands, elevation/PAM, backup,
 * network/authenticator changes, etc.). Those rows were returned org-axis only,
 * so a site-restricted operator's chat could read audit entries about devices in
 * sites they cannot access.
 *
 * This proves the residual fix end-to-end against real Postgres as the
 * unprivileged `breeze_app` role (so org-axis RLS is genuinely enforced while
 * the site axis is applied app-layer on top):
 *
 *   1. A site-restricted caller does NOT receive a non-device audit row whose
 *      `details.deviceId` points at an out-of-scope device.
 *   2. The same caller DOES receive a non-device audit row whose
 *      `details.deviceId` points at an IN-scope device.
 *   3. The same caller DOES receive a row with NO device reference at all
 *      (e.g. an org-level / ticket row) — we do not over-exclude.
 *   4. A row whose `details.deviceId` holds an id that is NOT a fleet device
 *      (e.g. an authenticator credential id) is NOT excluded — the predicate
 *      keys off the *forbidden org-device set*, not "any id not in the allowed
 *      set", so non-fleet ids are never mistaken for out-of-scope devices.
 *   5. An unrestricted (all-sites) caller sees every row — no-op.
 *
 * Mirrors R3/R3b: narrows both the returned rows (count is derived from rows in
 * this tool, which has no separate count query).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { db, withDbAccessContext } from '../../db';
import { auditLogs } from '../../db/schema';
import { devices, sites } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';
import { registerAuditTools } from '../../services/aiToolsAudit';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

function auditHandler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerAuditTools(reg);
  return reg.get('query_audit_log')!.handler;
}

// Build an org-scope AuthContext. `allowedSiteIds` (+ canAccessSite) makes the
// caller site-restricted; omit them for an unrestricted caller.
function makeAuth(orgId: string, allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    // The handler filters audit_logs on the org axis via orgCondition; under
    // breeze_app RLS the row is also gated by org access, so an org-scope
    // condition is the realistic shape.
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

async function seedDevice(orgId: string, siteId: string) {
  const [d] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning();
  return d!;
}

// audit_logs is append-only (rows survive the per-test TRUNCATE), so scope every
// query to a per-run marker `action` to avoid cross-run / cross-test bleed.
async function seedAudit(
  orgId: string,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: Record<string, unknown> | null,
) {
  await getTestDb()
    .insert(auditLogs)
    .values({
      orgId,
      actorType: 'user',
      actorId: randomUUID(),
      action,
      resourceType,
      resourceId,
      details,
      result: 'success',
    });
}

describe('query_audit_log — details.deviceId site narrowing (R3b residual)', () => {
  it('narrows non-device rows that reference an out-of-scope device via details.deviceId', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteAllowed = await createSite({ orgId: org.id });
    const siteForbidden = await createSite({ orgId: org.id });

    const inScopeDevice = await seedDevice(org.id, siteAllowed.id);
    const outScopeDevice = await seedDevice(org.id, siteForbidden.id);

    const marker = `r3b-residual-${randomUUID()}`;

    // (a) non-device row referencing an OUT-of-scope device → must be hidden
    await seedAudit(org.id, marker, 'remote_session', randomUUID(), {
      deviceId: outScopeDevice.id,
      reason: 'forbidden-ref',
    });
    // (b) non-device row referencing an IN-scope device → must be visible
    await seedAudit(org.id, marker, 'remote_session', randomUUID(), {
      deviceId: inScopeDevice.id,
      reason: 'allowed-ref',
    });
    // (c) row with NO device reference → must be visible (no over-exclusion)
    await seedAudit(org.id, marker, 'org_update', org.id, { field: 'name' });
    // (d) details.deviceId that is NOT a fleet device (e.g. authenticator
    //     credential id) → must be visible (keyed off forbidden device set)
    await seedAudit(org.id, marker, 'auth_authenticator', randomUUID(), {
      deviceId: randomUUID(),
      reason: 'credential-revoke',
    });
    // (e) device-typed row for an out-of-scope device → must be hidden
    //     (existing R3b device-typed narrowing stays intact)
    await seedAudit(org.id, marker, 'device', outScopeDevice.id, null);
    // (f) non-device row referencing an OUT-of-scope device via the secondary
    //     `linkedDeviceId` key (discovery linking convention) → must be hidden
    await seedAudit(org.id, marker, 'discovered_asset', randomUUID(), {
      linkedDeviceId: outScopeDevice.id,
      reason: 'forbidden-linked-ref',
    });
    // (g) non-device row referencing an IN-scope device via `linkedDeviceId`
    //     → must be visible
    await seedAudit(org.id, marker, 'discovered_asset', randomUUID(), {
      linkedDeviceId: inScopeDevice.id,
      reason: 'allowed-linked-ref',
    });

    const handler = auditHandler();
    const auth = makeAuth(org.id, [siteAllowed.id]);

    const raw = await withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
      async () => handler({ action: marker, hoursBack: 168, limit: 100 }, auth),
    );
    const parsed = JSON.parse(raw);
    const reasons = (parsed.entries ?? []).map((e: any) => e.details?.reason ?? e.resourceType);

    expect(parsed.error).toBeUndefined();
    expect(reasons).toContain('allowed-ref');
    expect(reasons).toContain('org_update');
    expect(reasons).toContain('credential-revoke');
    expect(reasons).toContain('allowed-linked-ref');
    expect(reasons).not.toContain('forbidden-ref');
    expect(reasons).not.toContain('forbidden-linked-ref');
    // device-typed out-of-scope row excluded too
    expect((parsed.entries ?? []).some((e: any) => e.resourceType === 'device')).toBe(false);
    // Exactly the 4 in-scope / no-ref rows survive (b, c, d, g) — no over- or
    // under-inclusion. Marker-scoped so only this run's rows are counted.
    expect(parsed.showing).toBe(4);
    expect(JSON.stringify(parsed)).not.toContain(outScopeDevice.id);
  });

  it('does NOT over-exclude device-referencing rows when the caller has no forbidden devices (empty forbidden set)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const onlySite = await createSite({ orgId: org.id });
    // The single device is in the caller's only allowed site, so the forbidden
    // set is empty and the details predicate must be SKIPPED entirely — the
    // device-referencing row must still be returned.
    const device = await seedDevice(org.id, onlySite.id);

    const marker = `r3b-empty-forbidden-${randomUUID()}`;
    await seedAudit(org.id, marker, 'remote_session', randomUUID(), {
      deviceId: device.id,
      reason: 'in-scope-ref',
    });
    await seedAudit(org.id, marker, 'remote_session', randomUUID(), {
      linkedDeviceId: device.id,
      reason: 'in-scope-linked-ref',
    });

    const handler = auditHandler();
    const auth = makeAuth(org.id, [onlySite.id]); // restricted, but all devices in-scope

    const raw = await withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
      async () => handler({ action: marker, hoursBack: 168, limit: 100 }, auth),
    );
    const parsed = JSON.parse(raw);
    const reasons = (parsed.entries ?? []).map((e: any) => e.details?.reason);

    expect(parsed.error).toBeUndefined();
    expect(reasons).toContain('in-scope-ref');
    expect(reasons).toContain('in-scope-linked-ref');
    expect(parsed.showing).toBe(2);
  });

  it('unrestricted caller sees every row including out-of-scope device references (no-op)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: org.id });
    const siteB = await createSite({ orgId: org.id });
    const devA = await seedDevice(org.id, siteA.id);
    const devB = await seedDevice(org.id, siteB.id);

    const marker = `r3b-unrestricted-${randomUUID()}`;
    await seedAudit(org.id, marker, 'remote_session', randomUUID(), { deviceId: devA.id, reason: 'a' });
    await seedAudit(org.id, marker, 'remote_session', randomUUID(), { deviceId: devB.id, reason: 'b' });

    const handler = auditHandler();
    const auth = makeAuth(org.id, undefined); // unrestricted

    const raw = await withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
      async () => handler({ action: marker, hoursBack: 168, limit: 100 }, auth),
    );
    const parsed = JSON.parse(raw);
    const reasons = (parsed.entries ?? []).map((e: any) => e.details?.reason);

    expect(parsed.error).toBeUndefined();
    expect(reasons).toContain('a');
    expect(reasons).toContain('b');
    expect(parsed.showing).toBe(2);
  });
});
