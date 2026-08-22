---
tracking_issue: LanternOps/breeze#3772
---

# Multi-Currency Wave 4 — Ticketing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Every task carries an **Executor:** line — `codex` tasks are written to be self-contained (codex sees only that task); `claude` tasks touch concurrency, cross-module wiring, or UI.

**Goal:** Every ticketing monetary row (time entry, ticket part) snapshots its currency at creation; org and category rate defaults carry the currency they were entered under; the rate chain is match-or-skip (a wrong-currency default never lands on an entry); invoice assembly partitions billables into `{included, blockedByCurrency}` against the draft header currency and offers an explicit old-currency draft so nothing is stranded; `issueInvoice` asserts time/part source currency under lock; ticket AND device org-moves are blocked under lock when the destination currency differs and unbilled monetary rows exist — unless the caller explicitly accepts that those snapshots stay in the old currency; billables CSV, ticket billing summary, timesheet money and `listBillables` report per-currency groups (B5, spec §7).

**Architecture:** Four new columns (`time_entries.currency_code`, `ticket_parts.currency_code`, `org_ticket_settings.rate_currency`, `ticket_categories.rate_currency`) in one idempotent migration with audited backfills and NOT VALID FKs to `supported_currencies`. Stamping is server-side only — no validator admits a client-supplied currency on entries/parts/settings/categories. `resolveTicketLink` becomes the single source of an entry's currency (it reads the ticket org's `currency_code` and returns the matching default rate with that currency). Assembly is advisory and non-locking (partition only); `issueInvoice` is authoritative (source currency re-checked on the rows it already locks — no new locks, no reordering). Every ticket/device org-move and every linked create/relink/edit of a monetary row obeys ONE global lock order — `tickets → time_entries → ticket_parts` — so moves, edits, and `issueInvoice` (which never locks `tickets`) serialize instead of deadlocking. A move across currencies is blocked while unbilled monetary snapshots exist unless the caller explicitly accepts that those snapshots keep the old currency (`acceptCurrencyMismatch`, spec §7).

**Tech Stack:** Hono + Drizzle ORM (`.for('update')`, `sql` raw), hand-written SQL migrations, Vitest (Drizzle-mock unit + real-DB integration on postgres :5437 / redis :6387 — `.env.test` at the repo root already points there), Astro + React islands (web), react-i18next with 8 locale catalogs.

**Tracking:** parent LanternOps/breeze#3772, wave sub-issue #3776, branch `feature/3772-multi-currency/wave-3776` (worktree `/Users/toddhebebrand/.herdr/worktrees/breeze/mc-wave4`). Spec: `docs/superpowers/specs/billing/2026-08-21-multi-currency-design.md` §7 (Ticketing), §2 (snapshots invariant), §1.6 (match-or-skip), §3 bug table (B5), §14 (assembly blocked-group + backfill anomaly tests). Format precedent: `docs/superpowers/plans/billing/2026-08-21-multi-currency-wave2-document-correctness.md`.

## Global Constraints

- **No conversion, ever.** A currency mismatch is an error, a block, or a blocked-group — never a recompute of a number.
- **Snapshots rule.** `time_entries.currency_code` / `ticket_parts.currency_code` are written exactly once — at creation for every ticket-linked row, and for a standalone entry at the first moment it carries money (`hourly_rate` set on create or on a later edit) or is first attached to a ticket. **A non-null `hourly_rate` always has a currency** (standalone rows take the actor's partner currency; the DB CHECK `time_entries_currency_required_when_rate_chk` backstops it). Editing `hourly_rate` / `unit_price` never restamps; org currency changes never touch existing rows; the ticket-move and device-move rewrites touch `org_id` only. `org_ticket_settings.rate_currency` / `ticket_categories.rate_currency` are restamped only when the **normalized `default_hourly_rate` value actually changes** (a PATCH that resends the same rate alongside an SLA/name/color edit must not restamp — both UIs resend the rate on every save, `OrgTicketSettingsEditor.tsx:123`, `TicketCategoriesPage.tsx:193`).
- **Match-or-skip (owner-fixed):** entry override → org setting rate iff `rate_currency == org currency` → category default iff `rate_currency == org currency` → `null` (entry carries no rate; `isBillable` may still be true — that is allowed, not an error).
- **Client never supplies currency** for entries/parts/org ticket settings/categories. Validators are unchanged except `assembleFromOrgSchema.currencyCode`, a new `assembleFromTicketQuerySchema` (the explicit "assemble a draft in <old currency>" path), and `acceptCurrencyMismatch: z.boolean().optional()` on `moveTicketOrgSchema` + the device `moveOrgSchema`. **Every currency field uses `currencyCodeSchema` from `@breeze/shared` (spec §4) — never a bare `z.string().length(3)`, including AI tool schemas.**
- **Labor quantity rounding (one rule, everywhere):** hours are rounded to **two decimals first** (the existing `numeric(10,2)` quantity schema — `invoiceAssembly.ts:26` `toFixed(2)`), then `amount = roundToCurrency(hours2dp × rate, currency)`. 20 min × 1,000 JPY = `0.33 × 1000 = 330`. Summaries (Task 8), billables/CSV (Task 9) and assembly (Task 10) all apply this identical rule; no quantity-precision migration this wave.
- **Error codes (new):** `TimeEntryServiceError` `CURRENCY_MISMATCH` (409 — relinking a stamped entry to an org in another currency), `ENTRY_BILLED` / `PART_BILLED` (409 — monetary edit of a row `issueInvoice` already flipped to `billed`), `TICKET_NOT_FOUND` reused when the ticket row lock finds no row; `TicketMoveCurrencyBlockedError` (`services/ticketMoveCurrencyGuard.ts`, status 409, code `TICKET_MOVE_CURRENCY_BLOCKED`, carries `details`) shared by ticket and device moves; `InvoiceServiceError` `ALL_BLOCKED_BY_CURRENCY` (409, carries `details.blockedByCurrency`); existing invoice `CURRENCY_MISMATCH` (400) reused for time/part source-vs-header at issue.
- **Explicit old-currency acceptance (spec §7):** a cross-currency move with unbilled monetary rows succeeds only with `acceptCurrencyMismatch: true`, which additionally requires `PERMISSIONS.INVOICES_WRITE` (checked inline via `hasPermission(c.get('permissions'), …)` — `middleware/auth.ts:787-792` stores the resolved permission set), is recorded in the audit details and the ticket feed, and leaves every snapshot in the OLD currency — those rows only ever assemble into an old-currency draft (Task 11's `currencyCode` override). AI tools never pass it.
- **Migration:** single file `apps/api/migrations/2026-08-30-ticketing-currency.sql`; idempotent; no inner `BEGIN`/`COMMIT`; sorts after `2026-08-28-billing-doc-currency-drop-default.sql` (run `ls apps/api/migrations | sort | tail -3` before creating — never trust the date). Export-policy registry fires on the three new `org_id`-table columns (CLAUDE.md cascade table) — `ticket_categories` has no `org_id` and needs nothing.
- **Lock ordering (global, documented here because two call sites outside ticketing share it):** `tickets → time_entries → ticket_parts`. Holders: `moveTicketOrg` (Task 13: `UPDATE tickets` takes the row lock first, then the guard's `time_entries → ticket_parts` `ORDER BY id FOR UPDATE`, then the child rewrites); the device move (`routes/devices/moveOrg.ts:161-165` already updates `tickets` inside the `CORE_DEVICE_ORG_DENORMALIZED_TABLES` loop — `core.ts:155` — before `time_entries` at `:197` and `ticket_parts` at `:200`; the guard slots in between); linked create/relink (Task 7: lock the ticket row, then the entry); edits (Task 7: lock the entry/part row only). `issueInvoice` stays `invoices → invoice_lines → contracts → contract_lines → time_entries → ticket_parts` (wave 2) and **never locks `tickets`**, so no cycle with any of the above — a holder of `tickets` waiting on `time_entries` is only ever waiting on issue, which never turns around to wait on `tickets`. Wave 4 adds a column to issue's two already-locked selects and nothing else. Every request runs inside the `withDbAccessContext` transaction (`db/index.ts:465`), so a `.for('update')` on `db` persists to request commit (`invoiceService.ts:1048-1051`) — no extra `db.transaction` needed to hold a lock.
- Unit tests: Drizzle mock-queue conventions per the `breeze-testing` skill; integration: `pnpm --filter @breeze/api test:integration <file>` (the root `.env.test` already sets `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:5437/breeze_test`, `REDIS_URL=redis://localhost:6387`; bring the DB up with `pnpm --filter @breeze/api test:docker:up`). `pnpm test` green ≠ CI green — run the integration config before the PR.
- Commit after every task (message suffix `(#3776)`); typecheck via the repo turbo typecheck; full integration config + `pnpm db:check-drift` before PR.
- Device org-move (`apps/api/src/routes/devices/moveOrg.ts:194-201`) also rewrites `time_entries`/`ticket_parts.org_id` for tickets bound to the moved device — it IS a ticket org-move path, so it uses the same locked guard (Task 13) with the same `acceptCurrencyMismatch` contract. There is no web UI for device moves (`git grep move-org apps/web/src` hits only `TicketWorkbench`), so the flag is API-only there.

---

### Task 1: Schema columns + migration + drift check

**Executor:** codex (the full tenancy/migration contract is spelled out below; no new tables, no RLS policy work).

**Files:**
- Create: `apps/api/migrations/2026-08-30-ticketing-currency.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts:2-5` (import), `:33` (after `hourlyRate`), `:56` (after `unitPrice`)
- Modify: `apps/api/src/db/schema/ticketConfig.ts:43` (after `defaultHourlyRate`)
- Modify: `apps/api/src/db/schema/tickets.ts:27` (after `defaultHourlyRate`)
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing — naming/ordering), `apps/api/src/__tests__/integration/ticketingCurrencyMigration.integration.test.ts` (new)

**Interfaces:**
- Produces Drizzle columns: `timeEntries.currencyCode: char(3) | null`, `ticketParts.currencyCode: char(3) NOT NULL`, `orgTicketSettings.rateCurrency: char(3) NOT NULL`, `ticketCategories.rateCurrency: char(3) | null`.
- DB constraints (SQL-only, per repo precedent at `tickets.ts:20-21`): `time_entries_currency_required_when_org_chk CHECK (org_id IS NULL OR currency_code IS NOT NULL)`; `time_entries_currency_required_when_rate_chk CHECK (hourly_rate IS NULL OR currency_code IS NOT NULL)` (standalone entries with a rate are money too — `createTimeEntrySchema`/`updateTimeEntrySchema` admit `hourlyRate` without a ticket, `packages/shared/src/validators/timeEntries.ts:10-31`); `ticket_categories_rate_currency_chk CHECK (default_hourly_rate IS NULL OR rate_currency IS NOT NULL)`; FKs `time_entries_currency_code_fkey`, `ticket_parts_currency_code_fkey`, `org_ticket_settings_rate_currency_fkey`, `ticket_categories_rate_currency_fkey` → `supported_currencies(code)`, added `NOT VALID` then validated with `foreign_key_violation` downgraded to a WARNING (exact precedent: `apps/api/migrations/2026-08-27-b-org-currency-and-fks.sql`).
- No RLS changes: all four tables already carry policies (`time_entries`/`ticket_categories` partner-axis, `ticket_parts`/`org_ticket_settings` org-axis); columns do not change tenancy shape. No cascade-list changes (`tenantCascade.ts:244,368,370` already list the three `org_id` tables). Export-policy registration is Task 2.

- [ ] **Step 1: Write the failing integration test** `ticketingCurrencyMigration.integration.test.ts` (copy the `import './setup'` / `describe.runIf(!!process.env.DATABASE_URL)` shape from `apps/api/src/__tests__/integration/invoiceCurrencyStamping.integration.test.ts:1-20`). Assertions via `db.execute(sql\`...\`)` under `withSystemDbAccessContext`: (a) `information_schema.columns` has `time_entries.currency_code` (`is_nullable='YES'`), `ticket_parts.currency_code` (`'NO'`), `org_ticket_settings.rate_currency` (`'NO'`), `ticket_categories.rate_currency` (`'YES'`); (b) `pg_constraint` contains the two CHECK names and the four FK names above; (c) a forged `INSERT INTO time_entries (partner_id, org_id, user_id, started_at, is_billable) VALUES (...)` with `org_id` set and no `currency_code` rejects with SQLSTATE `23514`; the same insert with `org_id NULL` and `hourly_rate NULL` succeeds; `org_id NULL, hourly_rate '50.00'` and no `currency_code` rejects `23514` (`time_entries_currency_required_when_rate_chk`); `org_id NULL, hourly_rate '50.00', currency_code 'USD'` succeeds; (d) `INSERT INTO ticket_parts ... ` without `currency_code` rejects `23502`; (e) `INSERT INTO ticket_categories (partner_id, name, default_hourly_rate) VALUES (..., '100.00')` without `rate_currency` rejects `23514`, and with `default_hourly_rate NULL` succeeds; (f) `UPDATE ticket_parts SET currency_code = 'ZZZ'` on a seeded row rejects `23503`. Seed a partner/org/user with the `seedFixture` recipe from `invoiceCurrencyStamping.integration.test.ts:29-56` (add `currencyCode` to the entry insert there only after Task 3 — for this test seed no entries).
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test:integration ticketingCurrencyMigration` → FAIL (columns absent).
- [ ] **Step 3: Create the migration** with exactly this content:

```sql
-- Multi-currency wave 4 (#3776, spec §7): currency snapshots on ticketing rows.
--  * time_entries.currency_code      — nullable ONLY while org_id IS NULL AND hourly_rate
--                                      IS NULL (standalone, money-less timesheet entries);
--                                      stamped on org/ticket attach or the first rate.
--  * ticket_parts.currency_code      — NOT NULL (parts are always ticket-linked).
--  * org_ticket_settings.rate_currency — currency of default_hourly_rate, from the org.
--  * ticket_categories.rate_currency — partner currency the default rate was entered
--                                      under; nullable when there is no rate.
-- Backfills come from the owning org (entries/parts/org settings) or partner
-- (categories; standalone rated entries) and are REPORTED via RAISE WARNING
-- counts (repo convention).
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps the file).

-- 1) time_entries ------------------------------------------------------------
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE time_entries te
  SET currency_code = o.currency_code
  FROM organizations o
  WHERE o.id = te.org_id AND te.org_id IS NOT NULL AND te.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % time_entries from owning org', n; END IF;
END $$;

-- Standalone (org_id NULL) entries that carry a rate are money too: the rate
-- was entered under the technician's partner currency.
DO $$
DECLARE n integer;
BEGIN
  UPDATE time_entries te
  SET currency_code = p.currency_code
  FROM partners p
  WHERE p.id = te.partner_id AND te.org_id IS NULL AND te.hourly_rate IS NOT NULL AND te.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % standalone rated time_entries from partner', n; END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE time_entries
    ADD CONSTRAINT time_entries_currency_required_when_org_chk
    CHECK (org_id IS NULL OR currency_code IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- idempotent re-run
END $$;

DO $$
BEGIN
  ALTER TABLE time_entries
    ADD CONSTRAINT time_entries_currency_required_when_rate_chk
    CHECK (hourly_rate IS NULL OR currency_code IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- idempotent re-run
END $$;

-- 2) ticket_parts ------------------------------------------------------------
ALTER TABLE ticket_parts ADD COLUMN IF NOT EXISTS currency_code char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE ticket_parts tp
  SET currency_code = o.currency_code
  FROM organizations o
  WHERE o.id = tp.org_id AND tp.currency_code IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled currency_code on % ticket_parts from owning org', n; END IF;
END $$;

ALTER TABLE ticket_parts ALTER COLUMN currency_code SET NOT NULL;

-- 3) org_ticket_settings -----------------------------------------------------
ALTER TABLE org_ticket_settings ADD COLUMN IF NOT EXISTS rate_currency char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE org_ticket_settings s
  SET rate_currency = o.currency_code
  FROM organizations o
  WHERE o.id = s.org_id AND s.rate_currency IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled rate_currency on % org_ticket_settings from owning org', n; END IF;
END $$;

ALTER TABLE org_ticket_settings ALTER COLUMN rate_currency SET NOT NULL;

-- 4) ticket_categories -------------------------------------------------------
ALTER TABLE ticket_categories ADD COLUMN IF NOT EXISTS rate_currency char(3);

