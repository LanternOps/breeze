# Breeze M365 Communications-Delegated Executor — Design Spec

**Date:** 2026-07-28
**Revision:** v2 (v1 drafted 2026-07-28, reviewed by Codex `gpt-5.6-sol` at `xhigh`, 18 findings)
**Status:** Proposed design, pre-implementation
**Stage:** Delivery-sequence stage 4/5 remainder (master spec §17, `docs/superpowers/specs/integrations/2026-07-13-breeze-m365-control-plane-design.md:476-489`) — the communications executor defined in §11.1 (lines 306-311).

## 0. What changed in v2, and why

v1's trust-boundary mirroring, ruthless 5-action first cut, and tenancy analysis survived review. Its **credential layer and its binding layer did not.** Six changes, each replacing a v1 position rather than refining it:

| # | v1 said | v2 says | Because |
|---|---|---|---|
| 1 | Content binding is solved by `argumentDigest` + `bodySha256` | **Canonical effect envelope**, digest recomputed *inside the executor* (§5.1) | The two mechanisms never meet. `revalidateApprovedIntentForRelease` compares two *stored* strings (`revalidateRelease.ts:41-43`); the headless mapper then builds a **fresh** typed request (`m365ToolsHeadless.ts:64-70`) and `bodySha256` hashes *that*. The executor never sees the approved digest. |
| 2 | Connection resolved at release time by org/user | **Connection, tenant, sender object id and consent generation pinned at intent creation** (§5.2) | `action_intents.connection_id`/`tenant_id` exist and are immutability-protected (`2026-07-18-action-intents.sql:109-110`) but `CreateActionIntentInput` cannot set them (`intentService.ts:65-75`) and creation leaves both null (`intentService.ts:293-312`). A reconnect between approval and release would send approved content from a different mailbox. |
| 3 | User allowlist + owner check authorize the send | Those are necessary but **not sufficient without a principal-kind discriminator** (§6) | MCP auto-executes Tier-3 with no approval (`mcpServer.ts:998-999`) and API keys inherit their creator's `user.id` (`mcpServer.ts:1880`). `AuthContext` has no principal discriminator (`middleware/auth.ts:18-88`). A key minted by the mailbox owner passes every v1 gate. **Blocking prerequisite.** |
| 4 | Consent reuses the shipped `identity_verification` machinery | **Delegated-specific consent phase** (§4.2) | That machinery requires a tenant GUID *before* authorization (`consentSessionService.ts:119-133` takes `tenantHint`). A first `/common` delegated sign-in only learns `tid` from the returned ID token. |
| 5 | Row created, then consent fills in the vault ref | **Status-aware credential-location constraint + atomic promotion** (§4.1) | `m365_connections_credential_location_check` (foundation migration:105-110) demands non-null `vault_ref` **and** `credential_version` for every non-legacy profile. Neither exists until the OAuth callback completes, so the row cannot be inserted at all. |
| 6 | Key Vault is the refresh-token store, executor `set`s new versions, single replica + in-process mutex | **MSAL confidential client + encrypted, CAS-guarded distributed token cache**; Key Vault holds only immutable material (§3) | AKV `setSecret` always creates a new version — no CAS, no lease, no overwrite. And a single-replica constraint is unachievable: *any rolling deploy transiently runs two replicas*, so the in-process mutex cannot be the concurrency story. |

Two v1 claims are **withdrawn as factually wrong**, and one review finding is **rejected**:

- Withdrawn: "retained old RT versions are harmless." Microsoft does not invalidate a refresh token merely because a newer one was issued. Every retained version is a live credential.
- Withdrawn: the `/me/mailboxSettings` probe — it needs `MailboxSettings.Read`, which is not in the profile. §4.2 probes `GET /me?$select=id,userPrincipalName,mail` only, which `User.Read` covers.
- Rejected: the review's claim that the `breeze_current_user_id` RLS branch is untested. `m365ConnectionsRls.integration.test.ts:160-235` already covers same-partner/same-org peer denial, owner CRUD, and forged insert. v1's *proposed* assertion was the wrong one though — see §3.3.

One v1 omission the review found that v2 must carry: `offline_access` **is** already present in the profile (`profiles.ts:60`), so no scope change is needed for refresh tokens; the Teams trim (§9.4) still stands.

## 1. Summary

Build `apps/m365-communications-executor/`, the third narrow M365 executor, serving the `communications-delegated` profile (`packages/shared/src/m365/profiles.ts:58-77`): typed mail reads, draft creation, and Tier-3 approved sends from the owning user's own mailbox, using **per-user delegated refresh tokens**.

The read and actions executors are structural siblings of each other because they share one credential shape: a single, immutable, org-consented application certificate, version-pinned in env at boot (`apps/m365-graph-actions-executor/src/config.ts:168-185`). The communications executor **cannot** be a third re-key of that template, because its credential is the opposite in every dimension that matters:

| Dimension | Read/Actions executors | Communications executor |
|---|---|---|
| Credential | 1 app certificate, platform-owned | N refresh tokens, one per owning user |
| Mutability | Immutable; rotated by controlled migration | **Rotates on redemption**; Microsoft decides when |
| Cardinality vs env | 1 secret ⇒ pinnable as `VAULT_REF` env | per-connection ⇒ cannot live in env at all |
| Vault access | `get` only | `get` only — but the rotating material lives **outside** the vault entirely (§3.2) |
| Acquisition | Customer admin consent (app-only) | Owning user's own sign-in (auth code + PKCE, **confidential** client) |
| Death | Cert expiry (years, scheduled) | invalid_grant at any moment (revocation, password reset, CA policy, 90-day inactivity) |
| Who acts | The app's service principal | **The human user** — sends appear as that person in recipients' inboxes and in the tenant audit log |
| Tenancy | `ownerAxis: 'organization'` | `ownerAxis: 'user'` |

**Design stance:** mirror the siblings at the *trust boundary* (process shape, Ed25519 internal auth, private bind, closed catalog, boot validation, dark launch) and diverge deliberately at the *credential lifecycle* and *ownership axis*. Every divergence is enumerated in §3.

## 2. What mirrors the siblings (and why)

These are identical because the API↔executor trust boundary does not care what kind of Microsoft credential sits behind it:

1. **Process shape.** Hono app, `GET /healthz`, typed POST operations, 16 KiB bounded body, strict content-type, schema-validate-in/schema-validate-out, blanket `internal_error` on throw — clone of `apps/m365-graph-actions-executor/src/app.ts:70-158`.
2. **Internal request auth.** Ed25519-signed 60s JWT from the API with `iss=breeze-api`, `sub=breeze-control-plane`, per-operation claim, `jti`, `correlationId`, and `bodySha256` binding the exact signed bytes (`internalAuth.ts:64-113`, client side `graphActionsExecutorClient.ts:153-200`). New audience: **`m365-communications-executor`**, new dedicated Ed25519 keypair — never shared with the other two (per the secret-ownership discipline in `docs/deploy/m365-customer-graph-actions-executor.md:114-123`).
3. **Config discipline.** All env parsed at boot, fail-fast, private RFC1918/ULA bind only, no default Azure credential fallback (`config.ts:52-66, 200-218`). Convention: port 3005 (read=3003, actions=3004).
4. **Closed catalog.** A new `packages/shared/src/m365/commsActions.ts` with a discriminated-union Zod schema, `.strict()` objects, per-action projection allowlists for reads, and enumerated failure codes — the `readActions.ts:13-38` / `writeActions.ts:10-39` pattern.
5. **API-side service ladder.** flag → connection load under caller/ambient RLS → readiness → budget → executor call → categorized failure mapping with fixed one-sentence messages that never echo Graph detail (`writeActionService.ts:98-193`, `readActionService.ts:103-232`).
6. **Dark launch.** Onboarding flag + allowlist, tools flag + allowlist, `validate...AtBoot` that force-loads the full descriptor when either flag is on (`writeActionRuntimeConfig.ts:263-281`). One change: the allowlists are **user IDs**, not org IDs (§7).
7. **Deploy model.** Not a compose service; digest-pinned image in an identity-capable environment, private ingress from API only, egress allowlisted to Key Vault host + `login.microsoftonline.com` + `graph.microsoft.com` (runbook lines 127-137).

## 3. The divergences (the actual design)

### 3.1 Why Key Vault cannot be the refresh-token store

v1 proposed one AKV secret per connection, with the executor writing a new version on every rotation. **This does not work**, for reasons that are properties of the products, not of the implementation:

1. **`setSecret` is not a compare-and-swap.** It unconditionally creates a new version and returns it. Two concurrent redemptions both succeed, both create versions, and "latest" is whichever landed second — the other redemption's refresh token is silently orphaned. There is no `If-Match`, no conditional write, and no lease primitive on AKV secrets.
2. **Old versions stay live at Microsoft.** v1 called retained versions "harmless because latest-read is authoritative." That is wrong in the direction that matters: issuing RT<sub>n+1</sub> does not invalidate RT<sub>n</sub>, so every retained version is a **usable credential for that person's mailbox** until it expires or is revoked. An AKV secret with 400 versions is 400 live credentials, and `delete` is name-wide (master §6.1 line 117) so they cannot be pruned individually.
3. **The single-replica mitigation is unachievable.** v1 leaned on "exactly one replica + in-process mutex." Every rolling deployment transiently runs two replicas — that is what rolling means. So the mutex is not a constraint the platform can actually hold, and the one failure it guards (concurrent redemption of the same RT) is exactly the one that bricks a mailbox.
4. **AKV is priced and rate-limited as a config store, not a session store.** Per-send `get` + `set` against a shared vault throttle ceiling is a self-inflicted availability dependency on the send path.

Taken together: a rotating, per-user, concurrently-accessed credential is *session state*, and AKV is a *secret store*. v1 used the right storage for the wrong noun.

### 3.2 What v2 does instead: MSAL confidential client + encrypted CAS token cache

**Key Vault keeps exactly the material it is good at — immutable secrets, version-pinned at boot, `get` only.** This restores the siblings' read-only vault posture and removes the `set` grant entirely:

| Secret | Contents | Rotation |
|---|---|---|
| `m365-comms-client-cert` | The **confidential-client certificate** for the comms Entra app | Scheduled, by migration — sibling-identical (`config.ts:175-185`) |
| `m365-comms-token-cache-kek` | AES-256 key-encryption key wrapping the per-user token cache | Scheduled; supports a two-version read window for rollover |

This also closes a v1 omission the review caught outright: **v1 never specified a client credential at all.** PKCE is a *public*-client protection against code interception; it is not client authentication. The sibling executors authenticate to Entra with a certificate assertion (`tokenClient.ts:166-204`), and a confidential client is mandatory here — a public client holding delegated refresh tokens for a whole MSP's staff is not an acceptable posture.

**The rotating per-user cache lives in a CAS-capable store the executor owns.** Shape, stated independently of backing technology so the infra decision (§handoff item 3) stays open:

```
comms_token_cache(
  connection_id      uuid primary key,
  cache_version      bigint  not null,   -- optimistic concurrency
  ciphertext         bytea   not null,   -- AES-256-GCM(MSAL cache blob)
  kek_version        text    not null,   -- which KEK version wrapped this
  lease_holder       uuid,               -- replica instance id
  lease_expires_at   timestamptz,        -- short, ~30s
  updated_at         timestamptz not null
)
```

- **Write is `UPDATE … WHERE connection_id = $1 AND cache_version = $2`.** Zero rows updated ⇒ another replica redeemed concurrently ⇒ re-read and retry the *silent* path (never re-redeem the stale RT). This is the CAS that AKV cannot provide.
- **Redemption is serialized by a short lease**, not a process mutex — so it holds across replicas and across a rolling deploy. Lease acquisition failure ⇒ brief wait, re-read cache, try silent acquisition; the common case after waiting is that the other replica already refreshed and the silent path just works.
- **Rotation is MSAL's problem, not ours.** The executor uses MSAL Node's `ConfidentialClientApplication` with a partitioned `ICachePlugin` (`beforeCacheAccess` = decrypt-and-load, `afterCacheAccess` = encrypt-and-CAS-write), one partition per `connectionId`. `acquireTokenSilent` handles refresh-token redemption, rotation, and access-token reuse internally. Hand-rolling redemption — v1's plan — reimplements a subtle, security-critical protocol that a supported library already implements.
- **Ciphertext-at-rest means the store is not a credential store to anyone but the executor.** AES-256-GCM under a KEK the executor's identity alone can `get`. The API's identity has no access to that KEK, and the KEK is emphatically **not** `APP_ENCRYPTION_KEY_ID`.

**Where that store physically lives — an open infrastructure decision, with a recommendation.** Preference order:

1. **A dedicated store the executor owns** (small Postgres or Redis with persistence), reachable only from the executor. Preserves isolation in *both* directions.
2. **Breeze Postgres**, as a fallback if a separate store cannot be provisioned. Cheaper operationally, but it adds Breeze Postgres to the executor's egress allowlist, so an RCE in the executor gains reach toward the tenant database. That is a real widening and must be an explicit, recorded decision — not a default.

**This needs a master-spec amendment, stated plainly rather than buried.** §6.1 (lines 103-117) says "Breeze Postgres … does not store … refresh tokens." Option 2 violates the letter of that rule; both options preserve its intent (the API process and its encryption key cannot read the material). §6.1 should be amended to the property it actually wants: *no component may hold credential material it can decrypt outside its own credential domain.* Under that wording, encrypted-blob-in-Postgres is compliant and plaintext-in-Postgres remains forbidden. **Do not implement option 2 until that amendment is agreed** — it is precisely the kind of "it's basically the same" drift the boundary exists to prevent.

**What the API still tracks.** `m365_connections.credential_version` becomes the **cache generation** (an opaque counter the executor returns), and `vault_ref` points at the *client certificate* secret, not at a per-user token. Both stay non-null after promotion, so §4.1's constraint needs relaxing only for the pre-consent window.

