/**
 * Integration test — helper policy resolution against real Postgres.
 *
 * Two pre-existing bugs in routes/agents/helpers.ts:
 *
 *  Bug 1 (dual-axis): resolveDeviceHelperSettings joined on
 *  `configurationPolicies.orgId = device.orgId`, so a partner-owned helper
 *  policy (org_id NULL, partner_id set — the "partner-wide" ownership shape,
 *  epic #2135) never matched, even when correctly assigned at the partner
 *  level. Fixed with the same dual-axis WHERE shape as
 *  resolveEffectiveConfigWithExecutor (services/configurationPolicy.ts).
 *
 *  Bug 2 (disabled precedence): buildHelperConfigUpdate treated
 *  `!settings.enabled` as "no policy" and fell through to the legacy
 *  organizations.settings.helper fallback, so an explicit enabled:false
 *  policy was silently overridden. Fixed by giving resolveDeviceHelperSettings
 *  a HelperSettings | null contract — null means "no policy matched" — so the
 *  fallback in buildHelperConfigUpdate can fire ONLY on that, not on a
 *  resolved-but-disabled result. This file proves the resolver-level
 *  precondition (a disabled policy resolves non-null); the fallback branch
 *  itself is a small, directly-readable change in buildHelperConfigUpdate.
 *
 * resolveDeviceHelperSettings is exercised under withSystemDbAccessContext,
 * mirroring the production call site: routes/agents/heartbeat.ts resolves
 * helper settings OUTSIDE the request's org-scoped RLS context (see its
 * #1105 comment) precisely because a partner-wide policy row is invisible
 * under that context (accessiblePartnerIds: [] there) — RLS would hide it
 * regardless of this resolver's own WHERE clause.
 *
 * setup.ts's global beforeEach TRUNCATEs core tenant tables (partners,
 * organizations, devices — which cascade through the config-policy FKs)
 * before EVERY test in this run, so each `it()` below seeds its own fresh
 * partner/org/site/device rather than sharing beforeAll fixtures across
 * tests (same "why no memoization" reasoning as
 * remote-access-settings-rls.integration.test.ts).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import {
  devices,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { resolveDeviceHelperSettings } from '../../routes/agents/helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface BaseFixture {
  partnerId: string;
  orgId: string;
  deviceId: string;
}

// Seeds a fresh partner -> org -> site -> device chain. partners/organizations
// use db-utils (superuser test pool, bypasses RLS for convenience seeding);
// the device insert goes through the real app pool (`db` from '../../db')
// under a system context, matching how config-policy fixtures are seeded
// below and in the sibling RLS integration tests.
async function seedBase(): Promise<BaseFixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  return withSystemDbAccessContext(async () => {
    const agentId = `hpr-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId,
        hostname: `hpr-${agentId}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        enrolledAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('seedBase: device insert failed');
    return { partnerId: partner.id, orgId: org.id, deviceId: device.id };
  });
}

describe('helper policy resolution (dual-axis + disabled precedence)', () => {
  runDb('resolves a PARTNER-OWNED helper policy assigned at partner level (bug 1)', async () => {
    const { partnerId, deviceId } = await seedBase();

    await withSystemDbAccessContext(async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({
          name: `partner-wide-helper-${Date.now()}`,
          status: 'active',
          orgId: null,
          partnerId,
        })
        .returning({ id: configurationPolicies.id });
      if (!policy) throw new Error('policy insert failed');

      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy.id,
        featureType: 'helper',
        inlineSettings: {
          enabled: true,
          showOpenPortal: false,
          showDeviceInfo: true,
          showRequestSupport: true,
        },
      });

      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy.id,
        level: 'partner',
        targetId: partnerId,
      });
    });

    const settings = await withSystemDbAccessContext(() =>
      resolveDeviceHelperSettings(deviceId)
    );

    expect(settings).not.toBeNull();
    expect(settings!.enabled).toBe(true);
    // A resolved field surviving (false), not the HELPER_DEFAULTS true,
    // proves the policy's OWN row was matched — not a defaults fallback.
    expect(settings!.showOpenPortal).toBe(false);
  });

  runDb('an explicitly DISABLED policy resolves as disabled, not null (bug 2 precondition)', async () => {
    const { orgId, deviceId } = await seedBase();

    await withSystemDbAccessContext(async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({
          name: `org-disabled-helper-${Date.now()}`,
          status: 'active',
          orgId,
          partnerId: null,
        })
        .returning({ id: configurationPolicies.id });
      if (!policy) throw new Error('policy insert failed');

      await db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy.id,
        featureType: 'helper',
        inlineSettings: {
          enabled: false,
          showOpenPortal: true,
          showDeviceInfo: true,
          showRequestSupport: true,
        },
      });

      await db.insert(configPolicyAssignments).values({
        configPolicyId: policy.id,
        level: 'organization',
        targetId: orgId,
      });
    });

    const settings = await withSystemDbAccessContext(() =>
      resolveDeviceHelperSettings(deviceId)
    );

    expect(settings).not.toBeNull();
    expect(settings!.enabled).toBe(false);
  });

  runDb('returns null when no helper feature link exists at all', async () => {
    const { deviceId } = await seedBase();

    const settings = await withSystemDbAccessContext(() =>
      resolveDeviceHelperSettings(deviceId)
    );

    expect(settings).toBeNull();
  });
});