DO $$
DECLARE n integer;
BEGIN
  UPDATE ticket_categories tc
  SET rate_currency = p.currency_code
  FROM partners p
  WHERE p.id = tc.partner_id AND tc.default_hourly_rate IS NOT NULL AND tc.rate_currency IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'multi-currency: backfilled rate_currency on % ticket_categories from owning partner', n; END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE ticket_categories
    ADD CONSTRAINT ticket_categories_rate_currency_chk
    CHECK (default_hourly_rate IS NULL OR rate_currency IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- idempotent re-run
END $$;

-- 5) NOT VALID FKs to supported_currencies on all four columns; validate
--    opportunistically (off-list rows only block VALIDATE → WARNING).
DO $$
DECLARE spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ['time_entries', 'currency_code'],
    ['ticket_parts', 'currency_code'],
    ['org_ticket_settings', 'rate_currency'],
    ['ticket_categories', 'rate_currency']
  ] LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES supported_currencies(code) NOT VALID',
        spec[1], spec[1] || '_' || spec[2] || '_fkey', spec[2]);
    EXCEPTION WHEN duplicate_object THEN
      NULL; -- idempotent re-run
    END;
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', spec[1], spec[1] || '_' || spec[2] || '_fkey');
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE WARNING 'multi-currency: %.% has off-list currency rows; % left NOT VALID',
        spec[1], spec[2], spec[1] || '_' || spec[2] || '_fkey';
    END;
  END LOOP;
END $$;
```

- [ ] **Step 4: Drizzle edits.** `timeTracking.ts`: add `char` to the `drizzle-orm/pg-core` import; after `hourlyRate` on `timeEntries` add
```ts
  // Wave 4 (#3776): snapshot of the org currency at creation / first attach, or
  // of the partner currency when a standalone entry first carries a rate.
  // Nullable only while org_id IS NULL AND hourly_rate IS NULL — CHECKs
  // time_entries_currency_required_when_{org,rate}_chk live in SQL
  // (2026-08-30-ticketing-currency.sql). Never restamped.
  currencyCode: char('currency_code', { length: 3 }),
```
and after `unitPrice` on `ticketParts` add `currencyCode: char('currency_code', { length: 3 }).notNull(),` with the same one-line snapshot comment. `ticketConfig.ts` (import `char`): after `defaultHourlyRate` add `// Currency default_hourly_rate was entered under — stamped from the org, never from the client.` + `rateCurrency: char('rate_currency', { length: 3 }).notNull(),`. `tickets.ts` (import `char`): after `defaultHourlyRate` add `// Partner currency the default rate was entered under (null when no rate); CHECK ticket_categories_rate_currency_chk is SQL-only.` + `rateCurrency: char('rate_currency', { length: 3 }),`.
- [ ] **Step 5: Run** — `pnpm db:migrate` (with `DATABASE_URL` pointing at the test DB or dev DB), `pnpm db:check-drift` → no drift; `pnpm --filter @breeze/api test autoMigrate` → PASS; `pnpm --filter @breeze/api test:integration ticketingCurrencyMigration` → PASS.
- [ ] **Step 6: Commit** — `feat(api): ticketing currency columns + audited backfill migration (#3776)`.

Both CHECK names are asserted by name in Step 1(b) (`pg_constraint`), and Task 19's backfill replay adds a standalone rated entry with NULL currency and asserts the `standalone rated time_entries from partner` warning count.

### Task 2: Export-policy registry classification for the new columns

**Executor:** codex.

**Files:**
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:217` (`org_ticket_settings`), `:326` (`ticket_parts`), `:328` (`time_entries`)
- Test: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`, `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` (existing — red until this lands)

**Interfaces:**
- Produces: `"rate_currency"` appended to the `included` array of `org_ticket_settings`; `"currency_code"` appended to the `included` array of `ticket_parts` and `time_entries`. Bucket rationale: a 3-letter ISO code is ordinary customer data, the name does not match `SUSPICIOUS_NAME_PARTS`, and `currency_code` is already `included` on `contracts` (`:115`), `invoices` (`:187`), `quotes` (`:254`). `ticket_categories` has no `org_id` → no entry.

