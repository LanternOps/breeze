/**
 * Patch compliance report FILES follow their `patch_compliance_reports` rows,
 * against real Postgres with the production `db` (breeze_app, forced RLS) and a
 * real storage directory:
 *
 *  1. Org erasure removes the erased org's report files and keeps the
 *     surviving org's.
 *  2. The retention job removes a report file past the window and marks the
 *     row `expired` with no output path (the enum value exists after
 *     migration), and leaves a report inside the window alone. Its reads run
 *     in system scope: a contextless read under breeze_app sees no rows.
 *  3. The orphan sweep keeps a file whose row still owns it and removes one
 *     whose row is gone after the orphan floor (1 h), not the 30-day window —
 *     the lookup must SEE the rows.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, rm, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { sql } from 'drizzle-orm';

const storageRoot = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? '/tmp'}/breeze-patch-report-int-${process.pid}-${Math.random().toString(36).slice(2)}`;
  process.env.PATCH_REPORT_STORAGE_PATH = root;
  delete process.env.PATCH_REPORT_RETENTION_DAYS;
  delete process.env.PATCH_REPORT_ORPHAN_MIN_AGE_MS;
  return root;
});

import { getTestDb } from './setup';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { runPatchReportRetentionOnce } from '../../jobs/patchReportRetention';

const DAY_MS = 24 * 60 * 60 * 1000;

async function seed(): Promise<{ userId: string; orgA: string; orgB: string }> {
  const db = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const [partner] = (await db.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('Report Partner', ${`pr-${suffix}`}, 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [user] = (await db.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partner!.id}, ${`pr-${suffix}@example.com`}, 'Report Tester', 'active', now(), now()) RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const orgs: string[] = [];
  for (const tag of ['a', 'b']) {
    const [org] = (await db.execute(sql`
      INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
      VALUES (${partner!.id}, ${`Org ${tag}`}, ${`pr-${tag}-${suffix}`}, 'active', 'USD', now(), now()) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    orgs.push(org!.id);
  }
  return { userId: user!.id, orgA: orgs[0]!, orgB: orgs[1]! };
}

/** A completed report row for `orgId` and its CSV, both `ageDays` old. */
async function report(orgId: string, ageDays: number): Promise<{ id: string; path: string }> {
  const id = randomUUID();
  const path = join(storageRoot, `${id}.csv`);
  await writeFile(path, 'metric,value\ntotal,"1"\n', 'utf8');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(path, when, when);
  await getTestDb().execute(sql`
    INSERT INTO patch_compliance_reports (id, org_id, status, format, row_count, output_path, completed_at, created_at, updated_at)
    VALUES (${id}, ${orgId}, 'completed', 'csv', 1, ${path}, ${when.toISOString()}, ${when.toISOString()}, ${when.toISOString()})
  `);
  return { id, path };
}

async function row(id: string): Promise<{ status: string; output_path: string | null } | undefined> {
  const [found] = (await getTestDb().execute(
    sql`SELECT status::text AS status, output_path FROM patch_compliance_reports WHERE id = ${id}`,
  )) as unknown as Array<{ status: string; output_path: string | null }>;
  return found;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  await rm(storageRoot, { recursive: true, force: true });
  await mkdir(storageRoot, { recursive: true });
});

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

describe('patch compliance report files follow their rows', () => {
  it('org erasure removes the erased org\'s report files and keeps the surviving org\'s', async () => {
    const s = await seed();
    const erased = await report(s.orgA, 1);
    const control = await report(s.orgB, 1);

    await cascadeDeleteOrg(s.orgA, s.userId);

    expect(await row(erased.id)).toBeUndefined();
    expect(await exists(erased.path)).toBe(false);
    expect(await row(control.id)).toMatchObject({ status: 'completed', output_path: control.path });
    expect(await exists(control.path)).toBe(true);
  });

  it('the retention job expires reports past the window and leaves recent ones', async () => {
    const s = await seed();
    const old = await report(s.orgA, 40);
    const recent = await report(s.orgA, 5);

    const result = await runPatchReportRetentionOnce();

    expect(result.expired.expired).toBeGreaterThanOrEqual(1);
    expect(await exists(old.path)).toBe(false);
    expect(await row(old.id)).toEqual({ status: 'expired', output_path: null });
    expect(await exists(recent.path)).toBe(true);
    expect(await row(recent.id)).toMatchObject({ status: 'completed', output_path: recent.path });
  });

  it('the orphan sweep keeps an owned file and removes one whose row is gone', async () => {
    const s = await seed();
    // Owned and old, but its completion is recent enough to stay inside the
    // window: only the file's mtime is aged.
    const owned = await report(s.orgA, 1);
    const ownedAged = new Date(Date.now() - 40 * DAY_MS);
    await utimes(owned.path, ownedAged, ownedAged);
    // An orphan only a couple of hours old (e.g. an erased org's file whose
    // unlink failed) goes on the next run, not after the 30-day window.
    const orphan = await report(s.orgA, 1);
    const orphanAged = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(orphan.path, orphanAged, orphanAged);
    await getTestDb().execute(sql`DELETE FROM patch_compliance_reports WHERE id = ${orphan.id}`);

    const result = await runPatchReportRetentionOnce();

    expect(await exists(owned.path)).toBe(true);
    expect(await exists(orphan.path)).toBe(false);
    expect(result.orphans).toMatchObject({ removed: 1, failed: 0 });
  });
});
