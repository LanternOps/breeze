---
tracking_issue: LanternOps/breeze#11377
---
# Customer Portal Registration Options — Wave Index

> **For agentic workers:** this is the index. Each wave has its own plan file; implement a wave from its file using superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Plans for W3–W9 are written **when the wave starts**, against main as it is then, because they consume interfaces earlier waves create.

**Goal:** Let an MSP choose, per customer org, how that customer's staff get customer-portal access. The options are invite from contacts, self-registration by verified domain, Sign in with Microsoft, Sign in with Google, and Entra SCIM. New people go to an approval queue or are let in, and leavers lose access automatically.

**Architecture:** Each account gets separate fields for its lifecycle (`status`), its password credential, its external identities (`portal_user_identities`) and browser access (`browser_access`). A partner-default/org-override policy (`portal_access_policies`) is enforced at use. Proof of tenant and domain ownership never comes from MSP input. A single OIDC layer serves Microsoft and Google, and account linking never happens on an email match.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only) + hand-written SQL migrations, PostgreSQL RLS, Redis, `jose`, Astro + React (web and portal), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md` (approved r2, PR #11326). Absorbs #8278.

## Global Constraints (every wave)

- No automatic account linking by email match, ever (spec §5.6, invariant 5).
- No MSP-entered value or callback query parameter is treated as proof of a tenant or domain (invariant 2).
- Unauthenticated discovery and failure responses are identical in body, status and throttling (invariant 8).
- Browser and add-in sessions never grant each other access (invariant 9).
- Every `status` / `browser_access` writer goes through the W2 state module (invariant 10).
- New org_id tables: RLS enabled + forced + policies in the creating migration, and registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`, and `rls-coverage.integration.test.ts`. Composite FKs to `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`.
- Config tables are `org_id` XOR `partner_id` (partner-wide first, #2135).
- Migrations: name sorts after the newest on main at push time, idempotent, no inner `BEGIN`/`COMMIT`, `SELECT set_config('breeze.scope', 'system', true);` before row writes, then `pnpm db:check-drift`. Never rename a shipped migration.
- Settings PRs state home, level, resolver, and the before/after count (rule 9).
- Web mutations use `runAction`. New locale keys go into all 8 locales.
- Full + contract (Integration Tests) suites run before every PR in W2–W9 (tenancy/auth touched).

## Review Focus (feature-wide; each wave plan pins the ones it owns)

1. **An email that exists in two orgs.** Login, self-registration, invites and SSO must each resolve to the right org or fail generically, never pick the "first" match. Owned by W2 (login) and W6 (self-registration).
2. **A tenant or domain that changes hands** (repointed domain row, org merge, a new proof from another partner). Dependent features stop on the next request, and nobody lands in the old org. Owned by W4 and W5.
3. **An add-in user who opens the browser portal.** They get the new-person policy, not silent access. Owned by W4.
4. **A policy change that happens while sessions and tokens are outstanding** (method turned off, `sso_only` turned on, inherited partner change). Takes effect on the next request or token use. Owned by W3 and W4.
5. **A partial or failed directory sync.** It never disables anyone. Owned by W8.

## Waves

| Wave | Plan file | Depends on | Risk | Status |
|---|---|---|---|---|
| W1 Invite from contacts | `2026-11-08-portal-registration-options-w01-invite-from-contacts.md` | — | Medium | plan written |
| W2 Account foundations | `2026-11-08-portal-registration-options-w02-account-foundations.md` | — | High | plan written |
| W3 Policy + access requests + identities read switch | `2026-11-08-portal-registration-options-w03-access-policy.md` (W03a API, W03b web) | W2 | High | plan written |
| W4 Tenant proof + Microsoft sign-in + OIDC layer + session caps + `sso_only` | `2026-11-09-portal-registration-options-w04-entra-sign-in.md` (W04a API, W04b web + portal) | W3 | High | plan written |
| W5 Domain verification + Organization › Domains | `2026-11-11-portal-registration-options-w05-domain-verification.md` (W05a API, W05b web) | W3 (Entra method: W4) | Medium | plan written |
| W6 Self-registration | write at start | W3, W5 | High | — |
| W7 Sign in with Google | write at start | W4, W5 | High | — |
| W8 Directory deprovisioning | write at start | W4 or W7 | High | — |
| W9 Entra SCIM Users (#8278) | write at start | W4 | High | — |
| Cleanup: drop `portal_users.entra_*` | write at start | W3 shipped + one release reconciled | Medium | — |

W1 and W2 can run in parallel.

## Cross-wave interfaces

Later wave plans must use these names. If W2's plan or code renames any of them, update this table in the W2 PR.

| Produced by | Name | Consumed by |
|---|---|---|
| W2 | `portal_user_identities` table + Drizzle `portalUserIdentities` | W3, W4, W7, W8, W9 |
| W2 | `portal_users.browser_access` (`granted` / `none`) | W3, W4, W6, W9 |
| W2 | state module `services/portalAccountState.ts` (allowed transitions + assert helper) | all later waves |
| W2 | purpose-bound token helpers (issue/consume with `{purpose, portalUserId, orgId, email, authEpoch}`) | W4 (invite/link purposes), W6 (self-registration purpose) |
| W2 | identity reconciliation function | W3 (read switch), cleanup |
| W3 | `resolvePortalAccessPolicy(orgId)` → effective values + per-field source; `isSignInMethodAllowed(policy, method)` | W4–W9 |
| W3 | `getPortalSignInCapabilities()`: each wave flips its own key (`entra` W4, `selfRegistration` W6, `google` W7) | W4, W6, W7 |
| W3 | `portal_access_requests` table + `createPortalAccessRequest` / `approvePortalAccessRequest` / `denyPortalAccessRequest` | W4, W6, W7 |
| W3 | browser session `method` (`PortalSessionMethod`) + `parseStoredPortalSession` + `isBrowserSessionAllowed` | W4, W7 |
| W3 | `portalUserHasIdentitySql()`: the only "has an external identity" fact | all later waves |
| W3 | Writer fence (W3 plan D4): until release C, every writer that creates an Entra identity also sets `portal_users.entra_*`, and every writer that removes one clears them | W4, W8, W9, cleanup |
| W4 | OIDC common layer: `services/portalOidc/` (`createPortalOidcState` / `consumePortalOidcState`, `PortalOidcProvider`, `resolvePortalOidcSignIn` for §5.6), `linkPortalUserIdentity` (D4 fence), `mintPortalBrowserSession` | W7 |
| W4 | tenant proof on `client_ai_tenant_mappings` (`proven_at`, `proven_via`, `proven_by_user_id`, `proven_evidence`; cleared on tenant change) + `findProvenEntraTenantForOrg` / `findOrgByProvenEntraTenant` | W5 (`entra_tenant` method), W8, W9 |
| W4 | Rule: every identity-removing writer clears `portal_users.entra_*` and bumps `auth_epoch` (Entra sessions carry their tenant and die durably) | W8, W9 |
| W5 | domain verification state on `customer_email_domains` + `isDomainVerifiedForOrg(domain, orgId)`, `findOrgByVerifiedDomain(domain)`, `listVerifiedDomainsForOrg(orgId)` (`services/portalDomainVerification/`; evidence re-checked at use) | W6, W7 |

## Wave entry checklist (W3+)

1. `get_feature_status` and confirm the predecessor waves are merged on main.
2. Fetch and branch: `feature/<parent#>-portal-registration/wave-<subissue#>`, then `start_wave`.
3. Write the wave plan with superpowers:writing-plans against current main. Use the spec section listed in spec §7, plus this index's interfaces table.
4. Re-run the spec's §6 invariants that the wave touches as named tests in its plan.