- [ ] **Step 1: Run to verify failure** — `pnpm --filter @breeze/api test:integration tenant-export-policy` → FAIL with `org_ticket_settings.rate_currency: unclassified`, `ticket_parts.currency_code: unclassified`, `time_entries.currency_code: unclassified` (requires Task 1's migration applied to the test DB).
- [ ] **Step 2: Implement** — insert `"rate_currency"` after `"default_billable"` in the `org_ticket_settings` `included` list; insert `"currency_code"` after `"unit_price"` in `ticket_parts` and after `"hourly_rate"` in `time_entries`.
- [ ] **Step 3: Run** — both suites above → PASS.
- [ ] **Step 4: Commit** — `chore(api): classify ticketing currency columns in the tenant export policy (#3776)`.

### Task 3: Stamp currency in every existing integration fixture that inserts entries/parts/org settings

**Executor:** claude (repo-wide sweep).

**Files:**
- Modify (add `currencyCode` to `timeEntries` inserts with `orgId` set or a rate, `currencyCode` to every `ticketParts` insert, `rateCurrency` to every `orgTicketSettings` insert, `rateCurrency` to every `ticketCategories` insert that sets `defaultHourlyRate`): `apps/api/src/__tests__/integration/time-entries-rls.integration.test.ts:246,270,363,562` (entries) `:291,573` (parts) `:93` (category — sets `defaultHourlyRate: '125.00'`); `ticket-move-org.integration.test.ts:104-126` (entry + part); `ticket-config-rls.integration.test.ts:261,282,493,572,630` (org settings) `:560,618` (rated categories, `defaultHourlyRate: '100.00'`); `invoiceIssueRace.integration.test.ts:113`; `changeCurrency.integration.test.ts:126`; `invoiceCurrencyStamping.integration.test.ts:46`; `apps/api/src/services/invoiceService.issue.integration.test.ts:60`.

**Interfaces:**
- Every fixture stamps the currency of the org it inserts under (read it from the seeded org's `currencyCode`, or hard-code the same literal the org was seeded with — `'USD'` for the legacy suites, `'EUR'` where the org is EUR). Rated `ticketCategories` fixtures stamp `rateCurrency` with the seeded partner's currency (`'USD'` in every current suite). Rate-less category inserts (`ticket-validation-rls:81,92`) stay untouched.

- [ ] **Step 1: Re-grep before editing** — `git grep -n "insert(timeEntries)\|insert(ticketParts)\|insert(orgTicketSettings)\|INSERT INTO \(time_entries\|ticket_parts\|org_ticket_settings\)" -- 'apps/' 'ee/'` — every hit with an org (or a rate) gets a stamp (line numbers above are pre-change references). Then the rate-bearing category audit: `git grep -n -A8 "insert(ticketCategories)" -- 'apps/' 'ee/' | grep -n "defaultHourlyRate"` — every hit must have a `rateCurrency` within the same `.values({...})` block; the DB CHECK from Task 1 makes a miss fail loudly (`23514`) in Step 3.
- [ ] **Step 2: Edit** each fixture. For `invoiceCurrencyStamping.integration.test.ts:46` use `currencyCode: orgCurrency` (the seed parameter) so the EUR/JPY variants stay honest.
- [ ] **Step 3: Run** — `pnpm --filter @breeze/api test:integration time-entries-rls ticket-move-org ticket-config-rls ticket-validation-rls invoiceIssueRace changeCurrency invoiceCurrencyStamping invoiceService.issue` → PASS (no 23502/23514).
- [ ] **Step 4: Commit** — `test(api): stamp currency in ticketing integration fixtures (#3776)`.

### Task 4: `org_ticket_settings.rate_currency` — service + route stamping from the org

**Executor:** codex.

**Files:**
- Modify: `apps/api/src/services/ticketConfigService.ts:171-189` (`getOrgBillingDefaults`), `:589-600` (`toOrgTicketSettingsResponse`), `:602-613` (`getOrgTicketSettings`), `:621-638` (`upsertOrgTicketSettings`)
- Modify: `apps/api/src/routes/orgTicketSettings.ts:17-32` (`resolveAccessibleOrg`), `:62` (upsert call)
- Modify: `packages/shared/src/validators/ticketConfig.ts:58-65` (comment only)
- Test: `apps/api/src/services/ticketConfigService.test.ts:485-515`, `apps/api/src/routes/orgTicketSettings.test.ts:42-56,93-152`, `packages/shared/src/validators/ticketConfig.test.ts`

**Interfaces:**
- `getOrgBillingDefaults(orgId: string): Promise<{ defaultHourlyRate: string | null; rateCurrency: string; defaultBillable: boolean | null } | null>` — adds `rateCurrency: orgTicketSettings.rateCurrency` to the select (system-context read, unchanged otherwise).
- `getOrgTicketSettings(orgId: string)` → `{ orgId, slaOverrides, defaultHourlyRate, defaultBillable, rateCurrency: string | null }` (`null` only when no row exists).
- `upsertOrgTicketSettings(orgId: string, input: OrgTicketSettingsInput, orgCurrencyCode: string)` — new third parameter. Insert values: `{ orgId, rateCurrency: orgCurrencyCode, ...fields }`. Conflict `set`: the currency is restamped **only when the stored rate actually changes** — `OrgTicketSettingsEditor.tsx:123` resends `defaultHourlyRate` on every save, so "key present in the PATCH" is not a usable signal. Done in SQL so it is race-free: `rateCurrency: sql\`CASE WHEN ${orgTicketSettings.defaultHourlyRate} IS DISTINCT FROM excluded.default_hourly_rate THEN excluded.rate_currency ELSE ${orgTicketSettings.rateCurrency} END\`` (only when `input.defaultHourlyRate !== undefined`; a `slaOverrides`-only or `defaultBillable`-only PATCH carries no `rateCurrency` key at all).
- `getOrgTicketSettings` response additionally carries `orgCurrency: string` and `partnerCurrency: string` (from `organizations.currencyCode` and the owning `partners.currencyCode`, one joined select) so the web editor (Task 15) needs no scope-sensitive partner lookup.
- Route `resolveAccessibleOrg` returns `{ id: string; currencyCode: string }` (select adds `currencyCode: organizations.currencyCode`); PATCH calls `upsertOrgTicketSettings(org.id, body, org.currencyCode)`.
- `orgTicketSettingsSchema` unchanged (unknown keys are stripped by Zod — `rateCurrency` from a client is silently dropped; add a comment saying so).

- [ ] **Step 1: Write failing unit tests.** `ticketConfigService.test.ts`: (a) `upsertOrgTicketSettings(ORG, { defaultHourlyRate: 125.5 }, 'EUR')` → `insertedValues[0].rateCurrency === 'EUR'` and `conflictArgs[0].set.rateCurrency` is a `SQL` object whose rendered text contains `IS DISTINCT FROM excluded.default_hourly_rate` (the Drizzle mock captures the `set` object; assert via `String(set.rateCurrency.queryChunks ...)` or the mock's `sql` passthrough — see how `ticketConfigService.test.ts` already inspects `sql` fragments); (b) `upsertOrgTicketSettings(ORG, { defaultBillable: true }, 'EUR')` → insert values carry `rateCurrency: 'EUR'` but `conflictArgs[0].set` has **no** `rateCurrency` key; (c) `getOrgTicketSettings` default case (`:489`) now `toEqual({ orgId, slaOverrides: {}, defaultHourlyRate: null, defaultBillable: null, rateCurrency: null, orgCurrency: 'USD', partnerCurrency: 'USD' })`; the `:509` expectation gains `rateCurrency` from the mocked returning row (add `rateCurrency: 'USD'` to `dbMocks.insertResult`). The "same rate resent with an SLA edit does not restamp" behaviour is proven against a real DB in Task 19 (c). `orgTicketSettings.test.ts`: extend the `'../db/schema'` mock (`:54-56`) to `organizations: { id: 'id', deletedAt: 'deletedAt', currencyCode: 'currencyCode' }`, make `dbSelectResult` resolve `[{ id: ORG_ID, currencyCode: 'CAD' }]`, and assert `serviceMocks.upsertOrgTicketSettings` was called with `(ORG_ID, body, 'CAD')`. `validators/ticketConfig.test.ts`: `orgTicketSettingsSchema.parse({ defaultHourlyRate: 10, rateCurrency: 'EUR' })` has no `rateCurrency` key.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test ticketConfigService orgTicketSettings` and `pnpm --filter @breeze/shared test ticketConfig`.
- [ ] **Step 3: Implement** the service:

```ts
export async function upsertOrgTicketSettings(orgId: string, input: OrgTicketSettingsInput, orgCurrencyCode: string) {
  const fields: Record<string, unknown> = {};
  if (input.slaOverrides !== undefined) fields.slaOverrides = input.slaOverrides;
  if (input.defaultHourlyRate !== undefined) {
    fields.defaultHourlyRate = input.defaultHourlyRate == null ? null : String(input.defaultHourlyRate);
  }
  if (input.defaultBillable !== undefined) fields.defaultBillable = input.defaultBillable;
  // rate_currency is a snapshot of the org currency the rate was entered under
  // (spec §7). Stamped on insert; restamped on conflict ONLY when the stored
  // rate actually changes — the editor resends the rate on every save, so a
  // same-value PATCH (SLA/billability edit after an org currency change) must
  // leave the historical pair intact. Decided in SQL so it is race-free.
  const restamp = input.defaultHourlyRate !== undefined
    ? {
        rateCurrency: sql`CASE WHEN ${orgTicketSettings.defaultHourlyRate} IS DISTINCT FROM excluded.default_hourly_rate
                               THEN excluded.rate_currency ELSE ${orgTicketSettings.rateCurrency} END`
      }
    : {};
  const [row] = await db
    .insert(orgTicketSettings)
    .values({ orgId, rateCurrency: orgCurrencyCode, ...fields })
    .onConflictDoUpdate({
      target: orgTicketSettings.orgId,
      set: { ...fields, ...restamp, updatedAt: new Date() },
    })
    .returning();
  return toOrgTicketSettingsResponse(orgId, row);
}
```
(`sql` from `drizzle-orm`.) `toOrgTicketSettingsResponse` row type gains `rateCurrency?: string | null` and the response gains `rateCurrency: row?.rateCurrency ?? null`; `getOrgTicketSettings` and `getOrgBillingDefaults` selects gain `rateCurrency: orgTicketSettings.rateCurrency`; `getOrgTicketSettings` additionally selects `{ orgCurrency: organizations.currencyCode, partnerCurrency: partners.currencyCode }` via `organizations` ⋈ `partners` for the org and spreads them into the response. Route: `resolveAccessibleOrg` selects `{ id: organizations.id, currencyCode: organizations.currencyCode }`, returns `{ id, currencyCode: orgRows[0].currencyCode }`; PATCH passes it through.
- [ ] **Step 4: Run** all three suites → PASS.
- [ ] **Step 5: Commit** — `feat(api): org ticket settings carry rate_currency stamped from the org (#3776)`.

### Task 5: `ticket_categories.rate_currency` — stamped from the partner on create/update

**Executor:** codex.

**Files:**
- Modify: `apps/api/src/routes/ticketCategories.ts:159-205` (POST), `:208-275` (PATCH)
- Modify: `packages/shared/src/validators/tickets.ts:155-166` (comment only)
- Test: `apps/api/src/routes/ticketCategories.test.ts:361-371` + new cases, `packages/shared/src/validators/tickets.test.ts`

**Interfaces:**
- New module-private helper in `ticketCategories.ts`:
```ts
async function partnerCurrency(partnerId: string): Promise<string | null> {
  const rows = await db.select({ currencyCode: partners.currencyCode })
    .from(partners).where(eq(partners.id, partnerId)).limit(1);
  return rows[0]?.currencyCode ?? null;
}
```
(`partners` is exported from `../db/schema`; add it to the existing schema import.)
- POST: when `body.defaultHourlyRate != null`, `rateCurrency = await partnerCurrency(auth.partnerId)`; if null → `c.json({ error: 'Partner not found' }, 404)`; otherwise `rateCurrency = null`. Insert `{ ...body, defaultHourlyRate: ..., rateCurrency, partnerId: auth.partnerId }`.
- PATCH: always read the existing row first — `select({ partnerId, defaultHourlyRate, rateCurrency }) from ticketCategories where id` → 404 if missing (`TicketCategoriesPage.tsx:193` resends `defaultHourlyRate` on every edit, so "present in body" means nothing). Then: `typeof body.defaultHourlyRate === 'number'` and `String(body.defaultHourlyRate) !== existing.defaultHourlyRate` (normalized via `Number(existing.defaultHourlyRate) !== body.defaultHourlyRate`) → `rateCurrency = await partnerCurrency(existing.partnerId)`; same number → key omitted (currency untouched); `body.defaultHourlyRate === null` → `rateCurrency: null`; undefined → key omitted. The DB CHECK `ticket_categories_rate_currency_chk` backstops a rate without a currency.
- GET responses already return the full row, so `rateCurrency` appears automatically. `ticketCategoryInputSchema` is unchanged (Zod strips `rateCurrency`; add a comment).
- Do the partner read **only** when a rate is present, so tests that never send a rate keep their existing `dbSelectResult` sequence.

- [ ] **Step 1: Write failing tests** in `ticketCategories.test.ts` (mock style: `dbSelectResult.mockResolvedValueOnce([...])` per select, `dbInsertReturning`, `dbUpdateReturning`; the POST/PATCH `db.insert(...).values` call args are inspectable via `vi.mocked(db.insert).mock.results[0]?.value.values.mock.calls[0]` as at `:369`): (a) POST with `defaultHourlyRate: 150` → one partner select (`dbSelectResult.mockResolvedValueOnce([{ currencyCode: 'CAD' }])`) and insert values `rateCurrency: 'CAD'`; (b) POST without a rate → no select call, insert values `rateCurrency: null`; (c) PATCH `{ defaultHourlyRate: 90 }` with the existing-row select returning `{ partnerId, defaultHourlyRate: '100.00', rateCurrency: 'USD' }` → partner select → update `set` has `rateCurrency: 'CAD'`; (c2) PATCH `{ name: 'Renamed', color: '#fff', defaultHourlyRate: 100 }` with existing `'100.00'`/`'USD'` → **no** partner select and `set` has no `rateCurrency` key (same-value resend after a partner currency change must not restamp); (d) PATCH `{ defaultHourlyRate: null }` → `set.rateCurrency === null` and no partner select; (e) PATCH `{ name: 'x' }` → `set` has no `rateCurrency` key. `validators/tickets.test.ts`: `ticketCategoryInputSchema.parse({ name: 'a', rateCurrency: 'EUR' })` has no `rateCurrency`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test ticketCategories`.
- [ ] **Step 3: Implement** POST:

```ts
    let rateCurrency: string | null = null;
    if (body.defaultHourlyRate != null) {
      rateCurrency = await partnerCurrency(auth.partnerId);
      if (!rateCurrency) return c.json({ error: 'Partner not found' }, 404);
    }
    const inserted = await db.insert(ticketCategories).values({
      ...body,
      defaultHourlyRate: body.defaultHourlyRate != null ? String(body.defaultHourlyRate) : null,
      // Snapshot of the partner currency the rate was entered under (spec §7);
      // a later partner-currency change must not reinterpret this number.
      rateCurrency,
      partnerId: auth.partnerId
    }).returning();
```
PATCH — build `const set: Record<string, unknown> = { ...body, defaultHourlyRate: <existing expression>, updatedAt: new Date() };` then:
```ts
    if (body.defaultHourlyRate !== undefined) {
      const [existing] = await db
        .select({ partnerId: ticketCategories.partnerId, defaultHourlyRate: ticketCategories.defaultHourlyRate })
        .from(ticketCategories).where(eq(ticketCategories.id, id)).limit(1);
      if (!existing) return c.json({ error: 'Category not found' }, 404);
      if (body.defaultHourlyRate === null) {
        set.rateCurrency = null;
      } else if (existing.defaultHourlyRate == null || Number(existing.defaultHourlyRate) !== body.defaultHourlyRate) {
        // Snapshot rule: restamp ONLY when the number itself changes. The
        // editor resends the rate on every save (name/colour/SLA edits), and a
        // same-value resend after a partner currency change must not
        // reinterpret the historical rate.
        const cur = await partnerCurrency(existing.partnerId);
        if (!cur) return c.json({ error: 'Partner not found' }, 404);
        set.rateCurrency = cur;
      }
    }
```
and pass `set` to `.set(...)`.
- [ ] **Step 4: Run** → PASS (also `pnpm --filter @breeze/shared test tickets`).
- [ ] **Step 5: Commit** — `feat(api): ticket categories snapshot the partner currency of their default rate (#3776)`.

### Task 6: Match-or-skip rate resolver returning rate + currency

**Executor:** claude (mock-queue ordering changes ripple through every ticket-linked test in `timeEntryService.test.ts`).

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts:8-20` (error codes), `:87-93` (`TicketForTimeTracking`), `:110-122` (`resolveTicketPartner` → `resolveTicketOrg`), `:124-140` (`getCategoryDefaults`), `:154-178` (`resolveTicketLink`)
- Test: `apps/api/src/services/timeEntryService.test.ts:119-130` (schema stub: add `organizations.currencyCode`), `:195-234`, `:266-325`, `:404-413` (D6 chain cases)

**Interfaces:**
- `TimeEntryServiceErrorCode` gains `'CURRENCY_MISMATCH'` (used in Task 7).
- `resolveTicketOrg(ticket: TicketForTimeTracking): Promise<{ partnerId: string | null; currencyCode: string } | null>` — **always** performs one system-context select of `{ partnerId: organizations.partnerId, currencyCode: organizations.currencyCode }` (the old short-circuit on `ticket.partnerId` is gone because the currency is needed regardless); `partnerId` resolves `ticket.partnerId ?? org.partnerId`. Returns `null` when the org row is missing → `resolveTicketLink` throws `PARTNER_UNRESOLVABLE` as today.
- `getCategoryDefaults(categoryId)` → `{ defaultBillable: boolean; defaultHourlyRate: string | null; rateCurrency: string | null } | null` (adds `rateCurrency: ticketCategories.rateCurrency` to the select).
- New exported pure function (unit-tested directly):
```ts
/** Spec §1.6 / §7 match-or-skip: a default rate applies only when it was
 *  entered under the org's currency. Never converts, never falls through to a
 *  wrong-currency number. */
export function resolveDefaultRate(
  orgCurrency: string,
  org: { defaultHourlyRate: string | null; rateCurrency: string } | null,
  category: { defaultHourlyRate: string | null; rateCurrency: string | null } | null
): string | null {
  if (org?.defaultHourlyRate != null && org.rateCurrency === orgCurrency) return org.defaultHourlyRate;
  if (category?.defaultHourlyRate != null && category.rateCurrency === orgCurrency) return category.defaultHourlyRate;
  return null;
}
```
- `resolveTicketLink(ticketId, actor)` returns `{ ticket, partnerId: string, currencyCode: string, defaultBillable: boolean, defaultHourlyRate: string | null }` with `currencyCode = org.currencyCode` and `defaultHourlyRate = resolveDefaultRate(org.currencyCode, orgSettings, category)`. `defaultBillable` chain is unchanged (non-monetary).
- Select order for the mock queue becomes: ticket → **org** → category (`getOrgBillingDefaults` is a module mock, not in the queue).

- [ ] **Step 1: Write failing tests.** `resolveDefaultRate` matrix: org USD/setting USD → setting rate; org EUR/setting USD/category EUR → category rate; org EUR/setting USD/category USD → `null`; org setting rate null + category match → category; no setting, category with `rateCurrency: null` → `null`. Resolver-level: in the existing D6 case at `:195` insert `dbMocks.selectResults.push([{ partnerId: 'p-1', currencyCode: 'USD' }])` between the ticket and category pushes, give the category stub `rateCurrency: 'USD'`, keep the assertion `vals.hourlyRate === '125.00'`; add a sibling case with org `currencyCode: 'EUR'` and category `rateCurrency: 'USD'` asserting `vals.hourlyRate === null` (and `vals.isBillable === true` — billable without a rate is allowed). For `:266-325` (org-settings precedence) set `configMocks.getOrgBillingDefaults` to return `{ defaultHourlyRate: '150.00', rateCurrency: 'USD', defaultBillable: true }` and add a mismatch case (`rateCurrency: 'CAD'`, org USD, category USD `'125.00'` → `'125.00'`).
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test timeEntryService`.
- [ ] **Step 3: Implement** `resolveTicketOrg`, `getCategoryDefaults`, `resolveDefaultRate`, and the `resolveTicketLink` return:

```ts
  const org = await resolveTicketOrg(ticket);
  const ticketPartnerId = org?.partnerId ?? null;
  if (!ticketPartnerId) {
    throw new TimeEntryServiceError('Ticket partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  }
  // ... existing partner + org-axis gates unchanged ...
  const [orgSettings, category] = await Promise.all([
    getOrgBillingDefaults(ticket.orgId),
    ticket.categoryId ? getCategoryDefaults(ticket.categoryId) : Promise.resolve(null)
  ]);
  return {
    ticket,
    partnerId: ticketPartnerId,
    // The currency every monetary value on this link is expressed in (spec §7).
    currencyCode: org!.currencyCode,
    defaultBillable: orgSettings?.defaultBillable ?? category?.defaultBillable ?? false,
    // D6 + match-or-skip: a default rate is used only when entered in the org's currency.
    defaultHourlyRate: resolveDefaultRate(org!.currencyCode, orgSettings, category)
  };
```
- [ ] **Step 4: Fix every other ticket-linked test in the file** (search `selectResults.push([{ id: 't-1'`) by inserting the org row after the ticket row — an omitted org row now yields `PARTNER_UNRESOLVABLE`, which makes the breakage loud.
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** — `feat(api): match-or-skip ticket rate resolver returns the rate with its currency (#3776)`.

### Task 7: Stamp currency on entries and parts under the ticket lock; lock-and-re-read before edits; billed rows reject monetary edits

**Executor:** claude (concurrency: holds the ticket row lock through linked create/relink, locks source rows before mutation, two-client race tests; depends on Task 6 — `resolveTicketLink(...)` now returns `currencyCode: string`).

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts:8-20` (error codes), `:214-252` (`createTimeEntry`), `:297-354` (`startTimer` insert), `:428-438` (`getEntryOr404`), `:449-481` (`updateTimeEntry` relink), `:620-645` (`addTicketPart`), `:647-652` (`getPartOr404`), `:654-669` (`updateTicketPart`), `:701-724` (`entrySelection`)
- Modify: `packages/shared/src/types/officeAddin.ts:85` (add `currencyCode: string | null;` beside `hourlyRate`)
- Modify: `packages/shared/src/validators/timeEntries.ts:10-31,69-92` (comment only: currency is server-stamped, never accepted)
- Test: `apps/api/src/services/timeEntryService.test.ts`; new `apps/api/src/__tests__/integration/timeEntryRace.integration.test.ts`

**Why this task is not "just stamping":** today `resolveTicketLink` reads the ticket on a *separate* system-context connection (`timeEntryService.ts:95-107`, `runOutsideDbContext` → `withSystemDbAccessContext`) and the insert at `:232` runs later on the request transaction with no lock in between — a `moveTicketOrg` that commits in that gap rewrites `org_id` on rows that exist at its `UPDATE ... WHERE ticket_id` moment and misses the one being inserted, leaving an entry stamped in the OLD org's currency under the NEW org. `updateTimeEntry` (`:428`) and `updateTicketPart` (`:647`) read without locking, so an edit can resume after `issueInvoice` has locked the row, validated it and flipped it to `billed` (wave 2, `invoiceService.ts:860-865`). Both are closed here.

**Interfaces:**
- `TimeEntryServiceErrorCode` gains `'ENTRY_BILLED' | 'PART_BILLED'` (409) beside Task 6's `'CURRENCY_MISMATCH'`.
- New module-private helpers (`tickets` and `partners` join the existing `../db/schema` import):
```ts
/** Lock the ticket row on the REQUEST transaction (global order: tickets → time_entries →
 *  ticket_parts). Held until request commit (withDbAccessContext is one transaction,
 *  db/index.ts:465), so a concurrent moveTicketOrg / device move — which UPDATE tickets
 *  first — queues behind this create/relink and then sees the new row. */
async function lockTicketRow(ticketId: string): Promise<{ id: string; orgId: string }> {
  const rows = await db.select({ id: tickets.id, orgId: tickets.orgId })
    .from(tickets).where(eq(tickets.id, ticketId)).limit(1).for('update');
  const row = rows[0];
  if (!row) throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  return row;
}

/** resolveTicketLink (access gates, unlocked system-context reads) THEN the lock; if the
 *  ticket moved between the two, resolve once more under the lock so the stamped
 *  currency is the org the row will actually land in. */
async function resolveAndLockTicketLink(ticketId: string, actor: TimeEntryActor) {
  let link = await resolveTicketLink(ticketId, actor);
  const locked = await lockTicketRow(ticketId);
  if (locked.orgId !== link.ticket.orgId) link = await resolveTicketLink(ticketId, actor);
  return link;
}

/** Standalone entries: money still needs a currency (CHECK time_entries_currency_required_when_rate_chk). */
async function getPartnerCurrency(partnerId: string): Promise<string> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ currencyCode: partners.currencyCode }).from(partners).where(eq(partners.id, partnerId)).limit(1)));
  const code = rows[0]?.currencyCode;
  if (!code) throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  return code;
}

