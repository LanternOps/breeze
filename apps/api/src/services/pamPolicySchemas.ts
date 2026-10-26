/**
 * PAM policy administration schemas and shape validators: rules, org config
 * and signer groups. Pure (zod + table types only, no DB handle, no registry)
 * so the AI tool input schemas can import them without a cycle. Shared by the
 * REST control plane (routes/pam.ts) and the AI tool `manage_pam_rules`
 * (full-control W11, #6781); moved verbatim out of routes/pam.ts.
 */
import { z } from 'zod';

import { PAM_RULE_NEGATE_KEYS, type StoredSignerEntry } from '../db/schema';

export const MAX_APPROVAL_DURATION_MINUTES = 24 * 60;

export const ruleCriteriaFields = [
  'matchSigner',
  'matchSignerThumbprint',
  'matchSignerGroupId',
  'matchHash',
  'matchPathGlob',
  'matchParentImage',
  'matchCommandLine',
  'matchUser',
  'matchAdGroup',
] as const;

export const timeWindowSchema = z.object({
  start: z.string().regex(/^\d{1,2}:\d{2}$/),
  end: z.string().regex(/^\d{1,2}:\d{2}$/),
  days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  timezone: z.string().max(64).optional(),
});

// Criteria fields shared verbatim between ruleBaseSchema and previewRuleSchema.
// Spread into both z.object calls so any validator change applies to both.
export const ruleCriteriaValidators = {
  siteId: z.string().guid().nullable().optional(),
  matchSigner: z.string().min(1).max(255).nullable().optional(),
  matchSignerThumbprint: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be a sha256 hex thumbprint')
    .nullable()
    .optional(),
  matchSignerGroupId: z.string().guid().nullable().optional(),
  matchHash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be a sha256 hex digest')
    .nullable()
    .optional(),
  matchPathGlob: z.string().min(1).max(4096).nullable().optional(),
  matchParentImage: z.string().min(1).max(4096).nullable().optional(),
  matchCommandLine: z.string().min(1).max(4096).nullable().optional(),
  matchUser: z.string().min(1).max(255).nullable().optional(),
  matchAdGroup: z.string().min(1).max(255).nullable().optional(),
  matchToolName: z.string().min(1).max(100).nullable().optional(),
  matchRiskTier: z.number().int().min(0).max(4).nullable().optional(),
  matchNegate: z.array(z.enum(PAM_RULE_NEGATE_KEYS)).max(PAM_RULE_NEGATE_KEYS.length).nullable().optional(),
  timeWindow: timeWindowSchema.nullable().optional(),
};

export const ruleBaseSchema = z.object({
  orgId: z.string().guid().optional(),
  ...ruleCriteriaValidators,
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100000).optional(),
  verdict: z.enum(['auto_approve', 'auto_deny', 'require_approval', 'ignore']),
  approvalDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_APPROVAL_DURATION_MINUTES)
    .nullable()
    .optional(),
});

export type RuleCriteriaShape = {
  matchSigner?: string | null;
  matchSignerThumbprint?: string | null;
  matchSignerGroupId?: string | null;
  matchHash?: string | null;
  matchPathGlob?: string | null;
  matchParentImage?: string | null;
  matchCommandLine?: string | null;
  matchUser?: string | null;
  matchAdGroup?: string | null;
  matchToolName?: string | null;
  matchRiskTier?: number | null;
  verdict?: 'auto_approve' | 'auto_deny' | 'require_approval' | 'ignore';
};

// A rule must carry at least one identifying criterion. A rule scoped only
// by time window (or nothing) must never exist — it would match every
// elevation in the org (catastrophic for verdict=auto_approve).
export function hasAnyCriterion(rule: RuleCriteriaShape): boolean {
  return ruleCriteriaFields.some((f) => Boolean(rule[f])) || hasToolActionCriteria(rule);
}

// Binary-identifying criteria — what makes a rule executable-shaped (user/
// group/time only narrow; they don't identify a binary).
export const executableCriteriaFields = [
  'matchSigner',
  'matchSignerThumbprint',
  'matchSignerGroupId',
  'matchHash',
  'matchPathGlob',
  'matchParentImage',
  'matchCommandLine',
] as const;

export function hasToolActionCriteria(rule: RuleCriteriaShape): boolean {
  return Boolean(rule.matchToolName) || rule.matchRiskTier != null;
}

