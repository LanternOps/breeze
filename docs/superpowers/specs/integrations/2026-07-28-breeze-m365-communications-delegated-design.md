# Breeze M365 Communications-Delegated Executor — Design Spec

**Date:** 2026-07-28
**Status:** Proposed design, pre-implementation
**Stage:** Delivery-sequence stage 4/5 remainder (master spec §17, `docs/superpowers/specs/integrations/2026-07-13-breeze-m365-control-plane-design.md:476-489`) — the communications executor defined in §11.1 (lines 306-311).

## 1. Summary

Build `apps/m365-communications-executor/`, the third narrow M365 executor, serving the `communications-delegated` profile (`packages/shared/src/m365/profiles.ts:58-77`): typed mail reads, draft creation, and Tier-3 approved sends from the owning user's own mailbox, using **per-user delegated refresh tokens**.

The read and actions executors are structural siblings of each other because they share one credential shape: a single, immutable, org-consented application certificate, version-pinned in env at boot (`apps/m365-graph-actions-executor/src/config.ts:168-185`). The communications executor **cannot** be a third re-key of that template, because its credential is the opposite in every dimension that matters:

| Dimension | Read/Actions executors | Communications executor |
|---|---|---|
| Credential | 1 app certificate, platform-owned | N refresh tokens, one per owning user |
| Mutability | Immutable; rotated by controlled migration | **Rotates on redemption**; Microsoft decides when |
| Cardinality vs env | 1 secret ⇒ pinnable as `VAULT_REF` env | per-connection ⇒ cannot live in env at all |
| Vault access | `get` only | `get` **and** `set` (write-back of rotated tokens) |
| Acquisition | Customer admin consent (app-only) | Owning user's own sign-in (auth code + PKCE) |
| Death | Cert expiry (years, scheduled) | invalid_grant at any moment (revocation, password reset, CA policy, 90-day inactivity) |
| Who acts | The app's service principal | **The human user** — sends appear as that person in recipients' inboxes and in the tenant audit log |
| Tenancy | `ownerAxis: 'org'` | `ownerAxis: 'user'` |

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

### 3.1 Credential storage: per-connection Key Vault secrets, executor write-back

**Where refresh tokens live.** Azure Key Vault, in the isolated `communications-delegated` domain — **not** DB-encrypted columns. The Google precedent (service-account JSON encrypted via secretCrypto in `apps/api/src/db/schema/google.ts:21-22`) is explicitly not the model here: master spec §6.1 (lines 103-117) locks "Breeze Postgres … does not store … refresh tokens," and §18.7 requires that only the selected executor can access its credential domain. A DB-stored token would be readable by the API process and its encryption key — exactly the collapse §5's credential boundary exists to prevent. The `m365_connections_credential_location_check` constraint (`apps/api/migrations/2026-07-13-m365-control-plane-foundation.sql:105-110`) already enforces vault-ref-only for all non-legacy profiles, including `communications-delegated`.

**Naming.** One secret per connection: `m365-comms-delegated-<connectionId>`, value a strict JSON envelope mirroring the certificate envelope (runbook lines 46-53): `{schemaVersion: 1, domain: 'communications-delegated', material: {kind: 'delegated-refresh-token', refreshToken}}`, no extra fields. `m365_connections.vault_ref` stores `akv://<host>/m365-comms-delegated-<connectionId>/<32-hex-version>`.

**The version-pinning divergence — the most important call in this design.** The siblings pin one immutable secret *version* in env and validate it at boot (`config.ts:175-185`). A rotating credential makes that scheme self-defeating: pinning a version of a secret that Microsoft rotates guarantees eventual lockout on a stale token. Instead:

