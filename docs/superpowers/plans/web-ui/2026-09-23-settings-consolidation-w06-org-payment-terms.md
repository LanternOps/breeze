---
tracking_issue: LanternOps/breeze#6223
wave: W06 (#6229)
---

# Settings consolidation W06 — org-level payment terms override

> **For agentic workers:** execute task-by-task, red first. Checkbox (`- [ ]`) steps.

**Goal:** Let an organization override the partner's invoice payment terms
(`partners.invoice_terms_days`). Blank = inherit. The resolved value is frozen
onto each invoice as its `due_date` at issue, on every issue path.

**Contract:** quorum GH W06 amendments 1–6
(`~/.claude/breeze-handoff/6223-wave2-quorum-2026-09-23.md`). Quorum wins over
the positions doc (`2026-09-17-settings-consolidation-wave2-design-positions.md`,
whose internal "W05" is this wave).

**Settings rule 9 statement:**
- Home: org settings → Billing tab (`OrgBillingSettings.tsx`), next to tax rate.
- Level: partner default (`partners.invoice_terms_days`, Billing → Defaults) →
  org override (`organizations.invoice_terms_days`, NULL = inherit) → frozen on
  the invoice as `due_date` at issue.
- Resolver: `resolveInvoiceTermsDays(orgTerms, partnerTerms)` =
  `org ?? partner ?? 30` (`services/invoiceTerms.ts`).
- Places configured: before 1 (partner only) → after 2 levels, one place per level.

## Verified facts (re-checked on `origin/main` 32eeb5b27c, 2026-09-23)

| Fact | Where |
|---|---|
| Partner terms `NOT NULL DEFAULT 30` | `db/schema/orgs.ts:109` |
| Orgs have no terms column | `db/schema/orgs.ts:185-227` |
| Normal issue due date | `services/invoiceService.ts:1474` (`partner?.invoiceTermsDays ?? 30`); org row already read as `select()` at `:1462` |
| Quote-accept direct issue due date | `services/quoteAcceptService.ts:516` (`partner?.termsDays ?? 30`); partner read at `:339-348`; **no org read today** — runs under `withSystemDbAccessContext` |
| Contract auto-issue delegates to `issueInvoice` | `jobs/contractWorker.ts:119-123`, `routes/contracts/generate.ts:39-43`; `contractWorker.test.ts` mocks `issueInvoice` but never asserts the call |
| Stale "partner terms" comment | `services/invoiceService.ts:563-565` (moved from `:541`) |
| Draft `dueDate` still editable; issued due date never restamped | `updateInvoiceHeader` draft-only |
| Org billing projection / PATCH | `services/invoiceService.ts:1089-1219` |
| Shared validator | `packages/shared/src/validators/invoices.ts:146` (`orgBillingSettingsSchema`, `.strict()`) |
| Partner default response next to tax | `routes/orgs.ts:2066-2078` (`partnerDefaultTaxRate`) — `GET /orgs/organizations/:id` returns `select()` so the new column rides along |
| Export policy | `services/tenantExportPolicyRegistry.ts:782` (`organizations.included`) |
| Org merge | loser-shell: `orgMergeRegistry.ts` `organizations` entry; survivor row untouched |
| Latest migration | `2026-10-29-100100-invoice-presentation-snapshot.sql` → ours `2026-10-29-100500-org-invoice-terms-days.sql` sorts last |

## Tasks

### Task 1 — pure resolver
- [ ] Red: `services/invoiceTerms.test.ts` — precedence (org wins), org NULL → partner,
  both NULL → 30, **org 0 wins over partner 30** (`??` not `||`), partner 0 honoured,
  `computeDueDate(issueDate, days)` returns `YYYY-MM-DD` UTC. Plus a static sweep
  guard: no `services/**/*.ts` (non-test) other than `invoiceTerms.ts` contains
  `TermsDays ?? ` — a new issue writer must use the resolver.
- [ ] Green: `services/invoiceTerms.ts` exporting `DEFAULT_INVOICE_TERMS_DAYS = 30`,
  `resolveInvoiceTermsDays`, `computeDueDate`.

### Task 2 — schema + migration + export policy
- [ ] `organizations.invoiceTermsDays: integer('invoice_terms_days')` (nullable, no default).
- [ ] Migration `2026-10-29-100500-org-invoice-terms-days.sql`: `ADD COLUMN IF NOT EXISTS`,
  CHECK `organizations_invoice_terms_days_range_chk` added under a `pg_constraint`
  existence check. No DML → no scope election.
- [ ] Add `invoice_terms_days` to `organizations.included` in `CORE_TENANT_EXPORT_POLICY`.
- [ ] `pnpm db:check-drift`; `autoMigrate.test.ts`, `migrationRlsScope.test.ts`.

### Task 3 — both issue writers
- [ ] Red (`invoiceService.test.ts` issue block): org `invoiceTermsDays: 7`, partner 30 →
  `dueDate = issue + 7`; org 0 → due today; org null → partner 14.
- [ ] Red (`quoteAcceptService.test.ts`): new org-terms read; org 10 → due +10; org null →
  partner terms.
- [ ] Green: `invoiceService.issueInvoice` uses `computeDueDate(issueDate,
  resolveInvoiceTermsDays(org?.invoiceTermsDays, partner?.invoiceTermsDays))`.
  `quoteAcceptService` reads `organizations.invoiceTermsDays` for `quote.orgId`
  (system context, same as the partner read) inside the one-time branch.
- [ ] Fix the stale "partner terms" comment on `updateInvoiceHeader`.
- [ ] Contract delegation: `contractWorker.test.ts` asserts auto-issue calls
  `issueInvoice(invoiceId, actor)` (so terms resolution cannot fork there).

### Task 4 — shared validator + PATCH + projection
- [ ] Red (`packages/shared` validator test): `invoiceTermsDays` accepts 0, 365, null;
  rejects −1, 366, 1.5.
- [ ] Red (`invoiceService.test.ts`): PATCH writes `invoiceTermsDays` (and null clears);
  cross-org actor → `ORG_DENIED` 403 before any write.
- [ ] Green: `invoiceTermsDays: z.number().int().min(0).max(365).nullable().optional()`;
  service patch type + `set.invoiceTermsDays`; `orgBillingProjection` includes it.

### Task 5 — partner-default response
- [ ] Red (`routes/orgs` test for GET `/organizations/:id`): response carries
  `partnerDefaultInvoiceTermsDays`.
- [ ] Green: select `invoiceTermsDays` alongside `defaultTaxRate`.

### Task 6 — web
- [ ] Red (`OrgBillingSettings.test.tsx`): blank field shows placeholder `30` and
  "Partner default"; entering 14 PATCHes `invoiceTermsDays: 14`; clearing sends null;
  out-of-range blocks save.
- [ ] Green: `InheritedField` in a "Payment terms" section; save via existing `runAction`.
- [ ] i18n: `orgBillingSettings.terms.{title,paymentTermsDays,description,invalid}` in 8 locales.

### Task 7 — merge + contract suites
- [ ] Org merge: cite the loser-shell contract (`orgMergeRegistry.ts` organizations
  entry + `orgMerge.ts` terminal op marks loser deleted only) — survivor keeps its
  own `invoice_terms_days`; no registry change.
- [ ] `pnpm test-stack up` → `tenant-export-policy.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts`,
  `invoiceService.issue.integration.test.ts` (extend with an org override case) → down.

### Task 8 — verify + PR
- [ ] API tsc, web tsc, targeted vitest; PR with `Closes #6229`, `Part of #6223`, rule 9.

## Non-goals
- No restamp of issued invoices' due dates. No change to draft `dueDate` editing.
- No partner-wide/ownerScope axis: this is an org column override of a partner column.
