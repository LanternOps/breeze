---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 1 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the currency foundations: one shared currency module (codes, minor units, rounding, formatting, validation), a DB-enforced currency allowlist, `organizations.currency_code` with audited backfill and explicit stamping on every creation path, and currency-aware rounding through the money math — without exposing org-currency editing yet.

**Architecture:** All currency knowledge moves to `packages/shared` (single source for API, web, portal). A global `supported_currencies` reference table (forced RLS, public read, system-only write) backs `NOT VALID` FKs from tenant currency columns. Money math keeps its integer-cents discipline internally but gains an optional trailing `currencyCode` parameter that rounds persisted results to the currency's minor-unit exponent (JPY → whole units).

**Tech Stack:** TypeScript, Zod, Drizzle ORM, PostgreSQL (hand-written SQL migrations), Vitest.

**Spec:** `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` (§4 shared module, §5 org currency & stamping, §14 testing). Tracking: `LanternOps/breeze#3772`, this wave = sub-issue **#3773**.

## Global Constraints

- **Migration prefix MUST be `2026-08-27`** (with `-a-`/`-b-` infixes for intra-wave ordering). The repo already ships migrations dated `2026-08-24`…`2026-08-26` on origin/main; a file named with today's date (`2026-08-21`) would sort BEFORE them and replay in the wrong order on a fresh DB. Verify with `ls apps/api/migrations | sort | tail` that your files sort last.
- Migrations are idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `DO $$ ... EXCEPTION`), contain NO inner `BEGIN;`/`COMMIT;`, and every cleanup UPDATE reports row counts via `GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING ...`.
- `organizations.currency_code` gets **NO column DEFAULT** — creation paths stamp explicitly; a missed path must fail loudly (spec §5).
- The supported list is the existing 34 codes from `apps/web/src/lib/currencies.ts` — unchanged in this wave.
- Money storage stays `numeric` major-unit strings (`'1000.00'` for JPY); only *rounding* becomes currency-aware.
- Branch: `feature/3772-multi-currency/wave-3773` (feature-lifecycle: call `start_wave` with that branch before Task 1). PR body must contain `Closes #3773`.
- Test commands: `pnpm --filter @breeze/shared test`, `pnpm --filter @breeze/api test`, `pnpm --filter @breeze/web test`. Integration/RLS suites (need real DB, see `apps/api/vitest.integration.config.ts`): run before the PR — `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <file>`. `pnpm db:check-drift` after schema changes. Fresh worktrees lack gitignored `.env`/`.env.test` — symlink from the main checkout or RLS forge tests pass vacuously.

---

### Task 1: Shared currency core module

**Files:**
- Create: `packages/shared/src/utils/currency.ts`
- Create: `packages/shared/src/utils/currency.test.ts`
- Modify: `packages/shared/src/utils/index.ts` (add `export * from './currency';`)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (later tasks + waves rely on these exact names):
  - `CURRENCY_CODES: readonly string[]`, `type CurrencyCode`
  - `isKnownCurrency(code: string): boolean`
  - `minorUnitExponent(code: string): 0 | 2`
  - `isZeroDecimal(code: string): boolean`
  - `toMinorUnits(amountMajor: string | number, currency: string): number` (throws on non-finite)
  - `fromMinorUnits(minor: string | number, currency: string): string` (always fixed-2 string)
  - `roundToCurrency(value: string | number, currency: string): string` (half-up at the exponent, fixed-2 string)
  - `formatCurrencyAmount(value: string | number, currency: string, locale: string): string` (Intl with bare-code fallback)
  - `currencyLabel(code: string, locale: string): string`, `currencyOptions(current: string): string[]`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/utils/currency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CURRENCY_CODES, isKnownCurrency, minorUnitExponent, isZeroDecimal,
  toMinorUnits, fromMinorUnits, roundToCurrency, formatCurrencyAmount,
} from './currency';

