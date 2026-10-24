/**
 * Shared access helpers for YARA rule sets (#6263): W03's rule-set CRUD
 * (`routes/security/yara.ts`), W04's IOC import and rule test, and the W05 AI
 * `ioc_hunt` tool. Moved verbatim out of `routes/security/yaraAccess.ts`
 * (which re-exports them) so services gate writes through the same
 * `writeDenial` without importing from `routes/` (#6268).
 */
import { and, asc, count, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { yaraRuleSets, type YaraRuleSet } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from './siteCeilingAccess';
import type { PublishRuleSetResult } from './yaraRuleSetPublisher';

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

export type RuleSetOwnerKind = 'builtin' | 'partner' | 'org';

export function ruleSetOwnerKind(set: Pick<YaraRuleSet, 'isBuiltin' | 'orgId'>): RuleSetOwnerKind {
  if (set.isBuiltin) return 'builtin';
  return set.orgId === null ? 'partner' : 'org';
}

export interface VisibleRuleSetSummary {
  id: string;
  name: string;
  ownerKind: RuleSetOwnerKind;
  orgId: string | null;
  enabled: boolean;
  autoQuarantine: boolean;
  publishedVersion: number | null;
  stale: boolean;
  ruleCount: number;
}

/**
 * Rule sets the caller can see, paged, in the Detection-rules list order
 * (built-in first, then by name). `orgId` narrows to the sets usable in that
 * org: its own, partner-wide and built-in (the access condition still bounds
 * which partner-wide sets are visible). Ambient (caller) DB context.
 */
export async function listVisibleRuleSets(
  auth: AuthContext,
  query: { orgId?: string; page: number; limit: number },
): Promise<{ data: VisibleRuleSetSummary[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, Math.floor(query.page));
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit)));
  const conditions: SQL[] = [];
  const access = ruleSetAccessCondition(auth);
  if (access) conditions.push(access);
  if (query.orgId) conditions.push(or(eq(yaraRuleSets.orgId, query.orgId), isNull(yaraRuleSets.orgId))!);
  const where = conditions.length ? and(...conditions) : undefined;
  const [{ value: total } = { value: 0 }] = await db.select({ value: count() }).from(yaraRuleSets).where(where);
  const rows = await db
    .select()
    .from(yaraRuleSets)
    .where(where)
    .orderBy(desc(yaraRuleSets.isBuiltin), asc(yaraRuleSets.name), asc(yaraRuleSets.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return {
    data: rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerKind: ruleSetOwnerKind(row),
      orgId: row.orgId,
      enabled: row.enabled,
      autoQuarantine: row.autoQuarantine,
      publishedVersion: row.publishedVersion,
      stale: row.stale,
      ruleCount: row.ruleCount,
    })),
    total: Number(total),
    page,
    limit,
  };
}
