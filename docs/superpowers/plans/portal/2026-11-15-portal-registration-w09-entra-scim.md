---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W9: Entra SCIM Users Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer's Microsoft Entra tenant can provision its people into one org's customer portal over SCIM 2.0 (Users only). Assigning someone to the Breeze Portal enterprise app creates an identity-only portal account. Disabling, unassigning or deleting them in Entra disables that sign-in at once, and disables the account when nothing else signs in. This absorbs #8278's provisioning half.

**Architecture:**
- **One credential per org, bound to its proven tenant.** An MSP creates a SCIM bearer token for an org on the Portal tab. The token authenticates only while the org's **proven** Entra tenant equals the tenant it was bound to at creation, and while the org and partner are active. The secret is shown once, stored as a SHA-256 hash, compared in constant time, revocable and rotatable (two live tokens at most).
- **A SCIM User is an Entra identity of that tenant**, marked SCIM-managed by new columns on `portal_user_identities`. The SCIM resource `id` is the identity row id; `externalId` is the Entra object id, which is the identity's `subject`, and is immutable. Every read and write is scoped to the token's org **and** the token tenant's issuer.
- **Never link by email** (inv. 5). SCIM finds an existing account only by `(issuer, subject)`. A POST whose `userName` is the address of an existing account with no identity of this person is refused `409 uniqueness`; the MSP sends that person a Microsoft sign-in invite (W4) first. SCIM-created accounts get no contact link (the SCIM `userName` is not a verified claim).
- **Deactivate and delete add the `scim` blocker through W8's writer**, inside the SCIM request's own transaction. `active: true` lifts **only** the `scim` blocker and re-activates **only** an account whose `disabled_by = 'scim'`. A directory or MSP blocker, and an MSP or directory account disable, are never touched by SCIM.
- **Public surface, uniform failures.** `/api/v1/scim/portal/v2/*` has no session auth. Every authentication failure is the same `401` SCIM error. A dedicated per-IP bucket in the global limiter, a per-IP failure bucket and a per-org bucket bound the load. Every SCIM write is audited in its own transaction; refusals are audited in a separate transaction after the rollback.

