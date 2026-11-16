---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W9: Entra SCIM Users Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer's Microsoft Entra tenant can provision its people into one org's customer portal over SCIM 2.0 (Users only). Assigning someone to the Breeze Portal enterprise app creates an identity-only portal account. Disabling, unassigning or deleting them in Entra disables that sign-in at once, and disables the account when nothing else signs in. This absorbs #8278's provisioning half.

**Architecture:**
- **One credential per org, bound to its proven tenant.** An MSP creates a SCIM bearer token for an org on the Portal tab. The token is only valid while the org's **proven** Entra tenant equals the tenant it was bound to at creation, and while the org and partner are active. The secret is shown once, stored as a SHA-256 hash, compared in constant time, revocable and rotatable (two live tokens at most).
- **A SCIM User is an Entra identity of that tenant**, marked SCIM-managed by new columns on `portal_user_identities`. The SCIM resource `id` is the identity row id. `externalId` is the Entra object id and is the identity's `subject`; it is immutable.
- **Never link by email** (inv. 5). SCIM finds an existing account only by `(issuer, subject)`. A POST whose UPN belongs to an existing account with no identity of this person is refused `409 uniqueness`; the MSP sends that person a Microsoft sign-in invite (W4) first.
- **Deactivate and delete go through `disablePortalIdentity`** with blocker `scim` (W8). `active: true` lifts **only** the `scim` blocker and re-activates **only** an account whose `disabled_by = 'scim'`. A directory or MSP blocker, and an MSP or directory account disable, are never touched by SCIM.
- **Public surface, uniform failures.** `/api/v1/scim/portal/v2/*` has no session auth. Every authentication failure is the same `401` SCIM error. Valid tokens are rate-limited per org; failed attempts per IP. Every SCIM write is audited in its own transaction.