describe('currency core', () => {
  it('curated list contains no 3-decimal currencies (spec §4)', () => {
    for (const bad of ['BHD', 'KWD', 'OMR', 'JOD', 'TND']) {
      expect(CURRENCY_CODES).not.toContain(bad);
    }
    expect(CURRENCY_CODES).toContain('USD');
    expect(CURRENCY_CODES.length).toBe(34);
  });

  it('isKnownCurrency trims + uppercases', () => {
    expect(isKnownCurrency(' eur ')).toBe(true);
    expect(isKnownCurrency('ZZZ')).toBe(false);
  });

  it('minor-unit exponents: 0 for zero-decimal, else 2', () => {
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('CLP')).toBe(0);
    expect(minorUnitExponent('EUR')).toBe(2);
    expect(isZeroDecimal('jpy')).toBe(true);
    expect(isZeroDecimal('USD')).toBe(false);
  });

  it('toMinorUnits matches the Stripe contract (JPY not x100)', () => {
    expect(toMinorUnits('10.50', 'USD')).toBe(1050);
    expect(toMinorUnits('1000', 'JPY')).toBe(1000);
    expect(() => toMinorUnits(Number.NaN, 'USD')).toThrow();
  });

  it('fromMinorUnits returns fixed-2 major-unit strings', () => {
    expect(fromMinorUnits(1050, 'USD')).toBe('10.50');
    expect(fromMinorUnits(1000, 'JPY')).toBe('1000.00');
  });

  it('roundToCurrency rounds half-up at the currency exponent, fixed-2 output', () => {
    expect(roundToCurrency('10.505', 'USD')).toBe('10.51');
    expect(roundToCurrency('1000.50', 'JPY')).toBe('1001.00');
    expect(roundToCurrency('1000.49', 'JPY')).toBe('1000.00');
    expect(roundToCurrency(0, 'JPY')).toBe('0.00');
  });

  it('formatCurrencyAmount uses Intl and falls back on unknown codes', () => {
    expect(formatCurrencyAmount('1234.5', 'USD', 'en-US')).toBe('$1,234.50');
    expect(formatCurrencyAmount('1000.00', 'JPY', 'en-US')).toBe('¥1,000');
    // Unknown code: bare-code fallback, never a throw.
    expect(formatCurrencyAmount('12.00', 'ZZ1', 'en-US')).toBe('12.00 ZZ1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared exec vitest run src/utils/currency.test.ts`
Expected: FAIL — module `./currency` not found.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/utils/currency.ts` — this REPLACES the content of `apps/web/src/lib/currencies.ts` (moved, not rewritten — copy its docblocks) and the conversion core of `apps/api/src/services/stripeMoney.ts` (those two files become re-exports in Task 3):

```ts
// Single source of truth for currency knowledge (multi-currency spec §4,
// docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md).
// Moved from apps/web/src/lib/currencies.ts (issue #3204) + the zero-decimal
// core of apps/api/src/services/stripeMoney.ts — keep their original rationale
// docblocks when moving.

export const CURRENCY_CODES = [
  'AED', 'ARS', 'AUD', 'BRL', 'CAD', 'CHF', 'CLP', 'COP', 'CZK', 'DKK',
  'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'JPY', 'KES', 'MXN',
  'MYR', 'NGN', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SAR', 'SEK', 'SGD',
  'THB', 'TRY', 'USD', 'ZAR',
] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

const KNOWN = new Set<string>(CURRENCY_CODES);

export function isKnownCurrency(code: string): boolean {
  return KNOWN.has(code.trim().toUpperCase());
}

// Stripe's zero-decimal set (https://docs.stripe.com/currencies#zero-decimal).
// ISO 4217 agrees for every code Breeze supports. 3-decimal currencies
// (BHD/KWD/OMR/JOD/TND) are deliberately NOT supported (spec §12) — the
// exponent is therefore exactly 0 or 2.
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has(String(currency).trim().toUpperCase());
}

export function minorUnitExponent(currency: string): 0 | 2 {
  return isZeroDecimal(currency) ? 0 : 2;
}

/** Major-unit amount → minor units (Stripe contract). Throws on non-finite. */
export function toMinorUnits(amountMajor: string | number, currency: string): number {
  const n = Number(amountMajor);
  if (!Number.isFinite(n)) throw new Error('currency: non-finite amount');
  return isZeroDecimal(currency) ? Math.round(n) : Math.round(n * 100);
}

/** Minor units → fixed-2 major-unit string (storage stays numeric(_,2)). */
export function fromMinorUnits(minor: string | number, currency: string): string {
  const n = Number(minor);
  if (!Number.isFinite(n)) throw new Error('currency: non-finite amount');
  return isZeroDecimal(currency) ? n.toFixed(2) : (n / 100).toFixed(2);
}

/**
 * Round a major-unit amount half-up at the currency's minor-unit boundary,
 * returning the fixed-2 string our numeric(_,2) columns store. For 2-decimal
 * currencies this is the classic cent round; for zero-decimal currencies the
 * result is a whole number of major units ('1001.00' for JPY).
 * Half-up = ties away from zero toward +∞ on the scaled value, matching the
 * existing quoteMath/invoiceMath discipline.
 */
export function roundToCurrency(value: string | number, currency: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('currency: non-finite amount');
  if (isZeroDecimal(currency)) return Math.floor(n + 0.5).toFixed(2);
  return (Math.floor(n * 100 + 0.5) / 100).toFixed(2);
}

/** True when `value` is already exact at the currency's minor unit. */
export function isRepresentableInCurrency(value: string | number, currency: string): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return roundToCurrency(n, currency) === n.toFixed(2);
}

/**
 * Intl currency formatter with a graceful fallback: an invalid/unknown code
 * renders as "12.00 XYZ" instead of throwing (same contract as the web's
 * billing/shared/format.formatMoney).
 */
export function formatCurrencyAmount(value: string | number, currency: string, locale: string): string {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const code = String(currency).trim().toUpperCase();
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(safe);
  } catch {
    return `${safe.toFixed(2)} ${code}`;
  }
}
```

Then MOVE `currencyLabel` (with its `labelCache`) and `currencyOptions` verbatim from `apps/web/src/lib/currencies.ts` into this file (they are pure and Node-safe), keeping their docblocks. Add `export * from './currency';` to `packages/shared/src/utils/index.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/shared exec vitest run src/utils/currency.test.ts`
Expected: PASS (7 tests). Note: if the `formatCurrencyAmount` JPY assertion fails on your Node's ICU with a different narrow symbol, assert `toContain('1,000')` and no `.50` fraction instead of exact-match — do NOT loosen the USD case.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/utils/currency.ts packages/shared/src/utils/currency.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): currency core module — codes, minor units, currency-aware rounding, Intl formatting (#3773)"
```

---

### Task 2: Shared currency validator, adopted by billing validators

**Files:**
- Create: `packages/shared/src/validators/currency.ts`
- Create: `packages/shared/src/validators/currency.test.ts`
- Modify: `packages/shared/src/validators/invoices.ts:88` (partnerBillingSettingsSchema.currencyCode)
- Modify: `packages/shared/src/validators/quotes.ts:148` (createQuoteSchema.currencyCode)
- Modify: `packages/shared/src/validators/contracts.ts:34` (createContractSchema.currencyCode)
- Modify: the validators barrel (`packages/shared/src/validators/index.ts` or wherever sibling validators are exported — check how `invoices.ts` is exported and mirror it)

**Interfaces:**
- Consumes: `isKnownCurrency` from Task 1.
- Produces: `currencyCodeSchema: z.ZodType<string>` — trims, uppercases, then requires a known code. All later waves validate currency input through this.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/validators/currency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { currencyCodeSchema } from './currency';

describe('currencyCodeSchema', () => {
  it('accepts and normalizes case/whitespace', () => {
    expect(currencyCodeSchema.parse('usd')).toBe('USD');
    expect(currencyCodeSchema.parse(' eur ')).toBe('EUR');
  });
  it('rejects off-list and malformed codes', () => {
    for (const bad of ['ZZZ', 'US', 'USDD', '', '   ', 'xx1']) {
      expect(currencyCodeSchema.safeParse(bad).success).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/currency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement + adopt**

`packages/shared/src/validators/currency.ts`:

```ts
import { z } from 'zod';
import { isKnownCurrency } from '../utils/currency';

/** ISO-4217 currency code, normalized to uppercase and restricted to the
 *  curated supported list (multi-currency spec §4). The DB backstops this via
 *  the supported_currencies FK — but Zod is the user-facing error. */
export const currencyCodeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => isKnownCurrency(s), { message: 'Unsupported currency code' });
```

Export it from the validators barrel the same way sibling files are exported. Then replace the three weak fields (import `currencyCodeSchema` in each file):

- `invoices.ts:88`: `currencyCode: z.string().length(3),` → `currencyCode: currencyCodeSchema,`
- `quotes.ts:148`: `currencyCode: z.string().length(3).optional(),` → `currencyCode: currencyCodeSchema.optional(),` (keep the #3200 comment)
- `contracts.ts:34`: `currencyCode: z.string().length(3).optional(),` → `currencyCode: currencyCodeSchema.optional(),`

Also run `grep -rn "z.string().length(3)" packages/shared/src/validators/` — if any OTHER hit is a currency field (not a country code), convert it too; country-code fields (`length(2)`) are not currency and must be left alone.

- [ ] **Step 4: Run the shared suite**

Run: `pnpm --filter @breeze/shared test`
Expected: PASS, including the existing `invoices.test.ts` / `quotes.test.ts` cases (they pass `'USD'`, which normalizes to itself).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/
git commit -m "feat(shared): currencyCodeSchema — uppercase + curated-list validation on billing validators (#3773)"
```

---

### Task 3: Converge web currencies.ts and API stripeMoney.ts onto the shared module

**Files:**
- Modify: `apps/web/src/lib/currencies.ts` (becomes a re-export)
- Modify: `apps/api/src/services/stripeMoney.ts` (becomes a re-export)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: unchanged public surfaces — every existing importer of either file keeps compiling with identical behavior.

- [ ] **Step 1: Replace `apps/web/src/lib/currencies.ts` body**

```ts
// Moved to @breeze/shared (multi-currency wave 1, #3773) so API/portal share
// the same curated list. This file remains as the web-side import point.
export {
  CURRENCY_CODES, isKnownCurrency, currencyLabel, currencyOptions,
  type CurrencyCode,
} from '@breeze/shared';
```

Check how other web files import from the shared package (`grep -rn "from '@breeze/shared'" apps/web/src/lib | head -3`) and match that exact specifier.

- [ ] **Step 2: Replace `apps/api/src/services/stripeMoney.ts` body**

Keep the file's Stripe-context docblock (the 100x-overcharge rationale), then:

```ts
export { toMinorUnits, fromMinorUnits, isZeroDecimal } from '@breeze/shared';
```

- [ ] **Step 3: Verify nothing regressed**

Run: `pnpm --filter @breeze/web test` and `pnpm --filter @breeze/api exec vitest run src/routes/portal/invoices.test.ts src/services` (the JPY 100x regression test at `routes/portal/invoices.test.ts:247` MUST stay green). If `stripeMoney` had its own test file, it may keep testing through the re-export — leave it in place.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/currencies.ts apps/api/src/services/stripeMoney.ts
git commit -m "refactor: web currencies + api stripeMoney delegate to @breeze/shared currency module (#3773)"
```

---

### Task 4: `supported_currencies` reference table — migration, schema, registrations, tests

**Files:**
- Create: `apps/api/migrations/2026-08-27-a-supported-currencies.sql`
- Create: `apps/api/src/db/schema/currency.ts` (+ export from the schema barrel — check `apps/api/src/db/schema/index.ts` and mirror siblings)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:77-100` (INTENTIONAL_UNSCOPED entry)
- Create: `apps/api/src/__tests__/integration/supportedCurrencies.integration.test.ts`

**Interfaces:**
- Consumes: `CURRENCY_CODES` from Task 1.
- Produces: table `supported_currencies(code char(3) PRIMARY KEY)`; Drizzle export `supportedCurrencies`. Task 5's FKs reference it.

- [ ] **Step 1: Write the migration**

`apps/api/migrations/2026-08-27-a-supported-currencies.sql` — mirror the `winget_package_index` RLS pattern (`2026-08-16-c-winget-package-index.sql`):

```sql
-- Global allowlist of supported ISO-4217 currency codes (multi-currency spec §4,
-- docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md).
-- Kept in parity with CURRENCY_CODES in packages/shared/src/utils/currency.ts by
-- supportedCurrencies.integration.test.ts. Adding a currency = a new migration
-- INSERTing the row (plus the shared-list change in the same PR).
--
-- Tenancy: platform-global reference data, no tenant axis. Mirrors
-- winget_package_index (2026-08-16-c): forced RLS, permissive public SELECT
-- (rows contain no tenant data; ordinary org-scoped request contexts read it),
-- system-context-only writes. Registered in INTENTIONAL_UNSCOPED in
-- rls-coverage.integration.test.ts. No org_id/device_id column, so no cascade,
-- device-cascade or export-policy registration applies.
--
-- Idempotent: IF NOT EXISTS + ON CONFLICT DO NOTHING + DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS supported_currencies (
  code char(3) PRIMARY KEY,
  CONSTRAINT supported_currencies_code_format_chk CHECK (code ~ '^[A-Z]{3}$')
);

INSERT INTO supported_currencies (code) VALUES
  ('AED'), ('ARS'), ('AUD'), ('BRL'), ('CAD'), ('CHF'), ('CLP'), ('COP'),
  ('CZK'), ('DKK'), ('EUR'), ('GBP'), ('HKD'), ('HUF'), ('IDR'), ('ILS'),
  ('INR'), ('JPY'), ('KES'), ('MXN'), ('MYR'), ('NGN'), ('NOK'), ('NZD'),
  ('PHP'), ('PLN'), ('RON'), ('SAR'), ('SEK'), ('SGD'), ('THB'), ('TRY'),
  ('USD'), ('ZAR')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE supported_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE supported_currencies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supported_currencies_read ON supported_currencies;
CREATE POLICY supported_currencies_read ON supported_currencies
  FOR SELECT USING (true);

DROP POLICY IF EXISTS supported_currencies_system_write ON supported_currencies;
CREATE POLICY supported_currencies_system_write ON supported_currencies
  FOR ALL
  USING (current_setting('breeze.scope', true) = 'system')
  WITH CHECK (current_setting('breeze.scope', true) = 'system');
```

- [ ] **Step 2: Drizzle schema**

`apps/api/src/db/schema/currency.ts`:

```ts
import { pgTable, char } from 'drizzle-orm/pg-core';

// Global currency allowlist — see 2026-08-27-a-supported-currencies.sql for the
// tenancy rationale (INTENTIONAL_UNSCOPED: public read, system-only write).
export const supportedCurrencies = pgTable('supported_currencies', {
  code: char('code', { length: 3 }).primaryKey(),
});
```

Export it from the schema barrel exactly as sibling schema files are exported.

- [ ] **Step 3: Register in INTENTIONAL_UNSCOPED**

In `rls-coverage.integration.test.ts` add to the `INTENTIONAL_UNSCOPED` set (alphabetical placement is not enforced there, but put it near `winget_package_index` and copy its comment style):

```ts
  'supported_currencies', // Global ISO-4217 allowlist (multi-currency spec §4). No tenant axis. Forced RLS: permissive USING (true) SELECT (org-scoped request contexts read it), system-only writes. Mirrors winget_package_index.
```

- [ ] **Step 4: Write the integration test**

`apps/api/src/__tests__/integration/supportedCurrencies.integration.test.ts` — copy the harness setup (db context helpers, migration apply, `breeze_app` role assertions) from `apps/api/src/__tests__/integration/` — the winget/package-index or rls-coverage suites show the established pattern for opening org-scoped vs system contexts. The test must assert, non-vacuously:

```ts
import { describe, it, expect } from 'vitest';
import { CURRENCY_CODES } from '@breeze/shared';
// ...harness imports per sibling suites (db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext)

describe('supported_currencies contract', () => {
  it('table contents equal the shared CURRENCY_CODES list (parity, spec §14)', async () => {
    // system context read
    const rows = /* select code from supported_currencies, system context */;
    expect(new Set(rows.map(r => r.code)).size).toBe(rows.length);
    expect(rows.map(r => r.code).sort()).toEqual([...CURRENCY_CODES].sort());
  });

  it('tenant context can SELECT', async () => {
    // inside withDbAccessContext for a seeded org: select must return 34 rows
  });

  it('tenant context cannot INSERT (RLS 42501)', async () => {
    // inside org-scoped context: INSERT ('XTS') must reject with code 42501
  });

  it('system context can INSERT and DELETE (cleanup)', async () => {
    // system context: INSERT ('XTS') succeeds, then DELETE it
  });
});
```

Flesh in the harness calls from the sibling suite you copied — the four behaviors above are the contract; do not stub any of them out.

- [ ] **Step 5: Run it (needs the real test DB)**

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/supportedCurrencies.integration.test.ts` and the rls-coverage suite (`... rls-coverage.integration.test.ts`).
Expected: both PASS. If the shared test DB carries stray state from other branches, see the CLAUDE.md healing note (delete the `breeze_migrations` row and re-apply).

- [ ] **Step 6: Drift check + commit**

Run: `pnpm db:check-drift` → clean.

```bash
git add apps/api/migrations/2026-08-27-a-supported-currencies.sql apps/api/src/db/schema/ apps/api/src/__tests__/integration/
git commit -m "feat(api): supported_currencies global allowlist table — forced RLS, public read, parity contract test (#3773)"
```

---

### Task 5: `organizations.currency_code` — migration, backfill, normalization, NOT VALID FKs

**Files:**
- Create: `apps/api/migrations/2026-08-27-b-org-currency-and-fks.sql`
- Modify: `apps/api/src/db/schema/orgs.ts:133` (add `currencyCode` to `organizations`, after `billingAddressCountry`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:347` (add `"currency_code"` to the organizations `included` array)

**Interfaces:**
- Consumes: `supported_currencies` (Task 4).
- Produces: `organizations.currency_code char(3) NOT NULL` (no default). Drizzle: `currencyCode` on `organizations` — Task 6 and later waves read `organizations.currencyCode`.

- [ ] **Step 1: Write the migration**

`apps/api/migrations/2026-08-27-b-org-currency-and-fks.sql`:

```sql
-- Multi-currency wave 1 (spec §5): org-level currency, backfilled from the
-- owning partner; normalization + anomaly audit of existing currency values;
-- NOT VALID FKs to supported_currencies (validated opportunistically).
-- Deliberately NO column DEFAULT on organizations.currency_code: every
-- creation path must stamp explicitly (fail-loudly contract).
-- Depends on 2026-08-27-a-supported-currencies.sql (same-date -a-/-b- infix).

-- 1) Add nullable, backfill from partner, then SET NOT NULL.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE organizations o
  SET currency_code = upper(trim(p.currency_code))
  FROM partners p
  WHERE p.id = o.partner_id AND o.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % organizations from partner default', n; END IF;
END $$;

ALTER TABLE organizations ALTER COLUMN currency_code SET NOT NULL;

-- 2) Normalize existing stored values (free-text era could hold 'usd'/' EUR').
DO $$
DECLARE n integer;
BEGIN
  UPDATE partners SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized partners.currency_code on % rows', n; END IF;

  UPDATE invoices SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized invoices.currency_code on % rows', n; END IF;

  UPDATE quotes SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized quotes.currency_code on % rows', n; END IF;

  UPDATE contracts SET currency_code = upper(trim(currency_code))
    WHERE currency_code <> upper(trim(currency_code));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: case-normalized contracts.currency_code on % rows', n; END IF;
END $$;

-- 3) Anomaly audit: off-list values are REPORTED, never rewritten (spec §5 —
-- issued documents are immutable; a bogus historical code is forensic data).
DO $$
DECLARE t text; n integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners','organizations','invoices','quotes','contracts'] LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I x WHERE NOT EXISTS (SELECT 1 FROM supported_currencies sc WHERE sc.code = x.currency_code)', t)
      INTO n;
    IF n > 0 THEN
      RAISE WARNING 'multi-currency: % rows in % carry an off-list currency_code (left as-is; FK stays NOT VALID until cleaned)', n, t;
    END IF;
  END LOOP;
END $$;

-- 4) NOT VALID FKs: enforce new writes immediately; existing bad rows only
-- block VALIDATE, which we attempt and downgrade to a warning.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners','organizations','invoices','quotes','contracts'] LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (currency_code) REFERENCES supported_currencies(code) NOT VALID',
        t, t || '_currency_code_fkey');
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- idempotent re-run
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', t, t || '_currency_code_fkey');
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'multi-currency: % has off-list currency rows; %_currency_code_fkey left NOT VALID', t, t;
    END;
  END LOOP;
END $$;
```

- [ ] **Step 2: Drizzle schema change**

In `apps/api/src/db/schema/orgs.ts`, inside `organizations` after `billingAddressCountry` (line 132):

```ts
  // Multi-currency (spec §5): the org's billing currency, inherited from the
  // partner at creation. Deliberately NO .default() — every creation path must
  // stamp it explicitly, so a missed path is a loud insert failure, never a
  // silent USD document. Editing is NOT exposed until wave 6.
  currencyCode: char('currency_code', { length: 3 }).notNull(),
```

(`char` is already imported in this file — it's used by `billingAddressCountry`.)

- [ ] **Step 3: Export-policy registration (the step that gets missed)**

`tenantExportPolicyRegistry.ts:347` — add `"currency_code"` to the organizations `included` array (it is an ordinary tenant identifier-adjacent scalar, not suspicious, not an open container). Keep the array's existing member order style (append near the other billing columns, e.g. after `"billing_address_country"`).

- [ ] **Step 4: Typecheck now, expect a controlled breakage**

Run: `pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | grep -c "currencyCode"` (or the repo's turbo typecheck).
Expected: errors at every `db.insert(organizations)` site missing `currencyCode` — that's the fail-loudly contract working. **Task 6 fixes them; do NOT add a schema default to silence this.** Do not commit yet if the pre-commit hook runs typecheck — Tasks 5 and 6 may need to land as one commit in that case; otherwise commit now:

```bash
git add apps/api/migrations/2026-08-27-b-org-currency-and-fks.sql apps/api/src/db/schema/orgs.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): organizations.currency_code + audited backfill + supported_currencies FKs (NOT VALID) (#3773)"
```

---

### Task 6: Stamp every org-creation path; sweep test fixtures

**Files:**
- Modify: `apps/api/src/routes/orgs.ts:1403-1414` (insertValues)
- Modify: `apps/api/src/services/partnerCreate.ts:155-165`
- Modify: `apps/api/src/services/quickSupportOrg.ts:37-46`
- Modify: `apps/api/src/services/aiToolsOrgs.ts:254-262`
- Modify: `apps/api/src/routes/partnerApi/provisioning.ts:234-241`
- Modify: `apps/api/src/services/orgImport/index.ts` (grep `insert(organizations)`)
- Modify: every test file inserting organizations (grep-driven sweep)

**Interfaces:**
- Consumes: `organizations.currencyCode` (Task 5); `partners.currencyCode` (existing).
- Produces: every org row is born with the partner's currency. No API surface for choosing a currency yet (wave 6).

- [ ] **Step 1: Production sites — inherit the partner's currency**

Each site already has (or can cheaply fetch) the partner row. The stamping rule is always `currencyCode: <partner.currencyCode>`:

1. **`routes/orgs.ts` insertValues** — the handler must fetch the target partner's currency before building `insertValues` (a `select({ currencyCode: partners.currencyCode }).from(partners).where(eq(partners.id, targetPartnerId))` — it may already select the partner for quota checks; reuse that query if so), then add `currencyCode: partnerRow.currencyCode` to `insertValues`.
2. **`partnerCreate.ts:157`** — the default org is created right after `newPartner` is returned: add `currencyCode: newPartner.currencyCode` to the `.values({...})`.
3. **`quickSupportOrg.ts:37`** — add a partner-currency lookup before the insert (`partners` is imported or import it) and stamp `currencyCode`.
4. **`aiToolsOrgs.ts:254`** — same: the system-context transaction already queries `organizations`; add a `partners.currencyCode` select and stamp.
5. **`provisioning.ts:234`** — the transaction already selects `partnerRow` (`maxOrganizations`) at :221; extend that select with `currencyCode: partners.currencyCode` and stamp.
6. **`orgImport/index.ts`** — locate its `insert(organizations)` and stamp from the importing partner the same way.

- [ ] **Step 2: Test-fixture sweep**

```bash
grep -rln "insert(organizations)" apps/api/src --include="*.test.ts" --include="*.integration.test.ts"
```

Add `currencyCode: 'USD'` to each fixture's `.values({...})`. Mock-based unit tests that stub `db.insert` do not need data changes — only real-insert fixtures (mostly the integration suites) and any `$inferInsert`-typed literals the typechecker flags.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @breeze/api exec tsc --noEmit` → zero errors. Then `pnpm --filter @breeze/api test` → PASS. Then the touched integration suites (at minimum `contractService.integration.test.ts`, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`) under the integration config → PASS. The export-policy suites are the ones that fire on the new column (CLAUDE.md: adding a COLUMN to a registered table breaks them unless Task 5 Step 3 was done).

- [ ] **Step 4: Commit**

```bash
git add -A apps/api/src
git commit -m "feat(api): stamp org currency from partner on every creation path; fixture sweep (#3773)"
```

---

### Task 7: Currency-aware rounding — invoiceMath + invoice/quote-accept threading

**Files:**
- Modify: `apps/api/src/services/invoiceMath.ts` (computeLineTotal, computeInvoiceTotals)
- Modify: `apps/api/src/services/invoiceService.ts:96` (recomputeInvoiceTotals), `:118` (addManualLine), `:676` (issueInvoice totals)
- Modify: `apps/api/src/services/quoteAcceptService.ts:187,221`
- Test: `apps/api/src/services/invoiceMath.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `roundToCurrency` from `@breeze/shared` (Task 1).
- Produces (exact signatures — Task 8 mirrors them in quoteMath):
  - `computeLineTotal(quantity: string, unitPrice: string, currencyCode?: string): string`
  - `computeInvoiceTotals(lines: TotalsLine[], taxRate: string | null, currencyCode?: string): { subtotal; taxTotal; total }`
  - Omitted `currencyCode` = exact current 2-decimal behavior (default `'USD'`), so untouched callers are bit-identical.

- [ ] **Step 1: Write the failing tests** (append to `invoiceMath.test.ts`)

```ts
describe('currency-aware rounding (multi-currency wave 1)', () => {
  it('computeLineTotal rounds to whole units for zero-decimal currencies', () => {
    // 3 × 333.5 = 1000.5 → JPY rounds half-up to 1001, stored fixed-2.
    expect(computeLineTotal('3', '333.50', 'JPY')).toBe('1001.00');
    // 2-decimal currencies keep the classic cent round (unchanged behavior).
    expect(computeLineTotal('3', '0.335', 'EUR')).toBe('1.01');
    // Back-compat: omitted currency === 2-decimal behavior.
    expect(computeLineTotal('3', '0.335')).toBe('1.01');
  });

  it('computeInvoiceTotals produces representable JPY tax/total', () => {
    const lines = [{ lineTotal: '1000.00', taxable: true, customerVisible: true }];
    const t = computeInvoiceTotals(lines, '0.10500', 'JPY'); // 10.5% of 1000 = 105 → integral anyway
    expect(t.taxTotal).toBe('105.00');
    const t2 = computeInvoiceTotals([{ lineTotal: '1001.00', taxable: true, customerVisible: true }], '0.10500', 'JPY');
    // 1001 * 0.105 = 105.105 → JPY tax must round to a whole unit, not 105.11
    expect(t2.taxTotal).toBe('105.00');
    expect(t2.total).toBe('1106.00');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/invoiceMath.test.ts`
Expected: FAIL (extra argument / wrong values).

- [ ] **Step 3: Implement in `invoiceMath.ts`**

```ts
import { roundToCurrency } from '@breeze/shared';

export function computeLineTotal(quantity: string, unitPrice: string, currencyCode = 'USD'): string {
  // Full-precision product, then ONE half-up round at the currency's minor-unit
  // boundary (cents for 2-decimal currencies — unchanged; whole units for JPY).
  return roundToCurrency(Number(quantity) * Number(unitPrice), currencyCode);
}

export function computeInvoiceTotals(
  lines: TotalsLine[],
  taxRate: string | null,
  currencyCode = 'USD'
): { subtotal: string; taxTotal: string; total: string } {
  let subtotalCents = 0;
  let taxableCents = 0;
  for (const l of lines) {
    if (!l.customerVisible) continue;
    const c = toCents(l.lineTotal);
    subtotalCents += c;
    if (l.taxable) taxableCents += c;
  }
  const rate = taxRate ? Number(taxRate) : 0;
  // Internal accumulation stays integer-cents; the CURRENCY decides the final
  // rounding boundary of each persisted figure (spec §4: persisted amounts must
  // be representable in the currency's minor unit).
  const subtotal = roundToCurrency(subtotalCents / 100, currencyCode);
  const taxTotal = roundToCurrency((taxableCents * rate) / 100, currencyCode);
  const total = roundToCurrency(Number(subtotal) + Number(taxTotal), currencyCode);
  return { subtotal, taxTotal, total };
}
```

(Line totals are already currency-rounded on write, so for 2-decimal currencies these are bit-identical to the old `fromCents` path; keep `toCents`/`fromCents` exports untouched for their other consumers.)

- [ ] **Step 4: Thread the invoice currency at the four call sites**

- `invoiceService.ts:96` → `computeInvoiceTotals(lines, taxRate, inv.currencyCode)`
- `invoiceService.ts:118` → `computeLineTotal(String(input.quantity), String(input.unitPrice), inv.currencyCode)`
- `invoiceService.ts:676` (inside issueInvoice) → pass the invoice row's `currencyCode` (the variable holding the invoice in that scope)
- `quoteAcceptService.ts:187` → `computeLineTotal(l.quantity, l.unitPrice, quote.currencyCode)`; `:221` → `computeInvoiceTotals(totalsLines, quote.taxRate ?? null, quote.currencyCode)`

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @breeze/api exec vitest run src/services/invoiceMath.test.ts src/services/invoiceService.test.ts src/services/quoteAcceptService.test.ts` (plus any file the grep `computeInvoiceTotals` shows with tests). Expected: PASS.

```bash
git add apps/api/src/services/
git commit -m "feat(api): currency-aware rounding in invoiceMath; thread invoice/quote currency (#3773)"
```

---

### Task 8: Currency-aware rounding — quoteMath + its API/web/portal callers

**Files:**
- Modify: `packages/shared/src/utils/quoteMath.ts` (computeLineTotal, computeQuoteTotals, priceFromMarkup)
- Modify: `apps/api/src/services/quoteService.ts:244,426,627,1042,1110,1165`
- Modify: `apps/api/src/routes/portal/quotes.ts:56,99`; `apps/api/src/routes/quotesPublic.ts:71`
- Modify: `apps/web/src/components/billing/quotes/QuoteEditor.tsx:717,761`; `QuoteLineRows.tsx:434,830,845`; `QuoteOrderBreakdown.tsx:161,204,452`
- Test: `packages/shared/src/utils/quoteMath.test.ts` (extend)

**Interfaces:**
- Consumes: `roundToCurrency` (Task 1).
- Produces (exact signatures):
  - `computeLineTotal(quantity, unitPrice, currencyCode?: string): string`
  - `computeQuoteTotals(lines, taxRate, deposit?, currencyCode?: string): QuoteTotals`
  - `priceFromMarkup(cost, markupPctValue, currencyCode?: string): string`
  - Omitted currency = current behavior. The deposit figure (`depositDueTotal`) and every returned total round at the currency exponent.

- [ ] **Step 1: Write the failing tests** (append to `quoteMath.test.ts`)

```ts
describe('currency-aware quote rounding (multi-currency wave 1)', () => {
  const jpyLine = { quantity: '3', unitPrice: '333.50', taxable: true, customerVisible: true, recurrence: 'one_time' as const };

  it('line and quote totals are whole-unit for JPY', () => {
    expect(computeLineTotal('3', '333.50', 'JPY')).toBe('1001.00');
    const t = computeQuoteTotals([jpyLine], 0.105, undefined, 'JPY');
    expect(t.subtotal).toBe('1001.00');
    expect(t.taxTotal).toBe('105.00');       // 105.105 → whole yen
    expect(t.total).toBe('1106.00');
    expect(t.dueOnAcceptanceTotal).toBe('1106.00');
  });

  it('percent deposits round to the currency exponent', () => {
    const t = computeQuoteTotals([jpyLine], null, { type: 'percent', percent: 30 }, 'JPY');
    // 30% of 1001 = 300.3 → JPY deposit must be 300.00, not 300.30
    expect(t.depositDueTotal).toBe('300.00');
  });

  it('omitted currency keeps the historical 2-decimal behavior', () => {
    expect(computeLineTotal('3', '0.335')).toBe('1.01');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/shared exec vitest run src/utils/quoteMath.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `quoteMath.ts`: import `roundToCurrency` from `../utils/currency` (same package — relative import). Change `computeLineTotal` to
`return roundToCurrency(Number(quantity) * Number(unitPrice), currencyCode);` (param `currencyCode = 'USD'`). Add `currencyCode = 'USD'` as the 4th param of `computeQuoteTotals` and wrap each returned figure: keep the integer-cents accumulators exactly as they are, then convert at the return boundary — every `fromCents(x)` in the return object becomes `roundToCurrency(x / 100, currencyCode)`, and route the per-line cents through `computeLineTotal(l.quantity, l.unitPrice, currencyCode)` at line 131 so JPY line totals are whole-unit BEFORE accumulation. Same for the two deposit computations (lines 163, 166): compute cents as today, then the returned `depositDueTotal` goes through `roundToCurrency(depositCents / 100, currencyCode)`. `priceFromMarkup` gains `currencyCode = 'USD'` and returns `roundToCurrency(c * (1 + markupPctValue / 100), currencyCode)`. Update `validateQuoteDeposit` to accept and pass through an optional `currencyCode` (4th param) so its internal `computeQuoteTotals` call agrees with the caller's.

- [ ] **Step 4: Thread the quote currency at callers**

Every listed call site has the quote row (or DTO) in scope with `currencyCode` on it — pass it as the trailing argument:
- `quoteService.ts` sites (:244 recompute, :426, :627, and the three `computeLineTotal` line-builders :1042/:1110/:1165)
- `routes/portal/quotes.ts:56,99` and `routes/quotesPublic.ts:71` — `quote.currencyCode`
- Web: `QuoteEditor.tsx:717,761` — the editor state holds the quote header; pass `quote.currencyCode` (find the header variable used for `formatMoney` calls in the same file). `QuoteLineRows.tsx` and `QuoteOrderBreakdown.tsx` already receive a `currency` prop (used at `QuoteOrderBreakdown.tsx:452`) — pass it to their `computeLineTotal` calls.

- [ ] **Step 5: Run and commit**

Run: `pnpm --filter @breeze/shared test && pnpm --filter @breeze/api exec vitest run src/services/quoteService.test.ts src/routes/portal src/routes/quotesPublic.test.ts && pnpm --filter @breeze/web test`
Expected: PASS.

```bash
git add packages/shared/src/utils/quoteMath.ts packages/shared/src/utils/quoteMath.test.ts apps/api/src apps/web/src
git commit -m "feat(shared): currency-aware quote math; thread quote currency through API/web callers (#3773)"
```

---

### Task 9: computeChargeNow currency + payment representability guard

**Files:**
- Modify: `packages/shared/src/utils/depositMath.ts`
- Modify: `apps/api/src/services/invoiceCheckout.ts:49`, `apps/api/src/routes/portal/invoices.ts:170`, `apps/api/src/services/invoicePdf.ts:482`, `apps/web/src/components/billing/InvoiceDetail.tsx:143`
- Modify: `apps/portal/src/lib/invoiceDeposit.ts:31` (the portal's structural copy — MUST mirror the new signature)
- Modify: `apps/api/src/services/invoiceService.ts:735-747` (recordPayment)
- Test: `packages/shared/src/utils/depositMath.test.ts` (extend), `apps/api/src/services/invoiceService.test.ts` (extend)

**Interfaces:**
- Consumes: `roundToCurrency`, `isRepresentableInCurrency` (Task 1).
- Produces: `computeChargeNow(inv: DepositChargeInput, currencyCode?: string): { amount: string; isDeposit: boolean }`; `recordPayment` rejects non-representable amounts with `InvoiceServiceError('...', 400, 'INVALID_AMOUNT')`.

- [ ] **Step 1: Failing tests**

`depositMath.test.ts` addition:

```ts
it('JPY deposit remainder rounds to a whole unit', () => {
  // depositDue 1000.50 can only exist from pre-fix data; the charge amount
  // must still come out representable: 1000.50 - 0 → 1001 (half-up), clamped by balance.
  const r = computeChargeNow({ depositDue: '1000.50', amountPaid: '0.00', balance: '2000.00' }, 'JPY');
  expect(r).toEqual({ amount: '1001.00', isDeposit: true });
});
it('omitted currency keeps 2-decimal behavior', () => {
  const r = computeChargeNow({ depositDue: '10.50', amountPaid: '0.00', balance: '20.00' });
  expect(r).toEqual({ amount: '10.50', isDeposit: true });
});
```

`invoiceService.test.ts` addition (mirror the file's existing mock discipline for `recordPayment`; the invoice fixture must carry `currencyCode: 'JPY'`, `status: 'sent'`, `balance: '2000.00'`):

```ts
it('rejects a payment not representable in the invoice currency', async () => {
  await expect(recordPayment(invoiceId, { amount: '100.50', method: 'cash', receivedAt: new Date() } as any, actor))
    .rejects.toMatchObject({ status: 400, code: 'INVALID_AMOUNT' });
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `pnpm --filter @breeze/shared exec vitest run src/utils/depositMath.test.ts` and the api invoiceService test file.
Expected: FAIL.

- [ ] **Step 3: Implement**

`depositMath.ts` — signature `computeChargeNow(inv: DepositChargeInput, currencyCode = 'USD')`; the deposit branch returns `{ amount: roundToCurrency(Math.min(depositCents - paidCents, balanceCents) / 100, currencyCode), isDeposit: true }`; the fall-through returns `{ amount: roundToCurrency(inv.balance, currencyCode), isDeposit: false }` (for 2-decimal currencies both are identical to today's output).

Callers: pass the invoice's currency — `invoiceCheckout.ts:49` and `routes/portal/invoices.ts:170` and `invoicePdf.ts:482` have the invoice row in scope (`inv.currencyCode` / `invoice.currencyCode`); `InvoiceDetail.tsx:143` has the invoice DTO. Portal: update `apps/portal/src/lib/invoiceDeposit.ts` to the same two-arg signature and update its caller `InvoiceDetailView.tsx:106` to pass the DTO's `currencyCode` (the file already receives it for `money()` formatting).

`invoiceService.recordPayment` — after the existing draft/void guards, before the overpayment check:

```ts
if (!isRepresentableInCurrency(input.amount, inv.currencyCode)) {
  throw new InvoiceServiceError('Payment amount has more precision than the invoice currency allows', 400, 'INVALID_AMOUNT');
}
```

(import `isRepresentableInCurrency` from `@breeze/shared`).

- [ ] **Step 4: Run the touched suites**

Run: shared + api + web + portal test filters for the touched files.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api/src apps/web/src apps/portal/src
git commit -m "feat: currency-aware charge-now + payment representability guard (#3773)"
```

---

### Task 10: Wave close-out — full verification + PR

**Files:** none new.

- [ ] **Step 1: Full local verification**

```bash
pnpm --filter @breeze/shared test
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test
pnpm db:check-drift
pnpm lint
```

Then the contract/integration suites (real DB): `rls-coverage`, `supportedCurrencies`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `contractService`, plus any integration file touched in Task 6. All green. (CLAUDE.md: local `pnpm test` does NOT run these — they are the local-green-vs-CI-green trap.)

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feature/3772-multi-currency/wave-3773
```

PR title: `feat: multi-currency wave 1 — currency foundations`. Body: summary of the five deliverables (shared module, validators, supported_currencies, org currency + stamping, currency-aware rounding), the NOT VALID FK caveat, and **`Closes #3773`**. Run one review round per the repo's review policy (this wave touches migrations + RLS ⇒ high blast radius: full review).

---

## Self-review notes (already applied)

- Spec §4 shared module → Tasks 1–3; §4 DB allowlist → Task 4; §4 rounding wave-1 → Tasks 7–9; §5 org column/backfill/anomaly/no-default/stamping → Tasks 5–6; §14 parity + RLS + fixture tests → Tasks 1, 4, 6.
- Deliberately NOT in this wave (spec wave map): document stamping/`issueInvoice` clobber (wave 2), race-safe issuance (wave 2), price books (wave 3), ticketing (wave 4), formatter adoption beyond the shared module's existence (wave 5), org-currency editing UI (wave 6), FX (wave 7).
- Known follow-on risk to flag in the PR: partners with an off-list stored currency will 400 on saving billing settings once `currencyCodeSchema` lands (Task 2) — the anomaly warnings from Task 5 tell operators which partners those are.
