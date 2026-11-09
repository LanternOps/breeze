---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W3: Access Policy, Access-Request Queue, Sign-in Card, Identities Read Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each customer org a portal access policy (partner default → org override) that is enforced on every request and token use. Add the `portal_access_requests` queue with approve/deny, ship the **Sign-in & registration** card (org) and the **Customer portal** tab (partner), and switch every read of external identity from `portal_users.entra_*` to `portal_user_identities` (identities release B).

**Architecture:** One migration creates `portal_access_policies` (`org_id` XOR `partner_id`, one row per owner, NULL = inherit) and `portal_access_requests` (shape 1). It extends the `auth_method` CHECK with `'google'` and re-runs the identity backfill. `services/portalAccessPolicy.ts` is the only resolver (`resolvePortalAccessPolicy`). It masks methods the deployment cannot run yet through `getPortalSignInCapabilities()`, and portal auth calls it on every session request, login, forgot-password and capability-token consume. `services/portalAccessRequests.ts` owns the queue and its approve/deny writers, through the W2 state module. Identity readers switch to `portal_user_identities`. Writers keep dual-writing `entra_*` until release C. A daily job reports drift.

**Tech Stack:** Hono, Drizzle (queries only), hand-written SQL migration, PostgreSQL forced RLS, ioredis, BullMQ, Astro + React (web), Vitest (unit + `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`. Relevant sections: §4, §5.1, §5.2 (release B), §5.3, §5.6 steps 4–5, §5.10, §6 invariants 4, 7, 8, 9, 10 and 11, and the §7 W3 row. The index is `2026-11-08-portal-registration-options-index.md`.

**Builds on (merged):** W1 #11405 and W2 #11408 (2396c14a57). It uses these W2 pieces:
- the state module `services/portalAccountState.ts`;
- the capability tokens `routes/portal/capabilityTokens.ts`;
- `portal_user_identities` with `services/portalUserIdentities.ts`;
- `loginCandidates.ts`.

**Rigor: high.** The wave touches auth, a migration, two new tenant tables (one of them dual-axis), and the AI for Office exchange. It follows full TDD, with one independent review round per PR and contract suites before each PR.

## PR split

| PR | Tasks | Branch | Body | Depends on |
|---|---|---|---|---|
| **W03a: API** | 1–8 | `feature/11377-portal-registration/wave-11380` | `Part of #11380` (never `Closes`) | main |
| **W03b: Web** | 9–13 | `feature/11377-portal-registration/wave-11380-b` | `Closes #11380` | W03a **merged to main**. Branch from fresh main and do not stack, because a stacked PR runs no CI. |

The W03a API is complete and additive. No UI calls it until W03b lands, and W03a changes no behaviour a user or MSP can see. The read switch and the policy gates resolve to today's behaviour by construction: with no policy rows, the effective password mode is `allowed`.

## Decisions taken in this plan (flag in each PR body)

- **D1: no policy cache.** The session middleware already reads Postgres on every request. `resolvePortalAccessPolicy` is one indexed query over a table with at most two rows per org, so a change takes effect on the very next request on every API instance. Cross-instance invalidation is never needed. `HotPathTtlCache` is not usable here anyway: it bypasses itself inside an ambient DB context (`services/hotPathCache.ts:136`). The spec leaves the TTL to the builder (§10), and TTL 0 is the strictest choice. If portal p95 regresses, the fallback is `HotPathTtlCache` with `cluster: true` plus `invalidateAroundCommit` on every policy write.
- **D2: an approved SSO request creates an identity-only account.**
  - The account's `auth_method` names the provider (`'entra'`, or `'google'`, which the CHECK gains in this wave). It is never `'password'`.
  - Reason: deprovisioning (W8) disables an account only when it has no other usable credential. A password added later through forgot-password would survive the leaver's IdP disable.
  - `isPasswordEligible` stays `authMethod === 'password'`.
- **D3: one pending request per `(org_id, email)`.**
  - It is a partial unique index, and a repeat attempt only bumps `last_requested_at`.
  - Expiry is 14 days, stored in `expires_at` and applied lazily: reads filter on it, and create/approve treat a past row as expired.
  - There are at most 200 pending requests per org (`PORTAL_ACCESS_REQUEST_PENDING_CAP`).
- **D4: writer fence.** Until release C, every writer that creates an **Entra** identity also writes `portal_users.entra_tenant_id/entra_oid`, and every writer that removes one clears them. In W3 that means the JIT exchange and approving an `entra` request. A rolling-deploy release-A instance, which still reads the columns, then finds every account. Recorded in the index's cross-wave table for W4/W8/W9.
- **D5: the add-in exchange drops `authMethod !== 'entra'` (`clientAiExchange.ts:433`).** The identity lookup is now the gate, per spec §5.2 release B. In W3 the only accounts with an Entra identity are add-in JIT rows and approved `entra` requests, and both have `auth_method='entra'`, so nothing changes until W4 links identities to password accounts.
- **D6: browser session payloads gain `method`.**
  - The type is `PortalSessionMethod = 'password' | 'entra' | 'google'`, and a payload without `method` parses as `'password'`, since every session minted before W3 is a password session.
  - An unknown value is refused.
  - Only `'password'` is minted in W3. The policy gate already covers all three methods for W4/W7.
- **D7: three RLS policies on `portal_access_policies`.**
  - The `FOR ALL` dual-axis policy and the SELECT-only partner-default branch (`partner_id = breeze_current_partner_id()`) both come from the playbook.
  - A third SELECT-only `org_member_select` branch copies the `business_calendars` template (`2027-01-03-160000-business-calendars.sql:414-425`). Portal sessions run with `currentPartnerId: null` (`routes/portal/portalDbContext.ts:20`), and so do org-scoped tokens. Without this branch, a resolver called in those contexts would silently fall back to built-in defaults instead of the partner's.
- **D8: the partner-wide pending count sits on the partner Customer portal tab, with per-org links.** No sidebar badge: spec §5.10 defers notification fan-out.
- **D9: `portal_access_requests.org_id NOT NULL` (no `partner_id`).** A request asks for one org's portal. It is queue data, not configuration, so the partner-wide-first rule (#2135) does not apply. State this justification in the W03a PR.
- **D10: the reconciliation job reports and never repairs.** **This deviates from approved spec §5.2 release B** ("a reconciliation job reports and repairs drift"), so it is also listed as OD5 for Todd.
  - Repair happens once, at deploy: the migration re-runs the release-A backfill.
  - A scheduled repair would resurrect an identity that a later wave's unlink writer removed while the legacy columns were still set.
  - Mismatches need a human, so the job alerts and the CLI (`scripts/portal-identity-reconcile.ts`, W2) prints the samples.
  - If Todd keeps the spec's wording instead, the job's repair is restricted to `missingIdentity` rows whose login has `auth_method='entra'` and `linked_via` history `jit`/`migrated`. Every unlink writer in W4+ must then clear `entra_*` in the same transaction (the D4 writer fence).

The advisor quorum (`codex exec`, xhigh, read-only) reviews D1–D10 before the W03a PR opens. Todd does not do that review.

## Open decisions (Todd)

- **OD1: where the partner tab lives.** Plan default: a new `customerPortal` tab in the partner settings **Branding** group, after Trust Center. That group already holds the customer-facing Login branding and Trust Center tabs. Alternative: the Security group.
- **OD2: which rows the card shows in W3.**
  - Plan default: rows appear only when the deployment can run them (`capabilities`). In W3 that is the Password row (with *Off — Microsoft/Google only* disabled and a hint) and *Invites from the MSP — always on*.
  - The Microsoft, Google, self-registration and first-SSO-sign-in rows appear in the wave that makes them work.
  - Alternative: render every row disabled now.
  - The API stores every column from day one either way, so no later migration is needed.
- **OD3: emails sent on a decision.**
  - Plan default: a denial sends a neutral email (spec §5.10).
  - Approving an SSO-origin or add-in request sends a short "you can now sign in" email with the portal link.
  - Approving a self-registration request sends the normal invite.
  - Alternative: send nothing on SSO approval.
- **OD4: deleting the W2 legacy-invite branch (W2 D3).** It is safe only 7 days after #11408 is in production in every region. Task 6 Step 6 does it only when the dispatcher confirms that date; otherwise the deletion moves to the W4 plan.
- **OD5: should the drift job repair, or only report (D10)?** Plan default: report only, with repair once at deploy through the migration. This deviates from spec §5.2. Alternative: the spec's "reports and repairs", narrowed as described in D10.

## Settings rule 9 statement (copy into both PR bodies)

- **Home:**
  - org settings › Portal › **Sign-in & registration** (org override);
  - partner settings › **Customer portal** (partner default).
- **Level:** partner default → org override. Blank means inherit, and the field shows the inherited value and where it comes from.
- **Resolver:** `resolvePortalAccessPolicy(orgId)` (`apps/api/src/services/portalAccessPolicy.ts`).
- **Places configured:** before 0, after 2 (one per level).
- `portal_branding.enable_password_reset` (org Portal settings) is a neighbour, not the same concept, and stays where it is. It switches self-service reset for password users, while `password_mode` decides whether password sign-in exists at all. Under `sso_only`, reset is refused whatever that flag says.
- **Nav:** no new settings page, so `settingsPageRegistry.test.ts` must pass unchanged. The partner tab is registered in `partnerSettings/tabRegistry.ts`, and `tabRegistry.test.ts` pins it.

## Global Constraints

- **Policy fields and defaults** (spec §4, §5.3):

| Field | Allowed values | Default |
|---|---|---|
| `entra_enabled` | boolean | false |
| `google_enabled` | boolean | false |
| `password_mode` | `allowed` \| `sso_only` | `allowed` |
| `self_registration_mode` | `off` \| `approval` \| `instant` | `off` |
| `sso_new_person_mode` | `invited_only` \| `approval` \| `instant` | `approval` |
| `sso_session_max_hours` | integer 1–168 | 12 |

  - Every column is nullable on both owner kinds. On an org row, NULL means inherit the partner. On a partner row, NULL means the built-in default.
- **The `sso_only` rule (spec §4):** effective `password_mode` is `sso_only` only while effective `entra_enabled || google_enabled` is true. Otherwise it is `allowed`, and `passwordModeFallback: true` is reported.
- **Capability masking:** effective `entra_enabled`, `google_enabled` and `self_registration_mode` are masked to `false` / `false` / `off` when `getPortalSignInCapabilities()` says the deployment cannot run them. In W3 all three capabilities are `false`; W4, W6 and W7 flip them.
- **Request shape** (spec §5.1):
  - `source ∈ {self, entra, google, addin_user}`;
  - `status ∈ {pending, approved, denied, expired}`.
- **Audit actions** (spec §5.10):
  - `organization.portal_user.access_request.approve` and `.deny`;
  - `organization.portal_access_policy.update` and `partner.portal_access_policy.update` (new).
- **Neither product grants the other** (inv. 9). Add-in gates are untouched, and `middleware/clientAiAuth.ts` still never reads `browser_access` or the policy.
- **Uniform failures** (inv. 8):
  - A password path refused by policy returns exactly today's failure: login 401 `{ error: 'Invalid email or password' }`, reset 400 `'Invalid or expired reset token'`, accept-invite 400 `'Invalid or expired invite'`, and forgot-password's unchanged uniform 200.
  - Rate-limit calls are unchanged.
- **Migration:** `apps/api/migrations/2027-01-22-2310xx-portal-access-policies-requests.sql`.
  - **The `xx` is assigned at dispatch.** Use the next free slot after the newest file on `origin/main`; today that is `2027-01-22-230300-software-upload-sessions-partner-owner.sql`.
  - Re-run the `localeCompare` check from `apps/api/migrations/README.md` right before every push, and rename the file (and the test's path constant) if it is overtaken. Never rename a shipped migration.
  - The file is idempotent, with no inner `BEGIN;/COMMIT;`, and its first statement is `SELECT set_config('breeze.scope', 'system', true);`. Every row write reports a count with `RAISE NOTICE/WARNING`.
- **New error codes** (UPPER_SNAKE, exported from the owning service):
  - `PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE`, `PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO`;
  - `PORTAL_ACCESS_REQUEST_NOT_FOUND`, `PORTAL_ACCESS_REQUEST_NOT_PENDING`, `PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS`, `PORTAL_ACCESS_REQUEST_IDENTITY_LINKED`.
- **Web:**
  - Mutations go through `runAction`, and new components are added to `TARGET_GLOBS` in `lib/__tests__/no-silent-mutations.test.ts`.
  - New keys go into all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`.
  - Transient UI state goes in `window.location.hash`. Tests select by `data-testid`.
- **CPU budget** (host shared with other sessions):
  - Vitest runs with `--pool=forks --poolOptions.forks.maxForks=4`, on the touched files only. For a sweep, use `vitest run --changed origin/main`.
  - Run one `tsc` at a time, with `NODE_OPTIONS=--max-old-space-size=20480`. Check `echo "exit=$?"`, never `| tail`.
  - No background CI pollers.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A policy change while sessions and tokens are outstanding** (feature RF4). The cases:
   - The org turns on `sso_only`, simulated with a capability override.
   - The same change arrives through the partner default while the org row is blank.

   Expected:
   - The next request on an existing password session gets 401, and the session is purged.
   - An outstanding invite or reset token gets the generic 400 at consume.
   - Forgot-password returns the same 200 and sends nothing.
   - Login gets the byte-identical 401 of a wrong password.

   *(Task 6: `inherited partner sso_only kills a password session on the next request`, `invite consumed under sso_only → generic 400`, `login under sso_only equals a bad password`.)*
2. **The resolver runs in an org-scoped DB context:** a portal session context, or an org-scoped token. It must return the partner default row, not built-in defaults. *(Task 2: `org-scoped context sees the partner default row`. Task 3: `resolves the partner default under portalOrgDbAccessContext`.)*
3. **Approve is double-clicked, or the person got an account meanwhile.** Exactly one account and one approval. The loser gets 409 `PORTAL_ACCESS_REQUEST_NOT_PENDING`. If an account with the email now exists, the result is 409 `PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS` and the request stays pending. *(Task 7: `two concurrent approvals create one account`, `approve refuses when the email now has an account`.)*
4. **An inherited change turns off the last SSO method while the org override says `sso_only`.** The effective value falls back to `allowed`, `passwordModeFallback` is true, password login works again, and the card shows why. *(Task 3 pick test. Task 6: `fallback re-allows password login`. Task 10: `shows the fallback notice`.)*
5. **An org merge with policies and pending requests on both sides.** Expected:
   - The survivor keeps its own policy. When the survivor has no override and the loser does, the loser's override is dropped, not adopted, so the survivor stays on its partner default.
   - The loser's duplicate pending request is dropped and other requests move.
   - The merge never fails with 23505.

   *(Task 2: `merge keeps the survivor policy and dedupes pending requests by email`, `merge drops the loser override when the survivor has none`.)*

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| Create `apps/api/migrations/2027-01-22-2310xx-portal-access-policies-requests.sql` | DDL, RLS, `auth_method` CHECK, identity re-backfill (spec of record, Task 1) | a |
| Create `apps/api/src/db/schema/portalAccess.ts`, modify `schema/index.ts`, `schema/portal.ts` (`authMethod` comment) | Drizzle tables + types | a |
| Modify `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/orgMerge.ts` (`DROP_LOSER_OVERRIDE_SETTINGS_TABLES`), `services/tenantExportPolicyRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts`, `__tests__/integration/orgMergeRegistry.integration.test.ts` | Registration | a |
| Create `services/portalAccessPolicy.ts` (+ `.test.ts`) | Capabilities, defaults, pure pick, resolver, `isSignInMethodAllowed` | a |
| Create `services/portalAccessPolicyWrites.ts` (+ `.test.ts`) | Validation against capabilities, partner/org upserts, view builder | a |
| Create `packages/shared/src/validators/portalAccessPolicy.ts` (+ `.test.ts`), export from validators index | Zod schemas + view/request types shared with web | a |
| Create `routes/orgPortalAccessPolicy.ts` (+ `.test.ts`), modify `routes/orgs.ts` (register) | Org + partner GET/PATCH, audit | a |
| Modify `services/portalUserIdentities.ts`, `services/clientAiExchange.ts`, `routes/clientAi/adminOrgs.ts`, `routes/orgPortalUsers.ts`, `services/contacts/portalInvite.ts`, `services/portalUserDirectory.ts`, `routes/portal/capabilityTokens.ts`, `routes/portal/auth.ts:821-832` | Identities read switch | a |
| Create `jobs/portalIdentityReconcile.ts` (+ `.test.ts`), modify `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, `jobs/scheduleRegistry.ts` | Daily drift report | a |
| Create `routes/portal/browserSession.ts` (+ `.test.ts`), modify `routes/portal/auth.ts`, `routes/portal/capabilityTokens.ts`, `routes/portal/schemas.ts` (`PortalSession.method`) | Enforcement at use | a |
| Create `services/portalAccessRequests.ts` (+ `.test.ts`), modify `services/portalAccountState.ts`, `__tests__/portalAccountWriters.contract.test.ts`, `services/email.ts` (+ templates), `services/emailDomains/mailPurposes.ts` (+ test) | Queue service, new state writers, decision emails | a |
| Create `routes/orgPortalAccessRequests.ts` (+ `.test.ts`), modify `routes/orgs.ts` | Org list/approve/deny/decide, partner summary | a |
| Create integration tests: `portalAccessPolicyMigration`, `portalAccessPoliciesPartnerRls`, `portalAccessRequests`, `portalAccessPolicyEnforcement` (`*.integration.test.ts`); append `portalUserIdentities.integration.test.ts` | Real-DB proofs | a |
| Create `apps/web/src/components/shared/InheritChoice.tsx`, `apps/web/src/components/settings/portalAccess/PortalAccessPolicyForm.tsx` (+ tests); locale keys in 8 locales | Shared form | b |
| Create `settings/portalAccess/OrgSignInRegistrationCard.tsx` (+ test), modify `settings/OrgSettingsPage.tsx:659-669` | Org card | b |
| Create `settings/partnerSettings/PartnerCustomerPortalTab.tsx` (+ test), modify `tabRegistry.ts`, `tabRegistry.test.ts`, `saveUnits.ts`, `partnerSettingsDraftStore.ts`, `PartnerSettingsPage.tsx` | Partner tab | b |
| Create `settings/portalAccess/PortalAccessRequestsList.tsx` (+ test), modify `OrgPortalUsersEditor.tsx`, `contactPortalAccess.ts` (+ test), `ContactsCard.tsx` | Queue UI, list badges, Contacts "Requested" | b |
| Modify `apps/docs/src/content/docs/features/portal.mdx`, regenerate `apps/api/src/data/docsIndex.json` | Docs | b |

---

## W03a — API

Test commands: run from `apps/api` with `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. Never use `pnpm --filter <pkg> test -- --run <path>`, because vitest path filters are substring matches. Integration runs need `pnpm test-stack up` first, then `npx vitest run -c vitest.integration.config.ts <file>`. Tear down with `pnpm test-stack down`.

### Task 1: Migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2027-01-22-2310xx-portal-access-policies-requests.sql`
- Create: `apps/api/src/db/schema/portalAccess.ts`. Add `export * from './portalAccess'` in `schema/index.ts`.
- Modify: `apps/api/src/db/schema/portal.ts:140`. Change the `authMethod` comment to `'password' | 'entra' | 'google' (SQL CHECK portal_users_auth_method_check); only 'password' is password-eligible`.
- Test: `apps/api/src/__tests__/integration/portalAccessPolicyMigration.integration.test.ts`. Templates: `portalAccountFoundationsMigration.integration.test.ts` (W2) for replay inside a rolled-back superuser transaction and notice capture.

**Interfaces — Produces** (`db/schema/portalAccess.ts`):
- `export type PortalPasswordMode = 'allowed' | 'sso_only'`
- `export type PortalSelfRegistrationMode = 'off' | 'approval' | 'instant'`
- `export type PortalSsoNewPersonMode = 'invited_only' | 'approval' | 'instant'`
- `export type PortalAccessRequestSource = 'self' | 'entra' | 'google' | 'addin_user'`
- `export type PortalAccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired'`
- `export const portalAccessPolicies = pgTable('portal_access_policies', { id, orgId, partnerId, entraEnabled, googleEnabled, passwordMode, selfRegistrationMode, ssoNewPersonMode, ssoSessionMaxHours, createdAt, updatedAt })`
  - Partial uniques `portal_access_policies_org_uq` and `_partner_uq`, declared with `.where(sql\`… IS NOT NULL\`)`.
  - Text columns typed with `$type<…>()`.
- `export const portalAccessRequests = pgTable('portal_access_requests', { id, orgId, portalUserId, email, name, source, issuer, subject, entraTenantId, status, requestedAt, lastRequestedAt, expiresAt, decidedAt, decidedByUserId, createdAt, updatedAt })`
  - Indexes `portal_access_requests_pending_email_uq` (partial), `_org_status_idx`, `_portal_user_idx`.
  - The composite FK is SQL-only, with a comment pointing at the migration (same convention as `portal_user_identities_user_org_fk`).

- [ ] **Step 1: Write the failing integration test**

```ts
describe('2027-01-22-2310xx-portal-access-policies-requests.sql', () => {
  it('starts with the system-scope line');
  it('portal_access_policies: refuses a row with both or neither owner (23514 portal_access_policies_one_owner_chk)');
  it('portal_access_policies: refuses a second org row and a second partner row (23505 _org_uq / _partner_uq)');
  it('portal_access_policies: refuses password_mode "off", sso_session_max_hours 0 and 169 (23514)');
  it('portal_access_requests: refuses entra source without issuer/subject/entra_tenant_id and self source with claims (23514 portal_access_requests_claims_chk)');
  it('portal_access_requests: refuses a self row with issuer set and subject NULL, and an entra row with subject only (23514)');
  it('portal_access_requests: refuses status approved with portal_user_id NULL (23514 portal_access_requests_decision_chk)');
  it('portal_access_requests: refuses a non-normalized email "  A@X.test" (23514 portal_access_requests_email_chk)');
  it('portal_access_requests: a second PENDING row for the same (org, email) → 23505; a denied one beside it is fine');
  it('portal_access_requests_user_org_fk is DEFERRABLE INITIALLY IMMEDIATE and refuses a portal user from another org (23503)');
  it('auth_method CHECK accepts google and still refuses "saml"');
  it('re-backfills an entra login that has no identity row (linked_via migrated) and NOTICEs the count');
  it('WARNs (does not fail) for a login whose (issuer, subject) belongs to another user');
  it('is idempotent: a second replay changes nothing');
});
```

- [ ] **Step 2: Run it and verify it fails.** It should fail with ENOENT on the migration path.

- [ ] **Step 3: Write the migration** (spec of record)

```sql
-- Portal registration W3: access policy, access requests, identities release B.
-- Spec: docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md §5.1-§5.3, §5.10.
-- WRITES ROWS (identity re-backfill) → system scope first. autoMigrate wraps the file: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

-- 1. portal_access_policies: partner default XOR org override (#2135). NULL column = inherit
--    (org row) / built-in default (partner row). Read ONLY through resolvePortalAccessPolicy.
--    Template: 2026-12-20-200100-ticket-approval-settings.sql.
CREATE TABLE IF NOT EXISTS public.portal_access_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES public.organizations(id),
  partner_id uuid REFERENCES public.partners(id),
  entra_enabled boolean,
  google_enabled boolean,
  password_mode text CHECK (password_mode IN ('allowed','sso_only')),
  self_registration_mode text CHECK (self_registration_mode IN ('off','approval','instant')),
  sso_new_person_mode text CHECK (sso_new_person_mode IN ('invited_only','approval','instant')),
  sso_session_max_hours integer CHECK (sso_session_max_hours BETWEEN 1 AND 168),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_access_policies_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_policies_partner_uq
  ON public.portal_access_policies (partner_id) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_policies_org_uq
  ON public.portal_access_policies (org_id) WHERE org_id IS NOT NULL;

ALTER TABLE public.portal_access_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_access_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_access_policies_tenant ON public.portal_access_policies;
CREATE POLICY portal_access_policies_tenant ON public.portal_access_policies FOR ALL
  USING (current_setting('breeze.scope', true) = 'system'
         OR public.breeze_has_org_access(org_id)
         OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (current_setting('breeze.scope', true) = 'system'
              OR public.breeze_has_org_access(org_id)
              OR public.breeze_has_partner_access(partner_id));
-- SELECT-only branches, never folded into FOR ALL (that would widen UPDATE/DELETE targeting).
DROP POLICY IF EXISTS portal_access_policies_partner_default_select ON public.portal_access_policies;
CREATE POLICY portal_access_policies_partner_default_select ON public.portal_access_policies FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
-- Portal sessions and org-scoped tokens carry currentPartnerId = NULL (W3 plan D7):
-- any context that can see one of the partner's orgs may read the partner default.
DROP POLICY IF EXISTS portal_access_policies_org_member_select ON public.portal_access_policies;
CREATE POLICY portal_access_policies_org_member_select ON public.portal_access_policies FOR SELECT
  USING (org_id IS NULL AND EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.partner_id = portal_access_policies.partner_id AND public.breeze_has_org_access(o.id)));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_access_policies TO breeze_app;

-- 2. portal_access_requests: shape 1. org_id NOT NULL by design (queue data, not config; plan D9).
CREATE TABLE IF NOT EXISTS public.portal_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  portal_user_id uuid,
  email text NOT NULL,
  name text,
  source text NOT NULL,
  issuer text,
  subject text,
  entra_tenant_id text,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_access_requests_user_org_fk
    FOREIGN KEY (portal_user_id, org_id) REFERENCES public.portal_users (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_access_requests_source_chk CHECK (source IN ('self','entra','google','addin_user')),
  CONSTRAINT portal_access_requests_status_chk CHECK (status IN ('pending','approved','denied','expired')),
  CONSTRAINT portal_access_requests_email_chk CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320),
  CONSTRAINT portal_access_requests_claims_chk CHECK (
        ((source IN ('entra','google')) = (issuer IS NOT NULL))
    AND ((issuer IS NOT NULL) = (subject IS NOT NULL))
    AND ((source = 'entra') = (entra_tenant_id IS NOT NULL))
    AND (source <> 'entra'  OR issuer = 'https://login.microsoftonline.com/' || entra_tenant_id || '/v2.0')
    AND (source <> 'google' OR issuer = 'https://accounts.google.com')
    AND (source <> 'addin_user' OR portal_user_id IS NOT NULL)),
  -- decided_by_user_id is NOT required: ON DELETE SET NULL may null it later.
  CONSTRAINT portal_access_requests_decision_chk CHECK (
        (status IN ('pending','expired') OR decided_at IS NOT NULL)
    AND (status <> 'approved' OR portal_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_access_requests_pending_email_uq
  ON public.portal_access_requests (org_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS portal_access_requests_org_status_idx
  ON public.portal_access_requests (org_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS portal_access_requests_portal_user_idx
  ON public.portal_access_requests (portal_user_id) WHERE portal_user_id IS NOT NULL;

ALTER TABLE public.portal_access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_access_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_select ON public.portal_access_requests
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_insert ON public.portal_access_requests
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_update ON public.portal_access_requests
  FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.portal_access_requests;
CREATE POLICY breeze_org_isolation_delete ON public.portal_access_requests
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.portal_access_requests TO breeze_app;

-- 3. auth_method gains 'google': an approved Google request creates an identity-only
--    account (plan D2). 'password' remains the only password-eligible value.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_auth_method_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%google%') THEN
    ALTER TABLE public.portal_users DROP CONSTRAINT portal_users_auth_method_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.portal_users'::regclass AND conname = 'portal_users_auth_method_check') THEN
    ALTER TABLE public.portal_users
      ADD CONSTRAINT portal_users_auth_method_check CHECK (auth_method IN ('password','entra','google'));
  END IF;
END $$;

-- 4. Identities release B: repair at deploy, before reads switch (plan D10). Same INSERT as
--    release A (2027-01-22-230200 §5); ON CONFLICT with no target covers both unique keys.
DO $$
DECLARE n integer; left_over integer;
BEGIN
  INSERT INTO public.portal_user_identities
    (org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via, last_used_at, created_at)
  SELECT pu.org_id, pu.id, 'entra',
         'https://login.microsoftonline.com/' || pu.entra_tenant_id || '/v2.0',
         pu.entra_oid, pu.entra_tenant_id, 'migrated', pu.last_login_at, pu.created_at
    FROM public.portal_users pu
   WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'portal_user_identities: release-B backfill inserted % identit(ies)', n;

  SELECT count(*) INTO left_over FROM public.portal_users pu
   WHERE pu.entra_oid IS NOT NULL AND pu.entra_tenant_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.portal_user_identities i
                      WHERE i.portal_user_id = pu.id AND i.provider = 'entra'
                        AND i.subject = pu.entra_oid AND i.entra_tenant_id = pu.entra_tenant_id);
  IF left_over > 0 THEN
    RAISE WARNING 'portal_users: % entra login(s) have no matching identity after backfill - run scripts/portal-identity-reconcile.ts', left_over;
  END IF;
END $$;
```

- [ ] **Step 4: Write the Drizzle file** per the Interfaces block.
- [ ] **Step 5: Run the test, the migration guards and the drift check**
  - `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalAccessPolicyMigration.integration.test.ts` → PASS
  - `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts` → PASS. `portal_users` has no partner-export triggers, so no pre-locks are needed. The suite proves this.
  - `DATABASE_URL=<test-stack url> pnpm db:check-drift` → exit 0
- [ ] **Step 6: Commit**: `feat(portal): access policy + access request tables, auth_method google, identity re-backfill (W3)`

### Task 2: Registration (cascade, merge, export, RLS coverage) + RLS/merge proofs

**Files:**
- Modify: `services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`). Add `'portal_access_policies'` and `'portal_access_requests'` before `'portal_branding'`. They sort alphabetically, and `portal_access_requests` must come before `portal_users`, which it references (child before parent). Add a comment on `portal_access_policies`: "only org-override rows carry org_id; partner rows are swept by cascadeDeletePartner's partner_id pass", copied from `ticket_approval_settings` (`:1023-1025`).
- Modify: `services/orgMergeRegistry.ts`:
  - `portal_access_policies: { kind: 'keep-survivor' }`, with the comment `// verified: portal_access_policies_org_uq partial UNIQUE (org_id); spec §5.3 survivor wins`.
  - `portal_access_requests: { kind: 'repoint-dedupe', key: ['email'], keyWhere: "{status} = 'pending'" }`, with the comment `// verified: portal_access_requests_pending_email_uq`. Use `{col}` placeholders, per the registry header at `:21-24`.
- Modify: `services/orgMerge.ts:416`. Add `'portal_access_policies'` to `DROP_LOSER_OVERRIDE_SETTINGS_TABLES`.
  - Without this entry, the generic `keep-survivor` path adopts the loser's override when the survivor has none. The survivor would then silently take on the loser's sign-in policy instead of its inherited partner default, which contradicts spec §5.3 "survivor's policy wins".
  - `billing_payment_settings` and `ticket_approval_settings` are in this set for the same reason.
- Modify: `__tests__/integration/orgMergeRegistry.integration.test.ts:692`. Add `'portal_access_policies'` to `DUAL_AXIS_SETTINGS_TABLES`. Without it, "every keep-survivor table has a UNIQUE constraint on exactly (org_id)" fails on the partial index.
- Modify: `services/tenantExportPolicyRegistry.ts`:
  - `"portal_access_policies": tablePolicy("org_id", { included: [every column incl. partner_id, except password_mode], reviewedIncluded: ["password_mode"] … })`.
  - `password_mode` contains `password`, which is in `SUSPICIOUS_NAME_PARTS` (`services/tenantExportPolicy.ts:42-43`). An `included` suspicious name throws, so it goes in `reviewedIncluded`: it holds a mode, not a secret. `portal_branding.enable_password_reset` (`tenantExportPolicyRegistry.ts:775`) is treated the same way.
  - `"portal_access_requests": tablePolicy("org_id", { included: [every column] … })`. None of its columns hits the list.
  - Neither table has json/bytea columns.
- Modify: `__tests__/integration/rls-coverage.integration.test.ts`. Add `'portal_access_policies'` to `DUAL_AXIS_TENANT_TABLES` (`:584`) and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`:1084`), each with a one-line comment. `portal_access_requests` is shape 1 and is auto-discovered, so add no entry.
- Create: `services/tenantExportPolicyRegistry.portalAccess.test.ts`. It moves the classification failure into Test API (W2 pattern).
- Create: `__tests__/integration/portalAccessPoliciesPartnerRls.integration.test.ts`. Template: `ticketApprovalSettingsPartnerRls.integration.test.ts`.
- Create: `__tests__/integration/portalAccessRequests.integration.test.ts`, covering RLS, FK and merge here. Task 7 appends the service semantics.

