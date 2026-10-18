/**
 * YARA rule sets and rules — `/security/yara` (#6263 W03a).
 *
 * Ownership (Partner-Wide First): a set is org-owned, partner-wide (all orgs
 * of the MSP), or THE built-in pack. Reads follow RLS plus an app-layer
 * dual-axis condition; writes:
 *   - built-in set: always 403 (it is written only by the release boot upsert);
 *   - partner-wide set: `canManagePartnerWidePolicies` (403 otherwise);
 *   - any set: `canMutateOrgWideGovernance` — a rule set reaches every device
 *     of every policy that attaches it, so a site-restricted caller may not
 *     edit one;
 *   - role: `devices:write`, plus `devices:execute` to switch a set's
 *     auto-quarantine ON (it moves files on devices; turning it off is the
 *     fail-safe direction and stays ungated).
 *
 * Every rule mutation and every `enabled`/`autoQuarantine` change runs
 * `publishRuleSet` in the same request transaction and returns
 * `{ published, version, currentVersion, stale, errors }`: the set is
 * pre-checked with the agent's own compiler and only a fully valid bundle is
 * published to devices.
 *
 * Audit events carry names and ids only — never rule source (customer IP).
 */
import { Hono, type Context } from 'hono';
import { and, asc, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import { isPgUniqueViolation } from '@breeze/shared/pgErrors';
import { YARA_MAX_RULES_PER_SET } from '@breeze/shared';

import { db, withDbTransaction } from '../../db';
import { yaraRuleSets, yaraRules, type YaraRuleSet } from '../../db/schema';
import { requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { publishRuleSet, type PublishRuleSetResult } from '../../services/yaraRuleSetPublisher';
import { requireSecurityReadAccess } from './readAuthorization';
import { getPolicyOrgId } from './helpers';
import {
  createYaraRuleSchema,
  createYaraRuleSetSchema,
  updateYaraRuleSchema,
  updateYaraRuleSetSchema,
  yaraRuleIdParamSchema,
  yaraRuleSetIdParamSchema,
} from './yaraSchemas';

export const yaraRoutes = new Hono();

const BUILTIN_READ_ONLY = 'The built-in rule set is read-only';
const AUTO_QUARANTINE_EXECUTE_REQUIRED =
  'Auto-quarantine moves files on every device that scans with this rule set, so enabling it requires the devices:execute permission.';

/**
 * Sets visible to the caller (on top of RLS, which is the real boundary):
 * own orgs, the caller's partner's partner-wide sets, and the built-in pack.
 * The partner-wide branch is safe for ORG tokens too: RLS grants them that
 * read through `yara_rule_sets_partner_wide_select` (breeze_current_partner_id
 * = the token's own partner), so app and DB agree.
 */
function ruleSetAccessCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(yaraRuleSets.orgId);
  if (!orgCond) return undefined; // system scope
  const branches: SQL[] = [orgCond, sql`${yaraRuleSets.isBuiltin} = true`];
  if (auth.partnerId) {
    branches.push(sql`(${yaraRuleSets.orgId} IS NULL AND ${yaraRuleSets.partnerId} = ${auth.partnerId})`);
  }
  return sql`(${sql.join(branches, sql` OR `)})`;
}

async function loadVisibleSet(auth: AuthContext, id: string): Promise<YaraRuleSet | null> {
  const conditions: SQL[] = [eq(yaraRuleSets.id, id)];
  const access = ruleSetAccessCondition(auth);
  if (access) conditions.push(access);
  const [row] = await db.select().from(yaraRuleSets).where(and(...conditions)).limit(1);
  return row ?? null;
}

/** null = allowed; otherwise the 403 message. */
function writeDenial(auth: AuthContext, set: Pick<YaraRuleSet, 'isBuiltin' | 'orgId'>): string | null {
  if (set.isBuiltin) return BUILTIN_READ_ONLY;
  if (!canMutateOrgWideGovernance(auth)) return SITE_CEILING_WRITE_DENIED_MESSAGE;
  if (set.orgId === null && !canManagePartnerWidePolicies(auth)) return PARTNER_WIDE_WRITE_DENIED_MESSAGE;
  if (set.orgId !== null && !auth.canAccessOrg(set.orgId)) return 'Access denied';
  return null;
}

function mayEnableAutoQuarantine(c: Context): boolean {
  const perms = c.get('permissions') as UserPermissions | undefined;
  return !!perms && hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);
}

