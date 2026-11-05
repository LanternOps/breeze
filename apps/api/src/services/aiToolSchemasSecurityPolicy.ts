/**
 * Input schemas for the W11 security-policy tools (full-control W11, #6781):
 * `get_security_compliance`, `manage_security_recommendations`,
 * `manage_access_reviews`, `manage_audit_baselines`,
 * `manage_compliance_policies`, `manage_security_policies`,
 * `manage_recovery_keys`, `manage_pam_rules`.
 *
 * Plain strict `z.object`s with an `action` enum where the tool multiplexes (no
 * unions or refinements) so `toolActionEnum` can read `.shape.action.options`
 * and the chat SDK `tool()` declarations can take `.shape` directly. Per-action
 * required fields are validated in the handlers. No `z.undefined()` anywhere:
 * it empties the model's tool list.
 *
 * Three human-only actions are deliberately ABSENT from every enum here, not
 * merely refused: access-review `complete` (revokes members), audit-baseline
 * apply-request `decision` (an approval) and recovery-key `reveal` (plaintext
 * key). PAM's `auto_approve` verdict and `reapprove` are absent too (W11-D3).
 * aiToolSchemas.securityPolicy.test.ts pins all of it, and keeps the keys and
 * enums equal to each tool's registry `input_schema`.
 */
import { z } from 'zod';
import { pageZodShape } from './aiToolPagination';
import { ruleCriteriaValidators, MAX_APPROVAL_DURATION_MINUTES } from './pamPolicySchemas';

export const SECURITY_COMPLIANCE_VIEWS = [
  'dashboard', 'score_breakdown', 'trends', 'status', 'firewall', 'encryption', 'password_policy', 'admin_audit',
] as const;
/** Per-view filter values (the handler checks each value belongs to the requested view). */
export const SECURITY_COMPLIANCE_FILTERS = {
  status: ['protected', 'at_risk', 'unprotected', 'offline'],
  firewall: ['enabled', 'disabled'],
  encryption: ['encrypted', 'partial', 'unencrypted'],
  password_policy: ['compliant', 'non_compliant'],
  admin_audit: ['default_account', 'weak_password', 'stale_account', 'no_issues'],
} as const;
const ALL_COMPLIANCE_FILTERS = [...new Set(Object.values(SECURITY_COMPLIANCE_FILTERS).flat())] as [string, ...string[]];

export const SECURITY_RECOMMENDATION_ACTIONS = ['list', 'complete', 'dismiss'] as const;
export const ACCESS_REVIEW_ACTIONS = ['list', 'get', 'create', 'decide_item'] as const;
export const ACCESS_REVIEW_DECISIONS = ['approved', 'revoked', 'pending'] as const;
export const AUDIT_BASELINE_ACTIONS = ['list', 'create', 'compliance', 'device_results', 'request_apply'] as const;
export const COMPLIANCE_POLICY_ACTIONS = ['deactivate'] as const;
export const POLICY_OWNER_SCOPES = ['organization', 'partner'] as const;
export const SECURITY_POLICY_ACTIONS = ['list', 'create', 'update'] as const;
export const RECOVERY_KEY_ACTIONS = ['list', 'rotate', 'collect'] as const;
export const PAM_RULE_ACTIONS = [
  'list_rules', 'create_rule', 'update_rule', 'delete_rule',
  'get_config', 'set_config',
  'list_signer_groups', 'create_signer_group', 'update_signer_group', 'delete_signer_group',
] as const;
/** W11-D3: `auto_approve` is human-only; the tool can never write it. */
export const PAM_TOOL_VERDICTS = ['require_approval', 'auto_deny', 'ignore'] as const;

const OS_TYPES = ['windows', 'macos', 'linux'] as const;
const SCAN_SCHEDULES = ['daily', 'weekly', 'monthly', 'manual'] as const;
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

const uuid = z.string().guid();

