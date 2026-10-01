import { z } from 'zod';

// Write-path schema for `compliance` configuration-policy inline settings (#6669).
//
// Field names and rule types are the ones the evaluator reads —
// apps/api/src/services/policyEvaluationService.ts `evaluateRule` and its
// per-type evaluators — and the ones the web ComplianceTab writes. Keep the
// three in step: a field the evaluator does not read saves fine and then
// evaluates as a permanent failure ("Required software rule is missing
// softwareName."), which is exactly what the AI reference produced when it
// advertised `name` and `config_file_check`.
//
// Rule objects are `.passthrough()`: the ComplianceTab keeps leftover keys when
// a rule's type is switched (every new rule starts with softwareName /
// softwareVersion / versionOperator) and stores `description` and `remediation`
// on each rule. None of that changes evaluation, and stripping it would drop
// the remediation the enforce path reads.

export const COMPLIANCE_RULE_TYPES = [
  'required_software',
  'prohibited_software',
  'disk_space_minimum',
  'os_version',
  'registry_check',
  'config_check',
] as const;

// The evaluator trims and treats '' as absent (readString), so "required"
// means non-blank here too.
const requiredText = (field: string) =>
  z.string({ error: `${field} is required` }).trim().min(1, `${field} is required`).max(1000);
const optionalText = z.string().max(1000).nullable().optional();
const isBlank = (value: unknown) => typeof value !== 'string' || value.trim().length === 0;

// The evaluator maps these onto exact/minimum/maximum/any (`gt` is treated as
// minimum, i.e. >=). Anything else silently evaluates as `any`, so reject it.
export const COMPLIANCE_VERSION_OPERATORS = ['any', 'eq', 'exact', 'gte', 'gt', 'minimum', 'lte', 'maximum'] as const;

const remediationSchema = z
  .object({ type: z.enum(['script', 'software_deploy', 'none']) })
  .passthrough()
  .nullable()
  .optional();

const ruleBase = {
  description: optionalText,
  remediation: remediationSchema,
};

const requiredSoftwareRuleSchema = z
  .object({
    ...ruleBase,
    type: z.literal('required_software'),
    softwareName: requiredText('softwareName'),
    softwareVersion: optionalText,
    versionOperator: z.enum(COMPLIANCE_VERSION_OPERATORS).optional(),
  })
  .passthrough()
  .superRefine((rule, ctx) => {
    // evaluateRequiredSoftwareRule: any operator other than `any` with no
    // version FAILS the rule even when the software is installed.
    if (rule.versionOperator && rule.versionOperator !== 'any' && isBlank(rule.softwareVersion)) {
      ctx.addIssue({
        code: 'custom',
        path: ['softwareVersion'],
        message: `softwareVersion is required when versionOperator is "${rule.versionOperator}" — omit versionOperator (or use "any") to require presence only`,
      });
    }
  });

const prohibitedSoftwareRuleSchema = z
  .object({
    ...ruleBase,
    type: z.literal('prohibited_software'),
    prohibitedName: optionalText,
    // Evaluator fallback: `prohibitedName ?? softwareName`.
    softwareName: optionalText,
  })
  .passthrough()
  .superRefine((rule, ctx) => {
    // Mirrors `prohibitedName ?? softwareName`: a present-but-blank
    // prohibitedName does NOT fall back, so check the same way.
    const effective = rule.prohibitedName ?? rule.softwareName;
    if (isBlank(effective)) {
      ctx.addIssue({ code: 'custom', path: ['prohibitedName'], message: 'prohibitedName is required' });
    }
  });

const diskSpaceRuleSchema = z
  .object({
    ...ruleBase,
    type: z.literal('disk_space_minimum'),
    minGb: z.number().positive().optional(),
    // Evaluator fallback: `minGb ?? diskSpaceGB`.
    diskSpaceGB: z.number().positive().optional(),
    diskPath: optionalText,
  })
  .passthrough()
  .superRefine((rule, ctx) => {
    if (rule.minGb === undefined && rule.diskSpaceGB === undefined) {
      ctx.addIssue({ code: 'custom', path: ['minGb'], message: 'minGb (minimum free GB) is required' });
    }
  });