function summarize(row: YaraRuleSet) {
  return {
    id: row.id,
    orgId: row.orgId,
    partnerId: row.partnerId,
    name: row.name,
    description: row.description,
    source: row.source,
    isBuiltin: row.isBuiltin,
    enabled: row.enabled,
    autoQuarantine: row.autoQuarantine,
    currentVersion: row.currentVersion,
    publishedVersion: row.publishedVersion,
    publishedSha256: row.publishedSha256,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedEngine: row.publishedEngine,
    stale: row.stale,
    ruleCount: row.ruleCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function publishBody(result: PublishRuleSetResult) {
  return {
    published: result.published,
    version: result.version,
    currentVersion: result.currentVersion,
    stale: result.stale,
    errors: result.errors,
    ...(result.unavailable ? { precheckUnavailable: true } : {}),
  };
}

function auditOwner(set: Pick<YaraRuleSet, 'orgId' | 'partnerId'>) {
  return { orgId: set.orgId, partnerId: set.partnerId };
}

// ---------------------------------------------------------------------------
// Rule sets
// ---------------------------------------------------------------------------

yaraRoutes.get(
  '/yara/rule-sets',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  async (c) => {
    const auth = c.get('auth');
    const access = ruleSetAccessCondition(auth);
    const rows = await db
      .select()
      .from(yaraRuleSets)
      .where(access)
      .orderBy(desc(yaraRuleSets.isBuiltin), asc(yaraRuleSets.name));
    return c.json({ data: rows.map(summarize) });
  },
);

yaraRoutes.post(
  '/yara/rule-sets',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('json', createYaraRuleSetSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    if (!canMutateOrgWideGovernance(auth)) {
      return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    }
    if (payload.autoQuarantine === true && !mayEnableAutoQuarantine(c)) {
      return c.json({ error: AUTO_QUARANTINE_EXECUTE_REQUIRED, code: 'AUTO_QUARANTINE_EXECUTE_REQUIRED' }, 403);
    }

    let owner: { orgId: string | null; partnerId: string | null };
    if (payload.ownerScope === 'partner') {
      if (!auth.partnerId) {
        return c.json({ error: 'Partner-wide rule sets require partner scope' }, 403);
      }
      if (!canManagePartnerWidePolicies(auth)) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      owner = { orgId: null, partnerId: auth.partnerId };
    } else {
      const orgId = payload.orgId ?? getPolicyOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required to create an organization rule set' }, 400);
      }
      if (!auth.canAccessOrg(orgId)) {
        return c.json({ error: 'Access denied' }, 403);
      }
      owner = { orgId, partnerId: null };
    }

    // Created unpublished (published_version 0): the resolver reports it as
    // `not_published` until its first rule is added, so attaching an empty
    // set never turns a policy's scans into zero-rule YARA scans.
    const [created] = await db
      .insert(yaraRuleSets)
      .values({
        ...owner,
        name: payload.name,
        description: payload.description ?? null,
        source: 'custom',
        enabled: payload.enabled ?? true,
        autoQuarantine: payload.autoQuarantine ?? false,
        createdBy: auth.user.id,
      })
      .returning();
    if (!created) {
      return c.json({ error: 'Failed to create rule set' }, 500);
    }

    writeRouteAudit(c, {
      ...auditOwner(created),
      action: 'security.yara_rule_set.create',
      resourceType: 'yara_rule_set',
      resourceId: created.id,
      resourceName: created.name,
      details: { ownerScope: payload.ownerScope, autoQuarantine: created.autoQuarantine },
    });

    return c.json({ data: summarize(created) }, 201);
  },
);

yaraRoutes.get(
  '/yara/rule-sets/:id',
  requireScope('organization', 'partner', 'system'),
  requireSecurityReadAccess,
  zValidator('param', yaraRuleSetIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const set = await loadVisibleSet(auth, id);
    if (!set) return c.json({ error: 'Rule set not found' }, 404);

    const rules = await db
      .select({
        id: yaraRules.id,
        name: yaraRules.name,
        source: yaraRules.source,
        severity: yaraRules.severity,
        tags: yaraRules.tags,
        enabled: yaraRules.enabled,
        compileError: yaraRules.compileError,
        createdAt: yaraRules.createdAt,
        updatedAt: yaraRules.updatedAt,
      })
      .from(yaraRules)
      .where(eq(yaraRules.ruleSetId, set.id))
      .orderBy(asc(yaraRules.name));

    return c.json({
      data: {
        ...summarize(set),
        rules: rules.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      },
    });
  },
);

yaraRoutes.patch(
  '/yara/rule-sets/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleSetIdParamSchema),
  zValidator('json', updateYaraRuleSetSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const set = await loadVisibleSet(auth, id);
    if (!set) return c.json({ error: 'Rule set not found' }, 404);
    const denial = writeDenial(auth, set);
    if (denial) return c.json({ error: denial }, 403);
    if (payload.autoQuarantine === true && !set.autoQuarantine && !mayEnableAutoQuarantine(c)) {
      return c.json({ error: AUTO_QUARANTINE_EXECUTE_REQUIRED, code: 'AUTO_QUARANTINE_EXECUTE_REQUIRED' }, 403);
    }

    const changes: Partial<typeof yaraRuleSets.$inferInsert> = {};
    if (payload.name !== undefined) changes.name = payload.name;
    if (payload.description !== undefined) changes.description = payload.description;
    if (payload.enabled !== undefined) changes.enabled = payload.enabled;
    if (payload.autoQuarantine !== undefined) changes.autoQuarantine = payload.autoQuarantine;
    if (Object.keys(changes).length === 0) {
      return c.json({ data: summarize(set) });
    }
    changes.updatedAt = new Date();

    await db.update(yaraRuleSets).set(changes).where(eq(yaraRuleSets.id, id));

    // autoQuarantine is part of the bundle; an enable/disable is republished
    // so the version agents see moves with it. Never-published sets stay
    // unpublished until they have a rule.
    const bundleAffecting =
      (payload.autoQuarantine !== undefined && payload.autoQuarantine !== set.autoQuarantine)
      || (payload.enabled !== undefined && payload.enabled !== set.enabled);
    const publish = bundleAffecting && set.currentVersion > 0 ? await publishRuleSet(id) : null;

    const updated = await loadVisibleSet(auth, id);
    writeRouteAudit(c, {
      ...auditOwner(set),
      action: 'security.yara_rule_set.update',
      resourceType: 'yara_rule_set',
      resourceId: id,
      resourceName: updated?.name ?? set.name,
      details: { fields: Object.keys(payload), ...(publish ? { published: publish.published, version: publish.version } : {}) },
    });

    return c.json({ data: updated ? summarize(updated) : null, ...(publish ? { publish: publishBody(publish) } : {}) });
  },
);

yaraRoutes.delete(
  '/yara/rule-sets/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleSetIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const set = await loadVisibleSet(auth, id);
    if (!set) return c.json({ error: 'Rule set not found' }, 404);
    const denial = writeDenial(auth, set);
    if (denial) return c.json({ error: denial }, 403);

    // Rules go with it (ON DELETE CASCADE). Policies that still list the id
    // resolve it as `not_found` at dispatch and record that on the scan.
    const deleted = await db.delete(yaraRuleSets).where(eq(yaraRuleSets.id, id)).returning({ id: yaraRuleSets.id });
    if (deleted.length === 0) return c.json({ error: 'Rule set not found' }, 404);

    writeRouteAudit(c, {
      ...auditOwner(set),
      action: 'security.yara_rule_set.delete',
      resourceType: 'yara_rule_set',
      resourceId: id,
      resourceName: set.name,
    });
    return c.json({ success: true });
  },
);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

