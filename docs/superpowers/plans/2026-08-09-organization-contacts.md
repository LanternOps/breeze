---
tracking_issue: LanternOps/breeze#3258
---
# Organization Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Breeze a first-class contact record so migrating MSPs can bring their customers' people across, and so contact PII stops being silently dropped from tenant export.

**Architecture:** New `contacts` (org-scoped, RLS shape 1) + `contact_external_links` (re-import identity). The existing `organizations.billing_contact` / `sites.contact` jsonb columns are **kept permanently** as a dual-written compatibility projection. Preview→commit importer mirroring `orgImport`.

**Tech Stack:** PostgreSQL + hand-written SQL migration, Drizzle ORM, Hono routes, Zod, React (web), Vitest.

**Spec:** `docs/superpowers/specs/onboarding-signup/2026-08-09-organization-contacts-design.md`
**Issue:** #3258 · **Epic:** #3249

---

## Decision — settled 2026-08-09

**Spec §0.2 is resolved: build the new `contacts` table**, with `portal_users` becoming a login attached to a contact. The alternative (extending `portal_users`, already the de-facto contact store via `findOrCreateEmailContact`) was considered and declined.

**Consequence for this plan: Task 9 is mandatory, not conditional.** Without repointing inbound email and backfilling/linking existing portal users, the product ends up with two person tables that drift — which is the whole argument the rejected option was making.

---

## Critical implementation notes — read before starting

1. **Do NOT plan to drop `organizations.billing_contact` or `sites.contact`.** Three shipped contracts depend on `sites.contact` existing: a partner-export watermark trigger reads it by name (`2026-07-18-partner-export-org-locks.sql:279-284`), it is a `.strict()` public partner-API DTO (`routes/partnerApi/schemas.ts:120-131`) whose records are content-hashed, and the two columns have deliberately different partner-API exposure. See spec §2.
2. **The site PATCH writer has no literal `contact:` token.** `routes/orgs.ts:~2028-2038` writes it through `{...data}` spread. A grep-driven sweep misses it. This is the exact class of miss this epic has been bitten by.
3. **Migrations must be dated `2026-08-19` or later.** The tree ships migrations through `2026-08-18`; today's date does **not** sort last, contrary to the handoff note.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-08-19-contacts.sql` | Both tables, indexes, RLS policies, backfill |
| `apps/api/src/db/schema/contacts.ts` | Drizzle schema |
| `apps/api/src/services/contacts/compat.ts` | `upsertSiteContact` / `upsertBillingContact` — the only writers |
| `apps/api/src/services/contacts/import.ts` | `previewContactImport` / `commitContactImport` |
| `apps/api/src/services/contacts/types.ts` | `ContactImportRow`, annotations |
| `apps/web/src/components/organizations/ContactsCard.tsx` | List / add / edit / delete |
| `apps/web/src/components/organizations/BulkContactImport.tsx` | Upload → map → preview → commit |
| `apps/api/src/__tests__/integration/contactsRls.integration.test.ts` | Forge tests |

### Modified files
| File | Change |
|---|---|
| `apps/api/src/routes/orgs.ts` | Contact CRUD + import routes; route all four jsonb writers through compat |
| `apps/api/src/services/invoiceService.ts` | Billing-contact write goes through compat |
| `apps/api/src/routes/invoices/settings.ts` | Same |
| `apps/api/src/services/orgImport/index.ts` | Site/billing contact writes go through compat |
| `apps/api/src/routes/partnerApi/provisioning.ts` | Site contact write goes through compat |
| `apps/api/src/services/inboundEmail/resolveOrg.ts` | `findOrCreateEmailContact` creates a contact |
| `apps/api/src/services/tenantCascade.ts` | Register both tables |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Register both tables, all columns `included` |
| `apps/api/src/services/aiToolsOrgs.ts` | Real `add_contact` |
| `apps/api/src/services/aiGuardrails.ts` | Tier + approval scope + summary |
| `apps/api/src/services/aiAgentSdkTools.ts`, `aiToolSchemas.ts` | Duplicated action enums |
| `apps/api/src/db/schema/index.ts` | Export the new schema |

---

## Task 1: Migration + schema

- [ ] Write `apps/api/migrations/2026-08-19-contacts.sql`, idempotent, no inner `BEGIN`/`COMMIT`, per spec §1.1 and §1.2.
- [ ] `contacts`: composite FK `(site_id, org_id) → sites(id, org_id)` (the required `sites_id_org_id_uniq` already exists, `2026-07-23-partner-export-material-state-hardening.sql:39`); `contacts_id_org_id_uniq`; the non-unique `(org_id, lower(email))` index; the two partial `is_primary` unique indexes.
- [ ] `contact_external_links`: composite FK `(contact_id, org_id) → contacts(id, org_id)`; `UNIQUE (org_id, system, external_id)` — **org-scoped, not partner-scoped**, deliberately diverging from `organization_external_links` so one person can exist at two customers (spec §1.2).
- [ ] Add **no** `json`/`jsonb`/`bytea` column to either table.
- [ ] Enable **and force** RLS on both; four `breeze_has_org_access(org_id)` policies each, guarded by `pg_policies` existence checks. Copy `device_mtls_certificates`.
- [ ] Add the Drizzle schema and export it.
- [ ] `pnpm db:migrate && pnpm db:check-drift` — no drift.