**Interfaces:** Consumes the Task 1 tables. Produces nothing new.

- [ ] **Step 1: Write the failing tests**

```ts
// tenantExportPolicyRegistry.portalAccess.test.ts
it('classifies every portal_access_policies and portal_access_requests column as include (password_mode via reviewedIncluded)');

// portalAccessPoliciesPartnerRls.integration.test.ts
it('partner A context cannot insert a partner row for partner B (42501)');
it('org A context cannot insert or update an org row for org B (42501)');
it('org-scoped context sees the partner default row');                                  // Review Focus 2
it('portalOrgDbAccessContext(orgA) sees partner P default but not partner Q default');   // Review Focus 2
it('portalOrgDbAccessContext cannot UPDATE or DELETE the partner default row (0 rows)');
it('org-scoped context cannot see another org\'s override row');

// portalAccessRequests.integration.test.ts (RLS/merge part)
it('org A context cannot see or insert org B requests (0 rows / 42501)');
it('deleting the portal user deletes requests that reference it');
it('merge keeps the survivor policy and dedupes pending requests by email');            // Review Focus 5
it('merge drops the loser override when the survivor has none: the survivor stays on the partner default'); // Review Focus 5
it('merge moves the loser\'s non-colliding and decided requests to the survivor');
```

- [ ] **Step 2: Run them and verify they fail.** `orgMergeRegistry` throws `no merge policy registered`, and the export test fails on the missing entry.
- [ ] **Step 3: Make the four registry edits.**
- [ ] **Step 4: Run the unit test plus every contract suite**