yaraRoutes.post(
  '/yara/rule-sets/:id/rules',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleSetIdParamSchema),
  zValidator('json', createYaraRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const set = await loadVisibleSet(auth, id);
    if (!set) return c.json({ error: 'Rule set not found' }, 404);
    const denial = writeDenial(auth, set);
    if (denial) return c.json({ error: denial }, 403);

    const [{ value: existing } = { value: 0 }] = await db
      .select({ value: count() })
      .from(yaraRules)
      .where(eq(yaraRules.ruleSetId, id));
    if (existing >= YARA_MAX_RULES_PER_SET) {
      return c.json({ error: `A rule set holds at most ${YARA_MAX_RULES_PER_SET} rules` }, 400);
    }

    let ruleId: string;
    try {
      // Savepoint: a duplicate name must not poison the request transaction.
      const [row] = await withDbTransaction(() =>
        db
          .insert(yaraRules)
          .values({
            ruleSetId: id,
            name: payload.name,
            source: payload.source,
            severity: payload.severity ?? 'high',
            tags: payload.tags ?? [],
            enabled: payload.enabled ?? true,
          })
          .returning({ id: yaraRules.id }),
      );
      if (!row) return c.json({ error: 'Failed to create rule' }, 500);
      ruleId = row.id;
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        return c.json({ error: `A rule named "${payload.name}" already exists in this set` }, 409);
      }
      throw err;
    }

    const publish = await publishRuleSet(id);
    writeRouteAudit(c, {
      ...auditOwner(set),
      action: 'security.yara_rule.create',
      resourceType: 'yara_rule',
      resourceId: ruleId,
      resourceName: payload.name,
      details: { ruleSetId: id, published: publish.published, version: publish.version, stale: publish.stale },
    });
    return c.json({ data: { id: ruleId }, publish: publishBody(publish) }, 201);
  },
);

