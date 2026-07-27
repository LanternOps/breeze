/**
 * Real-Postgres coverage for the partner-axis system-context sweep (#2822).
 *
 * THE BUG CLASS. Partner-axis tables (`partners`, `authenticator_policies`,
 * `patch_policies`, … — the full list is `PARTNER_TENANT_TABLES` in
 * rls-coverage.integration.test.ts) are gated by
 * `breeze_has_partner_access(<partner column>)`, which evaluates against the
 * `breeze.accessible_partner_ids` GUC. `computeAccessiblePartnerIds`
 * (apps/api/src/middleware/auth.ts) returns `[]` for `scope === 'organization'`,
 * and agentAuth / clientAiAuth / portal auth / org-scoped OAuth bearers all set
 * `accessiblePartnerIds: []` too. Under those contexts the read returns ZERO
 * ROWS — it does NOT raise — so the caller's value silently collapses to a
 * default, an empty list, or a spurious 404, for exactly the population the
 * feature was meant to serve.
 *
 * WHY THIS FILE HAS TO BE AN INTEGRATION TEST. A mocked-DB unit test is
 * structurally incapable of catching this: the mock returns whatever row the
 * test stages, with no RLS evaluation at all, so the entire unit suite passes
 * against a control that does nothing. Only a real Postgres connection through
 * the actual unprivileged `breeze_app` role, inside a genuine `withDbAccessContext`
 * org-scoped session, can prove the read is visible. Every test below therefore
 * reproduces the exact ambient context an org-scoped HTTP request runs under
 * (authMiddleware wraps every request in `withDbAccessContext` keyed off the
 * caller's auth) and asserts the fixed resolver still surfaces the partner data.
 *
 * The first test is the PREMISE PROOF: it asserts the raw partner-axis rows
 * really are invisible in that context. Without it, a later change that quietly
 * widened the RLS policy would make every other test here pass vacuously.
 */
import './setup';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  authenticatorPolicies,
  devices,
  organizations,
  partners,
  patchPolicies,
  sites,
} from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { loadPartnerPolicy, isEnforcing } from '../../services/authenticatorPolicy';
import { resolveDeviceTimezone } from '../../services/featureConfigResolver';
import { getEffectiveOrgSettings, assertNotLocked } from '../../services/effectiveSettings';
import { resolveMlFeatureFlagForOrg } from '../../services/mlFeatureFlags';
import { resolvePatchPolicyReference } from '../../services/configPolicyPatching';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * The context a real org-scoped JWT request runs under.
 *
 * Built with the PRODUCTION builder rather than a hand-rolled literal, on
 * purpose: `buildDbAccessContext` is what `authMiddleware` calls, so if
 * `computeAccessiblePartnerIds` ever changes for org scope this fixture changes
 * with it. A literal would keep asserting `accessiblePartnerIds: []` forever and
 * every test below would go on passing against a context production no longer
 * produces — the same hand-rolled-context drift this PR fixes in
 * `aiAgentSdkTools.ts`.
 *
 * Note it yields `accessiblePartnerIds: []` even though `currentPartnerId` IS
 * populated: `partners` has no `breeze_current_partner_id()` read branch
 * (apps/api/migrations/2026-04-11-partners-rls.sql), so that GUC buys nothing on
 * this axis — which is precisely the trap.
 */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return buildDbAccessContext({
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    partnerId,
    userId: null,
  });
}

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  ringId: string;
}

let fx: Fixture;

beforeEach(async () => {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  fx = await withSystemDbAccessContext(async () => {
    const [partner] = await db
      .insert(partners)
      .values({
        name: `PAX Partner ${unique}`,
        slug: `pax-partner-${unique}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
        // First-class partner timezone (#1318) — the value resolveDeviceTimezone
        // must surface. Deliberately NOT 'UTC' so the fallback is distinguishable
        // from a real hit.
        timezone: 'America/Chicago',
        settings: {
          security: { sessionTimeoutMinutes: 15 },
          mlFeatureFlags: { 'ml.rca.enabled': true },
        },
      })
      .returning({ id: partners.id });

    const [org] = await db
      .insert(organizations)
      .values({
        partnerId: partner!.id,
        name: `PAX Org ${unique}`,
        slug: `pax-org-${unique}`,
        type: 'customer',
        status: 'active',
        settings: {},
      })
      .returning({ id: organizations.id });

    const [site] = await db
      .insert(sites)
      .values({ orgId: org!.id, name: `PAX Site ${unique}`, timezone: '' })
      .returning({ id: sites.id });

    const [device] = await db
      .insert(devices)
      .values({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `pax-agent-${unique}`,
        hostname: `pax-host-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
      })
      .returning({ id: devices.id });

    await db.insert(authenticatorPolicies).values({
      partnerId: partner!.id,
      requireEnrollment: true,
      // Already in force — no grace window — so `isEnforcing` hinges purely on
      // whether the row was readable.
      enforceFrom: new Date(Date.now() - 86_400_000),
      floorOverrides: {},
    });

    const [ring] = await db
      .insert(patchPolicies)
      .values({ partnerId: partner!.id, kind: 'ring', name: `PAX Ring ${unique}` })
      .returning({ id: patchPolicies.id });

    return {
      partnerId: partner!.id,
      orgId: org!.id,
      siteId: site!.id,
      deviceId: device!.id,
      ringId: ring!.id,
    };
  });
});