const osVersionRuleSchema = z
  .object({
    ...ruleBase,
    type: z.literal('os_version'),
    // Evaluator lowercases and defaults to 'any'.
    osType: z
      .string()
      .refine((v) => ['windows', 'macos', 'linux', 'any'].includes(v.toLowerCase()), {
        message: 'osType must be one of "windows", "macos", "linux", "any"',
      })
      .optional(),
    minOsVersion: optionalText,
    // Evaluator fallback: `minOsVersion ?? osMinVersion`.
    osMinVersion: optionalText,
  })
  .passthrough();

const registryCheckRuleSchema = z
  .object({
    ...ruleBase,
    type: z.literal('registry_check'),
    registryPath: requiredText('registryPath'),
    registryValueName: requiredText('registryValueName'),
    registryExpectedValue: optionalText,
  })
  .passthrough();

const configCheckRuleSchema = z
  .object({
    ...ruleBase,
    type: z.literal('config_check'),
    configFilePath: requiredText('configFilePath'),
    configKey: requiredText('configKey'),
    configExpectedValue: optionalText,
  })
  .passthrough();

// discriminatedUnion so an unknown `type` (e.g. `config_file_check`) is
// reported with the list of accepted types rather than a bare "Invalid input".
export const complianceRuleSchema = z.discriminatedUnion('type', [
  requiredSoftwareRuleSchema,
  prohibitedSoftwareRuleSchema,
  diskSpaceRuleSchema,
  osVersionRuleSchema,
  registryCheckRuleSchema,
  configCheckRuleSchema,
]);

const complianceItemSchema = z
  .object({
    name: z.string().max(255).optional(),
    enforcementLevel: z.enum(['monitor', 'warn', 'enforce']).optional(),
    checkIntervalMinutes: z.number().int().min(1).max(10080).optional(),
    remediationScriptId: z.string().uuid().nullable().optional(),
    sortOrder: z.number().int().optional(),
    rules: z.array(complianceRuleSchema).min(1, 'each compliance item needs at least one rule').max(50),
  })
  .passthrough();

/**
 * The name a rule set is stored under: its own name, or `Compliance Rule <n>`
 * when it has none (the API's decomposeInlineSettings writes the same default).
 */
export function complianceItemName(item: { name?: unknown }, index: number): string {
  return String(item.name ?? `Compliance Rule ${index + 1}`);
}

/**
 * Names that more than one rule set in the same link is stored under, compared
 * exactly as the database compares them.
 *
 * A rule set is identified by (feature link, name), not by its row id: saving
 * deletes and re-inserts every rule set, so the id changes on every save. The
 * evaluator's persisted state (automation_policy_compliance.config_item_name),
 * the due check and the compliance alert all key on that pair, so two rule
 * sets with one name would share a state row and an alert and overwrite each
 * other's result.
 */
export function duplicateComplianceItemNames(items: ReadonlyArray<{ name?: unknown }> | null | undefined): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  (items ?? []).forEach((item, index) => {
    const name = complianceItemName(item, index);
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  });
  return [...duplicates];
}

export function duplicateComplianceItemNameMessage(name: string): string {
  return `More than one rule set is named "${name}". Each rule set in a policy needs its own name.`;
}

export const complianceInlineSettingsSchema = z
  .object({
    items: z.array(complianceItemSchema).max(100),
  })
  .passthrough()
  .superRefine((settings, ctx) => {
    const seen = new Set<string>();
    settings.items.forEach((item, index) => {
      const name = complianceItemName(item, index);
      if (seen.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'name'],
          message: duplicateComplianceItemNameMessage(name),
        });
      }
      seen.add(name);
    });
  });

export type ComplianceInlineSettings = z.infer<typeof complianceInlineSettingsSchema>;
