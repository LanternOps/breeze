/**
 * Org merge evidence holds — PAM ownership epochs W5 (#8207), spec §7.1–7.2.
 *
 * `pam_actuations` and `pam_actuation_results` are never re-tenanted by a
 * merge (today `blocks-merge` refuses the merge outright; from W6 they stay
 * behind under the loser's org_id). `elevation_requests` and
 * `elevation_audit` still repoint today; whatever chain rows the loser STILL
 * owns after the Phase-B walk keep the loser org row alive as a held shell
 * (`org_evidence_holds`) instead of being erased in Phase C. A survivor that
 * is itself the survivor of a held shell is held transitively when it merges
 * away, so A -> B -> C keeps A's lineage alive.
 *
 * Release is an erasure-path action only (OD6):
 *   - erasing the survivor erases its held shells first (tenantCascade.ts);
 *   - retention emptying a shell's chain lets the offboarding sweeper release
 *     the hold and hand the shell to erasure (tenantOffboarding.ts);
 *   - erasing the whole partner erases everything, holds included.
 *
 * Every function here runs on the ambient connection (`dbModule.db`): the
 * caller supplies a system-scope context. Holds are system-write-only at the
 * RLS layer, and an org- or partner-scoped caller would silently read zero
 * chain rows from another org.
 */
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';

/** Hops of held lineage a survivor can read (matches the SQL walk in breeze_merged_lineage_org_ids). */
export const EVIDENCE_HOLD_LINEAGE_DEPTH_CAP = 5;

/** Tables whose loser-owned rows keep a merged-away shell alive. */
export const EVIDENCE_HOLD_CHAIN_TABLES = [
  'pam_actuations',
  'pam_actuation_results',
  'elevation_requests',
  'elevation_audit',
] as const;

export const EVIDENCE_HOLD_DEFERRED_ACTION = 'tenant.erasure.deferred_evidence_hold';
export const EVIDENCE_HOLD_RELEASED_ACTION = 'tenant.erasure.evidence_hold_released';

export type EvidenceHoldReason = 'pam_evidence' | 'transitive';

export interface EvidenceHold {
  loserOrgId: string;
  partnerId: string;
  survivorOrgId: string;
  mergeEventId: string;
  reason: EvidenceHoldReason;
}

const uuid = (v: string) => sql`${v}::uuid`;

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/** SQL predicate: `org` (a uuid expression) owns at least one PAM-chain row. */
function ownsChainRows(org: ReturnType<typeof sql>) {
  return sql.join(
    EVIDENCE_HOLD_CHAIN_TABLES.map((t) => sql`EXISTS (SELECT 1 FROM ${sql.identifier(t)} WHERE org_id = ${org})`),
    sql` OR `,
  );
}

/**
 * Phase B: write the hold for a loser that still owns PAM-chain rows after
 * the walk, or that is the survivor of an existing hold. Must run AFTER the
 * registry walk (rows a policy repointed to the survivor do not count) and
 * after the `org_merge_events` insert (the hold references it). Returns the
 * reason written, or null when the loser needs no hold.
 */
export async function writeEvidenceHold(input: {
  loserOrgId: string;
  survivorOrgId: string;
  partnerId: string;
  mergeEventId: string;
}): Promise<EvidenceHoldReason | null> {
  const loser = uuid(input.loserOrgId);
  const written = rows<{ reason: EvidenceHoldReason }>(await dbModule.db.execute(sql`
    INSERT INTO org_evidence_holds (loser_org_id, partner_id, survivor_org_id, merge_event_id, reason)
    SELECT ${loser}, ${uuid(input.partnerId)}, ${uuid(input.survivorOrgId)}, ${uuid(input.mergeEventId)},
           CASE WHEN ${ownsChainRows(loser)} THEN 'pam_evidence' ELSE 'transitive' END
     WHERE (${ownsChainRows(loser)})
        OR EXISTS (SELECT 1 FROM org_evidence_holds h WHERE h.survivor_org_id = ${loser})
    RETURNING reason`));
  return written[0]?.reason ?? null;
}

/**
 * Hops of held lineage that already end at `orgId` (0 when nothing held
 * merges into it). Merging `orgId` away adds one hop to every held shell
 * behind it.
 */
export async function heldLineageDepth(orgId: string): Promise<number> {
  const [row] = rows<{ depth: number | null }>(await dbModule.db.execute(sql`
    WITH RECURSIVE behind(org_id, depth) AS (
      SELECT h.loser_org_id, 1 FROM org_evidence_holds h WHERE h.survivor_org_id = ${uuid(orgId)}
      UNION
      SELECT h.loser_org_id, b.depth + 1
        FROM behind b JOIN org_evidence_holds h ON h.survivor_org_id = b.org_id
       WHERE b.depth <= ${EVIDENCE_HOLD_LINEAGE_DEPTH_CAP}
    )
    SELECT max(depth)::int AS depth FROM behind`));
  return Number(row?.depth ?? 0);
}

