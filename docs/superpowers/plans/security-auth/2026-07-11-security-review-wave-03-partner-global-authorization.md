# Security Review Wave 3: Partner-Global Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Require explicit partner-wide authority for every route that reads or mutates partner-global configuration or data.

**Architecture:** Centralize the full-partner-scope decision in `canManagePartnerWidePolicies(auth)`, add route-family-specific read/manage permissions, and combine full scope, permission, and MFA for sensitive writes. Never infer full scope by enumerating accessible organizations.

**Tech Stack:** TypeScript, Hono middleware, Drizzle ORM, PostgreSQL migrations, Vitest, OrbStack.

**Global Constraints:** Partner Admin retains intended access; custom roles receive no new grants automatically; denied reads reveal no global data; mutations are audited; account-deletion subjects are constrained by caller type and accessible organization.

**Findings:** SR1-03, SR1-09, SR1-10, SR1-11, SR1-12, SR1-18, SR1-19, SR1-21, SR1-22, SR1-26, SR1-30.

**Design:** `docs/superpowers/specs/2026-07-11-security-review-wave-03-partner-global-authorization-design.md`

## File map

- Modify `apps/api/src/services/partnerWideAccess.ts` and add/extend its test.
- Add `apps/api/migrations/2026-07-11-a-partner-global-permissions.sql`; update `apps/api/src/db/seed.ts` and permission registry/tests.
- Modify routes/tests: `roles.ts`, `accessReviews.ts`, `authenticator.ts`, `auth/accountDeletion.ts`, `updateRings.ts`, `patches/approvals.ts`, `connectedApps.ts`, `huntress.ts`, `clientAi/adminTemplates.ts`, `tickets/ticketResponseTemplates.ts`, and `invoices/settings.ts`.

## Task 1: Freeze the partner-wide gate contract

- [ ] Add failing tests for partner admin/full scope, unrestricted custom role, org-restricted role, site-restricted role, missing auth, and misleading “all currently existing orgs” access.
- [ ] Implement or tighten:

```ts
export function canManagePartnerWidePolicies(auth: AuthContext): boolean;
export function assertPartnerWideAccess(auth: AuthContext): void;
```

The result must derive from authenticated scope metadata, never an organization query.
- [ ] Run `pnpm --filter=@breeze/api test -- services/partnerWideAccess.test.ts`; expect GREEN.
- [ ] Commit: `fix(authz): centralize partner-wide scope gate`.

## Task 2: Add explicit permission vocabulary

- [ ] Add registry/seed tests for `update_rings:read/manage`, `patch_approvals:read/manage`, `integrations:read/manage`, `client_ai_templates:read/manage`, `ticket_response_templates:read/manage`, and `billing_settings:read/manage`.
- [ ] Write idempotent migration `2026-07-11-a-partner-global-permissions.sql` inserting missing permissions and granting the approved conservative built-in-role matrix. Do not grant custom roles.
- [ ] Update `apps/api/src/db/seed.ts` and shared permission constants to mirror the migration.
- [ ] Run seed, permission, and migration tests plus `pnpm db:check-drift`; expect GREEN.
- [ ] Commit: `feat(authz): add partner-global route permissions`.

## Task 3: Roles and access reviews (SR1-03)

- [ ] Add route tests proving org/site-restricted callers cannot list, inspect, create, update, or delete partner-level roles or access reviews, including when their org list happens to cover all current orgs.
- [ ] Apply `assertPartnerWideAccess` before partner-global queries in `roles.ts` and `accessReviews.ts`; retain existing permission checks and require MFA on writes.
- [ ] Scope any subject detail lookup before serialization and audit all mutations.
- [ ] Run `roles.test.ts` and `accessReviews.test.ts`; expect GREEN.
- [ ] Commit: `fix(authz): protect partner roles and access reviews`.

## Task 4: Authenticator and account deletion (SR1-09, SR1-10)

- [ ] Add tests for authenticator policy reads/writes across full, org-restricted, and site-restricted callers; require MFA on changes.
- [ ] Add account-deletion tests: partner staff can act only with full-partner authority; org members can act only on subjects in an accessible org; cross-org and unknown subjects have indistinguishable denial.
- [ ] Gate `authenticator.ts` and restructure `auth/accountDeletion.ts` to authorize the subject before returning status or mutating records.
- [ ] Audit policy and deletion-request mutations with actor and target identifiers.
- [ ] Run focused tests; expect GREEN.
- [ ] Commit: `fix(authz): constrain authenticator and account deletion administration`.

## Task 5: Update rings and patch approvals (SR1-11, SR1-12)

- [ ] Add read/manage permission matrix tests to `updateRings_list_create.test.ts`, `updateRings_detail_update_delete.test.ts`, and `patches/approvals.test.ts`.
- [ ] Require full partner scope plus the exact read permission for GET and exact manage permission plus MFA for mutations.
- [ ] Apply gates before partner-level selects; audit create/update/delete/approval actions.
- [ ] Run all update-ring and approval tests; expect GREEN.
- [ ] Commit: `fix(authz): gate update rings and patch approvals`.

## Task 6: Connected applications (SR1-18, SR1-19)

- [ ] Add tests to `connectedApps.test.ts` and `huntress.test.ts` for read/manage separation, org/site restriction denial, secret-field minimization, and MFA on credential/configuration writes.
- [ ] Gate `connectedApps.ts` and `huntress.ts` with full scope plus `integrations:read/manage` before queries or client construction.
- [ ] Ensure responses never serialize credentials or internal error details and audit mutations without secrets.
- [ ] Run focused tests; expect GREEN.
- [ ] Commit: `fix(authz): protect partner integration settings`.

## Task 7: Shared templates (SR1-21, SR1-22, SR1-26)

- [ ] Add matrix tests to `clientAi/adminTemplates.test.ts` and `tickets/ticketResponseTemplates.test.ts` for list/detail/write paths.
- [ ] Require full scope plus `client_ai_templates:read/manage` or `ticket_response_templates:read/manage`; require MFA on writes.
- [ ] Filter or deny before template content is fetched, and audit all mutations.
- [ ] Run focused tests; expect GREEN.
- [ ] Commit: `fix(authz): gate partner template administration`.

## Task 8: Billing settings (SR1-30)

- [ ] Add tests to `invoices/settings.test.ts` proving `billing_settings:read` cannot write, manage requires full scope and MFA, and org/site-restricted callers cannot observe partner defaults.
- [ ] Gate reads and mutations in `invoices/settings.ts`; minimize returned payment/provider configuration; audit changes with sanitized before/after data.
- [ ] Run invoice settings and billing contact integration tests; expect GREEN.
- [ ] Commit: `fix(authz): protect partner billing settings`.

## Task 9: Cross-family regression and OrbStack verification

- [ ] Add a table-driven contract test that enumerates every route family above and asserts org-restricted, site-restricted, read-only, manage-without-MFA, and full-authorized outcomes.
- [ ] Apply the permission migration twice against OrbStack; verify idempotence and no custom-role grant changes.
- [ ] Run all focused route tests, `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`, `pnpm db:check-drift`, and `git diff --check`.
- [ ] Manually inspect denied requests to confirm no counts, names, integration existence, templates, or billing values leak.
- [ ] Commit: `test(authz): cover partner-global administration boundaries`.
