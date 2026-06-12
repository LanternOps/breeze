/**
 * Grace-period prune of stale patch tombstones (#1004).
 *
 * The scan ingest marks every existing device_patches row `status='missing'` at
 * the start of a scan, then re-upserts the rows the scan reported. Rows left at
 * 'missing' are tombstones; before this fix they accumulated unbounded (a Linux
 * package upgraded to a new externalId orphans the old row forever).
 *
 * pruneStaleTombstones bounds that growth by deleting 'missing' rows whose
 * `updatedAt` (the last scan that actually reported the patch — the bulk
 * mark-missing leaves updatedAt untouched) is older than a grace window. These
 * tests exercise the real SQL against a real DB (a Drizzle mock would never run
 * the make_interval filter), covering Todd's required cases: recent rows survive
 * (empty/zero-item payloads, same-bucket partial-provider failures self-heal),
 * non-'missing' rows are never touched, idempotency, and device/org isolation.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 * Run:
 *   pnpm test:integration -- src/routes/agents/patchTombstonePrune.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { devices, patches, devicePatches } from '../../db/schema';
import type { Database } from '../../db';
import { pruneStaleTombstones } from '../../routes/agents/patches';

const WINDOW_HOURS = 24;
const OLD = new Date(Date.now() - 200 * 60 * 60 * 1000); // 200h ago (past the window)
const RECENT = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago (inside the window)

let agentSeq = 0;
async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  agentSeq++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-tombstone-${agentSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'linux',
      osVersion: '22.04',
      osBuild: 'jammy',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row');
  return row.id;
}

let patchSeq = 0;
async function seedDevicePatch(opts: {
  orgId: string;
  deviceId: string;
  status: 'pending' | 'installed' | 'missing';
  source?: 'linux' | 'third_party';
  updatedAt: Date;
}): Promise<string> {
  patchSeq++;
  const source = opts.source ?? 'linux';
  // patches is a global catalog (not truncated per-test) → externalId must be unique.
  const [patch] = await getTestDb()
    .insert(patches)
    .values({ source, externalId: `${source}:${randomUUID()}`, title: `tp-${patchSeq}`, severity: 'unknown' })
    .returning({ id: patches.id });
  if (!patch) throw new Error('seedDevicePatch: no patch');
  const [dp] = await getTestDb()
    .insert(devicePatches)
    .values({
      deviceId: opts.deviceId,
      orgId: opts.orgId,
      patchId: patch.id,
      status: opts.status,
      lastCheckedAt: new Date(),
      updatedAt: opts.updatedAt,
    })
    .returning({ id: devicePatches.id });
  if (!dp) throw new Error('seedDevicePatch: no device_patch');
  return dp.id;
}

async function exists(devicePatchId: string): Promise<boolean> {
  const rows = await getTestDb()
    .select({ id: devicePatches.id })
    .from(devicePatches)
    .where(eq(devicePatches.id, devicePatchId));
  return rows.length > 0;
}

function prune(deviceId: string, orgId: string): Promise<void> {
  return pruneStaleTombstones(getTestDb() as unknown as Database, deviceId, orgId, WINDOW_HOURS);
}

describe('pruneStaleTombstones (#1004 grace-period prune)', () => {
  let orgId: string;
  let siteId: string;

  beforeEach(async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    orgId = env.organization.id;
    siteId = env.site.id;
  });

  it('deletes a stale "missing" tombstone older than the window', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'stale-host');
    const stale = await seedDevicePatch({ orgId, deviceId, status: 'missing', updatedAt: OLD });

    await prune(deviceId, orgId);

    expect(await exists(stale)).toBe(false);
  });

  it('keeps a "missing" row still inside the window (empty/zero-item scan + same-bucket self-heal)', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'recent-host');
    // A row that went missing this cycle but was reported recently — e.g. winget
    // failed while chocolatey succeeded under the shared third_party bucket.
    const recent = await seedDevicePatch({ orgId, deviceId, status: 'missing', source: 'third_party', updatedAt: RECENT });

    await prune(deviceId, orgId);

    expect(await exists(recent)).toBe(true);
  });

  it('never touches pending or installed rows, however old', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'live-host');
    const pending = await seedDevicePatch({ orgId, deviceId, status: 'pending', updatedAt: OLD });
    const installed = await seedDevicePatch({ orgId, deviceId, status: 'installed', updatedAt: OLD });

    await prune(deviceId, orgId);

    expect(await exists(pending)).toBe(true);
    expect(await exists(installed)).toBe(true);
  });

  it('is idempotent — a second prune is a clean no-op', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'idempotent-host');
    const stale = await seedDevicePatch({ orgId, deviceId, status: 'missing', updatedAt: OLD });
    const recent = await seedDevicePatch({ orgId, deviceId, status: 'missing', updatedAt: RECENT });

    await prune(deviceId, orgId);
    await prune(deviceId, orgId); // must not throw, must not affect the survivor

    expect(await exists(stale)).toBe(false);
    expect(await exists(recent)).toBe(true);
  });

  it('only prunes the target device — a stale tombstone on another device is untouched', async () => {
    const target = await seedDevice(orgId, siteId, 'target-host');
    const other = await seedDevice(orgId, siteId, 'other-host');
    const targetStale = await seedDevicePatch({ orgId, deviceId: target, status: 'missing', updatedAt: OLD });
    const otherStale = await seedDevicePatch({ orgId, deviceId: other, status: 'missing', updatedAt: OLD });

    await prune(target, orgId);

    expect(await exists(targetStale)).toBe(false); // target pruned
    expect(await exists(otherStale)).toBe(true); // other device untouched
  });

  it('does not prune when the orgId does not match the rows (cross-tenant guard)', async () => {
    const deviceId = await seedDevice(orgId, siteId, 'org-guard-host');
    const stale = await seedDevicePatch({ orgId, deviceId, status: 'missing', updatedAt: OLD });

    // Same device id but a different org id → the org-scoped WHERE must spare it.
    await prune(deviceId, randomUUID());

    expect(await exists(stale)).toBe(true);
  });
});