const BILLED_LOCKED_ENTRY_FIELDS = ['startedAt', 'endedAt', 'isBillable', 'hourlyRate', 'billingStatus', 'ticketId'] as const;
const BILLED_LOCKED_PART_FIELDS = ['quantity', 'unitPrice', 'costBasis', 'isBillable', 'billingStatus', 'catalogItemId'] as const;
```
- `createTimeEntry` / `startTimer`: linked → `const link = await resolveAndLockTicketLink(...)`, insert `currencyCode: link.currencyCode`. Standalone → `currencyCode = input.hourlyRate != null ? await getPartnerCurrency(partnerId) : null` (an explicit rate is interpreted in the technician's partner currency; money-less standalone rows stay `null`). An explicit `input.hourlyRate` on a linked create is interpreted in `link.currencyCode`.
- `getEntryOr404(id, actor)` → selects `.for('update')` (request tx; RLS partner-axis still scopes the read). `getPartOr404` likewise. Both are the *only* readers used by mutations, so every edit/delete now locks-and-re-reads before deciding.
- `updateTimeEntry`: order of operations becomes (1) if `typeof input.ticketId === 'string'`: `link = await resolveAndLockTicketLink(input.ticketId, actor)` — the **target ticket lock is taken before the entry lock** (global order); (2) `entry = await getEntryOr404(id, actor)` (locked); (3) `assertCanMutate`; (4) **billed guard:** if `entry.billingStatus === 'billed'` and any key of `BILLED_LOCKED_ENTRY_FIELDS` is present in `input` → `throw new TimeEntryServiceError('This entry has been invoiced; only its description can change', 409, 'ENTRY_BILLED')` (a description-only edit still goes through); (5) the existing `set` construction; relink: if `entry.currencyCode == null` → `set.currencyCode = link.currencyCode`; else if `entry.currencyCode !== link.currencyCode` → `CURRENCY_MISMATCH` 409. Detach leaves `currencyCode` untouched. Standalone rate edit on a `currencyCode == null` entry (`input.hourlyRate != null && entry.ticketId == null && entry.currencyCode == null`) → `set.currencyCode = await getPartnerCurrency(entry.partnerId)` (first money stamps the snapshot); every later `hourlyRate` edit never touches `currencyCode`.
- `addTicketPart`: `const link = await resolveAndLockTicketLink(ticketId, actor)`; insert `currencyCode: link.currencyCode`.
- `updateTicketPart`: `part = await getPartOr404(id)` (locked); if `part.billingStatus === 'billed'` and any `BILLED_LOCKED_PART_FIELDS` key is present → `PART_BILLED` 409; `set` must never contain `currencyCode` (snapshot comment above the function).
- `entrySelection()` gains `currencyCode: timeEntries.currencyCode` (feeds `listTimeEntries`, `getRunningTimer`, `getTimesheet`, ticket time-entries, office add-in).
- Routes map `ENTRY_BILLED`/`PART_BILLED` through the existing `TimeEntryServiceError` → `err.status` path (no route edits; verify `routes/timeEntries.ts` and `routes/tickets/parts.ts` return `err.status`).

- [ ] **Step 1: Write failing unit tests** (mock conventions: `dbMocks.selectResults` queue in order ticket → org → category → **ticket lock row** `[{ id: 't-1', orgId: 'o-1' }]`; `dbMocks.insertedValues[0]` for inserts; `dbMocks.updateSetArgs[0]` for update `set`; the `vi.mock('../db')` select chain at the top of the file must expose `.limit(...).for('update')` and `.for('update')` directly — extend it so `for` resolves the next queued result): (a) ticket-linked create with org `currencyCode: 'EUR'` → `insertedValues[0].currencyCode === 'EUR'`, and the ticket lock select ran (4 queued selects consumed); (b) standalone create without a rate → `currencyCode === null`; (b2) standalone create with `hourlyRate: 80` → one `partners` select (`[{ currencyCode: 'CAD' }]`) and `currencyCode === 'CAD'`; (c) `startTimer` with a ticket → `'EUR'`; (c2) a create whose lock row returns `orgId: 'o-2'` (≠ resolved `'o-1'`) re-resolves (queue: ticket, org, category, lock, ticket, org, category) and stamps the second resolution's currency; (d) `updateTimeEntry` rate-only edit on an entry `{ currencyCode: 'EUR' }` → `updateSetArgs[0]` has **no** `currencyCode` key; (d2) rate edit on a standalone `{ currencyCode: null, ticketId: null }` entry → `set.currencyCode === 'CAD'` from the partner select; (e) relink of a standalone `currencyCode: null` entry to a USD-org ticket → `set.currencyCode === 'USD'` and the lock select preceded the entry select; (f) relink of a `'EUR'` entry to a USD-org ticket → rejects `{ code: 'CURRENCY_MISMATCH', status: 409 }`; (g) detach → `set` has no `currencyCode`; (h) `addTicketPart` → `insertedValues[0].currencyCode === link currency`; (i) `updateTicketPart({ unitPrice: 5 })` → `set` has no `currencyCode`; (j) `updateTimeEntry(id, { hourlyRate: 200 })` on `{ billingStatus: 'billed' }` → rejects `{ code: 'ENTRY_BILLED', status: 409 }` and no update ran; (j2) `{ description: 'x' }` on the same billed entry → update runs; (k) `updateTicketPart({ quantity: 3 })` on `{ billingStatus: 'billed' }` → `PART_BILLED` 409.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api test timeEntryService`.
- [ ] **Step 3: Implement** (`createTimeEntry` excerpt; `startTimer` mirrors it):

```ts
  let currencyCode: string | null = null;
  if (input.ticketId) {
    // Lock order tickets → time_entries: the ticket row is held until request
    // commit, so a concurrent org-move cannot slip between stamping and insert.
    const link = await resolveAndLockTicketLink(input.ticketId, actor);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    currencyCode = link.currencyCode;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }
  if (!input.ticketId && input.hourlyRate != null) {
    // Standalone money is entered in the technician's partner currency.
    currencyCode = await getPartnerCurrency(partnerId);
  }
  // ... insert values gain:
      // Snapshot (spec §7): null only for standalone, money-less entries; never restamped.
      currencyCode,
```
`updateTimeEntry` head + relink branch:
```ts
  // Global lock order: the TARGET ticket (relink) before the entry row.
  const link = typeof input.ticketId === 'string' ? await resolveAndLockTicketLink(input.ticketId, actor) : null;
  const entry = await getEntryOr404(id, actor); // FOR UPDATE — re-read under lock
  assertCanMutate(entry, actor);
  if (entry.billingStatus === 'billed' && BILLED_LOCKED_ENTRY_FIELDS.some((k) => input[k] !== undefined)) {
    throw new TimeEntryServiceError('This entry has been invoiced; only its description can change', 409, 'ENTRY_BILLED');
  }
  // ...
    } else {
      if (link!.partnerId !== entry.partnerId) { /* existing TICKET_WRONG_PARTNER */ }
      set.ticketId = input.ticketId;
      set.orgId = link!.ticket.orgId;
      if (entry.currencyCode == null) {
        set.currencyCode = link!.currencyCode; // first attach stamps the snapshot
      } else if (entry.currencyCode !== link!.currencyCode) {
        throw new TimeEntryServiceError(
          `This entry is in ${entry.currencyCode}; the ticket's organization bills in ${link!.currencyCode} — snapshots are never restamped`,
          409, 'CURRENCY_MISMATCH'
        );
      }
    }
  // standalone first-money stamp:
  if (input.hourlyRate != null && entry.ticketId == null && input.ticketId === undefined && entry.currencyCode == null) {
    set.currencyCode = await getPartnerCurrency(entry.partnerId);
  }
```
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test timeEntryService routes/timeEntries routes/officeAddin/time aiToolsTicketing` → PASS; `pnpm --filter @breeze/shared test` → PASS.
- [ ] **Step 5: Write the two-client race tests** `timeEntryRace.integration.test.ts` — copy `deferred()`, `closeRaceClients()`, `waitForBlockedBackends()` and the holder pattern verbatim from `apps/api/src/__tests__/integration/invoiceIssueRace.integration.test.ts` on main (`:35-92`, `:185-210`: a dedicated `postgres(DATABASE_URL, { max: 1, onnotice: () => {} })` holder pre-takes the contended lock inside `holder.begin`, the racers are started under `withDbAccessContext`, `waitForBlockedBackends(2)` proves both are queued on `pg_blocking_pids`, then the holder releases). Seed with the `invoiceIssueRace` recipe plus a second org in `EUR` under the same partner (needs Task 13 for `moveTicketOrg`; write the move case now, mark it `it.todo` until Task 13 lands, then un-todo it there).
  - (a) **create vs move:** holder locks the ticket row (`SELECT id FROM public.tickets WHERE id = ${ticketId} FOR UPDATE`); racers: `createTimeEntry({ ticketId, hourlyRate: 100, ... })` and `moveTicketOrg(ticketId, eurOrgId, actor)`; after settle assert exactly one consistent outcome and never the stranded one: either the create fulfilled with `currency_code = 'USD'` and the move rejected `TICKET_MOVE_CURRENCY_BLOCKED` (move ran second, saw the new row under the guard), or the move fulfilled first and the entry is `currency_code = 'EUR'` with `org_id = eurOrgId`. Forbidden state, asserted explicitly: `org_id = eurOrgId AND currency_code = 'USD'`.
  - (b) **edit vs issue:** forge a USD draft referencing the entry (`forgeDraftReferencing`); holder locks the entry row; racers: `issueInvoice(draft)` and `updateTimeEntry(entryId, { hourlyRate: 200 })`; after settle: the entry is `billed` in both orders; if the update was rejected its code is `ENTRY_BILLED` and `hourly_rate` is still `'100.00'`; if it fulfilled, `hourly_rate` is `'200.00'` (it committed before issue took the lock). Never a rejected update with a changed rate, never a fulfilled update with `ENTRY_BILLED`.
  - (c) **part edit vs issue:** same as (b) for `updateTicketPart(partId, { unitPrice: 5 })` → `PART_BILLED`.
- [ ] **Step 6: Run** `pnpm --filter @breeze/api test:integration timeEntryRace time-entries-rls` → PASS (the move case `todo` until Task 13).
- [ ] **Step 7: Commit** — `feat(api): time entries and parts snapshot their currency under the ticket lock; billed rows reject monetary edits (#3776)`.

### Task 8: Per-currency ticket billing summary + timesheet money

**Executor:** codex.

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts:786-832` (`getTimesheet`), `:834-856` (`getTicketBillingSummary`)
- Test: `apps/api/src/services/timeEntryService.test.ts:857-900`, `apps/api/src/routes/tickets/parts.test.ts:268-277`

**Interfaces:**
- `export interface CurrencyAmount { currencyCode: string; amount: string }` (numeric string, 2 decimals, rounded with `roundToCurrency` from `@breeze/shared`).
- `getTicketBillingSummary(ticketId)` → `{ time: { totalMinutes: number; billableMinutes: number; billableAmounts: CurrencyAmount[] }; parts: { partsCount: number; billableTotals: CurrencyAmount[] } }`. The scalar `billableAmount` / `billableTotal` fields are **removed** (a cross-currency sum is a lie). Four queries in this order: time minutes aggregate (existing, minus the amount column) → time amounts `GROUP BY currency_code` → parts count → parts totals `GROUP BY currency_code`.
- `getTimesheet(...)` → existing shape plus `totals.billableAmounts: CurrencyAmount[]` computed in JS from the entries already fetched (`isBillable && hourlyRate != null && currencyCode != null`; **hours rounded to two decimals first** — `Number((durationMinutes/60).toFixed(2)) * hourlyRate` — the Global-Constraints labor rule, identical to `invoiceAssembly.ts:26`; grouped by `currencyCode`, first-seen order).

- [ ] **Step 1: Write failing tests.** `timeEntryService.test.ts`: `getTicketBillingSummary` with queue `[{ totalMinutes: 90, billableMinutes: 60 }]`, `[{ currencyCode: 'EUR', amount: '100.00' }, { currencyCode: 'USD', amount: '25.00' }]`, `[{ partsCount: 2 }]`, `[{ currencyCode: 'EUR', amount: '40.00' }]` → exact object; empty queues → `billableAmounts: []`, `billableTotals: []`, zeros. `getTimesheet`: two EUR entries (60 min @ 100, 30 min @ 100) + one USD entry (60 min @ 50) + one non-billable → `totals.billableAmounts` `[{ currencyCode: 'EUR', amount: '150.00' }, { currencyCode: 'USD', amount: '50.00' }]`; a JPY entry of 20 min @ 1000 → `{ currencyCode: 'JPY', amount: '330' }` (0.33 h × 1000, zero-decimal rounding — never `333`). `parts.test.ts:271-277`: update the mocked summary to the new shape and assert `body.data.time.billableAmounts[0].amount === '125.00'`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement:**

```ts
export interface CurrencyAmount { currencyCode: string; amount: string }

export async function getTicketBillingSummary(ticketId: string) {
  const timeRows = await db
    .select({
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)::int`,
      billableMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}) FILTER (WHERE ${timeEntries.isBillable}), 0)::int`
    })
    .from(timeEntries)
    .where(eq(timeEntries.ticketId, ticketId));
  // Money is grouped per currency — never summed across (spec §7 / sumByCurrency pattern).
  const timeMoney = await db
    .select({
      currencyCode: timeEntries.currencyCode,
      // Labor rule (Global Constraints): hours to 2 dp FIRST, then × rate — matches invoice assembly.
      amount: sql<string>`COALESCE(SUM(ROUND(${timeEntries.durationMinutes}::numeric / 60, 2) * ${timeEntries.hourlyRate}), 0)::numeric(12,2)`
    })
    .from(timeEntries)
    .where(and(
      eq(timeEntries.ticketId, ticketId), eq(timeEntries.isBillable, true),
      isNotNull(timeEntries.hourlyRate), isNotNull(timeEntries.currencyCode)
    ))
    .groupBy(timeEntries.currencyCode)
    .orderBy(timeEntries.currencyCode);
  const partsRows = await db
    .select({ partsCount: sql<number>`COUNT(*)::int` })
    .from(ticketParts)
    .where(eq(ticketParts.ticketId, ticketId));
  const partsMoney = await db
    .select({
      currencyCode: ticketParts.currencyCode,
      amount: sql<string>`COALESCE(SUM(${ticketParts.quantity} * ${ticketParts.unitPrice}), 0)::numeric(12,2)`
    })
    .from(ticketParts)
    .where(and(eq(ticketParts.ticketId, ticketId), eq(ticketParts.isBillable, true)))
    .groupBy(ticketParts.currencyCode)
    .orderBy(ticketParts.currencyCode);
  const toAmounts = (rows: Array<{ currencyCode: string | null; amount: string }>): CurrencyAmount[] =>
    rows.filter((r): r is { currencyCode: string; amount: string } => r.currencyCode != null)
      .map((r) => ({ currencyCode: r.currencyCode, amount: roundToCurrency(r.amount, r.currencyCode) }));
  return {
    time: { ...(timeRows[0] ?? { totalMinutes: 0, billableMinutes: 0 }), billableAmounts: toAmounts(timeMoney) },
    parts: { ...(partsRows[0] ?? { partsCount: 0 }), billableTotals: toAmounts(partsMoney) }
  };
}
```
(`isNotNull` from `drizzle-orm`; `roundToCurrency` from `@breeze/shared`. The unit-test mock's `where(...)` terminal must also expose `.groupBy(...).orderBy(...)` — extend the `vi.mock('../db')` chain at the top of `timeEntryService.test.ts` so `groupBy` returns an object whose `orderBy` resolves the queued result.) `getTimesheet` totals:
```ts
  const money = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.isBillable || entry.hourlyRate == null || entry.currencyCode == null) continue;
    const hours = Number(((entry.durationMinutes ?? 0) / 60).toFixed(2)); // labor rule: 2 dp first
    const amount = hours * Number(entry.hourlyRate);
    money.set(entry.currencyCode, (money.get(entry.currencyCode) ?? 0) + amount);
  }
  const billableAmounts: CurrencyAmount[] = [...money].map(([currencyCode, amount]) =>
    ({ currencyCode, amount: roundToCurrency(amount, currencyCode) }));