```bash
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/services/tenantExportPolicyRegistry.portalAccess.test.ts src/__tests__/partner-wide-write-coverage.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/portalAccessPoliciesPartnerRls.integration.test.ts \
  src/__tests__/integration/portalAccessRequests.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenantCascadeFkChildren.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter @breeze/api test:integration-suite-coverage
```
Expected: all PASS. Check the reported file counts.

- [ ] **Step 5: Commit**: `feat(portal): register access policy and request tables in cascade, merge, export and RLS coverage (W3)`

### Task 3: Policy resolver, capabilities, writes, shared validators

**Files:**
- Create: `services/portalAccessPolicy.ts`, `services/portalAccessPolicy.test.ts`
- Create: `services/portalAccessPolicyWrites.ts`, `services/portalAccessPolicyWrites.test.ts`
- Create: `packages/shared/src/validators/portalAccessPolicy.ts`, plus `.test.ts`. Export it from `packages/shared/src/validators/index.ts`.
- Test (real DB): append a `resolver` describe to `portalAccessPoliciesPartnerRls.integration.test.ts`.

**Interfaces — Produces:**

```ts
// packages/shared/src/validators/portalAccessPolicy.ts
export const PORTAL_ACCESS_POLICY_FIELDS = ['entraEnabled','googleEnabled','passwordMode','selfRegistrationMode','ssoNewPersonMode','ssoSessionMaxHours'] as const;
export type PortalAccessPolicyField = typeof PORTAL_ACCESS_POLICY_FIELDS[number];
export interface PortalAccessPolicyValues { entraEnabled: boolean; googleEnabled: boolean; passwordMode: 'allowed'|'sso_only';
  selfRegistrationMode: 'off'|'approval'|'instant'; ssoNewPersonMode: 'invited_only'|'approval'|'instant'; ssoSessionMaxHours: number }
export type PortalAccessPolicyRowValues = { [K in PortalAccessPolicyField]: PortalAccessPolicyValues[K] | null };
export const portalAccessPolicyPatchSchema: z.ZodType<Partial<PortalAccessPolicyRowValues>>; // .strict(); each field optional + nullable; null = inherit / clear
export interface PortalSignInCapabilities { entra: boolean; google: boolean; selfRegistration: boolean }
export type PortalPolicySource = 'org' | 'partner' | 'default';
export interface PortalAccessPolicyView {
  owner: { kind: 'org' | 'partner'; id: string };
  values: PortalAccessPolicyRowValues;                       // this owner's own row (all null when no row)
  inherited: { [K in PortalAccessPolicyField]: { value: PortalAccessPolicyValues[K]; source: Exclude<PortalPolicySource,'org'> } }; // what a blank field resolves to
  effective: { [K in PortalAccessPolicyField]: { value: PortalAccessPolicyValues[K]; source: PortalPolicySource } };
  passwordModeFallback: boolean;
  capabilities: PortalSignInCapabilities;
  canEdit: boolean;                                         // partner view: canManagePartnerWidePolicies; org view: true
}
export const PORTAL_ACCESS_POLICY_ERROR_CODES = { METHOD_UNAVAILABLE: 'PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE', SSO_ONLY_NEEDS_SSO: 'PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO' } as const;
```

