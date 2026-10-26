/**
 * `manage_pam_rules` (full-control W11, #6781; the #6141 PAM-rules gap): the AI
 * twin of the PAM rule, org-config and signer-group routes in routes/pam.ts.
 * Validation, the rule row builders and the rule-removal cleanup are the
 * route's own (services/pamPolicySchemas.ts, services/pamPolicyAdmin.ts).
 *
 * W11-D3 — the tool can never widen auto-approval:
 *  (a) `auto_approve` is not in the tool's verdict enum and `reapprove` is not
 *      an input, so the tool never writes an auto-approving rule;
 *  (b) the first enabled matching rule wins, so in an organization that has any
 *      rule whose `verdict` or `suspendedVerdict` is `auto_approve`, the tool
 *      may only add rules, rename / re-describe, and disable or delete a rule
 *      that itself auto-approves. Every other rule change and every signer-group
 *      membership change there could let a request fall through to an
 *      auto-approving rule, so it is refused ("edit it in PAM settings");
 *  (c) that check runs inside the write's transaction, with the target row
 *      locked FOR UPDATE and the org's auto-approve rules read FOR SHARE.
 * Every write is supervised (guardrails), MFA-gated (`MFA_GATED_TOOL_ACTIONS`)
 * and the whole tool is `AGENT_HUMAN_ONLY_TOOLS`. Stricter than REST: a session
 * bound to specific devices gets nothing, and a rule may reference only a signer
 * group of its own organization.
 */
