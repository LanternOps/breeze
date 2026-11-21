/**
 * Portal registration W10 (#11387): the read-only preflight that gates PR-A
 * (G1, against v0.130) and PR-B (G2, against release N)
 * (migrations/preflight/2026-11-21-100000-portal-entra-columns-drop-preflight.sql).
 * Each query runs alone, in system scope, against seeded rows, so the
 * operator's output can be trusted:
 *  - `sanity` proves the run is not RLS-blind;
 *  - `drift_counts` / `drift_samples` name each of the four buckets;
 *  - `fence_writes` sees a fence-written identity (login carries the same pair)
 *    and ignores a release-N one (no pair) and a `migrated` backfill row.
 * Deleted by PR-B together with the columns it reads.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';

const PREFLIGHT = '2026-11-21-100000-portal-entra-columns-drop-preflight.sql';
const entraIssuer = (tid: string) => `https://login.microsoftonline.com/${tid}/v2.0`;

async function query(name: string): Promise<string> {
  const file = await readFile(new URL(`../../../migrations/preflight/${PREFLIGHT}`, import.meta.url), 'utf8');
  const marker = `-- @query ${name}\n`;
  const start = file.indexOf(marker);
  if (start < 0) throw new Error(`preflight query ${name} not found`);
  const body = file.slice(start + marker.length);
  return body.slice(0, body.indexOf(';\n'));
}

const run = async (name: string) => withSystemDbAccessContext(async () =>
  [...(await db.execute(sql.raw(await query(name))))] as Array<Record<string, unknown>>);

const ids = { missing: randomUUID(), orphan: randomUUID(), mismatched: randomUUID(), half: randomUUID(), fenced: randomUUID(), clean: randomUUID() };
const tid = randomUUID();
let orgId = '';

async function login(id: string, pair: { oid: string | null; tid: string | null }) {
  await db.execute(sql`INSERT INTO portal_users (id, org_id, email, auth_method, status, browser_access, entra_oid, entra_tenant_id)
    VALUES (${id}, ${orgId}, ${`${id}@w10-preflight.test`}, 'entra', 'active', 'none', ${pair.oid}, ${pair.tid})`);
}
async function identity(portalUserId: string, oid: string, linkedVia = 'jit', createdAt = new Date()) {
  await db.execute(sql`INSERT INTO portal_user_identities (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via, created_at)
    VALUES (${orgId}, ${portalUserId}, 'entra', ${entraIssuer(tid)}, ${oid}, ${tid}, ${linkedVia}, ${createdAt})`);
}

beforeEach(async () => {
  const partner = await createPartner();
  orgId = (await createOrganization({ partnerId: partner.id })).id;
  await withSystemDbAccessContext(async () => {
    await login(ids.missing, { oid: 'oid-missing', tid });
    await login(ids.orphan, { oid: null, tid: null });
    await identity(ids.orphan, 'oid-orphan');
    await login(ids.mismatched, { oid: 'oid-legacy', tid });
    await identity(ids.mismatched, 'oid-current');
    await login(ids.half, { oid: 'oid-half', tid: null });
    await login(ids.fenced, { oid: 'oid-fenced', tid });
    await identity(ids.fenced, 'oid-fenced', 'jit', new Date('2026-12-01T00:00:00Z'));
    await login(ids.clean, { oid: 'oid-clean', tid });
    // A final-backfill row is not a fence write, however recent.
    await identity(ids.clean, 'oid-clean', 'migrated', new Date('2027-06-01T00:00:00Z'));
  });
});

describe('portal entra columns preflight (W10 G1/G2)', () => {
  it('sanity proves the run is in system scope and sees portal users', async () => {
    const [row] = await run('sanity');
    expect(row).toMatchObject({ effective_scope: 'system' });
    expect(Number(row!.portal_users)).toBeGreaterThanOrEqual(6);
    expect(Number(row!.portal_users_with_legacy_pair)).toBeGreaterThanOrEqual(5);
  });

  it('schema_state shows the legacy objects still present (release N)', async () => {
    const [row] = await run('schema_state');
    expect(row).toMatchObject({ legacy_index: true, fill_trigger: true });
    expect(Number(row!.legacy_columns)).toBe(2);
  });

  it('drift_counts counts each bucket once', async () => {
    const [row] = await run('drift_counts');
    expect(Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]))).toEqual({
      missing_identity: 1, orphan_identity: 1, mismatched: 1, half_populated: 1,
    });
  });

  it('drift_samples names the row of each bucket', async () => {
    const rows = await run('drift_samples');
    expect(rows.map((r) => [r.bucket, r.portal_user_id])).toEqual(expect.arrayContaining([
      ['missing_identity', ids.missing],
      ['orphan_identity', ids.orphan],
      ['mismatched', ids.mismatched],
      ['half_populated', ids.half],
    ]));
    expect(rows.map((r) => r.portal_user_id)).not.toContain(ids.clean);
  });

  it('fence_writes reports the newest fence-written identity and ignores migrated rows', async () => {
    const [row] = await run('fence_writes');
    expect(new Date(String(row!.last_fence_write_at)).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});
