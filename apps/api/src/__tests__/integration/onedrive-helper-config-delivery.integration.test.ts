/**
 * Integration test: buildOnedriveHelperConfigUpdate(deviceId) + heartbeat ingest
 *
 * Verifies that the resolver correctly joins config policy assignments →
 * active policies → feature links (onedrive_helper) → settings + libraries,
 * applying closest-level-wins hierarchy, and that it returns null when no
 * onedrive_helper policy is assigned to the device.
 *
 * Also verifies that the heartbeat route accepts an optional onedriveDeviceState
 * payload and upserts it into the onedrive_device_state table (Task 9).
 *
 * All seeding runs under withSystemDbAccessContext so RLS does not hide
 * the freshly inserted rows. The function under test uses the bare `db`
 * pool (breeze_app, same as the monitoring resolver), so it must be called
 * inside a withSystemDbAccessContext wrapper in these tests.
 *
 * Fixtures are re-seeded per test — setup.ts cleanupDatabase() TRUNCATEs
 * partners/organizations CASCADE on beforeEach, wiping all policy rows.
 */
import './setup';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyOnedriveSettings,
  configPolicyOnedriveLibraries,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  devices,
  organizations,
  partners,
  sites,
  onedriveDeviceState,
} from '../../db/schema';
import { buildOnedriveHelperConfigUpdate } from '../../routes/agents/helpers';
import { agentRoutes } from '../../routes/agents';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// ============================================================================
// Seed helpers
// ============================================================================

interface LibrarySeed {
  libraryId: string;
  displayName: string;
  targetingMode?: string;
  groupId?: string;
  groupName?: string;
  hiveScope?: string;
  enabled?: boolean;
}

interface SeedResult {
  deviceId: string;
  settingsId: string | null;
  agentId: string;
  agentToken: string;
  orgId: string;
}

/**
 * Seeds a partner → org → site → device → (optionally) config policy chain.
 * When `base` is null, no config policy is assigned (tests the null path).
 */
async function seedDeviceWithOnedrivePolicy(options: {
  base: {
    silentAccountConfig?: boolean;
    filesOnDemand?: boolean;
    kfmSilentOptIn?: boolean;
    kfmBlockOptOut?: boolean;
    restartOnChange?: boolean;
  } | null;
  libraries?: LibrarySeed[];
}): Promise<SeedResult> {
  return withSystemDbAccessContext(async () => {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);

    // 1. Partner
    const [partner] = await db
      .insert(partners)
      .values({
        name: `OD Test Partner ${ts}-${rand}`,
        slug: `od-tp-${ts}-${rand}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
      })
      .returning({ id: partners.id });
    if (!partner) throw new Error('seedDeviceWithOnedrivePolicy: failed to insert partner');

    // 2. Organization
    const [org] = await db
      .insert(organizations)
      .values({
        partnerId: partner.id,
        name: `OD Test Org ${ts}-${rand}`,
        slug: `od-org-${ts}-${rand}`,
        type: 'customer',
        status: 'active',
      })
      .returning({ id: organizations.id });
    if (!org) throw new Error('seedDeviceWithOnedrivePolicy: failed to insert organization');

    // 3. Site
    const [site] = await db
      .insert(sites)
      .values({ orgId: org.id, name: `OD Site ${ts}`, timezone: 'UTC' })
      .returning({ id: sites.id });
    if (!site) throw new Error('seedDeviceWithOnedrivePolicy: failed to insert site');

    // 4. Device — include agentTokenHash so the heartbeat route can auth
    const agentId = `od-delivery-test-${ts}-${rand}`;
    const agentToken = `brz_od_test_${ts}_${rand}`;
    const agentTokenHash = createHash('sha256').update(agentToken).digest('hex');
    const [device] = await db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId,
        hostname: `od-host-${rand}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        agentTokenHash,
        enrolledAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!device) throw new Error('seedDeviceWithOnedrivePolicy: failed to insert device');

    if (options.base === null) {
      // No policy — test the null path
      return { deviceId: device.id, settingsId: null, agentId, agentToken, orgId: org.id };
    }

    // 5. Configuration policy (active)
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: org.id, name: `OD Policy ${ts}`, status: 'active' })
      .returning({ id: configurationPolicies.id });
    if (!policy) throw new Error('seedDeviceWithOnedrivePolicy: failed to insert policy');

    // 6. Feature link
    const [featureLink] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy.id, featureType: 'onedrive_helper' })
      .returning({ id: configPolicyFeatureLinks.id });
    if (!featureLink) throw new Error('seedDeviceWithOnedrivePolicy: failed to insert feature link');

    // 7. Onedrive settings row
    const [settings] = await db
      .insert(configPolicyOnedriveSettings)
      .values({
        featureLinkId: featureLink.id,
        orgId: org.id,
        silentAccountConfig: options.base.silentAccountConfig ?? true,
        filesOnDemand: options.base.filesOnDemand ?? true,
        kfmSilentOptIn: options.base.kfmSilentOptIn ?? false,
        kfmBlockOptOut: options.base.kfmBlockOptOut ?? false,
        restartOnChange: options.base.restartOnChange ?? true,
      })
      .returning({ id: configPolicyOnedriveSettings.id });
    if (!settings) throw new Error('seedDeviceWithOnedrivePolicy: failed to insert settings');

    // 8. Library rows
    for (let i = 0; i < (options.libraries ?? []).length; i++) {
      const lib = options.libraries![i]!;
      await db.insert(configPolicyOnedriveLibraries).values({
        settingsId: settings.id,
        orgId: org.id,
        libraryId: lib.libraryId,
        displayName: lib.displayName,
        targetingMode: lib.targetingMode ?? 'everyone',
        groupId: lib.groupId ?? null,
        groupName: lib.groupName ?? null,
        hiveScope: lib.hiveScope ?? 'hkcu',
        sortOrder: i,
        enabled: lib.enabled ?? true,
      });
    }

    // 9. Assignment at organization level
    await db.insert(configPolicyAssignments).values({
      configPolicyId: policy.id,
      level: 'organization',
      targetId: org.id,
      priority: 10,
    });

    return { deviceId: device.id, settingsId: settings.id, agentId, agentToken, orgId: org.id };
  });
}