## Task 2: Register the contracts (do not defer)

- [ ] `CORE_ORG_CASCADE_DELETE_ORDER` — add `'contact_external_links'` and `'contacts'` alphabetically. Both sort ahead of `sites` and `organizations`.
- [ ] `CORE_TENANT_EXPORT_POLICY` — both tables, **every column `included`**. No name matches `SUSPICIOUS_NAME_PARTS`; no open containers exist by construction. This is the point of the feature.
- [ ] Add **no** `DUAL_AXIS_TENANT_TABLES` entry — that asserts a partner branch these tables do not have.
- [ ] No device-cascade entry (no `device_id`); no `AUDIT_ADMIN_REQUIRED_TABLES` entry (rows are mutable).
- [ ] Add **no** partner-export resource in this PR (spec §2 — it needs `RESOURCE_CLASSIFICATION`, locks, material state, canonical parity).

## Task 3: Backfill

- [ ] Same migration: backfill from `sites.contact` (`roles='{site}'`, `site_id` set, `is_primary`), from `organizations.billing_contact` (`roles='{billing}'`), and one contact per `portal_users` row linked via the new `portal_users.contact_id`.
- [ ] Skip blobs that are NULL, `'{}'`, or carry no `name`/`email`/`phone`.
- [ ] Every step reports its count: `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING 'backfilled % <what>', n; END IF; END $$;`
- [ ] Re-running the migration is a no-op.

## Task 4: The compat service — REQUIRED IN THIS PR

- [ ] `services/contacts/compat.ts` with `upsertSiteContact(siteId, orgId, contact, actor)` and `upsertBillingContact(orgId, patch, actor)`, each writing the contact row **and** the legacy jsonb in one transaction.
- [ ] Route every writer through it — the full list, verified, is in spec §2:
  - `routes/orgs.ts` org create, org PATCH (**whole-blob replace**), site create, **site PATCH (`{...data}` spread — no literal `contact:` token)**
  - `services/invoiceService.ts:497-506` (atomic `||` jsonb merge of email/name)
  - `routes/invoices/settings.ts:30`
  - `services/orgImport/index.ts` (~`:702,729,760,860,876`) — `:702` is the first-wins contact collapse, `:729` writes `billingContact`, `:760`/`:876` write `sites.contact`
  - `services/accounting/quickbooksCustomerImport.ts:143` (indirect, via orgImport)
  - `routes/partnerApi/provisioning.ts` site create/update
- [ ] Fix the pre-existing race as a deliberate side effect: org PATCH replaces `billing_contact` wholesale while `invoiceService` merges into it, so a partial PATCH silently drops merged keys. Both now go through `upsertBillingContact`. Add a test.
- [ ] Leave **all readers on the jsonb** in this PR. Writers move, readers do not — strictly safer than the Phase-1 sequencing.
- [ ] Sweep before calling it done: `rg -na 'billingContact|billing_contact' apps/api/src apps/web/src packages/shared/src` **and** re-read every `.update(sites)` / `.update(organizations)` call site, because the spread writer will not appear in the grep.

## Task 5: Contract + RLS verification

- [ ] Run all four contract suites against a live DB: `rls-coverage`, `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`. None of these fail in the `Test API` unit job.
- [ ] As `breeze_app`, forge a cross-tenant contact insert — must fail with `new row violates row-level security policy`.
- [ ] `contactsRls.integration.test.ts`: cross-org forge → 42501; a contact whose `site_id` belongs to another org → rejected by the composite FK; a link row whose `org_id` disagrees with its contact's → rejected; org isolation on read.
- [ ] **Partner-export regression test**: editing a site contact through the compat service still bumps `sites.partner_export_updated_at` (the trigger at `2026-07-18-partner-export-org-locks.sql:279-284` reads `sites.contact` by name).
- [ ] **Partner-API parity test**: `GET /partner-api/sites` contact payload byte-identical before/after; `organizations` still has no `billingContact` (`routes/partnerApi/organizations.test.ts:150,158`).
- [ ] Dispatch CI on the branch: `gh workflow run CI --ref <branch>`.

## Task 6: Contact CRUD + import routes

- [ ] `GET/POST /orgs/organizations/:id/contacts`, `PATCH/DELETE /orgs/contacts/:id` — reads `orgs:read`; writes `orgs:write` + `requireMfa()`.
- [ ] `POST /orgs/contacts/import/preview` and `POST /orgs/contacts/import`, max 1000 rows (`MAX_IMPORT_ROWS`).
- [ ] Annotations `create | link-match | email-match | name-match | conflict | org-not-found`. `link-match` auto-applies; `email-match` and `name-match` require an echoed `expectedAnnotation`.
- [ ] Commit **re-derives** every annotation and rejects rows whose annotation changed since preview, with identity pinning — mirror `checkExpectation` (`orgImport/index.ts:407-448`).
- [ ] Per-row failure recorded, remaining rows proceed; always HTTP 200 with `{ imported, updated, skipped, errors }`.
- [ ] `writeRouteAudit` for every contact created, updated, and deleted.

