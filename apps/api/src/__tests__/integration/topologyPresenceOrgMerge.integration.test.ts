import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeOrgMerge } from '../../services/orgMerge';
import { evaluateOrgPresence } from '../../services/topology/presenceEvaluator';
import { createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';
import { closeDb, twoSiteOrg, type PresenceDeviceSpec } from './topology-presence-fixtures';

afterAll(() => closeDb());

/**
 * Site location W2 (#7886): an org merge over a loser that holds an evaluated presence read model, with the REAL
 * invalidation triggers firing on the merge's own devices / discovery_profiles repoints mid-walk. Pins the
 * `leave-for-erasure` choice for topology_org_presence_state (a keep-survivor repoint would collide on its primary
 * key with the survivor row those triggers upsert) and that the merged presence rebuilds cleanly in the survivor.
 */
const admin = <T>(query: ReturnType<typeof sql>) => getTestDb().execute(query) as unknown as Promise<T[]>;
const DEVICES: PresenceDeviceSpec[] = [
  { key: 'L1', site: 'B', hostname: 'LAKESIDE-PC-01', address: '10.1.5.20', gateway: '10.1.5.1', gatewayMac: '00:00:5e:00:01:0b' },
  { key: 'MIS1', site: 'A', hostname: 'DESKTOP-HD7K2QF', address: '10.1.5.30', gateway: '10.1.5.1', gatewayMac: '00:00:5e:00:01:0b' },
];

let priorDrain: string | undefined;
beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
afterEach(() => { if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS; else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain; });

async function loserWithPresence() {
  const f = await twoSiteOrg({ declare: { B: ['10.1.5.0/24'] }, devices: DEVICES });
  await f.reportAll();
  await f.publishAll();
  await evaluateOrgPresence(f.orgId);
  const [visiting] = await admin<{ state: string }>(sql`SELECT state FROM topology_device_presence WHERE device_id = ${f.ids.MIS1}::uuid`);
  expect(visiting).toMatchObject({ state: 'visiting' }); // a matched-site row exists to be carried across the merge
  return f;
}

async function stateOf(orgId: string) {
  const [row] = await admin<{ org_id: string; dirty_at: string | null; dirty_seq: string; fingerprint_version: string }>(sql`
    SELECT org_id, dirty_at, dirty_seq::text AS dirty_seq, fingerprint_version::text AS fingerprint_version
    FROM topology_org_presence_state WHERE org_id = ${orgId}::uuid`);
  return row;
}

describe.each([
  { name: 'survivor already evaluated', survivorState: true },
  { name: 'survivor never evaluated (trigger creates its row mid-walk)', survivorState: false },
])('org merge with presence rows — $name', ({ survivorState }) => {
  it('commits, leaves the loser state row behind, marks the survivor dirty and re-evaluates cleanly', async () => {
    const f = await loserWithPresence();
    const survivor = await createOrganization({ partnerId: f.env.partner.id, name: 'Harbor Dental Group' });
    const survivorSite = await createSite({ orgId: survivor.id, name: 'Head Office' });
    if (survivorState) {
      await admin(sql`INSERT INTO topology_org_presence_state (org_id, fingerprint_version, coverage, evaluated_at)
        VALUES (${survivor.id}::uuid, 7, 'complete', now())`);
    }
    const loserBefore = await stateOf(f.orgId);
    // W3 (#7887): a daily summary row. A merge repoints it (history survives); only a non-merge org move deletes it.
    await admin(sql`INSERT INTO topology_device_presence_days (org_id, device_id, day, assigned_site_id, state, matched_site_id, match_key,
        first_observed_at, last_observed_at)
      VALUES (${f.orgId}::uuid, ${f.ids.MIS1}::uuid, '2026-09-01', ${f.env.site.id}::uuid, 'visiting', ${f.siteB}::uuid,
        ${`visiting:${f.siteB}`}, '2026-09-01T08:00:00Z', '2026-09-01T09:00:00Z')`);

    await executeOrgMerge({ loserOrgId: f.orgId, survivorOrgId: survivor.id, partnerId: f.env.partner.id,
      performedBy: f.env.user.id, performedByEmail: f.env.user.email });

    // The merged devices' presence rows went with the devices repoint (BEFORE trigger), never orphaned.
    const presence = await admin<{ org_id: string }>(sql`SELECT org_id FROM topology_device_presence
      WHERE device_id IN (${f.ids.L1}::uuid, ${f.ids.MIS1}::uuid)`);
    expect(presence).toEqual([]);
    const days = await admin<{ org_id: string; assigned_site_id: string }>(sql`SELECT org_id::text, assigned_site_id::text
      FROM topology_device_presence_days WHERE device_id = ${f.ids.MIS1}::uuid AND day = '2026-09-01'`);
    expect(days).toEqual([{ org_id: survivor.id, assigned_site_id: f.env.site.id }]);
    // leave-for-erasure: the loser keeps its own state row; nothing repointed onto the survivor.
    expect(await stateOf(f.orgId)).toMatchObject({ org_id: f.orgId, fingerprint_version: loserBefore!.fingerprint_version });
    // The survivor is dirty (created by the trigger if it had no row), with its own version untouched.
    const survivorAfter = await stateOf(survivor.id);
    expect(survivorAfter).toBeDefined();
    expect(survivorAfter!.dirty_at).not.toBeNull();
    expect(BigInt(survivorAfter!.dirty_seq)).toBeGreaterThan(0n);
    expect(survivorAfter!.fingerprint_version).toBe(survivorState ? '7' : '0');

    // Re-evaluating the survivor rebuilds presence for the merged sites.
    const result = await evaluateOrgPresence(survivor.id);
    expect(result.status).toBe('evaluated');
    const [mis] = await admin<{ state: string; matched_site_id: string; org_id: string }>(sql`SELECT state, matched_site_id::text, org_id::text
      FROM topology_device_presence WHERE device_id = ${f.ids.MIS1}::uuid`);
    expect(mis).toMatchObject({ state: 'visiting', matched_site_id: f.siteB, org_id: survivor.id });
    expect(survivorSite.id).toBeTruthy();
  });
});
