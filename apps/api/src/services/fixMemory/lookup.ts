/**
 * Fix-memory lookup (AI Suggested Fixes W1). Runs on the AMBIENT db, so under
 * a request/tool context RLS bounds it; the explicit owner filter below also
 * holds under system context (memory attach). Current-state checks before a
 * row is ever returned: for a script-backed kind (system/partner/org_script),
 * the script must be undeleted, still support this OS, still be at the
 * pinned head version, and its current owner must still be visible to the
 * target org/partner; for a `playbook` kind, the playbook must still exist
 * and be active; a `manual_steps` row's reviewed fix_instructions row must still
 * exist (retirement is handled by the sweeper, deletion drops the title).
 * `builtin_action` has no backing record and is always dispatchable.
 */
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { FixKind, FixMemoryStatus } from '@breeze/shared';
import { db } from '../../db';
import { fixInstructions, fixMemory, playbookDefinitions, scripts, scriptVersions } from '../../db/schema';
import { isProven } from './aggregate';
import type { FixSignature } from './signature';

export interface FixTrackRecord {
  memoryId: string;
  scope: 'all_clients' | 'this_client';
  fixKind: FixKind;
  scriptId: string | null;
  scriptVersionId: string | null;
  scriptName: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  instructionsRef: string | null;
  /** Human-authored; shown to the org's own users. NEVER include in AI tool output. */
  instructionsTitle: string | null;
  attempts: number;
  verified: number;
  failed: number;
  recurred: number;
  upVotes: number;
  downVotes: number;
  successRate: number;
  lastVerifiedAt: string | null;
  status: FixMemoryStatus;
}

export interface FixLookupResult {
  signature: { version: number; broad: boolean; family: string; condition: string; osFamily: string; discriminatorKind: string | null };
  proven: FixTrackRecord[];
  similar: FixTrackRecord[];
}

export interface MemoryCandidateRow {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  signatureKey: string;
  broadKey: string;
  osType: string;
  fixKind: FixKind;
  scriptId: string | null;
  scriptVersionId: string | null;
  builtinAction: string | null;
  playbookId: string | null;
  instructionsRef: string | null;
  instructionsTitle: string | null;
  attempts: number;
  verifiedCount: number;
  failedCount: number;
  recurredCount: number;
  upVotes: number;
  downVotes: number;
  rollingSuccessRate: number;
  recentOutcomes: string[];
  status: FixMemoryStatus;
  staleSince: Date | null;
  lastVerifiedAt: Date | null;
  script: { name: string; deletedAt: Date | null; osTypes: string[]; headVersion: number; isSystem: boolean; orgId: string | null; partnerId: string | null } | null;
  scriptVersionNumber: number | null;
  playbook: { isActive: boolean } | null;
}

const SCRIPT_KINDS = new Set<FixKind>(['system_script', 'partner_script', 'org_script']);

/**
 * The script's CURRENT owner must match the row's owner AND be visible to the
 * target org — checked here, independently of ambient RLS, because memory
 * attach runs under system scope. routes/scripts.ts can re-scope a script
 * (partner→org, org A→org B) without cutting a version (:921-928, :997-1038),
 * and owner drift is only folded on the next sweep.
 */
function scriptOwnerVisible(row: MemoryCandidateRow, s: NonNullable<MemoryCandidateRow['script']>, ctx: { orgId: string; partnerId: string }): boolean {
  if (row.orgId === null) return s.isSystem || (s.orgId === null && s.partnerId === ctx.partnerId);
  return !s.isSystem && s.orgId === row.orgId && s.orgId === ctx.orgId;
}

function isDispatchable(row: MemoryCandidateRow, ctx: { orgId: string; partnerId: string; osFamily: string }): boolean {
  if (SCRIPT_KINDS.has(row.fixKind)) {
    const s = row.script;
    return Boolean(
      s && s.deletedAt === null && s.osTypes.includes(ctx.osFamily)
      && row.scriptVersionNumber !== null && row.scriptVersionNumber === s.headVersion
      && scriptOwnerVisible(row, s, ctx),
    );
  }
  if (row.fixKind === 'playbook') return Boolean(row.playbook?.isActive);
  if (row.fixKind === 'manual_steps') return row.instructionsTitle !== null;
  return true;
}

function track(row: MemoryCandidateRow): FixTrackRecord {
  return {
    memoryId: row.id,
    scope: row.orgId === null ? 'all_clients' : 'this_client',
    fixKind: row.fixKind, scriptId: row.scriptId, scriptVersionId: row.scriptVersionId,
    scriptName: row.script?.name ?? null, builtinAction: row.builtinAction, playbookId: row.playbookId,
    instructionsRef: row.instructionsRef, instructionsTitle: row.instructionsTitle,
    attempts: row.attempts, verified: row.verifiedCount, failed: row.failedCount, recurred: row.recurredCount,
    upVotes: row.upVotes, downVotes: row.downVotes,
    successRate: Math.round(row.rollingSuccessRate * 100) / 100,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    status: row.status,
  };
}

const byStrength = (a: FixTrackRecord, b: FixTrackRecord) => b.successRate - a.successRate || b.verified - a.verified;

