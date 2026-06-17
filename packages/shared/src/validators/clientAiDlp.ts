import { z } from 'zod';

/**
 * DLP configuration for Breeze AI for Office (spec §6).
 *
 * Stored in client_ai_org_policies.dlp_config (jsonb, DB default '{}').
 * `dlpConfigSchema.parse({})` materialises the documented defaults: redact
 * for financial/credential detectors (creditCard, ssn, iban, apiKey),
 * email/phone off. The engine (apps/api/src/services/clientAiDlp.ts) parses
 * stored configs with this schema and degrades invalid configs to
 * DEFAULT_DLP_CONFIG — never to "everything off".
 *
 * ReDoS mitigation for custom patterns. The repo has no RE2-style regex
 * dependency (checked root / apps/api / packages/shared package.json), so
 * instead of an engine swap we layer guards:
 *   1. pattern length cap (DLP_MAX_PATTERN_LENGTH)
 *   2. backreference ban — \1..\9 enable exponential backtracking
 *   3. nested-quantifier heuristic: a quantified atom directly before a
 *      closing paren that is itself quantified — (a+)+, (\d{2,})*, (x*)+.
 *      Conservative: it can also reject safe escaped-paren patterns like
 *      x+\)+ ; custom DLP rules are short PII matchers, so over-rejection
 *      is acceptable. Bounded inner quantifiers like (colou?r){1,3} pass.
 *   4. bounded timed probes: the pattern executes against short (≤25 char)
 *      adversarial inputs under a wall-clock budget. Probes are short enough
 *      that even a fully catastrophic pattern that slips past (3) costs at
 *      most a few hundred ms ONCE at config-save time, never per message.
 *   5. (engine-side) per-call scan budget + input size caps in
 *      apps/api/src/services/clientAiDlp.ts (DLP_SCAN_BUDGET_MS et al.).
 *
 * The Plan-4 policy editor's live regex test box should call
 * validateDlpPattern directly for instant feedback.
 */

export const DLP_BUILTIN_RULES = ['creditCard', 'ssn', 'iban', 'apiKey', 'email', 'phone'] as const;
export type DlpBuiltinRule = (typeof DLP_BUILTIN_RULES)[number];

/** Actions a custom rule can take. */
export const dlpRuleActionSchema = z.enum(['redact', 'block', 'log']);
export type DlpRuleAction = z.infer<typeof dlpRuleActionSchema>;

/** Built-ins additionally support 'off'. */
export const dlpBuiltinSettingSchema = z.enum(['redact', 'block', 'log', 'off']);
export type DlpBuiltinSetting = z.infer<typeof dlpBuiltinSettingSchema>;

export const DLP_MAX_CUSTOM_RULES = 50;
export const DLP_MAX_PATTERN_LENGTH = 200;

/**
 * Short adversarial probe inputs (≤25 chars — see header, guard #4). Repeated
 * single chars trigger classic catastrophic shapes; the mixed tails vary the
 * failure position.
 */
const PATTERN_PROBES = [
  'a'.repeat(24) + '!',
  'A'.repeat(24) + '!',
  '0'.repeat(24) + '!',
  ' '.repeat(24) + '!',
  'ab'.repeat(12) + '!',
  'a0a0'.repeat(6) + '!',
];
const PROBE_BUDGET_MS = 50;

const BACKREFERENCE = /\\[1-9]/;
// Quantified atom (+, *, or a closing {m,n} brace) immediately before a
// closing paren that is itself quantified.
const NESTED_QUANTIFIER = /[+*}]\)[+*{?]/;

export type DlpPatternValidation = { ok: true } | { ok: false; reason: string };

/** Gate for custom rule patterns. Used by the schema below AND the Plan-4 live test box. */
export function validateDlpPattern(pattern: string): DlpPatternValidation {
  if (pattern.length === 0) return { ok: false, reason: 'empty_pattern' };
  if (pattern.length > DLP_MAX_PATTERN_LENGTH) return { ok: false, reason: 'pattern_too_long' };
  if (BACKREFERENCE.test(pattern)) return { ok: false, reason: 'backreference_not_allowed' };
  if (NESTED_QUANTIFIER.test(pattern)) return { ok: false, reason: 'nested_quantifier' };

  let re: RegExp;
  try {
    // 'gu' — the exact flags the engine compiles with; unicode mode is the
    // stricter parse, so anything accepted here compiles at scan time too.
    re = new RegExp(pattern, 'gu');
  } catch {
    return { ok: false, reason: 'invalid_regex' };
  }

  const start = Date.now();
  for (const probe of PATTERN_PROBES) {
    re.lastIndex = 0;
    re.test(probe);
    if (Date.now() - start > PROBE_BUDGET_MS) return { ok: false, reason: 'pattern_too_slow' };
  }
  return { ok: true };
}

export const dlpCustomRuleSchema = z
  .object({
    id: z.string().guid(),
    name: z.string().trim().min(1).max(60),
    pattern: z
      .string()
      .min(1)
      .max(DLP_MAX_PATTERN_LENGTH)
      .superRefine((pattern, ctx) => {
        const v = validateDlpPattern(pattern);
        if (!v.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unsafe or invalid pattern: ${v.reason}`,
          });
        }
      }),
    action: dlpRuleActionSchema,
  })
  .strict();
export type DlpCustomRule = z.infer<typeof dlpCustomRuleSchema>;

export const dlpBuiltinsSchema = z
  .object({
    creditCard: dlpBuiltinSettingSchema.default('redact'),
    ssn: dlpBuiltinSettingSchema.default('redact'),
    iban: dlpBuiltinSettingSchema.default('redact'),
    apiKey: dlpBuiltinSettingSchema.default('redact'),
    email: dlpBuiltinSettingSchema.default('off'),
    phone: dlpBuiltinSettingSchema.default('off'),
  })
  .strict()
  // v4: .default() short-circuits parsing, so child-field .default()s would NOT
  // apply and an untouched org would get {} (DLP silently disabled). .prefault()
  // re-parses the {} through the schema, materialising all builtin defaults —
  // the v3 behavior. DEFAULT_DLP_CONFIG depends on this.
  .prefault({});

export const dlpConfigSchema = z
  .object({
    builtins: dlpBuiltinsSchema,
    customRules: z
      .array(dlpCustomRuleSchema)
      .max(DLP_MAX_CUSTOM_RULES)
      .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, {
        message: 'custom rule ids must be unique',
      })
      .default([]),
  })
  // No top-level default/prefault here. builtins (.prefault) + customRules
  // (.default) already materialise the full config for dlpConfigSchema.parse({})
  // (→ DEFAULT_DLP_CONFIG). A top-level default would, under v4, ALSO fire for
  // `dlpConfig: dlpConfigSchema.optional()` on an absent key, injecting a full
  // config and breaking partial-PUT semantics (the field must stay undefined
  // when the client omits it).
  .strict();
export type DlpConfig = z.infer<typeof dlpConfigSchema>;

/** The materialised defaults — what an untouched org gets. */
export const DEFAULT_DLP_CONFIG: DlpConfig = dlpConfigSchema.parse({});