- The executor's env pins the **vault origin and the secret-name prefix** (`m365-comms-delegated-`), never a version.
- Per request, the API's signed job carries `connectionId` + `tenantId` + `expectedUserObjectId` + the DB's current `credentialVersion` (observability, not a fetch key). The executor **derives the secret name from `connectionId` itself** and reads the **latest enabled version**. No caller-supplied vault reference is ever accepted — this preserves §6.1's "no caller-supplied vault reference" rule in a stronger form than the siblings (they at least carry a full ref in env; here the executor constructs it).
- When a token response includes a rotated `refresh_token`, the executor `set`s a new secret version **before** using the paired access token, and returns `{usedCredentialVersion, rotatedCredentialVersion?}` in every response. The API CASes `m365_connections.credential_version`/`vault_ref` forward (`WHERE credential_version = <old>`); a lost CAS is logged, never fatal (DB version is bookkeeping, the vault's latest is authoritative).

**Vault permissions.** The comms executor identity gets `get` + `set` on secrets — a real widening versus the siblings' read-only grant, and the reason this executor above all must never share an identity or vault scope with them. No `delete`: AKV deletion is name-wide (§6.1 line 117), so v1 revocation marks the row `revoked` and purges via a runbook, not code.

**Failure modes accepted in v1:**
- *Write-back succeeds, response lost:* old RT versions remain in the vault but the latest is correct; DB `credential_version` is stale until the next successful call. Harmless because latest-read is authoritative.
- *Write-back fails after redemption:* if Microsoft has rotation enabled for the client, the in-vault RT may now be dead. The executor returns `credential_rotation_failed`; the API marks the connection `degraded` with `last_error_code`, and the UI shows "Reconnect". No silent retry loops.
- *Concurrent redemption:* v1 requires **exactly one executor replica** (boot-documented constraint) plus a per-connection in-process mutex around redemption. Multi-replica needs a vault-lease or DB advisory-lock design — explicitly deferred.

**Access-token caching — a deliberate amendment to the master spec.** §6.3 step 6 ("clears token and session state," line 139) is written for app-only flows where token acquisition is cheap and side-effect-free. Delegated redemption is neither: every redemption is a rotation opportunity and a failure opportunity. The comms executor keeps the short-lived (~60 min) *access token* in memory per connection, keyed by `connectionId` and dropped at expiry-minus-skew or on any 401. Refresh tokens are never held beyond the operation that reads/writes them. **Flagging this as a spec deviation the master doc should absorb** — the alternative (redeem per call) measurably increases the invalid_grant/rotation-race surface it is supposed to avoid.

### 3.2 Lifecycle: acquisition, rotation, revocation, reauth

```
pending-consent → verifying → active ⇄ degraded → revoked
```
(existing statuses, `apps/api/src/db/schema/m365.ts:28-34`; no new states)

- **Acquisition (consent).** Delegated auth-code + PKCE sign-in by the *owning user* — not admin consent. Reuses the shipped `identity_verification` phase machinery (nonce + codeVerifier, `m365.ts:140-153`; browser binding in `browserBinding.ts`) but the executor's `complete-consent` diverges from `operations.ts:120-173`: after code exchange and ID-token verification it **persists the refresh token to the vault**, acquires a delegated Graph access token, probes `GET /me` (+ mailbox settings), verifies `tid`/`oid` claims, reconciles the **`scp` claim** against the manifest's `delegatedPermissions` (delegated reconciliation is scope-string comparison, not appRoleAssignment enumeration — a new `reconcileCommunicationsDelegated` beside `reconcile.ts`), and returns tenant, user object id, UPN, observed scopes, and the created vault version. The refresh token never transits the API.
- **Rotation.** §3.1 write-back. No scheduled rotation job in v1; rotation is event-driven by Microsoft.
- **Expiry tracking.** Refresh tokens die after ~90 days of *inactivity* (sliding). On every successful redemption the API stamps `last_verified_at` and sets `expires_at = now() + 90d`. The existing expiry alerting surface (§14, master lines 384-385) keys off `expires_at`.
- **Revocation / reauth.** `invalid_grant`/`interaction_required` from the token endpoint maps to a new failure code `delegated_reauth_required`: the API sets `status='degraded'`, `last_error_code`, and every subsequent tool call refuses with a "Reconnect Microsoft 365 communications" message. Reconnect = a fresh consent attempt on the same row (new `consent_attempt_id`), same as the sibling reconnect path. Breeze-side revoke sets `revoked` and (runbook) purges the vault secret.

### 3.3 Tenancy: `ownerAxis: 'user'`

**Connection rows: no new shape needed.** The foundation migration already made `m365_connections` org-XOR-user (`m365_connections_owner_check`, `2026-07-13-m365-control-plane-foundation.sql:72-74`), already pins `communications-delegated → user_id NOT NULL + delegated + communications-delegated domain` (`profile_binding_check`, lines 112-119), and already carries the three-branch RLS policy `system OR breeze_has_org_access(org_id) OR user_id = breeze_current_user_id()` (lines 143-166). The user branch is CLAUDE.md **Shape 6** grafted onto a Shape-1 table.

**Gap to close:** the rls-coverage contract test auto-discovers `m365_connections` as an org table (its policy contains `breeze_has_org_access`) but nothing asserts the `breeze_current_user_id` branch — the same class of blindspot `DUAL_AXIS_TENANT_TABLES` exists to cover for org/partner (`rls-coverage.integration.test.ts:262-299`, `USER_ID_SCOPED_TABLES` at 510). This design adds an explicit cross-**user** forge test: user A must not read/write user B's communications connection even inside the same partner, and an org-scoped token must not see any user-owned row.

**Consent sessions: new table, and here is why.** `m365_consent_sessions` has `org_id NOT NULL` and a composite FK `(connection_id, org_id, profile, consent_attempt_id) → m365_connections(id, org_id, profile, consent_attempt_id)` (`m365.ts:96, 112-121`). A user-owned connection has `org_id NULL`; making the FK columns nullable silently disables the composite FK under `MATCH SIMPLE` for exactly the rows that need it. So: **`m365_user_consent_sessions`**, the same shape on the user axis, composite FK `(connection_id, user_id, profile, consent_attempt_id)` backed by a new unique index on `m365_connections (id, user_id, profile, consent_attempt_id)` (parallel to `attemptIdentityUniq`, `m365.ts:78-79`). RLS: system-only, exactly like its sibling (registered in the system-only allowlist, `rls-coverage.integration.test.ts:52,76`) — verifier/nonce material must never be tenant-readable. Cascade registration: it has `user_id` (FK CASCADE) and **no `org_id`**, so it joins neither `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts` — `m365_connections` itself is already there at line 216) nor the device lists; the rls-coverage and cascade contract suites are the proof, run in the same PR.

