import { z } from 'zod';

export type AuthContext = {
  scope: string;
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg?: (orgId: string) => boolean;
  user: {
    id: string;
    email?: string;
  };
};

export const listPoliciesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  enabled: z.enum(['true', 'false']).optional(),
});

export const targetTypeSchema = z.enum(['all', 'sites', 'groups', 'tags', 'devices']);
export type TargetType = z.infer<typeof targetTypeSchema>;

export const versionOperatorSchema = z.enum(['any', 'exact', 'minimum', 'maximum']);

const requiredSoftwareRuleSchema = z.object({
  type: z.literal('required_software'),
  softwareName: z.string().trim().min(1),
  softwareVersion: z.string().trim().optional(),
  versionOperator: versionOperatorSchema.optional(),
});

const prohibitedSoftwareRuleSchema = z.object({
  type: z.literal('prohibited_software'),
  softwareName: z.string().trim().min(1),
});

const diskSpaceRuleSchema = z.object({
  type: z.literal('disk_space_minimum'),
  diskSpaceGB: z.number().positive(),
  diskPath: z.string().trim().optional(),
});

const osVersionRuleSchema = z.object({
  type: z.literal('os_version'),
  osType: z.enum(['windows', 'macos', 'linux', 'any']).optional(),
  osMinVersion: z.string().trim().optional(),
});

const registryCheckRuleSchema = z.object({
  type: z.literal('registry_check'),
  registryPath: z.string().trim().min(1),
  registryValueName: z.string().trim().min(1),
  registryExpectedValue: z.string().trim().optional(),
});

const configCheckRuleSchema = z.object({
  type: z.literal('config_check'),
  configFilePath: z.string().trim().min(1),
  configKey: z.string().trim().min(1),
  configExpectedValue: z.string().trim().optional(),
});

export const policyRulesSchema = z.array(
  z.discriminatedUnion('type', [
    requiredSoftwareRuleSchema,
    prohibitedSoftwareRuleSchema,
    diskSpaceRuleSchema,
    osVersionRuleSchema,
    registryCheckRuleSchema,
    configCheckRuleSchema,
  ])
).min(1).superRefine((rules, ctx) => {
  rules.forEach((rule, index) => {
    if (rule.type !== 'required_software') {
      return;
    }

    const operator = rule.versionOperator ?? 'any';
    if (operator !== 'any' && (!rule.softwareVersion || rule.softwareVersion.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'softwareVersion is required when versionOperator is exact/minimum/maximum',
        path: [index, 'softwareVersion'],
      });
    }
  });
});

export const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const basePolicyPayloadSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  targets: z.record(z.unknown()).optional(),
  targetType: targetTypeSchema.optional(),
  targetIds: z.array(z.string()).optional(),
  rules: policyRulesSchema,
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  enforcementLevel: z.enum(['monitor', 'warn', 'enforce']).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(10080).default(60),
  remediationScriptId: z.string().uuid().optional(),
  type: z.string().optional(),
});

export const createPolicySchema = basePolicyPayloadSchema;

export const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  targets: z.record(z.unknown()).optional(),
  targetType: targetTypeSchema.optional(),
  targetIds: z.array(z.string()).optional(),
  rules: policyRulesSchema.optional(),
  enforcement: z.enum(['monitor', 'warn', 'enforce']).optional(),
  enforcementLevel: z.enum(['monitor', 'warn', 'enforce']).optional(),
  checkIntervalMinutes: z.number().int().min(5).max(10080).optional(),
  remediationScriptId: z.string().uuid().nullable().optional(),
  type: z.string().optional(),
});

export const listComplianceSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['compliant', 'non_compliant', 'pending', 'error']).optional(),
});

export const policyIdSchema = z.object({ id: z.string().uuid() });
