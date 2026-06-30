import { z } from 'zod';

// ============================================
// Software Detection Rules (issue #2022, Phase 1)
// ============================================
//
// A software package version can carry a set of detection rules that the agent
// evaluates against the device's REAL state — independent of the installer's
// exit code. They serve two purposes:
//   1. pre-install "skip if already installed" gate, and
//   2. post-install/uninstall verification (status reflects what is actually on
//      the box, not just whether the installer returned 0).
//
// Composition is implicit AND: every clause must be satisfied for the package to
// count as "detected" (matches Intune/PDQ semantics). Phase 1 ships three clause
// types; file-version comparison is deferred (it needs Win32 version-info work).
//
// Registry and MSI-product-code clauses are Windows-only. On a platform where a
// clause type can't be evaluated the agent reports the rule set as "unsupported"
// and falls back to exit-code behavior — it never silently treats unsupported as
// pass or fail. See agent/internal/remote/tools/software_detection*.go.

/** Registry hives a registry detection clause may target. */
export const REGISTRY_HIVES = ['HKLM', 'HKCU', 'HKCR', 'HKU', 'HKCC'] as const;
export type RegistryHive = (typeof REGISTRY_HIVES)[number];

// A loose GUID matcher accepting the MSI product-code forms with or without
// surrounding braces, e.g. {3F2504E0-4F89-41D3-9A0C-0305E82C3301} or the bare
// form. Case-insensitive — the agent normalizes to braced uppercase.
const MSI_PRODUCT_CODE_REGEX =
  /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;

export const registryDetectionRuleSchema = z.object({
  type: z.literal('registry'),
  hive: z.enum(REGISTRY_HIVES).optional(),
  // Registry key path WITHOUT the hive prefix, e.g.
  // "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{...}".
  path: z.string().min(1).max(1024),
  // Optional value under the key. Omit to assert only that the key exists.
  valueName: z.string().max(256).optional(),
  // Optional expected data for valueName. Omit to assert only that the value
  // exists (any data). Compared case-insensitively by the agent.
  valueData: z.string().max(1024).optional(),
});

export const fileDetectionRuleSchema = z.object({
  type: z.literal('file_exists'),
  // Absolute path to a file OR folder; existence of either satisfies the clause.
  path: z.string().min(1).max(1024),
});

export const msiProductCodeDetectionRuleSchema = z.object({
  type: z.literal('msi_product_code'),
  productCode: z
    .string()
    .min(1)
    .max(64)
    .regex(MSI_PRODUCT_CODE_REGEX, 'Must be a GUID, e.g. {3F2504E0-4F89-41D3-9A0C-0305E82C3301}'),
});

export const detectionRuleSchema = z.discriminatedUnion('type', [
  registryDetectionRuleSchema,
  fileDetectionRuleSchema,
  msiProductCodeDetectionRuleSchema,
]);

export type RegistryDetectionRule = z.infer<typeof registryDetectionRuleSchema>;
export type FileDetectionRule = z.infer<typeof fileDetectionRuleSchema>;
export type MsiProductCodeDetectionRule = z.infer<typeof msiProductCodeDetectionRuleSchema>;
export type DetectionRule = z.infer<typeof detectionRuleSchema>;

// The full rule set stored on a software version. An empty array (or null) means
// "no detection configured" — behavior is unchanged (exit-code only). Capped to
// keep the agent payload bounded.
export const detectionRulesSchema = z.array(detectionRuleSchema).max(20);
export type DetectionRules = z.infer<typeof detectionRulesSchema>;