```
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test timeEntryService routes/tickets/parts` → PASS.
- [ ] **Step 5: Commit** — `feat(api): per-currency ticket billing summary and timesheet money (#3776)`.

### Task 9: `listBillables` per-currency groups + billables CSV `currency` column

**Executor:** codex.

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts:858-994` (`BillableRowBase`, `listBillables`)
- Modify: `apps/api/src/routes/tickets/export.ts:12,31-37`
- Test: `apps/api/src/services/timeEntryService.test.ts` (listBillables cases), `apps/api/src/routes/tickets/parts.test.ts:281-300`

**Interfaces:**
- `BillableRowBase` gains `currencyCode: string | null` (time rows) / `string` (parts) — declare as `currencyCode: string | null` on the base.
- `listBillables(from, to, orgId?, accessibleOrgIds?)` → `Promise<{ rows: BillableRow[]; totalsByCurrency: CurrencyAmount[] }>` (was `BillableRow[]`). Both selects add `currencyCode` (`timeEntries.currencyCode` at the `:909-920` select, `ticketParts.currencyCode` at `:939-949`) and carry it into the pushed rows. Time rows apply the labor rule: `const hours = Number(((r.minutes ?? 0) / 60).toFixed(2))` (today `:959` keeps exact fractional hours and `toFixed(2)`s the product — 20 min × 1000 JPY printed `333.33`, while the invoice line said `330`); `amount = r.currencyCode ? roundToCurrency(hours * rate, r.currencyCode) : (hours * rate).toFixed(2)`. `totalsByCurrency` sums `amount` over rows with a non-null `currencyCode`, first-seen order, `roundToCurrency`.
- **Every consumer of the old array shape** (enumerated, not "the route"): `routes/tickets/export.ts:31-37` (destructure `{ rows }`); `routes/tickets/parts.test.ts:285`, `:322`, `:355` — three `timeServiceMocks.listBillables.mockResolvedValue(...)` calls, each becomes `{ rows: [...], totalsByCurrency: [] }`; `timeEntryService.test.ts` listBillables cases. `git grep -n "listBillables" -- apps/` before editing — any hit outside these is a missed caller.
- `CSV_HEADERS` becomes `['type','date','organization','ticket','description','technician','quantity','rate','amount','currency','billing_status','approved']`; the row emits `r.currencyCode ?? ''` right after `r.amount`; the route destructures `const { rows } = await listBillables(...)`. `auditSensitiveRead` / `rowCount: rows.length` unchanged.

- [ ] **Step 1: Write failing tests.** `timeEntryService.test.ts`: queue one time row (`minutes: 30, rate: '100.00', currencyCode: 'EUR'`) and one part row (`quantity: '2.00', unitPrice: '10.00', currencyCode: 'USD'`) → `rows[0].currencyCode === 'EUR'`, `rows[1].currencyCode === 'USD'`, `totalsByCurrency` `[{ currencyCode: 'EUR', amount: '50.00' }, { currencyCode: 'USD', amount: '20.00' }]`. `parts.test.ts:285`, `:322`, `:355`: all three `listBillables` mocks resolve `{ rows: [...existing rows with currencyCode: 'USD'], totalsByCurrency: [] }` (`:322` is the empty case → `{ rows: [], totalsByCurrency: [] }`); header assertion becomes `'type,date,organization,ticket,description,technician,quantity,rate,amount,currency,billing_status,approved'`; assert the data line contains `,62.50,USD,not_billed,`. Add a JPY time row (`minutes: 20, rate: '1000.00', currencyCode: 'JPY'`) to the service case → `quantity '0.33'`, `amount '330'`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the select/row additions and the totals fold:

```ts
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.currencyCode == null) continue; // standalone entries carry no currency
    totals.set(r.currencyCode, (totals.get(r.currencyCode) ?? 0) + Number(r.amount));
  }
  const totalsByCurrency: CurrencyAmount[] = [...totals].map(([currencyCode, amount]) =>
    ({ currencyCode, amount: roundToCurrency(amount, currencyCode) }));
  return { rows, totalsByCurrency };
```
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test timeEntryService routes/tickets/parts` → PASS.
- [ ] **Step 5: Commit** — `feat(api): billables CSV currency column; listBillables groups totals per currency (#3776)`.

### Task 10: Invoice assembly partitions billables into `{included, blockedByCurrency}`

**Executor:** claude (cross-module contract consumed by Task 11).

**Files:**
- Modify: `apps/api/src/services/invoiceAssembly.ts` (whole file)
- Test: `apps/api/src/services/invoiceAssembly.test.ts`

**Interfaces:**
```ts
export interface AssemblyResult {
  included: DraftLineSpec[];
  /** Keyed by source currency; rows whose snapshot ≠ header currency. Never a silent filter. */
  blockedByCurrency: Record<string, DraftLineSpec[]>;
}
/** Defensive bucket for a time entry with a null snapshot (impossible while the CHECK holds). */
export const UNKNOWN_CURRENCY_KEY = 'UNKNOWN';
export function partitionByCurrency<R extends { currencyCode: string | null }>(
  rows: R[], headerCurrency: string, toSpec: (row: R, currency: string) => DraftLineSpec
): AssemblyResult;
export function mergeAssembly(...parts: AssemblyResult[]): AssemblyResult;
// default 'USD' REMOVED on both; `currencyCode: string | null` added to the row type so the
// gather selects (which now read the snapshot column) satisfy partitionByCurrency's R bound.
export function timeEntryToLineSpec(r: {
  id: string; ticketId: string | null; description: string | null;
  durationMinutes: number | null; hourlyRate: string | null; isApproved: boolean;
  currencyCode?: string | null;
}, currencyCode: string): DraftLineSpec;
export function ticketPartToLineSpec(r: {
  id: string; ticketId: string | null; catalogItemId: string | null; description: string;
  quantity: string; unitPrice: string; costBasis: string | null;
  currencyCode?: string | null;
}, currencyCode: string): DraftLineSpec;
export async function gatherOrgTimeEntries(orgId: string, from: Date, to: Date, headerCurrency: string): Promise<AssemblyResult>;
export async function gatherOrgParts(orgId: string, from: Date, to: Date, headerCurrency: string): Promise<AssemblyResult>;
export async function gatherTicketBillables(ticketId: string, headerCurrency: string): Promise<AssemblyResult>;
```
- Blocked specs are built with the **row's own** currency for rounding (`toSpec(row, row.currencyCode ?? headerCurrency)`) so their `lineTotal` is honest in that currency; included specs use the header currency. `Record` (not `Map`) because the result is JSON-serialized by routes and `aiToolsBilling`. Quantity stays `hours.toFixed(2)` (`:26`) — the single labor rounding rule; 20 min × 1,000 JPY is `330`, never `333`.

