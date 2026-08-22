// #3472: the backfill that clears crawl_device_id from legacy local_profile
// rows. Real Postgres, because the migration is plain SQL — a unit test cannot
// tell a correct predicate from an inverted one, and getting this wrong either
// leaves the forbidden shape in place or wipes crawl devices off smb_share
// sources that legitimately need them.
//
// Bootstrap mirrors ingestJobs.integration.test.ts (:5433 stack, admin role,
// idempotent migration re-apply).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
if (new URL(ADMIN_URL).port === '5432') throw new Error('refusing to run against :5432 — use the test stack (:5433)');

const MIGRATION = '2026-08-17-workspace-local-profile-crawl-device-backfill.sql';

let admin: postgres.Sql;
let partner: string, org: string, site: string, deviceId: string;
let legacyLocal: string, cleanLocal: string, smbSource: string;

async function applyBackfill() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, '../../migrations/', MIGRATION), 'utf8');
  await admin.begin(async (tx) => { await tx.unsafe(sql); });
}

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1 });

  // The shared :5433 stack may not carry the workspace tables (it gets
  // reprovisioned by other branches' runs), so apply the foundation
  // idempotently first — same re-apply gotcha ingestJobs.integration.test.ts
  // documents.
  const here = dirname(fileURLToPath(import.meta.url));
  const foundation = readFileSync(join(here, '../../migrations/2026-07-10-workspace-foundation.sql'), 'utf8');
  await admin.begin(async (tx) => { await tx.unsafe(foundation); });

  partner = randomUUID(); org = randomUUID(); site = randomUUID(); deviceId = randomUUID();
  legacyLocal = randomUUID(); cleanLocal = randomUUID(); smbSource = randomUUID();
  const sfx = randomUUID();

  await admin`INSERT INTO partners (id, name, slug) VALUES (${partner}, 'wsp-3472', ${`wsp-3472-${sfx}`})`;
  await admin`INSERT INTO organizations (id, partner_id, name, slug, currency_code)
              VALUES (${org}, ${partner}, 'wsp-3472-org', ${`wsp-3472-org-${sfx}`}, 'USD')`;
  await admin`INSERT INTO sites (id, org_id, name) VALUES (${site}, ${org}, 'wsp-3472-site')`;
  await admin`INSERT INTO devices
                (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
              VALUES (${deviceId}, ${org}, ${site}, ${`wsp-3472-agent-${sfx}`},
                      'wsp-3472-dev', 'windows', '11', 'amd64', 'test')`;

  // The forbidden legacy shape main allowed, a clean local_profile, and an
  // smb_share whose crawl device MUST survive.
  await admin`INSERT INTO workspace_sources (id, org_id, kind, display_name, root_path, crawl_device_id)
              VALUES (${legacyLocal}, ${org}, 'local_profile', 'legacy', '/Users', ${deviceId}),
                     (${cleanLocal},  ${org}, 'local_profile', 'clean',  '/Users', NULL),
                     (${smbSource},   ${org}, 'smb_share',     'share',  '\\\\srv\\share', ${deviceId})`;
});

afterAll(async () => {
  await admin`DELETE FROM workspace_sources WHERE org_id = ${org}`;
  await admin`DELETE FROM devices WHERE org_id = ${org}`;
  await admin`DELETE FROM sites WHERE id = ${site}`;
  await admin`DELETE FROM organizations WHERE id = ${org}`;
  await admin`DELETE FROM partners WHERE id = ${partner}`;
  await admin.end();
});

// Deliberately NOT `row?.crawl_device_id ?? null`: that collapses "row was
// deleted" and "column is NULL" into the same answer, so a migration that
// DELETEs the offending rows instead of clearing the column would satisfy every
// assertion below. Throw on a missing row so the two stay distinguishable.
async function crawlDeviceOf(id: string): Promise<string | null> {
  const rows = await admin<{ crawl_device_id: string | null }[]>`
    SELECT crawl_device_id FROM workspace_sources WHERE id = ${id}`;
  if (rows.length !== 1) {
    throw new Error(`expected exactly 1 workspace_sources row for ${id}, found ${rows.length}`);
  }
  return rows[0].crawl_device_id;
}

describe('#3472 local_profile crawl-device backfill', () => {
  it('clears the crawl device from a legacy local_profile row and leaves smb_share alone', async () => {
    expect(await crawlDeviceOf(legacyLocal)).toBe(deviceId);

    await applyBackfill();

    expect(await crawlDeviceOf(legacyLocal)).toBeNull();
    // The inverse mistake — a predicate that matched smb_share — would strand
    // every SMB source with no crawler. Pin it.
    expect(await crawlDeviceOf(smbSource)).toBe(deviceId);
    expect(await crawlDeviceOf(cleanLocal)).toBeNull();
    // And the row count must be unchanged: clearing a column is not the same
    // as removing the source, and the operator keeps their configuration.
    const [{ count }] = await admin<{ count: string }[]>`
      SELECT count(*)::text AS count FROM workspace_sources WHERE org_id = ${org}`;
    expect(count).toBe('3');
  });

  it('is idempotent: re-applying touches nothing', async () => {
    await applyBackfill();
    expect(await crawlDeviceOf(legacyLocal)).toBeNull();
    expect(await crawlDeviceOf(smbSource)).toBe(deviceId);
  });
});