afterEach(async () => {
  if (!fx) return;
  await withSystemDbAccessContext(async () => {
    await db.delete(devices).where(eq(devices.id, fx.deviceId));
    await db.delete(sites).where(eq(sites.id, fx.siteId));
    await db.delete(patchPolicies).where(eq(patchPolicies.id, fx.ringId));
    await db.delete(authenticatorPolicies).where(eq(authenticatorPolicies.partnerId, fx.partnerId));
    await db.delete(organizations).where(eq(organizations.id, fx.orgId));
    await db.delete(partners).where(eq(partners.id, fx.partnerId));
  });
  fx = undefined as unknown as Fixture;
});

describe('#2822 premise — partner-axis rows really are invisible to an org-scoped context', () => {
  runDb('raw SELECTs on partners / authenticator_policies / patch_policies return ZERO rows, without raising', async () => {
    await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), async () => {
      // Sanity: the org row itself IS visible, so a zero result below is RLS on
      // the partner axis and not a broken fixture or a dead connection.
      const orgRows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, fx.orgId));
      expect(orgRows).toHaveLength(1);

      expect(
        await db.select({ id: partners.id }).from(partners).where(eq(partners.id, fx.partnerId)),
      ).toHaveLength(0);

      expect(
        await db
          .select({ partnerId: authenticatorPolicies.partnerId })
          .from(authenticatorPolicies)
          .where(eq(authenticatorPolicies.partnerId, fx.partnerId)),
      ).toHaveLength(0);

      expect(
        await db
          .select({ id: patchPolicies.id })
          .from(patchPolicies)
          .where(eq(patchPolicies.id, fx.ringId)),
      ).toHaveLength(0);
    });
  });
});

describe('#2822 — loadPartnerPolicy (step-up MFA fail-open, highest severity)', () => {
  runDb('an org-scoped caller resolves the partner policy, so step-up enforcement is NOT silently skipped', async () => {
    const policy = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
      loadPartnerPolicy(fx.partnerId),
    );

    // Pre-fix this was null, `isEnforcing(null, …)` was false, and an org-scoped
    // technician could approve a critical JIT-admin elevation with a bare L1
    // session tap while a partner-scoped technician on the same row got 403.
    expect(policy).not.toBeNull();
    expect(policy!.requireEnrollment).toBe(true);
    expect(isEnforcing(policy, new Date())).toBe(true);
  });

  runDb('still resolves under a system context (the skip-the-escape branch is not a regression)', async () => {
    const policy = await withDbAccessContext(SYSTEM_CTX, () => loadPartnerPolicy(fx.partnerId));
    expect(policy?.requireEnrollment).toBe(true);
  });

  runDb('and with no ambient context at all (background/worker callers)', async () => {
    const policy = await loadPartnerPolicy(fx.partnerId);
    expect(policy?.requireEnrollment).toBe(true);
  });
});

describe('#2822 — resolveDeviceTimezone', () => {
  runDb("an org-scoped caller resolves the PARTNER's timezone instead of falling through to UTC", async () => {
    const tz = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
      resolveDeviceTimezone(fx.deviceId),
    );
    // Site tz is '' and the org sets none, so the partner is the only non-UTC
    // candidate in the explicit -> site -> org -> partner -> UTC chain. Pre-fix
    // this returned 'UTC', meaning the same device resolved a DIFFERENT
    // maintenance window depending on whether the scheduler (system) or an
    // org-scoped UI action triggered the job.
    expect(tz).toBe('America/Chicago');
  });

  runDb('resolves identically under a system context — org and scheduler now agree', async () => {
    const tz = await withDbAccessContext(SYSTEM_CTX, () => resolveDeviceTimezone(fx.deviceId));
    expect(tz).toBe('America/Chicago');
  });
});

