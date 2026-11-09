---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W4: Entra Tenant Proof, Sign in with Microsoft, OIDC Layer, Session Caps, `sso_only` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customer staff can sign in to the browser portal with Microsoft. That works only for an org whose Entra tenant was proven by identity, never by an MSP-typed value. W4 adds a provider-neutral OIDC layer that W7 (Google) reuses. It also adds absolute lifetimes for SSO browser sessions and add-in sessions, and makes `password_mode = sso_only` a complete save flow.

**Architecture:**
- **Tenant proof.** The proof lives on the org's existing tenant mapping (`client_ai_tenant_mappings`), in four new columns. A trigger clears the proof whenever the mapped tenant changes. There are two ways to prove a tenant:
  1. **Proof run.** The tenant admin signs in to the new portal Entra app, and a live Graph role check confirms they are an admin.
  2. **M365 connection.** The org's identity-first M365 connection already proved the tenant, so it can be reused as evidence.
- **Policy resolution.** `resolvePortalAccessPolicy` treats Microsoft as off for any org without a proven tenant. An org therefore never stays on `sso_only` while nobody can sign in with Microsoft: the existing fallback re-allows password sign-in.
- **OIDC flow.** `services/portalOidc/` holds the flow state in Redis: single-use, 10-minute lifetime, bound to the browser by a cookie. It also holds the Entra client (authorize URL, code exchange, id_token verification) and account resolution, which implements spec §5.6 steps 1–5 with no email-match linking.
- **Callback.** One public callback serves every purpose: login, invite, link and tenant proof. It mints `method: 'entra'` browser sessions, which carry their tenant and are capped per request by the current `ssoSessionMaxHours`.