async function loadRuleWithSet(auth: AuthContext, ruleId: string) {
  const [rule] = await db
    .select({ id: yaraRules.id, ruleSetId: yaraRules.ruleSetId, name: yaraRules.name })
    .from(yaraRules)
    .where(eq(yaraRules.id, ruleId))
    .limit(1);
  if (!rule) return null;
  const set = await loadVisibleSet(auth, rule.ruleSetId);
  return set ? { rule, set } : null;
}

yaraRoutes.patch(
  '/yara/rules/:ruleId',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleIdParamSchema),
  zValidator('json', updateYaraRuleSchema),
  async (c) => {
    const auth = c.get('auth');
    const { ruleId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const found = await loadRuleWithSet(auth, ruleId);
    if (!found) return c.json({ error: 'Rule not found' }, 404);
    const denial = writeDenial(auth, found.set);
    if (denial) return c.json({ error: denial }, 403);

    const changes: Partial<typeof yaraRules.$inferInsert> = {};
    if (payload.name !== undefined) changes.name = payload.name;
    if (payload.source !== undefined) changes.source = payload.source;
    if (payload.severity !== undefined) changes.severity = payload.severity;
    if (payload.tags !== undefined) changes.tags = payload.tags;
    if (payload.enabled !== undefined) changes.enabled = payload.enabled;
    if (Object.keys(changes).length === 0) {
      return c.json({ error: 'No changes' }, 400);
    }
    changes.updatedAt = new Date();

    try {
      await withDbTransaction(() => db.update(yaraRules).set(changes).where(eq(yaraRules.id, ruleId)));
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        return c.json({ error: `A rule named "${payload.name}" already exists in this set` }, 409);
      }
      throw err;
    }

    const publish = await publishRuleSet(found.set.id);
    writeRouteAudit(c, {
      ...auditOwner(found.set),
      action: 'security.yara_rule.update',
      resourceType: 'yara_rule',
      resourceId: ruleId,
      resourceName: payload.name ?? found.rule.name,
      details: {
        ruleSetId: found.set.id,
        fields: Object.keys(payload),
        published: publish.published,
        version: publish.version,
        stale: publish.stale,
      },
    });
    return c.json({ data: { id: ruleId }, publish: publishBody(publish) });
  },
);

yaraRoutes.delete(
  '/yara/rules/:ruleId',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { ruleId } = c.req.valid('param');

    const found = await loadRuleWithSet(auth, ruleId);
    if (!found) return c.json({ error: 'Rule not found' }, 404);
    const denial = writeDenial(auth, found.set);
    if (denial) return c.json({ error: denial }, 403);

    await db.delete(yaraRules).where(eq(yaraRules.id, ruleId));
    const publish = await publishRuleSet(found.set.id);
    writeRouteAudit(c, {
      ...auditOwner(found.set),
      action: 'security.yara_rule.delete',
      resourceType: 'yara_rule',
      resourceId: ruleId,
      resourceName: found.rule.name,
      details: { ruleSetId: found.set.id, published: publish.published, version: publish.version, stale: publish.stale },
    });
    return c.json({ success: true, publish: publishBody(publish) });
  },
);