**Tech Stack:** Hono, Drizzle (queries only), one hand-written SQL migration, PostgreSQL forced RLS, Redis rate limiter, Astro + React (web), Vitest (unit + `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`:
- §5.1 (SCIM is an allowed `active ↔ disabled` writer and a `browser_access none → granted` path);
- §5.2 (`linked_via = 'scim'`);
- **§5.11 "SCIM (W9, absorbs #8278)", all of it**;
- §6 invariants 2, 4, 5, 9, 10 and 12;
- §3 non-goal: SCIM Groups (scoping is Entra *Assignment required*).

**Builds on (merged on `main` at `00d220e731`):**
- **W2/W3:** `portal_user_identities`, `portalUserHasIdentitySql()`, `services/portalAccountState.ts` (`initialPortalAccountState`, `planPortalAccountTransition`, writer census `__tests__/portalAccountWriters.contract.test.ts`), the writer fence (W3 D4: an Entra identity writer also sets `portal_users.entra_*`).
- **W4:** `findProvenEntraTenantForOrg(orgId)` (`services/portalEntraTenantProof.ts:180`); `createIdentityOnlyAccount` (`services/portalIdentityAccounts.ts`, address lock + "any account at the address ⇒ `account_exists`" + `ON CONFLICT DO NOTHING` on the identity ⇒ `identity_linked`); `resolveLinkableEntraAddress` (contact-link rule: a UPN on a domain the partner declared for this org); `entraIssuer(tid)`.
- **W8:** `disablePortalIdentity` / `restorePortalIdentity` (`services/portalDirectory/identityDisable.ts`), blockers, `portal_users.disabled_by` (`msp | directory | scim`), `portalUserHasUsableIdentitySql()`, readers that refuse a disabled identity under the account lock, `lockPortalDirectorySource(orgId, 'entra')`.
- **Patterns:** `middleware/apiKeyAuth.ts` (hashed key lookup in system scope, per-IP probe limiter, per-key limiter), `routes/orgPortalDirectory.ts` (MSP route gates and `runOutsideDbContext`), `__tests__/routerAuthGate.contract.test.ts` `EXEMPT` and `__tests__/writeRoutePermissionGate.contract.test.ts` (public route classification).

**Rigor: high** (public unauthenticated surface, auth credentials, a new org table, account state machine). Full TDD, one independent review round, contract + integration suites before the PR.

## PR split

One branch, `feature/11377-portal-registration/wave-11386`.

| Part | Tasks | Ships |
|---|---|---|
| **W09a: API + migration** | 1–7 | Token table, SCIM endpoints, MSP token routes. Dark until an MSP creates a token. |
| **W09b: Web + docs** | 8–9 | Portal tab SCIM panel, docs page. |

Both parts go in one PR if the non-test, non-locale diff stays under ~2500 lines; otherwise W09a ships with `Refs #11386` and W09b follows from fresh main with `Closes #11386`.

## Decisions taken in this plan (flag in the PR body)

- **D1: Token storage and shape.**
  - New table `portal_scim_tokens` (shape 1, `org_id NOT NULL`, RLS enabled + forced + four `breeze_has_org_access(org_id)` policies in the creating migration):
    `id uuid pk, org_id uuid not null → organizations, entra_tenant_id text not null, label text not null, secret_hash char(64) not null, secret_hint text not null (last 4 chars), created_by_user_id uuid, created_at, last_used_at, revoked_at, revoked_by_user_id`.
  - Index `(org_id) WHERE revoked_at IS NULL`. Cap: two live tokens per org, enforced under a per-org advisory lock at create (`409 PORTAL_SCIM_TOKEN_LIMIT`).
  - **Why `org_id NOT NULL`** (partner-wide-first justification, #2135): a SCIM token is a credential bound to one org's proven tenant, not configuration. A partner-wide token would let one customer's tenant write into another customer's org.
  - Wire format: `brzscim_<32 hex token id>_<43 char base64url secret>` (32 random bytes). The id is the row id (not secret). Lookup by id in system scope; `timingSafeEqual(sha256(secret), secret_hash)`. A malformed token, an unknown id, a wrong secret, a revoked token, an inactive org/partner, and a tenant mismatch are all the same `401`. An unknown id still runs one dummy hash compare.
  - No expiry: Entra has no token refresh, and an expired token silently quarantines provisioning. Rotation is manual (create the second, paste it into Entra, revoke the first); `last_used_at` shows which one Entra uses. `last_used_at` is written at most once per minute per token.
  - Registration: `CORE_ORG_CASCADE_DELETE_ORDER`; `orgMergeRegistry.ts` **`leave-for-erasure`** (the loser org stops being active, so its tokens stop authenticating; the MSP creates one on the survivor — a merge never silently re-points a credential); `CORE_TENANT_EXPORT_POLICY` with `secret_hash` and `secret_hint` `excludedSensitive`, the rest `included`; `rls-coverage.integration.test.ts`.
- **D2: Tenant binding, re-checked per request** (inv. 2, 3). Create requires `findProvenEntraTenantForOrg(orgId)` (`409 PORTAL_SCIM_TENANT_NOT_PROVEN`); the token stores that tenant. Every request re-reads the proven tenant; a different or missing one is `401` — a tenant transfer, a proof removal or a re-proof to another tenant kills the token on the next request with no extra writer. The SCIM issuer is always `entraIssuer(token.entra_tenant_id)`; nothing in the request names a tenant or an org.
- **D3: SCIM state on the identity.** New columns on `portal_user_identities`:
  - `scim_user_name text` (the SCIM `userName`, Entra UPN);
  - `scim_provisioned_at timestamptz` (non-null = SCIM-managed);
  - `scim_deleted_at timestamptz` (SCIM DELETE received: the resource 404s until a new POST);
  - CHECKs: `scim_user_name` set ⇔ `scim_provisioned_at` set; `scim_deleted_at` ⇒ `scim_provisioned_at`; SCIM columns only on `provider = 'entra'`;
  - partial unique index `(org_id, lower(scim_user_name)) WHERE scim_provisioned_at IS NOT NULL AND scim_deleted_at IS NULL` (SCIM `userName` is unique and case-insensitive).
  - Export policy: all three `included` (plain text/timestamps, like `subject`). No cascade/merge change: identities already cascade and repoint.
  - Rejected: a separate `portal_scim_users` table. It would duplicate the identity key, need a second cascade/merge/export registration, and could drift from the identity it describes.
  - SCIM `active` returned = the identity does not carry the `scim` blocker (SCIM's own assertion). A directory or MSP blocker does not show as `active: false`, so Entra does not loop re-sending `active: true` that SCIM may not act on.
- **D4: Create (`POST /Users`).** Required: `externalId` (a GUID — the Entra `objectId`; anything else `400 invalidValue` naming the mapping to fix) and `userName` (email-shaped). Lowercase both. Then, in one system transaction:
  1. Identity `(entraIssuer(tid), externalId)` exists **in this org**:
     - SCIM-managed and not deleted ⇒ `409 uniqueness` (RFC 7644 §3.3);
     - otherwise **adopt** it: set `scim_user_name`, `scim_provisioned_at = now`, `scim_deleted_at = null`; apply `active` (D6) and the attributes (D5); grant browser access to an `active` account with `browser_access = 'none'` (an add-in account) via new writer `scim_grant_browser_access` (alias of `msp_grant_browser_access`). `linked_via` keeps its history.
  2. Exists **in another org** (the insert conflicts but this org cannot see the row) ⇒ `409 uniqueness`, no detail about the other org (spec).
  3. Any account in this org at the UPN ⇒ `409 uniqueness`, detail "an account with this address exists; send it a Microsoft sign-in invite" (never link by email, inv. 5). Audited as `portal.scim.user.conflict`.
  4. Otherwise `createIdentityOnlyAccount` with writer `scim_provision` (alias of `sso_request_approved`: `active` + `granted`, `auth_method = 'entra'`, `entra_*` set — writer fence) and `linked_via = 'scim'`, plus the SCIM columns. `active: false` on create ⇒ writer `scim_provision_inactive` (`disabled`, `disabled_by = 'scim'`, `granted`) and the identity inserted with blocker `scim`, reason `scim_deactivated`, in the same transaction. Contact: `resolveLinkableEntraAddress(orgId, partnerId, { upn: userName })`; linked only when linkable (the W4 D10 rule).
  - Not gated on the access policy: an MSP-created token is the MSP's authorization, and the spec makes SCIM accounts `active` + `granted`. Browser sign-in still needs `entra_enabled` at use (W4), and add-in use still needs its own gates.
- **D5: Attributes.** Stored: `userName` → `scim_user_name`; `name.formatted` / `displayName` / `givenName + familyName` → `portal_users.name`. `portal_users.email` follows `userName` **only for an identity-only account** (`auth_method <> 'password'`); a password-eligible account's login address never changes from a directory push. `emails` is accepted and ignored (admin-typed, not vouched; W4 D10). Unknown attributes and extension schemas are accepted and ignored. `externalId` is immutable (`400 mutability`); `id` and `meta` are read-only. Contact links are not changed after create.
- **D6: `active`.**
  - `false` (PATCH, PUT) ⇒ `disablePortalIdentity({ blocker: 'scim', reason: 'scim_deactivated' })`. The account rule runs (W8 D2). The account writer for a SCIM blocker is new **`scim_deprovision`** (`disabled_by = 'scim'`; no-op that keeps `disabled_by` on a disabled account). `disablePortalIdentity` picks the writer by blocker. Audit: the W8 row, with `details.via = 'scim'` and `scimTokenId`.
  - `true` ⇒ new `liftScimIdentityBlocker` in `identityDisable.ts`, under the W8 lock order (advisory `(org, 'entra')`, account `FOR UPDATE`, identity `FOR UPDATE`): remove `scim` from the blockers (no-op without it); clear `disabled_at` / `disabled_reason` only when no blocker remains; then, only when the identity is now enabled **and** the account is `disabled` with `disabled_by = 'scim'`, new writer `scim_reactivate` (⇒ `active`, `disabled_by = null`, `bumpEpoch`). Audit `portal.scim.user.reactivate`.
  - Never: clearing `entra_directory`, `google_directory` or `msp`; reactivating an account disabled by `msp` or `directory`; reversing an MSP disable (spec precedence).
  - Rejected: SCIM `active: true` never lifting anything. Entra re-enable and re-assign are routine; requiring an MSP Restore for each would leave Entra and the portal permanently out of step, and SCIM's blocker is an explicit statement from the same channel, not inferred evidence like a W8 snapshot.
- **D7: Delete (`DELETE /Users/:id`)** ⇒ the D6 disable, then `scim_deleted_at = now`. The identity row stays (keeps `(issuer, subject)` reserved, W8 D1); the resource 404s. A later POST with the same `externalId` adopts it (D4.1), and `active: true` lifts the blocker.
- **D8: Reads.** `GET /Users/:id` (SCIM-managed, not deleted, this org). `GET /Users` with `filter` `userName eq "…"` or `externalId eq "…"` only (anything else `400 invalidFilter`), `startIndex`/`count` (max 100). Only SCIM-managed, non-deleted identities of this org are ever visible. `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` behind the token. PATCH supports `add` / `replace` / `remove` (case-insensitive ops, Entra's `"True"`/`"False"` strings), on paths `active`, `userName`, `displayName`, `name.givenName`, `name.familyName`, `name.formatted`, `externalId` (equal value only), and path-less object values. `PUT` replaces the same attributes. Everything else under the base path (Groups, Bulk, `/Me`) is `404` with a SCIM error. Responses are `application/scim+json`.
- **D9: Authentication, rate limits and size.**
  - Middleware order: body limit 64 KiB → bearer parse → lookup + compare (system scope) → tenant/org checks → per-org limiter → handler. No DB context is held by the router; services open their own system contexts with an explicit `org_id = token.orgId` predicate on every statement (the org is server-derived from the token row — the `linkLoginToContact` rule).
  - Failed authentication increments `portal_scim_auth_fail:<ip>` (300 per 5 min); over it, the response is `429` instead of `401`. A **valid** token is never blocked by the IP bucket (Entra calls from shared Microsoft address space).
  - Valid tokens: `portal_scim_org:<orgId>`, 3000 requests per 60 s (Entra expects ~25 rps per tenant), `429` + `Retry-After`. Redis down ⇒ the limiter fails closed (`429`; Entra retries).
- **D10: Audit** (every SCIM write, in the write's transaction; `actorType: 'system'`, `actorId` anonymous, `details.scimTokenId`, resource `portal_user`): `portal.scim.user.create`, `.adopt`, `.update` (changed field names only), `.reactivate`, `.conflict`, `.delete`; deactivation is W8's `portal.directory.identity.disable` with `via: 'scim'`. MSP token actions: `organization.portal_scim_token.create` / `.revoke` (user actor). New resource type label `portal_scim_token` in all 8 web locales.
- **D11: MSP routes** (`routes/orgPortalScim.ts`, registered on `orgRoutes`; gates as W8: partner|system scope, `ORGS_READ` to list, `ORGS_WRITE` + MFA to change):
  - `GET /organizations/:id/portal-scim` → `{ tenantProven, tenantId, baseUrl, tokens: [{ id, label, hint, createdAt, lastUsedAt, revokedAt }], counts: { provisioned, deactivated } }`;
  - `POST /organizations/:id/portal-scim/tokens { label }` → `{ token, … }` — the only time the secret exists outside the hash;
  - `DELETE /organizations/:id/portal-scim/tokens/:tokenId` → revoke (idempotent).
- **D12: Settings rule 9.** SCIM is a per-org credential, not a policy field. Home: org settings › Portal › Sign-in & registration (new "Microsoft Entra provisioning (SCIM)" panel). Level: org only (D1). Resolver: none — the org's live tokens are the state, checked by the SCIM auth middleware. Places SCIM is configured: before 0, after 1. No nav change.

## Advisor quorum

_Filled in after the `codex exec` review (below)._

## Open decisions for the operator

_Filled in after the quorum._

## Global Constraints

- Invariants: 2 (nothing in a SCIM request names the tenant or org), 4 (a token for org A never reads or writes org B), 5 (no email linking; SCIM links only by `(issuer, subject)`), 9 (a SCIM-disabled identity's sessions die on the next request — W8 epoch + purge), 10 (every new account write is a census writer), 12 (never reverses an MSP disable).
- Lock order: advisory `(org, 'entra')` → account → identity (W8 D3).
- Context: SCIM router holds none; services open `withSystemDbAccessContext`; `disablePortalIdentity` / `liftScimIdentityBlocker` run with no held context; MSP routes call services through `runOutsideDbContext`.
- Error codes: `PORTAL_SCIM_TENANT_NOT_PROVEN` (409), `PORTAL_SCIM_TOKEN_LIMIT` (409), `PORTAL_SCIM_TOKEN_NOT_FOUND` (404).
- Migration: `apps/api/migrations/2027-01-25-130000-portal-entra-scim.sql`, sorted after the newest on `origin/main` at push time; idempotent; no inner `BEGIN`/`COMMIT`; writes no rows (DDL only); then `pnpm db:check-drift`.
- PII: logs carry org, token and identity ids only — never `userName` or names. Tests use `example.com`.
- Web: `runAction` for mutations; locale keys in all 8 locales; `data-testid` selectors.

## Review Focus

1. **Cross-org.** Token for org A: GET/PATCH/DELETE an identity id from org B ⇒ 404, nothing written; POST an `externalId` bound in org B ⇒ 409, nothing written. *(Task 9: `a token never reaches another org's identity`.)*
2. **Credential.** Wrong secret, unknown id, revoked token, inactive org, tenant proof removed or moved ⇒ identical 401 bodies; valid token after a proof move ⇒ 401. *(Task 3.)*
3. **Precedence.** `active: true` on an identity with a directory blocker keeps it disabled; on an account with `disabled_by = 'msp'` leaves it disabled. *(Task 4.)*
4. **No email linking.** POST with the UPN of a password account ⇒ 409, the account unchanged, no identity created. *(Task 5.)*
5. **Sessions.** After SCIM deactivate, browser and add-in sessions are refused on the next request. *(Task 9.)*

## File structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2027-01-25-130000-portal-entra-scim.sql`; `db/schema/portalScim.ts` (+ index export); `db/schema/portal.ts` | Token table, identity columns |
| `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts` | Registrations |
| `services/portalAccountState.ts`, `__tests__/portalAccountWriters.contract.test.ts`, `services/portalIdentityAccounts.ts`, `services/portalDirectory/{identityDisable,types}.ts` | Writers `scim_provision`, `scim_provision_inactive`, `scim_deprovision`, `scim_reactivate`, `scim_grant_browser_access`; `liftScimIdentityBlocker`; audit override |
| `services/portalScim/{tokens,protocol,users,index}.ts` (+ tests) | Token mint/verify/revoke; SCIM parse/filter/patch/serialize; user operations |
| `routes/portalScim.ts` (+ test), `index.ts` mount, `routes/orgPortalScim.ts` (+ test), `routes/orgs.ts` | Public SCIM router; MSP token routes |
| `__tests__/routerAuthGate.contract.test.ts`, `__tests__/writeRoutePermissionGate.contract.test.ts` | Public classification |
| `__tests__/integration/portalScim.integration.test.ts` | Real-DB proofs |
| `apps/web/src/components/settings/portalAccess/ScimProvisioningPanel.tsx` (+ test), `OrgSignInRegistrationCard.tsx`, locales | MSP panel |
| `apps/docs/src/content/docs/features/portal-entra-scim.mdx`, `features/portal.mdx`, `astro.config.mjs` | Docs |

## W09a — API + migration

### Task 1: Migration, schema, registrations
- [ ] Red: `tenantExportPolicyRegistry` classification test and `orgMergeGucContract` fail on the new table/columns; `migrationRlsScope.test.ts`.
- [ ] Write the migration (D1, D3): table, RLS enabled + forced + 4 policies, FK `org_id → organizations(id)`, identity columns + CHECKs + partial unique index. Mirror in Drizzle.
- [ ] Register cascade (before `organizations`), merge `leave-for-erasure`, export policy, rls-coverage.
- [ ] `pnpm db:check-drift` against a test stack.

### Task 2: State module writers
- [ ] Red: `portalAccountState.test.ts` cases for `scim_deprovision` (active→disabled/scim; disabled keeps `disabled_by`), `scim_reactivate` (only from `disabled` + `disabled_by = 'scim'`; refuses otherwise), `scim_grant_browser_access`, initial states `scim_provision` / `scim_provision_inactive`; census entries.
- [ ] Implement; `disabledByFor` maps the new writers.

### Task 3: Tokens and the auth middleware
- [ ] Red: `services/portalScim/tokens.test.ts` — mint returns the secret once and stores only the hash; verify accepts the exact token and refuses each failure kind with the same result; constant-time path for unknown ids; tenant mismatch refused; cap of two; revoke idempotent.
- [ ] Implement `mintPortalScimToken`, `verifyPortalScimToken`, `revokePortalScimToken`, `listPortalScimTokens`.

### Task 4: `liftScimIdentityBlocker` and the SCIM disable
- [ ] Red: `identityDisable.test.ts` — scim blocker added with writer `scim_deprovision`; lift removes only `scim`; identity with a directory blocker stays disabled; `msp`/`directory` account disable untouched; `scim` account reactivated with epoch bump; audit override.
- [ ] Implement.

### Task 5: SCIM protocol + user operations
- [ ] Red: `protocol.test.ts` (filter grammar, PATCH ops incl. Entra quirks, serializer, errors) and `users.test.ts` (create, adopt, conflicts, active semantics, delete, reads scoped to org).
- [ ] Implement `services/portalScim/protocol.ts` and `users.ts`.

### Task 6: Routers
- [ ] Red: `routes/portalScim.test.ts` (401 uniformity, 429 paths, content type, each endpoint) and `routes/orgPortalScim.test.ts` (gates, MFA, secret returned once).
- [ ] Implement and mount; classify in both contract tests.

### Task 7: Integration proofs
- [ ] `__tests__/integration/portalScim.integration.test.ts`: cross-org isolation, create → deactivate → reactivate on a real DB, precedence with a directory blocker and an MSP disable, sessions refused after deactivate, token dies when proof is removed.

## W09b — Web + docs

### Task 8: Portal tab panel
- [ ] Red: `ScimProvisioningPanel.test.tsx` — unproven tenant shows the prerequisite; create shows the token once with copy; revoke via `runAction`; tenant URL shown.
- [ ] Implement; slot into `OrgSignInRegistrationCard`; keys in 8 locales.

### Task 9: Docs
- [ ] `features/portal-entra-scim.mdx`: prerequisites (proven tenant), creating the token, Entra enterprise app setup (Tenant URL, Secret Token, **map `objectId` → `externalId` and match on it**, remove Group mappings, *Assignment required*), what each Entra action does, precedence, rotation, troubleshooting 409s. Link from `features/portal.mdx` and the sidebar.

## Out of scope

SCIM Groups; Google push provisioning; generic SCIM for other IdPs (the identity model allows it later); an MSP "link SCIM user to existing account" action (the W4 Microsoft sign-in invite covers it); token expiry.