**Tech Stack:** Hono, Drizzle (queries only), a hand-written SQL migration, PostgreSQL forced RLS, ioredis (Lua GET+DEL), `jose`, Astro + React (web and portal), and Vitest (unit tests plus `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`. Relevant sections: §4, §5.1, §5.4 (tenant proof), §5.5 (SSO invite email), §5.6, §5.7, §5.11 (session caps and `sso_only`), §6 invariants 1–9, 11 and 13, and the §7 W4 row. The index is `2026-11-08-portal-registration-options-index.md`.

**Builds on:**
- W1 #11405 and W2 #11408, both merged.
- W3: W03a #11528 (API) and W03b #11523 (web). Both were open when this plan was written. **Wave entry gate:** both must be merged on main before Task 1 starts. Re-check every W3 name in the Interfaces blocks below against main. If review renamed any of them, fix this plan in the W04a PR.
- **From W2:**
  - the state module `services/portalAccountState.ts`;
  - the capability tokens `routes/portal/capabilityTokens.ts`;
  - `services/portalUserIdentities.ts` (`entraIssuer`, `insertEntraIdentity`, `ensureEntraIdentity`).
- **From W3:**
  - `resolvePortalAccessPolicy`, `isSignInMethodAllowed`, `getPortalSignInCapabilities` and `__testOnly.setCapabilities`;
  - `pickEffectivePortalAccessPolicy` and `portalAccessPolicyWrites.ts`;
  - `routes/portal/browserSession.ts` (`parseStoredPortalSession`, `isBrowserSessionAllowed`, `isPasswordSignInAllowedForOrg`);
  - `createPortalAccessRequest`, plus the approve path's private `createIdentityAccount`;
  - `portalUserHasIdentitySql` and `findPortalUserIdByEntraIdentity`;
  - the W03b card (`PortalAccessPolicyForm`, `OrgSignInRegistrationCard`, `PartnerCustomerPortalTab`).

**Rigor: high.** This wave touches auth, OIDC, a migration on an org-cascade table, cross-tenant proof transfer, org merge and session lifetimes. It follows full TDD, with one independent review round per PR and contract suites before each PR. The advisor quorum (`codex exec`, xhigh, read-only) reviews D1–D15 before the W04a PR opens.

## PR split

| PR | Tasks | Branch | Body | Depends on |
|---|---|---|---|---|
| **W04a: API** | 1–10 | `feature/11377-portal-registration/wave-11381` | `Part of #11381` (never `Closes`) | W03a and W03b merged |
| **W04b: Web + portal + docs** | 11–14 | `feature/11377-portal-registration/wave-11381-b` | `Closes #11381` | W04a **merged to main**. Branch from fresh main and do not stack, because a stacked PR runs no CI. |

**W04a's visible surface.** Its API is complete, but nothing reaches users while `PORTAL_ENTRA_CLIENT_ID` / `PORTAL_ENTRA_CLIENT_SECRET` are unset, because `capabilities.entra` stays false. Two changes are visible even with the env unset:
- the add-in absolute session cap (Task 6);
- the SSO-variant invite email, which still renders the password-only email while Microsoft is off.

**Rollout.** Ops sets the env in each region only after W04b deploys and the lab leg (Task 14) passes.

## Decisions taken in this plan (flag in each PR body)

- **D1: Proof lives on `client_ai_tenant_mappings`. There is no new table.**
  - Spec §5.4 says "stored on the org's tenant mapping". The table is already 1:1 per org and globally unique on the tenant.
  - New columns: `proven_at`, `proven_via` (`m365_connection` | `proof_run`), `proven_by_user_id` and `proven_evidence` (jsonb).
  - A `BEFORE UPDATE` trigger clears all four columns whenever `entra_tenant_id` changes and the update does not itself set a new `proven_at` (inv. 3). It catches the existing AI for Office `PUT /tenant-mapping` upsert without touching that route.
  - The table name stays. A rename is out of scope.
- **D2: The resolver masks `entraEnabled` by "the org has a proven tenant".**
  - `pickEffectivePortalAccessPolicy` gains a `facts` argument, and `entraEnabled = picked && caps.entra && facts.entraTenantProven`.
  - Losing the proof turns Microsoft off on the next request. Entra sessions die, and an org override of `sso_only` falls back to `allowed` with `passwordModeFallback: true`, so nobody is locked out.
  - An org override of `entraEnabled: true` without a proven tenant is refused with 400 `PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN`. An inherited `true` is simply masked.
  - Partner views pass `entraTenantProven: true`. The partner default means "on wherever a tenant is proven".
- **D3: OIDC state lives in Redis.** This follows the portal pattern, with the in-memory fallback outside production.
  - Key and lifetime: `portal:oidc:state:{sha256(state)}`, TTL 600 s, consumed by the W2 Lua GET+DEL.
  - **Browser binding.** A random 32-byte cookie `breeze_portal_oidc`: `HttpOnly`, `Path=/api/v1/portal/auth/oidc`, `SameSite=Lax`, `Secure` in production, `Max-Age=600`. Its sha256 is stored in the state and compared in constant time.
    - The cookie is `Lax`, not the configurable portal SameSite. It must survive Microsoft's top-level cross-site GET redirect (`response_mode=query`).
  - **No return URL travels through the API.** The callback redirects only to fixed portal paths. The portal keeps `next` in `sessionStorage` and applies its existing `safeNextPath`. This satisfies inv. 6's allowlist trivially and leaves no open-redirect surface.
- **D4: One callback URI and one consent-return URI per deployment.** Both are fixed:
  - `{base}/api/v1/portal/auth/oidc/entra/callback`, which dispatches on the state's purpose (`login | invite | link | tenant_proof`);
  - `{base}/api/v1/portal/auth/oidc/entra/consent-return`.

  `base` is `PORTAL_ENTRA_CALLBACK_BASE_URL`, falling back to the origin of `PUBLIC_URL || PUBLIC_APP_URL || PUBLIC_API_URL`, the same order as `m365ControlPlane/runtimeConfig.ts`. Self-hosters register exactly these two redirect URIs.
- **D5: Host binding is enforced, but there is no cross-host session handoff.**
  - **Where the host comes from.** The portal calls the API same-origin: Caddy routes `/portal` and `/api` on one host (`docker/Caddyfile.prod:458`), and `reverse_proxy` keeps `Host`. So the API's `Host` header *is* the portal host the browser used.
  - At start, the state records `hostOrgId`: the org whose **verified** custom domain equals that `Host` (`resolvePortalHostOrgId`), or null on the shared host.
  - At callback, a non-null `hostOrgId` that differs from the resolved org is denied (inv. 1).
  - On the shared host the check is a no-op by design. The spec takes the org from the proof alone there.
  - Portal custom-domain serving is not available yet (`apps/docs/src/content/docs/features/portal.mdx:19`). So a session handoff from the canonical callback host to a custom domain is out of scope until it is.
- **D6: The proof run uses the portal app plus a live Graph role check. `wids` is never read.**
  - **Tenant pin.** A proof link is always pinned to a tenant. The MSP gives a tenant hint when creating the link: a GUID, or a domain resolved to its tid through Microsoft's public `/{domain}/v2.0/.well-known/openid-configuration`. The default is the org's mapped tenant, or else its M365 connection's tenant. A hint is **not** proof (inv. 2). It only stops a link that was forwarded or leaked from binding some other tenant whose admin opened it. The callback requires `tid === expectedTenantId`.
  - **Sign-in.** The authority is the pinned tenant. Scope is `openid profile Directory.Read.All` (OD2), with PKCE and nonce.
  - **Role check.** It reuses `checkMailboxConsentAdminRoleViaGraph(accessToken, { tid, oid })` (`services/ticketMailbox/microsoftIdentity.ts:259`). That check is bound to the token's principal and tenant and accepts Global Administrator and Privileged Role Administrator.
  - **Run link.** It is a 72 h capability, consumed by GET+DEL right before the proof is recorded.
    - A failed sign-in or a failed admin check does not burn it.
    - A double callback records one proof.
    - A refused record (`PortalEntraProofError`) has already consumed it, so the MSP fixes the cause and creates a new link.
  - **Re-authorization at record time.** The org must still be active (`getActiveOrgTenant`). The link's creator must still be an `active` user in the org's partner. Otherwise the result is `invalid`.
  - **Consent.** After the proof, the admin is sent to the v2 `/{tid}/v2.0/adminconsent` with `scope=openid profile email`. The consent return reads no parameter as authority and records nothing, because Microsoft enforces consent itself.
  - **Least privilege is not guaranteed.** In the proof sign-in the admin still sees Microsoft's "consent on behalf of your organization" box for `Directory.Read.All`, and Breeze cannot hide it. If they tick it, the tenant grants that delegated scope to the portal app.
    - Breeze requests the scope only in proof-run sign-ins, and a delegated scope acts only as the signed-in admin.
    - The docs tell the admin to leave the box unticked.
    - OD2 is resolved before W04a Task 4, not in the lab leg.
- **D7: Transfer rules (spec §5.4).**
  - A `proof_run` displaces any mapping of the same tenant in another org, proven or not.
  - An `m365_connection` proof displaces only an **unproven** mapping. Otherwise it gets 409 `TENANT_PROVEN_ELSEWHERE` (OD4).
  - Displacement does the following in the proof transaction:
    - delete the other org's row;
    - bump `auth_epoch` for that org's accounts that have an identity in this tenant, which durably kills their browser and add-in sessions;
    - audit both orgs.

    After commit it emails the displaced partner's active admins (`listActivePartnerAdmins`).
  - The org that is proving must not hold a mapping for a different tenant. That gets 409 `ORG_HAS_OTHER_TENANT`, and the MSP removes it first (Task 8 `DELETE`).
  - **Concurrency.** The transaction takes `pg_advisory_xact_lock(hashtext('portal-entra-tenant:' || tid))` before any read. That serializes two orgs proving the same fresh tenant: `FOR UPDATE` locks nothing when no row exists yet. A stray `client_ai_tenant_mappings_tenant_uniq` 23505 maps to `TENANT_PROVEN_ELSEWHERE`, never a 500.
- **D8: Org merge.**
  - `client_ai_tenant_mappings` stays `keep-survivor`. A proven loser mapping is adopted when the survivor has none, and the trigger keeps the proof because the tenant does not change.
  - A new pre-walk blocker `entra_tenant_conflict` refuses the merge when the loser's mapping is proven **and** the survivor holds any mapping (spec §5.4).
    - This reads the spec's "if both hold one" as "both hold a mapping". Otherwise `keep-survivor` would drop the loser's **proven** mapping in favour of an unproven one and strand the repointed identities. See OD7.
- **D9: Session caps.**
  - **Browser.** An `entra` browser session dies when `now - createdAt ≥ effective.ssoSessionMaxHours × 1 h`. The check runs per request against the **current** policy, so lowering the cap takes effect at once.
  - **Tenant pin.** An `entra` session also stores its `entraTenantId` and dies when that is no longer the org's proven tenant.
  - **Password sessions** keep today's sliding 24 h, with no absolute cap (spec §5.11 limits the cap to SSO).
  - **Add-in sessions** get an absolute cap of `CLIENT_AI_SESSION_MAX_AGE_SECONDS = 12 h` from their stored `createdAt` (OD1). The add-in client already re-exchanges once on a 401 (`packages/office-addin-core/src/api/client.ts:49`). A missing or unparseable `createdAt` fails closed.
- **D10: The email for a new SSO person.**
  - It is the linkable address from `resolveLinkableEntraAddress` (the existing contact rule), otherwise the lowercased UPN. The UPN suffix is always a tenant-verified domain.
  - The contact link is attempted only for a linkable address.
  - The "account already exists" check (§5.6 step 4) matches either address. Nothing ever links by email.
- **D11: Purpose conflicts deny.** An identity already bound to a different account than an `invite` or `link` purpose names is denied (`identity_conflict`). It never signs in as the other account and never consumes the invite.
- **D12: `sso_only` save flow.**
  - Hash clearing runs only on a policy **save** (org or partner PATCH) that flips some org from effective `allowed` to effective `sso_only`.
  - **Acknowledgement.** The impact preview returns an `impactDigest`: sha256 over the sorted `(orgId, passwordsToClear, strandedTotal)` list. The PATCH must carry `?acknowledge=<impactDigest>`.
    - A missing ack, or a digest that no longer matches the impact recomputed inside the transaction, returns 409 `PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED` with the fresh impact and digest.
    - Neither a script nor a stale dialog can clear hashes the MSP never saw.
  - With it, the policy upsert and the hash clearing commit in one transaction. Hashes are cleared and epochs bumped only for accounts that have an identity. Session purge after commit is cleanup.
  - Flips caused by a proof or a deploy-time capability change clear nothing. W3's refusal at use is the control (inv. 11).
  - Linking an identity while the org is effectively `sso_only` clears that account's hash in the same transaction.
  - **Lazy convergence.** A successful Entra sign-in also clears that account's hash while the org is effectively `sso_only`, without bumping the epoch. An org that became `sso_only` through a proof, not a PATCH, still sheds hashes as people sign in. A later fallback to `allowed` therefore cannot revive a leaver's old password for anyone who has signed in with Microsoft since.
- **D13: An invite accepted through Microsoft keeps `auth_method` unchanged** (OD6).
  - The account stays password-eligible, so under `allowed` the person can still set a password later.
  - Instant-mode and approved SSO accounts stay identity-only (W3 D2).
- **D14: Client secret credential only** (`PORTAL_ENTRA_CLIENT_SECRET`). A certificate credential is a follow-up. The secret is env-only, never logged, and token-endpoint bodies are never logged (the `logIdentityCheckFailure` pattern).
- **D15: One user-visible failure.**
  - Every callback denial shows the portal's single generic message, "Microsoft sign-in isn't set up for this account here." (`?sso=unavailable`).
  - The only exceptions are the two spec-mandated outcomes, `request_sent` and `account_exists`.
  - The deny reason goes to the audit row and the server log only.

## Open decisions (Todd)

- **OD1: Add-in absolute cap default.** Plan default: **12 h**, matching the SSO browser default. Re-exchange is silent, so the cost is near zero, and a leaver's Entra disable bites within 12 h. Alternative: 24 h. Spec §5.11 asks for this number in the W4 PR.
- **OD2: Admin-check scope.** Plan default: request `Directory.Read.All` (delegated) **only** in the proof-run sign-in, the same as the ticket-mailbox flow, with roles GA and PRA. The tenant-wide admin consent asks only for `openid profile email`.
  - **Resolve before W04a Task 4.** Run a short lab check: does a lower scope such as `RoleManagement.Read.Directory` return `roleTemplateId` for `/me/transitiveMemberOf/microsoft.graph.directoryRole`? If one does, use it. Either scope can be granted tenant-wide by a ticked box, so D6 does not claim least privilege.
  - Alternative: also accept Cloud Application Administrator and Application Administrator, who can grant the delegated consent this app needs.
- **OD3: Removing an org's tenant (Task 8 `DELETE`) also removes its AI for Office mapping**, because D1 shares one row. Plan default: allow it, behind a confirm dialog that names the add-in impact.
- **OD4: An M365-connection proof cannot displace a tenant proven elsewhere** (D7). Only a fresh proof run can. Reason: an old connection held by a former MSP must not take a tenant back from the current one. Spec §5.4 reads "a newer proof from a different org" and does not distinguish the two.
- **OD5 (carry-over from W3 OD4): delete the W2 legacy-invite branch.** Task 7 Step 6 does this only if the dispatch brief confirms #11408 has been in production in every region for at least 7 days, and W3 did not already delete it.
- **OD6: An invite accepted with Microsoft keeps `auth_method='password'`** (D13). Alternative: make it identity-only, so a password added later cannot outlive a leaver's IdP disable under `allowed`.
- **OD7: Merge refusal reads spec §5.4 "if both hold one" as "both hold a mapping"** (D8). The other reading is "both hold a **proven** mapping". Under that reading a proven loser would merge into a survivor with an unproven mapping, and the loser's proven mapping would be dropped.

## Settings rule 9 statement (copy into both PR bodies)

- **No new setting concept.**
  - `entraEnabled`, `ssoNewPersonMode` and `ssoSessionMaxHours` already exist (W3), and W4 only makes them live. W04b adds the `ssoSessionMaxHours` row to the existing form.
  - Tenant proof is evidence about the org, not a setting. It is shown inside the Microsoft row and never inherited.
- **Home:** unchanged.
  - org settings › Portal › Sign-in & registration;
  - partner settings › Customer portal.
- **Level:** partner default → org override.
- **Resolver:** `resolvePortalAccessPolicy(orgId)`.
- **Places configured:** before 2, after 2.
- **Not settings:** the add-in cap (`CLIENT_AI_SESSION_MAX_AGE_SECONDS`) is a constant, and the portal Entra app credentials are deployment env.
- **Nav:** no new settings page. `settingsPageRegistry.test.ts` passes unchanged.

## Global Constraints

- **Entra issuer** is exactly `https://login.microsoftonline.com/{tid}/v2.0` (`entraIssuer`). The identity subject is the `oid` claim, never `sub`. That keeps it equal to the add-in's identity for the same person.
- **id_token checks** (spec §5.7, inv. 13):
  - `jose` against `https://login.microsoftonline.com/common/discovery/v2.0/keys` (10 min cache, 30 s cooldown), RS256 only, `aud` = portal client id.
  - Required claims: `iss`, `aud`, `exp`, `iat`, `tid`, `oid`, `nonce`.
  - `iss === entraIssuer(tid)` and `nonce` equal (constant time).
  - Freshness: `iat` no older than 10 min. Clock tolerance 60 s.
  - `tid` is a GUID and not the consumer tenant `9188040d-6c67-4c5b-b112-36a304b66dad`.
  - Also `ver === '2.0'` and `oid` is a GUID.
  - **Guest refusal, structural.** User sign-in always uses the `organizations` authority, never a tenant-specific one. Microsoft then issues the token in the user's **home** tenant, so a B2B guest token cannot be minted for a sign-in.
  - **Guest refusal, defence in depth.** Refuse when `idp` is present and differs from both `iss` and `https://sts.windows.net/{tid}/`, or when `acct === 1`.
    - `acct` and `xms_edov` are optional claims. The self-hoster steps (Task 14) add `acct`, `email` and `xms_edov` to the app's ID-token optional claims.
    - A token **without** `acct` is accepted. The structural rule is the guarantee, and a test pins that behaviour.
  - **Proof run.** It pins the tenant authority (D6). A guest who holds Global Administrator in the customer's tenant is an admin there, and the Graph role check binds to `tid`/`oid`.
- **Authority and scopes:**
  - Sign-in: authority `organizations`, scope `openid profile email`, `prompt=select_account`, `response_mode=query`, PKCE S256. PKCE comes from `generatePKCEChallenge` (`services/sso.ts:58`).
  - State and nonce: 32 random bytes each, base64url.
- **State TTL** 600 s. **Proof-run link TTL** 72 h. **Lua GET+DEL** for both.
- **Rate limits** (per IP, through `checkRateLimit`):
  - `portal:oidc:start:ip:{ip}`: 20 per 5 min, block 15 min;
  - `portal:oidc:callback:ip:{ip}`: 30 per 5 min, block 15 min;
  - `portal:oidc:proof:ip:{ip}`: 10 per 15 min, block 30 min.
  - The invite-methods peek reuses the accept-invite buckets.
- **Portal result codes**, the only values the callback ever puts in a redirect:
  - `/login?sso=signed_in|request_sent|account_exists|unavailable`
  - `/profile?sso=linked|unavailable`
  - `/entra-setup?status=proven|consent_done|invalid|failed`
- **Audit actions:**
  - `portal.auth.oidc.login` (result success or failure; `details: { provider, outcome, reason? }`, reason only on failure);
  - `portal.auth.identity.link` (`details: { provider, linkedVia }`);
  - `organization.portal_identity_proof.proven`, `.displaced`, `.link_created`, `.removed`;
  - `organization.portal_user.browser_access.grant`.
  - The portal auth audit wrapper (`routes/portal/auth.ts:84-130`) covers POST only, so the GET callback writes its own rows.
- **New error codes** (UPPER_SNAKE):
  - In shared `PORTAL_ACCESS_POLICY_ERROR_CODES`: `PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN` and `PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED`.
  - In `portalEntraTenantProof.ts`: `PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE`, `PORTAL_ENTRA_ORG_HAS_OTHER_TENANT`, `PORTAL_ENTRA_NO_VERIFIED_CONNECTION`, `PORTAL_ENTRA_PROTECTED_ORG`.
  - In `routes/orgPortalEntraTenant.ts`: `PORTAL_ENTRA_NOT_CONFIGURED` (route-level 404), `PORTAL_ENTRA_TENANT_HINT_REQUIRED` and `PORTAL_ENTRA_TENANT_HINT_INVALID` (422).
  - In the SSO invite route: `PORTAL_SSO_INVITE_UNAVAILABLE`.
- **Secrets:** env only. `.env.example` carries blank placeholders.
  - `PORTAL_ENTRA_CLIENT_ID`
  - `PORTAL_ENTRA_CLIENT_SECRET`
  - `PORTAL_ENTRA_CALLBACK_BASE_URL` (optional)

  - Compose: pass them through in `docker-compose.yml` and `deploy/docker-compose.prod.yml`, like `CLIENT_AI_ENTRA_CLIENT_ID`.
  - Validation: add new optional-string entries in `config/validate.ts`. `CLIENT_AI_ENTRA_CLIENT_ID` has none, so there is no precedent to copy. No secret, token, code or token-endpoint body is ever logged or audited.
- **Migration:** `apps/api/migrations/2027-01-22-2330xx-portal-entra-tenant-proof.sql`.
  - **The `xx` is assigned at enqueue.** The file must sort after the newest file on `origin/main`.
    - Today that is `2027-01-22-232100-backup-snapshot-files-kind.sql`.
    - W03a adds `2027-01-22-232800-portal-access-policies-requests.sql`, which merges first, so W4 must sort after it too.
  - Re-run the `localeCompare` check from `apps/api/migrations/README.md` before every push. If overtaken, rename the file and the test's path constant. Never rename a shipped migration.
  - The file is idempotent, has no inner `BEGIN;/COMMIT;`, and its first statement is `SELECT set_config('breeze.scope', 'system', true);`.
- **Tenancy:**
  - No new table. `client_ai_tenant_mappings` keeps its shape-1 RLS.
  - Registration: cascade (existing entry, unchanged), merge (existing `keep-survivor` plus the D8 blocker), export (new columns classified; `proven_evidence` jsonb → `excludedOpen`), RLS coverage (unchanged).
- **Unchanged invariants:**
  - **Neither product grants the other** (inv. 9). The add-in middleware still never reads `browser_access` or the policy, and the cap is its only new check.
  - **No email-match linking** (inv. 5).
- **Web:**
  - Mutations go through `runAction`, and new components are added to `TARGET_GLOBS` in `lib/__tests__/no-silent-mutations.test.ts`.
  - Locale keys go into all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`.
  - Tests select by `data-testid`.
  - The portal app has no i18n, so its strings are English literals.
- **CPU budget** (host shared with other sessions):
  - Vitest runs with `--pool=forks --poolOptions.forks.maxForks=4`, on touched files only. For a sweep use `--changed origin/main`.
  - Run one `tsc` at a time, with `NODE_OPTIONS=--max-old-space-size=20480`. Check `echo "exit=$?"`, never `| tail`.
  - No background CI pollers.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The tenant changes hands** (feature RF2). Org A holds a proven mapping, and a proof run in org B (another partner) proves the same tenant. Expected:
   - On the next request, A's Entra browser sessions get 401 and A's add-in sessions get 401 (epoch).
   - A Microsoft sign-in by a person whose identity lives in A is denied, never placed in B.
   - A's partner admins get the displacement email.
   - An org override of `sso_only` in A falls back to `allowed`.

   *(Task 2: `proof run displaces a proven mapping in another partner's org and bumps epochs of that org's tenant identities`. Task 3: `sso_only falls back to allowed when the tenant proof is removed`. Task 5: `identity in org A whose tenant is now proven for org B → denied identity_other_org`. Task 6: `entra session dies when the org's proven tenant changes`.)*
2. **An add-in user opens the browser portal** (feature RF3). The identity exists with `browser_access='none'`. Expected:
   - `invited_only` denies.
   - `approval` creates an `addin_user` request referencing the account.
   - `instant` grants browser access **without** an epoch bump, so the add-in session keeps working.

   *(Task 5: the three `add-in account …` tests. Task 7: `instant grant leaves the add-in session valid`.)*
3. **A replayed or cross-browser callback.** Cases:
   - the same `state` used twice;
   - a callback without the binding cookie, or with another browser's cookie;
   - a mismatched nonce, or an id_token older than 10 min;
   - two concurrent callbacks for one proof-run link;
   - two orgs proving the same fresh tenant at once.

   Expected: each refused callback is `unavailable` / `failed`. Each concurrent pair records exactly one proof, and the losing org gets `failed`, never a 500.

   *(Task 4 state-store and verifier tests. Task 7: `callback replay → unavailable`, `callback from a different browser → unavailable`. Task 8: `concurrent proof callbacks record one proof`. Task 2: `two orgs proving one fresh tenant concurrently: one proof, the other TENANT_PROVEN_ELSEWHERE`.)*
4. **A policy change while sessions are outstanding** (feature RF4). Cases and expected results:
   - **`ssoSessionMaxHours` lowered from 12 to 1:** a 2 h-old Entra session dies on its next request.
   - **Microsoft turned off:** Entra sessions die.
   - **`sso_only` saved:** identity accounts lose their hash and bump their epoch, and password sessions die. Stranded accounts are listed and keep their hash.

   *(Task 6: `lowering the cap kills an older entra session on its next request`. Task 9: `saving sso_only clears hashes only for identity accounts and lists the stranded`, `PATCH without acknowledge → 409 with impact`.)*
5. **Two first sign-ins race.** Two concurrent instant-mode callbacks come from one person, or an invite is double-clicked through Microsoft. Expected: one account, one identity and one activation. The loser is denied generically, never a 500. *(Task 5 integration: `concurrent instant first sign-ins create one account`, `invite consumed twice via Microsoft activates once`.)*

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| Create `apps/api/migrations/2027-01-22-2330xx-portal-entra-tenant-proof.sql`; modify `apps/api/src/db/schema/clientAi.ts` | Proof columns, CHECKs, clear-on-repoint trigger | a |
| Modify `services/tenantExportPolicyRegistry.ts`; create `services/tenantExportPolicyRegistry.portalEntraProof.test.ts` | Export classification | a |
| Create `apps/api/src/config/portalEntra.ts` (+ test); modify `config/validate.ts`, `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` | Portal Entra app config | a |
| Create `services/portalEntraTenantProof.ts` (+ `.test.ts`); modify `services/orgMerge.ts` (blocker), `services/email.ts`, `services/emailDomains/mailPurposes.ts` (+ test) | Proof record, transfer, lookup, merge refusal, displacement email | a |
| Modify `services/portalAccessPolicy.ts`, `services/portalAccessPolicyWrites.ts`, `packages/shared/src/validators/portalAccessPolicy.ts` (+ tests) | Capability flip, tenant masking, `TENANT_NOT_PROVEN` | a |
| Create `services/portalOidc/stateStore.ts`, `services/portalOidc/entraClient.ts`, `services/portalOidc/types.ts` (+ tests); modify `services/m365ControlPlane/microsoftAuthorization.ts` (optional `scope`) | OIDC common layer + Entra client | a |
| Create `services/portalOidc/accountResolution.ts`, `services/portalIdentityAccounts.ts` (+ tests); modify `services/portalAccountState.ts`, `services/portalUserIdentities.ts`, `services/portalAccessRequests.ts`, `__tests__/portalAccountWriters.contract.test.ts` | §5.6 resolution, identity link with the W3 D4 fence, new state writers | a |
| Modify `routes/portal/browserSession.ts`, `routes/portal/auth.ts`, `routes/portal/schemas.ts`, `middleware/clientAiAuth.ts`, `routes/clientAi/schemas.ts` | Shared session mint, Entra session gate, absolute caps | a |
| Create `routes/portal/oidc.ts` (+ test); modify `routes/portal/index.ts`, `routes/portal/capabilityTokens.ts`, `routes/portal/branding.ts` (export host→org) | Portal sign-in routes (start, callback, discovery, invite methods, link status) | a |
| Create `routes/orgPortalEntraTenant.ts` (+ test); modify `routes/orgs.ts` | MSP tenant-proof routes; proof-run link | a |
| Create `services/portalSsoOnly.ts` (+ test); modify `routes/orgPortalAccessPolicy.ts`, `routes/orgPortalUsers.ts`, `services/email.ts` (`sendPortalInvite`) | `sso_only` impact/ack/clear, SSO invite variant, bulk SSO invite, MSP browser-access grant | a |
| Create integration tests `portalEntraTenantProofMigration`, `portalEntraTenantProof`, `portalOidcSignIn`, `portalSessionCaps`, `portalSsoOnly` (`*.integration.test.ts`; the `suite portal tests …/portal[!a-z0-9]*` glob in `.github/scripts/integration-suites.txt` already owns them); add `suite portal sources <file>` lines for new imported sources (W03a pattern) | Real-DB proofs | a |
| Modify `apps/web/src/components/settings/portalAccess/{types.ts,PortalAccessPolicyForm.tsx,OrgSignInRegistrationCard.tsx}`, `partnerSettings/PartnerCustomerPortalTab.tsx`; create `portalAccess/EntraTenantPanel.tsx`, `portalAccess/SsoOnlyConfirmDialog.tsx` (+ tests); locale keys | MSP UI | b |
| Modify `settings/OrgPortalUsersEditor.tsx` (+ test) | Grant browser access action, stranded list hook-up | b |
| Modify `apps/portal/src/components/portal/{LoginForm,AcceptInviteForm}.tsx`, the profile page component; create `apps/portal/src/components/portal/MicrosoftSignInButton.tsx`, `apps/portal/src/pages/entra-setup.astro`, `apps/portal/src/lib/oidc.ts` (+ tests); modify `apps/portal/src/middleware.ts` / `lib/protectedPaths.ts` as needed | Portal UI | b |
| Modify `apps/docs/src/content/docs/features/portal.mdx`, `apps/docs/src/content/docs/deploy/environment.mdx`; create `apps/docs/src/content/docs/features/portal-microsoft-sign-in.mdx`; regenerate `apps/api/src/data/docsIndex.json` | Docs | b |

---

## W04a — API

Test commands:
- Unit: run from `apps/api` with `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. Never use `pnpm --filter <pkg> test -- --run <path>`.
- Integration: run `pnpm test-stack up` first, then `npx vitest run -c vitest.integration.config.ts <file>`. Tear down with `pnpm test-stack down` and say so.
- Redis: tests run the in-memory fallback unless `PORTAL_STATE_BACKEND=redis`. Run the Lua race tests under the test stack's Redis.

### Task 1: Migration, Drizzle columns, export classification

**Files:**
- Create: `apps/api/migrations/2027-01-22-2330xx-portal-entra-tenant-proof.sql`
- Modify: `apps/api/src/db/schema/clientAi.ts:29-40`. Add `provenAt`, `provenVia` (`$type<PortalEntraProofVia>()`), `provenByUserId` and `provenEvidence` (`jsonb().$type<PortalEntraProofEvidence>()`).
- Modify: `services/tenantExportPolicyRegistry.ts:338`. Add `proven_at`, `proven_via` and `proven_by_user_id` to `included`, and `proven_evidence` to `excludedOpen`, since it is jsonb.
- Create: `services/tenantExportPolicyRegistry.portalEntraProof.test.ts`. This is the W2 pattern: it moves the classification failure into Test API.
- Test: `apps/api/src/__tests__/integration/portalEntraTenantProofMigration.integration.test.ts`. Template: `portalAccessPolicyMigration.integration.test.ts` (W3), which replays inside a rolled-back superuser transaction.

**Interfaces — Produces** (`db/schema/clientAi.ts`):
- `export type PortalEntraProofVia = 'm365_connection' | 'proof_run'`
- `export type PortalEntraProofEvidence = { via: 'proof_run'; adminOid: string; runId: string } | { via: 'm365_connection'; connectionId: string; profile: string }`

- [ ] **Step 1: Write the failing tests**

```ts
describe('2027-01-22-2330xx-portal-entra-tenant-proof.sql', () => {
  it('starts with the system-scope line');
  it('refuses proven_via "manual" (23514 client_ai_tenant_mappings_proven_via_chk)');
  it('refuses proven_at set with proven_via or proven_evidence NULL, and the reverse (23514 client_ai_tenant_mappings_proof_shape_chk)');
  it('changing entra_tenant_id on a proven row clears all four proof columns');                 // inv. 3
  it('an update that changes entra_tenant_id AND sets a new proven_at keeps the new proof');      // the D7 writer
  it('changing only updated_at (or org_id) keeps the proof');                                     // D8 merge adoption
  it('deleting the proving user nulls proven_by_user_id and keeps the proof');
  it('is idempotent: a second replay changes nothing');
});
// tenantExportPolicyRegistry.portalEntraProof.test.ts
it('classifies every client_ai_tenant_mappings column; proven_evidence is excludedOpen');
```

- [ ] **Step 2: Run them and verify they fail.** The integration test should fail with ENOENT on the migration path, and the export test with an unclassified-column error.
- [ ] **Step 3: Write the migration** (spec of record)

```sql
-- Portal registration W4: Entra tenant proof on the org's tenant mapping (spec §5.4, plan D1).
-- DDL only; system scope first per migrations/README. autoMigrate wraps the file: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.client_ai_tenant_mappings
  ADD COLUMN IF NOT EXISTS proven_at timestamptz,
  ADD COLUMN IF NOT EXISTS proven_via text,
  ADD COLUMN IF NOT EXISTS proven_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proven_evidence jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.client_ai_tenant_mappings'::regclass
                  AND conname = 'client_ai_tenant_mappings_proven_via_chk') THEN
    ALTER TABLE public.client_ai_tenant_mappings ADD CONSTRAINT client_ai_tenant_mappings_proven_via_chk
      CHECK (proven_via IS NULL OR proven_via IN ('m365_connection','proof_run'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.client_ai_tenant_mappings'::regclass
                  AND conname = 'client_ai_tenant_mappings_proof_shape_chk') THEN
    ALTER TABLE public.client_ai_tenant_mappings ADD CONSTRAINT client_ai_tenant_mappings_proof_shape_chk
      CHECK ((proven_at IS NULL) = (proven_via IS NULL) AND (proven_at IS NULL) = (proven_evidence IS NULL));
  END IF;
END $$;

-- inv. 3: a proof is about ONE tenant. Any writer that changes the tenant (e.g. the AI for
-- Office PUT /tenant-mapping upsert) drops the proof unless it records a new one itself.
CREATE OR REPLACE FUNCTION public.client_ai_tenant_mappings_clear_proof_on_repoint()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entra_tenant_id IS DISTINCT FROM OLD.entra_tenant_id
     AND NEW.proven_at IS NOT DISTINCT FROM OLD.proven_at THEN
    NEW.proven_at := NULL; NEW.proven_via := NULL; NEW.proven_by_user_id := NULL; NEW.proven_evidence := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS client_ai_tenant_mappings_clear_proof_on_repoint ON public.client_ai_tenant_mappings;
CREATE TRIGGER client_ai_tenant_mappings_clear_proof_on_repoint
  BEFORE UPDATE ON public.client_ai_tenant_mappings
  FOR EACH ROW EXECUTE FUNCTION public.client_ai_tenant_mappings_clear_proof_on_repoint();
```

- [ ] **Step 4: Update the Drizzle columns and the export entry.**
- [ ] **Step 5: Run the tests, the migration guards and the drift check**
  - The integration file → PASS.
  - `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/services/tenantExportPolicyRegistry.portalEntraProof.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts` → PASS. If `migrationPartnerExportLocks` names `client_ai_tenant_mappings`, add the pre-locks it asks for.
  - `DATABASE_URL=<test-stack url> pnpm db:check-drift` → exit 0.
- [ ] **Step 6: Commit**: `feat(portal): Entra tenant proof columns on the tenant mapping, cleared on repoint (W4)`

### Task 2: Tenant proof service, transfer, merge refusal, displacement email

**Files:**
- Create: `services/portalEntraTenantProof.ts`, `services/portalEntraTenantProof.test.ts` (unit, mocked db)
- Modify: `services/orgMerge.ts`. Four places need the new check, all keyed by both the loser and the survivor:
  - `collectMergeBlockers(loserOrgId, pamTransfer?, survivorOrgId?)`: a direct check after the `device_network_isolations` one (`:363`). It is used by the pre-fence call (`:1306`).
  - the Phase-B recheck: `assertMergeIsolationSafe` (`:1261`) and its caller (`:1420`) gain `survivorOrgId`;
  - the preview: its inline blocker list (`:1733`) runs the same check, so a preview never shows a mergeable pair that then refuses;
  - the code list: `MergeBlockerCode` (`:181`) gains `entra_tenant_conflict`. `mergeBlockerCodes` (`:190-199`) maps the `client_ai_tenant_mappings` blocker to it. `buildMergeBlockedMessage` (`:204+`) gets the operator text "Both organizations are linked to a Microsoft tenant and the merged-away one is proven. Remove one tenant link first."
- Modify: `services/email.ts`. Add `sendPortalEntraTenantDisplaced({ to, partnerName, orgName, tenantId })`. Template: `services/partnerTrustPartnerMail.ts`, which is platform mail to partner admins.
- Modify: `services/emailDomains/mailPurposes.ts` and its test. Register `'partner.portal_entra_tenant.displaced'` with the lane that `partnerTrustPartnerMail` uses.
- Test (real DB): `__tests__/integration/portalEntraTenantProof.integration.test.ts`. Also append the merge cases to `orgMergeRegistry.integration.test.ts`, or to whichever merge integration file holds the `device_network_isolations` blocker cases.

**Interfaces — Produces** (`services/portalEntraTenantProof.ts`):

```ts
export interface PortalEntraTenantStatus {
  tenantId: string | null;                 // the org's mapped tenant, if any
  state: 'none' | 'unproven' | 'proven';
  provenAt: string | null; provenVia: PortalEntraProofVia | null;
  connectionTenantId: string | null;       // tenant bound on the org's m365_connections row (identity-first, F13), if any
}
export async function getPortalEntraTenantStatus(orgId: string): Promise<PortalEntraTenantStatus>;
/** Resolver + session gate. No context held → opens withSystemDbAccessContext; else reads under the held context. */
export async function findProvenEntraTenantForOrg(orgId: string): Promise<{ tenantId: string; provenAt: Date } | null>;
/** Sign-in org resolution (spec §5.7): tid → org ONLY through a proven row. System context; never call inside a request transaction. */
export async function findOrgByProvenEntraTenant(tid: string): Promise<{ orgId: string; partnerId: string } | null>;
export type RecordEntraProofInput =
  | { orgId: string; tenantId: string; via: 'proof_run'; evidence: { adminOid: string; runId: string }; provenByUserId: string | null }
  | { orgId: string; tenantId: string; via: 'm365_connection'; evidence: { connectionId: string; profile: string }; provenByUserId: string };
export interface RecordEntraProofOutcome { displaced: { orgId: string; partnerId: string; wasProven: boolean; epochsBumped: number } | null }
export type PortalEntraProofErrorCode = 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE' | 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT'
  | 'PORTAL_ENTRA_NO_VERIFIED_CONNECTION' | 'PORTAL_ENTRA_PROTECTED_ORG';
export class PortalEntraProofError extends Error { constructor(readonly code: PortalEntraProofErrorCode, readonly httpStatus: 409 | 422, message: string); }
// PROTECTED_ORG → 409 with the existing PROTECTED_ORG_ERROR body (routes/clientAi/admin.ts:117); NO_VERIFIED_CONNECTION → 422; the rest → 409.
/** One withSystemDbAccessContext + withDbTransaction. Callers inside a request call it through runOutsideDbContext. */
export async function recordEntraTenantProof(input: RecordEntraProofInput, now?: Date): Promise<RecordEntraProofOutcome>;
export async function proveEntraTenantFromM365Connection(orgId: string, actorUserId: string): Promise<RecordEntraProofOutcome & { tenantId: string }>;
export async function removePortalEntraTenant(orgId: string): Promise<{ removed: boolean; tenantId: string | null }>;
```

Rules for `recordEntraTenantProof` (D7). All steps run in one transaction under system scope. That is justified: the evidence is verified, not MSP input, and displacement crosses partners.
1. **Holding org.** `isHoldingOrg(orgId)` → `PROTECTED_ORG` (409), the same refusal as `routes/clientAi/admin.ts:117`.
2. **Lock.**
   - First `pg_advisory_xact_lock(hashtext('portal-entra-tenant:' || $tid))` (D7).
   - Then `SELECT … FOR UPDATE` the mapping rows `WHERE org_id = $org OR entra_tenant_id = $tid`.
   - A 23505 on `client_ai_tenant_mappings_tenant_uniq` → `TENANT_PROVEN_ELSEWHERE`.
3. **Own row.** If this org's row has a different tenant → `ORG_HAS_OTHER_TENANT` (409).
4. **Another org's row for `$tid`.**
   - It is proven and `via = 'm365_connection'` → `TENANT_PROVEN_ELSEWHERE` (409). This is OD4.
   - Otherwise delete it.
   - `UPDATE portal_users SET auth_epoch = auth_epoch + 1, updated_at = now() WHERE org_id = $other AND EXISTS (identity provider='entra' AND entra_tenant_id = $tid)`. Count the rows.
   - Write the audit `organization.portal_identity_proof.displaced` on the other org, with `details { tenantId, displacedByOrgId, wasProven }`.
5. **Upsert this org's row.**
   - `onConflictDoUpdate({ target: orgId })`, setting `entraTenantId`, `provenAt: now`, `provenVia`, `provenByUserId`, `provenEvidence: { via, ...evidence }` and `updatedAt`.
   - `createdBy` is `provenByUserId` on insert.
   - Audit `organization.portal_identity_proof.proven` on this org.
6. **After commit.** For a displacement, `listActivePartnerAdmins(other.partnerId)` → `sendPortalEntraTenantDisplaced`. A send failure is logged and never undoes the proof.

`proveEntraTenantFromM365Connection` reads the org's `m365_connections` row where:
- `org_id = $org AND user_id IS NULL AND tenant_id IS NOT NULL`;
- `profile IN ('customer-graph-read','customer-graph-actions')`.

The bound `tenant_id` there is set only by the identity-first consent flow's finalization (spec F13; `applyConsentFinalizationResult`, `services/m365ControlPlane/connectionService.ts:~1042-1090`). With no such row → `NO_VERIFIED_CONNECTION` (422). Otherwise call `recordEntraTenantProof({ via: 'm365_connection', evidence: { connectionId, profile }, … })`.

- [ ] **Step 1: Write the failing tests**

```ts
// unit (portalEntraTenantProof.test.ts): error mapping + argument shapes
it('maps a holding org to PORTAL_ENTRA_PROTECTED_ORG without opening a transaction');
// integration (real DB, breeze_app + superuser seeding)
it('proof run on an unmapped tenant creates the proven mapping with evidence and audits proven');
it('proof run on the org\'s own unproven mapping proves it in place');
it('proof refused when the org maps a different tenant (409 ORG_HAS_OTHER_TENANT), nothing written');
it('proof run displaces an unproven mapping in another partner\'s org: row deleted, audits on both orgs');
it('proof run displaces a proven mapping in another partner\'s org and bumps epochs of that org\'s tenant identities'); // Review Focus 1
it('displacement leaves accounts without an identity in that tenant untouched (epoch unchanged)');
it('m365_connection proof cannot displace a proven mapping (409 TENANT_PROVEN_ELSEWHERE)');            // OD4
it('m365_connection proof uses the identity-bound tenant of the org\'s connection; no row → 422 NO_VERIFIED_CONNECTION');
it('findOrgByProvenEntraTenant ignores unproven mappings');                                         // inv. 2
it('the AI for Office PUT upsert to a new tenant leaves the mapping unproven');                         // inv. 3, via the real route
it('displacement emails the displaced partner\'s active admins after commit; a send failure keeps the proof');
it('two orgs proving one fresh tenant concurrently: one proof, the other TENANT_PROVEN_ELSEWHERE');      // Review Focus 3, D7
it('merge: a proof recorded between preview and execute is refused in Phase B (entra_tenant_conflict)');
// merge (append to the merge integration file)
it('merge refuses entra_tenant_conflict when the loser mapping is proven and the survivor has a mapping');
it('merge adopts a proven loser mapping when the survivor has none, keeping the proof');
it('merge drops an unproven loser mapping when the survivor has one (unchanged behaviour)');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement** the service, the merge blocker and the email.
- [ ] **Step 4: Run** the unit file, `src/services/orgMerge.test.ts`, `src/__tests__/parkedFanout.contract.test.ts`, `src/__tests__/dbTransactionPromiseAll.contract.test.ts`, `src/__tests__/portalAccountWriters.contract.test.ts` and `src/services/emailDomains/mailPurposes.test.ts`, plus both integration files.
  - The epoch bump writes `portal_users`, so classify `portalEntraTenantProof.ts` as `no-state` in the writer census.
  - All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): Entra tenant proof record, transfer rules, merge refusal and displacement email (W4)`

### Task 3: Portal Entra config, capability flip, resolver tenant masking

**Files:**
- Create: `apps/api/src/config/portalEntra.ts` and `portalEntra.test.ts`.
- Modify: `config/validate.ts` to add optional strings for the three env vars. Modify `.env.example`, `docker-compose.yml` and `deploy/docker-compose.prod.yml`, adding blank placeholders and passthrough next to `CLIENT_AI_ENTRA_CLIENT_ID`.
- Modify: `services/portalAccessPolicy.ts`.
  - `getPortalSignInCapabilities()` (already a function in W3, returning `capabilityOverride ?? DEPLOYMENT_CAPABILITIES`) computes `entra: getPortalEntraConfig() !== null` at call time instead of reading the frozen constant. The `__testOnly` override keeps precedence.
  - The resolver and pick gain the tenant fact.
- Modify: `services/portalAccessPolicyWrites.ts`. Org writes refuse an explicit `entraEnabled: true` without a proven tenant. The would-be-effective computation for `sso_only` passes the tenant fact.
- Modify: `packages/shared/src/validators/portalAccessPolicy.ts`. `PORTAL_ACCESS_POLICY_ERROR_CODES` gains `TENANT_NOT_PROVEN` and `SSO_ONLY_CONFIRM_REQUIRED`, and `PortalAccessPolicyView` gains `entraTenantProven: boolean | null`.
- Tests: `portalAccessPolicy.test.ts` and `portalAccessPolicyWrites.test.ts`. Append to `portalAccessPoliciesPartnerRls.integration.test.ts`.

**Interfaces:**
- Consumes: the Task 1 proof columns. The resolver reads them in its one query. `findProvenEntraTenantForOrg` (Task 2) is used by the org view builder and by the write validation.
- Produces:

```ts
// config/portalEntra.ts
export interface PortalEntraConfig { clientId: string; clientSecret: string; callbackUrl: string; consentReturnUrl: string }
/** null unless PORTAL_ENTRA_CLIENT_ID and PORTAL_ENTRA_CLIENT_SECRET are both non-empty. Callback base per D4. Throws on a malformed base URL. */
export function getPortalEntraConfig(): PortalEntraConfig | null;