**Failure modes, restated:**
- *Concurrent redemption:* handled by lease + CAS. No replica constraint, no deploy hazard.
- *Cache write fails after redemption:* the RT Microsoft just issued is lost, and the previous RT may be dead. Returns `credential_rotation_failed`; API marks `degraded`; UI shows Reconnect. Unchanged from v1 — but now rare rather than structural.
- *KEK rollover mid-flight:* `kek_version` per row plus a two-version read window; a row wrapped under the old KEK is re-wrapped on next write.

**Access-token caching.** Retained from v1, and it is now MSAL's in-cache behaviour rather than a bespoke in-memory map: `acquireTokenSilent` reuses a valid access token and only touches the refresh token when it must. The master-spec flag in §12 item 1 stands — §6.3 step 6's "clears token and session state" is written for app-only flows and must be amended to permit short-lived access-token reuse within validity.

### 3.3 Lifecycle: acquisition, rotation, revocation, reauth

```
pending-consent → verifying → active ⇄ degraded → revoked
                                 active → suspended → revoked
```
(existing statuses, `apps/api/src/db/schema/m365.ts:28-34`; no new states. v1's status list omitted `suspended` — it exists and comms rows are subject to it like any other.)

- **Acquisition (consent).** Delegated auth-code + PKCE sign-in by the *owning user* — not admin consent. **Not** the shipped `identity_verification` phase: see §4.2 for why, and for the corrected ordering (verify *before* persisting credential material — v1 had it backwards).
- **Rotation.** §3.2, inside MSAL, guarded by lease + CAS. No scheduled rotation job in v1; rotation is event-driven by Microsoft.
- **Expiry tracking.** Refresh tokens die after ~90 days of *inactivity* (sliding). On every successful silent acquisition the API stamps `last_verified_at` and sets `expires_at = now() + 90d`. The existing expiry alerting surface (§14, master lines 384-385) keys off `expires_at`.
- **Revocation / reauth.** `invalid_grant`/`interaction_required` maps to a new failure code `delegated_reauth_required`: the API sets `status='degraded'`, `last_error_code`, and every subsequent tool call refuses with a "Reconnect Microsoft 365 communications" message. Reconnect = a fresh consent attempt on the same row (new `consent_attempt_id`), which **bumps `consent_generation`** (§5.2) and thereby invalidates every approved-but-unreleased intent bound to the previous generation. Breeze-side revoke sets `revoked` and deletes the token-cache row — which, unlike v1's AKV story, is a real code path rather than a runbook step, because the cache store supports deletion.

### 3.4 Tenancy: `ownerAxis: 'user'`

**Connection rows: no new shape needed.** The foundation migration already made `m365_connections` org-XOR-user (`m365_connections_owner_check`, `2026-07-13-m365-control-plane-foundation.sql:72-74`), already pins `communications-delegated → user_id NOT NULL + delegated + communications-delegated domain` (`profile_binding_check`, lines 112-119), and already carries the three-branch RLS policy `system OR breeze_has_org_access(org_id) OR user_id = breeze_current_user_id()` (lines 143-166). The user branch is CLAUDE.md **Shape 6** grafted onto a Shape-1 table.

**Gap to close — narrower than v1 claimed, and one v1 assertion is wrong.** The user branch is *already covered*: `m365ConnectionsRls.integration.test.ts:160-235` proves same-partner/same-org peer denial, owner CRUD, and forged insert. What is genuinely missing is **registration**: `m365_connections` is absent from `USER_ID_SCOPED_TABLES` (`rls-coverage.integration.test.ts:510-535`), so the coverage sweep does not know the table has a user axis at all.

v1 proposed asserting that "an org-scoped token must not see any user-owned row." **That assertion is false and must not be written**: human org-scoped contexts still set `breeze.user_id`, so an org-scoped session belonging to the owner *will* — correctly — see the owner's own row. The correct assertions are:

1. A **different** user, at any scope, cannot see or write the row.
2. A **keyed or no-user** DB context (agent/system-key paths with no `breeze.user_id`) cannot see it.
3. Cross-user forge insert fails with 42501.

Registering the table also does not buy the proof v1 implied: `m365_connections` has an `org_id` column, so the org sweep and `CORE_ORG_CASCADE_DELETE_ORDER` already see it (`tenantCascade.ts:216`) — but a *user-owned* row has `org_id NULL` and is therefore invisible to both contracts. **Those suites cannot serve as the tenancy proof for user-owned rows; the dedicated behavioural tests above are the only proof.** Say so in the PR rather than pointing at a green contract suite.

**Consent sessions: new table, and here is why.** `m365_consent_sessions` has `org_id NOT NULL` and a composite FK `(connection_id, org_id, profile, consent_attempt_id) → m365_connections(id, org_id, profile, consent_attempt_id)` (`m365.ts:96, 112-121`). A user-owned connection has `org_id NULL`; making the FK columns nullable silently disables the composite FK under `MATCH SIMPLE` for exactly the rows that need it. So: **`m365_user_consent_sessions`**, the same shape on the user axis, composite FK `(connection_id, user_id, profile, consent_attempt_id)` backed by a new unique index on `m365_connections (id, user_id, profile, consent_attempt_id)` (parallel to `attemptIdentityUniq`, `m365.ts:78-79`). RLS: system-only, exactly like its sibling (registered in the system-only allowlist, `rls-coverage.integration.test.ts:52,76`) — verifier/nonce material must never be tenant-readable. Cascade registration: it has `user_id` (FK CASCADE) and **no `org_id`**, so it joins neither `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts` — `m365_connections` itself is already there at line 216) nor the device lists; the rls-coverage and cascade contract suites are the proof, run in the same PR.

**Who may act.** Only the owning **human**, ever:
- Tool registration: comms tools appear only for sessions where `auth.user.id` is in the user allowlist **and** owns an `active` `communications-delegated` connection **and** `auth.principal.kind === 'user_session'` (§6). Site-restricted sessions refused (mirrors `readActionService.ts:110-115`).
- Release time: the comms headless service fails closed unless `connection.userId === intent.requestedByUserId` — the user-axis analogue of `writeActionService.ts`'s `wrong-org` check (lines 59-72). **An approval can never cause a send from a mailbox its requester does not own.**

⚠️ **v1 believed the two bullets above were sufficient. They are not** — a user-identity check cannot distinguish a human from an API key that the human minted, because API keys *are* their creator's `user.id` (`mcpServer.ts:1880`). §6 is the missing gate and is a hard prerequisite for this executor.

**Intent anchoring — master-spec ambiguity, resolved here.** §10.1 says intents record "organization/user ownership" (line 254), but `action_intents.org_id` is `NOT NULL` (`actionIntents.ts:61`) and the whole approval/RLS/audit chain is org-keyed. Decision: comms intents anchor to the **org context of the requesting session** (the customer being corresponded about, via `resolveWritableToolOrgId`), which routes approval visibility to the right customer context; mailbox ownership rides on `requestedByUserId` + the release-time owner check. The master spec should state this explicitly rather than implying user-owned intents might have no org.

## 4. Bootstrapping a delegated connection

Two shipped mechanisms assume an org-consented certificate profile and **block delegated onboarding outright**. v1 missed both. Neither is a design preference; each is a hard constraint that stops task 1.

### 4.1 The credential-location constraint forbids the pre-consent row

