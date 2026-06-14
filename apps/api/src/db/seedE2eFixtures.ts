// E2E / integration test fixtures for fresh-DB runs (issue #518).
//
// Populates deterministic synthetic data (devices, device groups, alerts,
// audit events, software inventory, patches, backups) on a clean database so
// the e2e YAML suite under `e2e-tests/tests/` and integration tests have rows
// to assert against without depending on a live agent or MFA-gated create
// endpoints.
//
// This is the app-layer replacement for the old `e2e-tests/seed-fixtures.sql`
// docker-exec approach: it runs through Drizzle inside
// `withSystemDbAccessContext`, so it works anywhere the API can reach the DB
// (local, CI, integration runner) — not just where a `breeze-postgres`
// container happens to be named. The earlier SQL-pipe attempt (PR #526) was
// closed precisely because it only worked against a local docker container.
//
// Safety: synthetic fixtures must never land in a real deployment, so seeding
// refuses to run when NODE_ENV === 'production' unless the caller explicitly
// opts in via `force: true` / `BREEZE_SEED_E2E_FORCE=true`.
//
// Idempotent: every insert resolves an existing row by a stable natural key
// first, or uses ON CONFLICT, so re-running is a no-op.

import '../config/normalizeNodeEnv';
import { db, withSystemDbAccessContext } from './index';
import {
  organizations,
  sites,
  users,
  devices,
  deviceGroups,
  deviceSoftware,
  alerts,
  auditLogs,
  patches,
  devicePatches,
  backupConfigs,
  backupJobs,
} from './schema';
import { and, eq } from 'drizzle-orm';

// Stable device IDs so e2e `.env` vars (E2E_MACOS_DEVICE_ID /
// E2E_WINDOWS_DEVICE_ID) and the YAML suite resolve the same rows every run.
// These match the UUIDs the legacy seed-fixtures.sql already used.
export const E2E_MACOS_DEVICE_ID = '42fc7de0-48f5-48f2-846b-6dd95924baf9';
export const E2E_WINDOWS_DEVICE_ID = 'e65460f3-413c-4599-a9a6-90ee71bbc4ff';

// The admin identity created by seedDefaultAdmin(); used as the actor on the
// seeded audit event when present.
const BOOTSTRAP_ADMIN_EMAIL = 'admin@breeze.local';

export interface SeedE2eFixturesOptions {
  /** Bypass the production guard. Only for deliberate non-prod-on-prod-like setups. */
  force?: boolean;
  /** Swallow per-section console output (used by tests). */
  quiet?: boolean;
  /** Override env source (testability). */
  env?: Record<string, string | undefined>;
}

export interface SeedE2eFixturesResult {
  seeded: boolean;
  reason?: string;
  orgId?: string;
  macosDeviceId?: string;
  windowsDeviceId?: string;
}

/**
 * Decide whether e2e fixture seeding is allowed in the current environment.
 *
 * Pure + side-effect-free so it can be unit-tested without a database.
 */
export function resolveSeedE2eGuard(
  env: Record<string, string | undefined> = process.env,
  force = false,
): { allowed: boolean; reason?: string } {
  const isProduction = env.NODE_ENV === 'production';
  const forced = force || env.BREEZE_SEED_E2E_FORCE === 'true';

  if (isProduction && !forced) {
    return {
      allowed: false,
      reason:
        'Refusing to seed synthetic e2e fixtures in production. Set BREEZE_SEED_E2E_FORCE=true to override.',
    };
  }
  return { allowed: true };
}

/**
 * Seed deterministic e2e/integration fixtures. Idempotent; safe to re-run.
 *
 * Returns { seeded: false, reason } when skipped (no baseline tenant yet, or
 * blocked by the production guard) rather than throwing, so callers wiring
 * this into a startup/migration flow can treat a skip as benign.
 */