// services/portalAccessPolicy.ts (changes)
export interface PortalPolicyOrgFacts { entraTenantProven: boolean }
export function pickEffectivePortalAccessPolicy(org, partner, caps, facts: PortalPolicyOrgFacts): /* unchanged return */;
export interface ResolvedPortalAccessPolicy { /* W3 fields */ entraTenant: { tenantId: string; provenAt: string } | null }
```

Rules:
- **Masking order.** Pick, then capability mask, then tenant mask (`entraEnabled = picked && caps.entra && facts.entraTenantProven`), then W3's `sso_only` fallback. The source stays the picked source.
- **Partner views** and partner would-be-effective computations pass `{ entraTenantProven: true }`.
- **No extra round trip.** W3's resolver already reads `organizations` for `partner_id` before `readPortalAccessPolicyRows`. Add the proven mapping to **that** read: `organizations o LEFT JOIN client_ai_tenant_mappings m ON m.org_id = o.id AND m.proven_at IS NOT NULL`.
  - Do not join it onto the policy-rows query. That query returns no rows when there are no policy rows, which would hide a proven tenant.
  - `readPortalAccessPolicyRows` is shared with the settings views, so leave it unchanged.
- **The fingerprint** includes `entraTenant?.tenantId`, so W6 tokens die when the tenant changes.
- **Write validation for org writes.** `patch.entraEnabled === true` while the org has no proven tenant → `PortalAccessPolicyValidationError(TENANT_NOT_PROVEN, 'entraEnabled', 'Prove the organization\'s Microsoft tenant before turning on Microsoft sign-in.')`.

- [ ] **Step 1: Write the failing tests**

```ts
// portalEntra.test.ts
it('returns null when either env var is empty; builds both fixed URIs from PORTAL_ENTRA_CALLBACK_BASE_URL else PUBLIC_URL');
// portalAccessPolicy.test.ts (pure)
it('getPortalSignInCapabilities().entra follows the portal Entra config');
it('entra on (org row) but no proven tenant → effective false with source org');
it('sso_only falls back to allowed when the tenant proof is removed');                    // Review Focus 1
it('fingerprint changes when the proven tenant changes');
it('an org with a proven tenant and NO policy rows resolves entraTenant (not hidden by the rows query)');
// portalAccessPolicyWrites.test.ts
it('org entraEnabled true without a proven tenant → 400 TENANT_NOT_PROVEN (field entraEnabled)');
it('org passwordMode sso_only is refused (SSO_ONLY_NEEDS_SSO) when entra is inherited on but the tenant is unproven');
it('partner entraEnabled true is accepted with caps.entra regardless of any org tenant');
// integration (portalAccessPoliciesPartnerRls)
it('resolves entraTenant under portalOrgDbAccessContext and with no context held');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Fix every W3 test that hard-codes the all-false capabilities to go through `__testOnly.setCapabilities` instead.
- [ ] **Step 4: Run** `src/config/portalEntra.test.ts`, `src/services/portalAccessPolicy.test.ts`, `src/services/portalAccessPolicyWrites.test.ts` and `src/routes/orgPortalAccessPolicy.test.ts`; `cd packages/shared && npx vitest run src/validators/portalAccessPolicy.test.ts`; and the integration file. All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): flip the entra capability on portal app config and mask Microsoft by tenant proof (W4)`

### Task 4: OIDC common layer and the Entra client

**Files:**
- Create: `services/portalOidc/types.ts`, `services/portalOidc/stateStore.ts`, `services/portalOidc/entraClient.ts`
- Create tests: `services/portalOidc/stateStore.test.ts` and `services/portalOidc/entraClient.test.ts`. Use a local `jose` key pair injected as `verificationKey`, the pattern in `ticketMailbox/microsoftIdentity.ts`, and an injected `fetch`. No test touches the network.
- Modify: `services/m365ControlPlane/microsoftAuthorization.ts:34,80-101`. `IdentityAuthorizationUrlInput` gains `scope?: string`, default `'openid profile'`. Existing callers are unchanged.
- Modify: `routes/portal/schemas.ts`, adding `PORTAL_REDIS_KEYS.oidcState(hash)` and `.entraProofRun(hash)`. Modify `routes/portal/helpers.ts` to add the in-memory maps, capped with `capMapByOldest`.

**Interfaces — Produces:**

```ts
// services/portalOidc/types.ts
export type PortalOidcProvider = 'entra';                                  // W7 adds 'google'
export type PortalOidcPurpose =
  | { kind: 'login' }
  | { kind: 'invite'; inviteTokenHash: string }
  | { kind: 'link'; portalUserId: string; orgId: string; authEpoch: number }
  | { kind: 'tenant_proof'; runTokenHash: string; orgId: string; expectedTenantId: string | null };
