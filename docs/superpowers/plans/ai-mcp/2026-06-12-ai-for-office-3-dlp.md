# Breeze AI for Office — Plan 3: DLP / Redaction Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Plan-2 `clientAiDlp.ts` passthrough stub with the real DLP/redaction engine (spec §6): built-in Luhn/mod-97-validated detectors, per-org custom regex rules with layered ReDoS guards, cell-level workbook scanning, block > redact > log action precedence, and a strict `dlp_config` schema so the audit trail (`ai_messages`) only ever stores the redacted form.

**Architecture:** Three layers, all pure computation (no DB, no Redis — the engine receives `dlpConfig` from `getOrgPolicy()` via its Plan-2 callers, so there are no `withDbAccessContext` concerns):
1. `packages/shared/src/validators/clientAiDlp.ts` — the `dlp_config` Zod schema + `validateDlpPattern` custom-pattern safety gate. Shared so the API PUT route, the engine, and the Plan-4 policy-editor live test box all use the identical contract.
2. `apps/api/src/services/clientAiDlpDetectors.ts` — built-in detectors as pure `string → match spans` functions (Luhn, IBAN mod-97 included here in full).
3. `apps/api/src/services/clientAiDlp.ts` — the scanning engine behind the **pinned** `applyDlp` interface Plan 2 calls on (a) user message text, (b) every workbook `tool_result` cell matrix, (c) template content. This plan does NOT touch those call sites.

**Tech Stack:** TypeScript, Zod v3 (`^3.24.1`, same in shared + api), Vitest. No new dependencies — the repo has no RE2-style regex engine (checked root, `apps/api`, and `packages/shared` package.json), so ReDoS mitigation is layered guards, not an engine swap.

**Spec:** docs/superpowers/specs/ai-mcp/2026-06-12-breeze-ai-for-office-design.md
**Depends on:** Plan 1 (foundation), Plan 2 (session loop — owns the applyDlp call sites)
---

## Pinned cross-plan contract

Plan 2 creates `apps/api/src/services/clientAiDlp.ts` as a passthrough stub with EXACTLY this interface. This plan replaces the internals and **must keep the signature**:

```ts
export interface DlpRedactionEvent { rule: string; count: number; location: string }
export interface DlpResult { action: 'allow' | 'block'; text?: string; cells?: unknown[][]; redactions: DlpRedactionEvent[]; blockReason?: string }
export async function applyDlp(input: { text?: string; cells?: unknown[][]; dlpConfig: unknown; orgId: string }): Promise<DlpResult>
```

If Plan 2 has not landed when this plan executes, create the file fresh — the interface is pinned either way, so merge order between Plan 2 and Plan 3 does not matter. (`input.orgId` is unused by the v1 engine — config arrives pre-fetched — but stays in the signature for future per-org compiled-rule caching/telemetry.)

`dlpConfig` arrives as `unknown` straight from `getOrgPolicy().dlpConfig` (Plan 1, `apps/api/src/services/clientAiPolicy.ts` — jsonb column, DB default `'{}'`). The engine parses it itself; callers never pre-validate.

## Design decisions (read before implementing)