- [ ] **Step 1: Write failing tests** in `invoiceAssembly.test.ts`: `partitionByCurrency([{ currencyCode: 'EUR' }, { currencyCode: 'USD' }, { currencyCode: null }], 'EUR', toSpec)` → one included, `blockedByCurrency.USD.length === 1`, `blockedByCurrency.UNKNOWN.length === 1`; `mergeAssembly` concatenates included and merges keys; existing `timeEntryToLineSpec`/`ticketPartToLineSpec` cases pass `'USD'` explicitly (the default is gone); JPY case: `timeEntryToLineSpec({ durationMinutes: 20, hourlyRate: '1000' }, 'JPY').lineTotal === '330'` (0.33 h × 1000 — the labor rule; `computeLineTotal` rounds to the JPY zero-decimal exponent, so never `333` or `333.00`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement:**

```ts
export function partitionByCurrency<R extends { currencyCode: string | null }>(
  rows: R[], headerCurrency: string, toSpec: (row: R, currency: string) => DraftLineSpec
): AssemblyResult {
  const result: AssemblyResult = { included: [], blockedByCurrency: {} };
  for (const row of rows) {
    if (row.currencyCode === headerCurrency) { result.included.push(toSpec(row, headerCurrency)); continue; }
    const key = row.currencyCode ?? UNKNOWN_CURRENCY_KEY;
    (result.blockedByCurrency[key] ??= []).push(toSpec(row, row.currencyCode ?? headerCurrency));
  }
  return result;
}
export function mergeAssembly(...parts: AssemblyResult[]): AssemblyResult {
  const out: AssemblyResult = { included: [], blockedByCurrency: {} };
  for (const p of parts) {
    out.included.push(...p.included);
    for (const [code, specs] of Object.entries(p.blockedByCurrency)) (out.blockedByCurrency[code] ??= []).push(...specs);
  }
  return out;
}
```
Each gather adds `currencyCode: timeEntries.currencyCode` / `ticketParts.currencyCode` to its select and returns `partitionByCurrency(rows, headerCurrency, timeEntryToLineSpec)` (parts: `ticketPartToLineSpec`); `gatherTicketBillables` returns `mergeAssembly(partitionByCurrency(te, ...), partitionByCurrency(parts, ...))`.
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test invoiceAssembly` → PASS (typecheck will flag `invoiceService.ts` callers — fixed in Task 11; commit both tasks only after Task 11 compiles, or commit this task with the `invoiceService.ts` spread sites temporarily adapted to `.included`).
- [ ] **Step 5: Commit** — `feat(api): invoice assembly partitions billables by source currency (#3776)`.

### Task 11: Assembly consumers — currency override, blocked-group response, `ALL_BLOCKED_BY_CURRENCY`

**Executor:** claude (service + route + validator + AI tool wiring).

**Files:**
- Modify: `apps/api/src/services/invoiceTypes.ts:27-58` (error code), `:59-67` (`InvoiceServiceError` gains `details`)
- Modify: `apps/api/src/services/invoiceService.ts:713-738` (`assembleDraftFromOrg`), `:740-763` (`assembleDraftFromTicket`)
- Modify: `apps/api/src/routes/invoices/invoices.ts:46-49` (`handleServiceError` surfaces `details`), `apps/api/src/routes/invoices/assembly.ts:21-34`
- Modify: `packages/shared/src/validators/invoices.ts:14-19` (+ new `assembleFromTicketQuerySchema`)
- Modify: `apps/api/src/services/aiToolSchemas.ts:270-298` (`manage_invoices` gains `currencyCode`), `apps/api/src/services/aiToolsBilling.ts:323-329`
- Test: `apps/api/src/services/invoiceService.test.ts`, `apps/api/src/routes/invoices/invoices.test.ts:511-546`, `packages/shared/src/validators/invoices.test.ts`, `apps/api/src/__tests__/integration/assemblyBlockedByCurrency.integration.test.ts` (new)

**Interfaces:**
- `InvoiceServiceErrorCode` gains `'ALL_BLOCKED_BY_CURRENCY'`; `InvoiceServiceError` constructor gains `public details?: Record<string, unknown>` (4th param); `handleServiceError` returns `{ error, code, ...(err.details ? { details: err.details } : {}) }`.
- `export interface BlockedCurrencySummary { currencyCode: string; count: number; amount: string }` and `export function summarizeBlocked(blocked: Record<string, DraftLineSpec[]>): BlockedCurrencySummary[]` (count + `roundToCurrency(sum(lineTotal), code)`; `UNKNOWN` key passes through with `'0.00'`-safe rounding via `'USD'` exponent — it cannot occur while the CHECK holds).
- `assembleDraftFromOrg(input: { orgId: string; siteId?: string; from: string; to: string; currencyCode?: string }, actor)` → `Promise<Awaited<ReturnType<typeof getInvoice>> & { blockedByCurrency: BlockedCurrencySummary[] }>`; header currency `input.currencyCode ?? org.currencyCode` (the explicit "assemble a draft in <old currency>" path). Only `included` specs are materialized. If `included` is empty: delete the transient draft, then throw `ALL_BLOCKED_BY_CURRENCY` (409, `details: { blockedByCurrency }`) when blocked groups exist, else the existing `NOTHING_TO_INVOICE`.
- `assembleDraftFromTicket(ticketId: string, actor: InvoiceActor, opts: { currencyCode?: string } = {})` — same treatment.
- Validators: `assembleFromOrgSchema` gains `currencyCode: currencyCodeSchema.optional()`; new `export const assembleFromTicketQuerySchema = z.object({ currencyCode: currencyCodeSchema.optional() })`. Route `POST /tickets/:ticketId/invoice` adds `zValidator('query', assembleFromTicketQuerySchema)` and passes `{ currencyCode }` (query, not body — the endpoint is body-less today and an optional JSON validator rejects an empty body).
- AI: `manage_invoices` schema gains `currencyCode: currencyCodeSchema.optional()` (import from `@breeze/shared` — spec §4 mandates the shared validator for every currency field; a bare `length(3)` would admit unsupported codes until the FK); `assemble_from_org` passes `currencyCode: s('currencyCode')`, `assemble_from_ticket` passes `{ currencyCode: s('currencyCode') }`; JSON output now contains `blockedByCurrency` (the tool description gains: "Response `blockedByCurrency` lists unbilled work in other currencies — assemble a separate draft with `currencyCode` set; never sum across currencies").

- [ ] **Step 1: Write failing unit tests** in `invoiceService.test.ts` (follow the existing assembly mock-queue cases; `gatherOrgTimeEntries`/`gatherOrgParts`/`gatherTicketBillables` are module-mocked there or mock them via `vi.mock('./invoiceAssembly')`): (a) gathers return `{ included: [], blockedByCurrency: { EUR: [spec] } }` → rejects `{ code: 'ALL_BLOCKED_BY_CURRENCY', status: 409, details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }] } }` and the draft delete ran; (b) both empty → `NOTHING_TO_INVOICE`; (c) `currencyCode: 'EUR'` override → the draft insert values carry `currencyCode: 'EUR'` and the gathers are called with `'EUR'`; (d) mixed → result `.blockedByCurrency` summary present and only `included` materialized. `invoices.test.ts:520`: loosen the `toHaveBeenCalledWith` on the org assemble route to `expect.objectContaining({ orgId, from, to })`; add a ticket-route case `POST /tickets/:id/invoice?currencyCode=eur` → service called with `{ currencyCode: 'EUR' }`. `validators/invoices.test.ts`: `assembleFromOrgSchema` accepts `currencyCode: 'eur'` → `'EUR'`, rejects `'ZZZ'`. `aiToolSchemas.test.ts` (or the nearest existing schema test): `manage_invoices` accepts `currencyCode: 'eur'` → `'EUR'` and rejects `'ZZZ'` / `'BHD'` (three-decimal, excluded from `SUPPORTED_CURRENCIES`).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `assembleDraftFromOrg`:

```ts
  const [org] = await db.select({ currencyCode: organizations.currencyCode })
    .from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) throw new InvoiceServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
  // Header currency: org default, or an explicit override so pre-change
  // billables (snapshotted in the org's OLD currency) stay invoiceable (spec §7).
  const currencyCode = input.currencyCode ?? org.currencyCode;
  const [inv] = await db.insert(invoices).values({ partnerId, orgId: input.orgId, siteId: input.siteId ?? null, status: 'draft', currencyCode, createdBy: actor.userId }).returning();
  const gathered = mergeAssembly(
    await gatherOrgTimeEntries(input.orgId, from, to, inv!.currencyCode),
    await gatherOrgParts(input.orgId, from, to, inv!.currencyCode)
  );
  const blockedByCurrency = summarizeBlocked(gathered.blockedByCurrency);
  if (gathered.included.length === 0) {
    await db.delete(invoices).where(eq(invoices.id, inv!.id));
    if (blockedByCurrency.length > 0) {
      throw new InvoiceServiceError(
        `All unbilled work in range is in ${blockedByCurrency.map((b) => b.currencyCode).join(', ')}; this draft is in ${inv!.currencyCode} — assemble a draft in that currency instead`,
        409, 'ALL_BLOCKED_BY_CURRENCY', { blockedByCurrency }
      );
    }
    throw new InvoiceServiceError('No unbilled billable work in range', 409, 'NOTHING_TO_INVOICE');
  }
  await materializeLines(inv!.id, input.orgId, gathered.included);
  await recomputeInvoiceTotals(inv!.id);
  return { ...(await getInvoice(inv!.id, actor)), blockedByCurrency };
```
`assembleDraftFromTicket` mirrors it with `gatherTicketBillables(ticketId, inv!.currencyCode)` and `opts.currencyCode ?? org.currencyCode`. Then the validator, route, `handleServiceError`, and AI-tool edits listed under Interfaces.
- [ ] **Step 4: Write the integration test** `assemblyBlockedByCurrency.integration.test.ts` (seed via the `invoiceCurrencyStamping` recipe, entries stamped `currencyCode: 'EUR'`): (a) flip `organizations.currency_code` to `'GBP'` directly (the wave-6 change flow is not exposed; mirror `invoiceCurrencyStamping:100`) → `assembleDraftFromOrg` without override rejects `ALL_BLOCKED_BY_CURRENCY` with `details.blockedByCurrency[0] = { currencyCode: 'EUR', count: 1, amount: '100.00' }` and **no** draft row remains; (b) `assembleDraftFromOrg({ ..., currencyCode: 'EUR' })` → EUR draft with one line, `blockedByCurrency: []`; (c) mixed: add a GBP part → default assemble yields a GBP draft with the part line and `blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '100.00' }]`, and the EUR entry is still `not_billed`; (d) ticket path: `assembleDraftFromTicket(ticketId, actor, { currencyCode: 'EUR' })` → EUR draft.
- [ ] **Step 5: Run** unit + `pnpm --filter @breeze/api test:integration assemblyBlockedByCurrency invoiceCurrencyStamping` + `aiToolsBilling.manageInvoices.test` → PASS.
- [ ] **Step 6: Commit** — `feat(api): assembly returns blocked-by-currency groups; explicit old-currency draft path (#3776)`.

### Task 12: `issueInvoice` asserts time/part source currency under lock (wave-2 hook)

**Executor:** claude (touches the B10 locked transaction).

**Files:**
- Modify: `apps/api/src/services/invoiceService.ts:843-869` (`validateBillable` + the two locked selects; delete the wave-4 hook comment)
- Test: `apps/api/src/__tests__/integration/invoiceIssueCurrencyMismatch.integration.test.ts` (new), `apps/api/src/services/invoiceService.issue.integration.test.ts` (re-run)

**Interfaces:**
- `validateBillable(label, ids, locked: Array<{ id: string; orgId: string | null; billingStatus: string; currencyCode: string | null }>)` — after the `SOURCE_NOT_FOUND` and `SOURCE_ALREADY_BILLED` checks:
```ts
      const foreign = ids.filter((id) => byId.get(id)!.currencyCode !== inv.currencyCode);
      if (foreign.length) {
        const codes = [...new Set(foreign.map((id) => byId.get(id)!.currencyCode ?? 'no currency'))].join(', ');
        throw new InvoiceServiceError(
          `${label} are in ${codes}; this invoice is in ${inv.currencyCode} — lines cannot cross currencies`,
          400, 'CURRENCY_MISMATCH'
        );
      }
```
- The two locked selects (`:859`, `:864`) add `currencyCode: timeEntries.currencyCode` / `currencyCode: ticketParts.currencyCode`. **No new locks, no reordering** — the check runs on rows already held `FOR UPDATE`, so a concurrent relink/move cannot desync it. Replace the `:867-869` hook comment with `// Source-vs-header currency is asserted in validateBillable on the LOCKED rows (wave 4, #3776).`

- [ ] **Step 1: Write the failing integration test**: seed (recipe from `invoiceService.issue.integration.test.ts:36-72`, stamping currency) a EUR org with a `not_billed` EUR entry; forge a USD draft for the same org with an `invoice_lines` row `sourceType 'time_entry'` pointing at the entry (hand-insert, mirroring `invoiceCurrencyStamping:87-96`); `issueInvoice` → rejects `{ code: 'CURRENCY_MISMATCH', status: 400 }`; the entry is still `not_billed`; the draft is still `draft` with no invoice number. Positive case: a EUR draft assembled via Task 11 issues cleanly and flips the entry to `billed`. Parts variant for the mismatch.
- [ ] **Step 2: Run to verify failure** — the USD draft currently issues.
- [ ] **Step 3: Implement** the select columns + `validateBillable` guard; delete the hook comment.
- [ ] **Step 4: Run** `pnpm --filter @breeze/api test:integration invoiceIssueCurrencyMismatch invoiceService.issue invoiceIssueRace` + `pnpm --filter @breeze/api test invoiceService` → PASS.
- [ ] **Step 5: Commit** — `fix(api): issueInvoice rejects time/part sources whose snapshot currency differs from the header (#3776)`.

### Task 13: Shared locked currency guard for ticket AND device org-moves; explicit `acceptCurrencyMismatch`

**Executor:** claude (lock order inside two existing transactions; cross-module guard; permission gate).

**Files:**
- Create: `apps/api/src/services/ticketMoveCurrencyGuard.ts` (+ `ticketMoveCurrencyGuard.test.ts`)
- Modify: `apps/api/src/services/ticketService.ts:1337-1392` (`moveTicketOrg`)
- Modify: `apps/api/src/routes/tickets/moveOrg.ts:17-43`, `apps/api/src/services/aiToolsTicketing.ts:47-52` (`serviceErrorToJson`), `:653` (`move_ticket_org` never passes the flag)
- Modify: `apps/api/src/routes/devices/moveOrg.ts:98-102` (org select), `:194-201` (guard before the `time_entries` UPDATE), `:218-234` (catch: 409 before the 500 path); `apps/api/src/routes/devices/schemas.ts:122-125` (`moveOrgSchema`)
- Modify: `packages/shared/src/validators/tickets.ts:133-135` (`moveTicketOrgSchema`)
- Test: `apps/api/src/services/ticketService.test.ts:2503-2610`, `apps/api/src/routes/tickets/moveOrg.test.ts`, `apps/api/src/routes/devices/moveOrg.test.ts`, `packages/shared/src/validators/tickets.test.ts`, `apps/api/src/__tests__/integration/ticket-move-org.integration.test.ts` (+ blocked / accepted cases), `apps/api/src/__tests__/integration/deviceMoveOrgCurrency.integration.test.ts` (new), `timeEntryRace.integration.test.ts` (un-`todo` the move case from Task 7)

**Why one guard, and why this order:** the device move (`routes/devices/moveOrg.ts:161-165`) rewrites `tickets.org_id` through the `CORE_DEVICE_ORG_DENORMALIZED_TABLES` loop (`core.ts:155` lists `tickets`) and then `time_entries` (`:197`) and `ticket_parts` (`:200`) — it is a ticket org-move in every respect that matters to a currency snapshot. A guard that locked `time_entries → ticket_parts` *before* `tickets` (the original draft of this task) would hold a source row while waiting for the ticket that a concurrent device move already holds while it waits for the source row — a real deadlock. Global order is therefore `tickets → time_entries → ticket_parts`; both movers already take the `tickets` lock via their `UPDATE`, and the guard runs after that UPDATE and before the child rewrites. `issueInvoice` never locks `tickets` (wave 2 order `invoices → invoice_lines → contracts → contract_lines → time_entries → ticket_parts`, `invoiceService.ts:792-865`), so it cannot close a cycle.

**Interfaces:**
- Validators: `moveTicketOrgSchema` and the device `moveOrgSchema` gain `acceptCurrencyMismatch: z.boolean().optional()`.
- Guard module:
```ts
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { timeEntries, ticketParts } from '../db/schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface MoveCurrencyGuardDetails {
  sourceCurrency: string;
  targetCurrency: string;
  unbilledTimeEntries: number;
  unbilledParts: number;
  accepted: boolean;
}

/** 409 carrier shared by ticket and device moves (own class — importing
 *  TicketServiceError here would make ticketService ⇄ guard a cycle). */
export class TicketMoveCurrencyBlockedError extends Error {
  readonly status = 409 as const;
  readonly code = 'TICKET_MOVE_CURRENCY_BLOCKED' as const;
  constructor(message: string, public details: MoveCurrencyGuardDetails) {
    super(message);
    this.name = 'TicketMoveCurrencyBlockedError';
  }
}

export interface MoveCurrencyGuardInput {
  ticketIds: string[];
  sourceCurrency: string;
  targetCurrency: string;
  targetOrgName: string;
  acceptCurrencyMismatch: boolean;
}

/**
 * Call INSIDE the mover's transaction, AFTER its `UPDATE tickets` (which holds
 * the ticket row lock) and BEFORE the time_entries / ticket_parts rewrites.
 * Global lock order: tickets → time_entries → ticket_parts (ORDER BY id FOR UPDATE),
 * the same relative order issueInvoice uses for the two source tables.
 * Returns null when the currencies match (no locks taken, nothing to report).
 * Guards EVERY unbilled monetary snapshot regardless of current billability —
 * `isBillable` can be flipped later (updateTimeEntrySchema), and a row that
 * moved while non-billable would otherwise surface as an old-currency amount
 * under the new org (codex review #6).
 */
export async function assertTicketMoveCurrencyCompatible(
  tx: Tx, input: MoveCurrencyGuardInput
): Promise<MoveCurrencyGuardDetails | null> {
  if (input.sourceCurrency === input.targetCurrency || input.ticketIds.length === 0) return null;
  const lockedTime = await tx.select({ id: timeEntries.id }).from(timeEntries)
    .where(and(inArray(timeEntries.ticketId, input.ticketIds), eq(timeEntries.billingStatus, 'not_billed'),
      isNotNull(timeEntries.hourlyRate)))
    .orderBy(timeEntries.id).for('update');
  const lockedParts = await tx.select({ id: ticketParts.id }).from(ticketParts)
    .where(and(inArray(ticketParts.ticketId, input.ticketIds), eq(ticketParts.billingStatus, 'not_billed')))
    .orderBy(ticketParts.id).for('update'); // unit_price is NOT NULL — every unbilled part is money
  const details: MoveCurrencyGuardDetails = {
    sourceCurrency: input.sourceCurrency, targetCurrency: input.targetCurrency,
    unbilledTimeEntries: lockedTime.length, unbilledParts: lockedParts.length,
    accepted: input.acceptCurrencyMismatch
  };
  if (lockedTime.length === 0 && lockedParts.length === 0) return details;
  if (input.acceptCurrencyMismatch) return details; // snapshots keep sourceCurrency; rows stay locked until commit
  throw new TicketMoveCurrencyBlockedError(
    `Cannot move: ${lockedTime.length} unbilled time entries and ${lockedParts.length} unbilled parts are in ${input.sourceCurrency} but ${input.targetOrgName} bills in ${input.targetCurrency}. Invoice them first (or assemble a ${input.sourceCurrency} draft), or move anyway and accept that they stay in ${input.sourceCurrency} and can only be invoiced on a ${input.sourceCurrency} draft.`,
    details
  );
}
```
- `moveTicketOrg(ticketId, targetOrgId, actor, opts: { acceptCurrencyMismatch?: boolean } = {})`: the org select adds `currencyCode: organizations.currencyCode`. Inside `db.transaction`: the existing `tx.update(tickets)` runs **first** (takes the ticket row lock), then `const guard = await assertTicketMoveCurrencyCompatible(tx, { ticketIds: [ticketId], sourceCurrency: sourceOrg.currencyCode, targetCurrency: targetOrg.currencyCode, targetOrgName: targetOrg.name, acceptCurrencyMismatch: opts.acceptCurrencyMismatch === true })`, then the `TICKET_ORG_DENORMALIZED_TABLES` rewrite (`SET org_id` only — `currency_code` untouched). The feed comment becomes `Moved to ${targetOrg.name}` + (`guard?.accepted && (guard.unbilledTimeEntries || guard.unbilledParts)` ? ` — ${n} unbilled items stay in ${sourceCurrency}` : ''). Audit `details` gains `currencyMismatchAccepted: guard` when accepted (null/omitted otherwise). A throw inside the transaction rolls the `tickets` UPDATE back — nothing moves on a block.
- Route `routes/tickets/moveOrg.ts`: `const { orgId: targetOrgId, acceptCurrencyMismatch } = c.req.valid('json')`; if `acceptCurrencyMismatch === true` and `!hasPermission(c.get('permissions'), PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action)` → `c.json({ error: 'Accepting a currency mismatch requires invoices:write' }, 403)` (`hasPermission` from `../../services/permissions`; `c.get('permissions')` is populated by the preceding `requirePermission` middleware, `middleware/auth.ts:792`); call `moveTicketOrg(id, targetOrgId, actorFrom(c), { acceptCurrencyMismatch: acceptCurrencyMismatch === true })`; `catch (err) { if (err instanceof TicketMoveCurrencyBlockedError) return c.json({ error: err.message, code: err.code, details: err.details }, 409); return handleServiceError(c, err); }`.
- `aiToolsTicketing.serviceErrorToJson`: add `if (err instanceof TicketMoveCurrencyBlockedError) return JSON.stringify({ error: err.message, code: err.code, details: err.details })`; the `move_ticket_org` call at `:653` stays without the flag (AI never accepts a mismatch — a human does, with `invoices:write`).
- Device route `routes/devices/moveOrg.ts`: org select (`:98-102`) adds `currencyCode: organizations.currencyCode`; body gains `acceptCurrencyMismatch` with the same inline `INVOICES_WRITE` gate (403); inside the transaction, immediately before the `time_entries` UPDATE at `:197`: `const ticketIds = (await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.deviceId, deviceId))).map((r) => r.id); currencyGuard = await assertTicketMoveCurrencyCompatible(tx, { ticketIds, sourceCurrency: sourceOrg.currencyCode, targetCurrency: targetOrg.currencyCode, targetOrgName: targetOrgName, acceptCurrencyMismatch })` (the `tickets` rows were already locked by the loop's UPDATE at `:161-165`; `tickets` added to the schema import; `targetOrgName` from the org select gaining `name`). In the `catch` (`:218`): `if (err instanceof TicketMoveCurrencyBlockedError) return c.json({ error: err.message, code: err.code, details: err.details }, 409);` **before** `captureException` and the failed-move audit — a policy block is not a failure. `auditDetails` (`:247`) gains `currencyMismatchAccepted: currencyGuard` when accepted.

- [ ] **Step 1: Guard unit tests** `ticketMoveCurrencyGuard.test.ts` with a hand-rolled `tx` stub whose `select().from().where().orderBy().for()` resolves from a queue: (a) same currency → returns `null`, no select; (b) differing currency, one locked time row, `acceptCurrencyMismatch: false` → throws `TicketMoveCurrencyBlockedError` with `details { unbilledTimeEntries: 1, unbilledParts: 0, accepted: false }`; (c) same with `accept: true` → returns details `{ accepted: true }`; (d) differing currency, both queues empty → returns details with zeros; (e) the time-entry `where` carries `billing_status = 'not_billed'` and `hourly_rate IS NOT NULL` but **no** `is_billable` predicate (walk the bound params per memory `vacuous_drizzle_where_clause_assertions`). `validators/tickets.test.ts`: `moveTicketOrgSchema.parse({ orgId, acceptCurrencyMismatch: 'yes' })` rejects; `{ orgId }` → flag `undefined`.
- [ ] **Step 2: Service/route unit tests** in `ticketService.test.ts` (the org lookup stub at `:2518-2521` gains `currencyCode`; mock `./ticketMoveCurrencyGuard` via `vi.mock` — the guard is unit-tested on its own): (a) differing currency, guard mock throws → `moveTicketOrg` rejects with that error, the child `txExecuteMock` rewrites never ran, the feed insert never ran; (b) guard returns `{ accepted: true, unbilledTimeEntries: 2, unbilledParts: 0 }` → rewrite proceeds (3 `txExecuteMock` calls), feed comment contains `2 unbilled items stay in USD`, audit details contain `currencyMismatchAccepted`; (c) same currency → guard called with matching currencies (it short-circuits) and nothing else changes; (d) the guard is invoked **after** `tx.update(tickets)` (assert call order via `mock.invocationCallOrder`). `routes/tickets/moveOrg.test.ts`: 409 body carries `code` + `details`; `acceptCurrencyMismatch: true` without `invoices:write` in the mocked permission set → 403 and the service is not called; with it → service called with `{ acceptCurrencyMismatch: true }`. `routes/devices/moveOrg.test.ts`: guard throwing → 409 with `code`/`details`, no `captureException`, no `device.move_org.failed` audit; `acceptCurrencyMismatch` permission gate mirrors the ticket route.
- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement** the guard module, service, both routes, validators, AI error mapping as above (`hasPermission` import; `tickets` in the device route schema import).
- [ ] **Step 5: Integration** — extend `ticket-move-org.integration.test.ts`: seed orgA `USD`, orgB `EUR` (same partner); with the Task-3-stamped `not_billed` entry (`hourlyRate: '100.00'`, **`isBillable: false`** — proves the guard ignores billability) → `moveTicketOrg` rejects 409 `TICKET_MOVE_CURRENCY_BLOCKED`, `tickets.org_id` unchanged; `moveTicketOrg(..., { acceptCurrencyMismatch: true })` → succeeds, `org_id = orgB`, `currency_code` still `'USD'`, the audit row for `ticket.move_org.source` has `details.currencyMismatchAccepted.unbilledTimeEntries === 1`; mark the entry `billed` on a fresh ticket → the plain move succeeds and the snapshot is still `'USD'`. New `deviceMoveOrgCurrency.integration.test.ts`: seed a device in orgA with a ticket bound to it (`tickets.device_id`) carrying a `not_billed` USD part; `POST /devices/:id/move-org` (route-level via the app, MFA/permissions per the existing device move suite) to orgB/EUR → 409 `TICKET_MOVE_CURRENCY_BLOCKED` with `details.unbilledParts === 1`, `devices.org_id` unchanged (the transaction rolled back — the `tickets` UPDATE too); with `acceptCurrencyMismatch: true` → 200, part `org_id = orgB`, `currency_code = 'USD'`. Un-`todo` the create-vs-move race in `timeEntryRace.integration.test.ts` (Task 7 Step 5a) and run it.
- [ ] **Step 6: Run** `pnpm --filter @breeze/api test ticketService ticketMoveCurrencyGuard routes/tickets/moveOrg routes/devices/moveOrg aiToolsTicketing` + `pnpm --filter @breeze/shared test tickets` + `test:integration ticket-move-org deviceMoveOrgCurrency timeEntryRace` → PASS.
- [ ] **Step 7: Commit** — `feat(api): shared locked currency guard for ticket and device org-moves with explicit acceptCurrencyMismatch (#3776)`.

### Task 14: AI tool copy, validator comments, device-move lock-order comment

**Executor:** codex.

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts:354-357` (`hourlyRate` description), `:664-690` (`log_time_entry` — no code change; output already carries `currencyCode`)
- Modify: `apps/api/src/services/aiToolSchemas.ts:236` (doc comment beside `hourlyRate`)
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (comment only, above the guard call Task 13 added before the `time_entries` UPDATE)
- Test: `apps/api/src/services/aiToolsTicketing.test.ts` (re-run)

**Interfaces:**
- `hourlyRate` description → `'Override hourly rate in the ticket organization\'s currency (log_time_entry; defaults from org/category settings only when their rate currency matches the org)'`.
- `aiToolSchemas.ts:236`: add `// Interpreted in the ticket org's currency (spec §9); the entry snapshots that currency.`
- `routes/devices/moveOrg.ts` above the guard + `time_entries` UPDATE: `// Wave 4 (#3776): org_id only — currency_code is a snapshot and is NOT rewritten. Lock order is global (tickets → time_entries → ticket_parts): the tickets row lock was taken by the denormalized-table loop above, the guard locks the two source tables in that order, and only then are they rewritten — the same order moveTicketOrg uses, so a concurrent ticket move or issueInvoice serializes instead of deadlocking. Accepted mismatches stay invoiceable only through an old-currency draft (assembleDraftFromOrg currencyCode override).`

- [ ] **Step 1: Edit** the three files.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test aiToolsTicketing aiToolSchemas routes/devices/moveOrg` → PASS.
- [ ] **Step 3: Commit** — `docs(api): currency wording for ticketing AI tools and device-move rewrite (#3776)`.

### Task 15: Web — org ticket settings currency nudge + category rate currency

**Executor:** claude (UI).

**Files:**
- Modify: `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx:18-23` (type), `:54-70` (load), `:215-233` (rate field)
- Modify: `apps/web/src/components/settings/TicketCategoriesPage.tsx:13-24` (type), `:84-92` (`defaultsSummary()` — the formatter's real name), page load (fetch partner currency once)
- Test: `apps/web/src/components/settings/OrgTicketSettingsEditor.test.tsx`, `apps/web/src/components/settings/TicketCategoriesPage.test.tsx`

**Interfaces:**
- `OrgTicketSettings` gains `rateCurrency: string | null; orgCurrency: string; partnerCurrency: string` — both currencies come from the ticket-settings GET itself (Task 4), so the editor works identically for partner- and system-scope users (`/orgs/partners/me` is `requireScope('partner')`, `orgs.ts:723`, and would 403 for system users; the ticket-settings route accepts both). When `orgCurrency !== partnerCurrency`, render `<p data-testid="org-ticket-currency-nudge" className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">{t('orgTicketSettingsEditor.billing.currencyNudge', { orgCurrency, partnerCurrency })}</p>` above the rate input. The rate label renders `t('orgTicketSettingsEditor.billing.hourlyRate', { currency: orgCurrency })`. **Save sends dirty fields only** (`:119-126`): include `defaultHourlyRate` in the PATCH body only when the input differs from the loaded value (string-compare the normalized `Number(...)`), so an SLA-only save never carries the rate at all — belt and braces with the server-side "restamp only on change" rule from Task 4.
- `Category` gains `rateCurrency: string | null`; the page fetches `/orgs/partners/me` once **only when the session is partner scope** (`fetchWithAuth` 403 → `partnerCurrency = null`; never toast it) and passes it into `defaultsSummary(c, partnerCurrency)`; an existing rate formats with `formatCurrency(parseFloat(c.defaultHourlyRate), c.rateCurrency ?? partnerCurrency ?? undefined)` (a rated row always has `rateCurrency` after Task 1's CHECK — the fallback is for the unrated/legacy display path only); the form label uses `t('ticketCategoriesPage.defaultHourlyRate', { currency: partnerCurrency ?? '' })`.

- [ ] **Step 1: Write failing tests.** `OrgTicketSettingsEditor.test.tsx`: the ticket-settings GET mock returns `{ ..., rateCurrency: 'EUR', orgCurrency: 'EUR', partnerCurrency: 'USD' }`; assert the nudge renders; with both `'USD'` it does not. Dirty-field save: load with `defaultHourlyRate: 100`, change only an SLA field, save → the PATCH body has **no** `defaultHourlyRate` key; change the rate to 120 → body has `defaultHourlyRate: 120`. `TicketCategoriesPage.test.tsx`: a category `{ defaultHourlyRate: '100.00', rateCurrency: 'CAD' }` renders a CAD-formatted rate (`/CA\$|CAD/`); `/orgs/partners/me` returning 403 still renders the page without a toast.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/web test OrgTicketSettingsEditor TicketCategoriesPage`.
- [ ] **Step 3: Implement** both components (locale keys land in Task 18 — add the `en` keys in this task so the component tests pass; the other 7 locales follow in Task 18).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): org ticket-settings currency nudge; category rates show their currency (#3776)`.

### Task 16: Web — per-currency ticket billing summary, parts, timesheet

**Executor:** claude (UI).

**Files:**
- Modify: `apps/web/src/components/tickets/TicketTimeBilling.tsx:7-12` (imports/type), `:113-131` (summary list)
- Modify: `apps/web/src/components/tickets/TicketPartsCard.tsx:6,11-19,185-215`
- Modify: `apps/web/src/components/time/TimesheetPage.tsx:19-44` (types), week-total header (money line), entry row (rate display)
- Test: `apps/web/src/components/tickets/TicketTimeBilling.test.tsx:11,25-26`, `TicketPartsCard.test.tsx:10,24-26`, `apps/web/src/components/time/TimesheetPage.test.tsx`

**Interfaces:**
- `BillingSummary` → `{ time: { totalMinutes; billableMinutes; billableAmounts: { currencyCode: string; amount: string }[] }; parts: { partsCount; billableTotals: { currencyCode: string; amount: string }[] } }`. Money renders via `formatMoney(amount, currencyCode)` from `../billing/shared/format` (drop the `lib/timeFormat.formatMoney` import in these three files; `lib/timeFormat.ts` itself stays — wave 5 retires it). The `ticket-billing-amount` / `ticket-billing-parts-total` `<dd>`s render one `<span data-testid="ticket-billing-amount-{code}">` per currency (an empty list renders `—`).
- `PartRow` gains `currencyCode: string`; every `formatMoney(x)` in the card becomes `formatMoney(x, part.currencyCode)`.
- `TsEntry` gains `currencyCode: string | null`; `TsSheet.totals` gains `billableAmounts`; the week header renders one `formatMoney(amount, currencyCode)` chip per entry under `data-testid="timesheet-billable-amounts"`; the entry rate cell renders `formatMoney(rate, entry.currencyCode)` only when **both** `hourlyRate` and `currencyCode` are non-null, otherwise `—` (`ticketTimeBilling.noAmount`). **No USD display fallback anywhere** — after Task 1's `time_entries_currency_required_when_rate_chk` a rate without a currency cannot exist, and labelling an ambiguous number as USD would be exactly the reinterpretation spec §2 forbids.

- [ ] **Step 1: Update/extend tests**: `TicketTimeBilling.test.tsx` fixture → new shape with `billableAmounts: [{ currencyCode: 'EUR', amount: '150.00' }]`; assert `€150.00` (or the `Intl` output for the test locale). `TicketPartsCard.test.tsx` fixture gains `currencyCode: 'EUR'`; assert `€`. `TimesheetPage.test.tsx`: `totals.billableAmounts` renders two chips for `[EUR, USD]`; an entry `{ hourlyRate: '50.00', currencyCode: 'JPY' }` renders `¥50` (not `$`), and an entry `{ hourlyRate: null, currencyCode: null }` renders `—` with no `$` anywhere in its row.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/web test TicketTimeBilling TicketPartsCard TimesheetPage`.
- [ ] **Step 3: Implement** the three components.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(web): per-currency money on ticket billing summary, parts, and timesheet (#3776)`.

### Task 17: Web — assembly blocked groups + old-currency draft; move-org block guidance + deliberate "move anyway" confirmation

**Executor:** claude (UI).

**Files:**
- Modify: `apps/web/src/components/billing/InvoicesPage.tsx:119-127` (state), `:223-256` (`submitDialog`), `:742-805` (dialog fields)
- Modify: `apps/web/src/components/tickets/TicketWorkbench.tsx:397-415` (`createInvoice`), `:417-423` (`handleMoveOrg`), `:830-858` (move form — the confirm button at `:854` currently fires `handleMoveOrg(...)` and `setMoveOrgOpen(false)` in the same tick, so any guidance rendered inside the form is unmounted before the 409 arrives)
- Test: `apps/web/src/components/billing/InvoicesPage.test.tsx`, `apps/web/src/components/tickets/TicketWorkbench.test.tsx:1651-1740`

**Interfaces:**
- `InvoicesPage`: new state `assembleCurrency: string` (`''` = organization default) rendered as a `<select data-testid="invoices-assemble-currency">` in assemble mode with an `''` option (`invoicesPage.dialog.currencyOrgDefault`) plus the curated list from `apps/web/src/lib/currencies.ts`; the POST body adds `currencyCode: assembleCurrency || undefined`. New state `blockedGroups: { currencyCode: string; count: number; amount: string }[]`: on `ActionError` with `code === 'ALL_BLOCKED_BY_CURRENCY'` read `(err.body as { details?: { blockedByCurrency?: ... } }).details?.blockedByCurrency`, keep the dialog open, render `<div data-testid="invoices-assemble-blocked">` listing `invoicesPage.dialog.allBlockedByCurrency` and one `<button data-testid="invoices-assemble-in-{code}">` per group that sets `assembleCurrency = code` and re-submits. On success with non-empty `result.data.blockedByCurrency`, `showToast({ type: 'warning', message: t('invoicesPage.dialog.blockedByCurrency', { count, code }) })` before navigating.
- `TicketWorkbench.createInvoice`: on `ActionError` `ALL_BLOCKED_BY_CURRENCY` set `invoiceBlocked` state from `err.body.details.blockedByCurrency` and render a small panel under the invoice button with one `<button data-testid="ticket-assemble-in-{code}">` per group that POSTs `/tickets/${ticketId}/invoice?currencyCode=${code}` and navigates on success. `handleMoveOrg(targetOrgId, opts: { acceptCurrencyMismatch?: boolean } = {})` becomes `async` and **returns a boolean**; the confirm button (`:854`) awaits it and calls `setMoveOrgOpen(false)` only on `true` — the dialog stays mounted on failure. On `ActionError` with `code === 'TICKET_MOVE_CURRENCY_BLOCKED'` set `moveBlocked` from `err.body.details` (`{ sourceCurrency, targetCurrency, unbilledTimeEntries, unbilledParts }`) and render inside the move form: `<p data-testid="ticket-move-blocked-currency">{t('ticketWorkbench.move.blockedCurrency', { timeCount, partCount, sourceCurrency, targetCurrency, targetOrg })}</p>`, then a **deliberate confirmation** — `<label><input type="checkbox" data-testid="ticket-move-accept-currency" …/> {t('ticketWorkbench.move.acceptCurrency', { sourceCurrency })}</label>` and `<button data-testid="ticket-workbench-move-org-accept" disabled={!acceptChecked}>{t('ticketWorkbench.move.moveAnyway')}</button>` which re-POSTs `{ orgId, acceptCurrencyMismatch: true }` and closes on success. A 403 on that re-POST (no `invoices:write`) is toasted by `runAction` with the server message; the checkbox resets whenever the target org changes. The original `runAction` toast still fires with the server message on the first 409 (spec §7: bill first, or explicitly accept).

- [ ] **Step 1: Write failing tests**: `InvoicesPage.test.tsx`: mock the assemble POST to return 409 `{ error, code: 'ALL_BLOCKED_BY_CURRENCY', details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 2, amount: '250.00' }] } }` → blocked panel renders with `invoices-assemble-in-EUR`; clicking it re-POSTs with `currencyCode: 'EUR'`. `TicketWorkbench.test.tsx`: move-org POST returning 409 `TICKET_MOVE_CURRENCY_BLOCKED` with details → the move dialog is **still open** (`ticket-workbench-move-org-confirm` present) and `ticket-move-blocked-currency` renders; `ticket-workbench-move-org-accept` is disabled until `ticket-move-accept-currency` is checked; clicking it re-POSTs `/tickets/:id/move-org` with body `{ orgId, acceptCurrencyMismatch: true }` and, on 200, the dialog closes and `load` refetches; a successful first move still closes the dialog; invoice POST returning 409 `ALL_BLOCKED_BY_CURRENCY` → `ticket-assemble-in-EUR` renders and re-POSTs with `?currencyCode=EUR`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/web test InvoicesPage TicketWorkbench`.
- [ ] **Step 3: Implement** both components (remember `handleActionError` / the `ActionError` catch pattern from CLAUDE.md — a non-401 `ActionError` is already toasted by `runAction`).
- [ ] **Step 4: Run** → PASS; also `pnpm --filter @breeze/web test no-silent-mutations` (new POST handlers must go through `runAction`).
- [ ] **Step 5: Commit** — `feat(web): assembly blocked-by-currency recovery and move-org currency guidance (#3776)`.

### Task 18: Locale catalogs (8 locales) + docs

**Executor:** claude (i18n parity sweep).

**Files:**
- Modify (all 8 locales: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` under `apps/web/src/locales/<locale>/`): `settings.json` keys `ticketCategoriesPage.defaultHourlyRate` (`en:2254`) and `orgTicketSettingsEditor.billing.hourlyRate` (`en:2755`) → `"Default hourly rate ({{currency}})"`; new `orgTicketSettingsEditor.billing.currencyNudge`; `tickets.json` new `ticketWorkbench.invoice.blockedByCurrency`, `ticketWorkbench.invoice.assembleIn`, `ticketWorkbench.move.blockedCurrency`, `ticketWorkbench.move.acceptCurrency`, `ticketWorkbench.move.moveAnyway`, `ticketTimeBilling.noAmount`; `billing.json` new `invoicesPage.dialog.currency`, `invoicesPage.dialog.currencyOrgDefault`, `invoicesPage.dialog.blockedByCurrency`, `invoicesPage.dialog.allBlockedByCurrency`, `invoicesPage.dialog.assembleIn`.
- Modify (explicit file list — the `update-breeze-docs` skill governs tone/structure; these are the files it must touch): `apps/docs/src/content/docs/features/ticketing.mdx:252` (per-org rate is in the org's currency; partner category rates apply only when currencies match), `:282-284` (CSV gains a `currency` column; totals are per currency), plus one paragraph under the move-org section (blocked across currencies while unbilled work exists; "Move anyway" keeps those items in the old currency, needs `invoices:write`, and they can only be invoiced on a draft in that currency); `apps/docs/src/content/docs/features/invoices.mdx` (assembly: "Organization default" vs explicit currency in the assemble dialog; the blocked-by-currency panel and what "Assemble in <code>" does; invoiced time/parts can no longer have their amounts edited).
- Test: `apps/web/src/lib/i18n/localeParity.test.ts`, `keyUsage.test.ts`, `translationCoverage.test.ts`

**Interfaces (en strings):**
- `orgTicketSettingsEditor.billing.currencyNudge`: `"This organization bills in {{orgCurrency}}, but your partner-level rates are in {{partnerCurrency}}. Category default rates will not apply here — set a local rate in {{orgCurrency}}."`
- `ticketWorkbench.invoice.blockedByCurrency`: `"Unbilled work on this ticket is in {{codes}}; the organization now bills in another currency."`; `ticketWorkbench.invoice.assembleIn`: `"Assemble a draft in {{code}}"`; `ticketWorkbench.move.blockedCurrency`: `"Cannot move: {{timeCount}} unbilled time entries and {{partCount}} unbilled parts are in {{sourceCurrency}}, but {{targetOrg}} bills in {{targetCurrency}}. Invoice them first (or assemble a {{sourceCurrency}} draft), then move."`; `ticketWorkbench.move.acceptCurrency`: `"I understand these items stay in {{sourceCurrency}} and can only be invoiced on a {{sourceCurrency}} draft."`; `ticketWorkbench.move.moveAnyway`: `"Move anyway"`; `ticketTimeBilling.noAmount`: `"—"`.
- `invoicesPage.dialog.currency`: `"Currency"`; `currencyOrgDefault`: `"Organization default"`; `blockedByCurrency`: `"{{count}} billable items in {{code}} were not included — assemble a separate draft in {{code}}."`; `allBlockedByCurrency`: `"All unbilled work in this range is in another currency."`; `assembleIn`: `"Assemble in {{code}}"`.
- The AI-budget `($)` labels (`ai.json:251-252`, `settings.json:116-117,1246-1248`) stay — provider spend is USD (spec §9).

- [ ] **Step 1: Run** `pnpm --filter @breeze/web test localeParity keyUsage translationCoverage` → FAIL (keys missing in 7 locales after Tasks 15–17 added `en`).
- [ ] **Step 2: Add** every key to all 8 catalogs with real translations (not English copies) — tr-TR parity fires per key (memory: `tr_tr_locale_parity_breaks_every_prefork_branch`).
- [ ] **Step 3: Update the docs** — invoke the `update-breeze-docs` skill (it exists in the Claude executor's catalog; codex cannot see it, which is why this task is `claude`) and edit exactly the two files listed under Files. Acceptance: `ticketing.mdx` mentions `currency` in the CSV column list, the per-org rate currency, the match-or-skip rule and the move-org block + "Move anyway" behaviour; `invoices.mdx` documents the assemble-dialog currency selector and the blocked-by-currency recovery.
- [ ] **Step 4: Run** the three i18n suites + `pnpm --filter @breeze/web test` → PASS.
- [ ] **Step 5: Commit** — `feat(web,docs): currency-neutral ticketing labels in all locales; ticketing docs (#3776)`.

### Task 19: Backfill anomaly-count and snapshot-permanence integration tests

**Executor:** claude (replays the migration inside a rolled-back transaction with a NOTICE collector).

**Files:**
- Create: `apps/api/src/__tests__/integration/ticketingCurrencyBackfill.integration.test.ts`
- Extend: `apps/api/src/__tests__/integration/ticketingCurrencyMigration.integration.test.ts` (Task 1) with snapshot-permanence cases

**Interfaces:**
- Backfill test: open a dedicated `postgres(DATABASE_URL, { max: 1, onnotice: (n) => notices.push(n.message) })` client (pattern: `backupProfilesPartnerRls.integration.test.ts:732`); inside ONE transaction: `ALTER TABLE ticket_parts ALTER COLUMN currency_code DROP NOT NULL`, `ALTER TABLE org_ticket_settings ALTER COLUMN rate_currency DROP NOT NULL`, `ALTER TABLE time_entries DROP CONSTRAINT time_entries_currency_required_when_org_chk`, `ALTER TABLE ticket_categories DROP CONSTRAINT ticket_categories_rate_currency_chk`; insert 2 org-linked entries, **1 standalone entry with `hourly_rate '50.00'` and `org_id NULL`**, 1 part, 1 org settings row, 1 category with a rate — all with NULL currency (also `DROP CONSTRAINT time_entries_currency_required_when_rate_chk`); replay `readFileSync(path.join(__dirname, '../../../migrations/2026-08-30-ticketing-currency.sql'))` via `client.unsafe(sql)`; assert `notices` contains `backfilled currency_code on 2 time_entries`, `backfilled currency_code on 1 standalone rated time_entries from partner`, `... 1 ticket_parts`, `... 1 org_ticket_settings`, `... 1 ticket_categories`, and the rows now carry the org/partner currency (the standalone one carries the **partner** currency); `ROLLBACK` (DDL is transactional — the live schema is untouched; `autoMigrate.test.ts` keeps the path reference honest).
- Snapshot permanence (real DB, service-level): (a) `updateTimeEntry(id, { hourlyRate: 200 })` leaves `currency_code` unchanged; (b) flipping `organizations.currency_code` leaves every existing `time_entries`/`ticket_parts`/`org_ticket_settings` row unchanged; (c) after the flip: `upsertOrgTicketSettings(org, { defaultBillable: false }, 'GBP')` leaves `rate_currency` at the old value; `upsertOrgTicketSettings(org, { slaOverrides: {...}, defaultHourlyRate: <the SAME stored rate>, defaultBillable: true }, 'GBP')` — the exact shape the editor sends on an SLA-only save — **also** leaves it at the old value (the `IS DISTINCT FROM excluded.default_hourly_rate` CASE); `{ defaultHourlyRate: 90 }` restamps to `'GBP'`. Category twin via the PATCH route against the real DB: `{ name: 'renamed', defaultHourlyRate: <same> }` after a partner currency flip keeps `rate_currency`; a new number restamps.

- [ ] **Step 1: Write both tests.**
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test:integration ticketingCurrencyBackfill ticketingCurrencyMigration` → PASS.
- [ ] **Step 3: Commit** — `test(api): ticketing currency backfill anomaly counts and snapshot permanence (#3776)`.

### Task 20: Full-suite verification + PR

**Executor:** claude.

- [ ] **Step 1:** `pnpm --filter @breeze/api test`, `pnpm --filter @breeze/web test`, `pnpm --filter @breeze/shared test`, the full `pnpm --filter @breeze/api test:integration` (test DB up via `test:docker:up`; see memory `integration_suite_needs_fsync_off_tmpfs_locally` if it looks hung), `pnpm db:check-drift`, turbo typecheck.
- [ ] **Step 2:** Re-grep the stamping blind spots: `git grep -n "insert(timeEntries)\|insert(ticketParts)\|insert(orgTicketSettings)\|insert(ticketCategories)" -- 'apps/' 'ee/'` — every production insert stamps currency (or has no rate, for categories); `git grep -n "billableAmount\b\|billableTotal\b" -- 'apps/api' 'apps/web/src/components/tickets' 'apps/web/src/components/billing'` → zero hits (the removed API response fields and their consumers). **Not** a repo-wide grep: `longTail.time.TimesheetPage.billableTotal` (`apps/web/src/components/time/TimesheetPage.tsx:562` + 8 locale catalogs) is a legitimate *minutes* label and stays. Also `git grep -n "?? 'USD'\|?? \"USD\"" -- 'apps/web/src/components/tickets' 'apps/web/src/components/time' 'apps/api/src/services/timeEntryService.ts' 'apps/api/src/services/invoiceAssembly.ts'` → zero hits (no display or compute fallback reinterprets an amount as USD).
- [ ] **Step 3:** `git grep -n "timeFormat'" -- 'apps/web/src/components/tickets' 'apps/web/src/components/time'` → no `formatMoney` imports from `lib/timeFormat` remain in the three migrated files.
- [ ] **Step 4:** Push, open PR: title `feat: multi-currency wave 4 — ticketing currency snapshots, match-or-skip rates, assembly blocked groups (#3776)`; body summarizes B5, the four columns + backfill, match-or-skip, snapshots, assembly `{included, blockedByCurrency}` + old-currency draft path, issue-time source-currency assertion, the move-org guard, per-currency summaries/CSV, web surfaces, and the owner decisions below; PR targets `main` (not stacked) so Integration Tests run on the PR itself; body ends with `Closes #3776`.
- [ ] **Step 5:** One review round (repo policy), then merge on green with `gh pr merge --squash --admin`.

## Self-Review Notes

- Spec §7 schema: Task 1 (all four columns, CHECKs, FKs, backfill warnings) + Task 2 (export policy on the three `org_id` tables). Rate chain match-or-skip + resolver returns rate with currency: Task 6. Snapshot stamping + never-restamp: Task 7 (+ Task 4/5 for setting/category currencies, Task 19 proves permanence). Assembly `{included, blockedByCurrency}` + "assemble a draft in <old currency>": Tasks 10–11 (integration test per §14). Issue-time source-currency hook: Task 12. Ticket org-move guard: Task 13. CSV `currency` column, `getTicketBillingSummary` / timesheet money / `listBillables` per-currency groups: Tasks 8–9. Org-settings UI nudge + assembly blocked-group UI: Tasks 15–17. §9 label/AI-tool wording: Tasks 14, 18. §14 tests: assembly blocked-group after org currency change (Task 11), backfill anomaly counts (Task 19), move block (Task 13), issue mismatch under lock (Task 12).
- Type consistency checked: `CurrencyAmount { currencyCode, amount }` (Tasks 8, 9) vs `BlockedCurrencySummary { currencyCode, count, amount }` (Task 11) — web Task 16/17 types mirror them; `resolveTicketLink().currencyCode: string` (Task 6) is what Tasks 7 and 13 consume; `listBillables` returns `{ rows, totalsByCurrency }` and Task 9's route edit destructures it.
- Deliberate scope calls, flagged for the owner: (a) relinking an already-stamped entry to an org in another currency **rejects** (`CURRENCY_MISMATCH` 409) rather than allow-and-strand — the snapshot rule has no "restamp on relink" exception; (b) `getTimesheet` had no money at all — "timesheet money per-currency" is implemented as `totals.billableAmounts` computed from the fetched entries (no per-day money); (c) the device org-move is guarded by the same locked guard as the ticket move (Task 13) and accepts the same `acceptCurrencyMismatch` flag API-only — there is no device-move web UI to add a confirmation to; (d) `org_ticket_settings.rate_currency` / `ticket_categories.rate_currency` restamp only when the stored rate value actually changes (SQL `IS DISTINCT FROM excluded…` / existing-row compare), never because the editor resent the same number; (e) the ticket-path currency override travels as a query param (`?currencyCode=`) because the endpoint is body-less and an optional JSON validator rejects an empty body — CLAUDE.md's hash-vs-query rule governs web UI state, not API inputs; (f) `getTicketBillingSummary` drops the scalar `billableAmount`/`billableTotal` fields outright (a cross-currency sum is the bug class this program kills) — web consumers are updated in the same PR; (g) **labor rounding rule (codex #8):** one rule everywhere — hours to two decimals first (the existing `numeric(10,2)` quantity schema), then `roundToCurrency(hours × rate)`; 20 min × 1,000 JPY = **330** on the invoice line, the ticket summary, the timesheet and the billables CSV alike (the CSV previously printed `333.33` from exact hours — that inconsistency is what this fixes); no quantity-precision migration this wave; (h) `acceptCurrencyMismatch` is gated on `invoices:write` in addition to the move's `tickets:write` + `organizations:write` + MFA because the consequence is a billing one; AI tools never send it; (i) monetary edits of `billed` rows are rejected (`ENTRY_BILLED` / `PART_BILLED`, description-only edits still allowed) — deleting a billed row is unchanged this wave (tracked as a follow-up; the lock-and-re-read makes it a one-line addition).
- Codex plan review (2026-08-22) folded in: #1 standalone rates carry currency (+ `time_entries_currency_required_when_rate_chk`, partner-currency backfill, no USD display fallback); #2/#5 global lock order `tickets → time_entries → ticket_parts` shared by ticket and device moves (Task 13); #3 Task 7 is Claude-executed, holds the ticket lock through linked create/relink, locks-and-re-reads before edits, rejects billed edits, two-client race tests from the `invoiceIssueRace` holder pattern; #4 `acceptCurrencyMismatch` API + deliberate UI confirmation; #6 guard ignores `isBillable`; #7 restamp only when the stored rate changes; #8 single labor rounding rule (330); #9 `currencyCodeSchema` in the AI schema; #10 move dialog stays mounted on 409; #11 all three `parts.test.ts` mocks + scoped grep; #12 rated category fixtures stamped + audit grep; #13 `defaultsSummary()` anchor + currencies from the ticket-settings response; #14 rejected — `update-breeze-docs` is in the Claude executor's skill catalog (codex cannot see it); Task 18 keeps the skill and now lists the doc files explicitly.