export async function findEvidenceHold(orgId: string): Promise<EvidenceHold | null> {
  const [row] = rows<{
    loser_org_id: string; partner_id: string; survivor_org_id: string; merge_event_id: string; reason: EvidenceHoldReason;
  }>(await dbModule.db.execute(sql`
    SELECT loser_org_id, partner_id, survivor_org_id, merge_event_id, reason
      FROM org_evidence_holds WHERE loser_org_id = ${uuid(orgId)}`));
  return row
    ? {
      loserOrgId: row.loser_org_id,
      partnerId: row.partner_id,
      survivorOrgId: row.survivor_org_id,
      mergeEventId: row.merge_event_id,
      reason: row.reason,
    }
    : null;
}

/** Holds whose shells `survivorOrgId`'s erasure must erase first. */
export async function listHoldsBySurvivor(survivorOrgId: string): Promise<EvidenceHold[]> {
  return rows<{
    loser_org_id: string; partner_id: string; survivor_org_id: string; merge_event_id: string; reason: EvidenceHoldReason;
  }>(await dbModule.db.execute(sql`
    SELECT loser_org_id, partner_id, survivor_org_id, merge_event_id, reason
      FROM org_evidence_holds WHERE survivor_org_id = ${uuid(survivorOrgId)}
     ORDER BY created_at, loser_org_id`)).map((row) => ({
    loserOrgId: row.loser_org_id,
    partnerId: row.partner_id,
    survivorOrgId: row.survivor_org_id,
    mergeEventId: row.merge_event_id,
    reason: row.reason,
  }));
}

/**
 * Every held shell behind `survivorOrgId`, transitively (A -> B -> C gives
 * [B, A] for C), bounded one hop past the read cap so a malformed lineage
 * still terminates. Survivor erasure pre-checks these before erasing any.
 */
export async function listHeldLineage(survivorOrgId: string): Promise<string[]> {
  return rows<{ org_id: string }>(await dbModule.db.execute(sql`
    WITH RECURSIVE behind(org_id, depth) AS (
      SELECT h.loser_org_id, 1 FROM org_evidence_holds h WHERE h.survivor_org_id = ${uuid(survivorOrgId)}
      UNION
      SELECT h.loser_org_id, b.depth + 1
        FROM behind b JOIN org_evidence_holds h ON h.survivor_org_id = b.org_id
       WHERE b.depth <= ${EVIDENCE_HOLD_LINEAGE_DEPTH_CAP}
    )
    SELECT DISTINCT org_id FROM behind`)).map((r) => r.org_id);
}

/** Deletes the hold on `loserOrgId`. Only the erasure path calls this. */
export async function deleteEvidenceHold(loserOrgId: string): Promise<number> {
  return rows<{ loser_org_id: string }>(await dbModule.db.execute(sql`
    DELETE FROM org_evidence_holds WHERE loser_org_id = ${uuid(loserOrgId)} RETURNING loser_org_id`)).length;
}

/**
 * Retention release, in ONE statement so the emptiness check and the delete
 * share a snapshot (a held shell is fenced and deleted, so nothing writes new
 * chain rows under it): releases every hold whose shell owns no
 * PAM-chain row any more and is not itself the survivor of another hold (that
 * shell's erasure would destroy the inner shell's evidence). Returns the
 * released holds; the caller hands each shell to erasure.
 */
export async function releaseEmptyEvidenceHolds(): Promise<EvidenceHold[]> {
  return rows<{
    loser_org_id: string; partner_id: string; survivor_org_id: string; merge_event_id: string; reason: EvidenceHoldReason;
  }>(await dbModule.db.execute(sql`
    DELETE FROM org_evidence_holds h
     WHERE NOT (${ownsChainRows(sql`h.loser_org_id`)})
       AND NOT EXISTS (SELECT 1 FROM org_evidence_holds inner_h WHERE inner_h.survivor_org_id = h.loser_org_id)
    RETURNING h.loser_org_id, h.partner_id, h.survivor_org_id, h.merge_event_id, h.reason`)).map((row) => ({
    loserOrgId: row.loser_org_id,
    partnerId: row.partner_id,
    survivorOrgId: row.survivor_org_id,
    mergeEventId: row.merge_event_id,
    reason: row.reason,
  }));
}