- **Defaults (spec §6):** `creditCard`, `ssn`, `iban`, `apiKey` → `redact`; `email`, `phone` → `off`. `dlpConfigSchema.parse({})` materialises exactly this, so an org that has never touched the policy editor still gets financial/credential redaction the moment the product is enabled.
- **Invalid stored config degrades to defaults, never to "off".** If a `dlp_config` row fails strict parsing (only possible via out-of-band DB writes — the PUT path validates with the same schema after Task 5), the engine falls back to `DEFAULT_DLP_CONFIG`. Trade-off: an invalid config's custom rules are dropped; the built-in redactions stay on. Documented in the engine header.
- **Action order: block → redact → log.** All enabled rules scan first; if ANY block-rule matched anywhere, the whole payload is refused (`action:'block'`, `blockReason:'dlp_blocked:<ruleName>'`) with **no partial results** (`text`/`cells` omitted) — but the value-free `redactions` events ARE returned so the MSP audit view can show what tripped. Otherwise redact rules rewrite content (`[REDACTED:<rule>]`, per spec §6's `[REDACTED:type]`), and log rules contribute events without modifying anything.
- **Oversize payloads block with `payload_too_large_for_dlp`** (cells > 50 000, any single stringified cell > 32 768 chars — Excel's own cell limit is 32 767 — or total > 2 000 000 chars). Justification: fail closed. Scanning a prefix and passing the rest would let data ride past the chokepoint inside padded payloads; Plan 2's read tools chunk well below these caps, so hitting one is a tool-layer bug that should surface loudly, not silently leak.
- **ReDoS mitigation (no RE2 dependency exists, so layered guards):** (1) 200-char pattern length cap; (2) backreference ban (`\1`–`\9` enable exponential backtracking); (3) nested-quantifier heuristic rejecting a quantified atom immediately before a quantified closing paren — `(a+)+`, `(\d{2,})*`, `(x*)+`; deliberately conservative (it also rejects some safe escaped-paren patterns — acceptable, custom DLP rules are short PII matchers); (4) bounded timed probes: the candidate pattern runs against ≤25-char adversarial inputs under a 50 ms budget, short enough that even a fully catastrophic pattern costs at most a few hundred ms once at config-save time; (5) engine-side per-call wall-clock budget (`DLP_SCAN_BUDGET_MS`, blocks with `dlp_scan_budget_exceeded`) plus the input size caps. The timing-based guards (4)(5) are intentionally NOT unit-tested — wall-clock assertions flake; the deterministic guards (1)(2)(3) are.
- **Custom rule fails to compile at scan time → block** (`dlp_rule_compile_failed:<name>`). Near-unreachable (the schema compiles every pattern at save time), but silently skipping a rule the MSP believes is active would disable DLP without anyone noticing.
- **Cell granularity:** every cell is a scan location labelled `cell[r][c]` (row-major, 0-based); redaction replaces *within* the cell string. Non-string cells are stringified for scanning (`String()` for number/boolean/bigint — Excel stores card numbers as numbers; `JSON.stringify` for objects; `null`/`undefined` skipped); a redacted numeric cell becomes a redacted **string** in the output. Untouched cells keep their original value and type. The input matrix is never mutated.
- **Redaction events** are aggregated per rule: `count` = total matches across the payload, `location` = the single location, or `'<first> (+N more)'` when matches span multiple locations. Bounded by construction (≤ 6 builtins + 50 custom rules = 56 events max).
- **SSN context guard:** the dashed form (`\d{3}-\d{2}-\d{4}` + area/group/serial plausibility) always matches. The bare 9-digit form only activates when an SSN keyword (`ssn`, `social security`) appears **anywhere in the payload** — this covers an `SSN` header cell above a column of bare numbers. False-positive trade-off documented in Task 2.
- **Idempotency:** `[REDACTED:<rule>]` tokens contain no digits and no 32+ char hex/base64 runs, so re-scanning redacted output yields zero findings (tested). A custom rule could theoretically match the literal token text — that is the org's own foot-gun, not guarded.

## File Structure

```
packages/shared/src/validators/
  clientAiDlp.ts               (new — dlp_config schema, pattern safety, DEFAULT_DLP_CONFIG)
  clientAiDlp.test.ts          (new)
  index.ts                     (edit — add barrel export)
apps/api/src/services/
  clientAiDlpDetectors.ts      (new — built-in detectors, luhnCheck, ibanMod97, mergeMatches)
  clientAiDlpDetectors.test.ts (new)
  clientAiDlp.ts               (replace Plan-2 stub internals — pinned interface)
  clientAiDlp.test.ts          (new)
apps/api/src/routes/clientAi/
  schemas.ts                   (edit — putPolicySchema.dlpConfig: z.record → dlpConfigSchema)
  schemas.dlp.test.ts          (new)
```

---

### Task 1: dlp_config Zod schema + custom-pattern safety validator (TDD)

**Files:**
- Create: packages/shared/src/validators/clientAiDlp.ts
- Create: packages/shared/src/validators/clientAiDlp.test.ts
- Edit: packages/shared/src/validators/index.ts

- [ ] **Step 1: Write the failing test** — `packages/shared/src/validators/clientAiDlp.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  dlpConfigSchema,
  dlpCustomRuleSchema,
  validateDlpPattern,
  DEFAULT_DLP_CONFIG,
  DLP_MAX_CUSTOM_RULES,
  DLP_MAX_PATTERN_LENGTH,
} from './clientAiDlp';

const RULE_ID = '0b8f8f54-1111-4222-8333-444455556666';

describe('dlpConfigSchema — defaults', () => {
  it('parses {} to the documented defaults (financial/credential redact, email/phone off)', () => {
    expect(dlpConfigSchema.parse({})).toEqual({
      builtins: {
        creditCard: 'redact',
        ssn: 'redact',
        iban: 'redact',
        apiKey: 'redact',
        email: 'off',
        phone: 'off',
      },
      customRules: [],
    });
  });

  it('DEFAULT_DLP_CONFIG matches parse({})', () => {
    expect(DEFAULT_DLP_CONFIG).toEqual(dlpConfigSchema.parse({}));
  });

  it('fills missing builtin keys with their defaults', () => {
    const config = dlpConfigSchema.parse({ builtins: { email: 'redact' } });
    expect(config.builtins.email).toBe('redact');
    expect(config.builtins.creditCard).toBe('redact');
    expect(config.builtins.phone).toBe('off');
  });
});

describe('dlpConfigSchema — strictness', () => {
  it('rejects unknown builtin keys', () => {
    expect(dlpConfigSchema.safeParse({ builtins: { creditCards: 'redact' } }).success).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    expect(dlpConfigSchema.safeParse({ rules: [] }).success).toBe(false);
  });

  it('rejects invalid action values', () => {
    expect(dlpConfigSchema.safeParse({ builtins: { ssn: 'mask' } }).success).toBe(false);
  });
});

describe('dlpConfigSchema — custom rules', () => {
  it('accepts a valid custom rule', () => {
    const result = dlpConfigSchema.safeParse({
      customRules: [{ id: RULE_ID, name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects duplicate custom rule ids', () => {
    const rule = { id: RULE_ID, name: 'A', pattern: 'x\\d+', action: 'log' as const };
    expect(
      dlpConfigSchema.safeParse({ customRules: [rule, { ...rule, name: 'B' }] }).success,
    ).toBe(false);
  });

  it(`caps customRules at ${DLP_MAX_CUSTOM_RULES}`, () => {
    const rules = Array.from({ length: DLP_MAX_CUSTOM_RULES + 1 }, (_, i) => ({
      id: `0b8f8f54-1111-4222-8333-${String(i).padStart(12, '0')}`,
      name: `r${i}`,
      pattern: 'abc',
      action: 'log' as const,
    }));
    expect(dlpConfigSchema.safeParse({ customRules: rules }).success).toBe(false);
  });

  it('rejects an unsafe pattern inside a custom rule', () => {
    expect(
      dlpCustomRuleSchema.safeParse({
        id: RULE_ID,
        name: 'bad',
        pattern: '(a+)+$',
        action: 'block',
      }).success,
    ).toBe(false);
  });
});

describe('validateDlpPattern — ReDoS guards', () => {
  const rejected: Array<[string, string]> = [
    ['(a+)+$', 'nested_quantifier'],
    ['(\\d{2,})*', 'nested_quantifier'],
    ['(x*)+', 'nested_quantifier'],
    ['(abc)\\1', 'backreference_not_allowed'],
    ['[unclosed', 'invalid_regex'],
    ['a'.repeat(DLP_MAX_PATTERN_LENGTH + 1), 'pattern_too_long'],
  ];
  it.each(rejected)('rejects %s (%s)', (pattern, reason) => {
    const v = validateDlpPattern(pattern);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe(reason);
  });

  const accepted = ['EMP-\\d{6}', '\\bACME-[A-Z]{2}\\d{4}\\b', '(colou?r){1,3}', 'invoice #?\\d+'];
  it.each(accepted)('accepts %s', (pattern) => {
    expect(validateDlpPattern(pattern)).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL** (module does not exist)

```bash
cd /Users/toddhebebrand/breeze/packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/validators/clientAiDlp.test.ts
```

Expected: failure — `Cannot find module './clientAiDlp'`.

- [ ] **Step 3: Create `packages/shared/src/validators/clientAiDlp.ts`**

```ts
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
    id: z.string().uuid(),
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
  .default({});

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
  .strict()
  .default({});
export type DlpConfig = z.infer<typeof dlpConfigSchema>;

/** The materialised defaults — what an untouched org gets. */
export const DEFAULT_DLP_CONFIG: DlpConfig = dlpConfigSchema.parse({});
```

- [ ] **Step 4: Add the barrel export** — in `packages/shared/src/validators/index.ts`, directly after the existing `export * from './ticketConfig';` line, add:

```ts
export * from './clientAiDlp';
```

- [ ] **Step 5: Run the test, expect PASS** (same command as Step 2 — 17 tests). Also run the package typecheck:

```bash
cd /Users/toddhebebrand/breeze/packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/clientAiDlp.ts packages/shared/src/validators/clientAiDlp.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(client-ai): dlp_config schema + custom-pattern safety validator" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Credit-card (Luhn) and SSN detectors (TDD)

False-positive trade-offs (documented here, cited in code comments):
- **creditCard:** any 13–19 digit run (single space/dash separators allowed) that passes Luhn. Luhn passes ~10% of random digit runs — that residual FP rate is the spec'd accepted bound (spec §6: "credit cards (Luhn-validated)"). Runs of 20+ digits never match, not even a sub-span (both edges are digit-lookaround pinned), so long numeric IDs are safe.
- **ssn:** the dashed form always matches (after area/group/serial plausibility: area ∉ {000, 666, 900–999}, group ≠ 00, serial ≠ 0000). The bare 9-digit form is gated on payload context because bare 9-digit numbers are routinely order IDs, ZIP+4 concatenations, and account numbers in spreadsheets — precision over recall. MSPs wanting aggressive matching can add a `\d{9}` custom rule.

**Files:**
- Create: apps/api/src/services/clientAiDlpDetectors.ts
- Create: apps/api/src/services/clientAiDlpDetectors.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiDlpDetectors.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  detectCreditCard,
  detectSsn,
  luhnCheck,
  ssnContextPresent,
} from './clientAiDlpDetectors';

describe('luhnCheck', () => {
  it.each([
    ['4111111111111111', true], // Visa 16-digit test number
    ['378282246310005', true], // Amex 15-digit test number
    ['4222222222222', true], // Visa 13-digit test number
    ['4111111111111112', false], // checksum off by one
    ['1234567890123456', false],
  ])('%s → %s', (digits, expected) => {
    expect(luhnCheck(digits)).toBe(expected);
  });

  it('rejects out-of-range lengths', () => {
    expect(luhnCheck('411111111111')).toBe(false); // 12 digits
    expect(luhnCheck('41111111111111111111')).toBe(false); // 20 digits
  });
});

describe('detectCreditCard', () => {
  it.each([
    ['plain 16-digit', 'card 4111111111111111 ok', 1],
    ['dash separators', 'card 4111-1111-1111-1111', 1],
    ['space separators', '4111 1111 1111 1111', 1],
    ['Amex 15-digit', 'amex 378282246310005', 1],
    ['Visa 13-digit', '4222222222222', 1],
    ['Luhn-invalid 16 digits NOT matched', '4111111111111112', 0],
    ['12 digits too short', '411111111111', 0],
    ['inside a 20-digit run — no sub-span matching', '41111111111111110000', 0],
    ['two cards', '4111111111111111 and 4111-1111-1111-1111', 2],
  ])('%s', (_name, text, hits) => {
    expect(detectCreditCard(text)).toHaveLength(hits);
  });

  it('returns exact spans', () => {
    expect(detectCreditCard('pay 4111111111111111 now')).toEqual([{ start: 4, end: 20 }]);
  });
});

describe('detectSsn', () => {
  it.each([
    ['dashed form, no context needed', 'id 536-22-1234', false, 1],
    ['invalid area 000', '000-12-3456', false, 0],
    ['invalid area 666', '666-12-3456', false, 0],
    ['invalid area 9xx', '912-12-3456', false, 0],
    ['invalid group 00', '536-00-1234', false, 0],
    ['invalid serial 0000', '536-22-0000', false, 0],
    ['bare 9 digits without context', 'id 536221234', false, 0],
    ['bare 9 digits with context active', 'num 536221234', true, 1],
    ['bare digits inside a longer run', 'ref 5362212345', true, 0],
    ['bare implausible area even with context', 'num 666221234', true, 0],
  ])('%s', (_name, text, contextActive, hits) => {
    expect(detectSsn(text, contextActive)).toHaveLength(hits);
  });

  it('ssnContextPresent detects keywords', () => {
    expect(ssnContextPresent('Employee SSN list')).toBe(true);
    expect(ssnContextPresent('social security numbers')).toBe(true);
    expect(ssnContextPresent('sales figures')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiDlpDetectors.test.ts
```

Expected: failure — `Cannot find module './clientAiDlpDetectors'`.

- [ ] **Step 3: Create `apps/api/src/services/clientAiDlpDetectors.ts`**

```ts
/**
 * Built-in DLP detectors for Breeze AI for Office (spec §6).
 *
 * Pure functions: string in → match spans out. Validation gates (Luhn for
 * cards, mod-97 for IBAN, plausibility for SSN, mixed-class post-filters for
 * generic token blobs) keep false positives down; the residual trade-offs are
 * documented per detector in the Plan-3 doc
 * (docs/superpowers/plans/ai-mcp/2026-06-12-ai-for-office-3-dlp.md, Tasks 2–3).
 *
 * The apiKey shapes are seeded from BARE_SECRET_PATTERNS in
 * services/aiToolOutput.ts (sk-, GitHub token family, github_pat_, AKIA, JWT)
 * plus Breeze brz_ tokens (services/apiKeys.ts generates brz_ + 48 hex) and
 * generic 32+ char hex/base64 bearer-ish blobs.
 *
 * (services/aiInputSanitizer.ts was reviewed as a seed source per spec §6:
 * its patterns target prompt-injection/Unicode, not PII/secrets, so nothing
 * is reused from it — the secret shapes above come from aiToolOutput.ts.)
 */

export interface DlpMatch {
  /** Inclusive start offset in the scanned string. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** Merge overlapping/nested spans (sorted output). Used per-detector and by the engine. */
export function mergeMatches(matches: DlpMatch[]): DlpMatch[] {
  if (matches.length <= 1) return matches;
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: DlpMatch[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

function spansOf(text: string, re: RegExp): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const m of text.matchAll(re)) {
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

// ── creditCard ───────────────────────────────────────────────────────────────
// 13–19 digits with optional single space/dash separators, Luhn-validated.
// The digit lookarounds pin BOTH edges, so runs of 20+ digits never match —
// not even a sub-span (long numeric IDs are safe).
const CARD_CANDIDATE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

export function luhnCheck(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectCreditCard(text: string): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  return out;
}

// ── ssn ──────────────────────────────────────────────────────────────────────
const SSN_DASHED = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const SSN_BARE = /(?<![\d.-])\d{9}(?![\d.-])/g;
const SSN_CONTEXT = /\bssns?\b|social\s*security/i;

/** Engine computes this over the WHOLE payload to activate bare-9-digit matching. */
export function ssnContextPresent(text: string): boolean {
  return SSN_CONTEXT.test(text);
}

function plausibleSsn(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  if (a === 0 || a === 666 || a >= 900) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

export function detectSsn(text: string, bareContextActive: boolean): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const m of text.matchAll(SSN_DASHED)) {
    if (plausibleSsn(m[1], m[2], m[3])) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  if (bareContextActive) {
    for (const m of text.matchAll(SSN_BARE)) {
      const v = m[0];
      if (plausibleSsn(v.slice(0, 3), v.slice(3, 5), v.slice(5))) {
        out.push({ start: m.index ?? 0, end: (m.index ?? 0) + v.length });
      }
    }
  }
  return mergeMatches(out);
}

// ── iban ─────────────────────────────────────────────────────────────────────
// Unspaced canonical IBAN shape (spec §6 pattern). Spaced presentation
// ("DE89 3704 ...") is a documented v1 non-goal.
const IBAN_CANDIDATE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

/** ISO 13616 mod-97: move first 4 chars to the end, A→10..Z→35, remainder must be 1. */
export function ibanMod97(candidate: string): boolean {
  const rearranged = candidate.slice(4) + candidate.slice(0, 4);
  let remainder = 0;
  for (let i = 0; i < rearranged.length; i++) {
    const ch = rearranged[i];
    const value = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (let j = 0; j < value.length; j++) {
      const digit = value.charCodeAt(j) - 48;
      if (digit < 0 || digit > 9) return false;
      remainder = (remainder * 10 + digit) % 97;
    }
  }
  return remainder === 1;
}

export function detectIban(text: string): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const m of text.matchAll(IBAN_CANDIDATE)) {
    if (ibanMod97(m[0])) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  return out;
}

// ── apiKey ───────────────────────────────────────────────────────────────────
// Specific token shapes — seeded from BARE_SECRET_PATTERNS in
// services/aiToolOutput.ts, plus Breeze brz_ tokens (services/apiKeys.ts).
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\bbrz_[0-9a-f]{32,64}\b/g,
];

// Bearer-ish generic blobs: 32+ char hex / base64 runs, post-filtered for
// mixed character classes so plain words and plain numbers never match.
// Residual FP: 32+ char mixed-case alphanumeric identifiers will match —
// accepted (spec asks for bearer-ish blobs; action is redact by default and
// the MSP can set apiKey to 'off').
const HEX_BLOB = /\b[0-9a-f]{32,128}\b/g;
const BASE64_BLOB = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,256}={0,2}(?![A-Za-z0-9+/=])/g;

export function detectApiKey(text: string): DlpMatch[] {
  const out: DlpMatch[] = [];
  for (const re of API_KEY_PATTERNS) {
    out.push(...spansOf(text, re));
  }
  for (const m of text.matchAll(HEX_BLOB)) {
    const v = m[0];
    if (/\d/.test(v) && /[a-f]/.test(v)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + v.length });
    }
  }
  for (const m of text.matchAll(BASE64_BLOB)) {
    const v = m[0];
    if (/[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + v.length });
    }
  }
  // JWTs/keys often double-match the generic blobs — merge so counts are honest.
  return mergeMatches(out);
}

// ── email / phone (off by default) ───────────────────────────────────────────
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// NANP-ish with required separators or +country/parens. Bare 10-digit runs do
// NOT match (precision-first — they collide with IDs and partial card runs).
const PHONE =
  /(?<![\d.-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?![\d-])/g;

export function detectEmail(text: string): DlpMatch[] {
  return spansOf(text, EMAIL);
}

export function detectPhone(text: string): DlpMatch[] {
  return spansOf(text, PHONE);
}
```

- [ ] **Step 4: Run, expect PASS** (same command as Step 2 — the iban/apiKey/email/phone exports exist but are untested until Task 3; that is fine, Task 3 adds their tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiDlpDetectors.ts apps/api/src/services/clientAiDlpDetectors.test.ts
git commit -m "feat(client-ai): DLP detectors — credit card (Luhn), SSN, IBAN (mod-97), API keys, email, phone" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

> Note: the full detector file ships in this task (splitting the file mid-way would churn it); Task 3 is purely the remaining detectors' test coverage, written before any further engine work depends on them.

---

### Task 3: IBAN / apiKey / email / phone detector tests (TDD coverage completion)

**Files:**
- Edit: apps/api/src/services/clientAiDlpDetectors.test.ts

- [ ] **Step 1: Append these describe blocks** to `clientAiDlpDetectors.test.ts` (extend the existing import line with `detectApiKey, detectEmail, detectIban, detectPhone, ibanMod97, mergeMatches`):

```ts
describe('ibanMod97', () => {
  it('validates the rearranged mod-97 == 1 rule', () => {
    expect(ibanMod97('DE89370400440532013000')).toBe(true);
    expect(ibanMod97('GB82WEST12345698765432')).toBe(true);
    expect(ibanMod97('DE89370400440532013001')).toBe(false); // single digit mutated
  });
});

describe('detectIban', () => {
  it.each([
    ['German IBAN', 'acct DE89370400440532013000', 1],
    ['UK IBAN', 'GB82WEST12345698765432', 1],
    ['mod-97 invalid NOT matched', 'DE89370400440532013001', 0],
    ['lowercase not matched (canonical uppercase shape only)', 'de89370400440532013000', 0],
    ['too short', 'DE8937040044', 0],
  ])('%s', (_name, text, hits) => {
    expect(detectIban(text)).toHaveLength(hits);
  });
});

describe('detectApiKey', () => {
  it.each([
    ['anthropic-style key', 'key sk-ant-abcdefghijklmnop1234', 1],
    ['github pat', 'ghp_abcdefghijklmnop1234', 1],
    ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', 1],
    ['breeze brz_ token', `brz_${'ab12'.repeat(12)}`, 1],
    [
      'jwt (merged with its base64 segments)',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N7flQ',
      1,
    ],
    ['generic 32-char hex blob', 'token 3fa85f6457174562b3fc2c963f66afa6', 1],
    ['generic mixed-class base64 blob', 'dGhpc0lzQVZlcnlMb25nU2VjcmV0VG9rZW4xMjM0', 1],
    ['all-letter run NOT matched', 'abcdefabcdefabcdefabcdefabcdefab', 0],
    ['digits-only run NOT matched', '11111111111111111111111111111111', 0],
    ['short hex NOT matched', 'deadbeef1234', 0],
  ])('%s', (_name, text, hits) => {
    expect(detectApiKey(text)).toHaveLength(hits);
  });
});

describe('detectEmail', () => {
  it('matches standard addresses', () => {
    expect(detectEmail('contact alice@example.com today')).toHaveLength(1);
  });
  it('ignores non-addresses', () => {
    expect(detectEmail('not an email @ nowhere')).toHaveLength(0);
  });
});

describe('detectPhone', () => {
  it.each([
    ['dashed NANP', 'call 555-123-4567', 1],
    ['parenthesised area code', '(555) 123-4567', 1],
    ['dotted', '555.123.4567', 1],
    ['international prefix', '+1 555 123 4567', 1],
    ['bare 10-digit run NOT matched (precision-first)', '5551234567', 0],
    ['not inside card numbers', '4111-1111-1111-1111', 0],
  ])('%s', (_name, text, hits) => {
    expect(detectPhone(text)).toHaveLength(hits);
  });
});

describe('mergeMatches', () => {
  it('merges overlapping and nested spans', () => {
    expect(
      mergeMatches([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 20, end: 25 },
        { start: 21, end: 23 },
      ]),
    ).toEqual([
      { start: 0, end: 15 },
      { start: 20, end: 25 },
    ]);
  });
});
```

- [ ] **Step 2: Run, expect PASS** (these detectors already exist from Task 2; if any fixture fails, fix the DETECTOR, not the fixture — the fixtures encode the contract):

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiDlpDetectors.test.ts
```

Expected: ~51 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/clientAiDlpDetectors.test.ts
git commit -m "test(client-ai): IBAN/apiKey/email/phone detector fixtures incl. mod-97 negatives" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The scanning engine — applyDlp (TDD)

Replaces the Plan-2 passthrough stub internals of `apps/api/src/services/clientAiDlp.ts` (or creates the file if Plan 2 has not landed). Interface pinned — see the contract section above.

**Files:**
- Replace/Create: apps/api/src/services/clientAiDlp.ts
- Create: apps/api/src/services/clientAiDlp.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/clientAiDlp.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { applyDlp, DLP_MAX_CELL_CHARS } from './clientAiDlp';

const ORG = '0a1b2c3d-1111-4222-8333-444455556666';
const RULE_ID = '0b8f8f54-1111-4222-8333-444455556666';

const VISA = '4111111111111111'; // Luhn-valid test number
const VISA_SPACED = '4111 1111 1111 1111';
const IBAN = 'DE89370400440532013000'; // mod-97 valid
const SK_KEY = 'sk-ant-abcdefghijklmnop1234';

describe('applyDlp — config handling', () => {
  it('treats {} as the documented defaults (financial redact, email/phone off)', async () => {
    const r = await applyDlp({
      text: `card ${VISA} mail alice@example.com`,
      dlpConfig: {},
      orgId: ORG,
    });
    expect(r.action).toBe('allow');
    expect(r.text).toContain('[REDACTED:creditCard]');
    expect(r.text).toContain('alice@example.com'); // email off by default
    expect(r.redactions).toEqual([{ rule: 'creditCard', count: 1, location: 'text' }]);
  });

  it('degrades an invalid stored config to defaults (never to off)', async () => {
    const r = await applyDlp({
      text: `card ${VISA}`,
      dlpConfig: { creditCards: 'nope' }, // strict-parse failure
      orgId: ORG,
    });
    expect(r.text).toContain('[REDACTED:creditCard]');
  });

  it('passes clean payloads through untouched', async () => {
    const r = await applyDlp({ text: 'sum column B please', dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', text: 'sum column B please', redactions: [] });
  });

  it('handles empty input (no text, no cells)', async () => {
    const r = await applyDlp({ dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', redactions: [] });
  });
});

describe('applyDlp — action precedence (block > redact > log)', () => {
  it('any block-rule match blocks the whole payload with no partial results', async () => {
    const r = await applyDlp({
      text: `${VISA} and ${IBAN}`,
      dlpConfig: { builtins: { iban: 'block' } },
      orgId: ORG,
    });
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('dlp_blocked:iban');
    expect(r.text).toBeUndefined();
    expect(r.cells).toBeUndefined();
    // value-free events still recorded for the MSP audit view
    expect(r.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'iban', count: 1 }),
        expect.objectContaining({ rule: 'creditCard', count: 1 }),
      ]),
    );
  });

  it('a custom block rule wins over builtin redacts', async () => {
    const r = await applyDlp({
      text: `${VISA} PROJECT-AURORA`,
      dlpConfig: {
        customRules: [
          { id: RULE_ID, name: 'Codename', pattern: 'PROJECT-[A-Z]+', action: 'block' },
        ],
      },
      orgId: ORG,
    });
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('dlp_blocked:Codename');
  });

  it('log rules record events without modifying content', async () => {
    const r = await applyDlp({
      text: 'mail alice@example.com',
      dlpConfig: { builtins: { email: 'log' } },
      orgId: ORG,
    });
    expect(r.action).toBe('allow');
    expect(r.text).toBe('mail alice@example.com');
    expect(r.redactions).toEqual([{ rule: 'email', count: 1, location: 'text' }]);
  });

  it('custom redact rules replace with [REDACTED:<name>]', async () => {
    const r = await applyDlp({
      text: 'badge EMP-123456 active',
      dlpConfig: {
        customRules: [{ id: RULE_ID, name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' }],
      },
      orgId: ORG,
    });
    expect(r.text).toBe('badge [REDACTED:Employee ID] active');
    expect(r.redactions).toEqual([{ rule: 'Employee ID', count: 1, location: 'text' }]);
  });

  it('overlapping redact spans merge into a single token', async () => {
    const r = await applyDlp({
      text: VISA,
      dlpConfig: {
        customRules: [{ id: RULE_ID, name: 'quad', pattern: '\\d{4}', action: 'redact' }],
      },
      orgId: ORG,
    });
    // creditCard span [0,16) and the custom quads merge into one token
    expect(r.text).toMatch(/^\[REDACTED:[^\]]+\]$/);
  });
});

describe('applyDlp — cell matrices', () => {
  it('redacts within cells, preserves untouched cells and their types', async () => {
    const cells = [
      ['Name', 'Card', 'Balance'],
      ['Alice', VISA_SPACED, 1200.5],
      ['Bob', `note ${VISA} end`, true],
    ];
    const r = await applyDlp({ cells, dlpConfig: {}, orgId: ORG });
    expect(r.action).toBe('allow');
    expect(r.cells![0]).toEqual(['Name', 'Card', 'Balance']);
    expect(r.cells![1][1]).toBe('[REDACTED:creditCard]');
    expect(r.cells![1][2]).toBe(1200.5);
    expect(r.cells![2][1]).toBe('note [REDACTED:creditCard] end');
    expect(r.cells![2][2]).toBe(true);
    expect(r.redactions).toEqual([
      { rule: 'creditCard', count: 2, location: 'cell[1][1] (+1 more)' },
    ]);
  });

  it('stringifies numeric cells before scanning (Excel stores card numbers as numbers)', async () => {
    const r = await applyDlp({ cells: [[4111111111111111]], dlpConfig: {}, orgId: ORG });
    expect(r.cells![0][0]).toBe('[REDACTED:creditCard]');
  });

  it('leaves null/undefined/empty cells alone', async () => {
    const r = await applyDlp({ cells: [[null, undefined, '']], dlpConfig: {}, orgId: ORG });
    expect(r.cells).toEqual([[null, undefined, '']]);
    expect(r.redactions).toEqual([]);
  });

  it('does not mutate the input matrix', async () => {
    const cells = [[VISA]];
    await applyDlp({ cells, dlpConfig: {}, orgId: ORG });
    expect(cells[0][0]).toBe(VISA);
  });

  it('activates bare-SSN matching from a header cell elsewhere in the payload', async () => {
    const withHeader = await applyDlp({ cells: [['SSN'], ['536221234']], dlpConfig: {}, orgId: ORG });
    expect(withHeader.cells![1][0]).toBe('[REDACTED:ssn]');

    const noContext = await applyDlp({ cells: [['ID'], ['536221234']], dlpConfig: {}, orgId: ORG });
    expect(noContext.cells![1][0]).toBe('536221234');
  });

  it('dashed SSNs in cells redact without any context', async () => {
    const r = await applyDlp({ cells: [['536-22-1234']], dlpConfig: {}, orgId: ORG });
    expect(r.cells![0][0]).toBe('[REDACTED:ssn]');
  });

  it('scans text and cells in the same call', async () => {
    const r = await applyDlp({ text: `IBAN ${IBAN}`, cells: [[VISA]], dlpConfig: {}, orgId: ORG });
    expect(r.text).toBe('IBAN [REDACTED:iban]');
    expect(r.cells![0][0]).toBe('[REDACTED:creditCard]');
  });
});

describe('applyDlp — redaction event accuracy', () => {
  it('reports rule, total count, and first location with overflow note', async () => {
    const r = await applyDlp({
      text: VISA,
      cells: [[VISA, `${VISA} ${VISA}`]],
      dlpConfig: {},
      orgId: ORG,
    });
    expect(r.redactions).toEqual([{ rule: 'creditCard', count: 4, location: 'text (+2 more)' }]);
  });
});

describe('applyDlp — size caps (fail closed)', () => {
  it('blocks when cell count exceeds DLP_MAX_CELLS', async () => {
    const rows = Array.from({ length: 501 }, () => new Array(100).fill('x')); // 50,100 cells
    const r = await applyDlp({ cells: rows, dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({
      action: 'block',
      blockReason: 'payload_too_large_for_dlp',
      redactions: [],
    });
  });

  it('blocks when a single cell exceeds the per-cell char cap', async () => {
    const r = await applyDlp({
      cells: [['a'.repeat(DLP_MAX_CELL_CHARS + 1)]],
      dlpConfig: {},
      orgId: ORG,
    });
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('payload_too_large_for_dlp');
  });
});

describe('applyDlp — idempotency', () => {
  it('re-scanning redacted output produces no new findings', async () => {
    const first = await applyDlp({
      text: `card ${VISA}, ssn 536-22-1234, iban ${IBAN}, key ${SK_KEY}, brz_${'ab12'.repeat(12)}`,
      dlpConfig: {},
      orgId: ORG,
    });
    expect(first.action).toBe('allow');
    expect(first.redactions.length).toBeGreaterThan(0);

    const second = await applyDlp({ text: first.text!, dlpConfig: {}, orgId: ORG });
    expect(second.redactions).toEqual([]);
    expect(second.text).toBe(first.text);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiDlp.test.ts
```

Expected: failures — against the Plan-2 passthrough stub everything that asserts redaction/blocking fails; if the file doesn't exist yet, module-not-found.

- [ ] **Step 3: Write `apps/api/src/services/clientAiDlp.ts`** (full replacement of the stub body; interface unchanged)

```ts
/**
 * Client AI DLP / redaction pipeline (spec §6) — the single chokepoint for
 * every payload leaving Breeze for the model provider: user prompts, workbook
 * tool_result cell matrices, and template content. The call sites live in the
 * Plan-2 session loop; this module owns only the scanning.
 *
 * Order of operations: size guard → scan all enabled rules → block (any
 * block-rule match refuses the whole payload, no partial results) → redact
 * ([REDACTED:<rule>] in place) → log (events only).
 *
 * Config handling: dlpConfig arrives as unknown (jsonb via getOrgPolicy).
 * Invalid configs degrade to DEFAULT_DLP_CONFIG — financial/credential
 * redaction stays ON, never "everything off". Note this also drops the custom
 * rules of an invalid config; acceptable because the policy PUT path
 * validates with the same schema, so invalid rows only arise from
 * out-of-band DB writes.
 *
 * Fail-closed guards: oversize payloads (cells/chars caps) and scan-budget
 * exhaustion BLOCK rather than pass unscanned content — passing unscanned
 * data would defeat the chokepoint. Plan 2's read tools chunk well below the
 * caps, so tripping one is a tool-layer bug that should surface loudly.
 *
 * Pure computation: no DB, no Redis, no db-access-context requirements.
 */

import {
  DEFAULT_DLP_CONFIG,
  dlpConfigSchema,
  type DlpConfig,
  type DlpRuleAction,
} from '@breeze/shared/validators';
import {
  detectApiKey,
  detectCreditCard,
  detectEmail,
  detectIban,
  detectPhone,
  detectSsn,
  ssnContextPresent,
  type DlpMatch,
} from './clientAiDlpDetectors';

export interface DlpRedactionEvent {
  rule: string;
  count: number;
  location: string;
}

export interface DlpResult {
  action: 'allow' | 'block';
  text?: string;
  cells?: unknown[][];
  redactions: DlpRedactionEvent[];
  blockReason?: string;
}

/** Hard cap on scanned cells per call. Exceeding it BLOCKS (fail closed). */
export const DLP_MAX_CELLS = 50_000;
/** Excel's own cell limit is 32,767 chars; anything bigger is not workbook data. */
export const DLP_MAX_CELL_CHARS = 32_768;
/** Hard cap on total scanned characters per call (text + stringified cells). */
export const DLP_MAX_TOTAL_CHARS = 2_000_000;
/** Wall-clock budget for one applyDlp call; exceeding it BLOCKS (fail closed). */
export const DLP_SCAN_BUDGET_MS = 2_000;

const BUILTIN_ORDER = ['creditCard', 'ssn', 'iban', 'apiKey', 'email', 'phone'] as const;

interface CompiledRule {
  name: string;
  action: DlpRuleAction;
  detect: (text: string) => DlpMatch[];
}

interface ScanLocation {
  label: string;
  content: string;
  /** [row, col] for cells; null for the text input. */
  coords: [number, number] | null;
}

function block(reason: string, redactions: DlpRedactionEvent[] = []): DlpResult {
  return { action: 'block', blockReason: reason, redactions };
}

function stringifyCell(cell: unknown): string | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'string') return cell === '' ? null : cell;
  if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'bigint') {
    return String(cell);
  }
  try {
    return JSON.stringify(cell) ?? null;
  } catch {
    // Circular / non-serializable — nothing scannable, and the SSE layer
    // cannot forward it to the provider as JSON either. Leave untouched.
    return null;
  }
}

/** Compile the enabled rule list, or return a block reason (fail closed). */
function compileRules(config: DlpConfig, ssnActive: boolean): CompiledRule[] | string {
  const builtinDetectors: Record<(typeof BUILTIN_ORDER)[number], (text: string) => DlpMatch[]> = {
    creditCard: detectCreditCard,
    ssn: (text) => detectSsn(text, ssnActive),
    iban: detectIban,
    apiKey: detectApiKey,
    email: detectEmail,
    phone: detectPhone,
  };

  const rules: CompiledRule[] = [];
  for (const name of BUILTIN_ORDER) {
    const setting = config.builtins[name];
    if (setting === 'off') continue;
    rules.push({ name, action: setting, detect: builtinDetectors[name] });
  }

  for (const custom of config.customRules) {
    let re: RegExp;
    try {
      re = new RegExp(custom.pattern, 'gu');
    } catch {
      // The shared schema compiles every pattern at save time, so this is
      // only reachable for out-of-band DB writes. Fail CLOSED: silently
      // skipping a rule the MSP believes is active would disable DLP
      // without anyone noticing.
      return `dlp_rule_compile_failed:${custom.name}`;
    }
    rules.push({
      name: custom.name,
      action: custom.action,
      detect: (text: string) => {
        const out: DlpMatch[] = [];
        for (const m of text.matchAll(re)) {
          if (m[0].length === 0) break; // zero-width match safety
          out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
        }
        return out;
      },
    });
  }
  return rules;
}

/** Replace spans right-to-left; overlapping spans merge, earliest span's rule labels the token. */
function replaceSpans(content: string, spans: Array<{ span: DlpMatch; rule: string }>): string {
  const sorted = [...spans].sort(
    (a, b) => a.span.start - b.span.start || a.span.end - b.span.end,
  );
  const merged: Array<{ start: number; end: number; rule: string }> = [];
  for (const { span, rule } of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end, rule });
    }
  }
  let out = content;
  for (let i = merged.length - 1; i >= 0; i--) {
    const m = merged[i];
    out = `${out.slice(0, m.start)}[REDACTED:${m.rule}]${out.slice(m.end)}`;
  }
  return out;
}

export async function applyDlp(input: {
  text?: string;
  cells?: unknown[][];
  dlpConfig: unknown;
  orgId: string;
}): Promise<DlpResult> {
  const started = Date.now();

  const parsedConfig = dlpConfigSchema.safeParse(input.dlpConfig ?? {});
  const config: DlpConfig = parsedConfig.success ? parsedConfig.data : DEFAULT_DLP_CONFIG;

  // ── Bound + collect scan locations (fail closed on oversize) ──────────────
  const locations: ScanLocation[] = [];
  let totalChars = 0;

  if (typeof input.text === 'string') {
    totalChars += input.text.length;
    if (totalChars > DLP_MAX_TOTAL_CHARS) return block('payload_too_large_for_dlp');
    locations.push({ label: 'text', content: input.text, coords: null });
  }

  if (input.cells !== undefined) {
    let cellCount = 0;
    for (let r = 0; r < input.cells.length; r++) {
      const row = input.cells[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        cellCount += 1;
        if (cellCount > DLP_MAX_CELLS) return block('payload_too_large_for_dlp');
        const content = stringifyCell(row[c]);
        if (content === null) continue;
        if (content.length > DLP_MAX_CELL_CHARS) return block('payload_too_large_for_dlp');
        totalChars += content.length;
        if (totalChars > DLP_MAX_TOTAL_CHARS) return block('payload_too_large_for_dlp');
        locations.push({ label: `cell[${r}][${c}]`, content, coords: [r, c] });
      }
    }
  }

  // Bare-9-digit SSN matching activates when an SSN keyword appears ANYWHERE
  // in the payload (covers "SSN" header cells above bare-number columns).
  const ssnActive = locations.some((l) => ssnContextPresent(l.content));

  const compiled = compileRules(config, ssnActive);
  if (typeof compiled === 'string') return block(compiled);

  // ── Scan every location with every enabled rule ────────────────────────────
  interface LocationMatches {
    rule: CompiledRule;
    spans: DlpMatch[];
  }
  const perLocation: LocationMatches[][] = locations.map(() => []);
  const perRule = new Map<string, { count: number; locations: string[] }>();
  let blockedBy: string | null = null;

  for (const rule of compiled) {
    for (let i = 0; i < locations.length; i++) {
      if (Date.now() - started > DLP_SCAN_BUDGET_MS) return block('dlp_scan_budget_exceeded');
      const spans = rule.detect(locations[i].content);
      if (spans.length === 0) continue;
      perLocation[i].push({ rule, spans });
      const agg = perRule.get(rule.name) ?? { count: 0, locations: [] };
      agg.count += spans.length;
      agg.locations.push(locations[i].label);
      perRule.set(rule.name, agg);
      if (rule.action === 'block' && blockedBy === null) blockedBy = rule.name;
    }
  }

  // Per-rule aggregated, value-free events (≤ 6 builtins + 50 custom rules).
  const redactions: DlpRedactionEvent[] = [];
  for (const [rule, agg] of perRule) {
    const location =
      agg.locations.length === 1
        ? agg.locations[0]
        : `${agg.locations[0]} (+${agg.locations.length - 1} more)`;
    redactions.push({ rule, count: agg.count, location });
  }

  // ── 1. Block wins outright: no partial results. Events stay so the MSP
  //       audit view can show what tripped (rule/count/location only — no
  //       sensitive values). ──────────────────────────────────────────────────
  if (blockedBy !== null) {
    return { action: 'block', blockReason: `dlp_blocked:${blockedBy}`, redactions };
  }

  // ── 2. Redact (3. log rules contribute events only, content untouched) ─────
  const result: DlpResult = { action: 'allow', redactions };
  let outCells: unknown[][] | null = null;
  if (input.cells !== undefined) {
    outCells = input.cells.map((row) => [...(row ?? [])]); // never mutate the input
    result.cells = outCells;
  }
  if (typeof input.text === 'string') result.text = input.text;

  for (let i = 0; i < locations.length; i++) {
    const spans: Array<{ span: DlpMatch; rule: string }> = [];
    for (const { rule, spans: ruleSpans } of perLocation[i]) {
      if (rule.action !== 'redact') continue;
      for (const span of ruleSpans) spans.push({ span, rule: rule.name });
    }
    if (spans.length === 0) continue;
    const redacted = replaceSpans(locations[i].content, spans);
    const coords = locations[i].coords;
    if (coords === null) {
      result.text = redacted;
    } else {
      // Numeric/object cells that matched become redacted STRINGS by design.
      outCells![coords[0]][coords[1]] = redacted;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run, expect PASS** (same command as Step 2 — 19 tests). Also re-run the detector suite to confirm nothing regressed:

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiDlp.test.ts src/services/clientAiDlpDetectors.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/clientAiDlp.ts apps/api/src/services/clientAiDlp.test.ts
git commit -m "feat(client-ai): DLP scanning engine — applyDlp with block/redact/log precedence" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Validate dlp_config on the policy PUT path (TDD)

Plan 1's `putPolicySchema` (apps/api/src/routes/clientAi/schemas.ts) currently accepts `dlpConfig: z.record(z.unknown()).optional()`. Tighten it to the shared schema so the policy editor cannot persist a config the engine would reject (which would silently degrade the org to defaults). Persisted values become the **normalized** full shape (defaults filled) — canonical storage. No route-handler change needed: the PUT handler already persists `body.dlpConfig` only when provided.

**Files:**
- Edit: apps/api/src/routes/clientAi/schemas.ts
- Create: apps/api/src/routes/clientAi/schemas.dlp.test.ts

- [ ] **Step 1: Write the failing test** — `apps/api/src/routes/clientAi/schemas.dlp.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { putPolicySchema } from './schemas';

const RULE_ID = '0b8f8f54-1111-4222-8333-444455556666';

describe('putPolicySchema.dlpConfig', () => {
  it('accepts a valid dlp config and normalizes defaults into the stored shape', () => {
    const parsed = putPolicySchema.parse({ dlpConfig: { builtins: { email: 'redact' } } });
    expect(parsed.dlpConfig).toEqual({
      builtins: {
        creditCard: 'redact',
        ssn: 'redact',
        iban: 'redact',
        apiKey: 'redact',
        email: 'redact',
        phone: 'off',
      },
      customRules: [],
    });
  });

  it('leaves dlpConfig undefined when omitted (partial-PUT semantics)', () => {
    expect(putPolicySchema.parse({ enabled: true }).dlpConfig).toBeUndefined();
  });

  it('rejects unknown builtin keys', () => {
    expect(
      putPolicySchema.safeParse({ dlpConfig: { builtins: { creditCards: 'redact' } } }).success,
    ).toBe(false);
  });

  it('rejects unsafe custom patterns (ReDoS heuristic)', () => {
    expect(
      putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [{ id: RULE_ID, name: 'bad', pattern: '(a+)+$', action: 'redact' }],
        },
      }).success,
    ).toBe(false);
  });

  it('accepts a safe custom rule', () => {
    expect(
      putPolicySchema.safeParse({
        dlpConfig: {
          customRules: [
            { id: RULE_ID, name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' },
          ],
        },
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/schemas.dlp.test.ts
```

Expected: the "normalizes defaults" / "rejects unknown builtin keys" / "rejects unsafe custom patterns" tests fail against `z.record(z.unknown())`.

- [ ] **Step 3: Edit `apps/api/src/routes/clientAi/schemas.ts`** — two changes:

Add to the imports at the top of the file:

```ts
import { dlpConfigSchema } from '@breeze/shared/validators';
```

In `putPolicySchema`, replace the line

```ts
    dlpConfig: z.record(z.unknown()).optional(),
```

with

```ts
    /** Validated + normalized (defaults filled) — see packages/shared/src/validators/clientAiDlp.ts. */
    dlpConfig: dlpConfigSchema.optional(),
```

- [ ] **Step 4: Run, expect PASS** (5 tests). Then run the Plan-1 admin route + policy service suites to confirm no regression (Plan 1's fixtures never PUT a `dlpConfig`, and `getOrgPolicy`'s lenient `Record<string, unknown>` read path is intentionally unchanged — the engine does its own parsing):

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/routes/clientAi/ src/services/clientAiPolicy.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clientAi/schemas.ts apps/api/src/routes/clientAi/schemas.dlp.test.ts
git commit -m "feat(client-ai): validate dlp_config on the policy PUT path" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Redact-before-log contract proof + full verification

Spec §6: `ai_messages` stores the redacted form — the audit trail never retains sensitive values. Plan 2's session-loop plan file does not exist yet (checked 2026-06-12: `docs/superpowers/plans/ai-mcp/2026-06-12-ai-for-office-2-session-loop.md` absent), so the proof is pinned at the `applyDlp` unit level here, with the integration hook noted for the Plan-2 executor.

> **Integration note for the Plan-2 executor:** Plan 2's message-persistence test MUST assert that the `ai_messages` insert mock receives `applyDlp(...).text` (and `result.redactions` in message metadata) — never the raw `input.text`. One assertion in Plan 2's session-route test closes the loop on this contract.

**Files:**
- Edit: apps/api/src/services/clientAiDlp.test.ts

- [ ] **Step 1: Append the contract test** to `apps/api/src/services/clientAiDlp.test.ts`:

```ts
describe('applyDlp — redact-before-log contract (spec §6)', () => {
  it('the persisted form (result.text) never contains the raw sensitive values', async () => {
    const raw = `Card ${VISA_SPACED}, key ${SK_KEY}, acct ${IBAN}`;
    const result = await applyDlp({ text: raw, dlpConfig: {}, orgId: ORG });

    // Plan 2's persistence path MUST store result.text + result.redactions —
    // never input.text. This is the unit-level proof; the integration
    // assertion lives in Plan 2's session-route test (the ai_messages insert
    // mock receives result.text).
    expect(result.action).toBe('allow');
    expect(result.text).not.toContain(VISA_SPACED);
    expect(result.text).not.toContain(SK_KEY);
    expect(result.text).not.toContain(IBAN);
    expect(result.text).toContain('[REDACTED:creditCard]');
    expect(result.text).toContain('[REDACTED:apiKey]');
    expect(result.text).toContain('[REDACTED:iban]');

    // The events persisted alongside are value-free: rule/count/location only.
    for (const event of result.redactions) {
      expect(Object.keys(event).sort()).toEqual(['count', 'location', 'rule']);
    }

    // And storing the redacted form is stable: re-scanning it finds nothing.
    const second = await applyDlp({ text: result.text!, dlpConfig: {}, orgId: ORG });
    expect(second.redactions).toEqual([]);
    expect(second.text).toBe(result.text);
  });
});
```

- [ ] **Step 2: Run, expect PASS**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiDlp.test.ts
```

- [ ] **Step 3: Full verification sweep** — all four new/edited test files plus typechecks:

```bash
cd /Users/toddhebebrand/breeze/packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/validators/clientAiDlp.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm typecheck
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm vitest run src/services/clientAiDlpDetectors.test.ts src/services/clientAiDlp.test.ts src/routes/clientAi/schemas.dlp.test.ts && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: all DLP suites PASS (~93 tests). `tsc --noEmit` may show the pre-existing errors in `agents.test.ts` / `apiKeyAuth.test.ts` (known, unrelated); no NEW errors. Do NOT run the full api vitest suite as a gate — it has known parallel-run flakiness on a pristine tree (verify affected files single-fork; trust CI).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/clientAiDlp.test.ts
git commit -m "test(client-ai): redact-before-log contract proof for the DLP chokepoint" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of scope for this plan (later plans)

- The `applyDlp` **call sites** — user message, tool_result, template content — Plan 2 owns those; this plan must not touch them.
- The policy editor UI for DLP toggles + custom-regex entry with live test box — Plan 4 (it should call `validateDlpPattern` from `@breeze/shared/validators` for the test box, and render `redactions` events in the audit viewer).
- ML-based DLP, spaced-IBAN presentation forms, national IDs beyond US SSN — spec §15 / documented v1 limits.

## Open questions embedded above (for the implementer/reviewer)

1. **Oversize behavior** is block-with-`payload_too_large_for_dlp` (fail closed). If Plan 2's `read_range` legitimately needs >50k cells, raise `DLP_MAX_CELLS` there and here in lockstep — do not switch to partial scanning.
2. **Invalid stored config → defaults** drops that config's custom rules (including custom `block` rules). Safe direction for builtins, debatable for custom blocks; acceptable v1 because the PUT path (Task 5) makes invalid rows out-of-band-only. Revisit if a config-migration ever loosens the schema.
3. **Event `location` for multi-location matches** is `'<first> (+N more)'` — human-oriented for the MSP audit view. If Plan 4 wants machine-parseable per-location drill-down, split the event shape there (the pinned `DlpRedactionEvent` is intentionally minimal).