```ts
// services/portalAccessPolicy.ts
export const PORTAL_ACCESS_POLICY_DEFAULTS: PortalAccessPolicyValues; // Global Constraints table
export function getPortalSignInCapabilities(): PortalSignInCapabilities; // W3: all false. W4/W6/W7 flip their own key.
export const __testOnly: { setCapabilities(c: PortalSignInCapabilities | null): void }; // throws unless NODE_ENV === 'test'
export interface ResolvedPortalAccessPolicy {
  orgId: string; partnerId: string;
  effective: PortalAccessPolicyView['effective'];
  passwordModeFallback: boolean;
  fingerprint: string; // sha256 hex of canonical JSON of the effective values (W6 binds self-registration tokens to it)
}
export function pickEffectivePortalAccessPolicy(org: PortalAccessPolicyRowValues | null, partner: PortalAccessPolicyRowValues | null,
  caps: PortalSignInCapabilities): Pick<ResolvedPortalAccessPolicy, 'effective' | 'passwordModeFallback' | 'fingerprint'>;
export class PortalAccessPolicyOrgNotFoundError extends Error {}
export async function resolvePortalAccessPolicy(orgId: string): Promise<ResolvedPortalAccessPolicy>;
export type PortalSignInMethod = 'password' | 'entra' | 'google';
export function isSignInMethodAllowed(policy: Pick<ResolvedPortalAccessPolicy, 'effective'>, method: PortalSignInMethod): boolean;
```