**Who may act.** Only the owning user, ever:
- Tool registration: comms tools appear only for sessions where `auth.user.id` is in the user allowlist **and** owns an `active` `communications-delegated` connection. Site-restricted sessions refused (mirrors `readActionService.ts:110-115`). API-key (`mcp_api`) principals: v1 **refuses** — a send-as-a-person must be anchored to a person (`requestedByUserId`), and `action_intents` allows key-only actors (`actionIntents.ts:66-72`). Failure code `user_actor_required`.
- Release time: the comms headless service loads the connection by `intent.requestedByUserId` and fails closed unless `connection.userId === intent.requestedByUserId` — the user-axis analogue of `writeActionService.ts`'s `wrong-org` check (lines 59-72). This is the single most important new invariant: **an approval can never cause a send from a mailbox its requester does not own.**

**Intent anchoring — master-spec ambiguity, resolved here.** §10.1 says intents record "organization/user ownership" (line 254), but `action_intents.org_id` is `NOT NULL` (`actionIntents.ts:61`) and the whole approval/RLS/audit chain is org-keyed. Decision: comms intents anchor to the **org context of the requesting session** (the customer being corresponded about, via `resolveWritableToolOrgId`), which routes approval visibility to the right customer context; mailbox ownership rides on `requestedByUserId` + the release-time owner check. The master spec should state this explicitly rather than implying user-owned intents might have no org.

## 4. Typed action catalog (first cut — ruthless)

New `packages/shared/src/m365/commsActions.ts`. Five actions. Mail only. **All Teams actions deferred** despite §11.1 naming them — see §9 flag 4.