**Tech Stack:** Hono, Drizzle (queries only), one hand-written SQL migration, PostgreSQL forced RLS, Redis rate limiter, Astro + React (web), Vitest (unit + `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`:
- §5.1 (SCIM is an allowed `active ↔ disabled` writer and a `browser_access none → granted` path);
- §5.2 (`linked_via = 'scim'`);
- **§5.11 "SCIM (W9, absorbs #8278)", all of it**;
- §6 invariants 2, 4, 5, 9, 10 and 12;
- §3 non-goal: SCIM Groups (scoping is the Entra app's assignment).

**Builds on (merged on `main` at `00d220e731`):**
- **W2/W3:** `portal_user_identities`; `services/portalAccountState.ts` (`initialPortalAccountState`, `planPortalAccountTransition`, writer census `__tests__/portalAccountWriters.contract.test.ts`); the writer fence (W3 D4: an Entra identity writer also sets `portal_users.entra_*`).
- **W4:** `findProvenEntraTenantForOrg(orgId)` (`services/portalEntraTenantProof.ts:180`); `createIdentityOnlyAccount` (`services/portalIdentityAccounts.ts`: address lock, "any account at the address ⇒ `account_exists`", `ON CONFLICT DO NOTHING` ⇒ `identity_linked`, caller must roll back); `entraIssuer(tid)`.
- **W8:** `disablePortalIdentity` / `restorePortalIdentity` (`services/portalDirectory/identityDisable.ts`), blockers, `portal_users.disabled_by` (`msp | directory | scim`), readers that refuse a disabled identity under the account lock, `lockPortalDirectorySource(orgId, 'entra')`, lock order advisory → account → identity.
- **Patterns:** `middleware/apiKeyAuth.ts` (hashed key lookup in system scope), `middleware/globalRateLimit.ts` `ISOLATED_BUCKETS`, `middleware/partnerGuard.ts` `isPartnerGuardExemptPath`, `routes/orgPortalDirectory.ts` (MSP gates, `runOutsideDbContext`), `__tests__/routerAuthGate.contract.test.ts` `EXEMPT`, `__tests__/writeRoutePermissionGate.contract.test.ts`.

**Rigor: high** (public unauthenticated surface, credentials, account state machine). Full TDD, one independent review round, contract + integration suites before the PR.

## PR split

One branch, `feature/11377-portal-registration/wave-11386`.

| Part | Tasks | Ships |
|---|---|---|
| **W09a: API + migration** | 1–7 | Token table, SCIM endpoints, MSP token routes. Dark until an MSP creates a token. |
| **W09b: Web + docs** | 8–9 | Portal tab SCIM panel, docs page. |

Both parts go in one PR if the non-test, non-locale diff stays under ~2500 lines; otherwise W09a ships with `Refs #11386` and W09b follows from fresh main with `Closes #11386`.

## Decisions taken in this plan (flag in the PR body)

- **D1: Token storage and shape.**
  - New table `portal_scim_tokens` (shape 1, `org_id NOT NULL`, RLS enabled + forced + four `breeze_has_org_access(org_id)` policies in the creating migration): `id, org_id, entra_tenant_id, label, secret_hash char(64), secret_hint, created_by_user_id, created_at, last_used_at, revoked_at, revoked_by_user_id`.
  - Two live tokens per org at most, checked under a per-org advisory lock at create (`409 PORTAL_SCIM_TOKEN_LIMIT`).
  - **Why `org_id NOT NULL`** (partner-wide-first justification, #2135): a credential bound to one org's proven tenant, not configuration. A partner-wide token would let one customer's tenant write into another customer's org.
  - Wire format: `brzscim_<32 hex token id>_<43 char base64url secret>` (32 random bytes). Lookup by id in system scope, then `timingSafeEqual` of equal-length SHA-256 digests. An unknown id still runs one dummy compare. Malformed, unknown, wrong secret, revoked, inactive org/partner, tenant mismatch: one identical `401`.
  - No expiry. Entra's manually entered Secret Token has no automatic refresh, so an expiring token silently quarantines provisioning. Rotation: create the second, paste it into Entra, revoke the first; `last_used_at` (written at most once a minute) shows which one Entra uses.
  - Registration: `CORE_ORG_CASCADE_DELETE_ORDER`; `orgMergeRegistry.ts` **`leave-for-erasure`** (the merge fences the loser org, so its tokens stop authenticating; a merge never re-points a credential); `CORE_TENANT_EXPORT_POLICY` (`secret_hash`, `secret_hint` `excludedSensitive`; the rest `included`); `rls-coverage.integration.test.ts`.
- **D2: Tenant binding, re-checked per request and under the locks** (inv. 2, 3).
  - Create requires a proven tenant (`409 PORTAL_SCIM_TENANT_NOT_PROVEN`); the token stores it.
  - Every request re-reads the org's proven tenant before any work, and every mutation re-checks it inside its transaction after the row locks (`FOR SHARE` on the tenant mapping, the W4 `lockProvenEntraTenant` pattern) together with the token's `revoked_at`. A different or missing proof is `401`.
  - Removing the proof **suspends** an unrevoked token; proving the same tenant again makes it valid again. Proving a different tenant leaves it permanently invalid for that org (the docs say so; the MSP revokes it).
  - The issuer is always `entraIssuer(token.entra_tenant_id)`; nothing in the request names a tenant or an org.
- **D3: SCIM state on the identity.** New columns on `portal_user_identities`:
  - `scim_user_name`, `scim_display_name`, `scim_given_name`, `scim_family_name` (text);
  - `scim_provisioned_at` (non-null = SCIM-managed), `scim_deleted_at` (a SCIM DELETE was received; the resource 404s until a new POST);
  - CHECK: user name set ⇔ provisioned; deleted ⇒ provisioned; SCIM columns only on `provider = 'entra'`;
  - a **non-unique** lookup index `(org_id, issuer, lower(scim_user_name))` over managed, non-deleted rows. `userName` uniqueness is enforced by the service under the address lock, not by a constraint: identities repoint on org merge with no dedupe (`orgMergeRegistry.ts:1235`), and an org-scoped unique key could abort a merge on a recycled UPN (quorum D3). After such a merge a `userName` filter can return two resources; the docs make `externalId` the only matching attribute, so Entra never depends on it.
  - Export policy: every new column `included` (plain text and timestamps).
  - Rejected: a separate `portal_scim_users` table. It would duplicate the identity key, need a second cascade/merge/export registration, and could drift from the identity it describes.
  - SCIM `active` returned = the identity does not carry the `scim` blocker (SCIM's own assertion). A directory or MSP blocker is not shown as `active: false`, so Entra does not loop re-sending an `active: true` SCIM may not act on. The MSP panel shows effective access.
- **D4: Create (`POST /Users`).** Required: `externalId` (a GUID, lowercased — the Entra `objectId`; anything else `400 invalidValue` naming the mapping to fix) and `userName` (email-shaped, lowercased). In one system transaction, under the address lock on `userName` and the W8 lock order:
  1. Identity `(issuer, externalId)` exists **in this org**: SCIM-managed and not deleted ⇒ `409 uniqueness`; otherwise **adopt** it (set the SCIM columns, clear `scim_deleted_at`; apply `active` (D6) and the attributes (D5); an `active` account with `browser_access = 'none'` — an add-in account — is granted browser access by `scim_grant_browser_access`). `linked_via` keeps its history.
  2. Exists **in another org** (or the legacy `portal_users.entra_*` key does) ⇒ `409 uniqueness`, no detail.
  3. Another live SCIM resource in this org has the `userName` ⇒ `409 uniqueness`.
  4. Any account in this org at the `userName` address ⇒ `409 uniqueness` ("an account with this address exists; send it a Microsoft sign-in invite") — never link by email.
  5. Otherwise `createIdentityOnlyAccount` with writer `scim_provision` (`active` + `granted`, `auth_method = 'entra'`, `entra_*` set — writer fence), `linked_via = 'scim'`, **no contact link** (quorum D4: the SCIM `userName` is admin-mapped, not a verified claim; see OD1), plus the SCIM columns. `active: false` on create ⇒ writer `scim_provision_inactive` (`disabled`, `disabled_by = 'scim'`) and the identity inserted with blocker `scim`, reason `scim_deactivated`, in the same transaction.
  - Refusals throw out of the transaction (rolling back any partial write — `createIdentityOnlyAccount` may have written the login), then `portal.scim.user.conflict` is audited in a separate transaction.
  - Not gated on the access policy: the MSP-created token is the MSP's authorization, and the spec makes SCIM accounts `active` + `granted`. Browser sign-in still needs `entra_enabled` at use (W4); add-in use keeps its own gates.
- **D5: Attributes.**
  - Stored as received: `userName`, `displayName`, `name.givenName`, `name.familyName`. `portal_users.name` = `displayName`, else `givenName familyName`, else unchanged. GET returns what was stored, so Entra sees no drift.
  - `portal_users.email` follows `userName` **only on an account SCIM itself created** (identity `linked_via = 'scim'`, identity-only), under the address lock, and only when no other account in the org is at the new address (otherwise the SCIM attribute changes and the login address stays; audited). A password-eligible account, and an account SCIM adopted, never has its address changed by a directory push (implementation-time security review: the SCIM `userName` is admin-mapped, not a verified claim).
  - Accepted and ignored: `emails`, `phoneNumbers`, `title`, the enterprise extension and any other attribute or URN, in every PATCH form (path, filtered path such as `emails[type eq "work"].value`, path-less object).
  - Read-only / immutable: `id`, `meta`; `externalId` may only be "replaced" with its current value (`400 mutability`); `remove` of `userName` or `externalId` is `400`.
  - Contact links are never changed by SCIM.
- **D6: `active`, and one transaction per SCIM mutation** (quorum omission 1).
  - `identityDisable.ts` exposes **transaction-local** primitives — `disableIdentityInTransaction` and `liftScimBlockerInTransaction` — and keeps `disablePortalIdentity` / `liftScimIdentityBlocker` as standalone wrappers. Each SCIM PATCH / PUT / DELETE / adopt runs **one** system transaction: advisory `(org, 'entra')` → account `FOR UPDATE` → identity `FOR UPDATE` → D2 re-check → attribute updates → blocker change → tombstone → audit. Purges run after commit.
  - The SCIM disable takes the `(org, 'entra')` advisory lock too (W8 takes it only for run actions).
  - `false` ⇒ blocker `scim`, reason `scim_deactivated`; the W8 account rule; account writer **`scim_deprovision`** (`disabled_by = 'scim'`; a no-op that keeps `disabled_by` on a disabled account); epoch bump; after commit, browser and add-in purge. Audit: the W8 `portal.directory.identity.disable` row with `via: 'scim'` and `scimTokenId`.
  - `true` ⇒ remove only `scim`; clear `disabled_at` / `disabled_reason` only when no blocker remains; then, only when the identity is now enabled **and** the account is `disabled` with `disabled_by = 'scim'`, writer **`scim_reactivate`** (active, `disabled_by` null, epoch bump). Audit `portal.scim.user.reactivate`.
  - Never: clearing `entra_directory`, `google_directory` or `msp`; reactivating an account disabled by `msp` or `directory`.
  - Purge failure: logged with ids only, not retried. The epoch bump is authoritative (W8 D2); W8's retry rides on action rows, which SCIM has none of. See OD3.
  - Rejected: SCIM `active: true` never lifting anything. Entra re-enable and re-assign are routine; requiring an MSP Restore each time would leave Entra and the portal permanently out of step, and SCIM's blocker is an explicit statement from the same channel, not inferred evidence like a W8 snapshot. See OD2.
- **D7: Delete (`DELETE /Users/:id`)** ⇒ the D6 disable **and** `scim_deleted_at = now`, in the same transaction (quorum D7: otherwise a concurrent `active: true` could leave a deleted-but-enabled identity). The identity stays (keeps `(issuer, subject)` reserved). A later POST with the same `externalId` adopts it, and its `active: true` lifts the blocker. Unassignment normally arrives as `active: false`, not DELETE; inactive resources stay readable.
- **D8: Reads and protocol.**
  - Visibility, everywhere (reads, writes, and the locked-row re-validation): `org_id = token.org_id AND provider = 'entra' AND issuer = entraIssuer(token.tenant) AND scim_provisioned_at IS NOT NULL AND scim_deleted_at IS NULL` (quorum D8: a token for a new tenant must not see the previous tenant's identities).
  - `GET /Users/:id`; `GET /Users?filter=` with `userName eq "…"` or `externalId eq "…"` only (case-insensitive attribute and operator; any value — Test Connection sends a random GUID and expects `200` with an empty `ListResponse`); anything else `400 invalidFilter`. `startIndex` / `count` (max 100). `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` behind the token.
  - PATCH: `add` / `replace` / `remove`, case-insensitive; `active` as boolean or `"True"`/`"False"`; paths `active`, `userName`, `displayName`, `name.givenName`, `name.familyName`, `name`, `externalId`; path-less objects including literal dotted keys (`"name.givenName"`). The whole operation list is validated before anything is written (RFC 7644 §3.5.2 atomicity).
  - PUT: replaces `userName`, `displayName` and `name`; omitted name parts are cleared; an omitted `active` leaves it unchanged (never an implicit activate or deactivate).
  - Groups, Bulk, `/Me`, anything else: `404` SCIM error. Content type `application/scim+json`; body limit 64 KiB.
- **D9: Authentication and load.**
  - `partnerGuard` exempts `/api/v1/scim/` (quorum omission 5: a staff JWT sent there must never activate a partner or answer 403/503 before SCIM auth).
  - The global limiter gets an **isolated bucket** `/api/v1/scim/` (6000 requests per minute per trusted, IPv6-/64-normalized IP), so SCIM never shares the 600/min anonymous bucket with other traffic from Microsoft's shared egress (quorum D9). It bounds lookup load per address.
  - Router order: well-formedness (no Redis, no DB; a malformed token is a free `401`) → failure bucket `portal_scim_auth_fail:<tokenId>:<ip>` (over 300 failures in 5 minutes ⇒ `429` before any lookup) → lookup + compare → tenant/org checks → per-org bucket `portal_scim_org:<orgId>` (3000 per minute, `429` + `Retry-After`) → handler. A refused well-formed token increments its bucket. Keying on token id **and** address (implementation-time security review) means failures from Microsoft's shared egress can never lock out another org's token, and someone who learns a token id cannot lock out the address Entra uses. Redis down ⇒ fail closed (`429`; Entra retries).
  - The router holds no DB context. Services open their own system contexts with the D8 predicate on every statement (the org is server-derived from the token row).
- **D10: Audit** (in the write's transaction; `actorType: 'system'`, anonymous actor, `details.scimTokenId`, resource `portal_user`): `portal.scim.user.create`, `.adopt`, `.update` (changed attribute names only), `.reactivate`, `.delete`; deactivation is W8's row with `via: 'scim'`. Refusal: `portal.scim.user.conflict` in its own transaction after the rollback. MSP token actions: `organization.portal_scim_token.create` / `.revoke` (user actor). New resource type label `portal_scim_token` in all 8 web locales.
- **D11: MSP routes** (`routes/orgPortalScim.ts`, on `orgRoutes`; gates as W8: partner|system scope, `ORGS_READ` to read, `ORGS_WRITE` + MFA to change; org authorized under the request context first, services through `runOutsideDbContext`):
  - `GET /organizations/:id/portal-scim` → `{ tenant: { proven, tenantId }, baseUrl, tokens: [{ id, label, hint, createdAt, lastUsedAt, revokedAt, usable }], counts: { provisioned, deactivated } }`;
  - `POST /organizations/:id/portal-scim/tokens { label }` → `{ token, … }`, the only time the secret exists outside the hash;
  - `DELETE /organizations/:id/portal-scim/tokens/:tokenId` → revoke by org **and** id (idempotent).
- **D12: Settings rule 9.** SCIM is a per-org credential, not a policy field. Home: org settings › Portal › Sign-in & registration (new "Microsoft Entra provisioning (SCIM)" panel). Level: org only (D1). Resolver: none — the org's live tokens are the state, checked by the SCIM auth middleware. Places SCIM is configured: before 0, after 1. No nav change.

## Advisor quorum

An independent `codex exec` (gpt-6-astra, `model_reasoning_effort="xhigh"`, `-s read-only`, stdin closed) reviewed the first draft on 2026-11-15 against the spec, the index, the W8 plan and the landed identity, account-state, proof, address and registration code. Verdict: **REVISE BEFORE IMPLEMENTATION — blocker precedence is sound, but tenant scoping, contact provenance, transaction composition and mounted middleware need correction.** Each code claim it made was checked before adopting it.

| Draft decision | Verdict | Resolution |
|---|---|---|
| D1 tokens | AGREE WITH CHANGES | Kept. Rationale corrected (manually entered Secret Token, not "Entra has no refresh"). |
| D2 tenant binding | AGREE WITH CHANGES | Re-check inside each mutation after the locks; proof removal documented as suspension. |
| D3 identity columns | AGREE WITH CHANGES — the org/userName unique index breaks merge's org-free-key assumption | **Adopted:** non-unique index, uniqueness in the service under the address lock. Structured name parts stored (D5). |
| D4 create/adopt | **DISAGREE** — passing SCIM `userName` as a UPN fabricates the verified-claim provenance `resolveLinkableEntraAddress` relies on | **Adopted:** no contact link for SCIM accounts (OD1). Refusals roll back the transaction; `identity_linked` included. |
| D5 attributes | AGREE WITH CHANGES | Address lock and collision check on rename; structured name state; full PATCH forms. |
| D6 active | AGREE WITH CHANGES — the SCIM disable takes no advisory lock | **Adopted:** the transaction-local primitives and one lock order (D6). |
| D7 delete | AGREE WITH CHANGES — disable and tombstone must be atomic | **Adopted** (D7). |
| D8 reads | **DISAGREE** — org-only scope lets a new tenant's token see the old tenant's identities | **Adopted:** issuer-scoped visibility everywhere (D8). |
| D9 auth/limits | **DISAGREE** — the global limiter puts valid Microsoft callers in the shared 600/min bucket; a post-lookup failure bucket does not bound DB work | **Adopted:** isolated global bucket, pre-lookup failure check, `partnerGuard` exemption (D9). |
| D10 audit | AGREE WITH CHANGES | Conflict audit in its own transaction after rollback. |
| D11 MSP routes | AGREE | Revoke by org and id. |
| D12 settings | AGREE | — |
| Omission: Entra mapping | Adopted | Docs require `objectId → externalId` as the **only** matching attribute, "Sync only assigned users and groups", Group mappings off. |
| Omission: PATCH forms, Test Connection | Adopted | D8 and Task 5 fixtures. |
| Omission: concurrency proofs | Adopted | Task 7 (W8 apply/Restore ordering, DELETE vs reactivate, cross-org zero residue, tenant replacement). |
| Omission: SCIM purge retry | Operator decision | OD3. |

No disagreement is left open.

## Open decisions for the operator

- **OD1: Contact link for SCIM-created accounts.** Plan: none. The SCIM `userName` comes from an attribute mapping the customer admin controls, so it is not the verified UPN claim the contact rule needs, and a contact link grants that address's ticket history. **Recommend** keeping none in W9 and adding a link on the person's first Microsoft sign-in (verified claims) as a follow-up. Alternative: link when the domain is a **verified** domain of the org (W5), which proves the org owns the domain but not that this person owns the address.
- **OD2: SCIM `active: true` re-activates an account SCIM disabled.** Plan: yes, only for `disabled_by = 'scim'` (D6). **Recommend** as planned. Alternative: SCIM never re-activates; every return needs an MSP Restore.
- **OD3: Session-purge retry for SCIM disables.** Plan: none — the epoch bump already refuses the sessions on their next request. **Recommend** as planned. Alternative: a small outbox table so the recovery sweep retries the Redis cleanup.
- **OD4: The numbers.** Isolated per-IP bucket 6000/min, failure bucket 300 per 5 min per (token id, address), per-org 3000/min, two live tokens. **Recommend** as defaults, tuned after the first customers. Because the failure bucket is keyed on the token id too, another tenant's failures on a shared Microsoft egress address never throttle a valid token.

## Global Constraints

- Invariants: 2 (nothing in a SCIM request names the tenant or org), 4 (a token for org A never reads or writes org B), 5 (no email linking), 9 (a SCIM-disabled identity's sessions die on the next request), 10 (every new account write is a census writer), 12 (never reverses an MSP disable).
- Lock order: advisory `(org, 'entra')` → address lock (create only) → account → identity → tenant mapping `FOR SHARE`.
- Context: the SCIM router holds none; services open `withSystemDbAccessContext`; MSP routes call services through `runOutsideDbContext`.
- Error codes: `PORTAL_SCIM_TENANT_NOT_PROVEN` (409), `PORTAL_SCIM_TOKEN_LIMIT` (409), `PORTAL_SCIM_TOKEN_NOT_FOUND` (404).
- Migration: `apps/api/migrations/2027-01-25-130000-portal-entra-scim.sql`, sorted after the newest on `origin/main` at push time; idempotent; no inner `BEGIN`/`COMMIT`; DDL only; then `pnpm db:check-drift`.
- PII: logs carry org, token and identity ids only. Tests use `example.com`.
- Web: `runAction` for mutations; locale keys in all 8 locales; `data-testid` selectors.

## Review Focus

1. **Cross-org and cross-tenant.** Token for org A: GET/PATCH/DELETE an identity id of org B ⇒ 404, nothing written; POST an `externalId` bound in org B ⇒ 409, zero residual rows. A token of a newly proven tenant cannot see the previous tenant's SCIM identities. *(Tasks 5, 7.)*
2. **Credential.** Wrong secret, unknown id, revoked token, inactive org, proof removed or moved ⇒ identical 401 bodies through the full middleware stack, including a staff JWT. *(Tasks 3, 6.)*
3. **Precedence.** `active: true` on an identity with a directory blocker keeps it disabled; on an account with `disabled_by = 'msp'` leaves it disabled. *(Task 4.)*
4. **No email linking.** POST with the address of a password account ⇒ 409, the account unchanged, no identity, no contact. *(Tasks 5, 7.)*
5. **Sessions.** After SCIM deactivate, browser and add-in sessions are refused on the next request. *(Task 7.)*

## File structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2027-01-25-130000-portal-entra-scim.sql`; `db/schema/portalScim.ts` (+ index export); `db/schema/portal.ts` | Token table, identity columns |
| `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts` (+ test), `__tests__/integration/rls-coverage.integration.test.ts` | Registrations |
| `services/portalAccountState.ts`, `__tests__/portalAccountWriters.contract.test.ts`, `services/portalIdentityAccounts.ts`, `services/portalDirectory/{identityDisable,types,index}.ts` | New writers; transaction-local disable / lift; audit details |
| `services/portalScim/{tokens,protocol,users,index}.ts` (+ tests) | Token mint/verify/revoke; SCIM parse/filter/patch/serialize; user operations |
| `routes/portalScim.ts` (+ test), `index.ts` mount, `middleware/partnerGuard.ts`, `middleware/globalRateLimit.ts`, `routes/orgPortalScim.ts` (+ test), `routes/orgs.ts` | Public router; MSP routes |
| `__tests__/routerAuthGate.contract.test.ts`, `__tests__/writeRoutePermissionGate.contract.test.ts` | Public classification |
| `__tests__/integration/portalScim.integration.test.ts` | Real-DB proofs |
| `apps/web/src/components/settings/portalAccess/ScimProvisioningPanel.tsx` (+ test), `OrgSignInRegistrationCard.tsx`, locales | MSP panel |
| `apps/docs/src/content/docs/features/portal-entra-scim.mdx`, `features/portal.mdx`, `astro.config.mjs` | Docs |

## W09a — API + migration

### Task 1: Migration, schema, registrations
- [ ] Red: `tenantExportPolicyRegistry.portalScim.test.ts` (every new column classified; the secret columns `excludedSensitive`).
- [ ] Migration (D1, D3), Drizzle mirror, cascade (children before `organizations`), merge `leave-for-erasure`, export policy, rls-coverage. `pnpm db:check-drift` on a test stack.

### Task 2: State module writers
- [ ] Red: `portalAccountState.test.ts` — `scim_deprovision`, `scim_reactivate`, `scim_grant_browser_access`, initial `scim_provision` / `scim_provision_inactive`; census boundary writers.
- [ ] Implement.

### Task 3: Tokens
- [ ] Red: `services/portalScim/tokens.test.ts` — mint returns the secret once and stores only the hash; verify accepts the exact token and refuses every failure kind with the same result; dummy compare for unknown ids; tenant mismatch / proof removed refused; cap of two; revoke by org and id.
- [ ] Implement.

### Task 4: Transaction-local disable and lift
- [ ] Red: `identityDisable.test.ts` — the SCIM blocker uses `scim_deprovision` and the advisory lock; audit details merged under the writer's fields; lift removes only `scim`; directory blocker keeps the identity disabled; `msp` / `directory` account untouched; `scim` account reactivated with an epoch bump; in-transaction variants write nothing outside the caller's transaction.
- [ ] Implement.

### Task 5: SCIM protocol + user operations
- [ ] Red: `protocol.test.ts` (filter grammar incl. Test Connection's GUID, PATCH forms incl. Entra quirks and ignored attributes, atomic validation, serializer, errors) and `users.test.ts` (create, adopt, each 409 with rollback + separate audit, active semantics, delete atomicity, D8 visibility predicate on every statement).
- [ ] Implement.

### Task 6: Routers
- [ ] Red: `routes/portalScim.test.ts` (401 uniformity incl. a staff JWT, 429 paths, content type, each endpoint) and `routes/orgPortalScim.test.ts` (gates, MFA, secret returned once). `partnerGuard` and `globalRateLimit` tests for the new path.
- [ ] Implement and mount; classify in both contract tests.

### Task 7: Integration proofs
- [ ] `__tests__/integration/portalScim.integration.test.ts`: cross-org and cross-tenant isolation with zero residue; create → deactivate → reactivate; precedence with a directory blocker and an MSP disable; sessions refused after deactivate; token suspended when proof is removed; DELETE vs `active: true` ordering.

## W09b — Web + docs

### Task 8: Portal tab panel
- [ ] Red: `ScimProvisioningPanel.test.tsx` — unproven tenant shows the prerequisite; create shows the token once with copy; revoke via `runAction`; tenant URL shown.
- [ ] Implement; slot into `OrgSignInRegistrationCard`; keys in 8 locales.

### Task 9: Docs
- [ ] `features/portal-entra-scim.mdx`: prerequisites (proven tenant); creating and rotating the token; Entra setup (Tenant URL, Secret Token, **`objectId → externalId` as the only matching attribute**, "Sync only assigned users and groups", Group mappings off); what each Entra action does; precedence; troubleshooting 409s. Link from `features/portal.mdx` and the sidebar.

## Out of scope

SCIM Groups; Google push provisioning; generic SCIM for other IdPs; an MSP "link SCIM user to existing account" action (the W4 Microsoft sign-in invite covers it); token expiry; contact linking (OD1).
