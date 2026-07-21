import { z } from 'zod';
import {
  describeExclusionPattern,
  sanitizeExclusionPatterns,
} from '../utils/backupExclusionGlob';

/**
 * Only appended for a genuine SYNTAX error. A pattern rejected for length is one
 * the agent would happily compile — telling the user "the agent would ignore
 * this" would be a lie (the length cap is an API-side guard, nothing more).
 */
const AGENT_WOULD_IGNORE =
  ' The backup agent would ignore this pattern, so it would silently exclude nothing.';

/**
 * Per-pattern validation. Runs on the RAW array, BEFORE blanks are stripped, so
 * `path: [index]` still points at the row the user actually typed — a UI mapping
 * an issue back to a textarea line would otherwise highlight the wrong one once
 * a blank line precedes the offender.
 */
function refineExcludePatterns(patterns: string[], ctx: z.RefinementCtx) {
  patterns.forEach((pattern, index) => {
    const verdict = describeExclusionPattern(pattern);
    if (verdict.usable) return;
    // Blanks are stripped by the transform below, not rejected.
    if (verdict.problem === 'empty') return;
    const suffix = verdict.problem === 'syntax' ? AGENT_WOULD_IGNORE : '';
    ctx.addIssue({
      code: 'custom',
      path: [index],
      message: `${verdict.message}${suffix}`,
    });
  });
}

/**
 * File-mode exclusion globs, validated against the Go agent's dialect (#2473).
 *
 * Before this, a malformed glob was accepted, persisted, and shipped to the
 * fleet, where the agent logged "ignoring invalid exclusion pattern" and backed
 * up everything the tech believed was excluded — with no feedback to whoever
 * typed it.
 *
 * Two deliberate design choices, both aimed at NOT breaking working saves:
 *
 *  - **Blank entries are stripped, not rejected.** A textarea split on newlines
 *    yields empty strings; failing the save over one would be an over-strict
 *    regression. The agent skips them too.
 *  - **Only definite syntax errors are rejected** — the ones the agent's own
 *    matcher refuses to compile. Merely unusual patterns (`[z-a]`, `[!a-z]`)
 *    are accepted, because the agent accepts them.
 *
 * The dialect is pinned by a cross-language contract fixture replayed against
 * the real agent matcher — see packages/shared/src/utils/backupExclusionGlob.ts.
 */
export const backupExcludePatternsSchema = z
  .array(z.string())
  .superRefine(refineExcludePatterns)
  .transform(sanitizeExclusionPatterns);

/**
 * Profiles variant. Keeps the `.max(64)` cap that shipped with the profiles
 * schema in #2417 — deliberately NOT added to `backupExcludePatternsSchema`,
 * because the legacy inline-settings `excludes` has always been uncapped and
 * introducing a cap here would fail a save for an existing policy that exceeds
 * it. That is the over-strict regression this feature exists to avoid.
 */
const backupProfileExcludePatternsSchema = z
  .array(z.string())
  .max(64)
  .superRefine(refineExcludePatterns)
  .transform(sanitizeExclusionPatterns);

export const fileTargetsSchema = z.object({
  paths: z.array(z.string()).min(1),
  // Stays OPTIONAL on purpose: omitted means "fall back to the agent's local
  // excludes", whereas an explicit [] means "no exclusions this run". Do not
  // collapse the two with a .default([]) — see backupWorker.resolveBackupTargets.
  excludes: backupExcludePatternsSchema.optional(),
});

export const hypervTargetsSchema = z.object({
  consistencyType: z.enum(['application', 'crash']).default('application'),
  excludeVms: z.array(z.string()).default([]),
});

export const mssqlTargetsSchema = z.object({
  backupType: z.enum(['full', 'differential', 'log']).default('full'),
  excludeDatabases: z.array(z.string()).default([]),
});

export const systemImageTargetsSchema = z.object({
  includeSystemState: z.boolean().default(true),
});

export const backupModeSchema = z.enum([
  'file',
  'hyperv',
  'mssql',
  'system_image',
]);

export type BackupMode = z.infer<typeof backupModeSchema>;

export const backupScheduleSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(28).optional(),
  windowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

const backupRetentionSchemaBase = z.object({
  preset: z.enum(['standard', 'extended', 'compliance', 'custom']).optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  maxVersions: z.number().int().min(1).max(100).optional(),
  keepDaily: z.number().int().min(1).max(365).optional(),
  keepWeekly: z.number().int().min(1).max(260).optional(),
  keepMonthly: z.number().int().min(1).max(120).optional(),
  keepYearly: z.number().int().min(1).max(25).optional(),
  weeklyDay: z.number().int().min(0).max(6).optional(),
  legalHold: z.boolean().optional(),
  legalHoldReason: z.string().trim().min(1).max(500).optional(),
  immutabilityMode: z.enum(['none', 'application', 'provider']).optional(),
  immutableDays: z.number().int().min(1).max(3650).optional(),
});

function validateBackupRetention(
  data: z.infer<typeof backupRetentionSchemaBase>,
  ctx: z.RefinementCtx,
) {
  if (data.legalHold && !data.legalHoldReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['legalHoldReason'],
      message: 'legalHoldReason is required when legalHold is enabled',
    });
  }

  if ((data.immutabilityMode === 'application' || data.immutabilityMode === 'provider') && !data.immutableDays) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['immutableDays'],
      message: 'immutableDays is required when immutability is enabled',
    });
  }
}