import { and, asc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { pamOrgConfig, pamRules, pamSignerGroups } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { isAutomationPrincipal } from '../middleware/principalKind';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { resolveWritableToolOrgId } from './aiToolWriteOrg';
import { siteAllowlistOf } from './aiToolsSiteScope';
import { isHoldingOrg } from './unassignedPool/protectedOrg';
import { PROTECTED_ORG_ERROR } from './unassignedPool/orgType';
import { describePamRuleTierDrift } from './pamRuleTierDrift';
import { cleanupPamRuleActuations, pamRuleInsertValues, pamRuleUpdateSet, tierDriftResponse, type PamTx } from './pamPolicyAdmin';
import {
  createRuleSchema, createSignerGroupSchema, updateConfigSchema, updateRuleSchema, updateSignerGroupSchema, validateRuleShape,
} from './pamPolicySchemas';
import { parseData } from './aiToolsTicketOpsShared';
import { PAM_RULE_ACTIONS, PAM_TOOL_VERDICTS } from './aiToolSchemasSecurityPolicy';
import {
  auditToolWrite, bounded, defined, deviceBoundDenied, json, jsonError, notFound, orgWideWriteDenied, requireFields, str, thrown,
} from './aiToolsSecurityPolicyShared';

type Action = (typeof PAM_RULE_ACTIONS)[number];
const TOOL = 'manage_pam_rules';
const LIST_CAP = 500;
const RULE_FIELDS = [
  'siteId', 'name', 'description', 'enabled', 'priority', 'verdict', 'approvalDurationMinutes',
  'matchSigner', 'matchSignerThumbprint', 'matchSignerGroupId', 'matchHash', 'matchPathGlob', 'matchParentImage',
  'matchCommandLine', 'matchUser', 'matchAdGroup', 'matchToolName', 'matchRiskTier', 'matchNegate', 'timeWindow',
] as const;
const COSMETIC = new Set(['name', 'description']);
const EDIT_IN_SETTINGS = 'This organization has an auto-approve PAM rule, so this change could let an elevation fall through to it. Edit it in PAM settings in the Breeze web app.';

const pickRule = (input: Record<string, unknown>) => defined(Object.fromEntries(RULE_FIELDS.map((k) => [k, input[k]])));

/**
 * W11-D3 (b): may this rule change be made without widening auto-approval?
 * `otherAutoApprove` = the org has another rule whose verdict or suspended
 * verdict is `auto_approve`. Pure, so the whole decision table is unit-tested.
 *  - delete: only an auto-approving rule itself (removing it never widens the
 *    auto-approved set), or any rule when nothing else in the org auto-approves;
 *  - an auto-approving rule: rename / re-describe, or exactly `{ enabled: false }`;
 *  - a quarantined one (`suspendedVerdict` auto_approve, a latent auto-approver):
 *    rename / re-describe, or disable when nothing else auto-approves;
 *  - any other rule: rename / re-describe, or anything when nothing else auto-approves.
 */
export function pamRuleChangeAllowed(p: {
  action: 'update_rule' | 'delete_rule';
  existing: { verdict: string; suspendedVerdict: string | null };
  otherAutoApprove: boolean;
  changed: readonly string[];
  enabledValue?: unknown;
}): boolean {
  if (p.action === 'delete_rule') return p.existing.verdict === 'auto_approve' || !p.otherAutoApprove;
  const cosmetic = p.changed.length > 0 && p.changed.every((k) => COSMETIC.has(k));
  const pureDisable = p.changed.length === 1 && p.changed[0] === 'enabled' && p.enabledValue === false;
  if (p.existing.verdict === 'auto_approve') return cosmetic || pureDisable;
  if (p.existing.suspendedVerdict === 'auto_approve') return cosmetic || (pureDisable && !p.otherAutoApprove);
  return cosmetic || !p.otherAutoApprove;
}

function projectRule(row: typeof pamRules.$inferSelect) {
  const drift = describePamRuleTierDrift(row);
  return {
    id: row.id, orgId: row.orgId, siteId: row.siteId, name: row.name, description: row.description, enabled: row.enabled,
    priority: row.priority, verdict: row.verdict, suspendedVerdict: row.suspendedVerdict, approvalDurationMinutes: row.approvalDurationMinutes,
    matchSigner: row.matchSigner, matchSignerThumbprint: row.matchSignerThumbprint, matchSignerGroupId: row.matchSignerGroupId,
    matchHash: row.matchHash, matchPathGlob: row.matchPathGlob, matchParentImage: row.matchParentImage, matchCommandLine: row.matchCommandLine,
    matchUser: row.matchUser, matchAdGroup: row.matchAdGroup, matchToolName: row.matchToolName, matchRiskTier: row.matchRiskTier,
    matchNegate: row.matchNegate, timeWindow: row.timeWindow, matchRiskTierStale: drift != null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function projectGroup(row: typeof pamSignerGroups.$inferSelect) {
  return { id: row.id, orgId: row.orgId, name: row.name, description: row.description, signers: row.signers, updatedAt: row.updatedAt.toISOString() };
}

/** Site gate of the rule handlers: a site-restricted caller reaches only rules of its sites (never an org-wide one). */
function ruleSiteDenied(auth: AuthContext, siteId: string | null | undefined): boolean {
  const allowed = siteAllowlistOf(auth);
  return allowed !== undefined && !(typeof siteId === 'string' && allowed.includes(siteId));
}

async function otherAutoApproveRule(tx: PamTx, orgId: string, exceptRuleId?: string): Promise<boolean> {
  const conditions: SQL[] = [
    eq(pamRules.orgId, orgId),
    or(eq(pamRules.verdict, 'auto_approve'), eq(pamRules.suspendedVerdict, 'auto_approve'))!,
  ];
  if (exceptRuleId) conditions.push(ne(pamRules.id, exceptRuleId));
  const rows = await tx.select({ id: pamRules.id }).from(pamRules).where(and(...conditions)).limit(1).for('share');
  return rows.length > 0;
}

async function signerGroupInOrg(tx: PamTx | typeof db, groupId: string, orgId: string): Promise<boolean> {
  const rows = await tx.select({ id: pamSignerGroups.id }).from(pamSignerGroups)
    .where(and(eq(pamSignerGroups.id, groupId), eq(pamSignerGroups.orgId, orgId))).limit(1);
  return rows.length > 0;
}

async function writeOrg(auth: AuthContext, orgId: string | undefined, forRead = false): Promise<string | { orgId: string }> {
  const resolved = resolveWritableToolOrgId(auth, orgId, { useWriteDefault: !forRead });
  if (!resolved.orgId) return jsonError(resolved.error ?? 'orgId is required', 'VALIDATION_ERROR');
  if (await isHoldingOrg(resolved.orgId)) return jsonError(PROTECTED_ORG_ERROR.error, PROTECTED_ORG_ERROR.code);
  return { orgId: resolved.orgId };
}

class Refusal extends Error {
  constructor(readonly result: string) { super('refused'); }
}

export function registerPamRuleTools(aiTools: Map<string, AiTool>): void {
  const verdictDescription = "create_rule / update_rule: require_approval, auto_deny or ignore (auto-approve rules are authored in the web app only)";
  aiTools.set(TOOL, {
    tier: 1,
    domain: 'security',
    searchHint: 'PAM elevation rules, org default verdict and trusted signer groups (who gets local admin, and when)',
    deviceArgs: [],
    definition: {
      name: 'manage_pam_rules',
      description:
        'PAM (privileged access) rules, the org default verdict and signer groups. Reads: list_rules, get_config, list_signer_groups. Writes need approval and never create auto-approval; in an org with an auto-approve rule only additive or cosmetic changes are allowed.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...PAM_RULE_ACTIONS], description: 'The action to perform' },
          orgId: { type: 'string', description: 'Organization UUID (required to write when you can reach several)' },
          ruleId: { type: 'string', description: 'update_rule / delete_rule: rule UUID' },
          signerGroupId: { type: 'string', description: 'update_signer_group / delete_signer_group: group UUID' },
          name: { type: 'string', description: 'Rule or signer group name (max 255)' },
          description: { type: 'string', description: 'Rule or signer group description (max 2000)' },
          enabled: { type: 'boolean', description: 'Rule enabled (disabling revokes elevations it granted)' },
          priority: { type: 'number', description: 'Rule priority, lower runs first (0-100000, default 100)' },
          verdict: { type: 'string', enum: [...PAM_TOOL_VERDICTS], description: verdictDescription },
          approvalDurationMinutes: { type: 'number', description: 'Rule: elevation length in minutes (1-1440)' },
          siteId: { type: 'string', description: 'Rule: limit to one site UUID (omit for every site)' },
          matchSigner: { type: 'string', description: 'Rule: code-signer subject CN' },
          matchSignerThumbprint: { type: 'string', description: 'Rule: signer certificate SHA-256 thumbprint' },
          matchSignerGroupId: { type: 'string', description: 'Rule: signer group UUID of the same organization' },
          matchHash: { type: 'string', description: 'Rule: executable SHA-256' },
          matchPathGlob: { type: 'string', description: 'Rule: executable path glob' },
          matchParentImage: { type: 'string', description: 'Rule: parent process image' },
          matchCommandLine: { type: 'string', description: 'Rule: command line pattern' },
          matchUser: { type: 'string', description: 'Rule: user name (exact)' },
          matchAdGroup: { type: 'string', description: 'Rule: AD group' },
          matchToolName: { type: 'string', description: 'Rule: Helper AI tool name (tool-action rules)' },
          matchRiskTier: { type: 'number', description: 'Rule: Helper tool risk tier 0-4 (tool-action rules)' },
          matchNegate: { type: 'array', items: { type: 'string' }, description: 'Rule: criteria to negate' },
          timeWindow: { type: 'object', description: 'Rule: { start "HH:MM", end "HH:MM", days [0-6], timezone }' },
          defaultUnmatchedVerdict: { type: 'string', enum: ['require_approval', 'auto_deny'], description: 'set_config: verdict when no rule matches' },
          signers: { type: 'array', items: {}, description: 'Signer group members: a subject CN string, or { subjectCn, thumbprint } (max 500)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!PAM_RULE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const bound = deviceBoundDenied(auth, 'PAM policy');
      if (bound) return bound;
      try {
        if (action === 'list_rules' || action === 'get_config' || action === 'list_signer_groups') return await reads(action, input, auth);
        const mfa = mfaGatedToolError(TOOL, action, auth);
        if (mfa) return mfa;
        if (isAutomationPrincipal(auth)) return jsonError('PAM policy is changed by a person, not an automated run', 'AGENT_REFUSED');
        return await writes(action, input, auth);
      } catch (error) {
        return thrown(TOOL, error);
      }
    },
  });
}

async function reads(action: Action, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const orgId = str(input.orgId);
  if (orgId && !auth.canAccessOrg(orgId)) return notFound('Organization');
  if (action === 'get_config') {
    const org = await writeOrg(auth, orgId, true);
    if (typeof org === 'string') return org;
    const [cfg] = await db.select().from(pamOrgConfig).where(eq(pamOrgConfig.orgId, org.orgId)).limit(1);
    return json({ orgId: org.orgId, defaultUnmatchedVerdict: cfg?.defaultUnmatchedVerdict ?? 'require_approval' });
  }
  if (action === 'list_signer_groups') {
    const conditions = [orgId ? eq(pamSignerGroups.orgId, orgId) : auth.orgCondition(pamSignerGroups.orgId)].filter((c): c is SQL => c !== undefined);
    const rows = await db.select().from(pamSignerGroups).where(conditions.length ? and(...conditions) : undefined).orderBy(asc(pamSignerGroups.name)).limit(LIST_CAP + 1);
    return bounded({ signerGroups: rows.slice(0, LIST_CAP).map(projectGroup), truncated: rows.length > LIST_CAP });
  }
  // list_rules: the route's site narrowing (a restricted caller sees only its sites' rules, never an org-wide one).
  const allowed = siteAllowlistOf(auth);
  const conditions = [
    orgId ? eq(pamRules.orgId, orgId) : auth.orgCondition(pamRules.orgId),
    allowed === undefined ? undefined : allowed.length === 0 ? sql`false` : inArray(pamRules.siteId, [...allowed]),
  ].filter((c): c is SQL => c !== undefined);
  const rows = await db.select().from(pamRules).where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(pamRules.priority), asc(pamRules.createdAt)).limit(LIST_CAP + 1);
  return bounded({
    rules: rows.slice(0, LIST_CAP).map(projectRule),
    truncated: rows.length > LIST_CAP,
    note: 'Rules are evaluated in priority order; the first enabled match decides. Auto-approve rules can only be authored in the Breeze web app.',
  });
}

async function writes(action: Action, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (action === 'create_rule') {
    const missing = requireFields(input, ['name', 'verdict'], action);
    if (missing) return missing;
    if (!(PAM_TOOL_VERDICTS as readonly unknown[]).includes(input.verdict)) return jsonError("verdict must be 'require_approval', 'auto_deny' or 'ignore'", 'VALIDATION_ERROR');
    const parsed = parseData(createRuleSchema, pickRule(input));
    if ('error' in parsed) return parsed.error;
    const payload = parsed.value;
    if (ruleSiteDenied(auth, payload.siteId)) return jsonError('Site access denied', 'ACCESS_DENIED');
    const org = await writeOrg(auth, str(input.orgId));
    if (typeof org === 'string') return org;
    const drift = tierDriftResponse(payload);
    if (drift) return jsonError(drift.error, drift.code);
    if (payload.matchSignerGroupId && !(await signerGroupInOrg(db, payload.matchSignerGroupId, org.orgId))) return notFound('Signer group');
    const [created] = await db.insert(pamRules).values(pamRuleInsertValues(payload, org.orgId, auth.user.id)).returning();
    if (!created) return jsonError('Rule insert returned no row');
    auditToolWrite(auth, { orgId: org.orgId, action: 'pam.rule.create', resourceType: 'pam_rule', resourceId: created.id, resourceName: created.name, details: { verdict: created.verdict, priority: created.priority } });
    return json({ created: true, rule: projectRule(created) });
  }

  if (action === 'update_rule' || action === 'delete_rule') {
    const missing = requireFields(input, ['ruleId'], action);
    if (missing) return missing;
    if (action === 'update_rule' && input.verdict !== undefined && !(PAM_TOOL_VERDICTS as readonly unknown[]).includes(input.verdict)) {
      return jsonError("verdict must be 'require_approval', 'auto_deny' or 'ignore'", 'VALIDATION_ERROR');
    }
    const parsed = action === 'update_rule' ? parseData(updateRuleSchema, pickRule(input)) : { value: {} as Record<string, never> };
    if ('error' in parsed) return parsed.error;
    const payload = parsed.value;
    const changed = Object.keys(payload);
    if (action === 'update_rule' && changed.length === 0) return jsonError('Nothing to update', 'VALIDATION_ERROR');
    const ruleId = String(input.ruleId);
    try {
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(pamRules).where(eq(pamRules.id, ruleId)).limit(1).for('update');
        if (!existing || !auth.canAccessOrg(existing.orgId)) throw new Refusal(notFound('PAM rule'));
        if (ruleSiteDenied(auth, existing.siteId)) throw new Refusal(notFound('PAM rule'));
        const otherAutoApprove = await otherAutoApproveRule(tx, existing.orgId, existing.id);
        const allowed = pamRuleChangeAllowed({
          action, existing, otherAutoApprove, changed, enabledValue: (payload as { enabled?: unknown }).enabled,
        });
        if (!allowed) throw new Refusal(jsonError(EDIT_IN_SETTINGS, 'PAM_AUTO_APPROVE_GUARD'));

        if (action === 'delete_rule') {
          await cleanupPamRuleActuations(tx, { ruleId: existing.id, orgId: existing.orgId });
          await tx.delete(pamRules).where(eq(pamRules.id, existing.id));
          return { deleted: true as const, existing };
        }
        const update = payload as typeof payload & { siteId?: string | null; matchSignerGroupId?: string | null; enabled?: boolean };
        if (update.siteId !== undefined && ruleSiteDenied(auth, update.siteId)) throw new Refusal(jsonError('Site access denied', 'ACCESS_DENIED'));
        const merged = { ...existing, ...update };
        const shape = validateRuleShape(merged);
        if (shape) throw new Refusal(jsonError(shape, 'VALIDATION_ERROR'));
        const drift = tierDriftResponse(merged);
        if (drift) throw new Refusal(jsonError(drift.error, drift.code));
        if (update.matchSignerGroupId && !(await signerGroupInOrg(tx, update.matchSignerGroupId, existing.orgId))) throw new Refusal(notFound('Signer group'));
        const [row] = await tx.update(pamRules).set(pamRuleUpdateSet(update, existing, auth.user.id)).where(eq(pamRules.id, existing.id)).returning();
        if (update.enabled === false && existing.enabled) await cleanupPamRuleActuations(tx, { ruleId: existing.id, orgId: existing.orgId });
        return { deleted: false as const, existing, row };
      });
      auditToolWrite(auth, {
        orgId: result.existing.orgId, action: result.deleted ? 'pam.rule.delete' : 'pam.rule.update', resourceType: 'pam_rule',
        resourceId: result.existing.id, resourceName: result.existing.name, details: result.deleted ? {} : { changed },
      });
      return result.deleted ? json({ deleted: true, ruleId: result.existing.id }) : json({ updated: true, rule: result.row ? projectRule(result.row) : null });
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      throw error;
    }
  }

  // Org config and signer groups are org-wide governance (route: canMutateOrgWideGovernance).
  const denied = orgWideWriteDenied(auth, 'PAM configuration');
  if (denied) return denied;

  if (action === 'set_config') {
    const parsed = parseData(updateConfigSchema, defined({ defaultUnmatchedVerdict: input.defaultUnmatchedVerdict }));
    if ('error' in parsed) return parsed.error;
    const org = await writeOrg(auth, str(input.orgId));
    if (typeof org === 'string') return org;
    const verdict = parsed.value.defaultUnmatchedVerdict;
    const [saved] = await db.insert(pamOrgConfig)
      .values({
        orgId: org.orgId,
        defaultUnmatchedVerdict: verdict,
        updatedByUserId: auth.user.id,
      })
      .onConflictDoUpdate({
        target: pamOrgConfig.orgId,
        set: {
          defaultUnmatchedVerdict: verdict,
          updatedByUserId: auth.user.id,
          updatedAt: new Date(),
        },
      })
      .returning();
    auditToolWrite(auth, { orgId: org.orgId, action: 'pam.config.update', resourceType: 'pam_org_config', resourceId: saved?.id, details: { defaultUnmatchedVerdict: verdict } });
    return json({ updated: true, orgId: org.orgId, defaultUnmatchedVerdict: verdict });
  }

  if (action === 'create_signer_group') {
    const missing = requireFields(input, ['name'], action);
    if (missing) return missing;
    const parsed = parseData(createSignerGroupSchema, defined({ name: input.name, description: input.description, signers: input.signers }));
    if ('error' in parsed) return parsed.error;
    const org = await writeOrg(auth, str(input.orgId));
    if (typeof org === 'string') return org;
    const [created] = await db.insert(pamSignerGroups).values({
      orgId: org.orgId, name: parsed.value.name, description: parsed.value.description ?? null,
      signers: parsed.value.signers ?? [],
      createdByUserId: auth.user.id,
    }).returning();
    if (!created) return jsonError('Signer group insert returned no row');
    auditToolWrite(auth, { orgId: org.orgId, action: 'pam.signer_group.create', resourceType: 'pam_signer_group', resourceId: created.id, resourceName: created.name, details: { signerCount: created.signers.length } });
    return json({ created: true, signerGroup: projectGroup(created) });
  }

  const missing = requireFields(input, ['signerGroupId'], action);
  if (missing) return missing;
  const groupId = String(input.signerGroupId);

  if (action === 'update_signer_group') {
    const parsed = parseData(updateSignerGroupSchema, defined({ name: input.name, description: input.description, signers: input.signers }));
    if ('error' in parsed) return parsed.error;
    const patch = parsed.value;
    if (Object.keys(patch).length === 0) return jsonError('Nothing to update', 'VALIDATION_ERROR');
    try {
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(pamSignerGroups).where(eq(pamSignerGroups.id, groupId)).limit(1).for('update');
        if (!existing || !auth.canAccessOrg(existing.orgId)) throw new Refusal(notFound('Signer group'));
        // A membership change re-scopes every rule that references the group (W11-D3 b).
        if (patch.signers !== undefined && (await otherAutoApproveRule(tx, existing.orgId))) {
          throw new Refusal(jsonError(EDIT_IN_SETTINGS, 'PAM_AUTO_APPROVE_GUARD'));
        }
        const [row] = await tx.update(pamSignerGroups).set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.signers !== undefined ? { signers: patch.signers } : {}),
          updatedAt: new Date(),
        }).where(eq(pamSignerGroups.id, existing.id)).returning();
        return { existing, row };
      });
      auditToolWrite(auth, { orgId: result.existing.orgId, action: 'pam.signer_group.update', resourceType: 'pam_signer_group', resourceId: result.existing.id, resourceName: result.existing.name, details: { changed: Object.keys(patch) } });
      return json({ updated: true, signerGroup: result.row ? projectGroup(result.row) : null });
    } catch (error) {
      if (error instanceof Refusal) return error.result;
      throw error;
    }
  }

  // delete_signer_group: refused while any rule references it (route parity), so matching never changes.
  const [existing] = await db.select().from(pamSignerGroups).where(eq(pamSignerGroups.id, groupId)).limit(1);
  if (!existing || !auth.canAccessOrg(existing.orgId)) return notFound('Signer group');
  const [{ refs } = { refs: 0 }] = await db.select({ refs: sql<number>`count(*)::int` }).from(pamRules).where(eq(pamRules.matchSignerGroupId, existing.id));
  if (refs > 0) return jsonError(`Signer group is used by ${refs} rule(s); remove those references first`, 'IN_USE');
  await db.delete(pamSignerGroups).where(eq(pamSignerGroups.id, existing.id));
  auditToolWrite(auth, { orgId: existing.orgId, action: 'pam.signer_group.delete', resourceType: 'pam_signer_group', resourceId: existing.id, resourceName: existing.name });
  return json({ deleted: true, signerGroupId: existing.id });
}