Rules:
- `pick` uses `!= null` (an org `false` beats a partner `true`), the same as `services/ticketApproval/settings.ts:47-52`.
- Masking happens after the pick: `entraEnabled = picked && caps.entra`, `googleEnabled = picked && caps.google`, `selfRegistrationMode = caps.selfRegistration ? picked : 'off'`. The source stays the picked source.
- The fallback rule comes last: `passwordMode = picked === 'sso_only' && (entra || google) ? 'sso_only' : 'allowed'`, and `passwordModeFallback = picked === 'sso_only' && !(entra || google)`.
- `resolvePortalAccessPolicy` reads `organizations.partner_id` for the org with no `deleted_at` filter, then both policy rows in **one** query (`org_id = $org OR (org_id IS NULL AND partner_id = $partner)`).
  - With **no** DB context held (`hasDbAccessContext()` false, as in public portal routes and the session middleware's post-hydration checks), it runs inside `withSystemDbAccessContext`.
  - Otherwise it reads under the held context, which RLS lets see both rows (D7).
  - It never calls `runOutsideDbContext`. An org row that is not found throws `PortalAccessPolicyOrgNotFoundError`.
- `isSignInMethodAllowed`: password → `passwordMode.value === 'allowed'`; entra → `entraEnabled.value`; google → `googleEnabled.value`.

```ts
// services/portalAccessPolicyWrites.ts
export class PortalAccessPolicyValidationError extends Error { constructor(readonly code: typeof PORTAL_ACCESS_POLICY_ERROR_CODES[keyof typeof PORTAL_ACCESS_POLICY_ERROR_CODES], readonly field: PortalAccessPolicyField, message: string); }
export async function getOrgPortalAccessPolicyView(org: { id: string; partnerId: string }): Promise<PortalAccessPolicyView>;
export async function getPartnerPortalAccessPolicyView(auth: AuthContext, partnerId: string): Promise<PortalAccessPolicyView>;
export async function updateOrgPortalAccessPolicy(org: { id: string; partnerId: string }, patch: Partial<PortalAccessPolicyRowValues>): Promise<{ view: PortalAccessPolicyView; changedFields: PortalAccessPolicyField[] }>;
export async function updatePartnerPortalAccessPolicy(auth: AuthContext, partnerId: string, patch: Partial<PortalAccessPolicyRowValues>): Promise<{ view: PortalAccessPolicyView; changedFields: PortalAccessPolicyField[] }>;
```

Write validation runs **before** the upsert:
- **Method availability.** A patch that sets `entraEnabled: true` without `caps.entra`, `googleEnabled: true` without `caps.google`, a non-null `selfRegistrationMode` other than `'off'` without `caps.selfRegistration`, or a non-null `ssoNewPersonMode` / `ssoSessionMaxHours` without `caps.entra || caps.google` is refused with `METHOD_UNAVAILABLE`.
- **`sso_only`.** `passwordMode: 'sso_only'` is refused with `SSO_ONLY_NEEDS_SSO` unless the would-be effective policy for this owner has an SSO method on. Compute that by picking the merged row against the partner row (org writes) or the defaults (partner writes).
- **Partner writes.** `updatePartnerPortalAccessPolicy` first checks `canManagePartnerWidePolicies(auth)`. When it fails, it throws `PartnerWideWriteDeniedError`, exported from the same file, and the route maps that to 403. The check sits in the service because `partner-wide-write-coverage.test.ts` scans `src/services/**` as well as routes, and fails a file that mutates a partner-axis table without mentioning the helper.
- **Upsert.** `onConflictDoUpdate({ target: orgId | partnerId, targetWhere: isNotNull(...) })` sets `updatedAt: now()`. That is the `ticketApproval/settings.ts` writer pattern.
- **Changed fields.** `changedFields` lists the patched keys whose stored value actually changed.

- [ ] **Step 1: Write the failing tests**

```ts
// portalAccessPolicy.test.ts (pure)
it('defaults when neither row exists: password allowed, sso approval, 12 h, everything else off');
it('org false beats partner true; org null inherits partner; partner null falls to default (source per field)');
it('masks entra/google/self-registration when the capability is off, keeping the picked source');
it('sso_only with no effective SSO method falls back to allowed and reports passwordModeFallback'); // Review Focus 4
it('sso_only with entra on and caps.entra stays sso_only');
it('fingerprint changes when an effective value changes and not when only a masked raw value changes');
it('isSignInMethodAllowed maps password/entra/google to the effective fields');
it('__testOnly.setCapabilities throws outside NODE_ENV=test');
// portalAccessPolicyWrites.test.ts
it('refuses entraEnabled true while caps.entra is false (METHOD_UNAVAILABLE, field entraEnabled)');
it('refuses ssoNewPersonMode while no SSO capability exists');
it('refuses passwordMode sso_only when the would-be effective policy has no SSO method (SSO_ONLY_NEEDS_SSO)');
it('accepts passwordMode sso_only for an org that inherits entra on from the partner (caps on)');
it('null clears an org override; changedFields lists only real changes');
it('partner write without full partner access throws PartnerWideWriteDeniedError and writes nothing');
// shared validators test
it('portalAccessPolicyPatchSchema rejects unknown keys, password_mode "off", ssoSessionMaxHours 0/169/1.5');
// integration (append to portalAccessPoliciesPartnerRls)
it('resolves the partner default under portalOrgDbAccessContext');   // Review Focus 2
it('resolves with no context held (opens its own system context)');
it('throws PortalAccessPolicyOrgNotFoundError for an unknown org id');
```

- [ ] **Step 2: Run them and verify they fail** (module not found).
- [ ] **Step 3: Implement** per the Interfaces block and rules.
- [ ] **Step 4: Run them, plus the parkedFanout contract** (the new service files must stay undiscovered)
  - `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/services/portalAccessPolicy.test.ts src/services/portalAccessPolicyWrites.test.ts src/__tests__/parkedFanout.contract.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
  - `cd packages/shared && npx vitest run src/validators/portalAccessPolicy.test.ts`
  - the integration file
- [ ] **Step 5: Commit**: `feat(portal): portal access policy resolver, capabilities and validated writes (W3)`

### Task 4: Policy routes (org + partner) and audit

**Files:**
- Create: `routes/orgPortalAccessPolicy.ts` and `routes/orgPortalAccessPolicy.test.ts`. Modify `routes/orgs.ts` to call `registerPortalAccessPolicyRoutes(orgRoutes)` next to `registerOrgPortalSettingsRoutes` (`:3052`).

**Interfaces:**
- Consumes: Task 3. It also uses `resolveAccessibleOrg` (`routes/orgPortalSettings.ts:32`), `writeRouteAudit` (`services/auditEvents.ts:236`) and `resolveAuditOrgIdForPartner` (as `routes/tickets/approvalSettings.ts:74` does).
- Produces (all mounted under `/orgs`):

| Method + path | Middleware | Response |
|---|---|---|
| `GET /organizations/:id/portal-access-policy` | `requireScope('partner','system')`, `requireOrgRead` | `{ data: PortalAccessPolicyView }` |
| `PATCH /organizations/:id/portal-access-policy` | `requireScope('partner','system')`, `requireOrgWrite`, `requireMfa()`, `zValidator('json', portalAccessPolicyPatchSchema)` | `{ data: PortalAccessPolicyView }`; empty body → 400 `NO_UPDATES_PROVIDED`; `PortalAccessPolicyValidationError` → 400 `{ error, code, field }` |
| `GET /partners/me/portal-access-policy` | `requireScope('partner')`, `requirePartner`, `requireOrgRead` | `{ data: PortalAccessPolicyView }` (`canEdit` false without full partner access) |
| `PATCH /partners/me/portal-access-policy` | `requireScope('partner')`, `requirePartner`, `requireOrgWrite`, `requireMfa()`, validator | same; 403 `{ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: ACCESS_DENIED }` |

- Audit happens on success only. The org route writes `organization.portal_access_policy.update` (`resourceType: 'organization'`). The partner route writes `partner.portal_access_policy.update` (`resourceType: 'partner'`, `orgId: await resolveAuditOrgIdForPartner(partnerId)`). Both carry `details: { changedFields, before, after }`, with only the changed fields in each.

- [ ] **Step 1: Write the failing tests**

```ts
it('GET org returns values (all null), inherited from partner/default, effective and capabilities');
it('PATCH org with {} → 400 NO_UPDATES_PROVIDED');
it('PATCH org entraEnabled true → 400 PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE with field');
it('PATCH org for an org the partner user cannot access → 404 (no audit)');
it('PATCH org audits changedFields with before/after of changed fields only');
it('PATCH partner as a selected-orgs partner user → 403 ACCESS_DENIED; GET shows canEdit false');
it('PATCH partner as full partner admin upserts the partner row and audits partner.portal_access_policy.update');
it('org-scope token → 403 on every route (requireScope)');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/routes/orgPortalAccessPolicy.test.ts` → PASS
- [ ] **Step 5: Commit**: `feat(portal): org and partner portal access policy routes (W3)`

### Task 5: Identities read switch (release B) + daily drift report

**Files (each line below is one reader to switch):**
- `services/portalUserIdentities.ts`: add the helpers below and update the header comment (release B: reads live here; writers still dual-write `entra_*`, D4).
- `services/clientAiExchange.ts:329-333` and `:409-413`: look the account up by identity, then remove the `authMethod !== 'entra'` check at `:433` (D5). The JIT insert (`:362-384`) is unchanged, and its dual-write stays. `ensureEntraIdentity` on the existing-user path stays for `last_used_at`.
- `routes/clientAi/adminOrgs.ts:105-109` (Entra user count per org) and `:210-221` (policy user picker): join `portal_user_identities` with `provider='entra'`. Do not filter on `authMethod='entra'`.
- `routes/orgPortalUsers.ts:78,92,94-103,388,528-533`: `hasExternalIdentity` comes from `portalUserHasIdentitySql()`, not `entraOid`. In the bulk `baseWhere`, `isNull(portalUsers.entraOid)` becomes `sql\`not ${portalUserHasIdentitySql()}\``.
- `services/contacts/portalInvite.ts:72,80,269-302`: the same switch.
- `routes/portal/capabilityTokens.ts:77-88,225-240`: `CapabilityUserRow.entraOid` is replaced by `hasExternalIdentity: boolean`.
- `routes/portal/auth.ts:821-832`: build the accept-invite facts from it.
- `services/portalUserDirectory.ts:25-71`:
  - List items gain `browserAccess: PortalBrowserAccess` and `identityProviders: PortalIdentityProvider[]`.
  - `effectivePortalStatus` returns `'pending_setup'` only for a password-eligible account with no password hash and no identity.
  - The `aiToolsOrgAdminReads.ts:166` consumer only gains additive fields.
- Create `jobs/portalIdentityReconcile.ts` and `jobs/portalIdentityReconcile.test.ts`. Template: `jobs/agreementRequestExpiryReaper.ts`, but with `repeat: { pattern: jobSchedule('portal-identity-reconcile') }`.
- Modify `jobs/scheduleRegistry.ts`: add the slot `'portal-identity-reconcile'` in the daily tier (minute ≡ 3 mod 5, a free hour). `scheduleRegistry.contract.test.ts` checks collisions.
- Modify `services/workerRegistry.ts` (entry like `:1606`) and `jobs/workerReadinessManifest.ts` (`consumers('portalIdentityReconcile')`, `requiredWhen: 'redis'`).
- Tests: `clientAiExchange.test.ts`, `orgPortalUsers.test.ts`, `portalInvite.test.ts`, `portalUserDirectory` tests, `capabilityTokens.test.ts`, and the `adminOrgs` route test. Real DB: append to `portalUserIdentities.integration.test.ts`.

**Interfaces — Produces** (`services/portalUserIdentities.ts`):

```ts
/** EXISTS over portal_user_identities for the outer portal_users row. Spells "portal_users"."id" explicitly:
 *  drizzle strips table qualifiers in single-table selects (#9692), and a bare id would bind to the subquery's own id. */
export const portalUserHasIdentitySql: () => SQL<boolean>;
export async function findPortalUserIdByEntraIdentity(exec: IdentityExecutor, input: { tid: string; oid: string }): Promise<{ portalUserId: string; orgId: string } | null>;
export async function listIdentityProvidersByUser(exec: IdentityExecutor, portalUserIds: string[]): Promise<Map<string, PortalIdentityProvider[]>>;
```
- The job module produces `runPortalIdentityReconcile(): Promise<PortalIdentityDriftReport>`, plus `initializePortalIdentityReconcileJob` and `shutdownPortalIdentityReconcileJob`.
- `runPortalIdentityReconcile` calls `reconcilePortalUserIdentities()` **with no DB context held**. Do not wrap it in `withSystemDbAccessContext` the way the `agreementRequestExpiryReaper` template does (`:43`): the W2 function opens its own context and throws when one is already held.
- The run is report-only (D10). It logs the counts as one JSON line. When the report is not clean, it calls `captureException(new Error('portal identity drift'), undefined, { eventCode: 'portal_identity_drift' }, { fingerprint: ['portal_identity_drift'] })`. That matches the signature at `services/sentry.ts:882-890`. The counts go in the JSON log line, not in Sentry.
- The drift definitions are W2's, unchanged. They cover Entra only, because Google identities have no legacy columns.

- [ ] **Step 1: Write the failing tests**

```ts
// clientAiExchange.test.ts
it('resolves the login through portal_user_identities (issuer/subject), not portal_users entra columns');
it('mints for an account found by its entra identity regardless of auth_method');           // D5
it('identity in org B for a tenant mapped to org A → org_mismatch denial');                  // inv. 4
// orgPortalUsers / portalInvite / capabilityTokens
it('an account with an identity row is identity-managed even when entra_oid is NULL');       // proves the switch
it('an identity on ANOTHER user does not make this user identity-managed');                  // #9692 trap
it('bulk invite skips accounts with any identity row');
// portalUserDirectory
it('identity-only active account reads active, not pending_setup; list items carry browserAccess and identityProviders');
// adminOrgs
it('entra user count and picker come from identities (a password user with an entra identity is counted)');
// job
it('reports and never writes; calls captureException with tag eventCode portal_identity_drift when not clean');
// integration
it('the real job handler runs against Postgres without throwing "context already held"');
// integration (portalUserIdentities.integration.test.ts)
it('add-in exchange for a login whose identity row is missing fails closed (403 provisioning_failed) and never inserts a second portal_users row');
it('JIT still writes both entra_* columns and the identity (writer fence) and the drift report stays clean');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement** the readers, then the job wiring. The job wiring is Sonnet-eligible.
- [ ] **Step 4: Run** the touched unit files, the job contracts (`src/jobs/scheduleRegistry.contract.test.ts src/jobs/workerReadinessCoverage.test.ts src/jobs/workerReadinessManifest.test.ts`), `src/__tests__/portalAccountWriters.contract.test.ts`, `src/__tests__/dbTransactionPromiseAll.contract.test.ts`, and the integration files `portalUserIdentities`, `loginContactLinking` and `portalUserInvite`. All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): switch external-identity reads to portal_user_identities and add a daily drift report (W3 release B)`

### Task 6: Enforcement at use — sessions, login, forgot, reset, accept-invite

**Files:**
- Create: `routes/portal/browserSession.ts`, `routes/portal/browserSession.test.ts`
- Modify: `routes/portal/schemas.ts:10-17`. `PortalSession` gains `method: PortalSessionMethod`. `helpers.ts:40` only holds the map.
- Modify: `routes/portal/auth.ts`, at these sites:
  - middleware `:170-205` (parse) and `:262` (gate), plus a policy gate after the org gate at `:349-373`;
  - login `:499-517` and the payloads at `:530-535` and `:557`;
  - forgot `:654`;
  - accept-invite mint `:860-874`.
- Modify: `routes/portal/capabilityTokens.ts` (`validatePortalCapability`)
- Test: `routes/portal/auth.test.ts`, `acceptInvite.test.ts`, `authOrgStatusGate.test.ts`, `capabilityTokens.test.ts`. Real DB: create `__tests__/integration/portalAccessPolicyEnforcement.integration.test.ts`. Its harness comes from `portalUserInvite.integration.test.ts`, with capabilities set through `__testOnly.setCapabilities({ entra: true, google: false, selfRegistration: false })` and policy rows seeded as superuser.

**Interfaces:**
- Consumes: `resolvePortalAccessPolicy`, `isSignInMethodAllowed`, `__testOnly.setCapabilities` (Task 3), and `isPasswordEligible` (W2).
- Produces (`routes/portal/browserSession.ts`):

```ts
export type PortalSessionMethod = PortalSignInMethod; // 'password' | 'entra' | 'google' (D6)
export interface StoredPortalSession { portalUserId: string; orgId: string; authEpoch: number; method: PortalSessionMethod }
/** Redis/in-memory payload → session. Missing method → 'password' (pre-W3 sessions). Unknown method or bad shape → null. */
export function parseStoredPortalSession(raw: unknown): StoredPortalSession | null;
/** The per-request browser gate (inv. 9). A password session also needs a password-eligible account. */
export function isBrowserSessionAllowed(session: Pick<StoredPortalSession, 'method'>, user: { authMethod: string; browserAccess: string },
  policy: Pick<ResolvedPortalAccessPolicy, 'effective'>): boolean;
```

Behaviour at each site:
- **Middleware: parse.** Use `parseStoredPortalSession` for both the Redis and the in-memory paths.
- **Middleware: account gate at `:262`.** It becomes `!user || user.browserAccess !== 'granted' || (session.method === 'password' && !isPasswordEligible(user))`. The cleanup and the 401 `'Portal user not found'` are unchanged. With only password sessions minted, this is today's behaviour by construction.
- **Middleware: policy gate.** It runs after the org gate. Paths where `isPortalAuthGateExemptPath` is true (logout) are skipped.
  - It calls `resolvePortalAccessPolicy(user.orgId)` with no context held.
  - If `!isBrowserSessionAllowed(...)`, it purges the session (the same `multi().del().srem()` as the epoch branch), clears the cookie and returns 401 `'Invalid or expired session'`.
  - `PortalAccessPolicyOrgNotFoundError` is handled the same way.
- **Login.** After `resolveLoginCandidate` returns a user, and **before** the org-active and status 403s, check `isSignInMethodAllowed(await resolvePortalAccessPolicy(user.orgId), 'password')`. When it is false, return the same 401 `'Invalid email or password'`, with no `clearRateLimitKeys`. Both mint sites write `method: 'password'`.
- **Forgot-password.** Add `browserAccess: portalUsers.browserAccess` to the select at `:614-640`, then compute `resetEligible = isPasswordEligible(user) && user.browserAccess === 'granted' && await isPortalPasswordResetEnabled(orgId) && isSignInMethodAllowed(await resolvePortalAccessPolicy(orgId), 'password')`. The response is unchanged.
- **`validatePortalCapability`.** After the row checks and **before** `getActiveOrgTenant`, if `!isSignInMethodAllowed(await resolvePortalAccessPolicy(user.orgId), 'password')` → `invalid`. This covers both reset and accept-invite (inv. 7). Only a token that is valid in every other respect learns that its org is unavailable.

- [ ] **Step 1: Write the failing tests**

```ts
// browserSession.test.ts
it('parses a pre-W3 payload without method as password');
it('rejects an unknown method and a non-integer authEpoch');
it('password session needs password-eligible + browser granted + passwordMode allowed');
// auth.test.ts / acceptInvite.test.ts / capabilityTokens.test.ts (resolver mocked)
it('login under sso_only equals a bad password (status, body, rate-limit buckets, no clear)');   // Review Focus 1, inv. 8
it('forgot-password under sso_only returns the uniform 200 and issues no token');
it('reset token consumed under sso_only → 400 Invalid or expired reset token, hash unchanged');
it('invite consumed under sso_only → generic 400, account stays invited');                       // Review Focus 1
it('logout still works for a session refused by policy');
// integration (portalAccessPolicyEnforcement, real DB + router, capabilities overridden)
it('org sso_only (entra on) kills a live password session on the next request and purges it');   // Review Focus 1, inv. 9/11
it('inherited partner sso_only kills a password session on the next request');                    // Review Focus 1
it('fallback re-allows password login when the partner turns entra off under an org sso_only');  // Review Focus 4
it('no policy rows: login, session, reset and accept-invite behave exactly as before W3');
it('every password-path endpoint refuses for an sso_only org (login, forgot, reset, accept-invite)'); // inv. 11
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/routes/portal/browserSession.test.ts src/routes/portal/auth.test.ts src/routes/portal/auth.logout.test.ts src/routes/portal/acceptInvite.test.ts src/routes/portal/authOrgStatusGate.test.ts src/routes/portal/capabilityTokens.test.ts`. Then run the integration files `portalAccessPolicyEnforcement`, `portalUserInvite`, `portalAuthEpoch`, `portalLoginUniformFailure`, `portalLogoutRevocation` and `portal-routes-rls`. All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): enforce the access policy on sessions, login, reset and invite tokens (W3)`
- [ ] **Step 6 (gated, OD4): delete the W2 legacy-invite branch.** Do this **only** if the dispatch brief confirms that #11408 has been in production in every region for at least 7 days. If so:
  - `parseCapability` returns `null` for a legacy `{portalUserId}` invite.
  - Delete the legacy branch in `validatePortalCapability` and the `TODO(W3)` at `capabilityTokens.ts:27`.
  - Flip `accepts a legacy invite token once for an invited row` (`capabilityTokens.test.ts:139`) to `rejects a legacy invite token with the generic invalid`.
  - Commit `chore(portal): drop the pre-W2 legacy invite token branch (W2 D3)`.

  Otherwise, skip this step and add the deletion to the W4 plan's carry-over list.

### Task 7: Access-request service, state-module writers, decision emails

**Files:**
- Create: `services/portalAccessRequests.ts`, `services/portalAccessRequests.test.ts`
- Modify: `services/portalAccountState.ts` and `.test.ts`. This includes the `:34` doc comment on `hasExternalIdentity`, which becomes `W3: EXISTS portal_user_identities (portalUserHasIdentitySql)`.
- Modify: `__tests__/portalAccountWriters.contract.test.ts`, adding `'apps/api/src/services/portalAccessRequests.ts': { kind: 'state-module' }`
- Modify: `services/email.ts`, adding `sendPortalAccessApproved` and `sendPortalAccessDeclined`. Model the templates on `sendPortalInvite` (`:618-629`) and render with `emailLayout.ts`.
  - Both methods take `partnerId` and `partnerName` and pass them to `sendEmail`, because partner-lane purposes require them (`email.ts:103-104`).
- Modify: `services/emailDomains/mailPurposes.ts:99`. Register `'portal.access_request.approved'` and `'portal.access_request.declined'` with the same `{ lane: 'partner', stream: 'support', fallbackFrom: 'partner_display_name' }` as `portal.invite`.
- Modify: `mailPurposes.test.ts` (`:69`, `:96`), which pins the sorted partner-branded purpose list.
- Test (real DB): append to `portalAccessRequests.integration.test.ts`.

**Interfaces — Produces:**

```ts
// services/portalAccountState.ts (additions)
export type PortalAccountWriter = /* W2 writers */ | 'access_request_approve';
export function initialPortalAccountState(writer: 'msp_invite' | 'addin_jit' | 'sso_request_approved' | 'self_request_approved'):
  { status: PortalAccountStatus; browserAccess: PortalBrowserAccess };
