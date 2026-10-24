/**
 * Shared access helpers for the `/security/yara` route modules (#6263):
 * W03's rule-set CRUD (`yara.ts`) and W04's IOC import and rule test
 * (`yaraIocImport.ts`, `yaraTest.ts`). Moved verbatim out of `yara.ts` so
 * every module gates writes through the same `writeDenial`.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { db } from '../../db';
import { yaraRuleSets, type YaraRuleSet } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import type { PublishRuleSetResult } from '../../services/yaraRuleSetPublisher';

export const BUILTIN_READ_ONLY = 'The built-in rule set is read-only';

/**
 * Sets visible to the caller (on top of RLS, which is the real boundary):
 * own orgs, the caller's partner's partner-wide sets, and the built-in pack.
 * The partner-wide branch is safe for ORG tokens too: RLS grants them that
 * read through `yara_rule_sets_partner_wide_select` (breeze_current_partner_id
 * = the token's own partner), so app and DB agree.
 */
export function ruleSetAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(yaraRuleSets.orgId);
  if (!orgCond) return undefined; // system scope
  const branches: SQL[] = [orgCond, sql`${yaraRuleSets.isBuiltin} = true`];
  if (auth.partnerId) {
    branches.push(sql`(${yaraRuleSets.orgId} IS NULL AND ${yaraRuleSets.partnerId} = ${auth.partnerId})`);
  }
  return sql`(${sql.join(branches, sql` OR `)})`;
}

export async function loadVisibleSet(auth: AuthContext, id: string): Promise<YaraRuleSet | null> {
  const conditions: SQL[] = [eq(yaraRuleSets.id, id)];
  const access = ruleSetAccessCondition(auth);
  if (access) conditions.push(access);
  const [row] = await db.select().from(yaraRuleSets).where(and(...conditions)).limit(1);
  return row ?? null;
}

/** null = allowed; otherwise the 403 message. */
export function writeDenial(auth: AuthContext, set: Pick<YaraRuleSet, 'isBuiltin' | 'orgId'>): string | null {
  if (set.isBuiltin) return BUILTIN_READ_ONLY;
  if (!canMutateOrgWideGovernance(auth)) return SITE_CEILING_WRITE_DENIED_MESSAGE;
  if (set.orgId === null && !canManagePartnerWidePolicies(auth)) return PARTNER_WIDE_WRITE_DENIED_MESSAGE;
  if (set.orgId !== null && !auth.canAccessOrg(set.orgId)) return 'Access denied';
  return null;
}

export function publishBody(result: PublishRuleSetResult) {
  return {
    published: result.published,
    version: result.version,
    currentVersion: result.currentVersion,
    stale: result.stale,
    errors: result.errors,
    ...(result.autoQuarantineOnly ? { autoQuarantineOnly: true } : {}),
    ...(result.unavailable ? { precheckUnavailable: true } : {}),
  };
}

/** Publish outcome for audit details: an outage must read differently from a rule error. */
export function publishAudit(result: PublishRuleSetResult) {
  return {
    published: result.published,
    version: result.version,
    stale: result.stale,
    ...(result.autoQuarantineOnly ? { autoQuarantineOnly: true } : {}),
    ...(result.unavailable ? { precheckUnavailable: true } : {}),
  };
}

export function auditOwner(set: Pick<YaraRuleSet, 'orgId' | 'partnerId'>) {
  return { orgId: set.orgId, partnerId: set.partnerId };
}