export interface PortalOidcState { v: 1; provider: PortalOidcProvider; purpose: PortalOidcPurpose; nonce: string; codeVerifier: string;
  bindingHash: string; hostOrgId: string | null; authority: string; createdAt: number }
/** Field names match ClientAiEntraClaims (clientAiEntraJwt.ts) so resolveLinkableEntraAddress accepts it structurally:
 *  `emailClaim` is the raw email claim (trusted only with emailDomainOwnerVerified), never a linking key. */
export interface PortalOidcVerifiedIdentity { provider: PortalOidcProvider; issuer: string; subject: string; entraTenantId: string | null;
  upn: string | null; emailClaim: string | null; emailDomainOwnerVerified: boolean; name: string | null }

// services/portalOidc/stateStore.ts
export const PORTAL_OIDC_STATE_TTL_SECONDS = 600;
export const PORTAL_OIDC_BINDING_COOKIE = 'breeze_portal_oidc';
/** Mints state + nonce + PKCE, stores the record, returns what the authorize URL and the Set-Cookie need. */
export async function createPortalOidcState(input: { provider: PortalOidcProvider; purpose: PortalOidcPurpose; hostOrgId: string | null; authority: string }):
  Promise<{ state: string; nonce: string; codeChallenge: string; bindingCookie: string }>;
/** GET+DEL by sha256(state); then constant-time compare of sha256(cookie) with bindingHash. Any miss → null (state is gone either way). */
export async function consumePortalOidcState(rawState: string, bindingCookieValue: string | undefined): Promise<PortalOidcState | null>;
export function buildPortalOidcBindingCookie(value: string, opts: { secure: boolean }): string;
export function buildClearPortalOidcBindingCookie(opts: { secure: boolean }): string;

// services/portalOidc/entraClient.ts
export const PORTAL_ENTRA_SIGN_IN_SCOPE = 'openid profile email';
export const PORTAL_ENTRA_PROOF_SCOPE = 'openid profile Directory.Read.All';   // OD2
export function buildPortalEntraAuthorizeUrl(cfg: PortalEntraConfig, input: { authority: string; scope: string; state: string; nonce: string; codeChallenge: string }): string; // wraps buildMicrosoftIdentityAuthorizationUrl
export function buildPortalAppAdminConsentUrl(cfg: PortalEntraConfig, tenantId: string): string;  // v2 /{tid}/v2.0/adminconsent, scope = PORTAL_ENTRA_SIGN_IN_SCOPE (D6)
export async function exchangePortalEntraCode(cfg: PortalEntraConfig, input: { authority: string; code: string; codeVerifier: string },
  deps?: { fetch?: typeof fetch }): Promise<{ idToken: string; accessToken: string | null }>;
export class PortalEntraTokenError extends Error { constructor(readonly check: string); }   // check is server-side only; never token content
export async function verifyPortalEntraIdToken(idToken: string, expected: { clientId: string; nonce: string; expectedTenantId: string | null; now?: Date },
  deps?: { verificationKey?: CryptoKey }): Promise<PortalOidcVerifiedIdentity & { entraTenantId: string }>;