//   sso_request_approved  → { active, granted }   (identity-only; caller sets auth_method = provider, D2)
//   self_request_approved → { invited, granted }  (same as msp_invite; caller sends the invite)
// planPortalAccountTransition(facts, 'access_request_approve'):
//   active + none    → { active, granted, bumpEpoch: false }   (granting must not kill add-in sessions)
//   active + granted → unchanged, bumpEpoch false (idempotent)
//   disabled         → PORTAL_ACCOUNT_TRANSITION_REFUSED / 409 'This user is disabled. Reactivate them before approving.'
//   invited          → PORTAL_ACCOUNT_TRANSITION_REFUSED / 409 'This user has a pending invite. Resend the invite instead.'
```

```ts
// services/portalAccessRequests.ts
export const PORTAL_ACCESS_REQUEST_TTL_DAYS = 14;
export const PORTAL_ACCESS_REQUEST_PENDING_CAP = 200;
export type CreatePortalAccessRequestInput =
  | { source: 'self'; orgId: string; email: string; name: string | null }
  | { source: 'entra'; orgId: string; email: string; name: string | null; tid: string; oid: string }
  | { source: 'google'; orgId: string; email: string; name: string | null; sub: string }
  | { source: 'addin_user'; orgId: string; portalUserId: string; email: string; name: string | null };
export type CreatePortalAccessRequestOutcome =
  | { kind: 'created' | 'already_pending'; requestId: string } | { kind: 'capped' };