```sql
-- 2026-07-13-m365-control-plane-foundation.sql:105-110
(profile <> 'legacy-direct' AND client_secret IS NULL
   AND vault_ref IS NOT NULL AND credential_version IS NOT NULL)
```

A delegated connection has **no credential at all** until the OAuth callback returns — that is the whole point of an interactive flow. So the `pending-consent` row cannot be inserted, and there is nothing to hang the consent session's composite FK from.

**Fix — a new migration** (fix-forward; the shipped migration is never edited) that drops and re-adds the constraint status-aware:

```sql
ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_credential_location_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_credential_location_check CHECK (
  (profile = 'legacy-direct' AND client_secret IS NOT NULL AND vault_ref IS NULL)
  OR (profile <> 'legacy-direct' AND client_secret IS NULL AND (
        (vault_ref IS NOT NULL AND credential_version IS NOT NULL)
     OR (auth_mode = 'delegated'
         AND status IN ('pending-consent', 'verifying')
         AND vault_ref IS NULL AND credential_version IS NULL)
  ))
);
```

The relaxation is deliberately keyed on **both** `auth_mode = 'delegated'` **and** a non-terminal status, so it cannot be used to park a certificate profile without a credential, and cannot leave a delegated row credential-less once it reaches `active`. Existing rows all satisfy the first branch, so the migration is a no-op on live data — but it still reports counts per the CLAUDE.md cleanup-statement rule if any row is found in the relaxed state.

**Promotion is one atomic UPDATE**, never a multi-statement sequence:

```sql
UPDATE m365_connections
   SET status = 'active', vault_ref = $2, credential_version = $3,
       tenant_id = $4, delegated_user_object_id = $5,
       consent_generation = consent_generation + 1,
       observed_delegated_scopes = $6, last_verified_at = now(), expires_at = now() + interval '90 days'
 WHERE id = $1 AND status = 'verifying' AND consent_attempt_id = $7;
```

Zero rows updated ⇒ the attempt was superseded ⇒ the executor discards the credential material it just cached and returns `consent_superseded`. A partially-promoted row is unrepresentable.

### 4.2 Delegated consent needs its own phase (the shipped one needs a tenant first)

The shipped `identity_verification` phase takes a **`tenantHint` before authorization** (`consentSessionService.ts:119-133`, hashed into the session as `tenantHintHash`) because the certificate profiles always know the customer tenant up front — an admin consented for a specific tenant. A user's **first** delegated sign-in has no tenant: the user types their own address at `/common` and Breeze learns `tid` only from the ID token that comes back.

**New phase `delegated_consent`**, sibling to the existing ones rather than a reuse of them:

1. **Initiate.** Create the `pending-consent` row (now legal, §4.1) + a `m365_user_consent_sessions` row carrying `state`, `nonce`, `codeVerifier`, and browser binding (`browserBinding.ts` reused unchanged). Authorize against **`/common`**, `response_type=code`, `code_challenge`, `prompt=select_account`. No `tenantHintHash` — there is nothing to hash yet.
2. **Callback.** Bind browser, consume state single-use, move row to `verifying`.
3. **Verify before persisting — the ordering v1 got backwards.** The executor exchanges the code, then, *in this order*:
   - validate the **ID token** (signature against the tenant's JWKS, `iss` matching the discovered issuer for the returned `tid`, `aud === clientId`, `nonce` equal to the session nonce, `exp`/`iat`);
   - read `tid` and `oid` from those validated claims and **pin** them;
   - acquire a Graph access token and probe `GET /me?$select=id,userPrincipalName,mail`, asserting `id === oid`;
   - reconcile the granted **`scp`** against the profile's `delegatedPermissions` — string-set comparison, not `appRoleAssignment` enumeration (new `reconcileCommunicationsDelegated` beside `reconcile.ts`);
   - **only then** write the token cache and return.

   v1 persisted the refresh token first and verified afterwards, which stores a live mailbox credential for an identity that has not yet been proven to be the expected one. If any check fails, nothing is persisted.
4. **Tenant allowlisting.** The learned `tid` is checked against whatever tenant policy the partner has *after* it is known, not before. A first connection defines the expected tenant for that user; a **reconnect that returns a different `tid` is refused** (`tenant_mismatch`) rather than silently re-pinning — otherwise reconnect becomes a mailbox-substitution primitive.

**On the discarded-grant residual:** if verification fails at step 3, Microsoft has already issued a refresh token that Breeze then throws away. Breeze cannot revoke it (that needs a scope the profile does not hold). It is unused, never persisted, and dies of inactivity — but this is a real residual and belongs in the runbook, not in a comment.

**Identity-token validation, not access-token parsing.** v1's §6 step 4 proposed a claims gate that reads `tid`/`oid`/`appid` from the token before each Graph call. Two corrections: (a) the Graph **access token is not ours to parse** — its audience is Graph, its format is unstated, and treating it as a claims source is a documented anti-pattern; (b) `appid` is a **v1-endpoint** claim, while these executors use the v2 endpoint where the equivalent is `azp`. v2's gate therefore uses the *pinned* `tid`/`oid` from consent-time ID-token validation, re-asserted per request against MSAL's `account.idTokenClaims` and the request's `expectedUserObjectId`, plus the `GET /me` identity assertion on the read path. No access-token introspection anywhere.

## 5. Binding approved content to sent content

This is the section v1 got most wrong, and the one that matters most: for the two shipped write actions the mapper carries only `userIdentifier`, so the weakness is narrow. **For mail, the recipients, subject, and body all ride through it.**

### 5.1 The chain is broken in the middle

What exists today, end to end:

| Step | Code | What is bound |
|---|---|---|
| Create | `intentService.ts:293-312` | `argumentDigest = sha256(canonicalize(arguments))` |
| Approve | approval row | `boundArgumentDigest` copied from the intent |
| Release | `revalidateRelease.ts:41-43` | `winningApproval.boundArgumentDigest !== intent.argumentDigest` — **two stored strings** |
| Dispatch | `m365ToolsHeadless.ts:64-70` | builds a **fresh** typed request from `arguments` |
| Transport | `graphActionsExecutorClient.ts:153-192` | `bodySha256` over **that new body** |
| Executor | `internalAuth.ts:85-103` | verifies the body matches the JWT it was sent with |

Every link is sound in isolation and the composition still has a gap: **nothing recomputes the digest from `arguments`, and the executor never sees the approved digest.** `bodySha256` proves the API's bytes were not altered in transit; it proves nothing about whether those bytes are what a human approved. Any defect between `arguments` and the outgoing request — a mapper bug, a schema coercion, a field silently dropped by `.strict()` — changes the effect while both digest checks still pass.

The mitigating fact, which is why this is a design gap and not a shipped vulnerability: `arguments` is **DB-immutable**, enforced by trigger (`2026-07-18-action-intents.sql:97-115, 122`). So today the input to the mapper cannot change between approval and release. The chain relies entirely on that trigger plus mapper correctness, and it degrades silently if either assumption weakens.

### 5.2 What v2 does: a canonical effect envelope, recomputed inside the executor

**One envelope, built once, carried verbatim, verified at the far end.**

```ts
// packages/shared/src/m365/commsEffect.ts
type CommsSendEffect = {
  envelopeVersion: 1;
  action: 'm365.comms.mail.send';
  actionVersion: number;
  connectionId: string; tenantId: string; senderObjectId: string; consentGeneration: number;
  to: string[]; cc: string[]; bcc: string[];        // lowercased, deduped, sorted
  subject: string; bodyText: string;
  inReplyToMessageId: string | null;
};
effectDigest = sha256(canonicalize(envelope))
```

1. **The envelope *is* the intent's `arguments`.** Not a projection of them, not derived from them at release. `argumentDigest` is therefore literally the effect digest, and the immutability trigger already protects it.
2. **The mapper stops mapping.** `m365CommsToolsHeadless` validates the stored envelope against the shared schema and passes it through **unchanged**. There is no rebuild step, so there is no rebuild bug. (Schema validation may *reject*; it may never *transform*.)
3. **The signed internal JWT carries `effectDigest` as a claim**, set from the stored `intent.argumentDigest` — the value the approval bound — never from a fresh computation on the release path.
4. **The executor recomputes** `sha256(canonicalize(receivedEnvelope))` and refuses unless it equals the `effectDigest` claim. This is the link v1 lacked: the process that talks to Graph independently verifies that the bytes it is about to send are the bytes a human approved.
5. **`revalidateApprovedIntentForRelease` gains a recompute**, cheap defense-in-depth against any write that bypassed the trigger (superuser, disabled trigger, restore): recompute from `intent.arguments` and compare to `intent.argumentDigest`; mismatch ⇒ `digest_mismatch`, same error code, no new taxonomy.

**The canonicalizer must be shared, not reimplemented.** `canonicalizeArguments`/`computeArgumentDigest` (`apps/api/src/services/actionIntents/canonicalize.ts`) are pure, dependency-free, and already correct (sorted keys, `undefined` dropped, cycle detection). Move them to `packages/shared` and have both the API and the executor import the same module. **A second implementation is a second canonicalization, and a digest scheme with two implementations has none.** Mail bodies carry arbitrary Unicode, so the shared test vectors must include non-BMP characters, lone-surrogate-adjacent sequences, CRLF, and long bodies.

**Sender pinning (change 2).** The envelope carries `connectionId`, `tenantId`, `senderObjectId`, `consentGeneration`, and `action_intents.connection_id` / `tenant_id` — which already exist and are already trigger-protected (`2026-07-18-action-intents.sql:109-110`) but are never populated (`intentService.ts:65-75, 293-312`) — are set at creation from the same values. `CreateActionIntentInput` gains an optional `binding: { connectionId, tenantId }`.

At release, the loaded connection must match on **all four**. `connectionId` alone is insufficient, and this is the subtlety v1 missed: **reconnect reuses the same row** (§3.3), so a revoked-and-reconnected mailbox — possibly a different mailbox, if the user signed in as someone else — keeps its id. `consent_generation` (new `integer NOT NULL DEFAULT 0` column, bumped in the §4.1 promotion UPDATE) is what actually detects it. Mismatch ⇒ `binding_stale` ⇒ the intent terminalizes and the user re-requests. Approved content is never released against a credential that was re-established after the approval.

## 6. Principal kind — the blocking prerequisite

**This is not a comms feature. It is a missing authorization primitive that comms happens to be the first caller to require, and it should land before task 1 as its own change.**

Three facts about shipped code, verified directly:

1. **MCP auto-executes Tier-3 tools with no approval** — by design, documented in place: *"MCP server auto-executes Tier 3 tools without approval — the API key holder is trusted at the scope level. Approval flow is for interactive UI only."* (`mcpServer.ts:998-999`).
2. **An API key *is* its creator.** `buildAuthFromApiKey` sets `user.id = apiKey.createdBy` (`mcpServer.ts:1880`).
3. **`AuthContext` cannot tell the difference.** It carries `scope`, `partnerOrgAccess`, `allowedSiteIds`, `helperDeviceId` — and no principal or transport discriminator (`middleware/auth.ts:18-88`).

Composed: an API key minted by the mailbox owner satisfies a user allowlist, a connection-owner check, and user-axis RLS — all three of §3.4's gates — and then **auto-executes a Tier-3 send as that human, with no approval and no interactive session.** Every downstream control in this design is anchored to "the owning user," and that phrase is currently unable to mean "a human at a keyboard."

**The primitive:**

```ts
// middleware/auth.ts — required, not optional, so every construction site must decide
principal: {
  kind: 'user_session' | 'api_key' | 'oauth_grant' | 'agent' | 'helper';
  apiKeyId?: string;      // set iff kind === 'api_key'
  grantId?: string;       // set iff kind === 'oauth_grant'
}
```

Making it non-optional is the point: TypeScript then enumerates every place an `AuthContext` is built, which is the only reliable way to find them all. Introducing it as optional would let existing construction sites default to "looks like a human."

**Comms requires `kind === 'user_session'`** at tool registration, at intent creation, and again at release-time revalidation. Everything else is refused with `user_actor_required`. Belt and braces, because these are three different trust moments.

**Comms tools are additionally suppressed from MCP entirely** — absent from `tools/list` *and* denied in `tools/call`. Absence from a listing is discoverability, not authorization; both are required.

**Open question for Todd, restated because it is bigger than this design:** fact (1) is deliberate and documented, but it means the *shipped* `m365_disable_user` and `m365_reset_password` execute with no approval for any API key holding the scopes. That is a defensible answer for read tools and a surprising one for account disable and password reset. Whatever the answer, comms must be `user_session`-only regardless — but the answer determines whether that is a special case or the first instance of a general rule.

## 7. Typed action catalog (first cut — ruthless)

New `packages/shared/src/m365/commsActions.ts`. Five actions. Mail only. **All Teams actions deferred** despite §11.1 naming them — see §12 flag 4.

| Action | Tier | Notes |
|---|---|---|
| `m365.comms.mail.list` | 1 | folder ∈ {inbox, sentitems, drafts, archive}, optional search (same constrained `searchTermSchema` charset as `readActions.ts:7`), `sinceHours ≤ 720`, `pageSize ≤ 25`. Projection allowlist: `id, subject, from, toRecipients, receivedDateTime, sentDateTime, isRead, hasAttachments, bodyPreview, conversationId, internetMessageId`. **Never full `body`** in list. |
| `m365.comms.mail.get` | 1 | by message id. Projection adds `body` (content capped at 64 KiB, HTML passed through as text — the executor truncates and flags, mirroring `graph_response_too_large` semantics). Attachments: names/sizes only, never content (v1). |
| `m365.comms.mail.draft.create` | 2 | `to/cc` (≤ 20 recipients total, strict email regex), `subject ≤ 500`, `bodyText ≤ 32_000` chars, optional `inReplyToMessageId` (executor uses Graph `createReply` then patches body, preserving threading). Result: `draftId`, `webLink`. Reversible → Tier 2 per §9.1 (master lines 236-243). |
| `m365.comms.mail.send` | **3** | Full literal content inline: `to/cc/bcc`, `subject`, `bodyText`, optional `inReplyToMessageId`. Same caps as draft. **No draftId-send in v1** — see §8. |
| (executor ops) `complete-consent`, `retest` | — | consent/verification ops, comms-specific result shapes (§4.2). |

Failure codes: the read set (`readActions.ts:104-115`) plus `delegated_reauth_required`, `credential_rotation_failed`, `mailbox_not_found`, `message_not_found`, `recipient_rejected`.

Deferred, in rough priority order: reply/reply-all/forward as first-class send variants; draft-send with content re-verification; attachments (a DLP program of its own); mail move/categorize; **all** Teams chat/channel reads and posts; calendar.

Precedent for this ruthlessness: the actions executor shipped with exactly two write actions (`writeActions.ts:10-13`).

## 8. Sends and the durable intent/approval layer

The plumbing already exists and fits: Tier-3 tool → immutable intent with canonical `argumentDigest` (`actionIntents.ts:78-91`) → approval bound to `boundArgumentDigest` → outbox → release worker CAS `approved→executing` → revalidation chain → headless dispatch (`intentReleaseWorker.ts:242-385`). The comms integration is a fourth headless family beside Google/M365-write:

- `M365_COMMS_HEADLESS_ACTIONS = { m365_send_mail: 'm365.comms.mail.send' }` in a new `m365CommsToolsHeadless.ts`, pinned to the tier-3 tool map by the same parity-test pattern as `m365ToolsHeadless.ts:24-29`.
- `executeM365CommsToolHeadless(actionName, args, orgId, userId, intentId)` — the release worker passes `intent.requestedByUserId` (new: the existing dispatch at `intentReleaseWorker.ts:357-366` only passes org; comms requires the user). Refusal taxonomy mirrors `m365ToolsHeadless.ts:35-44`: connection-level refusals throw `M365ConnectionUnavailableError` (→ `failed:connection_unavailable`, no side effect); Graph-level failures return tool errors. **Unlike its sibling it performs no argument mapping** — it validates and forwards the stored envelope (§5.2).

**Exact-content binding (§11.1's hard requirement)** is specified in §5 and is the largest change from v1. Summary of what this section relies on:
1. The intent's `arguments` **are** the canonical effect envelope — complete literal recipients, subject, and body — so `argumentDigest` *is* the content hash, protected by the immutability trigger.
2. The digest is carried to the executor as a signed claim and **recomputed there** from the received envelope. `bodySha256` alone was never sufficient: it binds the API's bytes to the API's own request, not to what a human approved.
3. `targetSummary` = exact recipient list + subject; `impactSummary` = recipient count, subject, body length, first ~200 chars of body, and the digest. The approval UI additionally renders the full body by reading `intent.arguments` through the org-scoped, RBAC-gated intent endpoint — **not** by copying the body into approval/audit rows (§12 flag 3).
4. **Draft-send is banned in v1 precisely because it breaks this.** Graph drafts are mutable; approving "send draft X" binds an id, not content. If added later, the send action must carry the approved content hash and the executor must fetch the draft, canonicalize, compare, and fail closed on mismatch.
5. The sender is pinned at creation and re-checked at release (§5.2), so an approved body cannot be released from a mailbox that was reconnected in the interim.

**Duplicate-send safety.** `sendMail` is not idempotent at Graph. Defenses, in order: the single-use `approved→executing` CAS (`intentReleaseWorker.ts:251-259`) makes duplicate release effectively impossible; the executor never internally retries a send after an ambiguous outcome (a timeout mid-send maps to `graph_request_timeout` and terminalizes the intent — re-sending requires a fresh intent and fresh approval); `idempotencyKey = intent.id` is carried for audit and a future executor-side dedup store, same posture as `writeActions.ts:35-38`. Accepted residual: a crash between Graph's 202 and the `executing→completed` CAS yields `failed:execution_lost` for an email that did send — the same residual the siblings accept (`intentReleaseWorker.ts:461-475`), and for email the human-visible Sent Items folder is the recovery oracle.

**Drafts (Tier 2)** execute inline in the chat session like Tier-1 reads — no intent row — matching §9.1's "execute according to organization policy" with v1 policy = allowed for the allowlisted owner, fully audited via a `breeze_m365_comms_total{action,outcome}` counter + audit events (metrics pattern of runbook lines 162-168).

## 9. Executor internal design

`POST /v1/execute-action` (all five catalog actions ride one operation, like the read executor), `/v1/complete-consent`, `/v1/retest`, `/healthz`. Per execute request:

1. Verify internal JWT (audience `m365-communications-executor`) + `bodySha256`.
2. Validate request schema: `{correlationId, connectionId, tenantId, expectedUserObjectId, consentGeneration, cacheGeneration, idempotencyKey?, effectDigest?, envelope}`.
3. **For Tier-3 sends: recompute `sha256(canonicalize(envelope))` and refuse unless it equals the `effectDigest` claim** (§5.2). This precedes credential access — an unapproved effect must never even cause a token acquisition. Failure code `effect_digest_mismatch`.
4. Acquire a token via MSAL `acquireTokenSilent` for the `connectionId` partition, with the cache plugin taking a short lease and CAS-writing any rotation (§3.2). Lease contention ⇒ bounded wait, re-read, retry silent.
5. **Identity gate before any Graph call** (master §5 Microsoft boundary, §18.3): assert MSAL's `account.idTokenClaims.tid === tenantId` and `.oid === expectedUserObjectId` against the values pinned at consent. **No parsing of the Graph access token** and no `appid` check — see §4.2. Mismatch → `tenant_mismatch` / `identity_token_invalid`, fail closed.
6. Execute the typed action against fixed `graph.microsoft.com` paths (`/me/messages`, `/me/sendMail`, `/me/messages/{id}/createReply`); project through the per-action field allowlist; enforce response-size/pagination/time bounds (read-executor `graphClient.ts` bounds pattern).
7. Return `{...result, usedCacheGeneration, rotated?: boolean}`.

Redaction is stricter than the siblings because payloads are correspondence: the executor's error normalization must strip message bodies, recipient lists, and subjects from every log/exception path; logs carry correlation id, action type, connection id, and counts only (§12, master lines 334-347).

## 10. Enablement, boot validation, allowlists

Mirrors `writeActionRuntimeConfig.ts:195-281` with the axis swapped to users:

| Var | Meaning |
|---|---|
| `M365_COMMS_ONBOARDING_ENABLED` / `M365_COMMS_ONBOARDING_USER_IDS` | Gates the connect/reconnect/disconnect card. UUID list or `*`; list required when enabled; boot-fails otherwise. v1 ships with exactly one UUID — but the design is N-user from day one; nothing may hardcode a single user. |
| `M365_COMMS_TOOLS_ENABLED` / `M365_COMMS_TOOLS_USER_IDS` | Gates tool registration + headless release dispatch. Cheap env-only check on the hot registration path (the `isM365GraphActionsEnabledForOrg` pattern, `writeActionRuntimeConfig.ts:253-261`). |
| `M365_COMMS_CLIENT_ID`, `M365_COMMS_EXECUTOR_URL/AUDIENCE/SIGNING_KID/SIGNING_PRIVATE_JWK_FILE` | Sibling-identical, new names/keys. No vault vars API-side at all: the API never touches the comms vault. |
| Executor side | client id; callback URL (byte-match trap — runbook gotcha (c) applies verbatim); vault URL + **two version-pinned refs**, `M365_COMMS_CLIENT_CERT_VAULT_REF`/`_VERSION` and `M365_COMMS_TOKEN_CACHE_KEK_VAULT_REF`/`_VERSION` (both immutable, so the siblings' boot-validation pattern at `config.ts:175-185` applies unchanged); token-cache store DSN; public JWK/kid/issuer/audience; azure credential mode; private bind host/port. |

**`MAX_REPLICAS=1` is gone**, and its removal is the point of §3.2: v1 leaned on a constraint no rolling deployment can honour. Concurrency safety is now the lease + CAS in the token-cache store, which is testable and does not constrain the deployment topology.

`validateM365CommunicationsRuntimeConfigAtBoot` force-loads everything when either flag is on, added to `apps/api/src/config/validate.ts` beside the actions checks. Dark deploy sequence mirrors runbook lines 149-157: executor dark by digest, healthz only, consent one user, allowlist that one UUID, exercise list→get→draft→approve→send→verify in Sent Items, then stop — there is no "expand gradually" story until a second communications user actually exists.

## 11. First cut vs deferred

**Prerequisite, shipped separately and first:** the principal-kind discriminator (§6).

**Ships:** the five §7 actions; the delegated consent phase + status-aware constraint (§4); the canonical effect envelope with executor-side digest recomputation and sender pinning (§5); MSAL confidential client + encrypted CAS token cache (§3.2); degraded-on-invalid_grant + reconnect UX; the release-worker user-axis dispatch; user-allowlist gating; the user-axis RLS behavioural tests (§3.4); deploy runbook.

**Deferred (recorded, not designed):** Teams entirely; reply/forward send variants; attachments; draft-send-with-verification; scheduled RT health probes (v1 discovers death lazily on next use + expiry alerting); manifest trim re-consent tooling beyond the ordinary version-bump path; any org-level policy over comms tools (v1 policy = the user allowlist).

**No longer deferred, because v2 removed the need:** multi-replica executor (§3.2 makes it the default rather than a future project) and automated credential purge on revoke (the cache store supports deletion, so revoke deletes the row instead of filing a runbook task).

## 12. Master-spec flags (things §11.1's parent gets wrong or leaves ambiguous)

1. **§6.3 "clears token and session state" (line 139)** is not compatible with delegated refresh-token reality; per-call redemption *increases* rotation races. Amend to: "clears credential material; MAY cache non-reusable short-lived access tokens in memory within their validity."
2. **§10.1 vs `action_intents.org_id NOT NULL`:** user-owned work still needs an org anchor for approval routing/RLS/audit. This design picks "requesting session's org context"; the master spec should codify it.
3. **§10.2 "approval UI shows proposed message content" vs §12 "unrestricted message payloads prohibited from approval summaries."** These conflict as written. Resolution here: content lives once, in `intent.arguments` (org-RLS + RBAC-gated read); approval *summaries*, audit details, and exports carry recipients/subject/digest/lengths only. The spec should adopt this split explicitly.
4. **`profiles.ts:65-75` requests Teams scopes (`Chat.ReadWrite`, `ChannelMessage.Read.All`, `ChannelMessage.Send`) that v1 will not exercise.** The actions runbook's own principle (line 40: consenting unexercisable scopes "only widens the mutation blast radius") says trim them. Recommendation: bump `communications-delegated` to version 2 with mail-only scopes; delegated re-consent is one sign-in by one user — the cheapest re-consent in the whole system. Restore Teams scopes with the Teams catalog.
5. **§6.1's version-pinned `put`/`get`-only provider** implicitly assumes immutable credentials. v2 keeps the provider read-only and version-pinned (§3.2) — but the *rotating* material needs a store the spec does not currently contemplate. §6.1's "Breeze Postgres does not store refresh tokens" should be restated as the property it actually wants: **no component may hold credential material it can decrypt outside its own credential domain.**
6. **§6.3's credential-boundary model assumes one credential per domain.** The comms domain has N per domain, keyed by connection, with a lifecycle the platform does not control. The abstraction should name per-domain *cardinality* alongside access shape.
7. **The master spec has no position on principal kind** (§6 here). It repeatedly says "the user," and shipped code cannot distinguish a user from a key minted by that user. This is a control-plane-wide gap, not a comms one.

## 13. Risks (most likely failures first)

1. **Correspondence leaking into logs/audit/approvals.** Now risk #1: it is the failure with the widest blast radius that no single gate prevents. Redaction tests must be first-class (master §12 verification bullet, line 467); the approval-summary split in §12 flag 3 is load-bearing.
2. **Rotation loss → surprise reauth.** Mitigated by lease + CAS, `degraded` + reconnect UX, correlation logging. Demoted from v1's #1 because §3.2 makes it rare rather than structural — but never zero.
3. **Duplicate or lost sends at the crash boundary.** §8; residual matches siblings; Sent Items is the oracle; never auto-retry a send.
4. **A second canonicalizer.** If the executor ever reimplements canonicalization instead of importing the shared module, every digest check silently becomes a self-consistency check. Guard with shared test vectors executed by both packages (§5.2).
5. **Cross-user access on the user-axis policy branch.** The branch is tested (`m365ConnectionsRls.integration.test.ts:160-235`); what is untested is *this table's user-owned rows under the coverage contracts*, which cannot see them at all (§3.4). Behavioural tests are the only proof — do not ship without them.
6. **The single-user assumption calcifying.** Everything is keyed by `connectionId`/`userId`; the allowlist is the only place "one user" appears.
7. **CA/MFA policy changes killing the RT mid-flight** (password reset, sign-in risk, device policy). Same handling as revocation: `delegated_reauth_required`, degrade, alert (master §14 already covers "delegated sessions approaching expiration," line 384).
8. **Sends are literally a named human** — a compromised approval chain here is impersonation of a person, not an app. This is why the principal-kind gate (§6), the owner-equals-requester release check (§3.4), the sender pinning (§5.2), and the executor-side digest recomputation (§5.2) are each mandatory *independently*. None of them subsumes another.
9. **Token-cache store placement.** If the fallback (Breeze Postgres) is chosen without the §3.2 spec amendment, the credential boundary erodes by precedent rather than by decision — the exact failure mode the boundary exists to prevent.

## 14. Task breakdown (TDD-shaped, commit per task)

Format mirrors `docs/superpowers/plans/integrations/2026-07-22-m365-customer-graph-actions-consent.md`.

**Task 0 ships as its own PR, before anything else here.** It is independently valuable, touches auth for the whole product, and must not be reviewed as part of a mail feature.

0. **Principal-kind discriminator** (§6) — add the required `principal` field to `AuthContext` (`middleware/auth.ts`); let the compiler enumerate every construction site and set each one deliberately (`buildAuthFromApiKey` → `api_key` with `apiKeyId`, session auth → `user_session`, helper → `helper`, agent → `agent`, MCP-OAuth → `oauth_grant`); tests asserting each builder's kind. **No behaviour change in this PR** beyond the field existing — gating lands with its consumers, so a regression here is isolable.

**Then, per the §0 changes, in dependency order:**

1. **Shared canonicalizer** — move `canonicalizeArguments`/`computeArgumentDigest` from `apps/api/src/services/actionIntents/canonicalize.ts` to `packages/shared`; re-export from the old path so no call site changes; shared test vectors (non-BMP, surrogate-adjacent, CRLF, 32 KiB bodies) executed by **both** the API and executor packages (§5.2). Pure move + vectors, no behaviour change.
2. **Shared catalog + effect envelope** — `packages/shared/src/m365/commsActions.ts` and `commsEffect.ts` (+tests): 5-action union, recipient/size caps, projection allowlists, failure-code enum (incl. `effect_digest_mismatch`, `binding_stale`, `consent_superseded`), the `CommsSendEffect` envelope with recipient normalization (lowercase/dedupe/sort) and its digest helper; export from `@breeze/shared/m365`.
3. **Profile trim** — `profiles.ts`: bump `communications-delegated` to version 2, mail-only delegated scopes, **retaining `offline_access`** (test asserts the exact scope set + version); confirm `connectionNeedsConsentReconciliation` flags stored-v1 rows.
4. **Migration: constraint relaxation, consent sessions, delegated columns** — `apps/api/migrations/2026-07-28-a-m365-comms-delegated.sql`: status-aware `m365_connections_credential_location_check` (§4.1, with the ROW_COUNT reporting the cleanup rule requires); unique index `m365_connections (id, user_id, profile, consent_attempt_id)`; `m365_user_consent_sessions` (system-only forced RLS, composite user-axis FK, expiry index); `ADD COLUMN IF NOT EXISTS delegated_user_object_id UUID`, `consent_generation INTEGER NOT NULL DEFAULT 0`, `observed_delegated_scopes JSONB NOT NULL DEFAULT '[]'`. Idempotent; schema file + `pnpm db:check-drift`.
5. **RLS contract + behavioural tests** — register `m365_user_consent_sessions` in the system-only allowlist and `m365_connections` in `USER_ID_SCOPED_TABLES` (`rls-coverage.integration.test.ts`); add `m365CommsUserRls.integration.test.ts`: cross-user forge (42501), **different-user denial and keyed/no-user-context denial** (§3.4 — *not* v1's incorrect "org token sees nothing" assertion), consent-session tenant-read refusal. Real-DB job. State in the PR that the coverage contracts cannot see user-owned rows.
6. **Intent binding** — extend `CreateActionIntentInput` with optional `binding: {connectionId, tenantId}` and populate the existing immutable columns (`intentService.ts`); add the digest recompute to `revalidateApprovedIntentForRelease` (`revalidateRelease.ts`) (+tests: recompute mismatch ⇒ `digest_mismatch`, binding populated on create, trigger still rejects mutation).
7. **Comms runtime config + boot validation** — `commsRuntimeConfig.ts` (+tests): user-ID allowlist parsing, the two version-pinned vault refs, token-cache DSN, JWK file perms (clone `writeActionRuntimeConfig.ts` tests); wire `validate.ts`.
8. **Executor scaffold** — `apps/m365-communications-executor/`: config loader, `internalAuth` with new audience, Hono app for 4 operations + healthz; port sibling suites, then the deltas. **Wire CI in this same PR** — test, typecheck, image build, Trivy, Dependabot, release image, and the `check-supply-chain-hardening.sh` service-name pin. (#2893 exists because the actions executor shipped without any of it.)
9. **Executor token cache** — `credentials/tokenCache.ts` (+tests): AES-256-GCM wrap/unwrap under the KEK, CAS write, lease acquire/release/expiry, KEK two-version read window, concurrent-redemption test proving one winner and no orphaned RT.
10. **Executor MSAL client** — `microsoft/delegatedClient.ts` (+tests): confidential client with cert assertion, partitioned `ICachePlugin` over task 9, `acquireTokenSilent`, auth-code redemption with PKCE, `invalid_grant → delegated_reauth_required`. All HTTP mocked.
11. **Executor operations** — `operations.ts` (+tests): **effect-digest recomputation before credential access**; identity gate from pinned `tid`/`oid` via MSAL account claims (no access-token parsing, no `appid`); consent op with the §4.2 verify-then-persist ordering and `scp` reconciliation; retest; execute-action dispatch across the 5 actions; projection enforcement; redaction of bodies/recipients/subjects from every error path (explicit leak tests).
12. **API executor client** — `commsExecutorClient.ts` (+tests): clone of `graphActionsExecutorClient.ts` against the comms schemas/audience, carrying the `effectDigest` claim from the **stored** `intent.argumentDigest`.
13. **API comms action service** — `commsActionService.ts` (+tests): user-axis ladder — principal kind → user allowlist → connection by `userId` under ambient/caller RLS → owner check (fail closed) → binding match (all four fields, §5.2) → status (`active` only for send; `active|degraded` for reads, per `writeActionService.ts:20-25`) → budget → executor call → cache-generation writeback → `degraded` on `delegated_reauth_required`; metrics `breeze_m365_comms_total`.
14. **Delegated consent phase + routes + UI** — the §4.2 phase (`/common` authorize, no tenant hint, verify-then-persist, atomic promotion, reconnect tenant-mismatch refusal); initiate/callback routes over `m365_user_consent_sessions`; browser binding reused; UI card (connect/reconnect/disconnect, "Signed in as <UPN>") behind the onboarding flag; i18n ×5 locales; `runAction` for all mutations.
15. **AI tools (tier 1/2)** — `m365_list_mail`, `m365_get_mail`, `m365_draft_mail` (+ tier map + gating tests): registered only for allowlisted owning users with `principal.kind === 'user_session'`; site-scope refused; **suppressed from MCP `tools/list` and denied in `tools/call`** (§6), with a test per half.
16. **Tier-3 send + headless release** — `m365_send_mail` creating intents whose `arguments` **are** the envelope, plus summaries; `m365CommsToolsHeadless.ts` that validates-and-forwards without mapping (+ tier-parity test); `intentReleaseWorker.ts` dispatch branch passing `intent.requestedByUserId` (+ `user_actor_required` for key-actor intents); worker tests for owner-mismatch, stale-binding, and connection-unavailable taxonomy.
17. **Integration proof** — consent→active→list→draft→intent→approve→release→sent (executor HTTP mocked at the client seam); digest-drift refusal; **executor-side digest mismatch refusal**; reconnect-bumps-generation invalidates an approved intent; reauth-required degrade/reconnect; concurrent redemption.
18. **Deploy runbook + plumbing** — `docs/deploy/m365-communications-executor.md` (env tables, **read-only** vault scoping for two immutable secrets, token-cache store provisioning and its placement decision, callback byte-match gotcha, rollback = tools flag off, discarded-grant residual from §4.2); `.env.example` entries; no compose service block.

**Watch item carried from the actions work:** the next release tag publishes the `m365-graph-actions-executor` image for the first time (#2893 added the job; `deploy/.env.example` has been telling operators to pin a digest that never existed). Verify that before adding a fourth executor image to the same pipeline.