```

Rules:
- **State** is a JSON value under `PORTAL_REDIS_KEYS.oidcState(sha256(state))`, written with `setex` for the TTL. Consume uses the W2 capability Lua script (`capabilityTokens.ts:~95`): extract it to a shared `luaGetDel(redis, key)` in `routes/portal/helpers.ts`, and keep the capability tokens on it.
- **The binding cookie value** is 32 random bytes in base64url. `bindingHash = sha256(value)`, and the comparison uses `timingSafeEqual`.
- **The code exchange** posts to `/{authority}/oauth2/v2.0/token` with `client_secret`. Any non-2xx or malformed body throws `PortalEntraTokenError('token_endpoint')`. Log the status only (D14).
- **id_token verification** follows the Global Constraints list exactly.
  - `emailClaim` is set only when the claim is present.
  - `emailDomainOwnerVerified` is `xms_edov === true`.
  - `upn` is `preferred_username`, lowercased.

- [ ] **Step 1: Write the failing tests**

```ts
// stateStore.test.ts (in-memory backend + one real-Redis case under the test stack)
it('consumes a state exactly once');                                                        // Review Focus 3
it('a wrong or missing binding cookie returns null and still burns the state');             // Review Focus 3
it('expires after 600 s');
it('two concurrent consumes on real Redis: exactly one wins');
it('stores only sha256 of the state and of the binding value');
// entraClient.test.ts
it('authorize URL: organizations authority, openid profile email, S256, response_mode query, prompt select_account');
it('admin consent URL is v2 adminconsent for the tenant with scope openid profile email');
it('verify accepts a well-formed token and returns issuer = entraIssuer(tid), subject = oid');
it.each([
  ['wrong audience'], ['issuer for another tenant'], ['nonce mismatch'], ['iat older than 10 minutes'],
  ['tid is the consumer tenant'], ['idp is another tenant (guest)'], ['acct = 1'], ['missing oid'], ['oid not a GUID'], ['ver 1.0'], ['HS256 algorithm'],
])('verify refuses: %s');                                                                   // inv. 13, Review Focus 3
it('verify refuses a tid different from expectedTenantId when one is pinned');
it('verify accepts a token with no acct and no idp claim (structural guest rule; documented)');
it('token endpoint 400 throws PortalEntraTokenError without logging the body');
it('buildMicrosoftIdentityAuthorizationUrl without scope still sends "openid profile"');   // existing callers
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both new test files, the existing `microsoftAuthorization` tests and `src/routes/portal/capabilityTokens.test.ts`, which proves the Lua extraction. All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): OIDC state store and Entra client for portal sign-in (W4)`

### Task 5: State writers, identity linking with the W3 D4 fence, account resolution (§5.6)

**Files:**
- Modify `services/portalAccountState.ts` and its `.test.ts`:
  - New writers: `'sso_invite_accept'`, `'sso_instant_grant'` and `'msp_grant_browser_access'`.
  - New initial state: `'sso_instant'`.
- Modify `services/portalUserIdentities.ts` to add `linkPortalUserIdentity`.
- Create `services/portalIdentityAccounts.ts` (+ `.test.ts`).
  - Extract and rewrite W3's private `createIdentityAccount(request: LockedRequest, deciderUserId)` from `services/portalAccessRequests.ts` as `createIdentityOnlyAccount(tx, input)`, so approve and instant mode share one writer.
  - The W3 original is bound to a locked request row, uses the module `db`, and throws `PortalAccessRequestError`. The new function takes the transaction and returns a discriminated outcome.
  - The approve path then maps `account_exists` → `ACCOUNT_EXISTS` and `identity_linked` → `IDENTITY_LINKED`. Its behaviour must stay byte-identical.
- Create `services/portalOidc/accountResolution.ts` (+ `.test.ts`).
- Modify `__tests__/portalAccountWriters.contract.test.ts`: classify `portalIdentityAccounts.ts` and `portalOidc/accountResolution.ts` as `state-module`.
- Test (real DB): `__tests__/integration/portalOidcSignIn.integration.test.ts`.

**Interfaces:**
- Consumes:
  - Task 2 `findOrgByProvenEntraTenant`; Task 3 `resolvePortalAccessPolicy`;
  - W3 `createPortalAccessRequest`, `portalUserHasIdentitySql`;
  - `getActiveOrgTenant` (`services/tenantStatus.ts:128`), `resolveLinkableEntraAddress` (`services/clientAiEntraAddress.ts:58`);
  - `lockPortalInviteAddresses` (`services/contacts/portalInvite.ts:220`), `linkLoginToContact` (`services/contacts/loginLink.ts:106`);
  - W2 `consumePortalCapabilityToken` / `validatePortalCapability` via the Task 7 additions `consumePortalCapabilityTokenByHash` and `{ requirePasswordMethod: false }`. Task 5 calls them through an injected `inviteConsumer` so it does not depend on Task 7's file. Task 7 wires the real ones.
- Produces:

```ts
// services/portalAccountState.ts (additions)
export type PortalAccountWriter = /* W2 + W3 */ | 'sso_invite_accept' | 'sso_instant_grant' | 'msp_grant_browser_access';
// Aliases, not new rules: 'sso_instant_grant' and 'msp_grant_browser_access' share W3's 'access_request_approve' case
// (active+none → granted, no epoch bump; disabled/invited refused); initialPortalAccountState('sso_instant') shares
// 'sso_request_approved' ({ active, granted }). Separate names exist only so the writer census and audits say which path wrote.
// initialPortalAccountState('sso_instant') → { active, granted }   (caller sets auth_method = provider; identity-only, W3 D2)
// planPortalAccountTransition rows:
//   sso_invite_accept:        invited+granted → { active, granted, bumpEpoch: true }   (same epoch rule as accept_invite); anything else → REFUSED
//   sso_instant_grant:        active+none → { active, granted, bumpEpoch: false }; active+granted → unchanged; invited/disabled → REFUSED
//   msp_grant_browser_access: same rows as sso_instant_grant; 409 messages 'This user is disabled. Reactivate them first.' / 'This user has a pending invite.'

// services/portalUserIdentities.ts
export type LinkIdentityResult = { kind: 'linked' } | { kind: 'conflict' };   // (issuer,subject) or (user,provider) already taken
/** One INSERT … ON CONFLICT DO NOTHING RETURNING; on success, for entra, also writes portal_users.entra_tenant_id/entra_oid
 *  (W3 D4 writer fence) and, when clearPasswordHash, password_hash = NULL. Runs on the caller's transaction. */
export async function linkPortalUserIdentity(tx: IdentityExecutor, input: { orgId: string; portalUserId: string; provider: 'entra';
  tid: string; oid: string; linkedVia: 'invite' | 'self_link' | 'jit'; clearPasswordHash: boolean; now: Date }): Promise<LinkIdentityResult>;

// services/portalIdentityAccounts.ts
export async function createIdentityOnlyAccount(tx: DbTx, input: { orgId: string; partnerId: string; provider: 'entra'; tid: string; oid: string;
  email: string; name: string | null; contactAddress: string | null; writer: 'sso_request_approved' | 'sso_instant'; now: Date }):
  Promise<{ kind: 'created'; portalUserId: string; authEpoch: number } | { kind: 'account_exists' } | { kind: 'identity_linked' }>;

// services/portalOidc/accountResolution.ts
export type PortalOidcDenyReason = 'org_unresolved' | 'host_mismatch' | 'org_unavailable' | 'method_off' | 'identity_other_org'
  | 'identity_conflict' | 'account_inactive' | 'invited_only' | 'invite_invalid' | 'link_invalid' | 'requests_capped';
export type PortalOidcSignInOutcome =
  | { kind: 'session'; portalUserId: string; orgId: string; authEpoch: number; entraTenantId: string; via: 'identity' | 'invite' | 'instant' | 'instant_grant' }
  | { kind: 'linked'; portalUserId: string; orgId: string }
  | { kind: 'request_sent'; orgId: string }
  | { kind: 'account_exists'; orgId: string }
  | { kind: 'denied'; reason: PortalOidcDenyReason; orgId: string | null };
export async function resolvePortalOidcSignIn(input: {
  identity: PortalOidcVerifiedIdentity & { entraTenantId: string };
  purpose: Exclude<PortalOidcPurpose, { kind: 'tenant_proof' }>;
  hostOrgId: string | null;
  inviteConsumer: (inviteTokenHash: string) => Promise<{ portalUserId: string; orgId: string; authEpoch: number } | null>;
  now?: Date;
}): Promise<PortalOidcSignInOutcome>;
```

Resolution order. It is spec §5.6, and every branch is a test:
0. **Org.**
   - `findOrgByProvenEntraTenant(tid)` returns nothing → `org_unresolved`.
   - `hostOrgId` is set and ≠ the org → `host_mismatch`.
   - `getActiveOrgTenant` fails → `org_unavailable`.
   - `!isSignInMethodAllowed(await resolvePortalAccessPolicy(org), 'entra')` → `method_off`.
   - For `link`, `purpose.orgId` must equal the resolved org, else `link_invalid`.
1. **Identity found** by `(entraIssuer(tid), oid)`.
   - It is in another org → `identity_other_org` (inv. 4).
   - For `invite`/`link` whose target is a different account → `identity_conflict` (D11).
   - For `link` on the same account → `linked`, which is idempotent.
   - The account is not `active` → `account_inactive`.
   - `browser_access='granted'` → touch `last_used_at`, and while the org is effectively `sso_only` also null `password_hash` with no epoch bump (D12 lazy convergence). Then `session` (`via: 'identity'`).
   - `browser_access='none'` is step 5.
2. **`invite`.**
   - `inviteConsumer(hash)` returns nothing, its org ≠ the resolved org, or the account already has an entra identity → `invite_invalid`.
     - The token is consumed **before** the transaction, the same as password accept-invite (W2). Any later failure has therefore spent it, and the MSP resends. "Rolled back" below covers database writes only.
   - Otherwise, in one transaction:
     - `linkPortalUserIdentity` with `linkedVia 'invite'` and `clearPasswordHash` = (effective `sso_only`, D12);
     - `sso_invite_accept`, with an `auth_epoch = <payload epoch>` guard;
     - a `conflict` result → `identity_conflict`, rolled back.
   - Result: `session` (`via: 'invite'`).
3. **`link`.** Load `purpose.portalUserId`. It must be active, granted, same org and same `authEpoch`, with no entra identity. Otherwise → `link_invalid`. Then `linkPortalUserIdentity` (`'self_link'`, `clearPasswordHash` as above) → `linked`.
4. **New person.** Only for `login` with no identity.
   - The address is the D10 rule. Any account in the org whose `lower(email)` equals the UPN or the linkable email → `account_exists`.
   - Then `ssoNewPersonMode`:
     - `invited_only` → `invited_only`;
     - `approval` → `createPortalAccessRequest({ source: 'entra', … })`. `created`/`already_pending` → `request_sent`; `capped` → `requests_capped`;
     - `instant` → `createIdentityOnlyAccount(writer 'sso_instant')`. `created` → `session` (`via: 'instant'`); `account_exists` → `account_exists`; `identity_linked` → retry step 1 once, then `identity_conflict`.
5. **Add-in account** (identity found, `browser_access='none'`):
   - `invited_only` → `invited_only`;
   - `approval` → `createPortalAccessRequest({ source: 'addin_user', portalUserId, … })` → `request_sent`;
   - `instant` → `sso_instant_grant` with no epoch bump → `session` (`via: 'instant_grant'`).

Context rules:
- The callback holds no DB context. Resolution opens `withSystemDbAccessContext` for reads, and one `withDbTransaction` per write branch.
- `createPortalAccessRequest` opens its own isolated system context, so call it **outside** any transaction this function holds.
- No `Promise.all` inside transactions.

- [ ] **Step 1: Write the failing tests**

```ts
// portalAccountState.test.ts — the rows above (it.each), plus initialPortalAccountState('sso_instant')
// portalUserIdentities.test.ts
it('linkPortalUserIdentity writes the identity and entra_* columns together; conflict writes neither');
it('clearPasswordHash nulls password_hash in the same statement set');
// accountResolution.test.ts (unit, mocked collaborators) — one test per branch name above
// integration (portalOidcSignIn.integration.test.ts, real DB, proven tenant seeded)
it('known identity in the org with browser access → session');
it('identity in org A whose tenant is now proven for org B → denied identity_other_org');          // Review Focus 1, inv. 4
it('unproven mapping for the tid → denied org_unresolved');                                         // inv. 2
it('new person with an existing same-email account → account_exists and no link is created');      // inv. 5
it('approval mode creates an entra request with issuer/subject/tid and no account');
it('instant mode creates an active, granted, identity-only account with entra_* columns and a contact link');
it('add-in account, invited_only → denied');                                                        // Review Focus 2
it('add-in account, approval → addin_user request referencing the account');                        // Review Focus 2
it('add-in account, instant → browser granted without an epoch bump');                              // Review Focus 2
it('invite via Microsoft activates the invited account, links (linked_via invite) and keeps auth_method password'); // D13
it('invite for another account than the identity\'s → identity_conflict, invite not consumed');      // D11
it('link adds self_link to a signed-in password user; under sso_only it also clears the hash');      // D12
it('known identity signing in while the org is effectively sso_only (via a proof, no PATCH) loses its hash, epoch unchanged'); // D12
it('invite consumed, then the identity link conflicts → invite spent, no account change, invite_invalid');
it('concurrent instant first sign-ins create one account');                                         // Review Focus 5
it('invite consumed twice via Microsoft activates once; the second → invite_invalid');              // Review Focus 5
it('W3 approve of an entra request still passes after createIdentityOnlyAccount moved');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** The move of `createIdentityOnlyAccount` must leave `portalAccessRequests.integration.test.ts` green unchanged.
- [ ] **Step 4: Run**
  - Unit: `portalAccountState.test.ts`, `portalUserIdentities.test.ts`, `portalIdentityAccounts.test.ts`, `portalOidc/accountResolution.test.ts`, `portalAccessRequests.test.ts`, `__tests__/portalAccountWriters.contract.test.ts`, `__tests__/dbTransactionPromiseAll.contract.test.ts`, `__tests__/parkedFanout.contract.test.ts`.
  - Integration: `portalOidcSignIn`, `portalAccessRequests`, `portalUserIdentities`.
  - All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): OIDC account resolution with invitation- and session-bound linking, never by email (W4)`

### Task 6: Shared session mint, Entra session gate, absolute caps

**Files:**
- Modify `routes/portal/browserSession.ts` (+ test) to add `mintPortalBrowserSession` and extend the parse and the gate.
- Modify `routes/portal/auth.ts`. Use `mintPortalBrowserSession` at the login mint (`:519-570`) and the accept-invite mint (`:857-875`), with byte-identical behaviour. Pass `Date.now()` into the policy gate.
- Modify `routes/portal/schemas.ts`. `PortalSession` gains `entraTenantId?: string`.
- Modify `middleware/clientAiAuth.ts` (the cap check goes after the epoch check at `:86-94`, before the sliding `expire` at `:124-129`), `routes/clientAi/schemas.ts` (`CLIENT_AI_SESSION_MAX_AGE_SECONDS`), and `middleware/clientAiAuth.test.ts`.
- Test (real DB + router): `__tests__/integration/portalSessionCaps.integration.test.ts`.

**Interfaces — Produces** (`routes/portal/browserSession.ts`):

```ts
export interface StoredPortalSession { portalUserId: string; orgId: string; authEpoch: number; method: PortalSessionMethod;
  createdAtMs: number | null; entraTenantId: string | null }