| Action | Tier | Notes |
|---|---|---|
| `m365.comms.mail.list` | 1 | folder ∈ {inbox, sentitems, drafts, archive}, optional search (same constrained `searchTermSchema` charset as `readActions.ts:7`), `sinceHours ≤ 720`, `pageSize ≤ 25`. Projection allowlist: `id, subject, from, toRecipients, receivedDateTime, sentDateTime, isRead, hasAttachments, bodyPreview, conversationId, internetMessageId`. **Never full `body`** in list. |
| `m365.comms.mail.get` | 1 | by message id. Projection adds `body` (content capped at 64 KiB, HTML passed through as text — the executor truncates and flags, mirroring `graph_response_too_large` semantics). Attachments: names/sizes only, never content (v1). |
| `m365.comms.mail.draft.create` | 2 | `to/cc` (≤ 20 recipients total, strict email regex), `subject ≤ 500`, `bodyText ≤ 32_000` chars, optional `inReplyToMessageId` (executor uses Graph `createReply` then patches body, preserving threading). Result: `draftId`, `webLink`. Reversible → Tier 2 per §9.1 (master lines 236-243). |
| `m365.comms.mail.send` | **3** | Full literal content inline: `to/cc/bcc`, `subject`, `bodyText`, optional `inReplyToMessageId`. Same caps as draft. **No draftId-send in v1** — see §5. |
| (executor ops) `complete-consent`, `retest` | — | consent/verification ops, comms-specific result shapes (§3.2). |

Failure codes: the read set (`readActions.ts:104-115`) plus `delegated_reauth_required`, `credential_rotation_failed`, `mailbox_not_found`, `message_not_found`, `recipient_rejected`.

Deferred, in rough priority order: reply/reply-all/forward as first-class send variants; draft-send with content re-verification; attachments (a DLP program of its own); mail move/categorize; **all** Teams chat/channel reads and posts; calendar.

Precedent for this ruthlessness: the actions executor shipped with exactly two write actions (`writeActions.ts:10-13`).

## 5. Sends and the durable intent/approval layer

The plumbing already exists and fits: Tier-3 tool → immutable intent with canonical `argumentDigest` (`actionIntents.ts:78-91`) → approval bound to `boundArgumentDigest` → outbox → release worker CAS `approved→executing` → revalidation chain → headless dispatch (`intentReleaseWorker.ts:242-385`). The comms integration is a fourth headless family beside Google/M365-write:

- `M365_COMMS_HEADLESS_ACTIONS = { m365_send_mail: 'm365.comms.mail.send' }` in a new `m365CommsToolsHeadless.ts`, pinned to the tier-3 tool map by the same parity-test pattern as `m365ToolsHeadless.ts:24-29`.
- `executeM365CommsToolHeadless(actionName, args, orgId, userId, intentId)` — the release worker passes `intent.requestedByUserId` (new: the existing dispatch at `intentReleaseWorker.ts:357-366` only passes org; comms requires the user). Refusal taxonomy mirrors `m365ToolsHeadless.ts:35-44`: connection-level refusals throw `M365ConnectionUnavailableError` (→ `failed:connection_unavailable`, no side effect); Graph-level failures return tool errors.