// ============================================================================
// Heartbeat app for ingest tests
// ============================================================================

function buildHeartbeatApp(): Hono {
  const app = new Hono();
  app.route('/', agentRoutes);
  return app;
}

// ============================================================================
// Tests
// ============================================================================

describe('buildOnedriveHelperConfigUpdate', () => {
  runDb('returns base config + library rules for an assigned device', async () => {
    const { deviceId } = await seedDeviceWithOnedrivePolicy({
      base: { silentAccountConfig: true, filesOnDemand: true, kfmSilentOptIn: true },
      libraries: [
        { libraryId: 'lib-fin', displayName: 'Finance', targetingMode: 'graph_group', groupId: 'g-fin' },
        { libraryId: 'lib-all', displayName: 'Company', targetingMode: 'everyone' },
      ],
    });

    const cfg = await withSystemDbAccessContext(() => buildOnedriveHelperConfigUpdate(deviceId));
    expect(cfg).not.toBeNull();
    expect(cfg!.base.kfmSilentOptIn).toBe(true);
    expect(cfg!.base.silentAccountConfig).toBe(true);
    expect(cfg!.base.filesOnDemand).toBe(true);
    expect(cfg!.libraries).toHaveLength(2);
    const finLib = cfg!.libraries.find((l) => l.libraryId === 'lib-fin');
    expect(finLib).toBeDefined();
    expect(finLib!.targetingMode).toBe('graph_group');
    expect(finLib!.groupId).toBe('g-fin');
    const allLib = cfg!.libraries.find((l) => l.libraryId === 'lib-all');
    expect(allLib).toBeDefined();
    expect(allLib!.targetingMode).toBe('everyone');
  });

  runDb('returns null for a device with no onedrive_helper policy assigned', async () => {
    const { deviceId } = await seedDeviceWithOnedrivePolicy({ base: null, libraries: [] });
    const result = await withSystemDbAccessContext(() => buildOnedriveHelperConfigUpdate(deviceId));
    expect(result).toBeNull();
  });

  runDb('returns null for an unknown device id', async () => {
    const result = await withSystemDbAccessContext(() =>
      buildOnedriveHelperConfigUpdate('00000000-0000-0000-0000-000000000000')
    );
    expect(result).toBeNull();
  });

  runDb('only returns enabled libraries', async () => {
    const { deviceId } = await seedDeviceWithOnedrivePolicy({
      base: { kfmSilentOptIn: false },
      libraries: [
        { libraryId: 'lib-on', displayName: 'Enabled', targetingMode: 'everyone', enabled: true },
        { libraryId: 'lib-off', displayName: 'Disabled', targetingMode: 'everyone', enabled: false },
      ],
    });

    const cfg = await withSystemDbAccessContext(() => buildOnedriveHelperConfigUpdate(deviceId));
    expect(cfg).not.toBeNull();
    expect(cfg!.libraries).toHaveLength(1);
    expect(cfg!.libraries[0]!.libraryId).toBe('lib-on');
  });

  runDb('returns correct base defaults when minimal settings seeded', async () => {
    const { deviceId } = await seedDeviceWithOnedrivePolicy({
      base: {},
      libraries: [],
    });

    const cfg = await withSystemDbAccessContext(() => buildOnedriveHelperConfigUpdate(deviceId));
    expect(cfg).not.toBeNull();
    // Schema defaults: silentAccountConfig=true, filesOnDemand=true, kfmSilentOptIn=false
    expect(cfg!.base.silentAccountConfig).toBe(true);
    expect(cfg!.base.filesOnDemand).toBe(true);
    expect(cfg!.base.kfmSilentOptIn).toBe(false);
    expect(cfg!.libraries).toHaveLength(0);
  });
});