/** entra: createdAt must parse and entraTenantId must be a GUID, else null. password: both optional (pre-W4 payloads). */
export function parseStoredPortalSession(raw: unknown): StoredPortalSession | null;
export function isBrowserSessionAllowed(session: Pick<StoredPortalSession, 'method' | 'createdAtMs' | 'entraTenantId'>,
  user: { authMethod: string; browserAccess: string },
  policy: Pick<ResolvedPortalAccessPolicy, 'effective' | 'entraTenant'>, nowMs: number): boolean;
/** Writes portal:session:{token} {portalUserId, orgId, authEpoch, method, createdAt, entraTenantId?} (setex 24 h), sadd
 *  portal:user-sessions:{id}, the in-memory twin, and the session + CSRF cookies. */
export async function mintPortalBrowserSession(c: Context, input: { portalUserId: string; orgId: string; authEpoch: number;
  method: PortalSessionMethod; entraTenantId?: string }): Promise<{ token: string }>;
```

Rules:
- **`entra` sessions** additionally need `policy.entraTenant?.tenantId === session.entraTenantId` and `nowMs - createdAtMs < effective.ssoSessionMaxHours.value * 3_600_000`.
- **`password` sessions** are unchanged: no absolute cap.
- **The middleware** keeps its purge and 401 `'Invalid or expired session'` for any refusal.
- **Add-in:** after the epoch check, `Date.parse(payload.createdAt)` is NaN or older than `CLIENT_AI_SESSION_MAX_AGE_SECONDS` → purge the session and return the existing 401. The add-in middleware still reads no portal policy (inv. 9).

- [ ] **Step 1: Write the failing tests**

```ts
// browserSession.test.ts
it('parses a pre-W4 password payload (no entraTenantId) unchanged');
it('refuses an entra payload without createdAt or with a non-GUID entraTenantId');
it('entra session allowed inside the cap with the matching proven tenant');
it('entra session refused at exactly ssoSessionMaxHours');
it('entra session refused when the policy\'s proven tenant differs');
it('password session has no absolute cap');
// auth.test.ts / acceptInvite.test.ts
it('login and accept-invite still mint the same Redis payload and cookies (method password, createdAt)');
// clientAiAuth.test.ts
it('add-in session older than 12 h → 401 and purge; younger → passes');
it('add-in session with an unparseable createdAt → 401');
// integration (portalSessionCaps)
it('lowering the cap kills an older entra session on its next request');                 // Review Focus 4
it('entra session dies when the org\'s proven tenant changes');                         // Review Focus 1
it('entra session dies on the next request after entra is turned off');                 // Review Focus 4
it('an entra session never satisfies a password-only gate and vice versa');             // inv. 9
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `browserSession.test.ts`, `auth.test.ts`, `auth.logout.test.ts`, `acceptInvite.test.ts`, `authOrgStatusGate.test.ts`, `middleware/clientAiAuth.test.ts` and `routes/clientAi/auth.test.ts`, plus the integration files `portalSessionCaps`, `portalAccessPolicyEnforcement`, `portalAuthEpoch` and `portalLogoutRevocation`. All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): entra browser sessions with tenant pin and absolute cap; add-in absolute cap (W4)`

### Task 7: Portal sign-in routes

**Files:**
- Create `routes/portal/oidc.ts` and `routes/portal/oidc.test.ts` (unit, collaborators mocked).
- Modify `routes/portal/index.ts`. Mount `oidcRoutes` beside `authRoutes`. The `link` start and `link-status` need `portalAuthMiddleware`, so mount them under `/auth/oidc/entra/link*` with `portalRoutes.use(…, portalAuthMiddleware)`.
- Modify `routes/portal/capabilityTokens.ts`:
  - `consumePortalCapabilityTokenByHash(purpose, hash)`;
  - `peekPortalCapabilityToken(purpose, raw)`, a GET with no DEL;
  - `validatePortalCapability(purpose, consumed, opts?: { requirePasswordMethod?: boolean })`. The default `true` keeps every W3 caller unchanged.
- Modify `routes/portal/branding.ts`. Export `resolvePortalHostOrgId(host: string): Promise<string | null>`, built on `resolveBrandingByDomain`: a verified custom domain gives its org id, anything else null. The caller passes the request's `Host` header with the port stripped and lowercased (D5). Never use a client-supplied body or query value.
- Test (real DB + router): append to `portalOidcSignIn.integration.test.ts`.

**Interfaces — Produces** (all under `/api/v1/portal`):

| Method + path | Auth | Behaviour |
|---|---|---|
| `GET /auth/methods` | public | `{ password: boolean, microsoft: boolean }`. Shared host: `{ password: true, microsoft: caps.entra }`, a constant that reveals nothing. Verified custom domain: that org's `isSignInMethodAllowed`. |
| `POST /auth/oidc/entra/start` body `{ purpose: 'login' } \| { purpose: 'invite', inviteToken }` | public, start limiter | `{ redirectUrl }` plus the binding cookie. `invite`: the token is peeked and validated with `requirePasswordMethod: false`, and the state stores its hash. An invalid token → 400 `'Invalid or expired invite'`. Not configured → 404. |
| `POST /auth/oidc/entra/link/start` | `portalAuthMiddleware` + CSRF | `{ redirectUrl }`. The state purpose is `link` with the session's user, org and epoch. |
| `GET /auth/oidc/entra/link-status` | `portalAuthMiddleware` | `{ available: boolean, linked: boolean }` |
| `POST /auth/invite/methods` body `{ token }` | public, accept limiter | `{ password: boolean, microsoft: boolean }` via peek. An invalid token, or both false → 400 `'Invalid or expired invite'` (uniform). |
| `GET /auth/oidc/entra/callback` | public, callback limiter | Steps below. Always 302, and always clears the binding cookie. |
| `GET /auth/oidc/entra/consent-return` | public | 302 → `/entra-setup?status=consent_done`. Reads no parameter as authority (D6). |

Callback steps:
1. Microsoft returned `error`, `code`/`state` is missing, or there are unexpected duplicate keys → `unavailable`. Use the strict-parse approach of `parseM365ConsentCallbackQuery` (`m365ConsentCallback.ts:247`).
2. `consumePortalOidcState(state, cookie)` returns nothing → `unavailable`.
3. `exchangePortalEntraCode`, then `verifyPortalEntraIdToken`, with `expectedTenantId` taken from a `tenant_proof` purpose. Any throw → `unavailable`.
4. A `tenant_proof` purpose goes to Task 8's handler.
5. Otherwise `resolvePortalOidcSignIn`, with the real invite consumer: `consumePortalCapabilityTokenByHash` + `validatePortalCapability(…, { requirePasswordMethod: false })`.
6. Map the outcome:
   - `session` → `mintPortalBrowserSession({ method: 'entra', entraTenantId })` → `/login?sso=signed_in`.
   - `linked` → `/profile?sso=linked`.
   - `request_sent` and `account_exists` → their codes.
   - `denied` → `unavailable` (link purpose: `/profile?sso=unavailable`).
7. Audit `portal.auth.oidc.login`, or `portal.auth.identity.link` for `linked` and for invite activations. Use `resourceType: 'portal_user'` where an account is known, and the resolved org or null.

- [ ] **Step 1: Write the failing tests**

```ts
// oidc.test.ts
it('methods on the shared host is constant and independent of any org');                      // inv. 8
it('start login sets the Lax binding cookie on the oidc path and returns an organizations authorize URL');
it('start invite with an invalid token → 400 Invalid or expired invite (same body as accept-invite)');
it('start returns 404 when the portal Entra app is not configured');
it('link/start requires a portal session and CSRF');
it('callback replay → unavailable');                                                          // Review Focus 3
it('callback from a different browser → unavailable');                                         // Review Focus 3
it('callback with error=access_denied or an extra query key → unavailable');
it('callback maps every denied reason to the same redirect and writes the reason only to audit'); // D15
it('callback session outcome mints an entra session and redirects to /login?sso=signed_in');
it('invite methods: sso_only org → { password: false, microsoft: true }; both off → 400');
it('consent-return ignores admin_consent/tenant params');
// integration (append)
it('end-to-end: start → callback (stubbed token endpoint + local JWKS key) → portal session works on /portal/profile');
it('instant grant leaves the add-in session valid');                                           // Review Focus 2
it('custom-domain host for org A + token for tenant proven in org B → unavailable (host_mismatch)'); // inv. 1
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `oidc.test.ts`, `capabilityTokens.test.ts`, `auth.test.ts`, `acceptInvite.test.ts` and `routes/portal/portalSectionGates.contract.test.ts`, plus the integration files `portalOidcSignIn`, `portalCapabilityTokens`, `portalUserInvite` and `portal-routes-rls`. All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): Sign in with Microsoft routes — start, callback, invite methods, link (W4)`
- [ ] **Step 6 (gated, OD5): delete the W2 legacy-invite branch.** Do this only if the dispatch brief confirms #11408 has been in production in every region for at least 7 days and W3 did not already delete it. The steps are the W3 plan's Task 6 Step 6, committed as `chore(portal): drop the pre-W2 legacy invite token branch (W2 D3)`. Otherwise skip it and add the deletion to the W5 plan's carry-over list.

### Task 8: Tenant proof routes and the proof-run link

**Files:**
- Create `routes/orgPortalEntraTenant.ts` and `routes/orgPortalEntraTenant.test.ts`. Modify `routes/orgs.ts` to call `registerPortalEntraTenantRoutes(orgRoutes)` next to `registerPortalAccessPolicyRoutes`.
- Modify `routes/portal/oidc.ts`, adding the proof-run start and the `tenant_proof` callback branch.
- Test (real DB): append to `portalEntraTenantProof.integration.test.ts`.

**Interfaces — Produces:**

| Method + path | Middleware | Response |
|---|---|---|
| `GET /orgs/organizations/:id/portal-entra-tenant` | `requireScope('partner','system')`, `requireOrgRead` | `{ data: PortalEntraTenantStatus & { consentUrl: string \| null } }`. `consentUrl` = `buildPortalAppAdminConsentUrl` for a proven tenant. Not configured → 404 `PORTAL_ENTRA_NOT_CONFIGURED`. |
| `POST /orgs/organizations/:id/portal-entra-tenant/prove-from-connection` | partner/system scope, `requireOrgWrite`, `requireMfa()` | `{ data: PortalEntraTenantStatus }`. `PortalEntraProofError` → `{ error, code }` with its status. |
| `POST /orgs/organizations/:id/portal-entra-tenant/proof-links` body `{ tenant?: string }` (GUID or domain) | same | `{ data: { url, expiresAt, expectedTenantId } }`. The URL is `{base}/api/v1/portal/auth/oidc/entra/proof?run=<token>`. With no hint and no mapping or connection tenant → 422 `PORTAL_ENTRA_TENANT_HINT_REQUIRED`. Audit `.link_created`. |
| `DELETE /orgs/organizations/:id/portal-entra-tenant` | same | `{ data: { removed, tenantId } }`. Audit `.removed` (OD3). |
| `GET /api/v1/portal/auth/oidc/entra/proof?run=<token>` | public, proof limiter | Peek the run → `createPortalOidcState({ purpose: tenant_proof, authority: expectedTenantId })` → 302 to authorize with `PORTAL_ENTRA_PROOF_SCOPE`. A bad or expired run → 302 `/entra-setup?status=invalid`. |

Rules:
- **The run record** lives under `PORTAL_REDIS_KEYS.entraProofRun(sha256(token))`: `{ v: 1, runId, orgId, partnerId, createdByUserId, expectedTenantId, createdAt }`, TTL 72 h.
  - `expectedTenantId` is never null (D6). Its source, in order: the org's mapped tenant, the body hint, then the org's M365 connection tenant.
  - The org's mapped tenant always wins: a hint for a different tenant → 409 `ORG_HAS_OTHER_TENANT`.
  - A domain hint resolves through `resolveEntraTenantIdFromDomain(domain)`. It fetches the public openid-configuration with a timeout and reads the tid from `issuer`. A failure → 422 `PORTAL_ENTRA_TENANT_HINT_INVALID`.
- **MSP routes** authorize the org through `resolveAccessibleOrg`, then call the Task 2 service through `runOutsideDbContext`.
- **The `tenant_proof` callback branch**, in order:
  1. `checkMailboxConsentAdminRoleViaGraph(accessToken, { tid, oid })` must be `ok`. Otherwise → `failed`, with the reason in audit and log.
  2. GET+DEL the run by hash. Gone → `invalid`. Re-authorize (D6): the org passes `getActiveOrgTenant`, and the creator is an `active` user who still belongs to the org's partner. Otherwise → `invalid`.
  3. `recordEntraTenantProof({ via: 'proof_run', evidence: { adminOid: oid, runId }, provenByUserId: run.createdByUserId })`. A `PortalEntraProofError` → `failed`.
  4. 302 to `buildPortalAppAdminConsentUrl(tid)`.

- [ ] **Step 1: Write the failing tests**

```ts
// orgPortalEntraTenant.test.ts
it('GET status for an org the partner cannot access → 404');
it('every route → 404 PORTAL_ENTRA_NOT_CONFIGURED without the portal app env');
it('proof-links returns a url under the callback base and audits link_created; no MFA → refused');
it('prove-from-connection maps TENANT_PROVEN_ELSEWHERE to 409 with code');
it('DELETE removes the mapping and audits removed');
// integration (append)
it('proof run end-to-end with a stubbed token endpoint + Graph role check: mapping proven via proof_run, redirect to adminconsent');
it('proof run by a non-admin (Graph check fails) → failed, run still usable');
it('proof run pinned to the org\'s mapped tenant refuses a token from another tenant');
it('a forwarded link opened by the admin of a different tenant → failed (tid ≠ expectedTenantId), nothing recorded'); // D6
it('proof-links with a domain hint pins the tid from the openid-configuration; no hint and no tenant → 422');
it('creator deactivated after creating the link → invalid at callback, nothing recorded');
it('concurrent proof callbacks record one proof');                                             // Review Focus 3
it('a used run link → invalid');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** The MSP status and delete routes are Sonnet-eligible once the service exists.
- [ ] **Step 4: Run** `orgPortalEntraTenant.test.ts`, `oidc.test.ts` and the integration file → PASS.
- [ ] **Step 5: Commit**: `feat(portal): tenant proof routes — prove from M365 connection, proof-run link, remove (W4)`

### Task 9: `sso_only` save flow, SSO invite email, bulk SSO invite, MSP browser-access grant

