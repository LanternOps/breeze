/**
 * Evidence-hold fixture — PAM ownership epochs W5 (#8207).
 *
 * Until W6 turns on PAM-aware merges, `blocks-merge` refuses every merge whose
 * loser holds PAM evidence, so production cannot reach the post-Phase-B state
 * these tests need. This helper builds it by hand over the superuser
 * connection: the loser is stamped as a terminal merge shell
 * (`status='merging'`, `deleted_at` set, backdated past the sweeper's grace
 * window) and the `org_merge_events` row Phase B would have written is
 * inserted. The hold row itself is written by the production writer
 * (`writeEvidenceHold`) in the tests that exercise it, or raw here when a test
 * needs a lineage shape the writer cannot produce on its own.
 *
 * TEST-ONLY.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization } from './db-utils';

type Row = Record<string, unknown>;

export function rowsOf<T = Row>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}

/** Stamp `loserOrgId` as a merged-away shell and record the merge event. Returns the event id. */
export async function markMergedShell(input: {
  partnerId: string;
  loserOrgId: string;
  survivorOrgId: string;
}): Promise<string> {
  const eventId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO org_merge_events (id, partner_id, loser_org_id, loser_org_name, survivor_org_id, summary)
    VALUES (${eventId}::uuid, ${input.partnerId}::uuid, ${input.loserOrgId}::uuid, 'merged-away fixture org',
            ${input.survivorOrgId}::uuid, '{"tables":{},"warnings":[]}'::jsonb)`);
  await getTestDb().execute(sql`
    UPDATE organizations
       SET status = 'merging', deleted_at = now() - interval '3 hours', updated_at = now() - interval '3 hours'
     WHERE id = ${input.loserOrgId}::uuid`);
  return eventId;
}

/** Raw hold insert for lineage shapes the production writer cannot build alone. */
export async function insertHoldRaw(input: {
  partnerId: string;
  loserOrgId: string;
  survivorOrgId: string;
  mergeEventId: string;
  reason?: 'pam_evidence' | 'transitive';
}): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO org_evidence_holds (loser_org_id, partner_id, survivor_org_id, merge_event_id, reason)
    VALUES (${input.loserOrgId}::uuid, ${input.partnerId}::uuid, ${input.survivorOrgId}::uuid,
            ${input.mergeEventId}::uuid, ${input.reason ?? 'pam_evidence'})`);
}

/**
 * A held lineage of `hops` merges inside one partner: orgs[0] -> orgs[1] ->
 * ... -> orgs[hops]. Every org but the last is a held shell. Returns the org
 * ids in lineage order.
 */
export async function seedHeldLineage(partnerId: string, hops: number, first?: string): Promise<string[]> {
  const orgs: string[] = [first ?? (await createOrganization({ partnerId })).id];
  for (let i = 0; i < hops; i++) orgs.push((await createOrganization({ partnerId })).id);
  for (let i = 0; i < hops; i++) {
    const eventId = await markMergedShell({ partnerId, loserOrgId: orgs[i]!, survivorOrgId: orgs[i + 1]! });
    await insertHoldRaw({
      partnerId,
      loserOrgId: orgs[i]!,
      survivorOrgId: orgs[i + 1]!,
      mergeEventId: eventId,
      reason: i === 0 ? 'pam_evidence' : 'transitive',
    });
  }
  return orgs;
}

/**
 * md5 over every PAM-chain row an org owns, in a stable order. Byte-identical
 * evidence means this value never changes across a refused or deferred
 * operation.
 */
export async function chainMd5(orgId: string): Promise<string> {
  const [row] = rowsOf<{ digest: string | null }>(await getTestDb().execute(sql`
    SELECT md5(string_agg(r, '|' ORDER BY r)) AS digest FROM (
      SELECT 'act:' || row_to_json(a)::text AS r FROM pam_actuations a WHERE a.org_id = ${orgId}::uuid
      UNION ALL
      SELECT 'res:' || row_to_json(x)::text FROM pam_actuation_results x WHERE x.org_id = ${orgId}::uuid
      UNION ALL
      SELECT 'req:' || row_to_json(q)::text FROM elevation_requests q WHERE q.org_id = ${orgId}::uuid
      UNION ALL
      SELECT 'aud:' || row_to_json(e)::text FROM elevation_audit e WHERE e.org_id = ${orgId}::uuid
    ) chain`));
  return row?.digest ?? 'empty';
}

export async function countChainRows(orgId: string): Promise<number> {
  const [row] = rowsOf<{ n: number }>(await getTestDb().execute(sql`
    SELECT (SELECT count(*) FROM pam_actuations WHERE org_id = ${orgId}::uuid)
         + (SELECT count(*) FROM pam_actuation_results WHERE org_id = ${orgId}::uuid)
         + (SELECT count(*) FROM elevation_requests WHERE org_id = ${orgId}::uuid)
         + (SELECT count(*) FROM elevation_audit WHERE org_id = ${orgId}::uuid) AS n`));
  return Number(row?.n ?? 0);
}

/** Simulates the audit-admin retention path emptying an org's PAM chain. */
export async function expireChainByRetention(orgId: string): Promise<void> {
  const client = getTestDb();
  await client.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`DELETE FROM pam_actuation_results WHERE org_id = ${orgId}::uuid`);
    await tx.execute(sql`DELETE FROM pam_actuations WHERE org_id = ${orgId}::uuid`);
    await tx.execute(sql`DELETE FROM elevation_audit WHERE org_id = ${orgId}::uuid`);
    await tx.execute(sql`DELETE FROM elevation_requests WHERE org_id = ${orgId}::uuid`);
  });
}

export async function holdRow(loserOrgId: string): Promise<Row | undefined> {
  return rowsOf(await getTestDb().execute(sql`
    SELECT loser_org_id, partner_id, survivor_org_id, merge_event_id, reason
      FROM org_evidence_holds WHERE loser_org_id = ${loserOrgId}::uuid`))[0];
}

export async function orgState(orgId: string): Promise<{ status: string; deleted: boolean } | undefined> {
  return rowsOf<{ status: string; deleted: boolean }>(await getTestDb().execute(sql`
    SELECT status::text AS status, (deleted_at IS NOT NULL) AS deleted FROM organizations WHERE id = ${orgId}::uuid`))[0];
}