/** For W4/W6/W7 (no W3 producer). Joins a held context, else opens a system context. */
export async function createPortalAccessRequest(input: CreatePortalAccessRequestInput, now?: Date): Promise<CreatePortalAccessRequestOutcome>;
export interface PortalAccessRequestListItem {
  id: string; email: string; name: string | null; source: PortalAccessRequestSource; status: PortalAccessRequestStatus; // 'expired' when pending past expires_at
  requestedAt: string; lastRequestedAt: string; expiresAt: string; decidedAt: string | null;
  decidedBy: { id: string; name: string | null } | null; portalUserId: string | null; accountExists: boolean;
}
export async function listPortalAccessRequests(orgId: string, opts: { status: 'pending' | 'decided'; limit?: number /* default 100, max 200 */ }): Promise<{ items: PortalAccessRequestListItem[]; hasMore: boolean }>;
export async function summarizePendingPortalAccessRequests(): Promise<{ pendingTotal: number; orgs: Array<{ orgId: string; orgName: string; pending: number }> }>; // under the caller's RLS context
export type PortalAccessRequestErrorCode = 'PORTAL_ACCESS_REQUEST_NOT_FOUND' | 'PORTAL_ACCESS_REQUEST_NOT_PENDING' | 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS' | 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED';
export class PortalAccessRequestError extends Error { constructor(readonly code: PortalAccessRequestErrorCode, readonly httpStatus: 404 | 409, message: string); }
export type ApprovePortalAccessRequestResult = {
  outcome: 'account_created' | 'invite_pending' | 'browser_access_granted';
  portalUserId: string; email: string; name: string | null; authEpoch: number; source: PortalAccessRequestSource;
};
export async function approvePortalAccessRequest(input: { orgId: string; requestId: string; deciderUserId: string; now?: Date }): Promise<ApprovePortalAccessRequestResult>;
export async function denyPortalAccessRequest(input: { orgId: string; requestId: string; deciderUserId: string; now?: Date }): Promise<{ email: string; source: PortalAccessRequestSource }>;
```

Rules:
- **Create.**
  1. Normalize the email to `lower(btrim)`.
  2. `UPDATE … SET status='expired'` for a pending row on this `(org, email)` whose `expires_at <= now`.
  3. Count the org's live pending rows. If the count is ≥ `PENDING_CAP`, return `capped`.
  4. Insert with `onConflictDoUpdate({ target: [orgId, email], targetWhere: sql\`status = 'pending'\`, set: { lastRequestedAt: now, updatedAt: now } })`. `expires_at = now + 14 d`. Entra claims are stored as `issuer = entraIssuer(tid)`, `subject = oid`, `entra_tenant_id = tid`. Google claims are stored as `issuer = 'https://accounts.google.com'`, `subject = sub`.
- **Approve.** The service owns the transaction: `approvePortalAccessRequest` and `denyPortalAccessRequest` each wrap their whole body in one `withDbTransaction`. Callers (the single routes and `/decide`) only catch outside the call and add no wrapper of their own.
  1. Read the request with `SELECT … FOR UPDATE` where `id` and `org_id` match. Not found → `NOT_FOUND`. Not pending, or past `expires_at` → `NOT_PENDING`. Do not write the `expired` status here, because the throw rolls the transaction back; lists already derive `expired` from `expires_at`. A concurrent second approver blocks on the row lock and then sees it is no longer pending (Review Focus 3).
  2. **`addin_user`:**
     - Load the account's facts, with `hasExternalIdentity` from `portalUserHasIdentitySql()`, and run `planPortalAccountTransition(facts, 'access_request_approve')`.
     - Update with an `auth_epoch = <read epoch>` guard. If the guard matches zero rows, the account changed since it was read. Throw `PortalAccountTransitionError(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'access_request_approve', 'epoch_moved', 'This account changed while it was being approved. Try again.')`, which rolls back and leaves the request pending.
     - Outcome: `browser_access_granted`.
  3. **`entra` / `google`:**
     - First call `lockPortalInviteAddresses(tx, orgId, [email])` (`services/contacts/portalInvite.ts:220`). This is the same advisory lock the MSP invite and `linkLoginToContact` take, so a concurrent invite for the address cannot create a second account. `portal_users.email` is not unique (spec F3).
     - Any portal account in the org with this email (`lower(email)`) → `ACCOUNT_EXISTS` (spec §5.6 step 4: never link by email).
     - Otherwise insert the `portal_users` row with `...initialPortalAccountState('sso_request_approved')` and `authMethod: source`. Entra rows also get `entraTenantId` and `entraOid` (the D4 writer fence).
     - Insert the identity with `onConflictDoNothing().returning()` and `linked_via 'jit'`. An empty result → throw `IDENTITY_LINKED`, which rolls the whole transaction back.
     - Run `linkLoginToContact(tx, …)` (`services/contacts/loginLink.ts:106`).
     - Outcome: `account_created`.
  4. **`self`:**
     - The same address lock and `ACCOUNT_EXISTS` check.
     - Insert with `...initialPortalAccountState('self_request_approved')`, `authMethod: 'password'`, `invitedAt: now` and `invitedBy: deciderUserId`, then link the contact.
     - Outcome: `invite_pending`. The route issues the invite.
  5. Finally set `status='approved'`, `decided_at`, `decided_by_user_id` and `portal_user_id`.
- **Deny.** The same lock and pending check, then `status='denied'`, `decided_at` and `decided_by_user_id`.
- **No `Promise.all` inside these transactions.**

- [ ] **Step 1: Write the failing tests**

```ts
// portalAccountState.test.ts (table rows)
it.each([/* the four access_request_approve rows above + both new initial states */])('…');
// portalAccessRequests.test.ts (unit, mocked db): argument shapes + error mapping
// integration (real DB)
it('create normalizes the email, sets expires_at +14 d, and a repeat returns already_pending with a bumped last_requested_at');
it('create expires a stale pending row and creates a fresh one');
it('create returns capped at 200 live pending requests');
it('approve entra creates an active, granted, identity-only account (auth_method entra) with identity + entra_* columns + contact');
it('approve google creates auth_method google with the google issuer');
it('approve self creates an invited password account and returns invite_pending');
it('approve addin_user grants browser access without bumping auth_epoch');
it('approve refuses when the email now has an account (409 ACCOUNT_EXISTS) and the request stays pending'); // Review Focus 3
it('approve refuses when (issuer, subject) is now linked (409 IDENTITY_LINKED) and creates no account');
it('approve self racing an MSP invite for the same address yields exactly one account');                 // address lock
it('approve addin_user whose epoch moved after the read → 409 PORTAL_ACCOUNT_TRANSITION_REFUSED, request stays pending');
it('two concurrent approvals create one account; the second gets NOT_PENDING');                         // Review Focus 3
it('approve of an expired request → NOT_PENDING and the row reads expired');
it('deny marks denied with decider; a second deny → NOT_PENDING');
it('portalAccountWriters census passes with portalAccessRequests.ts classified state-module');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement** the state-module rows, the service and the two email templates. Copy:
  - **Declined.** Subject: "Your portal access request". Body: "Your request for access to the {orgName} portal was not approved. If you think this is a mistake, contact your IT provider."
  - **Approved.** Subject: "You can now sign in to the {orgName} portal". The body has one button linking to the portal login URL, built the way `issueAndSendInvite` (`routes/orgPortalUsers.ts:143-190`) builds its accept URL.
- [ ] **Step 4: Run** `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/services/portalAccountState.test.ts src/services/portalAccessRequests.test.ts src/__tests__/portalAccountWriters.contract.test.ts src/__tests__/dbTransactionPromiseAll.contract.test.ts src/__tests__/parkedFanout.contract.test.ts` and the integration file → PASS
- [ ] **Step 5: Commit**: `feat(portal): access request queue service with approve/deny through the account state machine (W3)`

### Task 8: Access-request routes + W03a gate

**Files:**
- Create: `routes/orgPortalAccessRequests.ts` and `routes/orgPortalAccessRequests.test.ts`. Modify `routes/orgs.ts` to call `registerOrgPortalAccessRequestRoutes(orgRoutes)` next to `registerOrgPortalUsersRoutes` (`:3056`).

**Interfaces:**
- Consumes: Task 7, `issueAndSendInvite` (`routes/orgPortalUsers.ts`, exported in this task if it is not exported yet), `writeRouteAudit`.
- Produces (mounted under `/orgs`):

| Method + path | Middleware | Response |
|---|---|---|
| `GET /organizations/:id/portal-access-requests?status=pending\|decided` | `requireScope('partner','system')`, `requireOrgRead` | `{ data: PortalAccessRequestListItem[], hasMore }` |
| `POST /organizations/:id/portal-access-requests/:requestId/approve` | `requireScope('partner','system')`, `requireOrgWrite`, `requireMfa()` | `{ data: { outcome, portalUserId } }`; `PortalAccessRequestError` → `{ error, code }` with its status; `PortalAccountTransitionError` → `{ error, code }` with its `httpStatus` |
| `POST /organizations/:id/portal-access-requests/:requestId/deny` | same | `{ data: { status: 'denied' } }` |
| `POST /organizations/:id/portal-access-requests/decide` body `{ requestIds: uuid[1..100], decision: 'approve'\|'deny' }` | same, `zValidator` | `{ data: Array<{ requestId, result: 'approved' \| 'denied' \| <error code> }> }` |
| `GET /partners/me/portal-access-requests/summary` | `requireScope('partner')`, `requirePartner`, `requireOrgRead` | `{ data: { pendingTotal, orgs } }` |

- **Approve.** `invite_pending` → `issueAndSendInvite(c, orgId, { id, email, authEpoch }, orgName, inviterName)`. `account_created` and `browser_access_granted` → `sendPortalAccessApproved` (OD3). Each email is sent after the service returns. A failed send is logged and does not undo the approval, the same as invites today.
- **Deny.** `sendPortalAccessDeclined`.
- **Audit.** `organization.portal_user.access_request.approve` / `.deny`, with `resourceType: 'portal_access_request'`, `resourceId: requestId` and `details: { source, outcome, portalUserId }`. Write one audit row per decided request, including in `/decide`.
- **`/decide`.** Process the IDs **sequentially**. Each one calls the service, which opens its own `withDbTransaction` (Task 7), and the route's catch sits outside the call (`docs/agents/tenancy-rls.md`, "A catch around a query needs `withDbTransaction`"). Never use `Promise.all`.
- **Shared request schema.** The Zod body lives in `packages/shared/src/validators/portalAccessPolicy.ts` as `decidePortalAccessRequestsSchema`.

- [ ] **Step 1: Write the failing tests**

```ts
it('GET pending lists live requests only; expired rows read status expired under ?status=decided');
it('approve self sends the invite email; approve entra sends the approved email; deny sends the declined email');
it('approve maps ACCOUNT_EXISTS to 409 with code and writes no audit');
it('approve for a request in another org → 404 PORTAL_ACCESS_REQUEST_NOT_FOUND');
it('decide processes ids in order and reports a per-id error without failing the batch');
it('decide with 101 ids → 400');
it('summary counts pending per accessible org only (selected-orgs partner user)');
it('approve without MFA → requireMfa refusal');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/routes/orgPortalAccessRequests.test.ts`. Then add a real-router case to `portalAccessRequests.integration.test.ts`: `a caught 409 inside the request transaction stays a 409 (not a 500 at commit)`. Both must PASS.
- [ ] **Step 5: Commit**: `feat(portal): org access request routes and partner pending summary (W3)`
- [ ] **Step 6: W03a gate**

```bash
NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"   # exit=0
cd packages/shared && npx tsc --noEmit; echo "exit=$?"
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4   # FULL unit suite: the merge engine's "no merge policy registered" (orgMerge.ts:1454) reds only here
# every integration file touched in Tasks 1-8 + the Task 2 contract list + test:rls-coverage + test:integration-suite-coverage
git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep -E '^[0-9]{4}-.*\.sql$' \
  | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
pnpm test-stack down
```

Before the PR opens, run one independent review round (`superpowers:requesting-code-review`) and the advisor quorum on D1–D10. The PR body must contain:
- `Part of #11380`;
- the rule-9 statement, decisions D1–D10, and how OD4 and OD5 were resolved;
- the D9 `org_id NOT NULL` justification;
- the post-deploy step: from `apps/api`, run `pnpm exec tsx scripts/portal-identity-reconcile.ts` in each region and expect exit 0;
- "no user-visible change until W03b".

---

## W03b — Web

Test commands: run from `apps/web` with `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. For the typecheck, run `npx astro check; echo "exit=$?"`, then `NODE_OPTIONS=--max-old-space-size=20480 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`.

### Task 9: Shared form, `InheritChoice`, all W03b locale keys

**Files:**
- Create: `apps/web/src/components/shared/InheritChoice.tsx` and `InheritChoice.test.tsx`
- Create: `apps/web/src/components/settings/portalAccess/PortalAccessPolicyForm.tsx` and `PortalAccessPolicyForm.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`. Add **all** keys Tasks 10–12 use, in this task, so the parallel tasks never touch the locale files:
  - `portalAccessPolicy.*`
  - `portalAccessRequests.*`
  - `partnerSettingsPage.tabs.customerPortal.{label,description}`
  - `orgPortalUsersEditor.badges.{noBrowserAccess,microsoft,google}`
  - `contactsCard.portal.status.requested` (next to `none/invited/active/disabled`, used by `ContactsCard.tsx:36-39`)

**Interfaces — Produces:**

```ts
// InheritChoice.tsx — rule 4 for enums and booleans (InheritedField covers text/number only)
export interface InheritChoiceOption<T extends string | boolean> { value: T; label: string; disabled?: boolean; hint?: string; testId: string }
export function InheritChoice<T extends string | boolean>(props: {
  id: string; legend: string; options: InheritChoiceOption<T>[];
  value: T | null;                    // null = inherit
  inheritedValue: T; inheritedSourceLabel: string;   // "Partner default" | "Breeze default"
  allowInherit: boolean;              // false on the partner view (partner blank = Breeze default, shown the same way)
  onChange: (v: T | null) => void; disabled?: boolean;
}): JSX.Element;
// The first radio is "Inherit — {label of inheritedValue} ({inheritedSourceLabel})", data-testid `${id}-inherit`.

// PortalAccessPolicyForm.tsx — presentational; no fetching
export function PortalAccessPolicyForm(props: {
  view: PortalAccessPolicyView; draft: Partial<PortalAccessPolicyRowValues>;
  onChange: (next: Partial<PortalAccessPolicyRowValues>) => void;
  pendingRequestCount?: number; onShowRequests?: () => void;
}): JSX.Element;
```

Form rules:
- **"How people sign in."**
  - The Microsoft row renders only if `view.capabilities.entra`, and the Google row only if `view.capabilities.google`.
  - The Password row is always there. Its options are *Allowed* and *Off — Microsoft/Google only*. The second option is disabled unless the draft's effective `entraEnabled || googleEnabled` is true, with the hint `portalAccessPolicy.password.ssoOnlyNeedsSso`.
- **Fallback.** When `view.passwordModeFallback` is true, show a notice: "Password sign-in is on because no Microsoft or Google sign-in is enabled" (`data-testid="portal-access-policy-fallback"`).
- **"How new people get browser access."**
  - A static "Invites from the MSP — always on" row.
  - Self-registration renders only with `capabilities.selfRegistration`.
  - "First Microsoft / Google sign-in" renders only with `capabilities.entra || capabilities.google` (OD2).
- **Requests.** When `pendingRequestCount > 0`, show "Requests ({n})" as a button calling `onShowRequests`.
- **Read-only.** When `!view.canEdit`, every control is disabled and a note is shown.

- [ ] **Step 1: Write the failing tests**:
  - `InheritChoice shows the inherited value and source and emits null for inherit`
  - `form hides Microsoft/Google/self-registration rows when capabilities are off`
  - `sso_only option is disabled with a hint while no SSO method is on`
  - `shows the fallback notice`, for Review Focus 4
  - `read-only when canEdit is false`
  - the locale parity tests (existing): every new key exists in all 8 locales
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** The locale fan-out is Sonnet-eligible. Translate the keys rather than copying the English.
- [ ] **Step 4: Run** the two test files plus `src/locales/**/*.test.ts` → PASS
- [ ] **Step 5: Commit**: `feat(web): portal access policy form and InheritChoice control (W3)`

### Task 10: Org Sign-in & registration card

**Files:**
- Create: `apps/web/src/components/settings/portalAccess/OrgSignInRegistrationCard.tsx` and `OrgSignInRegistrationCard.test.tsx`
- Modify: `apps/web/src/components/settings/OrgSettingsPage.tsx:659-669`. In `case 'portal'`, the order becomes `OrgPortalSettingsEditor`, then `OrgSignInRegistrationCard`, then `OrgPortalUsersEditor`, per spec §4 ("above the portal users list").
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`).

**Interfaces:**
- Consumes: Task 9, plus `GET/PATCH /orgs/organizations/:id/portal-access-policy` and `GET /orgs/organizations/:id/portal-access-requests?status=pending`, which supplies the count.
- Produces: `OrgSignInRegistrationCard({ orgId, onDirty, onSave })`. It uses the same contract as `OrgPortalSettingsEditor` (`:235-239`): its own Save button inside the card (rule 7, form pattern), PATCH via `runAction` with only the changed fields, `successMessage` `portalAccessPolicy.toasts.saved`, and `friendly` mapping for both `PORTAL_ACCESS_POLICY_*` codes to field errors.
- `onShowRequests` scrolls to `#portal-access-requests` with `element.scrollIntoView`. It does not change the hash, because `#portal` already selects the tab.

- [ ] **Step 1: Write the failing tests**:
  - `loads and renders effective values with sources`
  - `saving an override PATCHes only changed fields and calls onSave`
  - `clearing to inherit sends null`
  - `a 400 SSO_ONLY_NEEDS_SSO shows the field error, not a generic toast`
  - `Requests (n) button scrolls to the queue`
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the card test plus `no-silent-mutations.test.ts`, `settingsPageRegistry.test.ts` (unchanged, proving no new page) and `OrgSettingsPage` tests → PASS
- [ ] **Step 5: Commit**: `feat(web): Sign-in & registration card on the org Portal tab (W3)`

### Task 11: Partner Customer portal tab

**Files:**
- Create: `apps/web/src/components/settings/partnerSettings/PartnerCustomerPortalTab.tsx` and `PartnerCustomerPortalTab.test.tsx`
- Modify `tabRegistry.ts`:
  - `TabKey` gains `'customerPortal'`.
  - Add `{ key: 'customerPortal', hash: 'customer-portal', ...copy('customerPortal'), icon: DoorOpen, kind: 'panel' }` to the `branding` group after `trustCenter` (OD1).
- Modify `tabRegistry.test.ts`: the group map and the counts. Total tabs go from 20 to 21 (`:16`, `:43`), and visible panel tabs from 18 to 19 (`:~53`).
- Modify `saveUnits.ts`: `SaveUnitId` gains `'portalAccessPolicy'`, mapped in `UNIT_TABS`.
- Create `partnerSettings/units/portalAccessPolicyUnit.ts` (`usePortalAccessPolicyUnit`, built on `useDraftSaveUnit`). Model it on `units/aiDataPolicyUnit.ts`.
- Modify `partnerSettingsDraftStore.ts`: add `'portalAccessPolicy'` to `DRAFT_UNIT_IDS` (`:36`) and the slice.
- Modify `PartnerSettingsPage.tsx`: the render branch, and register the unit in the page's unit arrays (`:73-76`).
- If `saveUnits.test.ts` pins the unit list, update it.
- Modify `no-silent-mutations.test.ts` (`TARGET_GLOBS`).

**Interfaces:**
- Consumes: Task 9, `GET/PATCH /orgs/partners/me/portal-access-policy` and `GET /orgs/partners/me/portal-access-requests/summary`.
- Produces: `PartnerCustomerPortalTab`. The tab renders a **Sign-in & registration** section with the form (`allowInherit: false`, Breeze-default source labels, saved by the header Save through the unit using `runAction`). Below it is a **Pending access requests** list: one row per org with a link to that org's settings Portal tab, built with the href the org list already uses. When `pendingTotal === 0` it shows "No pending requests".

- [ ] **Step 1: Write the failing tests**:
  - `tab registered in the branding group with hash customer-portal`
  - `header Save PATCHes the partner policy`
  - `selected-orgs partner user sees the form read-only`
  - `summary lists orgs with pending counts and links`
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** The tab registration and save-unit wiring are Sonnet-eligible.
- [ ] **Step 4: Run** the tab tests, `tabRegistry.test.ts`, `PartnerSettingsStatus.test.tsx`, `settingsPageRegistry.test.ts` and `no-silent-mutations.test.ts` → PASS
- [ ] **Step 5: Commit**: `feat(web): partner Customer portal tab with the sign-in policy default and pending requests (W3)`

### Task 12: Request queue on the portal users list, list badges, Contacts "Requested"

**Files:**
- Create: `apps/web/src/components/settings/portalAccess/PortalAccessRequestsList.tsx` and `PortalAccessRequestsList.test.tsx`
- Modify: `OrgPortalUsersEditor.tsx`. Render the list above the users table at `#portal-access-requests`, and only when pending > 0. Add the badges *Microsoft* / *Google* from `identityProviders` and *No browser access* when `browserAccess === 'none'`.
- Modify: `contactPortalAccess.ts` and its test:
  - Count logins with `browserAccess === 'granted'`, replacing `authMethod === 'password'` at `:29,60-66`.
  - Return `'requested'` when the contact's normalized email is in the pending-request set. This closes the W1 deferral.
  - `ContactPortalStatus` (`:23`) gains `'requested'`, as does the status record in `ContactsCard.tsx:36-39`.
  - `useContactPortalAccess` (`:81-`) fetches `?status=pending` once, next to the logins it already loads.
- Modify: `no-silent-mutations.test.ts`.

**Interfaces:**
- Consumes the Task 8 routes. Each row has an *Approve* and a *Deny* action. Deny asks for confirmation through the existing confirm-dialog component the editor already uses for delete.
- Bulk select uses `/decide`. The per-id `result` values map to one summary toast plus a row-level error badge, for example "Already has an account" for `PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS`.
- After any approval, the list and the users table both reload.
- A row with `accountExists` shows "Already has an account — Deny to dismiss" and disables Approve.

- [ ] **Step 1: Write the failing tests**:
  - `renders nothing when there are no pending requests`
  - `approve calls the route via runAction and reloads users`
  - `bulk decide reports per-row errors`
  - `accountExists disables approve`
  - `badges show identity providers and no browser access`
  - `contact with a pending request reads Requested`
  - `an add-in-only login does not count as portal access`
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Sonnet-eligible; Opus reviews.
- [ ] **Step 4: Run** the touched test files plus `no-silent-mutations.test.ts` → PASS
- [ ] **Step 5: Commit**: `feat(web): portal access request queue, identity badges and Contacts Requested status (W3)`

### Task 13: Docs, browser check, W03b gate

**Files:**
- Modify: `apps/docs/src/content/docs/features/portal.mdx`. Add an MSP-facing section "Sign-in & registration" covering the levels, inheritance, why Password Off is unavailable until Microsoft or Google sign-in exists, and the request queue. Regenerate the index from the repo root with `npx tsx scripts/build-docs-index.ts`, which rewrites `apps/api/src/data/docsIndex.json`.

Steps:
- [ ] **Step 1:** Write the docs and regenerate the index. Sonnet-eligible.
- [ ] **Step 2: Browser check** using the `feature-testing` skill on a `worktree-stack`. No new Playwright spec in W3. Check:
  - The org Portal tab shows the card with Password "Inherit — Allowed (Breeze default)".
  - An org override saves and survives a reload.
  - The partner tab default flows into an org that inherits it.
  - A request row seeded through SQL (`source 'entra'`) approves into an active account carrying the *Microsoft* badge.
  - Tear the stack down afterwards and say so.
- [ ] **Step 3: Gate.**
  - Web: `astro check` exit 0, `tsc` exit 0, and `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main` green.
  - API: `src/data/docsIndex.json` tests.
  - One independent review round.
  - The PR body carries `Closes #11380`, the rule-9 statement, OD1–OD3 as resolved, and screenshots of the card and the tab.
- [ ] **Step 4: Commit**: `docs(portal): Sign-in & registration and access requests (W3)`

---

## Execution split and parallelism

**W03a (API)**
- **SERIAL first:** T1 → T2. The migration and registrations gate everything else.
- **PARALLEL GROUP A1 (file-disjoint):**
  - **T3** (new `portalAccessPolicy*.ts`, shared validator).
  - **T5** (identity readers, `portalUserIdentities.ts`, job files).
- **PARALLEL GROUP A2 (file-disjoint):**
  - **T4** (after T3: new `orgPortalAccessPolicy.ts`, `routes/orgs.ts`).
  - **T6** (after T3 and T5: `auth.ts`, `capabilityTokens.ts`, `browserSession.ts`, `schemas.ts`).
  - **T7** (after T5, because it imports `portalUserHasIdentitySql`: new `portalAccessRequests.ts`, `portalAccountState.ts`, census, `email.ts`, `mailPurposes.ts`).
- **SERIAL:** T8 after T7 (new `orgPortalAccessRequests.ts`).
  - T8 and T4 each add one registration line to `routes/orgs.ts`. T8 lands after T4, so the conflict is trivial.
- **SERIAL last:** the T8 Step 6 gate.
- **Sonnet-eligible:** T2's list edits (contract tests are the check), T5's job wiring (Step 3, second half), T6 Step 6 (the gated deletion).
- **Opus:** T1, T3, T4, T5 readers, T6, T7, T8.

**W03b (Web)**, branched from main after W03a merges
- **SERIAL first:** T9. It holds every locale key, so later tasks never touch the locale files.
- **PARALLEL GROUP B (file-disjoint):**
  - **T10** (`OrgSignInRegistrationCard`, `OrgSettingsPage.tsx`).
  - **T11** (`partnerSettings/*`, `PartnerSettingsPage.tsx`).
  - **T12** (`PortalAccessRequestsList`, `OrgPortalUsersEditor.tsx`, `contactPortalAccess.ts`, `ContactsCard.tsx`).
  - All three add a line to `no-silent-mutations.test.ts` `TARGET_GLOBS`. Rebase those lines.
- **SERIAL last:** T13.
- **Sonnet-eligible:** T9's locale fan-out, T11, T12, T13 docs.
- **Opus:** T9's components and T10.

## CI traps

- **Contract suites that only fail under Integration Tests.**
  - The org-cascade order, merge-registry integration, export policy and export-erasure roundtrip suites go red **only under Integration Tests**, never Test API.
  - The merge engine's `no merge policy registered for '<table>'` (thrown at `orgMerge.ts:1454`) goes red only in the **full** unit suite.
  - `orgMergeRegistry.integration.test.ts` "every keep-survivor table has a UNIQUE constraint on exactly (org_id)" goes red unless `portal_access_policies` is in its `DUAL_AXIS_SETTINGS_TABLES` (Task 2).
  - Run both before the W03a PR (T8 Step 6).
- **RLS coverage.** `portal_access_policies` must appear in both `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`. The second list asserts the partner-wide SELECT branch. A shape-1 table (`portal_access_requests`) needs no entry.
- **Partner-wide writes.** `partner-wide-write-coverage.test.ts` fails if the partner-axis writer in `portalAccessPolicyWrites.ts` does not call `canManagePartnerWidePolicies`.
- **Writer census.** `portalAccountWriters.contract.test.ts` fails on the new `.insert(portalUsers)` in `portalAccessRequests.ts` until that file is classified `state-module`.
- **Migration slot and drift.**
  - The slot is assigned at dispatch. A sibling migration landing first poisons the merge queue (Check Migrations), so re-run the `localeCompare` check before every push, and rename the file and the test's path constant if needed.
  - `pnpm db:check-drift` must exit 0.
- **New job wiring.** It needs `scheduleRegistry.ts` (with no same-minute collision), `workerRegistry.ts` and `workerReadinessManifest.ts`. `scheduleRegistry.contract.test.ts`, `workerReadinessCoverage.test.ts` and `workerReadinessManifest.test.ts` catch a missing piece.
- **Qualifier stripping (#9692).** Drizzle strips table qualifiers in single-table selects, so `portalUserHasIdentitySql` must spell `"portal_users"."id"`. The T5 test `an identity on ANOTHER user does not make this user identity-managed` is what catches a regression.
- **Caught queries in a request transaction.** Inside a request context, a caught approve failure needs `withDbTransaction` with the catch outside it, or it turns into a 500 at commit. T8 has a real-router integration test for this. Never put these calls in `Promise.all` (`dbTransactionPromiseAll.contract.test.ts`).
- **New service files.** `parkedFanout.contract.test.ts` must still not discover them, since none reads `devices`.
- **Partner tab registry.** `tabRegistry.test.ts` hard-codes the group map and tab counts.
- **Locales.** Parity covers 8 locales, including `tr-TR`. `humanizedKeyRegression.test.ts` checks key naming.
- **Typecheck heap.** API `tsc` OOMs below a 20 GB heap and can report a false green through `| tail`. Check `exit=$?`.
- **No stacking.** W03b must branch from main after W03a merges. A stacked PR runs no CI (`gh workflow run CI --ref <branch>` if it ever has to be stacked).
- **Docs index.** Changing `portal.mdx` without regenerating `docsIndex.json` fails the docs-index test.

## Out of scope (owned by later waves)

- **W4:**
  - MSP "grant / remove browser access" row action (only usable once Microsoft sign-in exists);
  - the `sso_only` save flow (stranded-account count, hash clearing, connect emails) and invitation-bound invite emails;
  - minting `entra` sessions;
  - session caps that use `sso_session_max_hours`;
  - flipping `capabilities.entra`.
- **W6:** the self-registration producer, which calls `createPortalAccessRequest`. **W7:** the Google producer.
- **AI tools:** none in W3. The existing `manage_org_portal_settings` does not gain the policy.
- **Release C:** drops `portal_users.entra_*`, the W2 fill trigger and the D4 writer fence.

## Self-review

1. **Spec coverage (§7 W3 row):**
   - `portal_access_policies` → T1/T2.
   - The resolver → T3, and enforcement at use → T6. Inv. 7, 9 and 11 are tested with a capability override.
   - `portal_access_requests` → T1/T2/T7/T8, and the queue UI → T12.
   - The card with live password options → T9/T10, and the partner default → T11.
   - The identities read switch: readers → T5, the authMethod gate → T5 (D5), admin counts and pickers → T5.
   - Reconciliation: at deploy → T1 §4, the report → T5 (D10).
   - Audit actions (§5.10) → T4/T8.
   - Rule 9 → the statement above.
   - Org merge "survivor's policy wins" → T2.
2. **Step scan:** every code step names its file and signature. The SQL is given in full because it is the spec of record. Route and component bodies are left to the implementer.
3. **Type consistency.** These names are used identically across T1–T13:
   - `PortalAccessPolicyRowValues`, `PortalAccessPolicyView`, `PortalSignInCapabilities`, `ResolvedPortalAccessPolicy`, `PortalSignInMethod` / `PortalSessionMethod`;
   - `resolvePortalAccessPolicy`, `isSignInMethodAllowed`, `isBrowserSessionAllowed`, `portalUserHasIdentitySql`;
   - `createPortalAccessRequest`, `approvePortalAccessRequest`, `denyPortalAccessRequest`;
   - `initialPortalAccountState('sso_request_approved' | 'self_request_approved')`, `'access_request_approve'`.
4. **Review Focus:** all five lines have named tests in their owning tasks (T2, T3, T6, T7, T10).
5. **Proportion:** the plan holds interfaces, rules, the migration and test names. No route, service or component body is transcribed.