describe('#2822 — getEffectiveOrgSettings', () => {
  runDb('an org-scoped caller gets partner-inherited settings instead of a spurious 404', async () => {
    const result = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
      getEffectiveOrgSettings(fx.orgId),
    );
    // Pre-fix this threw HTTPException 404 "Partner not found" for an org admin
    // looking at their OWN org — GET /orgs/organizations/:id/effective-settings
    // is requireScope('organization','partner','system').
    expect(result.effective.security).toMatchObject({ sessionTimeoutMinutes: 15 });
    // The partner set it, so the field must come back LOCKED.
    expect(result.locked).toContain('security.sessionTimeoutMinutes');
  });
});

describe('#2822 — assertNotLocked (a WRITE gate, so a wrong answer is worse than a read)', () => {
  runDb('an org-scoped caller is still blocked from writing a partner-LOCKED field', async () => {
    // Reached from PUT /ai/budget, which is
    // requireScope('organization','partner','system'). Pre-fix the partner read
    // returned zero rows and this threw 404 "Partner not found" before it could
    // decide anything — so the gate never actually ran for org callers. Now it
    // resolves and correctly refuses: the partner set security.sessionTimeoutMinutes
    // to 15, and the org submits a DIVERGING value (#2752 made assertNotLocked
    // value-aware — echoing the partner's own value back is a permitted no-op,
    // so the block only fires on an actual change).
    await expect(
      withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        assertNotLocked(fx.orgId, 'security', { sessionTimeoutMinutes: 60 }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  runDb('an org-scoped caller may still write a field the partner has NOT set', async () => {
    await expect(
      withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        assertNotLocked(fx.orgId, 'security', { someUnlockedField: 'org-value' }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('#2822 — resolveMlFeatureFlagForOrg', () => {
  runDb('an org-scoped caller sees the partner-enabled ML flag, not a false org_not_found', async () => {
    const resolution = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
      resolveMlFeatureFlagForOrg(fx.orgId, 'ml.rca.enabled'),
    );
    // Pre-fix the innerJoin on the invisible `partners` row erased the whole
    // result row and this returned { enabled: false, source: 'org_not_found' } —
    // a statement that was false on both counts.
    expect(resolution.source).not.toBe('org_not_found');
    expect(resolution.enabled).toBe(true);
  });
});

describe('#2822 — resolvePatchPolicyReference', () => {
  runDb('an org-scoped caller resolves a valid update ring instead of missing_target', async () => {
    const resolution = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
      resolvePatchPolicyReference(fx.partnerId, fx.ringId),
    );
    // Pre-fix: classification 'missing_target', valid false — so the UI reported
    // a perfectly good ring as invalid (400 on POST /:id/patch-job) while the
    // system-scoped scheduler happily ran that same job.
    expect(resolution.classification).toBe('valid_ring');
    expect(resolution.valid).toBe(true);
    expect(resolution.ringId).toBe(fx.ringId);
  });

  runDb('a ring belonging to ANOTHER partner is still rejected — the escape did not widen reach', async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const other = await withSystemDbAccessContext(async () => {
      const [p] = await db
        .insert(partners)
        .values({
          name: `PAX Other ${unique}`,
          slug: `pax-other-${unique}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      const [r] = await db
        .insert(patchPolicies)
        .values({ partnerId: p!.id, kind: 'ring', name: `PAX Other Ring ${unique}` })
        .returning({ id: patchPolicies.id });
      return { partnerId: p!.id, ringId: r!.id };
    });

    try {
      // The caller's own partnerId, but a ring id owned by someone else. The
      // system-context escape must NOT make this resolve: the query is still
      // self-tenanted by the caller-derived partnerId.
      const resolution = await withDbAccessContext(orgContext(fx.orgId, fx.partnerId), () =>
        resolvePatchPolicyReference(fx.partnerId, other.ringId),
      );
      expect(resolution.classification).toBe('missing_target');
      expect(resolution.valid).toBe(false);
    } finally {
      await withSystemDbAccessContext(async () => {
        await db.delete(patchPolicies).where(eq(patchPolicies.id, other.ringId));
        await db.delete(partners).where(eq(partners.id, other.partnerId));
      });
    }
  });
});
