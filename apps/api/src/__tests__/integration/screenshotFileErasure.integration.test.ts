/**
 * #8117 — helper screenshot FILES follow their `ai_screenshots` rows, against
 * real Postgres with the production `db` (breeze_app, forced RLS) and a real
 * storage directory:
 *
 *  1. Org erasure removes the erased org's files, keeps the control org's, and
 *     keeps a moved device's file that sits under the erased org's directory
 *     but belongs to a row the control org still owns.
 *  2. The expiry sweep finds a moved device's file through its storage_key.
 *     It also proves the sweep reads in system scope: a contextless read of
 *     ai_screenshots under breeze_app matches no rows at all.
 *  3. The orphan sweep keeps a referenced file and removes an unreferenced one
 *     — the lookup must SEE the rows, or every file would look orphaned.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';

const storageRoot = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/breeze-ss-int-${process.pid}-${Math.random().toString(36).slice(2)}`;
  process.env.SCREENSHOT_STORAGE_DIR = root;
  return root;
});

import { getTestDb } from './setup';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { deleteExpiredScreenshots, sweepOrphanedScreenshotFiles } from '../../services/screenshotStorage';

const TWO_HOURS = 2 * 60 * 60 * 1000;

interface Seed {
  userId: string;
  orgA: string;
  orgB: string;
  deviceA: string;
  deviceB: string;
}

async function seed(): Promise<Seed> {
  const db = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [partner] = (await db.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('Screenshot Partner', ${`ss-${suffix}`}, 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await db.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`ss-${suffix}@example.com`}, 'Screenshot Tester', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;

  const orgs: string[] = [];
  const devices: string[] = [];
  for (const tag of ['a', 'b']) {
    const [org] = (await db.execute(sql`
      INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
      VALUES (${partner!.id}, ${`Org ${tag}`}, ${`ss-${tag}-${suffix}`}, 'active', 'USD', now(), now()) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const [site] = (await db.execute(sql`
      INSERT INTO sites (org_id, name, created_at, updated_at) VALUES (${org!.id}, 'Site', now(), now()) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const [device] = (await db.execute(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, created_at, updated_at)
      VALUES (${org!.id}, ${site!.id}, ${`ss-${tag}-${suffix}`}, ${`host-${tag}`}, 'linux', '1.0', 'x86_64', '0.0.0-test', now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    orgs.push(org!.id);
    devices.push(device!.id);
  }
  return { userId: user!.id, orgA: orgs[0]!, orgB: orgs[1]!, deviceA: devices[0]!, deviceB: devices[1]! };
}

/** A screenshot file under `dirOrg` plus a row owned by `rowOrg` pointing at it. */
async function screenshot(opts: {
  dirOrg: string;
  rowOrg: string;
  deviceId: string;
  expired?: boolean;
  fileAgeMs?: number;
}): Promise<{ key: string; path: string }> {
  const file = `${randomUUID()}.jpg`;
  const key = `screenshots/${opts.dirOrg}/${opts.deviceId}/${file}`;
  const path = join(storageRoot, opts.dirOrg, opts.deviceId, file);
  await mkdir(join(storageRoot, opts.dirOrg, opts.deviceId), { recursive: true });
  await writeFile(path, 'jpeg-bytes');
  if (opts.fileAgeMs) {
    const t = new Date(Date.now() - opts.fileAgeMs);
    await utimes(path, t, t);
  }
  const expiresAt = opts.expired ? sql`now() - interval '1 hour'` : sql`now() + interval '1 day'`;
  await getTestDb().execute(sql`
    INSERT INTO ai_screenshots (device_id, org_id, storage_key, width, height, size_bytes, captured_by, expires_at)
    VALUES (${opts.deviceId}, ${opts.rowOrg}, ${key}, 10, 10, 10, 'helper', ${expiresAt})
  `);
  return { key, path };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function rowCount(key: string): Promise<number> {
  const [row] = (await getTestDb().execute(
    sql`SELECT count(*)::int AS n FROM ai_screenshots WHERE storage_key = ${key}`,
  )) as unknown as Array<{ n: number }>;
  return row!.n;
}

/** Re-point a device (and, like the move trigger, its screenshot rows) to another org. */
async function moveDevice(deviceId: string, toOrg: string): Promise<void> {
  const db = getTestDb();
  const [site] = (await db.execute(sql`SELECT id FROM sites WHERE org_id = ${toOrg} LIMIT 1`)) as unknown as Array<{ id: string }>;
  await db.execute(sql`UPDATE devices SET org_id = ${toOrg}, site_id = ${site!.id} WHERE id = ${deviceId}`);
  await db.execute(sql`UPDATE ai_screenshots SET org_id = ${toOrg} WHERE device_id = ${deviceId}`);
}

beforeEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(storageRoot, { recursive: true });
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe('helper screenshot files follow their rows (#8117)', () => {
  it('org erasure removes the erased org\'s files and nothing the surviving org still references', async () => {
    const s = await seed();
    const erased = await screenshot({ dirOrg: s.orgA, rowOrg: s.orgA, deviceId: s.deviceA });
    const control = await screenshot({ dirOrg: s.orgB, rowOrg: s.orgB, deviceId: s.deviceB });
    // Captured while deviceB was in org A, then the device moved to org B: the
    // file stays under A's directory, the row now belongs to B.
    const moved = await screenshot({ dirOrg: s.orgA, rowOrg: s.orgB, deviceId: s.deviceB });

    await cascadeDeleteOrg(s.orgA, s.userId);

    expect(await rowCount(erased.key)).toBe(0);
    expect(await exists(erased.path)).toBe(false);
    expect(await rowCount(control.key)).toBe(1);
    expect(await exists(control.path)).toBe(true);
    expect(await rowCount(moved.key)).toBe(1);
    expect(await exists(moved.path)).toBe(true);
  });

  it('the expiry sweep removes a moved device\'s file through its storage key', async () => {
    const s = await seed();
    const shot = await screenshot({ dirOrg: s.orgA, rowOrg: s.orgA, deviceId: s.deviceA, expired: true });
    await moveDevice(s.deviceA, s.orgB);

    const deleted = await deleteExpiredScreenshots();

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await rowCount(shot.key)).toBe(0);
    expect(await exists(shot.path)).toBe(false);
  });

  it('the orphan sweep keeps referenced files and removes unreferenced ones', async () => {
    const s = await seed();
    const referenced = await screenshot({ dirOrg: s.orgA, rowOrg: s.orgA, deviceId: s.deviceA, fileAgeMs: TWO_HOURS });
    const movedReferenced = await screenshot({ dirOrg: s.orgA, rowOrg: s.orgB, deviceId: s.deviceB, fileAgeMs: TWO_HOURS });
    const orphan = await screenshot({ dirOrg: s.orgA, rowOrg: s.orgA, deviceId: s.deviceA, fileAgeMs: TWO_HOURS });
    await getTestDb().execute(sql`DELETE FROM ai_screenshots WHERE storage_key = ${orphan.key}`);

    const result = await sweepOrphanedScreenshotFiles();

    expect(await exists(referenced.path)).toBe(true);
    expect(await exists(movedReferenced.path)).toBe(true);
    expect(await exists(orphan.path)).toBe(false);
    expect(result).toMatchObject({ scanned: 3, removed: 1, failed: 0 });
  });
});
