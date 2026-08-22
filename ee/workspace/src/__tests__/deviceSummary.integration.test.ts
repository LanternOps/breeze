// Real-SQL cover for the device summary aggregate. The unit suite records what
// the service asks the database for; this one proves the query actually runs
// under the org-scoped (RLS-enforcing) connection and returns the right
// numbers — including the tombstone exclusion, the DISTINCT source count, the
// completed-runs filter, and the cross-org 404.
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { createDeviceSummaryService } from '../services/deviceSummaryService';

const ADMIN_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP
  ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';

if (new URL(ADMIN_URL).port === '5432' || new URL(APP_URL).port === '5432') {
  throw new Error('refusing to run against :5432 — use the test stack (:5433)');
}

const COMPLETED_AT = new Date('2026-07-12T10:00:00.000Z');
const OLDER_COMPLETED_AT = new Date('2026-07-11T10:00:00.000Z');
const LAST_ACTIVITY_AT = new Date('2026-07-12T11:30:00.000Z');
// A terminal-but-failed run that stamped completed_at AFTER the last good crawl.
const FAILED_COMPLETED_AT = new Date('2026-07-12T12:00:00.000Z');
// Newer than every device-scoped timestamp, so SMB rows moving in or out of a
// device's summary are immediately visible in the timestamps.
const SMB_CRAWL_AT = new Date('2026-07-13T09:00:00.000Z');
// Newer still, and owned by a DIFFERENT device: if the owned-sources subquery
// ever loses its crawl_device_id anchor, this timestamp surfaces on deviceA.
const FOREIGN_SMB_CRAWL_AT = new Date('2026-07-14T09:00:00.000Z');
const SHARED_DEVICE_KEY = '00000000-0000-0000-0000-000000000000';

let admin: postgres.Sql;
let app: postgres.Sql;
let appDb: ReturnType<typeof drizzle>;
let partnerId: string;
let orgA: string;
let orgB: string;
let siteA: string;
let siteB: string;
let deviceA: string;
let otherDeviceA: string;
let smbOnlyDeviceA: string;
let deviceB: string;
let sourceOne: string;
let sourceTwo: string;

/** Run fn as breeze_app inside the given org's access context. */
async function asOrg<T>(
  orgId: string,
  fn: (service: ReturnType<typeof createDeviceSummaryService>) => Promise<T>,
): Promise<T> {
  return appDb.transaction(async (transaction) => {
    const tx = (transaction as unknown as { session: { client: postgres.TransactionSql } })
      .session.client;
    await tx`SELECT set_config('breeze.scope', 'organization', true),
                    set_config('breeze.org_id', ${orgId}, true),
                    set_config('breeze.accessible_org_ids', ${orgId}, true),
                    set_config('breeze.accessible_partner_ids', ${partnerId}, true),
                    set_config('breeze.user_id', '', true),
                    set_config('breeze.current_partner_id', '', true)`;
    return fn(createDeviceSummaryService(transaction as unknown as WorkspaceDatabase));
  });
}

/**
 * Stand up an SMB share in orgA crawled by `crawlDeviceId`, with source-scoped
 * index rows and one completed source-scoped run, run `fn`, then remove it.
 * Source-scoped means device_id NULL / device_key = the shared zero uuid, per
 * runScope.ts — the owning device appears only as crawl_device_id.
 *
 * Torn down in a finally so a failing assertion cannot leak rows into the
 * later tests in this sequential suite.
 */