## Task 7: `add_contact` becomes real — all five edits together

- [ ] `services/aiToolsOrgs.ts` — real handler; fix the tool description (`:477`) and the input schema (`:486-492`, which currently documents params the handler ignores).
- [ ] `services/aiAgentSdkTools.ts:2051,2053` and `services/aiToolSchemas.ts:307` — the duplicated action enums.
- [ ] **`services/aiGuardrails.ts` — add `'add_contact'` to `TIER3_ACTIONS.manage_organizations` AND to `TIER3_SUPERVISED_ACTIONS.manage_organizations`.** Both. Omitting the first leaves it auto-executing with no approval while writing PII; adding only the first makes `resolveApprovalScope` fall through to the closing `return 'four_eyes'`, demanding a second approver to create a contact. Supervised is correct — `TIER3_FOUR_EYES_ACTIONS.manage_organizations` is `['create_org']` only (`:267`).
- [ ] Remove the now-false comment at `aiGuardrails.ts:203-204` ("returns guidance only").
- [ ] `buildApprovalDescription` (`aiGuardrails.ts:1366`; its `manage_organizations` branch at `:1526-1531`) — add a contact branch so the approver sees name/email instead of `Organizations: add_contact`.
- [ ] Extend `aiGuardrails.approvalScope.contract.test.ts:139-180`, which currently pins only four tools and catches none of the above.
- [ ] Test: `add_contact` resolves to `supervised` — not tier 2, not `four_eyes`.

## Task 8: Web UI

- [ ] `ContactsCard.tsx` on the organization detail page — list, add, edit, delete, role badges, "Primary" marker, site attribution. All mutations through `runAction`.
- [ ] Site detail keeps its single-contact editor (now writing through compat) and links to the full list.
- [ ] `BulkContactImport.tsx` modelled on `BulkOrgImport.tsx`: CSV → `lib/csvParse.ts` → column mapping → preview with status badges → commit.
- [ ] `email-match` / `name-match` unchecked by default; select-all spans only `create` and `link-match`.

## Task 9: Repoint inbound email — REQUIRED (§0.2 is settled)

- [ ] `services/inboundEmail/resolveOrg.ts` `findOrCreateEmailContact` creates a `contacts` row (creating a `portal_users` row only when portal access is actually granted).
- [ ] Add nullable `portal_users.contact_id` FK; backfill and link one contact per existing portal user.
- [ ] **Without this, inbound email keeps minting people in the other table and "who do I email" is permanently split across two.** This is the objection that makes §0.2 close; leaving it undone concedes the argument.
- [ ] Test: an inbound email from an unknown sender at a mapped domain creates exactly one contact and no orphan portal user.

## Task 10: Tests

- [ ] Service: link-match dedupe; email-match and name-match flagged not auto-applied; a shared mailbox (three contacts, one address) imports cleanly; an emailless contact round-trips; re-import is a no-op; partial success.
- [ ] Compat: every writer in Task 4 produces both a contact row and the jsonb; the org-PATCH/invoiceService clobber race is fixed.
- [ ] Backfill: idempotent; blobs with no usable field produce no row.
- [ ] Update, do not delete, the behaviour-pinning suites listed in spec §2: `orgBillingSettings.integration.test.ts:26-60` (incl. "clear by setting email to JSON null"), `billing-contact-info.integration.test.ts`, `invoiceService.test.ts:317-343` (asserts a Drizzle `SQL` merge expression), `quoteLifecycle.test.ts` fixtures, `orgs.test.ts:1480-1488` (projection leak guard).
- [ ] Web: preview rendering, fuzzy-match default-unchecked, `runAction` partial success.

## Task 11: Docs

- [ ] Update the three migration guides that tell readers contacts must be entered by hand: `migration/atera.mdx:29,77`, `migration/connectwise-automate.mdx:28`, `migration/syncro.mdx:30,74`.
- [ ] Add contact rows to the six guides that are currently **silent** on contacts (`datto-rmm`, `kaseya-vsa`, `n-central`, `ninjaone`, `other-rmms`, `overview`) — silence is worse than a stated limitation for a reader migrating from Datto.
- [ ] `migration/toolkit.mdx:116,120` — document the contact import endpoints.

---

## Verification

- [ ] `apps/api` and `apps/web` unit suites green (run package-local `vitest`; `pnpm` is unusable on this machine).
- [ ] All four contract suites green against a live DB (Task 5).
- [ ] Partner-export watermark and partner-API parity tests green (Task 5) — these are the two silent-bug guards.
- [ ] End-to-end: import a contacts CSV for an org with sites, confirm rows land, the jsonb projection matches, and a second import of the same file is a full skip.

## Out of scope

- Dropping the legacy jsonb columns — **not a deferral, a decision** (spec §2).
- Per-role primacy (`contact_roles`), notification routing to contacts, partner-export `contacts` resource, partner-level contact unification, per-person cross-org erasure — all in spec "Deferred".
- Custom-field backfill (#3257).