**Files:**
- Create `services/portalSsoOnly.ts` and `services/portalSsoOnly.test.ts`.
- Modify `services/portalAccessPolicyWrites.ts`. The update functions take `opts: { acknowledgeSsoOnly: boolean }`, and throw `PortalAccessPolicyConfirmRequiredError(impact)` when needed.
- Modify `routes/orgPortalAccessPolicy.ts` (+ test):
  - the `?acknowledge=sso-only` query;
  - the impact routes;
  - the stranded route;
  - audit `details.ssoOnly`.
- Modify `routes/orgPortalUsers.ts` (+ test):
  - `issueAndSendInvite` (`:143`) passes the method flags to the email;
  - the new `sso-invite` and `browser-access` routes.
- Modify `services/email.ts`. `sendPortalInvite` (`:618`) gains `microsoftUrl?: string` and `passwordAllowed: boolean`.
- Modify `__tests__/portalAccountWriters.contract.test.ts`, classifying `portalSsoOnly.ts` as `no-state`.
- Test (real DB): `__tests__/integration/portalSsoOnly.integration.test.ts`.

**Interfaces — Produces:**

```ts
// services/portalSsoOnly.ts
export interface SsoOnlyOrgImpact { orgId: string; orgName: string; passwordsToClear: number; strandedTotal: number }
export interface StrandedPortalAccount { portalUserId: string; email: string; name: string | null; status: 'active' | 'invited' }
/** Orgs whose effective passwordMode goes allowed → sso_only if `patch` is applied to `owner` (pick before/after with facts). */
export async function computeSsoOnlyFlips(owner: { kind: 'org'; orgId: string; partnerId: string } | { kind: 'partner'; partnerId: string },
  patch: Partial<PortalAccessPolicyRowValues>): Promise<SsoOnlyOrgImpact[]>;
/** status IN (active, invited), browser granted, password-eligible, no identity. */
export async function listSsoOnlyStranded(orgId: string, limit?: number /* 200 */): Promise<{ items: StrandedPortalAccount[]; total: number }>;
/** On the caller's transaction: password_hash = NULL, auth_epoch + 1 WHERE org_id = ANY(orgIds) AND password_hash IS NOT NULL AND identity exists. */
export async function clearPasswordsForSsoOnly(tx: DbTx, orgIds: string[]): Promise<{ clearedUserIds: string[] }>;
/** sha256 hex over the flips sorted by orgId as `${orgId}:${passwordsToClear}:${strandedTotal}` lines (D12). */
export function ssoOnlyImpactDigest(flips: SsoOnlyOrgImpact[]): string;
```

| Method + path | Middleware | Response |
|---|---|---|
| `POST /orgs/organizations/:id/portal-access-policy/sso-only-impact` body = patch | partner/system scope, `requireOrgRead` | `{ data: { flips: SsoOnlyOrgImpact[], impactDigest, stranded: { items, total } } }` |
| `POST /orgs/partners/me/portal-access-policy/sso-only-impact` body = patch | `requireScope('partner')`, `requirePartner`, `requireOrgRead` | `{ data: { flips, impactDigest } }` |
| `GET /orgs/organizations/:id/portal-access-policy/stranded` | partner/system scope, `requireOrgRead` | `{ data: { items, total } }` |
| `PATCH …/portal-access-policy[?acknowledge=<impactDigest>]` (both owners) | unchanged | A flip with no ack, or with a digest that differs from the impact recomputed inside the transaction, → 409 `{ error, code: SSO_ONLY_CONFIRM_REQUIRED, impact: { flips, impactDigest } }`. With ack: upsert + `clearPasswordsForSsoOnly` in one `withDbTransaction`. After commit, `purgePortalSessionsForUsers` + `purgeClientAiSessionsForUsers` (cleanup). Audit `details.ssoOnly = { orgIds, passwordsCleared }`. |
| `POST /orgs/organizations/:id/portal-users/sso-invite` body `{ portalUserIds: uuid[1..100] }` | partner/system scope, `requireOrgWrite`, `requireMfa()` | `{ data: Array<{ portalUserId, result: 'invited' \| 'not_stranded' \| <error code> }> }`. Processed sequentially through the existing `msp_invite` path. Microsoft not effective → 409 `PORTAL_SSO_INVITE_UNAVAILABLE`. |
| `POST /orgs/organizations/:id/portal-users/:userId/browser-access` | same | `{ data: { browserAccess: 'granted' } }`. Uses the `msp_grant_browser_access` writer, with no epoch bump. Audit `organization.portal_user.browser_access.grant`. |

Invite email (spec §5.5):
- `issueAndSendInvite` resolves the policy.
- `microsoftUrl = acceptUrl + '&method=microsoft'` when `isSignInMethodAllowed(policy, 'entra')`.
- `passwordAllowed = isSignInMethodAllowed(policy, 'password')`.
- Copy:
  - With `microsoftUrl`, add a primary button "Sign in with Microsoft". The password button becomes secondary ("Or set a password").
  - Without `passwordAllowed`, the password line and button are omitted.
  - The subject is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// portalSsoOnly.test.ts (pure parts) + integration (portalSsoOnly)
it('computeSsoOnlyFlips: org sso_only with entra on and proven → one flip; already sso_only → none');
it('computeSsoOnlyFlips: partner entra on flips every inheriting org that already holds an sso_only override in fallback');
it('saving sso_only clears hashes only for identity accounts and lists the stranded');      // Review Focus 4, inv. 11
it('PATCH without acknowledge → 409 with impact and nothing written');                       // Review Focus 4
it('PATCH with a stale digest (a new identity account appeared since the preview) → 409 with the fresh digest'); // D12
it('PATCH with acknowledge commits policy + clearing together; a forced failure rolls back both');
it('a flip caused by a proof (no PATCH) clears no hashes but password login is refused');  // D12
it('partner PATCH with acknowledge clears across its orgs only (another partner untouched)');
// orgPortalUsers.test.ts / email tests
it('invite email offers Microsoft first and hides the password option under sso_only');
it('invite email is unchanged when Microsoft is off');
it('sso-invite re-invites only stranded accounts and reports not_stranded for the rest');
it('browser-access grant on an add-in account keeps its epoch; on a disabled account → 409');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** The email template change is Sonnet-eligible.
- [ ] **Step 4: Run** `portalSsoOnly.test.ts`, `portalAccessPolicyWrites.test.ts`, `orgPortalAccessPolicy.test.ts`, `orgPortalUsers.test.ts`, the email tests, `portalAccountWriters.contract.test.ts`, `partner-wide-write-coverage.test.ts` and `dbTransactionPromiseAll.contract.test.ts`, plus the integration files `portalSsoOnly`, `portalAccessPolicyEnforcement` and `portalUserInvite`. All must PASS.
- [ ] **Step 5: Commit**: `feat(portal): sso_only save flow with impact, acknowledgement and stranded list; SSO invite email; browser-access grant (W4)`

### Task 10: W04a gate

- [ ] **Step 1: Typecheck and sweep**

```bash
NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"   # exit=0
cd packages/shared && npx tsc --noEmit; echo "exit=$?"
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/services/orgMerge.test.ts src/__tests__/   # merge "no merge policy"/blocker + all contracts
```

- [ ] **Step 2: Integration and contract suites.** Run every integration file from Tasks 1–9, plus:
  - `tenantCascade`, `tenantCascadeFkChildren`, `orgMergeRegistry`, `orgLifecycleFoundations`;
  - `tenant-export-policy`, `tenantExportErasureRoundtrip`;
  - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`;
  - `pnpm --filter @breeze/api test:integration-suite-coverage`.

  - `.github/scripts/integration-suites.txt`: the `portal` suite's test glob already matches the new `portal*.integration.test.ts` files.
  - Add `suite portal sources <file>` lines for each newly imported source file the portal suite does not own yet, as W03a did. Likely candidates: `routes/orgPortalEntraTenant.ts`, `config/portalEntra.ts`, `services/portalEntraTenantProof.ts`, `services/portalOidc/*`, `services/portalSsoOnly.ts`, `services/clientAiEntraAddress.ts`, `services/tenantStatus.ts`.
  - `test:integration-suite-coverage` names any line that is missing.
- [ ] **Step 3: Migration slot.** Run `git fetch origin main` and the `localeCompare` check from the migrations README. Rename if the slot was overtaken.
- [ ] **Step 4: Review.** Run one independent review round (`superpowers:requesting-code-review`) and the advisor quorum on D1–D15. Then `pnpm test-stack down` and say so.
- [ ] **Step 5: Open the PR.** The body must contain:
  - `Part of #11381`;
  - the rule-9 statement and D1–D15;
  - OD1–OD6 as resolved;
  - the env vars and the two redirect URIs;
  - the note that the capability stays off until the env is set;
  - the add-in cap default (spec §5.11 requires it in the PR).

---

## W04b — Web, portal, docs

Test commands:
- `apps/web`: `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. Typecheck with `npx astro check; echo "exit=$?"` and `NODE_OPTIONS=--max-old-space-size=20480 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`.
- `apps/portal`: the same vitest command (jsdom tests carry `// @vitest-environment jsdom`), plus `npx astro check`.

### Task 11: Card — Microsoft row tenant panel, session cap row, shared types, locale keys

**Files:**
- Modify `apps/web/src/components/settings/portalAccess/types.ts`. Replace the local W3 copies with `@breeze/shared` exports, as the W3 comment there asks, and add `entraTenantProven`.
- Modify `PortalAccessPolicyForm.tsx`:
  - Add the `ssoSessionMaxHours` row (`InheritedField`, number 1–168, testid `portal-access-policy-session-hours`), visible when `capabilities.entra || capabilities.google`.
  - Render an `entraSlot` prop under the Microsoft row.
- Create `portalAccess/EntraTenantPanel.tsx` and `EntraTenantPanel.test.tsx`.
- Modify `OrgSignInRegistrationCard.tsx`, passing `<EntraTenantPanel orgId>` as `entraSlot`. Map `PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN` in `friendly`.
- Locale keys go into all 8 locales, added **in this task** so Tasks 12–13 never touch the locale files: `portalAccessPolicy.sessionHours.*`, `portalAccessPolicy.entraTenant.*`, `portalAccessPolicy.ssoOnlyConfirm.*`, `portalAccessPolicy.stranded.*`, `orgPortalUsersEditor.actions.grantBrowserAccess`, `orgPortalUsersEditor.toasts.browserAccessGranted`.
- Modify `no-silent-mutations.test.ts` `TARGET_GLOBS`.

**Interfaces:**
- Consumes: the Task 8 routes.
- Produces: `EntraTenantPanel({ orgId, onChanged })`. Behaviour by state:
  - `none` / `unproven`:
    - *Use Microsoft 365 connection (tenant …)*, shown only when `connectionTenantId` is set.
    - *Create proof link*, with a tenant field (GUID or domain) prefilled from the mapped or connection tenant. It is required when neither exists.
    - The link shows with *Copy*, its expiry and the pinned tenant.
  - `proven`: "Proven {date} via {M365 connection | admin sign-in}", the admin-consent link (*Copy*), and *Remove tenant link*.
  - *Remove tenant link* uses `ConfirmDialog` with the AI for Office warning (OD3).
  - Every mutation goes through `runAction`, with the `PORTAL_ENTRA_*` codes mapped in `friendly`.
  - Testids: `entra-tenant-panel`, `entra-tenant-status`, `entra-tenant-prove-connection`, `entra-tenant-create-link`, `entra-tenant-link-url`, `entra-tenant-remove`.

- [ ] **Step 1: Write the failing tests**:
  - `shows not proven with both proof actions when a connection tenant exists`
  - `create proof link shows the url and expiry`
  - `proven shows date, method and the consent link`
  - `remove asks for confirmation naming AI for Office`
  - `session hours row hidden without an SSO capability and saves a number`
  - `TENANT_NOT_PROVEN shows the field error on the Microsoft row`
  - locale parity
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** The locale fan-out is Sonnet-eligible. Translate the keys rather than copying the English.
- [ ] **Step 4: Run** the touched tests, `src/locales/**/*.test.ts` and `no-silent-mutations.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(web): Microsoft tenant proof panel and SSO session cap on the sign-in card (W4)`

### Task 12: `sso_only` confirm, stranded list, grant browser access

**Files:**
- Create `portalAccess/SsoOnlyConfirmDialog.tsx` and `SsoOnlyConfirmDialog.test.tsx`.
- Modify `OrgSignInRegistrationCard.tsx`:
  - On a 409 `SSO_ONLY_CONFIRM_REQUIRED`, open the dialog with `impact`.
  - Confirm → PATCH with `?acknowledge=<impactDigest>`. On a fresh 409 (the impact changed), re-open the dialog with the new numbers. If *Send Microsoft sign-in invites* is ticked, then POST `sso-invite` in batches of 100.
  - When the effective mode is `sso_only`, show a *Stranded (n)* list (`GET …/stranded`) with *Send Microsoft sign-in invite*.
- Modify `partnerSettings/units/portalAccessPolicyUnit.ts`. The partner header Save goes through the same dialog, which lists the per-org flips with links. There is no bulk invite from the partner level.
- Modify `OrgPortalUsersEditor.tsx`. Add a *Give browser access* row action for `browserAccess === 'none'`, testid `portal-user-grant-browser-<id>`.
- Modify `no-silent-mutations.test.ts`.

- [ ] **Step 1: Write the failing tests**:
  - `save that flips to sso_only opens the dialog with counts and stranded names`
  - `confirm sends the impact digest and then batches sso-invite when ticked`
  - `a 409 with a new digest re-opens the dialog with fresh counts`
  - `cancel writes nothing`
  - `partner save lists affected orgs`
  - `stranded list shows when sso_only is effective`
  - `grant browser access calls the route and reloads`
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Opus does the dialog flow. The grant action is Sonnet-eligible.
- [ ] **Step 4: Run** the touched tests plus `PartnerSettingsPage.saveUnits.test.tsx` and `no-silent-mutations.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(web): sso_only confirmation with stranded accounts and Microsoft invites; grant browser access (W4)`

### Task 13: Portal app — Microsoft sign-in, invite, profile link, setup result page

**Files:**
- Create `apps/portal/src/lib/oidc.ts` (+ test):
  - `getSignInMethods()`;
  - `startMicrosoftSignIn(input)`, which stores `next` in `sessionStorage['portal-oidc-next']` and sets `window.location`;
  - `startMicrosoftLink()`;
  - `getInviteMethods(token)`;
  - `getLinkStatus()`.

  All use `buildPortalApiUrl` with `credentials: 'include'` and the CSRF header for POSTs.
- Create `components/portal/MicrosoftSignInButton.tsx` (+ test), testid `portal-login-microsoft`.
- Modify `components/portal/LoginForm.tsx`:
  - Show the button when `methods.microsoft`.
  - Render the `?sso=` banner. Copy:
    - `request_sent`: "Your request was sent. You'll get an email when you can sign in."
    - `account_exists`: "You already have an account. Sign in with your password and connect Microsoft, or ask your IT provider to re-invite you."
    - `unavailable`: "Microsoft sign-in isn't set up for this account here."
  - On `signed_in`, read and clear `portal-oidc-next`, then navigate through `safeNextPath`.
- Modify `components/portal/AcceptInviteForm.tsx`:
  - It fetches `/auth/invite/methods`.
  - It shows *Continue with Microsoft* (testid `portal-accept-invite-microsoft`) and the password form only when `password` is true.
  - `?method=microsoft` starts Microsoft at once.
- Modify the profile page component under `apps/portal/src/pages/profile/`. Add a *Microsoft account* section (testid `portal-profile-connect-microsoft`) using `getLinkStatus`, with the `?sso=linked|unavailable` banner.
- Create `apps/portal/src/pages/entra-setup.astro`. It is a public, `AuthLayout` page with static copy per `status`: `proven`, `consent_done`, `invalid`, `failed`. Check it against `src/middleware.ts` / `lib/protectedPaths.ts` and `disabledPageCoverage.test.ts`.

- [ ] **Step 1: Write the failing tests**:
  - `login shows Microsoft only when methods.microsoft`
  - `sso=request_sent and account_exists render their copy; any other code renders the generic copy`
  - `signed_in navigates to the stored next path via safeNextPath and clears it`
  - `accept-invite under sso_only shows only Microsoft`
  - `accept-invite ?method=microsoft starts immediately`
  - `profile shows Connect Microsoft when available and not linked`
  - `entra-setup renders per status and is reachable signed out`
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Sonnet-eligible; Opus reviews.
- [ ] **Step 4: Run** the touched portal tests plus `disabledPageCoverage.test.ts` and `lib/nextPath.test.ts`, then `npx astro check` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Sign in with Microsoft on login, invite and profile; tenant setup result page (W4)`