async function withSmbSource(
  crawlDeviceId: string,
  relPaths: string[],
  crawledAt: Date,
  fn: () => Promise<void>,
): Promise<void> {
  const smbSource = randomUUID();
  await admin`INSERT INTO workspace_sources
                (id, org_id, kind, display_name, root_path, crawl_device_id)
              VALUES (${smbSource}, ${orgA}, 'smb_share', 'summary smb', '\\\\srv\\share', ${crawlDeviceId})`;
  for (const relPath of relPaths) {
    await admin`INSERT INTO workspace_file_index
                  (org_id, source_id, device_id, device_key, rel_path, name)
                VALUES (${orgA}, ${smbSource}, NULL, ${SHARED_DEVICE_KEY}, ${relPath}, ${relPath})`;
  }
  await admin`INSERT INTO workspace_crawl_runs
                (org_id, source_id, device_id, device_key, status, started_at, last_activity_at, completed_at)
              VALUES (${orgA}, ${smbSource}, NULL, ${SHARED_DEVICE_KEY}, 'complete',
                      ${crawledAt}, ${crawledAt}, ${crawledAt})`;
  try {
    await fn();
  } finally {
    await admin`DELETE FROM workspace_crawl_runs WHERE source_id = ${smbSource}`;
    await admin`DELETE FROM workspace_file_index WHERE source_id = ${smbSource}`;
    await admin`DELETE FROM workspace_sources WHERE id = ${smbSource}`;
  }
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });
  app = postgres(APP_URL, { max: 1 });
  appDb = drizzle(app);
  partnerId = randomUUID();
  orgA = randomUUID();
  orgB = randomUUID();
  siteA = randomUUID();
  siteB = randomUUID();
  deviceA = randomUUID();
  otherDeviceA = randomUUID();
  smbOnlyDeviceA = randomUUID();
  deviceB = randomUUID();
  sourceOne = randomUUID();
  sourceTwo = randomUUID();
  const suffix = randomUUID();

  await admin`INSERT INTO partners (id, name, slug)
              VALUES (${partnerId}, 'workspace summary integration', ${`wsp-summary-${suffix}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${orgA}, ${partnerId}, 'wsp summary org a', ${`wsp-summary-a-${suffix}`}, 'USD'),
                     (${orgB}, ${partnerId}, 'wsp summary org b', ${`wsp-summary-b-${suffix}`}, 'USD')`;
  await admin`INSERT INTO sites (id, org_id, name)
              VALUES (${siteA}, ${orgA}, 'wsp summary site a'),
                     (${siteB}, ${orgB}, 'wsp summary site b')`;
  await admin`INSERT INTO devices
                (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
              VALUES
                (${deviceA}, ${orgA}, ${siteA}, ${`wsp-sum-a-${suffix}`}, 'sum-a', 'windows', '11', 'amd64', 'test'),
                (${otherDeviceA}, ${orgA}, ${siteA}, ${`wsp-sum-a2-${suffix}`}, 'sum-a2', 'windows', '11', 'amd64', 'test'),
                (${smbOnlyDeviceA}, ${orgA}, ${siteA}, ${`wsp-sum-a3-${suffix}`}, 'sum-a3', 'windows', '11', 'amd64', 'test'),
                (${deviceB}, ${orgB}, ${siteB}, ${`wsp-sum-b-${suffix}`}, 'sum-b', 'windows', '11', 'amd64', 'test')`;

  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, crawl_device_id)
              VALUES (${sourceOne}, ${orgA}, 'local_profile', 'summary one', '/Users', NULL),
                     (${sourceTwo}, ${orgA}, 'local_profile', 'summary two', '/Shared', NULL)`;

  // deviceA: 3 live rows across 2 sources + 1 tombstone (must not be counted).
  await admin`INSERT INTO workspace_file_index
                (org_id, source_id, device_id, device_key, rel_path, name, deleted_at)
              VALUES
                (${orgA}, ${sourceOne}, ${deviceA}, ${deviceA}, 'a/one.txt', 'one.txt', NULL),
                (${orgA}, ${sourceOne}, ${deviceA}, ${deviceA}, 'a/two.txt', 'two.txt', NULL),
                (${orgA}, ${sourceTwo}, ${deviceA}, ${deviceA}, 'b/three.txt', 'three.txt', NULL),
                (${orgA}, ${sourceOne}, ${deviceA}, ${deviceA}, 'a/gone.txt', 'gone.txt', now())`;
  // Same org, different device — must never bleed into deviceA's counts.
  await admin`INSERT INTO workspace_file_index
                (org_id, source_id, device_id, device_key, rel_path, name)
              VALUES (${orgA}, ${sourceOne}, ${otherDeviceA}, ${otherDeviceA}, 'c/other.txt', 'other.txt')`;

  await admin`INSERT INTO workspace_crawl_runs
                (org_id, source_id, device_id, device_key, status, started_at, last_activity_at, completed_at)
              VALUES
                (${orgA}, ${sourceOne}, ${deviceA}, ${deviceA}, 'complete',
                 ${OLDER_COMPLETED_AT}, ${OLDER_COMPLETED_AT}, ${OLDER_COMPLETED_AT}),
                (${orgA}, ${sourceOne}, ${deviceA}, ${deviceA}, 'complete',
                 ${COMPLETED_AT}, ${COMPLETED_AT}, ${COMPLETED_AT}),
                (${orgA}, ${sourceTwo}, ${deviceA}, ${deviceA}, 'failed',
                 ${COMPLETED_AT}, ${LAST_ACTIVITY_AT}, NULL),
                -- A terminal-but-unsuccessful run that still stamped
                -- completed_at, and stamped it LATER than the last good crawl.
                -- Without the status filter this would masquerade as the last
                -- successful crawl.
                (${orgA}, ${sourceTwo}, ${deviceA}, ${deviceA}, 'abandoned',
                 ${COMPLETED_AT}, ${LAST_ACTIVITY_AT}, ${FAILED_COMPLETED_AT})`;
});