**Exact-content binding (§11.1's hard requirement).** Solved by making the content *be* the arguments:
1. The intent's `arguments` contain the complete literal recipients, subject, and body. `argumentDigest` therefore *is* the content hash; `revalidateApprovedIntentForRelease` already refuses digest drift.
2. The executor receives the same literal content in the signed job body, and `bodySha256` in the internal JWT binds those exact bytes (`internalAuth.ts:103`, `graphActionsExecutorClient.ts:166-167`). There is no window in which approved content and sent content can diverge.
3. `targetSummary` = exact recipient list + subject; `impactSummary` = recipient count, subject, body length, first ~200 chars of body, and the digest. The approval UI additionally renders the full body by reading `intent.arguments` through the org-scoped, RBAC-gated intent endpoint — **not** by copying the body into approval/audit rows (§9 flag 3).
4. **Draft-send is banned in v1 precisely because it breaks this.** Graph drafts are mutable; approving "send draft X" binds an id, not content. If added later, the send action must carry the approved content hash and the executor must fetch the draft, canonicalize, compare, and fail closed on mismatch.

**Duplicate-send safety.** `sendMail` is not idempotent at Graph. Defenses, in order: the single-use `approved→executing` CAS (`intentReleaseWorker.ts:251-259`) makes duplicate release effectively impossible; the executor never internally retries a send after an ambiguous outcome (a timeout mid-send maps to `graph_request_timeout` and terminalizes the intent — re-sending requires a fresh intent and fresh approval); `idempotencyKey = intent.id` is carried for audit and a future executor-side dedup store, same posture as `writeActions.ts:35-38`. Accepted residual: a crash between Graph's 202 and the `executing→completed` CAS yields `failed:execution_lost` for an email that did send — the same residual the siblings accept (`intentReleaseWorker.ts:461-475`), and for email the human-visible Sent Items folder is the recovery oracle.

**Drafts (Tier 2)** execute inline in the chat session like Tier-1 reads — no intent row — matching §9.1's "execute according to organization policy" with v1 policy = allowed for the allowlisted owner, fully audited via a `breeze_m365_comms_total{action,outcome}` counter + audit events (metrics pattern of runbook lines 162-168).

## 6. Executor internal design

`POST /v1/execute-action` (all five catalog actions ride one operation, like the read executor), `/v1/complete-consent`, `/v1/retest`, `/healthz`. Per execute request:

1. Verify internal JWT (audience `m365-communications-executor`) + body digest.
2. Validate request schema: `{correlationId, connectionId, tenantId, expectedUserObjectId, credentialVersion, idempotencyKey?, action}`.
3. Derive secret name from `connectionId`; per-connection mutex; cached access token or redeem latest-version RT (§3.1).
4. **Claims gate before any Graph call** (§5 Microsoft boundary, §18.3): token `tid === tenantId`, `oid === expectedUserObjectId`, `appid === configured clientId`. Any mismatch → `tenant_mismatch`/`identity_token_invalid`, fail closed.
5. Execute the typed action against fixed `graph.microsoft.com` paths (`/me/messages`, `/me/sendMail`, `/me/messages/{id}/createReply`); project through the per-action field allowlist; enforce response-size/pagination/time bounds (read-executor `graphClient.ts` bounds pattern).
6. Return `{...result, usedCredentialVersion, rotatedCredentialVersion?}`.

Redaction is stricter than the siblings because payloads are correspondence: the executor's error normalization must strip message bodies, recipient lists, and subjects from every log/exception path; logs carry correlation id, action type, connection id, and counts only (§12, master lines 334-347).

## 7. Enablement, boot validation, allowlists

Mirrors `writeActionRuntimeConfig.ts:195-281` with the axis swapped to users:

| Var | Meaning |
|---|---|
| `M365_COMMS_ONBOARDING_ENABLED` / `M365_COMMS_ONBOARDING_USER_IDS` | Gates the connect/reconnect/disconnect card. UUID list or `*`; list required when enabled; boot-fails otherwise. v1 ships with exactly one UUID — but the design is N-user from day one; nothing may hardcode a single user. |
| `M365_COMMS_TOOLS_ENABLED` / `M365_COMMS_TOOLS_USER_IDS` | Gates tool registration + headless release dispatch. Cheap env-only check on the hot registration path (the `isM365GraphActionsEnabledForOrg` pattern, `writeActionRuntimeConfig.ts:253-261`). |
| `M365_COMMS_CLIENT_ID`, `M365_COMMS_VAULT_URL`, `M365_COMMS_EXECUTOR_URL/AUDIENCE/SIGNING_KID/SIGNING_PRIVATE_JWK_FILE` | Sibling-identical, new names/keys. Note: **no** `VAULT_REF`/`CREDENTIAL_VERSION` API-side vars — per-connection (§3.1). |
| Executor side | client id, callback URL (byte-match trap — runbook gotcha (c) applies verbatim), vault URL + secret-name prefix, public JWK/kid/issuer/audience, azure credential mode, private bind host/port, `MAX_REPLICAS=1` documentation. |

`validateM365CommunicationsRuntimeConfigAtBoot` force-loads everything when either flag is on, added to `apps/api/src/config/validate.ts` beside the actions checks. Dark deploy sequence mirrors runbook lines 149-157: executor dark by digest, healthz only, consent one user, allowlist that one UUID, exercise list→get→draft→approve→send→verify in Sent Items, then stop — there is no "expand gradually" story until a second communications user actually exists.

## 8. First cut vs deferred

**Ships:** the five §4 actions; consent/reconnect/retest for the owner user; vault write-back rotation; degraded-on-invalid_grant + reconnect UX; the release-worker user-axis dispatch; user-allowlist gating; cross-user RLS forge tests; deploy runbook.

**Deferred (recorded, not designed):** Teams entirely; reply/forward send variants; attachments; draft-send-with-verification; multi-replica executor; scheduled RT health probes (v1 discovers death lazily on next use + expiry alerting); automated vault purge on revoke; manifest trim re-consent tooling beyond the ordinary version-bump path; any org-level policy over comms tools (v1 policy = the user allowlist).

## 9. Master-spec flags (things §11.1's parent gets wrong or leaves ambiguous)

1. **§6.3 "clears token and session state" (line 139)** is not compatible with delegated refresh-token reality; per-call redemption *increases* rotation races. Amend to: "clears credential material; MAY cache non-reusable short-lived access tokens in memory within their validity."
2. **§10.1 vs `action_intents.org_id NOT NULL`:** user-owned work still needs an org anchor for approval routing/RLS/audit. This design picks "requesting session's org context"; the master spec should codify it.
3. **§10.2 "approval UI shows proposed message content" vs §12 "unrestricted message payloads prohibited from approval summaries."** These conflict as written. Resolution here: content lives once, in `intent.arguments` (org-RLS + RBAC-gated read); approval *summaries*, audit details, and exports carry recipients/subject/digest/lengths only. The spec should adopt this split explicitly.
4. **`profiles.ts:65-75` requests Teams scopes (`Chat.ReadWrite`, `ChannelMessage.Read.All`, `ChannelMessage.Send`) that v1 will not exercise.** The actions runbook's own principle (line 40: consenting unexercisable scopes "only widens the mutation blast radius") says trim them. Recommendation: bump `communications-delegated` to version 2 with mail-only scopes; delegated re-consent is one sign-in by one user — the cheapest re-consent in the whole system. Restore Teams scopes with the Teams catalog.
5. **§6.1's version-pinned `put`/`get`-only provider** implicitly assumes immutable credentials; the comms domain needs latest-read + executor `set` (§3.1). The credential-provider abstraction section should acknowledge per-domain access shapes.

## 10. Risks (most likely failures first)

1. **Rotation write-back loss → surprise reauth.** Mitigated by ordering (persist before use), `degraded` + reconnect UX, and rich correlation logging. Accepted as v1's sharpest edge.
2. **Duplicate or lost sends at the crash boundary.** §5; residual matches siblings; Sent Items is the oracle; never auto-retry a send.
3. **Correspondence leaking into logs/audit/approvals.** Redaction tests must be first-class (§12 verification bullet, master line 467); the approval-summary split in §9.3 is load-bearing.
4. **Cross-user access via the untested `breeze_current_user_id` policy branch.** Closed by the new forge tests (§3.3) — do not ship without them.
5. **The single-user assumption calcifying.** Everything is keyed by `connectionId`/`userId`; the allowlist is the only place "one user" appears.
6. **Executor scale-out breaking the redemption mutex.** Documented single-replica constraint; revisit before any second replica.
7. **CA/MFA policy changes killing the RT mid-flight** (password reset, sign-in risk, device policy). Same handling as revocation: `delegated_reauth_required`, degrade, alert (§14 alert list already covers "delegated sessions approaching expiration," master line 384).
8. **Sends are literally a named human** — a compromised approval chain here is impersonation of a person, not an app. This is why the owner-equals-requester release check (§3.3) and the exact-content digest binding are both mandatory, independently.

## 11. Task breakdown (TDD-shaped, commit per task)

Format mirrors `docs/superpowers/plans/integrations/2026-07-22-m365-customer-graph-actions-consent.md`.

1. **Shared catalog** — create `packages/shared/src/m365/commsActions.ts` (+`commsActions.test.ts`): failing tests for the 5-action union, recipient/size caps, projection allowlists, failure-code enum, request/result schemas incl. `connectionId`/`expectedUserObjectId`/`usedCredentialVersion`/`rotatedCredentialVersion`; implement; export from `@breeze/shared/m365`.
2. **Profile trim** — `profiles.ts`: bump `communications-delegated` to version 2, mail-only delegated scopes (test asserts exact scope set + version); confirm `connectionNeedsConsentReconciliation` flags stored-v1 rows.
3. **Migration: user consent sessions + delegated columns** — `apps/api/migrations/2026-07-28-a-m365-comms-consent-sessions.sql`: unique index `m365_connections (id, user_id, profile, consent_attempt_id)`; `m365_user_consent_sessions` (system-only forced RLS, composite user-axis FK, expiry index); `ALTER m365_connections ADD COLUMN IF NOT EXISTS delegated_user_object_id UUID`, `observed_delegated_scopes JSONB NOT NULL DEFAULT '[]'`. Idempotent; schema file + `pnpm db:check-drift`.
4. **RLS contract updates** — register `m365_user_consent_sessions` in the system-only allowlist of `rls-coverage.integration.test.ts`; add `m365CommsUserRls.integration.test.ts`: cross-user connection forge (42501), org-token-cannot-see-user-rows, consent-session tenant-read refusal. Real-DB job.
5. **Comms runtime config + boot validation** — `commsRuntimeConfig.ts` (+tests): user-ID allowlist parsing, no version-pin vars, JWK file perms checks (clone `writeActionRuntimeConfig.ts` tests); wire `validate.ts`.
6. **Executor scaffold** — `apps/m365-communications-executor/`: config loader (vault origin + prefix, no version pin; replica note), `internalAuth` with new audience, Hono app for 3 operations + healthz; port sibling test suites, then the deltas.
7. **Executor delegated token client** — `microsoft/delegatedTokenClient.ts` (+tests): auth-code exchange (PKCE), RT redemption against `login.microsoftonline.com/{tenantId}`, rotation detection, `invalid_grant → delegated_reauth_required` mapping, per-connection mutex, access-token cache with expiry-skew eviction. All HTTP mocked.
8. **Executor vault provider** — `credentials/delegatedTokenVaultProvider.ts` (+tests): name-from-connectionId derivation, envelope validation, latest-version `get`, rotation `set` returning the new version, `set`-failure → `credential_rotation_failed`.
9. **Executor operations** — `operations.ts` (+tests): claims gate (`tid`/`oid`/`appid`), consent op with RT persistence + `scp` reconciliation, retest, execute-action dispatch across the 5 actions, projection enforcement, redaction of bodies/recipients from every error path (explicit leak tests).
10. **API executor client** — `commsExecutorClient.ts` (+tests): clone of `graphActionsExecutorClient.ts` against the comms schemas/audience.
11. **API comms action service** — `commsActionService.ts` (+tests): user-axis ladder — user allowlist → connection by `userId` under ambient/caller RLS → owner check (`connection.userId === actorUserId`, fail closed) → status (`active` only for send; `active|degraded` for reads, mirroring the read/write split at `writeActionService.ts:20-25`) → budget → executor call → rotated-version CAS → `degraded` on `delegated_reauth_required`; metrics `breeze_m365_comms_total`.
12. **Consent route + connection service instance** — extend the `createConnectionService` factory usage (`connectionService.ts:273+`) or a comms-specific sibling for the user axis; consent initiate/callback routes using `m365_user_consent_sessions`; browser binding; UI card (connect/reconnect/disconnect, "Signed in as <UPN>") behind the onboarding flag; i18n ×5 locales; `runAction` for all mutations.
13. **AI tools (tier 1/2)** — `aiToolsM365` additions `m365_list_mail`, `m365_get_mail`, `m365_draft_mail` (+ tier map + gating tests): registered only for allowlisted owning users, site-scope refused.
14. **Tier-3 send + headless release** — `m365_send_mail` tool creating intents with content-inline args + summaries; `m365CommsToolsHeadless.ts` (+ tier-parity test); `intentReleaseWorker.ts` dispatch branch passing `intent.requestedByUserId` (+ `user_actor_required` refusal for key-actor intents); worker tests for owner-mismatch fail-closed and connection-unavailable taxonomy.
15. **Integration + E2E-ish proof** — integration suite: consent→active→list→draft→intent→approve→release→sent (executor HTTP mocked at the client seam), digest-drift refusal, reauth-required degrade/reconnect, rotation CAS.
16. **Deploy runbook + compose plumbing** — `docs/deploy/m365-communications-executor.md` (env tables, vault `get+set` scoping, single-replica constraint, callback byte-match gotcha, rollback = tools flag off); `.env.example` entries; supply-chain-hardening service-name rule extended; no compose service block.