### Task 14: Docs, browser check, lab leg, W04b gate

**Files:**
- Create `apps/docs/src/content/docs/features/portal-microsoft-sign-in.mdx`. It has two sections:
  - **For MSPs:** proving the tenant (both ways), turning Microsoft on, the first-sign-in modes, the session cap, `sso_only` and stranded accounts.
  - **For the customer's admin:** what the proof link asks, admin consent, and turning on *Assignment required* on the Breeze Portal enterprise app.
- Modify `features/portal.mdx`. Replace the W3 sentences "not available yet / appear once the portal supports them" (W3b docs, the Microsoft row) and link the new page.
- Modify `deploy/environment.mdx` (the page that lists `CLIENT_AI_ENTRA_CLIENT_ID`). Add the three env vars, plus the self-hoster steps:
  - register a multi-tenant web app;
  - add the two redirect URIs (D4);
  - add a client secret;
  - add the delegated permissions `openid profile email`, plus `Directory.Read.All` for the proof run (OD2). **Do not** grant tenant-wide consent for `Directory.Read.All`;
  - add the ID-token optional claims `acct`, `email` and `xms_edov`;
  - note that the portal and the API must share one site (the default Caddy layout). The OIDC binding cookie is `SameSite=Lax`.
  - Use generic placeholders only.
- Regenerate the index from the repo root with `npx tsx scripts/build-docs-index.ts`.

Steps:
- [ ] **Step 1:** Write the docs and regenerate the index. Sonnet-eligible.
- [ ] **Step 2: Browser check** using the `feature-testing` skill on a `worktree-stack`. Stub Microsoft with a local OIDC fake, or skip the IdP hop and assert up to the authorize redirect. Check:
  - The card shows the tenant panel.
  - A proof link is created and copyable.
  - With a tenant proven by SQL seeding, Microsoft can be turned on and the session-hours row saves.
  - `sso_only` shows the confirm dialog with stranded names.
  - The portal login shows *Sign in with Microsoft*, and accept-invite under `sso_only` shows only Microsoft.
  - Tear the stack down and say so.
- [ ] **Step 3: Lab leg (Todd gate, before the env is set in any region).** Use a lab tenant, a portal Entra app registered per the docs, and a lab stack. Record the results in the W04b PR. Check:
  1. A proof run by a GA proves the tenant, and admin consent completes.
  2. A non-admin proof run fails.
  3. Sign-in as a new person in approval mode → the request appears, approve → sign in works.
  4. Instant mode creates the account.
  5. A guest user of the tenant is refused.
  6. A personal Microsoft account is refused.
  7. An Entra session dies after a 1 h cap.
  8. An add-in session re-exchanges silently after the 12 h cap, verified with a shortened cap in the lab.
  9. Optional claims: `acct=1` is emitted for a guest in a pinned-tenant proof sign-in, and `xms_edov` is present.
- [ ] **Step 4: Gate.**
  - Web and portal: `astro check` and `tsc` exit 0, and `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main` green.
  - API: the docs-index tests.
  - One independent review round.
  - The PR body has `Closes #11381`, the rule-9 statement, the lab-leg results, and screenshots of the card, the dialog and the portal login.
- [ ] **Step 5: Commit**: `docs(portal): Sign in with Microsoft for MSPs, customer admins and self-hosters (W4)`

---

## Execution split and parallelism

**W04a (API)**
- **SERIAL first:** T1. The migration gates T2's real-DB tests.
- **PARALLEL GROUP A1 (file-disjoint):**
  - **T2** (`portalEntraTenantProof.ts`, `orgMerge.ts`, `email.ts`, `mailPurposes.ts`);
  - **T4** (`services/portalOidc/stateStore.ts`, `entraClient.ts`, `types.ts`, `microsoftAuthorization.ts`, `routes/portal/schemas.ts`, `helpers.ts`, `capabilityTokens.ts` Lua extraction).
- **SERIAL:** T3 after T2 (it consumes `findProvenEntraTenantForOrg`).
- **PARALLEL GROUP A2** (after T3 and T4):
  - **T5** (`portalAccountState.ts`, `portalUserIdentities.ts`, `portalIdentityAccounts.ts`, `portalAccessRequests.ts`, `portalOidc/accountResolution.ts`, the census);
  - **T6** (`browserSession.ts`, `auth.ts`, `schemas.ts` `PortalSession`, `clientAiAuth.ts`, `clientAi/schemas.ts`).
  - The overlap is `routes/portal/schemas.ts`: T4 adds Redis keys and T6 adds a `PortalSession` field, in different blocks. Rebase-trivial.
- **PARALLEL GROUP A3** (after T5 and T6):
  - **T7** (new `routes/portal/oidc.ts`, `index.ts`, `capabilityTokens.ts` peek/byHash, `branding.ts` export);
  - **T9** (`portalSsoOnly.ts`, `portalAccessPolicyWrites.ts`, `orgPortalAccessPolicy.ts`, `orgPortalUsers.ts`, `email.ts` `sendPortalInvite`).
  - T9's `email.ts` edit is a different method from T2's.
- **SERIAL:** T8 after T7. It adds the `tenant_proof` branch to `oidc.ts` and the new `orgPortalEntraTenant.ts`.
- **SERIAL last:** T10 gate.
- **Sonnet-eligible:**
  - T1's export-registry entry and env/compose passthrough (the contract tests are the check);
  - T2's displacement email template + mail purpose;
  - T8's MSP status/delete routes;
  - T9's invite email copy.
- **Opus:** T1 migration and trigger, T2 service + merge blocker, T3, T4, T5, T6, T7, T8's callback branch, T9's flip/clear logic.

**W04b (Web + portal + docs)**, branched from main after W04a merges
- **SERIAL first:** T11. It holds every web locale key and the shared-type switch.
- **PARALLEL GROUP B (file-disjoint):**
  - **T12** (web: `SsoOnlyConfirmDialog`, `OrgSignInRegistrationCard.tsx` save path, partner unit, `OrgPortalUsersEditor.tsx`);
  - **T13** (`apps/portal/**` only).
- **SERIAL last:** T14.
- **Sonnet-eligible:** T11's locale fan-out, T12's grant action, T13, T14 docs.
- **Opus:** T11's panel, T12's dialog flow, review of T13.

## CI traps

- **Premise:** W03a and W03b must be on main. W4 consumes `getPortalSignInCapabilities`, `pickEffectivePortalAccessPolicy`, `createPortalAccessRequest`, `parseStoredPortalSession` and the W03b form. If they are not merged yet, stop. Do not stack.
- **Export policy.** New `client_ai_tenant_mappings` columns must be classified. `proven_evidence` is jsonb, so it is `excludedOpen`. Run `tenant-export-policy` and `tenantExportErasureRoundtrip` under Integration Tests: they never go red in Test API.
- **Merge blocker.** The `entra_tenant_conflict` refusal and the threaded `survivorOrgId` are proven only by the full `orgMerge.test.ts` and the merge integration suite. Run both (T10).
- **Writer census.** `portalAccountWriters.contract.test.ts` fails on any new file that INSERTs or UPDATEs `portal_users` until it is classified: `portalIdentityAccounts.ts` and `accountResolution.ts` as state-module, `portalEntraTenantProof.ts` and `portalSsoOnly.ts` as no-state.
- **System context inside a request.** MSP proof routes must call the system-scope service through `runOutsideDbContext`. A nested `withSystemDbAccessContext` inside the request transaction stalls or throws "context already held".
- **Caught queries.** Any route that catches `PortalEntraProofError` or `PortalAccessPolicyConfirmRequiredError` around a query needs the query inside `withDbTransaction`, with the catch outside. Otherwise a 409 becomes a 500 at commit. Never use `Promise.all` (`dbTransactionPromiseAll.contract.test.ts`).
- **W3 capability assumptions.** Flipping `entra` to env-gated leaves tests false (no env in test). Any test that sets the env must restore it, and must prefer `__testOnly.setCapabilities`.
- **No network in tests.** Inject `fetch` and the `jose` verification key. A test that reaches `login.microsoftonline.com` hangs CI.
- **Redis Lua.** The GET+DEL extraction must keep the in-memory twin. Run `capabilityTokens.test.ts`, and the race test under real Redis.
- **Binding cookie SameSite.** It must stay `Lax` regardless of `PORTAL_COOKIE_SAME_SITE`. A `Strict` cookie is not sent on Microsoft's redirect, and every callback reads `unavailable`. A deployment whose portal and API sit on different sites drops the `Lax` Set-Cookie from the start `fetch`. Same-site is a documented requirement (Task 14).
- **Audit coverage.** The callback is a GET, so the portal auth audit wrapper (POST-only, `auth.ts:84-130`) skips it. Write the rows explicitly.
- **Integration suite map.** `.github/scripts/integration-suites.txt` maps suites to globs. The new tests already match `portal[!a-z0-9]*`, but newly imported sources need `suite portal sources <file>` lines, or `test:integration-suite-coverage` fails.
- **New service files.** `parkedFanout.contract.test.ts` must not discover them (none reads `devices`).
- **Migration slot.** The slot is assigned at enqueue. A sibling migration landing first poisons the merge queue (Check Migrations). Run `pnpm db:check-drift`.
- **Typecheck heap.** API `tsc` needs a 20 GB heap. Check `exit=$?`, never `| tail`.
- **Web.** Watch `no-silent-mutations` `TARGET_GLOBS`, 8-locale parity, `keyUsage.test.ts` (dynamic keys need a static `Record` + `/* i18n-dynamic */`) and `humanizedKeyRegression.test.ts`.
- **Portal pages.** A new public page needs the middleware / `protectedPaths` / `disabledPageCoverage.test.ts` treatment.
- **Docs index.** Changing any `.mdx` without regenerating `docsIndex.json` fails the docs-index test.
- **No infrastructure details** in docs or PR bodies. Redirect URIs use `https://<your-breeze-domain>`.

## Out of scope (owned by later waves)

- **W5:** domain verification, including the `entra_tenant` method, which reads this wave's proven tenant.
- **W6:** self-registration (flips `capabilities.selfRegistration`).
- **W7:** Google. It reuses `services/portalOidc/*`, adds `'google'` to `PortalOidcProvider`, and flips `capabilities.google`.
- **W8 / W9:** deprovisioning and SCIM. **Every identity-removing writer they add must clear `portal_users.entra_*` (W3 D4 fence) and bump `auth_epoch`**, so Entra sessions die durably.
- **Not in any wave yet:**
  - MSP *unlink identity* and *remove browser access* actions (spec §5.1 lists only grants);
  - a session handoff to custom domains (D5, after custom-domain serving ships);
  - a certificate credential for the portal app (D14);
  - AI tools.

## Self-review

1. **Spec coverage (§7 W4 row):**
   - Tenant proof run → T4/T8.
   - M365-connection proof → T2/T8.
   - Transfer and merge rules → T2.
   - Portal Entra app → T3/T14.
   - OIDC common layer → T4 (state, PKCE, nonce, binding) and T5 (§5.6).
   - Microsoft sign-in → T7.
   - Link from a signed-in session → T5/T7/T13.
   - Invitation-bound invites → T5/T7/T9/T13.
   - Absolute session caps, browser and add-in → T6.
   - `sso_only` → T9/T12.
   - Guests → T4.
   - Host binding → T5/T7 (D5).
   - Audit (§5.10) → T2/T7/T9.
   - Docs (§8) → T14.
   - Invariants 1–9, 11 and 13 have named tests in T2/T4/T5/T6/T7/T9.
2. **Step scan:** every code step names its file and signature. The SQL is given in full as the spec of record. Route, service and component bodies are left to the implementer.
3. **Type consistency.** These names are used identically across T1–T14:
   - types: `PortalEntraProofVia`, `PortalEntraTenantStatus`, `PortalOidcPurpose`, `PortalOidcVerifiedIdentity`, `PortalOidcSignInOutcome`, `PortalEntraConfig`, `StoredPortalSession`, `SsoOnlyOrgImpact`;
   - functions: `findProvenEntraTenantForOrg`, `findOrgByProvenEntraTenant`, `recordEntraTenantProof`, `createPortalOidcState`, `consumePortalOidcState`, `verifyPortalEntraIdToken`, `resolvePortalOidcSignIn`, `linkPortalUserIdentity`, `createIdentityOnlyAccount`, `mintPortalBrowserSession`;
   - writers: `'sso_invite_accept'`, `'sso_instant_grant'`, `'msp_grant_browser_access'`.
4. **Review Focus:** all five lines have named tests in their owning tasks (T2, T3, T4, T5, T6, T7, T8, T9).
5. **Proportion:** the plan holds decisions, interfaces, rules, the migration and test names, with no transcribed bodies.