export function hasExecutableShapeCriteria(rule: RuleCriteriaShape): boolean {
  return executableCriteriaFields.some((f) => Boolean(rule[f]));
}

/**
 * A rule is either executable-shaped or tool-action-shaped (Phase 1 helper
 * governance) — mixing the two is rejected because no single candidate
 * carries both kinds of field, so a mixed rule could never match anything.
 * Returns an error string, or null when the rule shape is valid.
 */
export function validateRuleShape(rule: RuleCriteriaShape): string | null {
  if (!hasAnyCriterion(rule)) {
    return 'At least one match criterion (signer/hash/path/parent/user/group/tool/tier) is required';
  }
  if (hasExecutableShapeCriteria(rule) && hasToolActionCriteria(rule)) {
    return 'A rule cannot mix executable criteria with tool-action criteria';
  }
  if ((rule.matchSigner || rule.matchSignerThumbprint) && rule.matchSignerGroupId) {
    return 'A rule cannot combine matchSignerGroupId with matchSigner/matchSignerThumbprint — use a group or a direct signer match, not both';
  }
  if (hasToolActionCriteria(rule) && rule.verdict === 'ignore') {
    return "verdict 'ignore' is not valid for tool-action rules — a tool action must be decided";
  }
  return null;
}

export const createRuleSchema = ruleBaseSchema.superRefine((rule, ctx) => {
  const err = validateRuleShape(rule);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});

export const updateRuleSchema = ruleBaseSchema
  .partial()
  .omit({ orgId: true })
  .extend({
    // §6B re-approval: restores `verdict` from `suspended_verdict` (set by
    // the 2026-10-15-150200 migration's auto_approve quarantine) and clears
    // it. A body combining `reapprove: true` with an explicit `verdict` is
    // ambiguous intent and is rejected below rather than guessing which wins.
    reapprove: z.boolean().optional(),
  });

export const updateConfigSchema = z.object({
  orgId: z.string().guid().optional(),
  defaultUnmatchedVerdict: z.enum(['require_approval', 'auto_deny']),
});

// A signer-group entry is EITHER a bare subject-CN string (legacy / weak tier,
// stored as-is for backward-compatibility) OR an object pinning a SHA-256
// thumbprint (strong tier) and/or a CN (#1776). At least one field is required
// on the object form. Stored shape stays read-compatible with the legacy
// string[] — see normalizeSignerGroupEntries / StoredSignerEntry.
export const signerEntryObjectSchema = z
  .object({
    subjectCn: z.string().trim().min(1).max(255).optional(),
    thumbprint: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{64}$/, 'must be a sha256 hex thumbprint')
      .optional(),
  })
  .refine((e) => Boolean(e.subjectCn) || Boolean(e.thumbprint), {
    message: 'each signer entry needs a subjectCn or a thumbprint',
  });

export const signerListSchema = z
  .array(z.union([z.string().trim().min(1).max(255), signerEntryObjectSchema]))
  .max(500)
  // Normalize to the stored form (bare CN strings stay strings; pins become
  // objects with a lowercased thumbprint) and de-duplicate, preserving the
  // first spelling.
  .transform((arr) => {
    const seen = new Set<string>();
    const out: StoredSignerEntry[] = [];
    for (const el of arr) {
      if (typeof el === 'string') {
        const cn = el.trim();
        const key = `cn:${cn.toLowerCase()}`;
        if (cn && !seen.has(key)) {
          seen.add(key);
          out.push(cn);
        }
        continue;
      }
      const cn = el.subjectCn?.trim();
      const thumbprint = el.thumbprint?.trim().toLowerCase();
      const key = `obj:${cn?.toLowerCase() ?? ''}|${thumbprint ?? ''}`;
      if ((cn || thumbprint) && !seen.has(key)) {
        seen.add(key);
        const entry: { subjectCn?: string; thumbprint?: string } = {};
        if (cn) entry.subjectCn = cn;
        if (thumbprint) entry.thumbprint = thumbprint;
        out.push(entry);
      }
    }
    return out;
  });

export const createSignerGroupSchema = z.object({
  orgId: z.string().guid().optional(),
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  signers: signerListSchema.optional(),
});

export const updateSignerGroupSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  signers: signerListSchema.optional(),
});
