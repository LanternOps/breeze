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
 * ReDoS mitigation for custom patterns. This module is imported by the
 * browser-side Plan-4 policy editor's live regex test box (for instant
 * feedback), so it stays engine-independent and WASM-free; it cannot
 * assume RE2 is available. Two layers, both server-side, do the actual
 * enforcement on top of what this file checks:
 *   - apps/api/src/services/clientAiDlp.ts and
 *     ee/workspace/src/content/dlp.ts compile and match custom rule
 *     patterns with RE2 (apps/api/src/services/dlpRegexEngine.ts,
 *     ee/workspace/src/services/dlpRegexEngine.ts — the `re2-wasm` pure-WASM
 *     binding), which matches in time linear in input length by
 *     construction — no pattern shape can make it backtrack. This is the
 *     actual safety boundary for the hot scan path.
 *   - apps/api/src/routes/clientAi/schemas.ts and
 *     ee/workspace/src/services/orgSettingsService.ts additionally run
 *     that same RE2 compile at write/read time, so a pattern RE2 can't
 *     compile (backreferences, lookaround — RE2's language is a strict
 *     subset of JS regex) is rejected or dropped before it ever reaches
 *     the scanner, not discovered there.
 *
 * This file's own guards are a fast, portable pre-check — cheap early
 * rejection and browser-side UX — not the thing standing between a hostile
 * pattern and the scan path:
 *   1. pattern length cap (DLP_MAX_PATTERN_LENGTH)
 *   2. backreference ban — \1..\9 enable exponential backtracking on a
 *      backtracking engine, and RE2 can't compile them regardless.
 *   2b. lookaround ban — (?=, (?!, (?<=, (?<! (not a named group (?<name>).
 *      Not a backtracking-safety concern on its own; banned because RE2
 *      can't compile these either, so rejecting here gives the same error
 *      instantly instead of only once the pattern reaches RE2 server-side.
 *   3. nested-quantifier heuristic: a quantified atom (+, *, ? or a closing
 *      {m,n} brace) directly before a closing paren that is itself
 *      quantified — (a+)+, (\d{2,})*, (x*)+, (a?)*. Conservative: it can
 *      also reject safe escaped-paren patterns like x+\)+ ; custom DLP
 *      rules are short PII matchers, so over-rejection is acceptable.
 *      Bounded inner quantifiers like (colou?r){1,3} pass. KNOWN GAP: a
 *      quantified atom separated from the group's closing paren by literal
 *      content — (([a-z])+.)+ — is NOT caught by this heuristic (no
 *      quantifier character sits immediately before the `)`); RE2 is what
 *      makes that shape safe to accept, not this check.
 *   4. ambiguous-alternation heuristic: a quantified group ((...)+, (...)*,
 *      or (...){m,n} with m or n ≥ 2) whose top-level `|` branches include
 *      a pair where one branch is a literal prefix of the other —
 *      (a|aa)+, (ab|a)*, (x|xy){2,}. This is the shape the nested-quantifier
 *      check above cannot see: no single atom is doubly-quantified, but the
 *      engine still has an exponential number of ways to partition a run of
 *      input across repetitions of the ambiguous branches. Structural (walks
 *      parens/brackets/escapes to find real top-level branches), so it is
 *      independent of — and does not rely on — probe strings happening to
 *      trigger the blowup at a given length.
 *   5. bounded timed probes: the pattern executes against short (≤25 char)
 *      worst-case inputs under a wall-clock budget. Defense-in-depth for
 *      shapes (3)/(4) don't cover; probes are short enough that even a
 *      fully catastrophic pattern that slips past both costs at most a few
 *      hundred ms ONCE at config-save time, never per message.
 *   6. (engine-side) per-call scan budget + input size caps in
 *      apps/api/src/services/clientAiDlp.ts (DLP_SCAN_BUDGET_MS et al.), and
 *      a hard wall-clock execution timeout on the match-time re-check in
 *      apps/api/src/services/scriptProposals/verify.ts.
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
// Quantified atom (+, *, ?, or a closing {m,n} brace) immediately before a
// closing paren that is itself quantified.
const NESTED_QUANTIFIER = /[+*?}]\)[+*{?]/;
// Lookahead `(?=`/`(?!` or lookbehind `(?<=`/`(?<!` — deliberately excludes
// a named group `(?<name>` (no `=`/`!` right after `<`). Not a
// backtracking-safety concern on its own; banned because RE2 (the engine
// that actually scans messages — apps/api/src/services/clientAiDlp.ts,
// ee/workspace/src/content/dlp.ts) cannot compile either form, so a pattern
// using one would otherwise pass this JS-only check and only fail later,
// deep in the scan path. Surfacing it here gives the same rejection
// instantly in the browser-side policy editor's live test box.
const LOOKAROUND = /\(\?[=!]|\(\?<[=!]/;

export type DlpPatternValidation = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Structural parse helpers for the ambiguous-alternation check (guard 4).
// Deliberately minimal: only what's needed to find top-level `(...)` group
// boundaries, whether a group is quantified with a repeat count ≥ 2, and its
// top-level `|`-separated branches — while correctly skipping over escaped
// characters and character classes (`[...]`) so a `|` or `(`/`)` inside
// either is never mistaken for structure. Not a full regex parser; a pattern
// this can't confidently walk (unbalanced parens/brackets) is left to the
// `new RegExp` compile check below to reject.
// ---------------------------------------------------------------------------

/** Index just past a `[...]` character class starting at `start` (which must be `[`). */
function skipCharClass(pattern: string, start: number): number {
  let j = start + 1;
  const n = pattern.length;
  if (pattern[j] === '^') j++;
  if (pattern[j] === ']') j++; // a leading ']' (or '[^]') is a literal member, not the close
  while (j < n) {
    const ch = pattern[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === ']') return j + 1;
    j++;
  }
  return n; // unterminated class — let the compile check below reject it
}

/** Split `content` on `|` at depth 0, skipping nested groups, classes, and escapes. */
function splitTopLevelAlternation(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') { i = skipCharClass(content, i); continue; }
    if (ch === '(') { depth++; i++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
    if (ch === '|' && depth === 0) {
      parts.push(content.slice(start, i));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  parts.push(content.slice(start));
  return parts;
}

/** True if one (non-empty) branch is a literal prefix of the other, either direction. */
function isPrefixPair(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return true; // an empty branch is always ambiguous
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer.startsWith(shorter);
}

/** A `{m,n}` (or `{m}`/`{m,}`) quantifier spec that allows 2 or more repetitions. */
function isRepeatableBraceSpec(spec: string): boolean {
  const m = /^(\d+)(,(\d*))?$/.exec(spec);
  if (!m) return false;
  const min = Number(m[1]);
  const hasComma = m[2] !== undefined;
  const maxPart = m[3];
  const max = !hasComma ? min : maxPart === '' || maxPart === undefined ? Infinity : Number(maxPart);
  return max >= 2;
}

/**
 * Walk every `(...)` group in `pattern` (recursing into nested groups) and
 * flag the first one that is BOTH quantified with a repeat count ≥ 2 AND has
 * two or more top-level `|` branches where one is a literal prefix of
 * another — the (a|aa)+ shape: an ambiguous match length lets the engine try
 * exponentially many ways to partition the same input across repetitions.
 */
function hasAmbiguousAlternation(pattern: string): boolean {
  const n = pattern.length;
  let i = 0;
  while (i < n) {
    const ch = pattern[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') { i = skipCharClass(pattern, i); continue; }
    if (ch === '(') {
      // Find the matching close paren, depth-aware, skipping classes/escapes.
      let depth = 0;
      let j = i;
      let closeIdx = -1;
      while (j < n) {
        const c = pattern[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') { j = skipCharClass(pattern, j); continue; }
        if (c === '(') { depth++; j++; continue; }
        if (c === ')') {
          depth--;
          if (depth === 0) { closeIdx = j; break; }
          j++;
          continue;
        }
        j++;
      }
      if (closeIdx === -1) { i++; continue; } // unbalanced; compile check below will reject

      // Skip past group-kind markers: (?:  (?=  (?!  (?<=  (?<!  (?<name>
      let contentStart = i + 1;
      if (pattern[contentStart] === '?') {
        const k1 = pattern[contentStart + 1];
        if (k1 === ':' || k1 === '=' || k1 === '!') {
          contentStart += 2;
        } else if (k1 === '<') {
          const k2 = pattern[contentStart + 2];
          if (k2 === '=' || k2 === '!') {
            contentStart += 3;
          } else {
            const gt = pattern.indexOf('>', contentStart);
            contentStart = gt === -1 ? contentStart : gt + 1;
          }
        }
      }
      const content = pattern.slice(contentStart, closeIdx);

      // Quantifier immediately after the closing paren.
      let repeatable = false;
      const after = pattern[closeIdx + 1];
      if (after === '+' || after === '*') {
        repeatable = true;
      } else if (after === '{') {
        const closeBrace = pattern.indexOf('}', closeIdx + 1);
        if (closeBrace !== -1) repeatable = isRepeatableBraceSpec(pattern.slice(closeIdx + 2, closeBrace));
      }

      if (repeatable) {
        const branches = splitTopLevelAlternation(content);
        if (branches.length >= 2) {
          for (let a = 0; a < branches.length; a++) {
            for (let b = a + 1; b < branches.length; b++) {
              if (isPrefixPair(branches[a] ?? '', branches[b] ?? '')) return true;
            }
          }
        }
      }

      if (hasAmbiguousAlternation(content)) return true; // nested groups can be independently ambiguous
      i = closeIdx + 1;
      continue;
    }
    i++;
  }
  return false;
}

/**
 * Pattern-only structural checks shared by every gate below: backreference
 * ban, lookaround ban, nested-quantifier and ambiguous-alternation
 * heuristics, and a compile check with the engine's exact flags. Pure
 * string/regex tests against the PATTERN itself, never against user text,
 * so no backtracking exposure. Excludes the empty/length checks (caller-
 * specific) and the timed probes (guard 5, which execute the pattern).
 */
function validateRegexStructure(pattern: string): DlpPatternValidation {
  if (BACKREFERENCE.test(pattern)) return { ok: false, reason: 'backreference_not_allowed' };
  if (LOOKAROUND.test(pattern)) return { ok: false, reason: 'lookaround_not_allowed' };
  if (NESTED_QUANTIFIER.test(pattern)) return { ok: false, reason: 'nested_quantifier' };
  if (hasAmbiguousAlternation(pattern)) return { ok: false, reason: 'ambiguous_alternation' };

  try {
    // 'gu' — the exact flags the engine compiles with; unicode mode is the
    // stricter parse, so anything accepted here compiles at scan time too.
    void new RegExp(pattern, 'gu');
  } catch {
    return { ok: false, reason: 'invalid_regex' };
  }
  return { ok: true };
}

/**
 * The cheap subset of the DLP gate (guards 1-4 + compile check): pure
 * string/regex tests against the PATTERN itself, never against user text, so
 * this has no backtracking exposure and is safe to run on every read of a
 * stored config — including a hot ingest path — not just at write time. Used
 * directly by callers that need a cheap re-check without paying for the timed
 * probes (guard 5); `validateDlpPattern` is this plus the probes.
 */
export function validateDlpPatternStatic(pattern: string): DlpPatternValidation {
  if (pattern.length === 0) return { ok: false, reason: 'empty_pattern' };
  if (pattern.length > DLP_MAX_PATTERN_LENGTH) return { ok: false, reason: 'pattern_too_long' };
  return validateRegexStructure(pattern);
}

/**
 * The engine-independent half of the pattern gate (guards 2-5 in the header
 * comment): backreference ban, nested-quantifier heuristic, ambiguous-
 * alternation structural check, bounded timed probes. Deliberately excludes
 * the length cap (guard 1) and the empty-string check, since those are
 * caller-specific (DLP custom rules cap at DLP_MAX_PATTERN_LENGTH; other
 * tenant-authored-regex sinks — e.g. AI script proposal `output_matches`
 * verification claims — cap at their own schema limit). Any other
 * tenant-authored-regex sink should call this directly rather than
 * reimplementing catastrophic-backtracking detection. Runs real regex
 * execution (up to PROBE_BUDGET_MS per pattern), so it is a write-time gate,
 * NOT a hot scan/read path check — use `validateDlpPatternStatic` there.
 */
export function validateRegexSafety(pattern: string): DlpPatternValidation {
  const structural = validateRegexStructure(pattern);
  if (!structural.ok) return structural;

  const re = new RegExp(pattern, 'gu');
  const start = Date.now();
  for (const probe of PATTERN_PROBES) {
    re.lastIndex = 0;
    re.test(probe);
    if (Date.now() - start > PROBE_BUDGET_MS) return { ok: false, reason: 'pattern_too_slow' };
  }
  return { ok: true };
}

/**
 * Full gate for custom rule patterns (guards 1-5). Used by the schema below,
 * the Plan-4 live test box, and any write-time validation path — NOT a hot
 * scan/read path, since guard 5 runs real regex execution and can cost up to
 * PROBE_BUDGET_MS per pattern.
 */
export function validateDlpPattern(pattern: string): DlpPatternValidation {
  if (pattern.length === 0) return { ok: false, reason: 'empty_pattern' };
  if (pattern.length > DLP_MAX_PATTERN_LENGTH) return { ok: false, reason: 'pattern_too_long' };
  return validateRegexSafety(pattern);
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