/** One signer-group entry: a bare subject CN (weak tier) or a pinned thumbprint and/or CN (strong tier). */
const signerEntry = z.union([
  z.string().trim().min(1).max(255),
  z.object({
    subjectCn: z.string().trim().min(1).max(255).optional(),
    thumbprint: z.string().trim().regex(/^[0-9a-fA-F]{64}$/).optional(),
  }).strict(),
]);

export const securityPolicyToolShapes = {
  get_security_compliance: {
    view: z.enum(SECURITY_COMPLIANCE_VIEWS),
    orgId: uuid.optional(),
    deviceId: uuid.optional(),
    period: z.enum(['7d', '30d', '90d']).optional(),
    filter: z.enum(ALL_COMPLIANCE_FILTERS).optional(),
    os: z.enum(OS_TYPES).optional(),
    search: z.string().trim().max(200).optional(),
    ...pageZodShape(25, 100),
  },
  manage_security_recommendations: {
    action: z.enum(SECURITY_RECOMMENDATION_ACTIONS),
    recommendationId: z.string().trim().min(1).max(100).optional(),
    orgId: uuid.optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    category: z.string().trim().max(100).optional(),
    status: z.enum(['open', 'dismissed', 'completed']).optional(),
    ...pageZodShape(25, 100),
  },
  manage_access_reviews: {
    action: z.enum(ACCESS_REVIEW_ACTIONS),
    reviewId: uuid.optional(),
    itemId: uuid.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    dueDate: z.string().datetime().optional(),
    reviewerId: uuid.optional(),
    decision: z.enum(ACCESS_REVIEW_DECISIONS).optional(),
    notes: z.string().max(2000).optional(),
    ...pageZodShape(50, 200),
  },
  manage_audit_baselines: {
    action: z.enum(AUDIT_BASELINE_ACTIONS),
    orgId: uuid.optional(),
    baselineId: uuid.optional(),
    deviceId: uuid.optional(),
    deviceIds: z.array(uuid).min(1).max(500).optional(),
    osType: z.enum(OS_TYPES).optional(),
    profile: z.enum(['cis_l1', 'cis_l2', 'custom']).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    settings: z.record(z.string().max(200), z.unknown()).optional(),
    isActive: z.boolean().optional(),
    expiresInMinutes: z.number().int().min(5).max(1440).optional(),
  },
  manage_compliance_policies: {
    action: z.enum(COMPLIANCE_POLICY_ACTIONS),
    policyId: uuid,
    ownerScope: z.enum(POLICY_OWNER_SCOPES),
  },
  manage_security_policies: {
    action: z.enum(SECURITY_POLICY_ACTIONS),
    policyId: uuid.optional(),
    orgId: uuid.optional(),
    ownerScope: z.enum(POLICY_OWNER_SCOPES).optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    providerId: z.string().trim().max(100).optional(),
    scanSchedule: z.enum(SCAN_SCHEDULES).optional(),
    realTimeProtection: z.boolean().optional(),
    autoQuarantine: z.boolean().optional(),
    severityThreshold: z.enum(SEVERITIES).optional(),
    exclusions: z.array(z.string().min(1).max(1024)).max(200).optional(),
    search: z.string().trim().max(200).optional(),
  },
  manage_recovery_keys: {
    action: z.enum(RECOVERY_KEY_ACTIONS),
    deviceId: uuid,
    volumeMount: z.string().regex(/^[A-Za-z]:$/).optional(),
  },
  manage_pam_rules: {
    action: z.enum(PAM_RULE_ACTIONS),
    orgId: uuid.optional(),
    ruleId: uuid.optional(),
    signerGroupId: uuid.optional(),
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(100000).optional(),
    verdict: z.enum(PAM_TOOL_VERDICTS).optional(),
    approvalDurationMinutes: z.number().int().min(1).max(MAX_APPROVAL_DURATION_MINUTES).nullable().optional(),
    ...ruleCriteriaValidators,
    defaultUnmatchedVerdict: z.enum(['require_approval', 'auto_deny']).optional(),
    signers: z.array(signerEntry).max(500).optional(),
  },
} as const;

export const securityPolicyToolSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(securityPolicyToolShapes).map(([name, shape]) => [name, z.object(shape).strict()]),
);