export async function seedE2eFixtures(
  options: SeedE2eFixturesOptions = {},
): Promise<SeedE2eFixturesResult> {
  const env = options.env ?? process.env;
  const log = options.quiet ? () => {} : (...args: unknown[]) => console.log(...args);

  const guard = resolveSeedE2eGuard(env, options.force ?? false);
  if (!guard.allowed) {
    log(`[seed:e2e] ${guard.reason}`);
    return { seeded: false, reason: guard.reason };
  }

  return withSystemDbAccessContext(async () => {
    log('[seed:e2e] Seeding e2e fixtures...');

    // Baseline tenant must already exist (seedDefaultAdmin runs first).
    const [org] = await db.select().from(organizations).limit(1);
    if (!org) {
      const reason = 'No organization found — run db:seed (seedDefaultAdmin) first.';
      log(`[seed:e2e] ${reason}`);
      return { seeded: false, reason };
    }
    const orgId = org.id;

    const [site] = await db
      .select()
      .from(sites)
      .where(eq(sites.orgId, orgId))
      .limit(1);
    if (!site) {
      const reason = 'No site found for the baseline org — run db:seed first.';
      log(`[seed:e2e] ${reason}`);
      return { seeded: false, reason };
    }
    const siteId = site.id;

    const [adminUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, BOOTSTRAP_ADMIN_EMAIL))
      .limit(1);

    // ── Devices ───────────────────────────────────────────────────────────
    await db
      .insert(devices)
      .values([
        {
          id: E2E_MACOS_DEVICE_ID,
          orgId,
          siteId,
          agentId: 'e2e-macos-agent',
          hostname: 'e2e-macos.local',
          displayName: 'E2E macOS Test Device',
          osType: 'macos',
          osVersion: '14.5',
          architecture: 'arm64',
          agentVersion: '0.63.0',
          status: 'online',
          lastSeenAt: new Date(),
        },
        {
          id: E2E_WINDOWS_DEVICE_ID,
          orgId,
          siteId,
          agentId: 'e2e-windows-agent',
          hostname: 'e2e-windows.local',
          displayName: 'E2E Windows Test Device',
          osType: 'windows',
          osVersion: '11.0.22631',
          architecture: 'amd64',
          agentVersion: '0.63.0',
          status: 'online',
          lastSeenAt: new Date(),
        },
      ])
      .onConflictDoUpdate({
        target: devices.id,
        set: { status: 'online', lastSeenAt: new Date(), updatedAt: new Date() },
      });

    // ── Device group ──────────────────────────────────────────────────────
    await upsertByLookup(
      () =>
        db
          .select({ id: deviceGroups.id })
          .from(deviceGroups)
          .where(and(eq(deviceGroups.orgId, orgId), eq(deviceGroups.name, 'E2E All Test Devices')))
          .limit(1),
      () =>
        db.insert(deviceGroups).values({
          orgId,
          siteId,
          name: 'E2E All Test Devices',
          type: 'static',
        }),
    );

    // ── Alerts ────────────────────────────────────────────────────────────
    await upsertByLookup(
      () =>
        db
          .select({ id: alerts.id })
          .from(alerts)
          .where(and(eq(alerts.deviceId, E2E_MACOS_DEVICE_ID), eq(alerts.title, 'E2E fixture: high CPU')))
          .limit(1),
      () =>
        db.insert(alerts).values({
          orgId,
          deviceId: E2E_MACOS_DEVICE_ID,
          severity: 'medium',
          status: 'active',
          title: 'E2E fixture: high CPU',
          message: 'Synthetic alert for e2e suite.',
        }),
    );
    await upsertByLookup(
      () =>
        db
          .select({ id: alerts.id })
          .from(alerts)
          .where(and(eq(alerts.deviceId, E2E_WINDOWS_DEVICE_ID), eq(alerts.title, 'E2E fixture: disk full')))
          .limit(1),
      () =>
        db.insert(alerts).values({
          orgId,
          deviceId: E2E_WINDOWS_DEVICE_ID,
          severity: 'critical',
          status: 'active',
          title: 'E2E fixture: disk full',
          message: 'Synthetic alert for e2e suite.',
        }),
    );

    // ── Audit event ───────────────────────────────────────────────────────
    if (adminUser) {
      await upsertByLookup(
        () =>
          db
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'e2e.fixture.seeded')))
            .limit(1),
        () =>
          db.insert(auditLogs).values({
            orgId,
            actorType: 'user',
            actorId: adminUser.id,
            action: 'e2e.fixture.seeded',
            resourceType: 'system',
            resourceId: orgId,
            result: 'success',
            ipAddress: '127.0.0.1',
          }),
      );
    }

    // ── Device software inventory ─────────────────────────────────────────
    await seedSoftware(E2E_MACOS_DEVICE_ID, [
      ['Google Chrome', '120.0.6099', 'Google LLC'],
      ['Slack', '4.36.140', 'Slack Technologies'],
      ['Visual Studio Code', '1.85.0', 'Microsoft Corporation'],
    ]);
    await seedSoftware(E2E_WINDOWS_DEVICE_ID, [
      ['Microsoft Edge', '120.0.2210', 'Microsoft Corporation'],
      ['7-Zip 19.00 (x64)', '19.00', 'Igor Pavlov'],
      ['Notepad++ (64-bit)', '8.6.0', 'Notepad++ Team'],
    ]);

    // ── Patches + device_patches links ────────────────────────────────────
    const patchCritical = await upsertPatch({
      source: 'microsoft',
      externalId: 'E2E-KB5000001',
      title: 'Cumulative Update for Windows 11 (E2E synthetic)',
      severity: 'critical',
      osTypes: ['windows'],
      kbArticleUrl: 'https://support.microsoft.com/en-us/help/E2E-KB5000001',
      requiresReboot: true,
    });
    const patchImportant = await upsertPatch({
      source: 'microsoft',
      externalId: 'E2E-KB5000002',
      title: 'Microsoft Defender Definition Update (E2E)',
      severity: 'important',
      osTypes: ['windows'],
      requiresReboot: false,
    });
    const patchModerate = await upsertPatch({
      source: 'apple',
      externalId: 'E2E-MAC-001',
      title: 'Safari 17.2 Security Update (E2E)',
      severity: 'moderate',
      osTypes: ['macos'],
      requiresReboot: false,
    });

    await linkDevicePatch(orgId, E2E_WINDOWS_DEVICE_ID, patchCritical, 'pending');
    await linkDevicePatch(orgId, E2E_WINDOWS_DEVICE_ID, patchImportant, 'installed', true);
    await linkDevicePatch(orgId, E2E_MACOS_DEVICE_ID, patchModerate, 'pending');

    // ── Backup config + jobs (one success, one failure) ───────────────────
    let backupConfigId: string;
    const [existingConfig] = await db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(and(eq(backupConfigs.orgId, orgId), eq(backupConfigs.name, 'E2E Default Backup')))
      .limit(1);
    if (existingConfig) {
      backupConfigId = existingConfig.id;
    } else {
      const [created] = await db
        .insert(backupConfigs)
        .values({
          orgId,
          name: 'E2E Default Backup',
          type: 'file',
          provider: 'local',
          providerConfig: { path: '/var/breeze/backups' },
        })
        .returning({ id: backupConfigs.id });
      backupConfigId = created!.id;
    }

    await upsertByLookup(
      () =>
        db
          .select({ id: backupJobs.id })
          .from(backupJobs)
          .where(and(eq(backupJobs.deviceId, E2E_MACOS_DEVICE_ID), eq(backupJobs.status, 'completed')))
          .limit(1),
      () =>
        db.insert(backupJobs).values({
          orgId,
          configId: backupConfigId,
          deviceId: E2E_MACOS_DEVICE_ID,
          status: 'completed',
          type: 'scheduled',
          startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          completedAt: new Date(Date.now() - 105 * 60 * 1000),
          totalSize: 1234567890,
          transferredSize: 1234567890,
          fileCount: 4823,
        }),
    );
    await upsertByLookup(
      () =>
        db
          .select({ id: backupJobs.id })
          .from(backupJobs)
          .where(and(eq(backupJobs.deviceId, E2E_WINDOWS_DEVICE_ID), eq(backupJobs.status, 'failed')))
          .limit(1),
      () =>
        db.insert(backupJobs).values({
          orgId,
          configId: backupConfigId,
          deviceId: E2E_WINDOWS_DEVICE_ID,
          status: 'failed',
          type: 'scheduled',
          startedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
          completedAt: new Date(Date.now() - 350 * 60 * 1000),
          errorLog: 'E2E synthetic failure: target unreachable',
        }),
    );

    log(`[seed:e2e] Fixtures seeded for org ${orgId}.`);
    return {
      seeded: true,
      orgId,
      macosDeviceId: E2E_MACOS_DEVICE_ID,
      windowsDeviceId: E2E_WINDOWS_DEVICE_ID,
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Insert only if the lookup returns no existing row. */
async function upsertByLookup(
  lookup: () => Promise<Array<{ id: string }>>,
  insert: () => Promise<unknown>,
): Promise<void> {
  const [existing] = await lookup();
  if (!existing) {
    await insert();
  }
}

async function seedSoftware(
  deviceId: string,
  rows: Array<[name: string, version: string, publisher: string]>,
): Promise<void> {
  for (const [name, version, publisher] of rows) {
    const [existing] = await db
      .select({ id: deviceSoftware.id })
      .from(deviceSoftware)
      .where(and(eq(deviceSoftware.deviceId, deviceId), eq(deviceSoftware.name, name)))
      .limit(1);
    if (!existing) {
      await db.insert(deviceSoftware).values({ deviceId, name, version, publisher, isSystem: false });
    }
  }
}

interface PatchSeed {
  source: 'microsoft' | 'apple' | 'linux' | 'third_party' | 'custom';
  externalId: string;
  title: string;
  severity: 'critical' | 'important' | 'moderate' | 'low' | 'unknown';
  osTypes: string[];
  kbArticleUrl?: string;
  requiresReboot: boolean;
}

async function upsertPatch(p: PatchSeed): Promise<string> {
  const [existing] = await db
    .select({ id: patches.id })
    .from(patches)
    .where(and(eq(patches.source, p.source), eq(patches.externalId, p.externalId)))
    .limit(1);
  if (existing) {
    return existing.id;
  }
  const [created] = await db
    .insert(patches)
    .values({
      source: p.source,
      externalId: p.externalId,
      title: p.title,
      severity: p.severity,
      osTypes: p.osTypes,
      kbArticleUrl: p.kbArticleUrl,
      requiresReboot: p.requiresReboot,
    })
    .returning({ id: patches.id });
  return created!.id;
}

async function linkDevicePatch(
  orgId: string,
  deviceId: string,
  patchId: string,
  status: 'pending' | 'installed' | 'failed' | 'skipped' | 'missing',
  installed = false,
): Promise<void> {
  const [existing] = await db
    .select({ id: devicePatches.id })
    .from(devicePatches)
    .where(and(eq(devicePatches.deviceId, deviceId), eq(devicePatches.patchId, patchId)))
    .limit(1);
  if (existing) {
    return;
  }
  await db.insert(devicePatches).values({
    orgId,
    deviceId,
    patchId,
    status,
    installedAt: installed ? new Date(Date.now() - 24 * 60 * 60 * 1000) : undefined,
    lastCheckedAt: new Date(),
  });
}

// Run if executed directly: `pnpm db:seed:e2e`
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  seedE2eFixtures()
    .then((result) => {
      if (!result.seeded) {
        console.error(`[seed:e2e] Skipped: ${result.reason}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed:e2e] Failed:', err);
      process.exit(1);
    });
}
