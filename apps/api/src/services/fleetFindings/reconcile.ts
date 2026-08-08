import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { fleetFindingDevices, fleetFindings } from '../../db/schema/fleetFindings';
import type { CandidateFinding } from './types';

// Bumped whenever the grouping/severity rules in producers.ts change in a way
// that should start a fresh episode lineage rather than silently reinterpret
// existing live rows.
export const FLEET_FINDINGS_ALGORITHM_VERSION = 1;

export interface ReconcileResult {
  opened: number;
  updated: number;
  resolved: number;
}

type FleetFindingRow = typeof fleetFindings.$inferSelect;
type FleetFindingDeviceRow = typeof fleetFindingDevices.$inferSelect;

function episodeKey(row: { kind: string; semanticKey: string }): string {
  return `${row.kind}::${row.semanticKey}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reconciles this pass's candidate findings against the org's live episodes
 * (fleet_findings rows with resolved_at IS NULL). Six semantics, each with a
 * dedicated test in reconcile.test.ts: (1) a candidate with no live episode
 * opens one; (2) membership rows always track the candidate; (3) an unchanged
 * live episode is left untouched (no revision bump); (4) a changed one is
 * bumped; (5) a dismissed episode is never mutated at the finding level; (6) a
 * live episode with no candidate this pass is resolved.
 *
 * Runs inside whatever DB access context the caller (the scheduled job, task 5)
 * has already established — this module only ever touches the ambient `db`,
 * matching services/metricRollups.ts. No transaction spans the whole org; each
 * candidate gets its own transaction.
 */
export async function reconcileOrgFindings(orgId: string, candidates: CandidateFinding[]): Promise<ReconcileResult> {
  const now = new Date();
  let opened = 0;
  let updated = 0;
  let resolved = 0;

  // "live" == resolvedAt IS NULL, mirroring the fleet_findings_live_episode_uq
  // partial unique index — this is what makes semantic #6 (new row after a
  // prior resolution) fall out for free: a resolved row simply never matches.
  const liveRows = await db
    .select()
    .from(fleetFindings)
    .where(and(
      eq(fleetFindings.orgId, orgId),
      eq(fleetFindings.algorithmVersion, FLEET_FINDINGS_ALGORITHM_VERSION),
      isNull(fleetFindings.resolvedAt),
    ));

  const liveByKey = new Map<string, FleetFindingRow>(liveRows.map((row) => [episodeKey(row), row as FleetFindingRow]));
  const candidateKeys = new Set(candidates.map((c) => episodeKey(c)));

  for (const candidate of candidates) {
    const existing = liveByKey.get(episodeKey(candidate));
    if (!existing) {
      await insertNewFinding(orgId, candidate, now);
      opened++;
      continue;
    }
    const wasUpdated = await reconcileExistingFinding(existing, candidate, now);
    if (wasUpdated) updated++;
  }

  for (const row of liveRows) {
    if (candidateKeys.has(episodeKey(row))) continue;
    await db
      .update(fleetFindings)
      .set({ status: 'resolved', resolvedAt: now, resolutionReason: 'source_cleared', updatedAt: now })
      .where(eq(fleetFindings.id, row.id));
    resolved++;
  }

  return { opened, updated, resolved };
}

async function insertNewFinding(orgId: string, candidate: CandidateFinding, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(fleetFindings)
      .values({
        orgId,
        kind: candidate.kind,
        semanticKey: candidate.semanticKey,
        algorithmVersion: FLEET_FINDINGS_ALGORITHM_VERSION,
        status: 'open',
        severity: candidate.severity,
        title: candidate.title,
        summary: candidate.summary,
        evidence: candidate.evidence,
        deviceCount: candidate.members.length,
        revision: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .returning({ id: fleetFindings.id });

    if (candidate.members.length > 0) {
      await tx.insert(fleetFindingDevices).values(candidate.members.map((member) => ({
        findingId: inserted!.id,
        orgId,
        deviceId: member.deviceId,
        sourceKind: member.sourceKind,
        sourceRowId: member.sourceRowId,
        memberEvidence: member.memberEvidence,
        firstSeenAt: now,
        lastSeenAt: now,
      })));
    }
  });
}

/**
 * Returns true when the finding-level row was bumped (counts toward
 * ReconcileResult.updated). Membership rows are always kept in sync with the
 * candidate regardless of that outcome (semantic #2), but a dismissed episode
 * is never reopened or otherwise mutated at the finding level (semantic #5),
 * and an unchanged live episode is left untouched (semantic #3).
 *
 * Semantic #5 is scoped to THIS function — i.e. to a dismissed episode that a
 * candidate still matches. The resolve loop in `reconcileOrgFindings` is
 * deliberately unconditional on status: a dismissed episode whose source has
 * cleared IS resolved (`source_cleared`), which is correct — dismissal
 * suppresses the finding, it does not pin it open forever.
 */
async function reconcileExistingFinding(existing: FleetFindingRow, candidate: CandidateFinding, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const existingMembers: FleetFindingDeviceRow[] = await tx
      .select()
      .from(fleetFindingDevices)
      .where(eq(fleetFindingDevices.findingId, existing.id));

    const existingIds = existingMembers.map((m) => m.deviceId);
    const existingIdSet = new Set(existingIds);
    const candidateById = new Map(candidate.members.map((m) => [m.deviceId, m]));
    const candidateIdSet = new Set(candidateById.keys());

    const toInsert = candidate.members.filter((m) => !existingIdSet.has(m.deviceId));
    const toDeleteIds = existingIds.filter((id) => !candidateIdSet.has(id));
    const toKeepIds = existingIds.filter((id) => candidateIdSet.has(id));

    if (toInsert.length > 0) {
      await tx.insert(fleetFindingDevices).values(toInsert.map((member) => ({
        findingId: existing.id,
        orgId: existing.orgId,
        deviceId: member.deviceId,
        sourceKind: member.sourceKind,
        sourceRowId: member.sourceRowId,
        memberEvidence: member.memberEvidence,
        firstSeenAt: now,
        lastSeenAt: now,
      })));
    }

    if (toDeleteIds.length > 0) {
      await tx.delete(fleetFindingDevices).where(and(
        eq(fleetFindingDevices.findingId, existing.id),
        inArray(fleetFindingDevices.deviceId, toDeleteIds),
      ));
    }

    for (const deviceId of toKeepIds) {
      const member = candidateById.get(deviceId)!;
      await tx.update(fleetFindingDevices)
        .set({ lastSeenAt: now, memberEvidence: member.memberEvidence })
        .where(and(
          eq(fleetFindingDevices.findingId, existing.id),
          eq(fleetFindingDevices.deviceId, deviceId),
        ));
    }

    if (existing.status === 'dismissed') return false;

    const membershipChanged = toInsert.length > 0 || toDeleteIds.length > 0;
    const evidenceChanged = !jsonEqual(existing.evidence, candidate.evidence);
    if (!membershipChanged && !evidenceChanged) return false;

    await tx.update(fleetFindings)
      .set({
        revision: existing.revision + 1,
        lastSeenAt: now,
        deviceCount: candidate.members.length,
        evidence: candidate.evidence,
        severity: candidate.severity,
        title: candidate.title,
        summary: candidate.summary,
        updatedAt: now,
      })
      .where(eq(fleetFindings.id, existing.id));

    return true;
  });
}