afterAll(async () => {
  if (!admin) return;
  try {
    await admin`DELETE FROM workspace_crawl_runs WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM workspace_file_index WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM workspace_sources WHERE org_id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM devices WHERE id IN (${deviceA}, ${otherDeviceA}, ${smbOnlyDeviceA}, ${deviceB})`;
    await admin`DELETE FROM sites WHERE id IN (${siteA}, ${siteB})`;
    await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
    await admin`DELETE FROM partners WHERE id = ${partnerId}`;
  } finally {
    await admin.end();
    await app?.end();
  }
});

describe.sequential('device summary aggregate against real SQL', () => {
  it('counts live rows and distinct sources, excluding tombstones and other devices', async () => {
    const summary = await asOrg(orgA, (service) => service.summarize(orgA, deviceA));
    expect(summary).not.toBeNull();
    expect(summary?.indexedFiles).toBe(3);
    expect(summary?.visibleSources).toBe(2);
  });

  it('takes lastSuccessfulCrawlAt from completed runs only, and lastActivityAt from all runs', async () => {
    const summary = await asOrg(orgA, (service) => service.summarize(orgA, deviceA));
    expect(summary?.lastSuccessfulCrawlAt?.toISOString()).toBe(COMPLETED_AT.toISOString());
    // The failed run carries the newest activity; it must still count here and
    // must NOT become a "successful crawl".
    expect(summary?.lastActivityAt?.toISOString()).toBe(LAST_ACTIVITY_AT.toISOString());
  });

  it('reports null timestamps for a never-crawled device without borrowing another device rows', async () => {
    const summary = await asOrg(orgA, (service) => service.summarize(orgA, otherDeviceA));
    expect(summary).toEqual({
      deviceId: otherDeviceA,
      indexedFiles: 1,
      visibleSources: 1,
      lastSuccessfulCrawlAt: null,
      lastActivityAt: null,
    });
  });

  // SMB content is source-scoped: device_id NULL / device_key = shared zero
  // uuid, with the owning device named by workspace_sources.crawl_device_id
  // (see runScope.ts). These three tests pin the union semantic — a device's
  // summary covers what it is RESPONSIBLE for indexing — and, crucially, that
  // the union stays anchored to the owning device.
  it('counts the SMB content it crawls alongside its own device-scoped content', async () => {
    await withSmbSource(deviceA, ['s/one.txt', 's/two.txt'], SMB_CRAWL_AT, async () => {
      const summary = await asOrg(orgA, (service) => service.summarize(orgA, deviceA));
      // 3 device-scoped live rows across 2 sources, plus 2 SMB rows on 1 more.
      expect(summary?.indexedFiles).toBe(5);
      expect(summary?.visibleSources).toBe(3);
      // The SMB run is the newest, and it is a real crawl by this device.
      expect(summary?.lastSuccessfulCrawlAt?.toISOString()).toBe(SMB_CRAWL_AT.toISOString());
      expect(summary?.lastActivityAt?.toISOString()).toBe(SMB_CRAWL_AT.toISOString());
    });
  });

  // The regression this change exists to fix: before the union, a device whose
  // only job was crawling an SMB share reported 0 / 0 / null while crawling
  // successfully.
  it('reports real numbers for a device whose only role is crawling an SMB share', async () => {
    await withSmbSource(smbOnlyDeviceA, ['s/one.txt', 's/two.txt'], SMB_CRAWL_AT, async () => {
      const summary = await asOrg(orgA, (service) => service.summarize(orgA, smbOnlyDeviceA));
      expect(summary).toEqual({
        deviceId: smbOnlyDeviceA,
        indexedFiles: 2,
        visibleSources: 1,
        lastSuccessfulCrawlAt: SMB_CRAWL_AT,
        lastActivityAt: SMB_CRAWL_AT,
      });
    });
  });

  // THE cross-device control, written to fail if the owned-sources subquery
  // loses its `crawl_device_id = <device>` anchor. Dropping that anchor widens
  // the union to every source-scoped row in the org, so this share — crawled by
  // otherDeviceA, and carrying the newest timestamp of any row in the org —
  // would land in deviceA's summary and in smbOnlyDeviceA's.
  it('never counts an SMB source crawled by a different device in the same org', async () => {
    await withSmbSource(otherDeviceA, ['x/one.txt', 'x/two.txt'], FOREIGN_SMB_CRAWL_AT, async () => {
      const summary = await asOrg(orgA, (service) => service.summarize(orgA, deviceA));
      expect(summary?.indexedFiles).toBe(3);
      expect(summary?.visibleSources).toBe(2);
      expect(summary?.lastSuccessfulCrawlAt?.toISOString()).toBe(COMPLETED_AT.toISOString());
      expect(summary?.lastActivityAt?.toISOString()).toBe(LAST_ACTIVITY_AT.toISOString());

      // A device with no content of its own must stay at zero, not inherit it.
      const bystander = await asOrg(orgA, (service) => service.summarize(orgA, smbOnlyDeviceA));
      expect(bystander).toEqual({
        deviceId: smbOnlyDeviceA,
        indexedFiles: 0,
        visibleSources: 0,
        lastSuccessfulCrawlAt: null,
        lastActivityAt: null,
      });
    });
  });

  // crawl_device_id is only meaningful for smb_share, but routes/sources.ts
  // validateSmbConfig returns early for local_profile, so a local_profile
  // source may legally carry one. The owned-sources branch matches only
  // source-scoped rows (device_id IS NULL) precisely so that such a source
  // cannot attribute another device's device-scoped rows to its crawl device.
  it('never counts another device rows on a local_profile source it happens to crawl', async () => {
    const sharedLocal = randomUUID();
    await admin`INSERT INTO workspace_sources
                  (id, org_id, kind, display_name, root_path, crawl_device_id)
                VALUES (${sharedLocal}, ${orgA}, 'local_profile', 'summary shared local', '/Users', ${deviceA})`;
    // A device-scoped row owned by a DIFFERENT device on that same source.
    await admin`INSERT INTO workspace_file_index
                  (org_id, source_id, device_id, device_key, rel_path, name)
                VALUES (${orgA}, ${sharedLocal}, ${otherDeviceA}, ${otherDeviceA}, 'l/other.txt', 'other.txt')`;
    await admin`INSERT INTO workspace_crawl_runs
                  (org_id, source_id, device_id, device_key, status, started_at, last_activity_at, completed_at)
                VALUES (${orgA}, ${sharedLocal}, ${otherDeviceA}, ${otherDeviceA}, 'complete',
                        ${FOREIGN_SMB_CRAWL_AT}, ${FOREIGN_SMB_CRAWL_AT}, ${FOREIGN_SMB_CRAWL_AT})`;
    try {
      const summary = await asOrg(orgA, (service) => service.summarize(orgA, deviceA));
      expect(summary?.indexedFiles).toBe(3);
      expect(summary?.visibleSources).toBe(2);
      expect(summary?.lastSuccessfulCrawlAt?.toISOString()).toBe(COMPLETED_AT.toISOString());
      expect(summary?.lastActivityAt?.toISOString()).toBe(LAST_ACTIVITY_AT.toISOString());
    } finally {
      await admin`DELETE FROM workspace_crawl_runs WHERE source_id = ${sharedLocal}`;
      await admin`DELETE FROM workspace_file_index WHERE source_id = ${sharedLocal}`;
      await admin`DELETE FROM workspace_sources WHERE id = ${sharedLocal}`;
    }
  });

  it('makes a device in another org indistinguishable from one that does not exist', async () => {
    const crossOrg = await asOrg(orgA, (service) => service.summarize(orgA, deviceB));
    const missing = await asOrg(orgA, (service) => service.summarize(orgA, randomUUID()));
    expect(crossOrg).toBeNull();
    expect(missing).toBeNull();
  });

  it('does not leak counts across orgs even when asked for a foreign org id', async () => {
    // RLS is the backstop; the explicit org predicate is the first control.
    const spoofed = await asOrg(orgA, (service) => service.summarize(orgB, deviceB));
    expect(spoofed).toBeNull();
  });
});