export const backupRetentionSchema = backupRetentionSchemaBase.superRefine(validateBackupRetention);
export const backupRetentionUpdateSchema = backupRetentionSchemaBase.partial().superRefine(validateBackupRetention);

const targetsMap = {
  file: fileTargetsSchema,
  hyperv: hypervTargetsSchema,
  mssql: mssqlTargetsSchema,
  system_image: systemImageTargetsSchema,
} as const;

export const backupInlineSettingsSchema = z
  .object({
    backupMode: backupModeSchema.default('file'),
    targets: z.record(z.string(), z.unknown()).default({}),
    schedule: backupScheduleSchema.optional(),
    retention: backupRetentionSchema.optional(),
    paths: z.array(z.string()).optional(),
    // Explicit destination (backup_configs id). Omitted/null on a LEGACY link
    // falls back to the link's featurePolicyId destination first, then the
    // device org's default (see the destination chain in featureConfigResolver).
    destinationConfigId: z.string().nullish(),
  })
  .superRefine((data, ctx) => {
    const schema = targetsMap[data.backupMode];
    const result = schema.safeParse(data.targets);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['targets', ...issue.path],
        });
      }
    }
  });

export type BackupInlineSettings = z.infer<typeof backupInlineSettingsSchema>;
export type BackupSchedule = z.infer<typeof backupScheduleSchema>;
export type BackupRetention = z.infer<typeof backupRetentionSchema>;

// Inline settings for a PROFILE-LINKED backup feature link: "what to protect"
// lives on the linked backup_profiles row, so backupMode/paths/targets are
// not validated here (legacy keys may still be present in stored JSONB and
// are ignored). Schedule/retention/destination stay per-policy.
export const backupProfileLinkedInlineSettingsSchema = z.object({
  schedule: backupScheduleSchema.optional(),
  retention: backupRetentionSchema.optional(),
  destinationConfigId: z.string().nullish(),
});

// ── Backup profiles (docs/superpowers/specs/backup/2026-07-13-backup-profiles-design.md)
//
// A profile's `selections` enables any subset of the four source types. Keys
// deliberately match `backupModeSchema` values (so `system_image`, not the
// spec's working name `system_state`) — job fan-out maps each enabled
// selection straight onto a legacy single-mode job with zero key translation.

export const backupProfileSelectionsSchema = z
  .object({
    file: z
      .object({
        enabled: z.boolean().default(false),
        paths: z.array(z.string().trim().min(1)).max(64).default([]),
        // Was z.array(z.string().trim().min(1)) — which rejected a blank line
        // outright. Blank entries are now stripped instead (see schema doc).
        // Trimming is preserved by sanitizeExclusionPatterns.
        excludes: backupProfileExcludePatternsSchema.default([]),
        // Reserved for drive-letter/volume selection once the agent reports
        // volume inventory (spec phase 3). Rejected until then (see
        // superRefine): job creation cannot expand volumes into paths yet,
        // so accepting the field would fan out a file job with empty paths —
        // a green backup that protects nothing.
        volumes: z
          .union([z.literal('all_fixed'), z.array(z.string().trim().min(1)).max(26)])
          .optional(),
      })
      .optional(),
    hyperv: z
      .object({
        enabled: z.boolean().default(false),
        consistencyType: z.enum(['application', 'crash']).default('application'),
        excludeVms: z.array(z.string()).default([]),
      })
      .optional(),
    mssql: z
      .object({
        enabled: z.boolean().default(false),
        backupType: z.enum(['full', 'differential', 'log']).default('full'),
        excludeDatabases: z.array(z.string()).default([]),
      })
      .optional(),
    system_image: z
      .object({
        enabled: z.boolean().default(false),
        includeSystemState: z.boolean().default(true),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    const enabledCount = [
      data.file?.enabled,
      data.hyperv?.enabled,
      data.mssql?.enabled,
      data.system_image?.enabled,
    ].filter(Boolean).length;
    if (enabledCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one data source must be enabled',
      });
    }
    if (data.file?.volumes !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['file', 'volumes'],
        message: 'Volume selection is not supported yet — list explicit paths instead',
      });
    }
    if (data.file?.enabled && data.file.paths.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['file', 'paths'],
        message: 'File backups require at least one path',
      });
    }
  });

export type BackupProfileSelections = z.infer<typeof backupProfileSelectionsSchema>;

/**
 * Source types enabled in a selections object, in fan-out order.
 *
 * Must stay in sync with `backupSelectionSpecs` (apps/api featureConfigResolver),
 * which emits the actual job specs in this same order — if the two disagree, the
 * UI's source count and the jobs that really run diverge silently.
 */
export function enabledBackupSelections(
  selections: BackupProfileSelections,
): BackupMode[] {
  const order: BackupMode[] = ['file', 'system_image', 'mssql', 'hyperv'];
  return order.filter((mode) => selections[mode]?.enabled === true);
}

export const createBackupProfileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  // Partner-wide creation is gated on canManagePartnerWidePolicies server-side.
  ownerScope: z.enum(['organization', 'partner']).default('organization'),
  orgId: z.string().optional(),
  selections: backupProfileSelectionsSchema,
  isActive: z.boolean().optional(),
});

// Update never changes the ownership axis (same rule as every dual-axis table).
export const updateBackupProfileSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  selections: backupProfileSelectionsSchema.optional(),
  isActive: z.boolean().optional(),
});

export type CreateBackupProfileInput = z.infer<typeof createBackupProfileSchema>;
export type UpdateBackupProfileInput = z.infer<typeof updateBackupProfileSchema>;