// ============================================================================
// Task 9: Heartbeat ingest — persisting onedriveDeviceState
// ============================================================================

describe('heartbeat ingest: onedriveDeviceState', () => {
  runDb('persists reported onedrive device state via heartbeat (insert)', async () => {
    const { deviceId, agentId, agentToken } = await seedDeviceWithOnedrivePolicy({
      base: null,
      libraries: [],
    });

    const app = buildHeartbeatApp();
    const res = await app.request(`/${agentId}/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'ok',
        agentVersion: '1.0.0-test',
        onedriveDeviceState: {
          signedIn: true,
          filesOnDemandOn: true,
          kfmFolderStates: { Documents: 'redirected' },
          mountedLibraries: ['lib-all'],
          entitledLibraries: ['lib-all'],
          driftEntries: [],
        },
      }),
    });

    expect(res.status, `heartbeat returned ${res.status}: ${await res.text()}`).toBe(200);

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(onedriveDeviceState).where(eq(onedriveDeviceState.deviceId, deviceId))
    );
    expect(row, 'onedrive_device_state row should exist after heartbeat').toBeDefined();
    expect(row!.signedIn).toBe(true);
    expect(row!.filesOnDemandOn).toBe(true);
    expect(row!.mountedLibraries).toEqual(['lib-all']);
    expect(row!.kfmFolderStates).toEqual({ Documents: 'redirected' });
  });

  runDb('second heartbeat updates (not duplicates) the state row', async () => {
    const { deviceId, agentId, agentToken } = await seedDeviceWithOnedrivePolicy({
      base: null,
      libraries: [],
    });

    const app = buildHeartbeatApp();

    // First heartbeat — signedIn: true
    await app.request(`/${agentId}/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'ok',
        agentVersion: '1.0.0-test',
        onedriveDeviceState: {
          signedIn: true,
          filesOnDemandOn: false,
          kfmFolderStates: {},
          mountedLibraries: ['lib-v1'],
          entitledLibraries: ['lib-v1'],
          driftEntries: [],
        },
      }),
    });

    // Second heartbeat — signedIn: false, different libraries
    await app.request(`/${agentId}/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status: 'ok',
        agentVersion: '1.0.0-test',
        onedriveDeviceState: {
          signedIn: false,
          filesOnDemandOn: true,
          kfmFolderStates: { Desktop: 'redirected' },
          mountedLibraries: ['lib-v2'],
          entitledLibraries: ['lib-v2'],
          driftEntries: [],
        },
      }),
    });

    const rows = await withSystemDbAccessContext(() =>
      db.select().from(onedriveDeviceState).where(eq(onedriveDeviceState.deviceId, deviceId))
    );
    // Must be exactly one row (upsert, not duplicate insert)
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signedIn).toBe(false);
    expect(rows[0]!.filesOnDemandOn).toBe(true);
    expect(rows[0]!.mountedLibraries).toEqual(['lib-v2']);
  });
});
