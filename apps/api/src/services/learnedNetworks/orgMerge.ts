/**
 * Learned networks W01a (#12370, spec §6, index A7): the org-merge fold, `resolve` half of the `learned_networks`
 * custom merge policy (orgMergeRegistry.ts). The move half (`moveLearnedNetworks` in orgMergeCustomExecutors.ts)
 * repoints whatever this leaves under the loser.
 *
 * Two orgs can hold the same fingerprint (gateway_mac, gateway_address), most likely when one customer was created
 * twice. A plain repoint would then abort the merge on learned_network_gateways_fingerprint_uniq, so this pass runs
 * first, while every row is still under the loser, and folds per fingerprint:
 *
 *   - each colliding loser gateway `t` hands its device rows and grants to the survivor's identical gateway `s`
 *     (the only row it can collide with), widens `s`'s seen window, and is deleted;
 *   - a loser network whose gateways ALL fold into ONE survivor network `M` is merged into `M`: profiles, jobs,
 *     assets and WAN rows are re-pointed, the assignment carries over only when `M` is unassigned, and the
 *     network is deleted;
 *   - any other loser network that lost a gateway (a split across survivor networks, or a partial fold) is kept
 *     without the folded gateways and is unassigned. A partial fold is never merged: that would put an unreviewed
 *     gateway into a network that may be assigned. A split network keeps no gateway at all. Profiles pointing at
 *     it keep pointing at an unassigned network, which the discovery gate (later waves) treats as fail-closed.
 *
 * A source site keeps discovery_network_required, so a site that lost its last network fails closed.
 *
 * Rows are located by id; org_id is used only to pair loser and survivor fingerprints and to stamp new WAN rows.
 * Child rows are re-pointed BEFORE their parent is deleted
 * (cascade actions are not deferred). Rows in between name a survivor-org parent under a loser org_id, which the
 * merge's `SET CONSTRAINTS ALL DEFERRED` (services/orgMerge.ts) admits until the move half repoints them. The
 * device-org-move trigger breeze_learned_networks_device_moved stands down while the loser is 'merging', so this
 * fold, not that trigger, decides the device rows. Memberships keep their fingerprint identity here, so the
 * devices' network_attachment_digest stays valid and is not cleared (index A8 applies to deletes outside a merge).
 *
 * Runs on the merge's ambient transaction (`dbModule.db`), like every executor; never opens its own.
 */
import { sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../../db';
import { extractRowCount } from '../../db/rowCount';
import type { CustomMergeExecutor, MergeTableOutcome } from '../orgMergeCustomExecutors';

/** Max WAN rows kept per network (spec §6 limits); the oldest by last_seen_at are dropped. */
export const LEARNED_NETWORK_WAN_ADDRESS_LIMIT = 32;

const uuid = (v: string) => sql`${v}::uuid`;
const uuidArray = (ids: readonly string[]) =>
  ids.length === 0 ? sql`ARRAY[]::uuid[]` : sql`ARRAY[${sql.join(ids.map(uuid), sql`, `)}]::uuid[]`;

/**
 * Every loser gateway `t` paired with the survivor gateway `s` of the identical fingerprint. Shared by the
 * executor and its preview count so the two cannot disagree.
 */
function fingerprintPairs(loser: string, survivor: string): SQL {
  return sql`
    SELECT t.id AS t_id, t.network_id AS t_network_id, s.id AS s_id, s.network_id AS s_network_id
      FROM learned_network_gateways t
      JOIN learned_network_gateways s
        ON s.gateway_mac = t.gateway_mac AND s.gateway_address = t.gateway_address
     WHERE t.org_id = ${uuid(loser)} AND s.org_id = ${uuid(survivor)}`;
}

/** Loser networks whose every gateway pairs, all into one survivor network: (t_network_id, s_network_id). */
function wholeFolds(pairs: SQL): SQL {
  return sql`
    SELECT p.t_network_id, (array_agg(p.s_network_id))[1] AS s_network_id
      FROM (${pairs}) p
     GROUP BY p.t_network_id
    HAVING count(DISTINCT p.s_network_id) = 1
       AND count(*) = (SELECT count(*) FROM learned_network_gateways g WHERE g.network_id = p.t_network_id)`;
}

async function run(statement: SQL): Promise<number> {
  return extractRowCount(await dbModule.db.execute(statement));
}

interface PairRow {
  t_id: string;
  t_network_id: string;
  s_id: string;
  s_network_id: string;
  t_network_gateways: number;
  t_network_assigned: boolean;
}

export const resolveLearnedNetworks: CustomMergeExecutor = async (loser, survivor): Promise<MergeTableOutcome> => {
  // 1. One read. No pairs (every ordinary merge): nothing else runs.
  const result = await dbModule.db.execute(sql`
    SELECT p.t_id::text, p.t_network_id::text, p.s_id::text, p.s_network_id::text,
           (SELECT count(*)::int FROM learned_network_gateways g WHERE g.network_id = p.t_network_id) AS t_network_gateways,
           (SELECT n.site_id IS NOT NULL FROM learned_networks n WHERE n.id = p.t_network_id) AS t_network_assigned
      FROM (${fingerprintPairs(loser, survivor)}) p
     ORDER BY p.t_network_id, p.t_id`);
  // Not null-safe on purpose (as extractRowCount): a result that is not a row list is a driver fault, not "no
  // collisions", and treating it as empty would surface as a raw 23505 in the move phase instead.
  if (!Array.isArray(result)) throw new Error('resolveLearnedNetworks: fingerprint read returned no row list');
  const pairs = result as unknown as PairRow[];
  if (pairs.length === 0) return { moved: 0, dropped: 0, notes: [] };

  // 2. Classify each loser network that has a colliding gateway.
  const byNetwork = new Map<string, PairRow[]>();
  for (const row of pairs) byNetwork.set(row.t_network_id, [...(byNetwork.get(row.t_network_id) ?? []), row]);
  const folds: Array<{ from: string; into: string }> = [];
  const kept: string[] = [];
  let assignmentsChanged = 0;
  for (const [networkId, rows] of byNetwork) {
    const targets = new Set(rows.map((r) => r.s_network_id));
    if (targets.size === 1 && rows.length === rows[0]!.t_network_gateways) folds.push({ from: networkId, into: rows[0]!.s_network_id });
    else kept.push(networkId);
    if (rows[0]!.t_network_assigned) assignmentsChanged++;
  }

  // 3. Per pair: device rows and grants move to the survivor fingerprint, its seen window widens, the loser one goes.
  const tIds = pairs.map((p) => p.t_id);
  const sIds = pairs.map((p) => p.s_id);
  const mapping = sql`unnest(${uuidArray(tIds)}, ${uuidArray(sIds)}) AS m(t_id, s_id)`;
  await run(sql`UPDATE learned_network_devices d SET gateway_id = m.s_id FROM ${mapping} WHERE d.gateway_id = m.t_id`);
  await run(sql`UPDATE discovery_profile_snmp_grants g SET gateway_id = m.s_id FROM ${mapping} WHERE g.gateway_id = m.t_id`);
  await run(sql`
    UPDATE learned_network_gateways s
       SET first_seen_at = LEAST(s.first_seen_at, t.first_seen_at), last_seen_at = GREATEST(s.last_seen_at, t.last_seen_at)
      FROM ${mapping}
      JOIN learned_network_gateways t ON t.id = m.t_id
     WHERE s.id = m.s_id`);
  const gatewaysDeleted = await run(sql`DELETE FROM learned_network_gateways WHERE id = ANY (${uuidArray(tIds)})`);

  // 4. Whole folds N -> M.
  let networksDeleted = 0;
  if (folds.length > 0) {
    const nIds = folds.map((f) => f.from);
    const mIds = folds.map((f) => f.into);
    const fold = sql`unnest(${uuidArray(nIds)}, ${uuidArray(mIds)}) AS f(n_id, m_id)`;
    await run(sql`UPDATE discovery_profiles x SET network_id = f.m_id FROM ${fold} WHERE x.network_id = f.n_id`);
    await run(sql`UPDATE discovery_jobs x SET network_id = f.m_id FROM ${fold} WHERE x.network_id = f.n_id`);
    await run(sql`UPDATE discovered_assets x SET last_network_id = f.m_id FROM ${fold} WHERE x.last_network_id = f.n_id`);
    // Aggregated first: two loser networks folding into one M may share an address, and ON CONFLICT DO UPDATE
    // cannot touch one row twice in a statement.
    await run(sql`
      INSERT INTO learned_network_wan_addresses (org_id, network_id, address, first_seen_at, last_seen_at)
      SELECT ${uuid(survivor)}, f.m_id, w.address, min(w.first_seen_at), max(w.last_seen_at)
        FROM learned_network_wan_addresses w
        JOIN ${fold} ON w.network_id = f.n_id
       GROUP BY f.m_id, w.address
      ON CONFLICT (network_id, address) DO UPDATE
         SET first_seen_at = LEAST(learned_network_wan_addresses.first_seen_at, EXCLUDED.first_seen_at),
             last_seen_at = GREATEST(learned_network_wan_addresses.last_seen_at, EXCLUDED.last_seen_at)`);
    await run(sql`DELETE FROM learned_network_wan_addresses WHERE network_id = ANY (${uuidArray(nIds)})`);
    await run(sql`
      DELETE FROM learned_network_wan_addresses w
       USING (SELECT id, row_number() OVER (PARTITION BY network_id ORDER BY last_seen_at DESC, id DESC) AS rn
                FROM learned_network_wan_addresses WHERE network_id = ANY (${uuidArray(mIds)})) r
       WHERE w.id = r.id AND r.rn > ${LEARNED_NETWORK_WAN_ADDRESS_LIMIT}`);
    // The assignment carries over only to an unassigned M (from the earliest-assigned N if several fold into it);
    // when both are assigned the survivor's wins.
    await run(sql`
      WITH f AS (SELECT * FROM ${fold}),
      agg AS (
        SELECT f.m_id, min(n.first_seen_at) AS first_seen_at, max(n.last_seen_at) AS last_seen_at,
               (array_agg(n.name ORDER BY n.id) FILTER (WHERE n.name IS NOT NULL))[1] AS name,
               (array_agg(n.prefix ORDER BY n.last_seen_at DESC, n.id) FILTER (WHERE n.prefix IS NOT NULL))[1] AS prefix
          FROM f JOIN learned_networks n ON n.id = f.n_id
         GROUP BY f.m_id),
      asg AS (
        SELECT DISTINCT ON (f.m_id) f.m_id, n.site_id, n.assigned_by, n.assigned_at
          FROM f JOIN learned_networks n ON n.id = f.n_id
         WHERE n.site_id IS NOT NULL
         ORDER BY f.m_id, n.assigned_at NULLS LAST, n.id)
      UPDATE learned_networks m
         SET site_id = CASE WHEN m.site_id IS NULL AND asg.site_id IS NOT NULL THEN asg.site_id ELSE m.site_id END,
             assigned_by = CASE WHEN m.site_id IS NULL AND asg.site_id IS NOT NULL THEN asg.assigned_by ELSE m.assigned_by END,
             assigned_at = CASE WHEN m.site_id IS NULL AND asg.site_id IS NOT NULL THEN asg.assigned_at ELSE m.assigned_at END,
             ignored_at = CASE WHEN m.site_id IS NULL AND asg.site_id IS NOT NULL THEN NULL ELSE m.ignored_at END,
             name = COALESCE(m.name, agg.name),
             prefix = COALESCE(m.prefix, agg.prefix),
             first_seen_at = LEAST(m.first_seen_at, agg.first_seen_at),
             last_seen_at = GREATEST(m.last_seen_at, agg.last_seen_at),
             updated_at = now()
        FROM agg LEFT JOIN asg ON asg.m_id = agg.m_id
       WHERE m.id = agg.m_id`);
    networksDeleted = await run(sql`DELETE FROM learned_networks WHERE id = ANY (${uuidArray(nIds)})`);
  }

  // 5. Kept networks that lost a gateway are unassigned (the move half repoints them as they are).
  if (kept.length > 0) {
    await run(sql`
      UPDATE learned_networks SET site_id = NULL, assigned_by = NULL, assigned_at = NULL, updated_at = now()
       WHERE id = ANY (${uuidArray(kept)})`);
  }

  // 6. Operator note when an assignment changed: a merged or unassigned network can leave a gated site with none.
  const notes = assignmentsChanged > 0
    ? [`learned_networks: ${folds.length} merged into identical survivor networks, ${kept.length} left unassigned because their gateways matched more than one survivor network or only some of them`]
    : [];
  return { moved: 0, dropped: gatewaysDeleted + networksDeleted, notes };
};

/** Read-only mirror of resolveLearnedNetworks' DELETEs (folded gateways + merged networks), for previewOrgMerge. */
export function learnedNetworkFoldDropCount(loser: string, survivor: string): SQL {
  const pairs = fingerprintPairs(loser, survivor);
  return sql`
    SELECT ((SELECT count(*) FROM (${pairs}) p) + (SELECT count(*) FROM (${wholeFolds(pairs)}) f))::int AS n`;
}