export function classifyMemoryRows(
  rows: readonly MemoryCandidateRow[],
  ctx: { orgId: string; partnerId: string; signatureKey: string; broadKey: string; broad: boolean; osFamily: string },
  limit: number,
): { proven: FixTrackRecord[]; similar: FixTrackRecord[] } {
  const proven: FixTrackRecord[] = [];
  const similar: FixTrackRecord[] = [];
  for (const row of rows) {
    const visible = row.orgId !== null ? row.orgId === ctx.orgId : row.partnerId === ctx.partnerId;
    if (!visible || row.osType !== ctx.osFamily || row.status === 'retired') continue;
    if (!isDispatchable(row, ctx)) continue;
    const exact = row.signatureKey === ctx.signatureKey;
    const provenNow = exact && !ctx.broad && isProven({
      status: row.status, stale: row.staleSince !== null, verifiedCount: row.verifiedCount,
      rollingSuccessRate: row.rollingSuccessRate, recentOutcomes: row.recentOutcomes,
    });
    if (provenNow) proven.push(track(row));
    else if (row.broadKey === ctx.broadKey) similar.push(track(row));
  }
  return { proven: proven.sort(byStrength).slice(0, limit), similar: similar.sort(byStrength).slice(0, limit) };
}

export async function lookupFixes(input: { orgId: string; partnerId: string; signature: FixSignature; limit: number }): Promise<FixLookupResult> {
  const sig = input.signature;
  const rows = await db
    .select({
      id: fixMemory.id, orgId: fixMemory.orgId, partnerId: fixMemory.partnerId,
      signatureKey: fixMemory.signatureKey, broadKey: fixMemory.broadKey, osType: fixMemory.osType, fixKind: fixMemory.fixKind,
      scriptId: fixMemory.scriptId, scriptVersionId: fixMemory.scriptVersionId, builtinAction: fixMemory.builtinAction,
      playbookId: fixMemory.playbookId, instructionsRef: fixMemory.instructionsRef, instructionsTitle: fixInstructions.title, attempts: fixMemory.attempts, verifiedCount: fixMemory.verifiedCount,
      failedCount: fixMemory.failedCount, recurredCount: fixMemory.recurredCount, upVotes: fixMemory.upVotes,
      downVotes: fixMemory.downVotes, rollingSuccessRate: fixMemory.rollingSuccessRate, recentOutcomes: fixMemory.recentOutcomes,
      status: fixMemory.status, staleSince: fixMemory.staleSince, lastVerifiedAt: fixMemory.lastVerifiedAt,
      scriptName: scripts.name, scriptDeletedAt: scripts.deletedAt, scriptOsTypes: scripts.osTypes, scriptHeadVersion: scripts.version,
      scriptIsSystem: scripts.isSystem, scriptOrgId: scripts.orgId, scriptPartnerId: scripts.partnerId,
      scriptVersionNumber: scriptVersions.version,
      playbookIsActive: playbookDefinitions.isActive,
    })
    .from(fixMemory)
    .leftJoin(scripts, eq(scripts.id, fixMemory.scriptId))
    .leftJoin(scriptVersions, and(eq(scriptVersions.id, fixMemory.scriptVersionId), eq(scriptVersions.scriptId, fixMemory.scriptId)))
    .leftJoin(playbookDefinitions, eq(playbookDefinitions.id, fixMemory.playbookId))
    .leftJoin(fixInstructions, eq(sql`${fixInstructions.id}::text`, fixMemory.instructionsRef))
    .where(and(
      eq(fixMemory.signatureVersion, sig.version),
      eq(fixMemory.osType, sig.facets.osFamily),
      or(eq(fixMemory.signatureKey, sig.key), eq(fixMemory.broadKey, sig.broadKey)),
      or(eq(fixMemory.orgId, input.orgId), and(isNull(fixMemory.orgId), eq(fixMemory.partnerId, input.partnerId))),
      ne(fixMemory.status, 'retired'),
    ))
    // Exact-signature rows first, so a >100-match partner never has its proven
    // rows silently dropped by an arbitrary Postgres pick; ties broken by
    // strength, then id for determinism.
    .orderBy(desc(sql`${fixMemory.signatureKey} = ${sig.key}`), desc(fixMemory.rollingSuccessRate), desc(fixMemory.verifiedCount), fixMemory.id)
    .limit(100);
  const candidates: MemoryCandidateRow[] = rows.map((r) => ({
    id: r.id, orgId: r.orgId, partnerId: r.partnerId, signatureKey: r.signatureKey, broadKey: r.broadKey,
    osType: r.osType, fixKind: r.fixKind, scriptId: r.scriptId, scriptVersionId: r.scriptVersionId,
    builtinAction: r.builtinAction, playbookId: r.playbookId,
    instructionsRef: r.instructionsRef, instructionsTitle: r.instructionsTitle, attempts: r.attempts, verifiedCount: r.verifiedCount,
    failedCount: r.failedCount, recurredCount: r.recurredCount, upVotes: r.upVotes, downVotes: r.downVotes,
    rollingSuccessRate: r.rollingSuccessRate, recentOutcomes: r.recentOutcomes, status: r.status,
    staleSince: r.staleSince, lastVerifiedAt: r.lastVerifiedAt,
    script: r.scriptName === null
      ? null
      : {
        name: r.scriptName, deletedAt: r.scriptDeletedAt, osTypes: r.scriptOsTypes ?? [], headVersion: r.scriptHeadVersion ?? -1,
        isSystem: r.scriptIsSystem ?? false, orgId: r.scriptOrgId ?? null, partnerId: r.scriptPartnerId ?? null,
      },
    scriptVersionNumber: r.scriptVersionNumber ?? null,
    playbook: r.playbookIsActive === null ? null : { isActive: r.playbookIsActive },
  }));
  const { proven, similar } = classifyMemoryRows(candidates, {
    orgId: input.orgId, partnerId: input.partnerId, signatureKey: sig.key, broadKey: sig.broadKey,
    broad: sig.broad, osFamily: sig.facets.osFamily,
  }, input.limit);
  return {
    signature: {
      version: sig.version, broad: sig.broad, family: sig.facets.family, condition: sig.facets.condition,
      osFamily: sig.facets.osFamily, discriminatorKind: sig.facets.discriminator?.kind ?? null,
    },
    proven,
    similar,
  };
}
