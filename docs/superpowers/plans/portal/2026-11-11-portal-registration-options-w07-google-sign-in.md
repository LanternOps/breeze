---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W7: Sign in with Google Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customer staff can sign in to the browser portal with a Google Workspace (or Cloud Identity) account. A sign-in lands in an org only when the token's `hd` claim equals a domain that is **currently verified** for exactly that org (W5), and the org's effective policy has Google on. Personal Google accounts never sign in. Accounts are found by Google `sub`, never by email.

**Architecture:**
- **Reuse, not a second copy.** W4's OIDC layer (`services/portalOidc/`) is provider-neutral in its state store and types, but its account resolution, identity link and routes are Entra-shaped. W7 turns the Entra-specific parts of `resolvePortalOidcSignIn` into a **provider adapter** (`PortalOidcSignInProvider`: org resolver, identity key, new-person address rule, session pin). The Entra adapter keeps today's behaviour byte-identical (every existing W4 test passes unchanged), and a Google adapter is added beside it.
- **Org from the verified domain.** The Google adapter resolves the org with W5's `findOrgByVerifiedDomain(hd)`, which re-checks the verification's evidence at use. Any W5 method counts (`dns_txt`, `entra_tenant`, `google_directory`).
- **Policy mask.** `resolvePortalAccessPolicy` masks `googleEnabled` by "the org has at least one currently verified domain", the Google twin of W4's tenant-proof mask (W4 D2). Losing every domain turns Google off on the next request, Google sessions die, and an org on `sso_only` with only Google falls back to `allowed`, so nobody is locked out.
- **Sessions.** A `google` browser session pins the `hd` it signed in with and dies on the next request once that domain is no longer one of the org's verified domains. The W4 absolute cap (`ssoSessionMaxHours`) already applies to method `google`.
- **Routes.** A separate fixed callback `/api/v1/portal/auth/oidc/google/callback`, plus Google start, link and link-status routes, live in a new `routes/portal/oidcGoogle.ts`. The provider-neutral callback steps move from `oidc.ts` to `routes/portal/oidcShared.ts`, which both route files use.
- **One small migration.** `portal_access_requests.google_hosted_domain` records the `hd` of a Google request, so an MSP approval re-checks that the domain is still verified for the org (W4's `ENTRA_TENANT_NOT_PROVEN` twin), and the queue can show it.

**Tech Stack:** Hono, Drizzle (queries only), one hand-written SQL migration, PostgreSQL forced RLS, ioredis (Lua GET+DEL), `jose`, Astro + React (web and portal), Vitest (unit plus `vitest.integration.config.ts`), Playwright MCP for the browser check.

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`. Relevant sections:
- §3: G4, G5 and the anti-goals (wrong org; an SSO sign-in taking over an existing login because an email matched);
- §4: the card's Google row ("hd contoso.example.com ✓ verified") and the first-SSO-sign-in default;
- §5.1 (transition table), §5.2 (identity key; "Google `hd` is a per-sign-in domain assertion… not part of the identity key");
- §5.4 (requirements table: "Sign in with Google — verified domain equal to the `hd` claim");
- §5.5 (the SSO invite email variant), **§5.6 (all of it), §5.8 (all of it)**, §5.10 (audit names), §5.11 (session caps, `sso_only`);
- §6 invariants 1–9 and 11;
- §7 W7 row ("W4 (OIDC layer), W5"), §8 (docs), §10 (left to the builder).

The wave index is `2026-11-08-portal-registration-options-index.md`.

**Builds on (all merged on `main` at `2895af8721`):**
- **W4a #11557 / W4b #11568:**
  - `services/portalOidc/types.ts`: `PortalOidcProvider = 'entra'` (comment: "W7 adds 'google'"), `PortalOidcPurpose`, `PortalOidcState`, `PortalOidcVerifiedIdentity`.
  - `services/portalOidc/stateStore.ts`: `createPortalOidcState`, `consumePortalOidcState`, the binding cookie (`breeze_portal_oidc`, `Path=/api/v1/portal/auth/oidc`, `SameSite=Lax`). Its private `recordShape` refuses any `provider !== 'entra'` and any authority other than `authorityFor(purpose)`.
  - `services/portalOidc/accountResolution.ts`: `resolvePortalOidcSignIn` (spec §5.6 steps 0–5), `PortalOidcDenyReason`, `PortalOidcSignInOutcome`. Entra-specific today: step 0 (`findOrgByProvenEntraTenant`), `entraIssuer`, `findPortalUserIdByEntraIdentity`, `legacyEntraKeyHeld`, `lockAccount().hasEntraIdentity`, `resolveLinkableEntraAddress` (D10 of W4), and the outcome's `entraTenantId`.
  - `services/portalOidc/entraClient.ts`: `buildPortalEntraAuthorizeUrl`, `exchangePortalEntraCode`, `verifyPortalEntraIdToken`, `PortalEntraTokenError` (the template for the Google client).
  - `services/portalUserIdentities.ts`: `PORTAL_GOOGLE_ISSUER = 'https://accounts.google.com'`, `portalUserHasIdentitySql`, `linkPortalUserIdentity` (input `provider: 'entra'` only; the W3 D4 writer fence).
  - `services/portalIdentityAccounts.ts`: `createIdentityOnlyAccount` **already accepts** `{ provider: 'google'; sub }` and writes the identity with `PORTAL_GOOGLE_ISSUER`.
  - `routes/portal/browserSession.ts`: `parseStoredPortalSession` already accepts `method: 'google'` (needs `createdAt`), `isBrowserSessionAllowed` already applies the SSO absolute cap to it, `mintPortalBrowserSession`.
  - `routes/portal/oidc.ts` (726 lines): Entra start, callback, link, link-status, `/auth/methods`, `/auth/invite/methods`; private `startFlow`, `refuse`, `writeOidcAudit`, `finishSignIn`, `parseCallbackQuery`, `consumeInviteForMicrosoft`, `bindingCookieSecure`, `ipRateKey`; `__testOnly.setEntraDeps`.
  - `services/portalSsoOnly.ts`: `resolveInviteSignInMethods(orgId) → { microsoft, password }`, `computeSsoOnlyFlips` (facts `{ entraTenantProven }`), `listSsoOnlyStranded` (any identity counts). `routes/orgPortalUsers.ts` `issueAndSendInvite` (`microsoftUrl = inviteUrl + '&method=microsoft'`) and `POST …/portal-users/sso-invite` (409 `PORTAL_SSO_INVITE_UNAVAILABLE` unless Microsoft is effective). `services/email.ts` `buildPortalInviteTemplate` (`microsoftUrl`, `passwordAllowed`).
  - Portal app: `lib/oidc.ts` (`getSignInMethods`, `getInviteMethods`, `getLinkStatus`, `startMicrosoftSignIn`, `startMicrosoftLink`, `takeStoredNext`, `MICROSOFT_FAILURE_MESSAGE`), `MicrosoftSignInButton.tsx`, `LoginForm.tsx` (`SSO_COPY` banner), `AcceptInviteForm.tsx` (`?method=microsoft`), `ProfileSettings.tsx` (Microsoft account section).
- **W3a #11528 / W3b #11523:**
  - `services/portalAccessPolicy.ts`: `getPortalSignInCapabilities()` returns `google: false` (comment: "`google` (W7) flips its own key"); `pickEffectivePortalAccessPolicy(org, partner, caps, facts: { entraTenantProven })`; `resolvePortalAccessPolicy(orgId)` (no cache); `isSignInMethodAllowed(policy, 'google')`.
  - `services/portalAccessPolicyWrites.ts`: refuses `googleEnabled: true` while `!caps.google` (`METHOD_UNAVAILABLE`); org view already carries `verifiedDomainCount` (W6).
  - `portal_access_requests` (source `google`, `issuer = PORTAL_GOOGLE_ISSUER`, `subject`; `portal_access_requests_claims_chk`), `createPortalAccessRequest({ source: 'google', orgId, email, name, sub })`, and the approve path for `google` (identity-only account via `createIdentityOnlyAccount`).
  - `portal_users.auth_method` CHECK already allows `'google'` (migration `2027-01-22-232800`).
  - Web: `PortalAccessPolicyForm.tsx` renders the `googleEnabled` row only when `capabilities.google`.
- **W5a #11577 / W5b #11576:** `services/portalDomainVerification` read API: `findOrgByVerifiedDomain(domain)`, `isDomainVerifiedForOrg(domain, orgId)`, `listVerifiedDomainsForOrg(orgId)`. System scope; **they throw inside a request transaction** (call with no context held, or through `runOutsideDbContext`). Exact lowercase match, no subdomain match, evidence re-checked at use (W5 D6), at most one org per domain platform-wide.
- **W6a / W6b:** `routes/portal/requestHost.ts` (`requestHost`, `hostOrgIdFor`), `GET /auth/methods` gains `requestAccess`; `PortalAccessRequestsList.tsx` domain badge pattern; `approvePortalAccessRequest`'s `selfDomainVerified` pre-check pattern (route checks outside the transaction, service fails closed).

**Rigor: high.** Auth, OIDC, an account-takeover surface (email collisions), a migration on an org-cascade table, the session gate and the policy resolver. Full TDD, one independent review round per PR, contract and integration suites before each PR. Advisor quorum (independent `codex exec`, xhigh, read-only) on D1–D15: see **Advisor quorum** below.

## PR split

| PR | Tasks | Branch | Body | Depends on |
|---|---|---|---|---|
| **W07a: API** | 1–9 | `feature/11377-portal-registration/wave-11384` | `Part of #11384` (never `Closes`) | W4, W5 merged (they are) |
| **W07b: Web + portal + docs** | 10–13 | `feature/11377-portal-registration/wave-11384-b` | `Closes #11384` | W07a **merged to main**. Branch from fresh main; do not stack, because a stacked PR runs no CI. |

**W07a ships dark.** `getPortalSignInCapabilities().google` becomes `getPortalGoogleConfig() !== null` in Task 2, and no region has `PORTAL_GOOGLE_CLIENT_ID` / `PORTAL_GOOGLE_CLIENT_SECRET` set. So `googleEnabled` is masked off everywhere, the card hides the row, every Google route answers 404, and `/auth/methods` returns `google: false`. W07a tests turn the capability on with `portalAccessPolicy.__testOnly.setCapabilities`. Two changes are visible with the env unset:
- the request list's new `googleHostedDomain` field (null for every row that exists);
- the migration.

**Rollout.** Ops sets the env in each region only after W07b deploys and the lab leg (Task 13 Step 3) passes. That is the same gate as W4.

## Decisions taken in this plan (flag in each PR body)

- **D1: Trusted claims** (spec §5.8, inv. 6). `verifyPortalGoogleIdToken` accepts a token only when all of these hold:
  - `jose` `jwtVerify` against Google's JWKS `https://www.googleapis.com/oauth2/v3/certs` (10 min cache, 30 s cooldown, the W4 options), **RS256 only**;
  - `aud` is a **string** equal to the portal Google client id (an array `aud` is refused, even one containing the id: `jose`'s `audience` option alone would accept it); `azp`, when present, equals the client id too;
  - `iss` is `https://accounts.google.com` or `accounts.google.com` (Google documents both). The identity key always stores the normalized `PORTAL_GOOGLE_ISSUER`;
  - required claims `iss`, `aud`, `exp`, `iat`, `sub`, `nonce`, `email`, `email_verified`, `hd`; `iat` and `exp` are numbers;
  - `nonce` equal in constant time; `iat` no older than 10 min and not more than the 60 s clock tolerance in the future;
  - `sub` is a non-empty string of at most 255 printable ASCII characters, compared and stored case-sensitively and never normalized;
  - `email_verified === true` (strict boolean; the string `"true"` is refused);
  - `hd` is a non-empty string; it is lowercased and must be a syntactically valid domain (the `customerDomainSchema` rule). **No `hd` → refused.** This is what refuses personal Gmail accounts and "consumer" Google accounts created on a company address outside any Workspace: neither carries `hd`.
  - Rejected: trusting `email` + `email_verified` without `hd` (Google is authoritative for an address only when the account is managed; a consumer account on `pat@contoso.example.com` would otherwise reach Contoso's org). Rejected: keying on `email` (spec §5.2, inv. 5).
- **D2: The org comes from `hd` and nothing else** (spec §5.6 host binding, §5.8, inv. 1–2).
  - Step 0 for Google: `findOrgByVerifiedDomain(hd)` → null ⇒ `org_unresolved`. Then the W4 host binding (`hostOrgId` set and ≠ the org ⇒ `host_mismatch`), `getActiveOrgTenant` (which also requires the owning **partner** to be active), and `isSignInMethodAllowed(policy, 'google')`.
  - The email's domain, the authorize request's `hd` hint and any query parameter never choose an org.
  - "Evidence re-checked at use" means W5's structural and freshness check (W5 D6: the row is verified, active, passed within 7 days, and its tenant proof or Google connection is still the one it was verified through). It is **not** a live DNS or Directory lookup per sign-in; the W5 worker owns those.
  - Any W5 method counts. A DNS-verified domain proves the `hd` as well as a directory-verified one (W5 "W7 consumption"). Rejected: requiring the `google_directory` method, which would make Google sign-in impossible for a customer whose MSP has no Workspace connection.
  - **Residual, accepted and documented (OD5):** `hd` proves which Workspace Google currently places the domain in, not continuity with the Workspace the customer had when the MSP verified the domain. If a domain moves to a different Workspace (a new controller) while Breeze still holds A's verification (a TXT record left in place keeps passing; W5's freshness window is 7 days), that Workspace's users reach org A under A's new-person mode. The ID token carries no Workspace customer id to pin. The MSP docs say so and tell MSPs to prefer `approval` mode and to remove verifications when a customer leaves.
  - The authorize URL sends `hd=*` (Google's "any managed account" account-chooser hint). It is a UI hint only; D1 is the check.
- **D3: The address rule for a Google person** (W4 D10's twin).
  - The account or request address is the `email` claim, lowercased (D1 already requires `email_verified === true`).
  - The "account already exists" refusal (§5.6 step 4) matches that address. **Nothing ever links by email** (inv. 5).
  - The contact link is attempted only when the email's domain equals `hd`, or `isDomainVerifiedForOrg(emailDomain, orgId)`. Otherwise the account is created with `contactId = null`. The rule applies to **both** Google account writers: instant mode, and the MSP approval of a `google` request (today the approval passes `contactAddress: request.email` unconditionally, which would bypass the rule and expose the matched contact's ticket history). The approval route computes it outside the transaction and passes `googleContactAllowed` in (Task 8). Rejected: W4's `resolveLinkableEntraAddress`, which accepts a merely **declared** `customer_email_domains` row (W5 OD6 kept that for Entra contact linking only); W7 adds no new consumer of declared rows (spec §5.4 "mail routing only").
  - An email domain that differs from `hd` (a user whose primary address is on a secondary domain of the same Workspace) **may** sign in: the org came from `hd`, and Google is authoritative for the address. See OD2.
- **D4: One resolver, two adapters.** `resolvePortalOidcSignIn` keeps its exported name and step order; its input identity widens to `PortalOidcVerifiedIdentity` and it dispatches on `identity.provider` to a `PortalOidcSignInProvider` adapter (Task 5 Interfaces).
  - The Entra adapter is a move of today's code, not a rewrite. Every W4 unit and integration test passes **unchanged** (the gate in Task 5 Step 4).
  - Google differences live only in the adapter, which the resolver selects server-side from the verified identity's `provider` (never from request input): org resolver (D2), identity key (`PORTAL_GOOGLE_ISSUER`, `sub`) used for lookup **and** `last_used_at` touch, the per-provider "already has an identity of this provider" check in `lockAccount`, address rule (D3), access-request input, session pin (D7), the proof fence (D15), and no legacy-key pre-check (Google has no `portal_users` legacy columns).
  - **Step 5 still applies to Google.** No writer creates a `google` identity on a `browser_access='none'` account today (there is no Google add-in), but a known Google identity is never given a session without `browser_access='granted'`: a `none` account follows step 5 exactly as Entra does.
  - Linking Google never touches an existing Entra identity or the `portal_users.entra_*` legacy columns.
  - Old tests passing is necessary, not sufficient: Task 5 adds mixed-provider tests (an account with both identities; each provider's lookup ignoring the other's identity).
  - Rejected: a second `googleAccountResolution.ts`. The resolution order is the security core of SSO (inv. 4, 5); two copies would drift.
- **D5: Identity writes.**
  - `linkPortalUserIdentity` input becomes a union: `{ provider: 'entra'; tid; oid }` (unchanged behaviour, including the legacy-key pre-check and the W3 D4 `entra_*` fence) or `{ provider: 'google'; sub }` (no legacy columns; it still clears `password_hash` when asked and still refuses a login outside `orgId`).
  - New reader `findPortalUserIdByIdentity(exec, { provider, issuer, subject })`. `findPortalUserIdByEntraIdentity` stays as a thin wrapper (the add-in exchange uses it).
  - One account may hold one Entra and one Google identity (`unique (portal_user_id, provider)`, spec §5.2). A second Google identity on the same account is a `conflict`.
- **D6: Policy mask by verified domain** (W4 D2's twin; spec §4 "sso_only valid only while the effective policy has an SSO method on").
  - `PortalPolicyOrgFacts` gains `googleDomainVerified: boolean`; `googleEnabled = picked && caps.google && facts.googleDomainVerified`, before W3's `sso_only` fallback.
  - `resolvePortalAccessPolicy` reads `listVerifiedDomainsForOrg(orgId)` **only when** the picked `googleEnabled` is true and `caps.google` is true. Every other org pays nothing. With no context held, or a held **system** context, it calls the read API directly; under a held request context it calls it through `runOutsideDbContext` (the W6 `countVerifiedDomains` precedent in `portalAccessPolicyWrites.ts`).
  - `ResolvedPortalAccessPolicy` gains `googleDomains: string[] | null` (lowercase, sorted; null when not read). The fingerprint is unchanged in shape: `effective.googleEnabled` already changes when the mask flips.
  - Org write: `patch.googleEnabled === true` while the org has no verified domain ⇒ 400 `PORTAL_ACCESS_POLICY_GOOGLE_DOMAIN_NOT_VERIFIED` (field `googleEnabled`), W4's `TENANT_NOT_PROVEN` parity. Partner writes and partner views pass `{ googleDomainVerified: true }`: the partner default means "on wherever a domain is verified".
  - **Every** caller of `pickEffectivePortalAccessPolicy` passes the fact: the resolver, the org settings view and write validation (`portalAccessPolicyWrites.ts` `factsFor`, using the existing `countVerifiedDomains`), the partner impact preview, and `computeSsoOnlyFlips` (one `listVerifiedDomainsForOrg` per org whose picked Google is on, outside the request transaction, before the impact digest is computed), so the hash-clearing decision and the preview agree with what sign-in will do.
  - **Fail closed.** A W5 read that throws propagates (the session middleware then fails the request, the settings route answers 500); it is never turned into an empty list, which would silently mask Google off and re-allow passwords.
  - Rejected: no mask, refusing only at sign-in. An org on `sso_only` with only Google would refuse every sign-in method when its domain lapses.
  - **What the fallback does not do.** Re-allowing passwords helps only accounts that still have one. Identity-only accounts, and accounts whose hash `sso_only` cleared, stay unable to sign in until the domain is verified again or the MSP re-invites them. The MSP docs (Task 12) state this recovery path; the card's existing `passwordModeFallback` notice names the cause.
- **D7: Google sessions pin `hd`.**
  - `mintPortalBrowserSession` gains `googleHostedDomain?: string`, required for, and only for, `method: 'google'`. The stored payload gains `googleHostedDomain` (after `createdAt`, so the pre-W7 byte layout of password and entra payloads is unchanged).
  - `parseStoredPortalSession`: a `google` payload needs a parseable `createdAt` **and** a valid lowercase domain in `googleHostedDomain`, else null.
  - `isBrowserSessionAllowed`: a `google` session additionally needs `policy.googleDomains?.includes(session.googleHostedDomain)`. The session middleware already resolves the policy per request with no context held (`auth.ts:399`), so the domain list is read there at no extra round trip beyond D6's.
  - Effect: removing, displacing or lapsing the domain (W5) ends every Google session for it on the next request; turning Google off, or the policy cap, does too (W4 D9).
- **D8: Google requests record their `hd`** (the one migration).
  - New nullable column `portal_access_requests.google_hosted_domain text`, CHECK `(source = 'google') = (google_hosted_domain IS NOT NULL)` and `google_hosted_domain = lower(btrim(google_hosted_domain))`. Added `NOT VALID`, then validated in the same file only when no row violates it (no `google` row can exist on main: nothing produces one while `caps.google` is false).
  - `createPortalAccessRequest`'s google input gains `hostedDomain`.
  - **Approval is fenced, not only pre-checked** (quorum G8). A pre-check alone races a W5 transfer: check passes → the domain is displaced to org B → the approval creates the globally unique `(issuer, sub)` identity in org A → that person's later sign-in resolves org B and is denied `identity_other_org`. So, mirroring W4's `lockProvenEntraTenant` (`FOR SHARE` held through commit):
    1. **Outside** the request transaction the route calls `findOrgByVerifiedDomain(hostedDomain)` (full W5 semantics, no network) and passes `googleDomain: { verifiedAt } | null` in (null when the fact is missing or names another org).
    2. **Inside** `approvePortalAccessRequest`'s transaction, before any write, `lockVerifiedGoogleDomain(request)` selects the org's `customer_email_domains` row `WHERE org_id = $org AND lower(domain) = $hd AND verified_at = $verifiedAt AND is_active FOR SHARE`. No row → 409 `PORTAL_ACCESS_REQUEST_GOOGLE_DOMAIN_NOT_VERIFIED`. W5's transfer, clear and repoint writers take `FOR UPDATE` on that row, so they wait for the approval to commit, or the approval sees their change and refuses.
    3. A `google` request with a null `google_hosted_domain` (none can exist; see the migration) fails closed with the same 409.
  - The list gains `googleHostedDomain` and `domainVerified` for `google` rows too.
  - Export policy: `google_hosted_domain` is `included` (plain text, like `entra_tenant_id`). Cascade, merge (repoint) and RLS registrations already cover the table.
  - Rejected alternative (recorded for the quorum): no column and no approval re-check. Safe for org placement (every sign-in re-resolves the org by `hd`, so a stale approval only creates an account that cannot sign in), but the MSP would approve requests with no way to see which Workspace they came from, and W4 refuses the Entra equivalent.
- **D9: A conflicting pending request is refused, never overwritten by email** (quorum omission 1). Today a re-request at an address with a pending row only bumps `last_requested_at` and keeps the first row's source and claims (W3), so a provider switch or a recycled mailbox would read "request sent" while a **different** identity sits in the queue.
  - When the incoming create is SSO (`entra` or `google`) and the pending row's `(source, issuer, subject)` differ, `createPortalAccessRequest` returns a new outcome `{ kind: 'claims_conflict'; requestId }` and writes nothing. The resolver maps it to a new deny reason `request_conflict` (generic `unavailable` in the portal; the audit row names the reason). The MSP sees the pending request and denies it; the person then signs in again.
  - Same `(source, issuer, subject)` with a different `google_hosted_domain` (the same Google user, now asserting a different domain of the same org) refreshes `google_hosted_domain` with the bump: it is the same identity's newest assertion.
  - A `self` or `addin_user` create keeps the W3 bump behaviour unchanged (W6 and the add-in exchange are not touched).
  - This changes W3 semantics for Entra re-requests too. The change is deliberate and pinned by a new Entra test; it is the one place D4's "Entra byte-identical" does not hold.
  - Rejected: replacing claims with the newest (the quorum's point: an email match must never decide which identity is queued) and silently keeping the old claims (today's behaviour).
- **D10: Routes and the callback.**
  - Fixed URIs: `{base}/api/v1/portal/auth/oidc/google/callback` (the only Google redirect URI). `base` = `PORTAL_GOOGLE_CALLBACK_BASE_URL`, else the W4 fallback chain (`PUBLIC_URL || PUBLIC_APP_URL || PUBLIC_API_URL`).
  - New `routes/portal/oidcGoogle.ts`: `POST /auth/oidc/google/start` (`login` | `invite`), `POST /auth/oidc/google/link/start` (session + CSRF), `GET /auth/oidc/google/link-status`, `GET /auth/oidc/google/callback`.
  - The provider-neutral callback machinery moves from `oidc.ts` to `routes/portal/oidcShared.ts` unchanged in behaviour: strict query parse, state consume, `refuse`, `writeOidcAudit`, `finishSignIn`, invite consumer, `bindingCookieSecure`, `ipRateKey`, the start/callback rate limits (one IP bucket shared by both providers, so switching providers buys no extra attempts).
  - **Provider check before the code exchange.** Each callback consumes the state and refuses (`state_invalid`) when `state.provider` is not its own provider, before any token request. This adds one check to the Entra callback (a Google state presented there is refused); the state store also refuses a Google state with a `tenant_proof` purpose.
  - **Google's own query parser.** Google's redirect carries `code`, `state` and also `scope`, `authuser`, `hd`, `prompt` (and may carry `iss`). W4's strict Entra parser would refuse them. `parseGoogleCallbackQuery` requires exactly one `code` and one `state` (or one `error`), refuses any duplicated `code`, `state`, `error` or `iss`, refuses an `iss` other than Google's, and **ignores** every other parameter (its `hd` is never read; D2).
  - Same binding cookie name and path for both providers. A browser runs one SSO flow at a time; starting a second flow overwrites the first flow's binding, and the first callback then reads `unavailable`. That first callback's unconditional cookie clear also removes the second flow's binding, so the second flow fails too and the person starts again. Documented trap, not a defect: the alternative (per-provider cookie names) still loses a same-provider double start, and the binding must stay single-use.
  - **Custom portal domains** keep W4 D5's limit: the callback is on the fixed callback origin, and the binding cookie is host-only, so a flow started on a custom portal domain whose host differs from the callback origin cannot complete. Google sign-in on custom domains waits for the same cross-host handoff W4 deferred. The host binding (`hostOrgId`) is still recorded and enforced, so the limit fails closed.
  - `GET /auth/methods` gains `google`: shared host `caps.google` (a constant); verified custom domain: `getPortalGoogleConfig() !== null && isSignInMethodAllowed(policy, 'google')`. `POST /auth/invite/methods` gains `google` the same way; an invite is unusable only when `password`, `microsoft` and `google` are all false.
  - Redirect result codes are W4's (`/login?sso=…`, `/profile?sso=…`) plus a fixed `&p=google` for Google flows, so the portal picks provider-specific copy. The Entra callback is unchanged (no `p` ⇒ Microsoft). Deny reasons go to the audit row and the log only (W4 D15).
  - Rejected: one parameterized `/auth/oidc/:provider/callback`. Each IdP registers its exact redirect URI, and W4's Entra paths are already registered by self-hosters; keeping them literal avoids a re-registration.
- **D11: Config and capability.** `config/portalGoogle.ts` → `getPortalGoogleConfig(): PortalGoogleConfig | null` (null unless both `PORTAL_GOOGLE_CLIENT_ID` and `PORTAL_GOOGLE_CLIENT_SECRET` are non-empty; the client id must end in `.apps.googleusercontent.com`; a malformed base URL throws, validated at boot by `config/validate.ts`). `getPortalSignInCapabilities().google = getPortalGoogleConfig() !== null`. Secret: env only, never logged; token-endpoint bodies are never logged (W4 D14).
- **D12: Invites and `sso_only` cover Google.**
  - `resolveInviteSignInMethods(orgId)` returns `{ microsoft, google, password }`. `issueAndSendInvite` passes `googleUrl = inviteUrl + '&method=google'` when Google is effective.
  - `buildPortalInviteTemplate`: with both SSO methods effective, two primary buttons ("Sign in with Microsoft", "Sign in with Google"); with one, that one; the password button stays secondary, and is omitted when `passwordAllowed` is false (W4 rule). The subject is unchanged.
  - `POST …/portal-users/sso-invite` refuses with `PORTAL_SSO_INVITE_UNAVAILABLE` only when **neither** Microsoft nor Google is effective. The stranded definition (no identity of any provider) is unchanged.
  - Accept-invite (`?method=google`), the Google invite start and the invite consumer reuse W4's invitation-bound flow (`peekPortalCapabilityToken` + `validatePortalCapability(…, { requirePasswordMethod: false })`).
- **D13: Account-takeover rules restated for Google** (spec §3 anti-goal, inv. 5). An existing account at the Google address is **never** linked by a Google sign-in. The only ways a Google identity reaches an existing account: (a) an invite-bound state (the invite is the continuity proof; the invited account must have no Google identity), (b) a signed-in session's link state (same org, same epoch, no Google identity yet), (c) an MSP approval of a Google request, which creates a **new** account and refuses when any account exists at the address (`ACCOUNT_EXISTS`). An identity already bound elsewhere than an invite/link target names is denied (`identity_conflict`) without consuming the invite (W4 D11).
- **D14: Audit and copy.** Audit actions are W4's (`portal.auth.oidc.login`, `portal.auth.identity.link`) with `details.provider: 'google'`; approval and deny are W3's. Portal copy (English literals, the portal has no i18n): `unavailable` with `p=google` → "Google sign-in isn't set up for this account here."; `account_exists` with `p=google` → "You already have an account. Sign in with your password and connect Google, or ask your IT provider to re-invite you."; `request_sent` is the W4 copy.
- **D15: Google write branches hold the domain row for the transaction** (quorum G8, applied to sign-in). The same race as the approval exists inside sign-in: step 0 reads `findOrgByVerifiedDomain(hd)` with no lock, then instant mode creates an account and identity, or an invite/link writes an identity, in that org. Every Google write branch (`instant` create, `invite` activation, `link`, and the step-1 `sso_instant_grant`) therefore first runs the adapter's `fenceProof(r)` inside its `inWriteTransaction`: the same `FOR SHARE` select as D8 on the org's `customer_email_domains` row for `hd` with the `verifiedAt` that step 0 observed. No row → `ResolutionRefusal('org_unresolved')`, rolling back the branch. The Entra adapter's `fenceProof` is a no-op, keeping W4 byte-identical: a tenant transfer is serialized by W4's own proof transaction (advisory lock, then an epoch bump of the displaced org's tenant identities). Read-only branches (a known identity's plain session) need no fence: D7's per-request session check covers them.

## Advisor quorum

An independent `codex exec` (gpt-6-astra, `model_reasoning_effort="xhigh"`, `-s read-only`, prompt on stdin) reviewed the draft decisions (claims, org resolution, address rule, linking, adapter, mask, session pin, request column, routes, domain-authority trust) against the spec, the W4/W5 plans and the landed code, on 2026-11-11.

| Draft decision | Verdict | Resolution in this plan |
|---|---|---|
| Trusted claims (D1) | AGREE, with additions | Added: `aud` must be a string (an array is refused), numeric `iat`/`exp`, `iat` not in the future beyond skew, `sub` case-sensitive and not assumed numeric. |
| Org from `hd` (D2) | AGREE | Added: the partner must be active (`getActiveOrgTenant` already checks it); "evidence at use" is W5's structural + freshness check, not a live lookup. |
| Address rule (D3) | AGREE, with one gap | The contact rule now applies to the MSP approval path too, not only instant mode (the approval passed `request.email` unconditionally). |
| Linking (D4/D13) | AGREE | Added: a known Google identity on a `browser_access='none'` account follows step 5; linking Google leaves Entra identities and legacy columns intact. |
| One resolver, adapters (D4) | AGREE | Adapter now also owns identity touch, the per-provider presence check and request creation; mixed-provider tests added. |
| Policy mask (D6) | AGREE, with corrections | The fact is passed to **every** picker caller; a W5 read failure propagates (fail closed); the "no lockout" claim is narrowed to accounts that still hold a password, with the recovery path documented. |
| Session pin (D7) | AGREE | Tests added for a missing pin in both stores and for one domain removed while another stays verified. |
| Request column + approval re-check (D8) | **DISAGREE** (pre-check alone races a domain transfer) | **Resolved by adopting the quorum's fix**: the pre-check's `verifiedAt` is re-validated under `FOR SHARE` on the domain row inside the approval transaction (D8), and the same fence guards every Google sign-in write branch (D15). |
| Routes, cookie, `p=google` (D10) | AGREE, with additions | Added: provider check before the code exchange in both callbacks; a Google-specific query parser (Google sends `scope`, `authuser`, `hd`, `prompt`); the cookie-clear side effect and the custom-domain limit are documented. |
| DNS-verified domains prove `hd` (D2) | AGREE as an explicit trust decision | Recorded as an accepted residual (D2) and OD5. |
| Omission: conflicting pending requests | Adopted | D9: refuse an SSO request whose pending row at the address holds a different identity; never replace claims by email. |
| Omission: custom-host boundary | Adopted | D10 states W4 D5's limit for Google. |
| Omission: migration coverage | Adopted | Task 1 does not infer `hd` for any existing row; approval of a `google` row with no `hd` fails closed (D8). |

No disagreement is left open.

## Open decisions for the operator

- **OD1: Who owns the hosted Google OAuth client and its consent screen.** Hosted Breeze needs one Google Cloud project with an OAuth "web application" client, an **External** consent screen in **production** publishing status (otherwise only listed test users can sign in), and Google's brand verification (app name, logo, home page, privacy policy, authorized domains). The spec says "a new Google OAuth web client per deployment" but not whose project it lives in or who submits brand verification. Options:
  - (a) A LanternOps-owned project per region, with brand verification submitted before rollout. Recommended: it mirrors W4's "hosted uses LanternOps' registration", and the customer-facing consent screen then names the product, not an individual's project.
  - (b) One project shared by every region (fewer verifications; one blast radius for a revoked client).
  - (c) Ship without brand verification. Sign-in still works for `openid email profile` (non-sensitive scopes), but users see a less trusted consent screen.
  - **Recommend (a).**
- **OD2: Users whose email domain differs from `hd`** (D3). With no precedent in the spec. Options:
  - (a) Allow sign-in; the org comes from `hd`; link a contact only when the email's domain is `hd` or verified for the same org. Recommended: a Workspace user's primary address can sit on a secondary domain of the same Workspace, and Google is authoritative for it.
  - (b) Refuse unless `emailDomain === hd`. Simpler to explain, but locks out secondary-domain users, and the live check (owed check 2) may show `hd` is always the primary domain, which would lock out every such user.
  - **Recommend (a).**
- **OD3: Customer-side scoping guidance.** Entra has *Assignment required*. Google's equivalent is the Workspace admin's **API controls → App access control**: mark the Breeze Portal client as *Trusted* or *Limited*, optionally per organizational unit, and decide whether sign-in-only apps are allowed when third-party access is restricted. Whether the customer docs recommend *Trusted for selected OUs only* (narrower, more admin work) or *Allowed for everyone* (simpler) is a product call. **Recommend** documenting both, leading with OU-scoped *Trusted* for orgs that turn on `instant` mode, and plain *Allowed* for `approval` mode, where the MSP queue is the gate.
- **OD4: Session cap shared by Microsoft and Google.** The spec has one `sso_session_max_hours`; W7 applies it to Google unchanged. A separate Google cap is not proposed. Listed only so the operator can object. **Recommend** keeping one setting.
- **OD5: The domain-authority residual** (D2). A domain that moves to a different Google Workspace while Breeze still holds the old customer's verification lets the new Workspace's users reach the old org under its new-person mode. Options:
  - (a) Accept and document: MSP docs recommend `approval` mode for Google, and removing verifications (and asking the customer to delete the TXT record) when a customer leaves. Recommended: the ID token carries no Workspace customer id to pin, and `approval` mode already puts an MSP decision in front of every new person.
  - (b) Allow `instant` for Google only when the matched domain was verified through `google_directory` (the org's own Workspace connection listed it within the last day), so a TXT record left behind cannot admit strangers instantly. Narrower, but it needs a W5 read-API change (`method` is already in `VerifiedDomainFact`) and makes `instant` unavailable to MSPs without a Workspace connection.
  - (c) Shorten W5's 7-day freshness window for DNS-verified domains used by Google sign-in.
  - **Recommend (a)** now, with (b) as a follow-up if an MSP asks for `instant` mode at scale.

## Settings rule 9 statement (copy into both PR bodies)

- **No new setting concept.** `googleEnabled`, `ssoNewPersonMode`, `ssoSessionMaxHours` and `passwordMode` already exist (W3); W7 makes `googleEnabled` live and masks it by verified domain (D6).
- **Home:** unchanged: org settings › Portal › Sign-in & registration (org); partner settings › Customer portal (partner default).
- **Level:** partner default → org override.
- **Resolver:** `resolvePortalAccessPolicy(orgId)`.
- **Places configured:** before 2, after 2. Verified domains are evidence about the org (home: Organization › Domains, W5), shown read-only in the Google row, never inherited.
- **Not settings:** the Google OAuth client credentials (deployment env).
- **Nav:** no new settings page; `settingsPageRegistry.test.ts` passes unchanged.

## Global Constraints

- **Google issuer** for every stored identity and request is exactly `PORTAL_GOOGLE_ISSUER` (`https://accounts.google.com`); the subject is the `sub` claim. `portal_access_requests_claims_chk` already pins the issuer.
- **id_token checks:** D1, exactly. The JWKS URL and the token endpoint are constants in `services/portalOidc/googleClient.ts`; tests inject the key and `fetch`.
- **Authorize request:** `https://accounts.google.com/o/oauth2/v2/auth`, `response_type=code`, `scope=openid email profile`, `prompt=select_account`, `hd=*`, `access_type=online`, PKCE S256 (`generatePKCEChallenge`), state and nonce 32 random bytes base64url (the W4 state store), `redirect_uri` = the fixed callback.
- **Token request:** `POST https://oauth2.googleapis.com/token`, form-encoded, `client_secret` in the body, `code_verifier`. Any non-2xx or a body without `id_token` throws `PortalGoogleTokenError('token_endpoint')`; log the status only.
- **State:** the W4 store, unchanged TTL (600 s) and cookie. `authorityFor` returns `PORTAL_GOOGLE_ISSUER` for a Google state; a Google state with any purpose other than `login`, `invite` or `link` is refused (no tenant proof for Google).
- **Rate limits:** W4's per-IP `start` (20 / 5 min) and `callback` (30 / 5 min) buckets, shared across providers; the invite-methods peek keeps the accept-invite buckets.
- **Portal result codes**, the only redirects the Google callback produces: `/login?sso=signed_in|request_sent|account_exists|unavailable&p=google`, `/profile?sso=linked|unavailable&p=google`.
- **Error codes** (UPPER_SNAKE): `PORTAL_ACCESS_POLICY_GOOGLE_DOMAIN_NOT_VERIFIED` (shared `PORTAL_ACCESS_POLICY_ERROR_CODES`, 400), `PORTAL_ACCESS_REQUEST_GOOGLE_DOMAIN_NOT_VERIFIED` (409, copy: "This request's Google Workspace domain is no longer verified for this organization. Verify it again or invite the person directly.").
- **Secrets:** env only. `.env.example` gets blank `PORTAL_GOOGLE_CLIENT_ID`, `PORTAL_GOOGLE_CLIENT_SECRET`, `PORTAL_GOOGLE_CALLBACK_BASE_URL` with one generic comment line. Pass them through in `docker-compose.yml` and `deploy/docker-compose.prod.yml` next to the `PORTAL_ENTRA_*` lines. No secret, code, token or token-endpoint body is logged or audited.
- **Migration:** `apps/api/migrations/2027-01-24-130000-portal-access-requests-google-hosted-domain.sql`. The slot was assigned in the `13xxxx` block of `2027-01-24`; the file must sort after the newest file on `origin/main` (today `2027-01-24-110000-wisp-check-ins-cancelled-by.sql`). Idempotent, no inner `BEGIN;`/`COMMIT;`, first statement `SELECT set_config('breeze.scope', 'system', true);`, then `pnpm db:check-drift`. Never rename a shipped migration.
- **Context rules:** the callback holds no DB context; W5 read API calls run with none held or through `runOutsideDbContext`; a route that catches a refusal around a query keeps the query inside the service's `withDbTransaction`, catch outside; never `Promise.all` siblings that open transactions.
- **Tests:** addresses use `example.com`, `*.example.com` or `.test` only (`scripts/security/check-customer-pii.sh`); no test reaches Google (inject `fetch` and the `jose` key, mock the W5 read API in unit tests and seed verified rows by SQL in integration tests).
- **Web:** mutations through `runAction`; new locale keys in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); dynamic keys via a static `Record` + `/* i18n-dynamic */`; tests select by `data-testid`. The portal app has no i18n.
- **CPU budget:** Vitest with `--pool=forks --poolOptions.forks.maxForks=4` on touched files, `--changed origin/main` for the sweep; one `tsc` at a time with `NODE_OPTIONS=--max-old-space-size=20480`, check `echo "exit=$?"`, never `| tail`; no background CI pollers.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Numbering: "Review Focus n" (RFn in test comments) is this list. "Feature RFn" is the index's feature-wide list.

1. **An email that already has an account** (spec anti-goal "an SSO sign-in takes over an existing login because an email matched"; feature RF1). `pat@contoso.example.com` has a password account in org A; `contoso.example.com` is verified for A with Google on. A Google sign-in by `pat` with no invite or link state. Expected: `account_exists`, no identity row, the password account untouched, and the portal shows the "connect Google" copy. The same address in org B (another partner) has no effect on A. *(Task 5: `google new person with an existing same-email account → account_exists, no link`; `an account at the same address in another org does not block`. Task 7 integration: `end-to-end account_exists leaves the password account unchanged`.)*
2. **A token Google is not authoritative for.** A personal Gmail token, a consumer account on a company address (no `hd`), `email_verified: false`, `email_verified: "true"`, an `hd` for an unverified or merely declared domain, an `hd` verified for another org, and a token with an `azp` for another client. Expected: each refused, `unavailable`, nothing written. *(Task 3: the `verify refuses` table. Task 5: `hd verified for org B never signs into org A`, `declared-only hd → org_unresolved`.)*
3. **The domain changes state while sessions and requests are outstanding** (feature RF2). Expected: the domain's verification lapses, is removed, is displaced to another org, or its row is set inactive ⇒ on the next request the Google session gets 401; a new sign-in is `org_unresolved`; an org on `sso_only` with only Google falls back to `allowed`; approving a pending Google request for that `hd` is refused with 409 and the list shows the domain unverified. A second verified domain in the same org keeps sessions for that other `hd` alive. *(Task 2: `googleEnabled is masked off when the org has no verified domain`, `sso_only falls back to allowed when the last domain lapses`. Task 6: `google session dies when its hd is no longer verified for the org`, `a session for another still-verified hd survives`. Task 8: `approve refuses a google request whose hd is no longer verified`.)*
4. **Invite and link continuity across providers.** An invited account accepts through Google; an Entra-linked account links Google from its profile; an account already linked to Google tries to link a second Google account; an invite whose account already has a Google identity. Expected: the first two link and keep the Entra identity; the third and fourth are `identity_conflict` / `invite_invalid` without consuming the invite (W4 D11). *(Task 5 integration: `invite via Google activates and links linked_via invite`, `an entra-linked account links google; both identities remain`, `second google identity on one account → identity_conflict`, `invite for an account that already has a google identity → invite_invalid, invite not consumed`.)*
5. **Entra regressions from the refactor** (D4). Expected: every W4 unit and integration test passes unchanged; an Entra sign-in still mints a session with `entraTenantId` and no `googleHostedDomain`; the Entra callback URI and redirect codes are byte-identical. *(Task 5 Step 4 gate; Task 7: `entra callback redirects are unchanged (no p parameter)`.)*

Invariants re-run as named tests:
- **1:** Task 7 `custom-domain host for org A + hd verified for org B → unavailable (host_mismatch)`.
- **2:** Task 5 `declared-only hd → org_unresolved`; Task 3 `the authorize hd hint is never read back`.
- **3:** Review Focus 3.
- **4:** Task 5 `google identity in org A whose hd is now verified for org B → identity_other_org`.
- **5:** Review Focus 1 and 4.
- **6:** Task 7 `google callback replay → unavailable`, `google callback from another browser → unavailable`.
- **7:** Task 7 `google invite start with an invalid token → 400 Invalid or expired invite`.
- **8:** Task 7 `/auth/methods on the shared host returns a constant google flag`.
- **9:** Task 6 `a google session never satisfies a password-only or entra-only policy`.
- **11:** Task 8 `sso_only with only Google on: stranded accounts are those with no identity; Google-linked accounts lose their hash`.

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| Create `apps/api/migrations/2027-01-24-130000-portal-access-requests-google-hosted-domain.sql`; modify `apps/api/src/db/schema/portalAccess*.ts` (the file that defines `portalAccessRequests`), `services/tenantExportPolicyRegistry.ts` | `google_hosted_domain` column + CHECK, export classification | a |
| Create `config/portalGoogle.ts` (+ test); modify `config/validate.ts`, `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` | Google OAuth client config | a |
| Modify `services/portalAccessPolicy.ts`, `services/portalAccessPolicyWrites.ts`, `services/portalSsoOnly.ts` (`computeSsoOnlyFlips` facts), `packages/shared/src/validators/portalAccessPolicy.ts` (+ tests) | Capability flip, verified-domain mask, `googleDomains`, write refusal | a |
| Create `services/portalOidc/googleClient.ts` (+ test); modify `services/portalOidc/types.ts`, `services/portalOidc/stateStore.ts` (+ test) | Google authorize/exchange/verify; `'google'` provider in state | a |
| Modify `services/portalUserIdentities.ts` (+ test), `services/portalAccessRequests.ts` (+ test), `services/portalDomainVerification/{service,index}.ts` (+ test) | Google link branch, generic identity reader, request `hostedDomain`, D9 conflict, D8 approval fence (`lockVerifiedDomainRow`) | a |
| Create `services/portalOidc/signInProviders.ts` (+ test); modify `services/portalOidc/accountResolution.ts` (+ test) | Provider adapters; resolver dispatch | a |
| Modify `routes/portal/browserSession.ts` (+ test), `routes/portal/schemas.ts` (`PortalSession.googleHostedDomain`), `routes/portal/auth.ts` (only if the middleware call site needs the new field) | Google session pin | a |
| Create `routes/portal/oidcShared.ts`, `routes/portal/oidcGoogle.ts` (+ `oidcGoogle.test.ts`); modify `routes/portal/oidc.ts`, `routes/portal/index.ts` | Google routes, shared callback core, discovery | a |
| Modify `routes/orgPortalAccessRequests.ts` (+ test), `services/portalSsoOnly.ts` (`resolveInviteSignInMethods`), `routes/orgPortalUsers.ts` (+ test), `services/email.ts` (+ golden test) | Approval re-check, list fields, invite email and `sso-invite` with Google | a |
| Create `__tests__/integration/portalGoogleSignIn.integration.test.ts`, `portalGoogleRequestMigration.integration.test.ts`; append to `portalSessionCaps`, `portalAccessRequests`, `portalSsoOnly` integration files | Real-DB proofs (all matched by the `portal[!a-z0-9]*` glob) | a |
| Modify `apps/web/src/components/settings/portalAccess/{PortalAccessPolicyForm,OrgSignInRegistrationCard,PortalAccessRequestsList,StrandedAccountsList,SsoOnlyConfirmDialog}.tsx`, `types.ts`, `ssoOnlyActions.ts` (+ tests); create `portalAccess/GoogleDomainsStatus.tsx` (+ test); locale keys | MSP UI | b |
| Create `apps/portal/src/components/portal/GoogleSignInButton.tsx` (+ test); modify `apps/portal/src/lib/oidc.ts`, `LoginForm.tsx`, `AcceptInviteForm.tsx`, `ProfileSettings.tsx` (+ tests) | Portal UI | b |
| Create `apps/docs/src/content/docs/features/portal-google-sign-in.mdx`; modify `features/portal.mdx`, `features/portal-domain-verification.mdx`, `deploy/environment.mdx`, `apps/docs/astro.config.mjs`; regenerate `apps/api/src/data/docsIndex.json` | Docs | b |

---

## W07a — API

Test commands:
- Unit: from `apps/api`, `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. Never `pnpm --filter <pkg> test -- --run <path>`.
- Integration: `pnpm test-stack up`, then `npx vitest run -c vitest.integration.config.ts <file>`. Tear down with `pnpm test-stack down` and say so.

### Task 1: Migration, Drizzle column, export classification

**Files:**
- Create: `apps/api/migrations/2027-01-24-130000-portal-access-requests-google-hosted-domain.sql`.
- Modify: the Drizzle `portalAccessRequests` table (add `googleHostedDomain: text('google_hosted_domain')`).
- Modify: `services/tenantExportPolicyRegistry.ts:787`, adding `google_hosted_domain` to `included`.
- Test: `__tests__/integration/portalGoogleRequestMigration.integration.test.ts` (template: `portalAccessPolicyMigration.integration.test.ts`, replay inside a rolled-back superuser transaction). Extend the existing export-registry unit test for `portal_access_requests` if one pins its columns; otherwise create `services/tenantExportPolicyRegistry.portalGoogleRequest.test.ts` (the W2/W4 pattern that moves the failure into Test API).

- [ ] **Step 1: Write the failing tests**

```ts
describe('2027-01-24-130000-portal-access-requests-google-hosted-domain.sql', () => {
  it('starts with the system-scope line');
  it('refuses a google request without google_hosted_domain (23514 portal_access_requests_google_hd_chk)');
  it('refuses google_hosted_domain on an entra, self or addin_user request (23514)');
  it('refuses an upper-case or padded google_hosted_domain (23514)');
  it('accepts a google request with a lowercase hosted domain');
  it('is idempotent: a second replay changes nothing and leaves the constraint VALID');
  it('with a pre-existing google row lacking a domain: the constraint stays NOT VALID, the row is untouched (no hd inferred from email)');
});
it('classifies every portal_access_requests column; google_hosted_domain is included');
```

- [ ] **Step 2: Run them and verify they fail** (ENOENT on the migration path; unclassified column).
- [ ] **Step 3: Write the migration** (spec of record)

```sql
-- Portal registration W7: the hd of a Google access request (plan D8).
-- DDL only; system scope first per migrations/README. autoMigrate wraps the file: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.portal_access_requests
  ADD COLUMN IF NOT EXISTS google_hosted_domain text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.portal_access_requests'::regclass
                  AND conname = 'portal_access_requests_google_hd_chk') THEN
    ALTER TABLE public.portal_access_requests ADD CONSTRAINT portal_access_requests_google_hd_chk
      CHECK ((source = 'google') = (google_hosted_domain IS NOT NULL)
             AND (google_hosted_domain IS NULL OR google_hosted_domain = lower(btrim(google_hosted_domain))))
      NOT VALID;
  END IF;
  -- Nothing produces a google request before W7 (caps.google was false), so this validates on
  -- every real database. A database that somehow holds one keeps the constraint NOT VALID
  -- (enforced for new rows) instead of failing the deploy.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.portal_access_requests'::regclass
              AND conname = 'portal_access_requests_google_hd_chk' AND NOT convalidated)
     AND NOT EXISTS (SELECT 1 FROM public.portal_access_requests WHERE source = 'google' AND google_hosted_domain IS NULL) THEN
    ALTER TABLE public.portal_access_requests VALIDATE CONSTRAINT portal_access_requests_google_hd_chk;
  END IF;
END $$;
```

- [ ] **Step 4: Update the Drizzle column and the export entry.**
- [ ] **Step 5: Run** the integration file, the export test, `src/db/autoMigrate.test.ts`, `src/db/migrationRlsScope.test.ts`, `src/db/migrationPartnerExportLocks.test.ts` → PASS (add any pre-locks `migrationPartnerExportLocks` asks for). `DATABASE_URL=<test-stack url> pnpm db:check-drift` → exit 0.
- [ ] **Step 6: Commit**: `feat(portal): record the Workspace domain of a Google access request (W7)`

### Task 2: Google config, capability, verified-domain mask, write refusal

**Files:**
- Create: `apps/api/src/config/portalGoogle.ts`, `config/portalGoogle.test.ts` (template: `config/portalEntra.ts` and its test).
- Modify: `config/validate.ts` (three optional strings, plus the boot check that `getPortalGoogleConfig()` does not throw, beside the W4 Entra check at `:3272`), `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`.
- Modify: `services/portalAccessPolicy.ts` (+ test), `services/portalAccessPolicyWrites.ts` (+ test), `services/portalSsoOnly.ts` (`computeSsoOnlyFlips` facts), `packages/shared/src/validators/portalAccessPolicy.ts` (+ test).
- Test (real DB): append to `portalAccessPolicyResolver.integration.test.ts`.

**Interfaces — Produces:**

```ts
// config/portalGoogle.ts
export const PORTAL_GOOGLE_CALLBACK_PATH = '/api/v1/portal/auth/oidc/google/callback';
export interface PortalGoogleConfig { clientId: string; clientSecret: string; callbackUrl: string }
export function getPortalGoogleConfig(source?: Environment): PortalGoogleConfig | null;

// services/portalAccessPolicy.ts (changes)
export interface PortalPolicyOrgFacts { entraTenantProven: boolean; googleDomainVerified: boolean }
export interface ResolvedPortalAccessPolicy { /* W3/W4 fields */ googleDomains: string[] | null }

// packages/shared PORTAL_ACCESS_POLICY_ERROR_CODES
GOOGLE_DOMAIN_NOT_VERIFIED: 'PORTAL_ACCESS_POLICY_GOOGLE_DOMAIN_NOT_VERIFIED',
```

Rules (D6, D11):
- **Masking order:** pick → capability mask → tenant mask (Entra) / domain mask (Google) → W3's `sso_only` fallback. The source stays the picked source.
- **Reading the fact:** in `resolvePortalAccessPolicy`, after the existing read, compute the picked Google value; only if it and `caps.google` are true, read `listVerifiedDomainsForOrg(orgId)` (D6 context rule) and set `googleDomains` to the sorted lowercase domains; otherwise `googleDomains = null` and the fact is `false`.
- **Write refusal (org owner only):** `patch.googleEnabled === true` and `(await runOutsideDbContext(() => listVerifiedDomainsForOrg(orgId))).length === 0` → `PortalAccessPolicyValidationError(GOOGLE_DOMAIN_NOT_VERIFIED, 'googleEnabled', 'Verify one of the organization\'s email domains before turning on Google sign-in.')`. Reuse the existing `countVerifiedDomains` helper.
- **Partner** views and would-be-effective computations pass `{ entraTenantProven: true, googleDomainVerified: true }`.
- **`computeSsoOnlyFlips`:** each candidate org gets `googleDomainVerified` from one read API call per org whose picked Google is on, made before the transaction that recomputes the impact digest.

- [ ] **Step 1: Write the failing tests**

```ts
// portalGoogle.test.ts
it('returns null when either env var is empty');
it('throws when the client id does not end in .apps.googleusercontent.com');
it('builds the callback from PORTAL_GOOGLE_CALLBACK_BASE_URL, else PUBLIC_URL, else PUBLIC_APP_URL, else PUBLIC_API_URL');
it('refuses a base URL with a path, query or fragment');
// portalAccessPolicy.test.ts
it('getPortalSignInCapabilities().google follows the portal Google config');
it('googleEnabled is masked off when the org has no verified domain (source stays org)');   // RF3
it('sso_only falls back to allowed when the last verified domain lapses and Google was the only SSO method'); // RF3
it('the verified-domain read is skipped when the picked googleEnabled is false (read API mock not called)');
it('googleDomains lists the verified domains lowercase and sorted; null when not read');
it('under a held request context the read goes through runOutsideDbContext');
it('a W5 read that throws propagates; it never masks Google off or re-allows passwords');      // fail closed
it('the org settings view, write validation, partner preview and computeSsoOnlyFlips all pass googleDomainVerified');
// portalAccessPolicyWrites.test.ts
it('org googleEnabled true with no verified domain → 400 GOOGLE_DOMAIN_NOT_VERIFIED (field googleEnabled)');
it('partner googleEnabled true is accepted with caps.google regardless of any org domain');
it('org sso_only is refused (SSO_ONLY_NEEDS_SSO) when Google is inherited on but the org has no verified domain');
// portalSsoOnly.test.ts
it('computeSsoOnlyFlips: a partner Google-on patch flips only orgs with a verified domain');
// integration (portalAccessPolicyResolver)
it('resolves googleDomains with no context held and under a portal org context');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Sweep tests that assumed `google: false` from the real capability (`grep -rln "google" apps/api/src --include='*.test.ts' | xargs grep -l getPortalSignInCapabilities`) and pin them through `__testOnly.setCapabilities`.
- [ ] **Step 4: Run** the four unit files, `cd packages/shared && npx vitest run src/validators/portalAccessPolicy.test.ts`, `src/routes/orgPortalAccessPolicy.test.ts`, and the integration file → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Google capability from the portal OAuth client, masked by verified domain (W7)`

### Task 3: Google client and the provider in the state store

**Files:**
- Create: `services/portalOidc/googleClient.ts`, `services/portalOidc/googleClient.test.ts` (local `jose` key pair as `verificationKey`, injected `fetch`; no network).
- Modify: `services/portalOidc/types.ts` (`PortalOidcProvider = 'entra' | 'google'`; `PortalOidcVerifiedIdentity` gains `googleHostedDomain: string | null`), `services/portalOidc/stateStore.ts` (+ test): `recordShape` accepts `provider: 'google'`, `authorityFor` takes the provider, a Google state may carry only `login | invite | link`.
- Modify: `services/portalOidc/entraClient.ts`: the returned identity sets `googleHostedDomain: null` (type completeness only).

**Interfaces — Produces:**

```ts
// services/portalOidc/googleClient.ts
export const PORTAL_GOOGLE_SIGN_IN_SCOPE = 'openid email profile';
export const PORTAL_GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const PORTAL_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PORTAL_GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export function buildPortalGoogleAuthorizeUrl(cfg: PortalGoogleConfig, input: { state: string; nonce: string; codeChallenge: string }): string;
export async function exchangePortalGoogleCode(cfg: PortalGoogleConfig, input: { code: string; codeVerifier: string },
  deps?: { fetch?: typeof fetch }): Promise<{ idToken: string }>;
export class PortalGoogleTokenError extends Error { constructor(readonly check: string); }   // server-side only; never token content
/** D1. Returns provider 'google', issuer PORTAL_GOOGLE_ISSUER, subject = sub, entraTenantId null,
 *  upn null, emailClaim = email (lowercased), emailDomainOwnerVerified = true, googleHostedDomain = hd (lowercased). */
export async function verifyPortalGoogleIdToken(idToken: string, expected: { clientId: string; nonce: string; now?: Date },
  deps?: { verificationKey?: CryptoKey }): Promise<PortalOidcVerifiedIdentity & { provider: 'google'; googleHostedDomain: string; emailClaim: string }>;

// services/portalOidc/stateStore.ts (internal change; exported signatures unchanged)
// authorityFor(provider, purpose): entra → today's rule; google → PORTAL_GOOGLE_ISSUER (only login|invite|link).
```

- [ ] **Step 1: Write the failing tests**

```ts
// googleClient.test.ts
it('authorize URL: v2 auth endpoint, openid email profile, code, S256, prompt select_account, hd=*, the fixed redirect_uri');
it('the authorize hd hint is never read back: verify ignores what the request sent');      // inv. 2
it('verify accepts a well-formed Workspace token and returns issuer https://accounts.google.com, subject = sub, hd lowercased');
it('verify accepts iss "accounts.google.com" and stores the normalized issuer');
it.each([
  ['no hd (personal Gmail)'], ['no hd (consumer account on a company address)'], ['hd empty'], ['hd not a domain'],
  ['email_verified false'], ['email_verified "true" (string)'], ['no email'], ['wrong audience'],
  ['aud is an array containing the client id'], ['azp for another client'], ['issuer https://evil.example.com'],
  ['nonce mismatch'], ['iat older than 10 minutes'], ['iat more than 60 s in the future'], ['iat as a string'], ['expired'],
  ['empty sub'], ['sub longer than 255 characters'], ['HS256 algorithm'],
])('verify refuses: %s');                                                                          // RF2, inv. 6
it('sub is kept exactly as issued (case-sensitive, not assumed numeric)');
it('token endpoint 400 throws PortalGoogleTokenError without logging the body');
it('a token response without id_token throws PortalGoogleTokenError');
// stateStore.test.ts
it('creates and consumes a google login state with authority https://accounts.google.com');
it('refuses a google state carrying a tenant_proof purpose (create throws; a stored one is refused)');
it('refuses a google state with an entra authority, and an entra state with the google authority');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Mirror `entraClient.ts`: a module-level `createRemoteJWKSet(new URL(PORTAL_GOOGLE_JWKS_URL), { cacheMaxAge: 600_000, cooldownDuration: 30_000 })`, `fail(check)` logging the check name only.
- [ ] **Step 4: Run** both new/changed files, `entraClient.test.ts`, and `portalOidcStateStore.integration.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Google OIDC client and the google provider in the portal flow state (W7)`

### Task 4: Identity link, identity reader, Google requests

**Files:**
- Modify: `services/portalUserIdentities.ts` (+ `portalUserIdentities.test.ts`).
- Modify: `services/portalAccessRequests.ts` (+ `portalAccessRequests.test.ts`).
- Modify: `services/portalDomainVerification/service.ts` and `index.ts` (+ `service.test.ts`): export `lockVerifiedDomainRow`.
- Test (real DB): append to `portalUserIdentities.integration.test.ts` and `portalAccessRequests.integration.test.ts`.

**Interfaces — Produces:**

```ts
// services/portalUserIdentities.ts
export type PortalIdentityKey = { provider: 'entra'; tid: string; oid: string } | { provider: 'google'; sub: string };
export function identityIssuerSubject(key: PortalIdentityKey): { issuer: string; subject: string };
export async function findPortalUserIdByIdentity(exec: IdentityExecutor, key: PortalIdentityKey):
  Promise<{ portalUserId: string; orgId: string } | null>;          // findPortalUserIdByEntraIdentity becomes a wrapper
export async function linkPortalUserIdentity(tx: IdentityExecutor, input: PortalIdentityKey & {
  orgId: string; portalUserId: string; linkedVia: 'invite' | 'self_link' | 'jit'; clearPasswordHash: boolean; now: Date;
}): Promise<LinkIdentityResult>;   // entra branch byte-identical; google: no legacy pre-check, no entra_* fence

// services/portalAccessRequests.ts
export type CreatePortalAccessRequestInput = /* … */
  | { source: 'google'; orgId: string; email: string; name: string | null; sub: string; hostedDomain: string };
export type CreatePortalAccessRequestOutcome =
  | { kind: 'created' | 'already_pending'; requestId: string }
  | { kind: 'capped' }
  | { kind: 'claims_conflict'; requestId: string };                 // D9: SSO create vs a pending row holding another identity
// ApproveInput gains (D3, D8; both ignored by non-google sources):
//   googleDomain?: { verifiedAt: Date } | null    — the route's outside-transaction findOrgByVerifiedDomain(hd) fact for THIS org
//   googleContactAllowed?: boolean                — the D3 contact rule, computed by the route; undefined → no contact link
// PortalAccessRequestListItem gains googleHostedDomain: string | null; domainVerified covers google rows too
// New error: PORTAL_ACCESS_REQUEST_GOOGLE_DOMAIN_NOT_VERIFIED (409, Global Constraints copy)
/** Inside the approval transaction: FOR SHARE on the org's customer_email_domains row for hd with verified_at = fact.verifiedAt and is_active. */
async function lockVerifiedGoogleDomain(request: LockedRequest, fact: { verifiedAt: Date } | null | undefined): Promise<void>; // private
/** Shared with Task 5's fence: the same FOR SHARE select on the caller's transaction; false when no such row. */
export async function lockVerifiedDomainRow(tx: IdentityExecutor, input: { orgId: string; domain: string; verifiedAt: Date }): Promise<boolean>;
```

`lockVerifiedDomainRow` lives in `services/portalDomainVerification/service.ts` (exported through `index.ts`) so the one definition of "the row W5 verified" stays in W5's module; it reads `customer_email_domains` with the caller's transaction (RLS: the approval's partner context sees its own org's row; resolution runs under system scope).

Rules:
- **D9 conflict:** inside the existing admission-locked transaction, before the upsert, read the pending row at `(org_id, email)`. If the incoming source is `entra` or `google` and the row's `(source, issuer, subject)` differ → return `claims_conflict`, write nothing. If they are equal and only `google_hosted_domain` differs → the upsert's `set` also refreshes `googleHostedDomain`. `self` and `addin_user` keep the W3 bump.
- **Approve (`google`):** `lockVerifiedGoogleDomain` first (null fact, null `google_hosted_domain`, or no locked row → the new 409), then `createIdentityOnlyAccount` with `contactAddress = googleContactAllowed === true ? request.email : null` (D3).

- [ ] **Step 1: Write the failing tests**

```ts
// portalUserIdentities
it('linkPortalUserIdentity google: writes the identity with PORTAL_GOOGLE_ISSUER and leaves entra_* untouched');
it('linkPortalUserIdentity google: clearPasswordHash nulls the hash; conflict writes nothing');
it('an account with an entra identity can link a google identity; a second google identity is a conflict'); // RF4
it('linkPortalUserIdentity entra is unchanged (legacy pre-check, entra_* fence)');
it('findPortalUserIdByIdentity finds google and entra identities; the entra wrapper is unchanged');
// portalAccessRequests
it('creates a google request with google_hosted_domain');
it('a google create at an address pending for another sub → claims_conflict, nothing written (D9)');
it('a google create at an address pending as entra (provider switch) → claims_conflict');
it('an entra create at an address pending for another oid → claims_conflict (deliberate W3 change)');
it('the same google sub re-requesting with a new hd bumps and refreshes google_hosted_domain');
it('a self re-request keeps the W3 bump and never touches a pending google request\'s claims');
it('approve refuses a google request with a null or stale googleDomain fact (409 GOOGLE_DOMAIN_NOT_VERIFIED), nothing written'); // RF3
it('approve of a google request with a verified hd creates an identity-only google account');
it('approve links the contact only when googleContactAllowed is true');                       // D3
// integration (portalAccessRequests)
it('a W5 transfer of the hd that commits between the route pre-check and the approval → 409, no identity in the old org'); // D8 race
it('a W5 transfer started while the approval holds the row waits for the approval to commit');
it('the list carries googleHostedDomain and domainVerified for google rows');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both unit files, `services/portalDomainVerification/service.test.ts`, `__tests__/portalAccountWriters.contract.test.ts`, `__tests__/dbTransactionPromiseAll.contract.test.ts`, and the integration files `portalUserIdentities`, `portalAccessRequests`, `portalDomainVerification`, `portalSelfRegistration` (W6 must still see the W3 bump) → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Google identity links and Workspace-bound access requests (W7)`

### Task 5: Provider adapters and the Google account resolution

**Files:**
- Create: `services/portalOidc/signInProviders.ts`, `services/portalOidc/signInProviders.test.ts`.
- Modify: `services/portalOidc/accountResolution.ts` (+ `accountResolution.test.ts`, new Google cases appended; existing cases unchanged).
- Modify: `__tests__/portalAccountWriters.contract.test.ts` only if the census names the new file (classify `signInProviders.ts` as `no-state`: it writes no `status`/`browser_access`).
- Test (real DB): create `__tests__/integration/portalGoogleSignIn.integration.test.ts` (verified domains seeded by SQL, `findOrgByVerifiedDomain` real).

**Interfaces:**
- Consumes: Task 2 `resolvePortalAccessPolicy` (with `googleDomains`); Task 3 identity shape; Task 4 `findPortalUserIdByIdentity`, `linkPortalUserIdentity`, `createPortalAccessRequest` (google + `hostedDomain`); W5 `findOrgByVerifiedDomain`, `isDomainVerifiedForOrg`; `createIdentityOnlyAccount` (already Google-capable).
- Produces:

```ts
// services/portalOidc/signInProviders.ts
export interface PortalOidcSessionPin { entraTenantId: string | null; googleHostedDomain: string | null }
export interface PortalOidcNewPersonAddress { email: string; contactAddress: string | null; refuseIfAnyAccountAt: string[] }
export interface PortalOidcSignInProvider {
  provider: PortalOidcProvider;
  /** Step 0's org: entra → proven tenant; google → verified hd (D2), with the fact's verifiedAt. Null → org_unresolved. No DB context held. */
  resolveOrg(identity: PortalOidcVerifiedIdentity): Promise<{ orgId: string; proofVerifiedAt: Date | null } | null>;
  /** D15: inside a write branch's transaction. Google: lockVerifiedDomainRow(db, { orgId, domain: hd, verifiedAt }); false → the branch refuses org_unresolved. Entra: always true (no-op). */
  fenceProof(org: { orgId: string; proofVerifiedAt: Date | null }, identity: PortalOidcVerifiedIdentity): Promise<boolean>;
  identityKey(identity: PortalOidcVerifiedIdentity): PortalIdentityKey;
  /** Entra: the W3 D4 legacy-column pre-check before an invite is spent. Google: always false. */
  legacyKeyHeld(identity: PortalOidcVerifiedIdentity): Promise<boolean>;
  /** Entra: W4 D10 (resolveLinkableEntraAddress, else UPN). Google: D3. Null → no_address. */
  newPersonAddress(identity: PortalOidcVerifiedIdentity, org: { orgId: string; partnerId: string }): Promise<PortalOidcNewPersonAddress | null>;
  sessionPin(identity: PortalOidcVerifiedIdentity): PortalOidcSessionPin;
  accessRequest(identity: PortalOidcVerifiedIdentity, base: { orgId: string; email: string; name: string | null }): CreatePortalAccessRequestInput;
}
export const entraSignInProvider: PortalOidcSignInProvider;
export const googleSignInProvider: PortalOidcSignInProvider;
export function signInProviderFor(provider: PortalOidcProvider): PortalOidcSignInProvider;

// services/portalOidc/accountResolution.ts (changes)
// ResolvePortalOidcSignInInput.identity: PortalOidcVerifiedIdentity (was … & { entraTenantId: string })
// PortalOidcSignInOutcome 'session' gains method: PortalOidcProvider and googleHostedDomain: string | null;
//   entraTenantId becomes string | null (non-null exactly for method 'entra').
// lockAccount's hasEntraIdentity becomes hasProviderIdentity (EXISTS … provider = the adapter's provider).
// PortalOidcDenyReason gains 'request_conflict' (createPortalAccessRequest → claims_conflict, D9).
```

Rules:
- `resolvePortalOidcSignIn` keeps steps 0–5 and every deny reason. Step 0 uses `adapter.resolveOrg`, then the unchanged host binding, `getActiveOrgTenant`, and `isSignInMethodAllowed(policy, identity.provider)`.
- Every place that names `entraIssuer(r.tid)` / `r.oid` uses `identityIssuerSubject(adapter.identityKey(identity))`.
- Google `newPersonAddress`: `email = identity.emailClaim`; `contactAddress = email` when `emailDomain === hd` or `await isDomainVerifiedForOrg(emailDomain, orgId)` (no context held), else null; `refuseIfAnyAccountAt = [email]`.
- Google `accessRequest`: `{ source: 'google', …base, sub: identity.subject, hostedDomain: identity.googleHostedDomain }`.
- Every write branch (`identitySignIn` when it grants, `invite`, `link`, `instant`) calls `adapter.fenceProof` first inside its transaction (D15).
- `claims_conflict` from either request call site (step 4 approval, step 5 add-in) maps to `denied('request_conflict')`.
- The Entra adapter is a move of today's private code. Its tests are the existing ones.

- [ ] **Step 1: Write the failing tests**

```ts
// signInProviders.test.ts (mocked collaborators)
it('google resolveOrg reads findOrgByVerifiedDomain(hd) only; the email domain is never consulted');   // inv. 2
it('google newPersonAddress links a contact only when the email domain is hd or verified for the org'); // D3
it('google legacyKeyHeld is always false; sessionPin carries hd and no tenant');
it('entra adapter reproduces W4 D10 (linkable address, else UPN)');
// accountResolution.test.ts (Google cases; every existing case untouched)
it('google: unverified or declared-only hd → org_unresolved');                                         // RF2, inv. 2
it('google: hd verified for org B never signs into org A; custom host for A + hd for B → host_mismatch'); // inv. 1
it('google: googleEnabled off (masked or set) → method_off');
it('google new person with an existing same-email account → account_exists, no link');                // RF1, inv. 5
it('google: approval → google request with sub and hostedDomain; instant → identity-only google account'); 
it('google: invited_only → invited_only');
// integration (portalGoogleSignIn)
it('known google identity with browser access → session pinned to hd');
it('google identity in org A whose hd is now verified for org B → identity_other_org');                // inv. 4
it('an account at the same address in another org does not block (instant creates org A\'s account)');  // RF1
it('invite via Google activates and links linked_via invite, auth_method unchanged');                    // RF4
it('invite for an account that already has a google identity → invite_invalid, invite not consumed');   // RF4
it('an entra-linked account links google from its session; both identities remain');                   // RF4
it('second google identity on one account → identity_conflict');                                       // RF4
it('under sso_only a google link clears the hash; a google sign-in sheds it without an epoch bump');    // W4 D12
it('concurrent instant first Google sign-ins create one account');
it('instant mode with an email on an unverified secondary domain creates the account with no contact'); // D3
it('a known google identity on a browser_access none account follows step 5 (no session without a grant)');
it('an account with both identities: an entra sign-in and a google sign-in each find it; neither lookup sees the other provider');
it('the hd is displaced to org B between step 0 and the instant write → org_unresolved, nothing written in org A'); // D15
it('an approval-mode google sign-in at an address pending for another identity → request_conflict, queue unchanged'); // D9
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Move first (Entra adapter + dispatch), run the W4 suite green, commit; then add Google.
- [ ] **Step 4: Run** — the Entra gate first, unchanged files:
  - Unit: `accountResolution.test.ts`, `signInProviders.test.ts`, `portalAccessRequests.test.ts`, `portalIdentityAccounts.test.ts`, `__tests__/portalAccountWriters.contract.test.ts`, `__tests__/dbTransactionPromiseAll.contract.test.ts`, `__tests__/parkedFanout.contract.test.ts`.
  - Integration: `portalOidcSignIn` (**unchanged file, must pass**), `portalGoogleSignIn`, `portalAccessRequests`, `portalUserIdentities`.
  - All PASS.
- [ ] **Step 5: Commit** (two commits): `refactor(portal): OIDC account resolution behind a provider adapter (W7)` and `feat(portal): Google account resolution — verified hd, never by email (W7)`.

### Task 6: Google session pin

**Files:**
- Modify: `routes/portal/browserSession.ts` (+ `browserSession.test.ts`), `routes/portal/schemas.ts` (`PortalSession.googleHostedDomain?: string`).
- Test (real DB + router): append to `portalSessionCaps.integration.test.ts`.

**Interfaces — Produces:**

```ts
export interface StoredPortalSession { /* W4 */ googleHostedDomain: string | null }
export interface MintPortalBrowserSessionInput { /* W4 */ googleHostedDomain?: string }   // required for, and only for, method 'google'
export function isBrowserSessionAllowed(
  session: Pick<StoredPortalSession, 'method' | 'createdAtMs' | 'entraTenantId' | 'googleHostedDomain'>,
  user: { authMethod: string; browserAccess: string },
  policy: Pick<ResolvedPortalAccessPolicy, 'effective' | 'entraTenant' | 'googleDomains'>,
  nowMs: number,
): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('parses a google payload with createdAt and googleHostedDomain; refuses one without hd or with an invalid hd');
it('the in-memory twin refuses a google session without googleHostedDomain exactly as the Redis payload does');
it('password and entra payloads parse unchanged and carry googleHostedDomain null');
it('mint refuses googleHostedDomain on a non-google session and requires it on a google one');
it('mint writes googleHostedDomain after createdAt (password/entra byte layout unchanged)');
it('google session allowed inside the cap while its hd is in policy.googleDomains');
it('google session refused when its hd is not in policy.googleDomains, or googleDomains is null');
it('a google session never satisfies a password-only or entra-only policy');                    // inv. 9
// integration (portalSessionCaps)
it('google session dies on the next request when its hd verification is removed');             // RF3
it('google session dies when the domain is displaced to another org');                          // RF3
it('a session for another still-verified hd of the same org survives');                         // RF3
it('lowering ssoSessionMaxHours kills an older google session');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `browserSession.test.ts`, `auth.test.ts`, `auth.sessionMint.test.ts`, `acceptInvite.test.ts`, and the integration files `portalSessionCaps`, `portalAccessPolicyEnforcement`, `portalAuthEpoch` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Google browser sessions pinned to their verified Workspace domain (W7)`

### Task 7: Google routes, shared callback core, discovery

**Files:**
- Create: `routes/portal/oidcShared.ts` (moved helpers, D10), `routes/portal/oidcGoogle.ts`, `routes/portal/oidcGoogle.test.ts`.
- Modify: `routes/portal/oidc.ts` (imports the shared core; `/auth/methods` and `/auth/invite/methods` gain `google`), `routes/portal/index.ts` (mount `oidcGoogleRoutes` beside `oidcRoutes`; the Google `link/start` and `link-status` go behind `portalAuthMiddleware` exactly like the Entra ones).
- Test (real DB + router): append to `portalGoogleSignIn.integration.test.ts`.

**Interfaces — Produces** (all under `/api/v1/portal`):

| Method + path | Auth | Behaviour |
|---|---|---|
| `POST /auth/oidc/google/start` body `{ purpose: 'login' } \| { purpose: 'invite', inviteToken }` | public, shared start limiter | `{ redirectUrl }` + binding cookie. Invite: peek + `validatePortalCapability(…, { requirePasswordMethod: false })`, 400 `'Invalid or expired invite'` otherwise. Not configured → 404. |
| `POST /auth/oidc/google/link/start` | `portalAuthMiddleware` + CSRF | `{ redirectUrl }`, purpose `link` with the session's user, org and epoch. |
| `GET /auth/oidc/google/link-status` | `portalAuthMiddleware` | `{ available, linked }` (Google configured and allowed by the org's policy; a `google` identity exists). |
| `GET /auth/oidc/google/callback` | public, shared callback limiter | W4 callback steps 1–7 with the Google client and adapter; always 302 with `&p=google`; always clears the binding cookie; never 500. |
| `GET /auth/methods` | public | adds `google` (D10). |
| `POST /auth/invite/methods` | public | adds `google` (D10). |

```ts
// routes/portal/oidcShared.ts (moved, behaviour unchanged)
export function bindingCookieSecure(c: Context): boolean;
export function ipRateKey(prefix: 'start' | 'callback', c: Context): string;
export const START_RATE_LIMIT, CALLBACK_RATE_LIMIT;
export function parseCallbackQuery(params: URLSearchParams): CallbackQuery | null;          // Entra's strict parser, unchanged
export function parseGoogleCallbackQuery(params: URLSearchParams): CallbackQuery | null;    // D10: code+state (or error) once each; ignores scope/authuser/hd/prompt; refuses duplicates and a foreign iss
export async function consumeInviteForSso(inviteTokenHash: string): Promise<{ portalUserId: string; orgId: string; authEpoch: number } | null>;
export async function refuse(c: Context, reason: CallbackFailureReason, ctx: { purpose?: PortalOidcPurpose; orgId?: string | null; provider: PortalOidcProvider }): Promise<string>;
export async function finishSignIn(c: Context, provider: PortalOidcProvider, purpose: Exclude<PortalOidcPurpose, { kind: 'tenant_proof' }>, outcome: PortalOidcSignInOutcome): Promise<string>;
export function loginResult(code: LoginResult, provider: PortalOidcProvider): string;   // entra: no p; google: &p=google
export function profileResult(code: ProfileResult, provider: PortalOidcProvider): string;
// oidcGoogle.ts test seam
export const __testOnly: { setGoogleDeps(deps: { fetch?: typeof fetch; verificationKey?: CryptoKey } | null): void };
```

- [ ] **Step 1: Write the failing tests**

```ts
// oidcGoogle.test.ts
it('start login sets the Lax binding cookie and returns a Google authorize URL with the fixed callback');
it('google invite start with an invalid token → 400 Invalid or expired invite');                // inv. 7
it('every google route → 404 when the portal Google client is not configured');
it('link/start requires a portal session and CSRF');
it('google callback replay → unavailable&p=google');                                            // inv. 6
it('google callback from another browser → unavailable&p=google');                              // inv. 6
it('google callback with error=access_denied, a duplicated code/state/iss, or a foreign iss → unavailable&p=google');
it('google callback accepts Google\'s extra scope, authuser, hd and prompt parameters and never reads hd');
it('an entra state at the google callback, and a google state at the entra callback → unavailable before any token request');
it('every denied reason maps to the same redirect; the reason goes only to audit (provider google)');
it('session outcome mints a google session pinned to hd → /login?sso=signed_in&p=google');
it('/auth/methods on the shared host returns a constant google flag');                         // inv. 8
it('/auth/methods on a verified custom domain reflects that org\'s google policy');
it('/auth/invite/methods: sso_only org with only Google → { password: false, microsoft: false, google: true }');
it('entra callback redirects are unchanged (no p parameter)');                                  // RF5
// integration (append to portalGoogleSignIn)
it('end-to-end: start → callback (stubbed token endpoint + local JWKS key) → /portal/profile works');
it('end-to-end account_exists leaves the password account unchanged');                          // RF1
it('custom-domain host for org A + hd verified for org B → unavailable (host_mismatch)');       // inv. 1
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Move the helpers first with `oidc.test.ts` and `oidcTenantProof.test.ts` green and unchanged, then add `oidcGoogle.ts`.
- [ ] **Step 4: Run** `oidc.test.ts`, `oidcTenantProof.test.ts`, `oidcGoogle.test.ts`, `capabilityTokens.test.ts`, `acceptInvite.test.ts`, `selfRegistration.test.ts`, `portalSectionGates.contract.test.ts`, plus the integration files `portalOidcSignIn`, `portalGoogleSignIn`, `portalCapabilityTokens`, `portal-routes-rls` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Sign in with Google routes on a shared OIDC callback core (W7)`

### Task 8: Approval re-check, invites and `sso_only` with Google

**Files:**
- Modify: `routes/orgPortalAccessRequests.ts` (+ test): before each approve (single and bulk), for a `google` request read its `google_hosted_domain` and email, then, outside the request transaction (`runOutsideDbContext`), compute `googleDomain` (the `findOrgByVerifiedDomain(hd)` fact's `verifiedAt` when its `orgId` is this org, else null) and `googleContactAllowed` (D3: email domain is `hd`, or `isDomainVerifiedForOrg(emailDomain, orgId)`), and pass both in; bulk maps the 409 to per-id `domain_not_verified` (the W6 result code). The list's `domainVerified` covers `google` rows from the same `listVerifiedDomainsForOrg` set.
- Modify: `services/portalSsoOnly.ts` (`resolveInviteSignInMethods` → `{ microsoft, google, password }`), `routes/orgPortalUsers.ts` (+ test): `issueAndSendInvite` passes `googleUrl`; `sso-invite` refuses only when neither SSO method is effective.
- Modify: `services/email.ts` (`PortalInviteEmailParams.googleUrl?: string`; `buildPortalInviteTemplate`, D12) and its golden test.
- Test (real DB): append to `portalSsoOnly.integration.test.ts` and `portalAccessRequests.integration.test.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// orgPortalAccessRequests.test.ts
it('approve pre-checks a google request\'s hd and contact rule outside the request transaction and passes both in');
it('approve refuses a google request whose hd is no longer verified (409), request stays pending');   // RF3
it('bulk approve reports domain_not_verified for such a google request and keeps deciding the rest');
it('the list marks google rows domainVerified true/false and carries googleHostedDomain');
// orgPortalUsers.test.ts / email golden
it('invite email offers Google when only Google is effective, and both buttons when both are');
it('invite email hides the password option under sso_only with only Google');
it('invite email is unchanged when no SSO method is effective');
it('sso-invite works for a Google-only org and refuses 409 when neither SSO method is effective');
// integration (portalSsoOnly)
it('sso_only with only Google on: stranded accounts are those with no identity; Google-linked accounts lose their hash'); // inv. 11
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** The email template change is Sonnet-eligible.
- [ ] **Step 4: Run** the touched unit files, `email.golden.test.ts`, `__tests__/dbTransactionPromiseAll.contract.test.ts`, `partner-wide-write-coverage.test.ts`, and the integration files `portalSsoOnly`, `portalAccessRequests`, `portalUserInvite` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Google in invites, sso_only and the approval domain re-check (W7)`

### Task 9: W07a gate

- [ ] **Step 1: Typecheck and sweep**

```bash
NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"   # exit=0
cd packages/shared && npx tsc --noEmit; echo "exit=$?"
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/__tests__/
```

- [ ] **Step 2: Integration and contract suites.** Every integration file from Tasks 1–8, plus `tenantCascade`, `orgMergeRegistry`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, and `pnpm --filter @breeze/api test:integration-suite-coverage`. New sources under `services/portal*` and `routes/portal*` are already globbed; add `suite portal sources apps/api/src/config/portalGoogle.ts` if the coverage check names it.
- [ ] **Step 3: Migration slot.** `git fetch origin main` and the `localeCompare` check from `apps/api/migrations/README.md`; rename the file and the test's path constant if overtaken.
- [ ] **Step 4: Review.** One independent review round (`superpowers:requesting-code-review`). `pnpm test-stack down`, and say so.
- [ ] **Step 5: Open the PR.** Body: `Part of #11384`; the rule-9 statement; D1–D15 and the quorum result; OD1–OD5 as resolved; the env vars and the one redirect URI; "the capability stays off until the env is set".

---

## W07b — Web, portal, docs

Test commands:
- `apps/web`: `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`; typecheck with `npx astro check; echo "exit=$?"` and `NODE_OPTIONS=--max-old-space-size=20480 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`.
- `apps/portal`: the same vitest command (jsdom tests carry `// @vitest-environment jsdom`), plus `npx astro check`.

### Task 10: Card — Google row domain status, request queue, `sso_only` copy

**Files:**
- Create: `portalAccess/GoogleDomainsStatus.tsx` (+ test): under the Google row, "Verified domains: contoso.example.com, …" from the org view's verified domains, or "No verified domain — verify one under Organization › Domains" with a link to `#domains`. Testids `google-domains-status`, `google-domains-none`. The partner view shows "On wherever a domain is verified".
- Modify: `PortalAccessPolicyForm.tsx` (a `googleSlot` prop under the Google row, like W4's `entraSlot`), `OrgSignInRegistrationCard.tsx` (passes it; maps `PORTAL_ACCESS_POLICY_GOOGLE_DOMAIN_NOT_VERIFIED` in `friendly` to a field error on the Google row).
- Modify: `PortalAccessRequestsList.tsx` (+ test), `types.ts`: a `google` row shows "Google · {googleHostedDomain}"; `domainVerified === false` shows the W6 badge (`access-request-domain-unverified`) and disables **Approve** with the reason.
- Modify: `SsoOnlyConfirmDialog.tsx`, `StrandedAccountsList.tsx`, `ssoOnlyActions.ts` (+ tests): copy says "Microsoft or Google sign-in" / "sign-in invite" instead of "Microsoft" when Google is effective; the action itself is the unchanged `sso-invite` route.
- The org view needs the verified domains, not only `verifiedDomainCount`: if the W6 view has only the count, add `verifiedDomains: string[] | null` in the shared `PortalAccessPolicyView` (W07a Task 2 owns the API side; add it there if this task finds it missing, and note it in the W07b PR).
- Locale keys in all 8 locales: `portalAccessPolicy.google.domains.*`, `portalAccessPolicy.google.domainNotVerified`, `portalAccessRequests.source.googleWithDomain`, and the generalized `portalAccessPolicy.ssoOnlyConfirm.*` / `portalAccessPolicy.stranded.*` strings. Sonnet-eligible fan-out.

- [ ] **Step 1: Write the failing tests**

```ts
it('the Google row lists the org\'s verified domains');
it('the Google row says no verified domain and links to #domains');
it('GOOGLE_DOMAIN_NOT_VERIFIED shows the field error on the Google row');
it('a google request shows its Workspace domain; an unverified one has the badge and a disabled Approve');
it('the sso_only dialog and stranded list say Microsoft or Google when Google is effective');
// plus locale parity
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the touched tests, `no-silent-mutations.test.ts`, the locale parity tests, `translationCoverage.test.ts`, `keyUsage.test.ts`, `humanizedKeyRegression.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(web): Google row domain status, Google requests in the queue, SSO copy (W7)`

### Task 11: Portal — Sign in with Google on login, invite and profile

**Files:**
- Modify: `apps/portal/src/lib/oidc.ts` (+ test): `SignInMethods`/`InviteMethods` gain `google`; `startGoogleSignIn(input)` (stores `next` under the existing `OIDC_NEXT_KEY`), `startGoogleLink()`, `getGoogleLinkStatus()`; `GOOGLE_FAILURE_MESSAGE`.
- Create: `components/portal/GoogleSignInButton.tsx` (+ test), testid `portal-login-google`. Follow Google's sign-in button branding guidelines (the "G" mark, "Sign in with Google" text); an inline SVG, no external script.
- Modify: `LoginForm.tsx` (+ test): show the button when `methods.google`; the banner reads `p` (`google` → Google copy, absent → Microsoft copy; D14); `signed_in` picks up the session exactly as for Microsoft.
- Modify: `AcceptInviteForm.tsx` (+ test): *Continue with Google* (testid `portal-accept-invite-google`) when `google`; `?method=google` starts Google at once.
- Modify: `ProfileSettings.tsx` (+ test): a *Google account* section (testid `portal-profile-connect-google`) from `getGoogleLinkStatus`, with the `?sso=linked|unavailable&p=google` banner.

- [ ] **Step 1: Write the failing tests**

```ts
it('login shows Google only when methods.google');
it('sso banner with p=google renders the Google copy; without p, the Microsoft copy');
it('signed_in&p=google navigates to the stored next path and clears it');
it('accept-invite under sso_only with only Google shows only Google; ?method=google starts at once');
it('profile shows Connect Google when available and not linked, and Linked when linked');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Sonnet-eligible; Opus reviews.
- [ ] **Step 4: Run** the touched portal tests, `lib/disabledPageCoverage.test.ts`, `lib/nextPath.test.ts`, then `npx astro check` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Sign in with Google on login, invite and profile (W7)`

### Task 12: Docs

**Files:**
- Create: `apps/docs/src/content/docs/features/portal-google-sign-in.mdx`:
  - **For MSPs:** requirements (a verified domain equal to the user's Workspace domain; link to `portal-domain-verification`), turning Google on, first-sign-in modes (recommend `approval`; OD5), the shared session cap, `sso_only` with Google, what happens when a domain lapses (Google turns off; password fallback helps only accounts that still have a password; identity-only accounts need the domain re-verified or a re-invite — D6), removing verifications and the TXT record when a customer leaves (D2 residual), personal Gmail is never accepted, and Google sign-in works on the shared portal host only until custom-domain handoff ships (D10).
  - **For the customer's Google admin:** what the consent screen asks (`openid email profile`), App access control (OD3), OU scoping, and that sign-in uses the user's Workspace account.
- Modify: `features/portal.mdx` (the Google row: replace any "not available yet" sentence; link the page), `features/portal-domain-verification.mdx` (domains now also gate Google sign-in), `deploy/environment.mdx` (the three env vars; self-hoster steps: create a Google Cloud project, an OAuth **web application** client, the one authorized redirect URI `https://<your-breeze-domain>/api/v1/portal/auth/oidc/google/callback`, an External consent screen in production status with scopes `openid email profile`; portal and API on one site, the binding cookie is `SameSite=Lax`), `apps/docs/astro.config.mjs` sidebar.
- Regenerate the index from the repo root: `npx tsx scripts/build-docs-index.ts`.

- [ ] **Step 1:** Write the docs and regenerate the index. Sonnet-eligible. Generic placeholders only.
- [ ] **Step 2:** Run the API docs-index tests → PASS.
- [ ] **Step 3: Commit**: `docs(portal): Sign in with Google for MSPs, customer admins and self-hosters (W7)`

### Task 13: Browser check, lab leg, W07b gate

- [ ] **Step 1: Browser check** with the `feature-testing` skill on a `worktree-stack`. Google is stubbed: assert up to the authorize redirect, and drive the callback with the `__testOnly` seam only in the API tests. Check:
  - the Google row is hidden without the env, and visible with it (dummy client id/secret on the stack);
  - with no verified domain, turning Google on shows the field error; with a domain verified by SQL seeding, it saves;
  - the portal login shows *Sign in with Google*, and its button produces a redirect to `accounts.google.com` with `hd=*`;
  - accept-invite under `sso_only` with only Google shows only Google;
  - a seeded Google request shows its domain, and clearing the domain disables **Approve** with the badge.

  Tear the stack down and say so.
- [ ] **Step 2: Gate.** `astro check` and `tsc` exit 0 in `apps/web` and `apps/portal`; `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main` green in both; one independent review round. PR body: `Closes #11384`, the rule-9 statement, screenshots (card Google row, queue, portal login), and the lab-leg results or "lab leg owed" with the list below.
- [ ] **Step 3: Lab leg — owed live checks (operator gate before the env is set in any region).** These need a real Google OAuth client and real Workspace / Gmail accounts; nothing in CI or the browser check can prove them. Record each result in the W07b PR, or as a follow-up comment on #11384 if the PR merges first:
  1. A Workspace user's token carries `hd` equal to their domain and `email_verified: true`; a personal Gmail token has no `hd` and is refused.
  2. **`hd` for a user whose primary address is on a secondary domain, and for an alias-domain address**: is `hd` the Workspace primary domain or the address's domain? (Decides how OD2 plays out; adjust the docs if `hd` is always the primary domain.)
  3. A consumer (unmanaged) Google account on a company address has no `hd` and is refused.
  4. A Cloud Identity Free user signs in like a Workspace user.
  5. `hd=*` narrows the account chooser to managed accounts and is not echoed into any trusted claim.
  6. Google's token endpoint accepts PKCE S256 with the client secret for a web client; real tokens carry `azp` equal to the client id.
  7. The binding cookie survives Google's redirect (`SameSite=Lax`) on the shared host and on a verified custom domain.
  8. The consent screen in production status with `openid email profile` shows no "unverified app" interstitial (OD1); record what brand verification was needed.
  9. A Workspace with third-party app access restricted: confirm the documented App access control steps (OD3) allow and block sign-in as stated.
  10. Approval mode: a new Google user → request appears with its domain → approve → sign-in works. Instant mode creates the account.
  11. A Google session dies after a 1 h cap and on removing the domain's verification, and the user re-authenticates through Google.
  12. An existing password user at the same address gets `account_exists`, links Google from the profile, then signs in with Google.
- [ ] **Step 4: Commit** any doc fixes from the lab leg: `docs(portal): Google sign-in lab-leg corrections (W7)`.

---

## Execution split and parallelism

**W07a (API)**
- **SERIAL first:** T1 (migration gates T4's real-DB tests).
- **PARALLEL GROUP A1 (file-disjoint):**
  - **T2** (`config/portalGoogle.ts`, env/compose, `portalAccessPolicy.ts`, `portalAccessPolicyWrites.ts`, `portalSsoOnly.ts` facts, shared validators);
  - **T3** (`portalOidc/googleClient.ts`, `types.ts`, `stateStore.ts`, `entraClient.ts` one field). T3 needs `PortalGoogleConfig`'s type only: land T2's `config/portalGoogle.ts` first (a small commit) or code T3 against the Interfaces block.
- **SERIAL:** T4 after T1 (`portalUserIdentities.ts`, `portalAccessRequests.ts`).
- **SERIAL:** T5 after T2, T3, T4 (`signInProviders.ts`, `accountResolution.ts`).
- **PARALLEL GROUP A2 (after T5):**
  - **T6** (`browserSession.ts`, `schemas.ts`);
  - **T8** (`orgPortalAccessRequests.ts`, `portalSsoOnly.ts` `resolveInviteSignInMethods`, `orgPortalUsers.ts`, `email.ts`). T8's `portalSsoOnly.ts` edit is a different function from T2's.
- **SERIAL:** T7 after T6 (it mints Google sessions; `oidcShared.ts`, `oidcGoogle.ts`, `oidc.ts`, `index.ts`).
- **SERIAL last:** T9.
- **Sonnet-eligible:** T1's export entry; T2's env/compose/validate plumbing; T8's email template; the T7 helper move (mechanical, with the existing tests as the check).
- **Opus:** T1 migration, T2 mask and resolver, T3 verifier, T4 link and D9 refresh, T5 entirely, T6, T7 callback and discovery, T8 approval re-check, T9.

**W07b (web + portal + docs)**, branched from fresh main after W07a merges
- **PARALLEL GROUP B1 (file-disjoint):** **T10** (`apps/web/**`, locale files), **T11** (`apps/portal/**`), **T12** (`apps/docs/**`, docs index).
- **SERIAL last:** T13.
- **Sonnet-eligible:** T10's locale fan-out and copy, T11, T12. **Opus:** T10's status panel and queue logic, T13, review of B1.

**CPU:** never more than one `tsc` at a time across a parallel group; each implementer runs only its own files with `maxForks=4`; the `--changed origin/main` sweep runs once, in T9 / T13.

## CI traps

- **Premise.** W4 and W5 are on main. Re-check every name in the "Builds on" list and the Interfaces blocks against main before T1; if review renamed one, fix this plan in the W07a PR.
- **Stacked PRs get no CI.** W07b branches from main after W07a merges. If it must open early, `gh workflow run CI --ref <branch>`.
- **The Entra refactor gate.** T5 and T7 move code that the W4 suites pin. Run `accountResolution.test.ts`, `oidc.test.ts`, `oidcTenantProof.test.ts` and `portalOidcSignIn.integration.test.ts` **before** adding any Google code, and commit the move on its own. A W4 test edited "to fit" is a review blocker.
- **W5 read API inside a transaction throws.** `resolvePortalAccessPolicy` (D6), the policy write refusal, `computeSsoOnlyFlips`, and the approval pre-check all call it with no context held or through `runOutsideDbContext`. A call under a held request context without that wrapper fails every MSP settings request.
- **Lock order.** `lockVerifiedDomainRow` takes `FOR SHARE` on a `customer_email_domains` row inside an approval or sign-in transaction that also locks `portal_access_requests` / `portal_users` rows. W5's transfer takes its advisory lock, then `FOR UPDATE` on domain rows only, and touches no portal rows, so there is no cycle. Keep it that way: no W5 writer may lock portal rows.
- **Resolver cost.** The domain read must stay behind "picked `googleEnabled` && `caps.google`". Without that guard every portal request for every org pays W5's evidence read.
- **Capability assumptions.** Flipping `google` to env-gated leaves tests false (no env in test). Tests that need Google on use `__testOnly.setCapabilities`; a test that sets the env restores it.
- **Writer census.** `portalAccountWriters.contract.test.ts` fails on a file that writes `portal_users` unclassified. `signInProviders.ts` writes nothing; the writes stay in `accountResolution.ts` (already `state-module`) and `portalUserIdentities.ts`.
- **Export policy.** `google_hosted_domain` must be classified; `tenant-export-policy` and `tenantExportErasureRoundtrip` fail only under Integration Tests.
- **Integration suite map.** New test files match `portal[!a-z0-9]*`; `config/portalGoogle.ts` may need a `suite portal sources` line (`test:integration-suite-coverage` names it).
- **No network in tests.** Inject `fetch` and the `jose` key. A test that reaches `accounts.google.com` or `googleapis.com` hangs CI.
- **One binding cookie for both providers.** Starting a Google flow while a Microsoft flow is in flight (another tab) overwrites the binding; the first callback reads `unavailable`. Tests must not run two flows in one cookie jar and expect both to succeed.
- **Redirect codes.** The Entra callback must not gain `p=`; portal code treats a missing `p` as Microsoft. A test pins both.
- **Customer-PII guard.** Test and doc addresses use `example.com`, `*.example.com` or `.test`.
- **`.env.example` and config validation.** The three env vars go into `.env.example` with a generic comment and are parsed in `config/validate.ts`; a doc row in `deploy/environment.mdx` without a compose mapping fails `envReadComposeCoverage`.
- **Migration slot.** Assigned at enqueue; a sibling migration landing first poisons the merge queue (Check Migrations). Run `pnpm db:check-drift`.
- **Typecheck heap.** API `tsc` needs a 20 GB heap. Check `exit=$?`, never `| tail`.
- **Web.** `no-silent-mutations` `TARGET_GLOBS` (only if a new mutating component is added), 8-locale parity, `keyUsage.test.ts`, `humanizedKeyRegression.test.ts`.
- **Docs index.** Changing any `.mdx` without regenerating `docsIndex.json` fails the docs-index test.
- **No infrastructure details** in docs or PR bodies; redirect URIs use `https://<your-breeze-domain>`.

## Out of scope

- **W8:** Google directory deprovisioning (suspended or deleted users from a daily Directory API pass). Every identity-removing writer W8 adds must bump `auth_epoch`, as W4 requires for Entra.
- **W9:** Entra SCIM.
- A Google tenant/domain "proof run" like W4's: W5 already proves domains.
- Google identities for the AI for Office add-in (none exists).
- MSP *unlink identity* and *remove browser access* actions (W4's out-of-scope list still holds).
- A session handoff to custom portal domains (W4 D5).
- An AI tool for Google sign-in.

## Self-review

1. **Spec coverage (§5.8, §7 W7 row):**
   - Google OAuth web client per deployment, env names → D11, T2, T12 (OD1 for the hosted project).
   - Scopes `openid email profile` → Global Constraints, T3.
   - `jose` against Google's JWKS, iss, aud, nonce, `email_verified=true` → D1, T3.
   - `hd` required, personal Gmail refused → D1, T3, owed checks 1 and 3.
   - `hd` equal to a domain verified for exactly one org with `google_enabled` → D2, D6, T2, T5.
   - §5.6 common rules (state, PKCE, nonce, binding, allowlisted redirects, host binding, finding the account in order, no email linking, atomic linking) → reused W4 layer, D4, D5, D13, T3, T5, T7.
   - §5.5 SSO invite email with Google → D12, T8.
   - §5.10 audit → D14, T7.
   - §5.11 absolute cap and `sso_only` → D6, D7, T2, T6, T8.
   - §8 docs → T12.
   - Invariants 1–9 and 11 → named tests above.
2. **Step scan:** every code step names its file and signature; the SQL is given in full as the spec of record; route, adapter and component bodies are left to the implementer.
3. **Type consistency:** used identically across T1–T13:
   - types: `PortalGoogleConfig`, `PortalOidcProvider` (`'entra' | 'google'`), `PortalOidcVerifiedIdentity.googleHostedDomain`, `PortalIdentityKey`, `PortalOidcSignInProvider`, `PortalOidcSessionPin`, `StoredPortalSession.googleHostedDomain`, `ResolvedPortalAccessPolicy.googleDomains`, `PortalPolicyOrgFacts.googleDomainVerified`;
   - functions: `getPortalGoogleConfig`, `buildPortalGoogleAuthorizeUrl`, `exchangePortalGoogleCode`, `verifyPortalGoogleIdToken`, `findPortalUserIdByIdentity`, `identityIssuerSubject`, `linkPortalUserIdentity`, `lockVerifiedDomainRow`, `signInProviderFor` (adapter methods `resolveOrg`, `fenceProof`, `identityKey`, `legacyKeyHeld`, `newPersonAddress`, `sessionPin`, `accessRequest`), `resolvePortalOidcSignIn`, `parseGoogleCallbackQuery`, `mintPortalBrowserSession`, `isBrowserSessionAllowed`, `resolveInviteSignInMethods`;
   - codes and outcomes: `PORTAL_ACCESS_POLICY_GOOGLE_DOMAIN_NOT_VERIFIED`, `PORTAL_ACCESS_REQUEST_GOOGLE_DOMAIN_NOT_VERIFIED`, `portal_access_requests_google_hd_chk`, `claims_conflict`, `request_conflict`.
4. **Review Focus:** all five lines have named tests in their owning tasks (T2, T3, T4, T5, T6, T7, T8).
5. **Proportion:** decisions, interfaces, the migration and test names; no transcribed bodies.
