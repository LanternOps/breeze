/**
 * Write gate for a `security` feature link's `ruleSetIds` (#6263 W03a).
 *
 * A policy may attach only rule sets every device it reaches can fetch:
 *   - an ORG policy: that org's own sets, its partner's partner-wide sets, and
 *     the built-in pack;
 *   - a PARTNER-WIDE policy: its partner's partner-wide sets and the built-in
 *     pack — never an org set (the other orgs' devices could not fetch it).
 *
 * The check runs in the caller's own RLS context, so a set the caller cannot
 * see also fails. The scan-time resolver re-applies the same ownership rule per
 * device, and the agent fetch route re-checks under the agent's context; this
 * gate makes a bad attachment a 400 at save time instead of a silent per-scan
 * `not_found`.
 *
 * Enforces the spec §5.3 cap of 20 sets per policy. Malformed values are
 * rejected here even though `parseSecurityScanSettings` would quietly drop
 * them, so what the UI saved is what scans use.
 */
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { YARA_MAX_RULE_SETS_PER_POLICY } from '@breeze/shared';
import { db } from '../../db';
import { yaraRuleSets } from '../../db/schema';
import { resolvePartnerIdForOrg } from '../patches/helpers';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SecurityRuleSetGateResult =
  | { ok: true }
  | { ok: false; status: 400; body: { error: string; code: string; ruleSetIds?: string[] } };

function reject(error: string, code: string, ruleSetIds?: string[]): SecurityRuleSetGateResult {
  return { ok: false, status: 400, body: { error, code, ...(ruleSetIds ? { ruleSetIds } : {}) } };
}

export async function checkSecurityRuleSetsWrite(
  owner: { orgId: string | null; partnerId: string | null },
  inlineSettings: unknown,
): Promise<SecurityRuleSetGateResult> {
  if (typeof inlineSettings !== 'object' || inlineSettings === null) return { ok: true };
  const raw = (inlineSettings as { ruleSetIds?: unknown }).ruleSetIds;
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw)) return reject('ruleSetIds must be an array of rule set ids', 'INVALID_RULE_SET_IDS');

  const ids: string[] = [];
  for (const item of raw) {
    const id = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (!UUID_PATTERN.test(id)) return reject('ruleSetIds must contain only rule set ids', 'INVALID_RULE_SET_IDS');
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return { ok: true };
  if (ids.length > YARA_MAX_RULE_SETS_PER_POLICY) {
    return reject(`A policy can use at most ${YARA_MAX_RULE_SETS_PER_POLICY} rule sets`, 'TOO_MANY_RULE_SETS');
  }

  const partnerId = owner.partnerId ?? (owner.orgId ? await resolvePartnerIdForOrg(owner.orgId) : null);
  const branches: SQL[] = [sql`${yaraRuleSets.isBuiltin} = true`];
  if (owner.orgId) branches.push(eq(yaraRuleSets.orgId, owner.orgId));
  if (partnerId) branches.push(and(isNull(yaraRuleSets.orgId), eq(yaraRuleSets.partnerId, partnerId))!);

  const rows = await db
    .select({ id: yaraRuleSets.id })
    .from(yaraRuleSets)
    .where(and(inArray(yaraRuleSets.id, ids), or(...branches)));
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return reject(
      owner.orgId === null
        ? 'A partner-wide policy can use only partner-wide rule sets and the built-in pack'
        : 'These rule sets do not exist or are not available to this policy',
      'YARA_RULE_SET_NOT_ATTACHABLE',
      missing,
    );
  }
  return { ok: true };
}
