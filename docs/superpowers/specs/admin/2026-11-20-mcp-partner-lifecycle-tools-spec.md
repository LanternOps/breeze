---
issue: 12302
status: draft (open decisions pending approval)
area: admin
date: 2026-11-20
depends_on: "#12299 (fix in #12303)"
related: "#4119"
---

# Platform-admin partner-lifecycle tools in the Breeze MCP server — spec

Refs #12302. Depends on #12299 (fix in PR #12303). Related: #4119.

## 1. Problem

Platform operators read partner trust state, triage partner trust signals, and
suspend, unsuspend or restore partners. The admin UI and the `/admin/*` REST
routes already do this. Some of this work also happens outside the app.
Out-of-app work skips the side effects the app performs and writes audit rows
that don't match the app's own. The side effects are:

- token, session and OAuth revocation;
- remote-session teardown;
- billing cancel and checkout close;
- device command cancellation.

The issue asks for the same work through the Breeze MCP server, on the same
code path, with the same gates and audit trail as the UI.

What exists on `main` (verified 2026-11-20; line numbers omitted where #12303
moves them):

- **Admin routes.** `routes/admin/index.ts` mounts every `/admin/*` router
  behind `platformAdminMiddleware`. That middleware:
  - requires `auth.user.isPlatformAdmin === true`;
  - writes a `platform_admin.<route>` audit row for every request.

  Every route below also has `requireMfa()`, except `GET /admin/trust/queue`
  (no route-level MFA gate) and `POST /admin/trust/act` (fresh TOTP instead):

  | Route | Logic lives in | Audit row |
  |---|---|---|
  | `POST /admin/partners/:id/suspend-for-abuse` (+ `confirmEmail` typo gate) | `suspendPartnerForAbuse(c, partnerId, reason)` in `routes/admin/abuse.ts`. It takes a Hono `Context`. The evidence-card action `POST /admin/trust/act` (`trustAct.ts`) shares it after its own fresh-TOTP step-up. | `partner.suspended_for_abuse` |
  | `POST /admin/partners/:id/unsuspend` | **inline in the route handler** | `partner.unsuspended` |
  | `GET /admin/signals` | inline | none (only the middleware row) |
  | `POST /admin/signals/:id/acknowledge`, `POST /admin/signals/acknowledge-bulk` | inline | `abuse_signal.acknowledged` / `abuse_signal.bulk_acknowledged` |
  | `POST /admin/partners/:id/trust/fraud-flag-restore` | service `restoreBillingFraudRestriction` (`services/partnerTrustFraudFlags.ts`) | written by `setTrustState` |
  | `POST /admin/partners/:id/trust/{promote,restrict}`, `GET /admin/trust/queue` | `changeTrustState` in `trust.ts` over `setTrustState`; `buildEvidenceCard` | `partner.trust.*` |

- **What suspend does.** In one system-scope transaction it:
  - sets the partner `suspended`;
  - queues `self_uninstall` on **every device** under the partner. This cannot
    be undone; re-enrollment is the only recovery;
  - cancels other pending commands;
  - deletes sessions;
  - disables active non-platform-admin users;
  - advances auth epochs and revokes refresh families;
  - revokes org API keys.

  After commit it:
  - runs Redis token cutoff and per-user cleanup;
  - revokes partner OAuth artifacts;
  - tears down live remote sessions;
  - closes open checkouts and cancels the billing subscription, when billing is
    configured.

  Partial failure of token or OAuth revocation returns `500 partial_suspend`
  and an audit `result: 'failure'`; the operator is told to re-run. The calling
  admin is excluded from session, token and disable steps.
- **DB context (#12299).** A platform admin who is also a partner member gets a
  partner-scoped token (`resolveCurrentUserTokenContext`,
  `routes/auth/helpers.ts`). A nested `withSystemDbAccessContext` keeps that
  context. #12303 wraps the abuse routes in `runOutsideDbContext(() =>
  withSystemDbAccessContext(…))` (helper `withAdminSystemScope` in `abuse.ts`).
  MCP requests are partner- or org-scoped by construction, so this spec relies
  on that pattern rather than re-solving it.
- **MCP principal.** `buildAuthFromApiKey` (`services/mcpPrincipalAuth.ts`)
  builds the context for every MCP credential (API key, OAuth bearer grant,
  partner service principal). It:
  - hard-codes `user.isPlatformAdmin: false`;
  - sets a synthetic `apikey-<name>@breeze.local` email;
  - returns only `organization` or `partner` scope, never `system`.

  **No MCP caller can be a platform admin today, and there is no precedent for
  a platform-admin-only tool.**
- **MCP Tier 3 intents are tenant-shaped.**
  - `action_intents.org_id` is NOT NULL.
  - Approvers are users holding `approvals:decide` in the intent's org or its
    partner (`actionIntents/intentApprovers.ts`).
  - A partner-scope caller's execution org falls back to its first accessible
    org (`routes/mcpExecutionOrg.ts`).
  - Release re-runs the handler under the requester's rebuilt credential.

  Filed as-is, a platform action would land in a tenant org's approvals inbox.
- **MFA mirroring.** MCP callers carry `token: {}`. Tools listed in
  `MFA_GATED_TOOL_ACTIONS` (`services/aiToolMfaGate.ts`) are hidden from
  `tools/list`, cannot be filed as intents, and fail at release. Mirroring
  `requireMfa()` literally would make every tool in this spec unreachable,
  reads included.
- **Hosted gating.** `partnerTrustMode()` (`config/partnerTrustMode.ts`)
  returns `off` unless `IS_HOSTED=true`.

## 2. Users and scope

- **Actor:** a platform admin, meaning a `users` row with
  `is_platform_admin = true` and `status = 'active'`, connected through an MCP
  client with a credential bound to that user.
- **Never:** partner or org principals; partner service principals; API keys
  that act as a service (see Decision 2); unattended principals
  (`MCP_UNATTENDED_TIER3_PRINCIPALS`); in-app AI chat; Wisp; agent runs; the
  generated tool index.
- **Targets:** any partner on the deployment. The caller's own partner
  membership, if any, never narrows or widens the target set.
- **Deployments:** hosted only. On self-hosted (`partnerTrustMode() === 'off'`)
  the group does not exist: it is not listed, not callable and not mounted.
- **Level:** platform. These are not tenant settings, so the partner → org
  settings rules do not apply.

## 3. Proposed design

### 3.1 Shape

```
MCP client (platform admin's own OAuth grant)
   │  tools/list · tools/call
   ▼
Platform-admin MCP surface  ── gate: hosted + flag + live platform-admin principal
   │  reads: run directly
   │  writes: create a pending platform action → return confirmUrl
   ▼                                   ▼
services/partnerLifecycle/*        Admin web: /admin/platform-actions/:id
(shared with REST + evidence card)  shows preview + evidence, confirmEmail + fresh TOTP
                                       │  POST …/confirm (platformAdminMiddleware + session MFA)
                                       ▼
                                  same service call, actor.via = 'mcp'
```

Three rules hold throughout:

1. **One code path.** Every read and write calls a function in
   `apps/api/src/services/partnerLifecycle/`. REST routes, the evidence-card
   action and MCP are thin adapters. No MCP tool runs its own query.
2. **Writes never execute inside an MCP call.** An MCP write records a pending
   platform action. The same admin confirms it in the web app with
   `confirmEmail` plus a fresh TOTP. The service then runs in a real web
   session, which has MFA, IP and user agent, so step-up and audit match the UI
   by construction (Decision 3a).
3. **Never visible to a tenant principal**, on any surface, proven by test (§3.4).

### 3.2 Tools (first cut)

| Tool | Kind | Service function | Wave |
|---|---|---|---|
| `partner_lookup` | read | `findPartnersForAdmin({ query })`, by id, slug or name prefix. Needed because a model cannot act on a partner it cannot resolve; the UI has the trust queue. | W2 |
| `partner_trust_get` | read | `getPartnerTrustSummary(partnerId)` over `loadTrustState`, `loadFraudRestoreEpisodes` and an MCP projection of `buildEvidenceCard` (§3.12) | W2 |
| `partner_signals_list` | read | `listAbuseSignals(filter)`, the extracted `GET /admin/signals` | W2 |
| `partner_suspend_preview` | read (dry run) | `previewPartnerSuspension(partnerId, callerId)` (§3.7) | W2 |
| `platform_action_status` | read | `getPlatformAction(id, callerId)`: status and outcome of a pending write | W3 |
| `partner_signal_acknowledge` | write → confirm | `acknowledgeAbuseSignals(ids, actor)` (single and bulk) | W3 |
| `partner_unsuspend` | write → confirm | `unsuspendPartner(partnerId, reason, actor)` | W3 |
| `partner_fraud_flag_restore` | write → confirm | `restoreBillingFraudRestriction` (already a service; gains `actor`) | W3 |
| `partner_suspend` | write → confirm | `suspendPartner(partnerId, reason, actor, { previewDigest })` | W4 (see Decision 1) |
| `partner_trust_restrict` / `partner_trust_promote` | write → confirm | `changeTrustState`, extracted from `trust.ts` | W3 (see Decision 6) |

Write tools take `partnerId`, `reason` (same minimum length as the route) and
`confirmPartnerSlug`. The slug must match the target partner's slug. This is
the model-side typo gate; the human-side typo gate stays `confirmEmail` on the
confirm page. `partner_suspend` also requires the `previewDigest` returned by
`partner_suspend_preview`.

### 3.3 Principal

A **platform-admin MCP principal** is an MCP credential whose bound user
(`createdBy` / the consenting user of an OAuth grant) passes all of these:

- `users.is_platform_admin = true` and `users.status = 'active'`;
- the credential is not a partner service principal, not on
  `MCP_UNATTENDED_TIER3_PRINCIPALS`, and of an allowed credential type
  (Decision 2; recommended: dedicated platform OAuth grants only);
- the credential is a **platform grant**: issued for the platform MCP audience
  with dedicated scopes `platform:read` (reads, preview) and/or
  `platform:propose` (create pending writes). Only a platform admin can be
  granted these at consent. Tenant `ai:*` scopes never imply them. A tenant
  MCP grant held by a user who happens to be a platform admin does **not**
  qualify: promoting a tenant credential by looking up its owner would hand a
  human's platform authority to a credential minted for tenant work.

These are checked **live on every `tools/list`, `tools/call` and status
request**, and again at confirm and immediately before the service runs. The
checks cover:

- the grant, client and audience are live;
- the subject is bound to the grant;
- the auth epochs are current;
- the user is active and `is_platform_admin` is still true.

Nothing is cached on the key. A demoted or disabled admin loses the group on the next
request. The check produces a separate `PlatformAdminActor`
(`{ userId, email (real, from users), grantId, scopes }`). It never mutates the
tenant `AuthContext`, so `isPlatformAdmin` stays `false` there and no existing
`isPlatformAdmin` bypass in tenant tools starts to apply.

**Assurance.** A platform grant is issued only after a real factor
verification (TOTP or passkey) in the consenting browser session. It records
that time as `assuranceAt`. Reads require `assuranceAt` within a window, and
once the window passes, a browser step-up refreshes it (Decision 8). Writes
always need a fresh TOTP at confirm (§3.6).

**Issuance gap.** The OAuth issuer and bearer verifier assume partner tenancy
today (`oauth/provider.ts`, `middleware/bearerTokenAuth.ts`). A platform admin
with no partner or org membership, whose web token has `system` scope, cannot
obtain a grant at all. W2 adds a platform issuance and verification path for
the platform audience. It does not reuse the tenant one.

### 3.4 Surface and hiding

**Recommended (Decision 4, option A): a separate registry on a separate mount.**

- The tools live in `services/platformAdminMcp/registry.ts`, **not** in the
  `aiTools` map and **not** in `TOOL_TIERS`. They are therefore absent by
  construction from in-app chat, Wisp, agent runs, the tool index, tenant
  intents and every tenant contract test.
- They are served at `/api/v1/mcp/platform`, which:
  - reuses the MCP protocol and transport plumbing (`mcpProtocol`,
    `mcpModernEnvelope`);
  - has its own auth gate (§3.3) and its own rate limits;
  - returns 404 when the group is disabled (§3.10).

  The operator adds it as a second MCP server in their client.
- `mcpCoverage.ts` keeps `admin/abuse.ts`, `admin/trust.ts` and
  `admin/trustAct.ts` as `exempt: 'platform_admin'` for the tenant server and
  records the platform mount as their MCP coverage.

**Proof of hiding** (tests are W2 exit criteria):

1. **Tenant server.** Over the real transports, for each of these
   credentials:
   - an org key;
   - a partner key;
   - a partner service principal;
   - an unattended principal;
   - an OAuth grant of a non-admin partner user;
   - a tenant OAuth grant **owned by a platform admin**.

   On every page of the listing, including with valid and malformed
   arguments:
   - `tools/list` contains none of the names;
   - `tools/call` on each name returns the same `Unknown tool` error as a
     made-up name.
2. **Platform mount.** Each non-admin credential above, plus a platform-admin
   credential without the `platform:*` scopes, gets the same 404 or `unauthorized`
   body as a disabled mount. The response does not reveal whether the mount
   exists.
3. **Live demotion.** A platform admin lists the tools; `is_platform_admin` is
   then cleared; the next list is empty and the next call is refused. Repeat
   with `status = 'disabled'`.
4. **Chat and Wisp.** `getToolDefinitions()`, the chat-surface tool list, the
   Wisp subject maps (including wildcard grants), the full and lazy tool
   indexes, agent catalogs, MCP resources and tasks, and tenant approval queues
   and notifications contain none of the names (contract test). No platform
   service function is called on any refused path.
5. **Confirm.** A pending action created by admin A cannot be read or
   confirmed by admin B (`operator_mismatch`), by a non-admin web session, or
   without session MFA plus fresh TOTP.

### 3.5 Service extraction (W1, no behaviour change except §3.8)

New module `apps/api/src/services/partnerLifecycle/`:

- `actor.ts`:

  ```ts
  type PlatformActor = {
    userId: string; email: string;
    via: 'ui' | 'email_card' | 'mcp';
    ipAddress?: string; userAgent?: string;
    mcp?: { grantId: string; platformActionId: string; requestedAt: string };
  };
  ```

- `suspend.ts`:
  - `selectSuspensionTargets(tx, partnerId, callerId)` is the **only** place
    that selects the affected devices, commands, users, keys and orgs. It is
    used by both preview and suspend (§3.7).
  - `previewPartnerSuspension(partnerId, callerId)`.
  - `suspendPartner(partnerId, reason, actor, opts)` returns a discriminated
    result: `{ status: 'not_found' } | { status: 'suspended', counts, billing,
    teardown } | { status: 'partial', … }`.
  - All of today's steps move here unchanged: the transaction, post-commit
    cleanup, OAuth revocation, remote-session teardown, billing close/cancel,
    and the audit row. `captureException` is called without a Hono context.
- `unsuspend.ts`: `unsuspendPartner(partnerId, reason, actor)`, with the
  activation gate, billing-status veto, `reEnableSuspensionDisabledUsers` and
  `restorePartnerTenantAccess`.
- `abuseSignals.ts`: `listAbuseSignals`, `acknowledgeAbuseSignals` (single and
  bulk share one guarded `UPDATE … WHERE acknowledged_at IS NULL`).
- `trustState.ts`: `changeTrustState` from `trust.ts`, `getPartnerTrustSummary`
  and `findPartnersForAdmin`.
- Each service owns its system scope with the #12303 helper (moved from
  `abuse.ts` into the service module as `withAdminSystemScope`). Adapters never
  open a DB context.

The routes become adapters: validate input, apply route-only gates
(`confirmEmail`, `requireMfa`), build a `PlatformActor` with `via: 'ui'`, call
the service, and map the result to **today's exact status codes and bodies**,
including `partial_suspend` 500 and the production redaction. `trustAct.ts`
passes `via: 'email_card'`.

**Parity tests (W1).** The existing route tests in `routes/admin/` and the
#12303 integration suite `adminAbuseSystemScope.integration.test.ts` pass
unchanged. A new contract test asserts that the routes import the service
functions and contain no `db.` calls for these operations.

### 3.6 Writes: pending platform action → web confirm

1. **MCP call.**
   - The tool validates input and resolves the target, including slug match
     and, for suspend, recomputing and comparing the preview digest.
   - It writes a **pending platform action**: `{ id, operatorUserId, tool,
     args, previewDigest?, createdAt, expiresAt }`.
   - It returns:

     ```
     { status: 'pending_confirmation', actionId,
       confirmUrl: <DASHBOARD_URL>/admin/platform-actions#<id>, expiresAt }
     ```

   The MCP call itself changes no partner state.
2. **Confirm page.** It requires a platform-admin web session (MFA claim as
   today) and shows:
   - the tool and its arguments;
   - the target partner;
   - for suspend, a live **re-preview** next to the previewed counts, with
     differences highlighted;
   - the same evidence the admin UI shows.

   The admin enters `confirmEmail` (suspend only, as today) and a fresh TOTP
   (`requireFreshMfaStepUp`, keyed `admin:platform-action`).
3. **Confirm route** `POST /admin/platform-actions/:id/confirm`, mounted under
   `platformAdminMiddleware`. It:
   - verifies `operatorUserId === session user` and that the action is unused
     and unexpired;
   - **consumes the action before acting** (the anti-replay posture of
     `trustAct.ts`);
   - calls the service with `actor.via = 'mcp'` and the web request's IP and
     user agent;
   - stores the outcome on the action record for `platform_action_status`.
4. **Reject and expiry.** The page has Reject. Unconfirmed actions expire
   after 30 minutes. Rejected and expired actions are audited
   `platform_action.rejected` / `.expired`.

**Storage.** Recommended: a durable, system-only `platform_action_requests`
table (§4). The single-use confirmation token stays in Redis, as trust action
tokens do (`partnerTrustEvidenceCard.ts`). It has its own `typ`/purpose and is
bound to the request id, origin grant, target, verb, argument digest, preview
digest, operator and a short expiry. The durable row carries:

- the status lifecycle: `pending → confirmed → executing → completed |
  completed_with_failures | failed`, or `rejected | expired`;
- the outcome.

It lets a lost response be recovered and lets a crash mid-execution be seen.
It enforces **one live suspension request per partner** with a partial unique
index. Redis-only storage was considered and rejected (Decision 3b).

**Retries.** A client that loses the result calls `platform_action_status`. It
never re-files. The status tool reports every outcome explicitly. A suspend
whose token or OAuth revocation failed is `completed_with_failures` with the
failed step named, never `completed`. The tenant MCP server's generic error
classifier is not reused, because it can read an error body that carries
counts as a success.

### 3.7 Dry-run preview for suspend

`previewPartnerSuspension` runs `selectSuspensionTargets` in a **read-only
transaction** and returns counts only, no row data:

- organizations;
- devices that will get `self_uninstall`, flagged **irreversible**;
- devices that already have a pending uninstall;
- pending and sent commands that will be cancelled;
- active users that will be disabled;
- users whose sessions and tokens will be revoked;
- the calling admin's own membership (that admin is excluded);
- org API keys that will be revoked;
- OAuth grants and refresh tokens;
- live remote sessions;
- `partner.status` and `trust_state`;
- billing:
  - whether billing is configured;
  - the local subscription status mirror;
  - "open checkouts will be closed, subscription cancelled immediately; no
    refund".

The preview makes no billing-service calls.

`previewDigest` is an HMAC over:

- `partnerId` and `partner.status`;
- the counts;
- a hash of the **sorted target identities**: device ids for the uninstall
  set, org ids and user ids.

Equal counts can hide a changed target set, so the digest covers the
identities. Execution is **bound to the preview** in three ways:

- the MCP call refuses a stale digest (`preview_stale`; re-preview);
- the confirm page shows the live re-preview next to it;
- the mutation transaction re-selects the targets and applies the drift policy
  (Decision 9).

Transient credentials (sessions, tokens, OAuth artifacts, remote sessions) are
always swept live at execution, whatever the preview said. The audit row
records both the previewed and the actual counts.

### 3.8 Re-run safety (small behaviour change, W1)

Today a re-run suspend, which the `partial_suspend` path tells the operator to
do, queues a second `self_uninstall` per device. W1 makes the insert skip
devices that already have a `pending`/`sent` `self_uninstall`. Every other step
is already idempotent:

- users are disabled only from `active`;
- keys are revoked only if not already revoked;
- epochs and revocations are safe to repeat.

The service returns `partial` with `retrySafe: true`, and the MCP status
surfaces it as `completed_with_failures`, never `completed`. The existing
integration suite gains a re-run case.

Before `partner_suspend` ships over MCP (W4), suspension also gets:

- **serialization:** a per-partner advisory lock inside the transaction, plus
  the one-live-request index (§3.6);
- **a durable record of pending post-commit work,** written in the suspend
  transaction, so an unfinished effect can be retried on its own after a crash
  between commit and cleanup. Effects stay in today's order: checkout close
  before subscription cancel.
- **tests** for duplicate calls, concurrent change, crash recovery and failure
  of each downstream effect.

The UI path benefits from all three as well.

### 3.9 Audit

| Row | UI today | MCP path |
|---|---|---|
| Middleware `platform_admin.<route>` | every `/admin/*` request | every **confirm** request (it is an `/admin/*` route). The MCP mount writes `platform_admin.mcp.<tool>` for every list and call: `actorType 'user'`, real email, `details.grantId`, result. |
| Domain row (`partner.suspended_for_abuse`, `partner.unsuspended`, `abuse_signal.*`, `partner.trust.*`) | `actorType 'user'`, real email, `requestedBy`, IP, user agent | **Same action names and shape**, written by the same service. `details` add `via: 'mcp'`, `platformActionId`, `mcpGrantId`, `requestedAt`, and for suspend `previewCounts`. IP and user agent are those of the confirming web request. |
| `via` | absent | W1 adds `via: 'ui'` / `'email_card'` to UI rows too, so every row states its origin. `setTrustState(…, { via: 'email_card' })` already sets the precedent. |
| Pending action lifecycle | n/a | `platform_action.requested`, `.confirmed`, `.rejected`, `.expired` (`resourceType 'platform_action'`) |

Audit rows keep `orgId: null`, as today.

### 3.10 Enablement and self-hosted

The group exists only when **both** hold:

- `partnerTrustMode() !== 'off'`, which already implies `IS_HOSTED=true`;
- `PLATFORM_ADMIN_MCP_ENABLED=true`, a new flag, default `false`, validated as
  a boolean in `config/validate.ts`.

Whether writes also require `enforce` (as opposed to `shadow`) is Decision 10.
`partner_fraud_flag_restore` is only meaningful under `enforce` in any case,
because the fraud-flag sweep only runs there.

When either is off, the mount returns 404 and the confirm route returns 404 for
MCP-origin actions. The flag is set per region. Docs (`apps/docs` deploy
environment page) list it under the hosted-only variables that self-hosters can
skip.

### 3.11 Rate limits

Each limit is per platform-admin user, kept in Redis, and fails closed when
Redis is down. The tenant limiter (`checkToolRateLimit`) is **not** reused: it allows tools
that have no entry and applies tenant multipliers. The platform mount has its
own table, keyed on user and grant.

| Tool class | Limit |
|---|---|
| Reads (`partner_lookup`, `partner_trust_get`, `partner_signals_list`) | 60/min |
| `partner_suspend_preview` | 20/min |
| Pending-action creation, all write tools | 20/h, at most 5 live unconfirmed actions |
| `partner_suspend` creation | 5/h, and one live request per target partner |
| Confirm | the existing `requireFreshMfaStepUp` throttle, plus 30/h |

Limits are tunable by env and never exceed the per-credential MCP message limit.

### 3.12 Data exposure and untrusted content

- **Projection.** MCP results go to a third-party model. `partner_trust_get`
  returns an **MCP projection** of the evidence card:
  - trust state, status, plan, timestamps;
  - signal summaries (fields per Decision 5);
  - fraud-restore episode metadata;
  - device and denial counts.

  By default it omits payment-instrument details, raw IP addresses, personal
  names and email addresses. Raw signal evidence stays in the admin UI
  (Decision 5).
- **Untrusted text.** Partner-controlled strings (partner name, hostnames, user
  and domain names, evidence text) are data, not instructions. They go through
  the same untrusted-output filtering the tenant MCP server applies (rule 6a)
  before they reach the model.

### 3.13 Side effects never skipped

Every side effect in §1 lives inside the service, so no adapter can skip one.
The confirm route calls exactly the function the REST route calls. A contract
test spies on each effect:

- `revokeAllPartnerOauthArtifacts`, `runPostCommitCleanup`,
  `terminateUserRemoteSessions`;
- the billing client `closeOpenCheckouts` / `cancelSubscription`;
- `cancelDeviceCommands`;
- the trust-state publish and the serving-set refresh;
- the approval email inside `setTrustState`.

It asserts identical calls for `via: 'ui'` and `via: 'mcp'`.

## 4. Tenancy and data model impact

- **New table `platform_action_requests`** (recommended, Decision 3b). It holds
  the pending-write row from §3.6.
  - It is a **platform-axis table with no tenant column**: no `org_id` and no
    `partner_id`. The target partner is stored as `target_partner_id`, which is
    not a tenancy key. Other columns:
    - `operator_user_id`, `origin_grant_id`, `tool`;
    - `args` (jsonb), `args_digest`, `preview_digest`, `preview_counts`
      (jsonb);
    - `status`, `outcome` (jsonb);
    - `confirmed_by[]`, `created_at`, `expires_at`, `executed_at`.
  - RLS: enabled + forced, with a **system-only** policy (same shape as
    `partner_abuse_signals`), in the creating migration. Only the platform
    services touch it, under `runOutsideDbContext(() =>
    withSystemDbAccessContext(…))`.
  - It is not registered in `CORE_ORG_CASCADE_DELETE_ORDER`,
    `orgMergeRegistry` or `CORE_TENANT_EXPORT_POLICY`, because it is not
    tenant-owned and has no `org_id`. Partner deletion keeps the row as an
    audit artifact. `target_partner_id` has no FK, so a deleted partner leaves
    a dangling id, the same as audit rows. The tenancy-rls contract tests that
    enumerate tables need a "platform/system-only" classification entry; W3
    confirms which allowlist that is.
  - A partial unique index on `(target_partner_id) WHERE tool =
    'partner_suspend' AND status IN ('pending','confirmed','executing')`
    enforces one live suspension per partner.
  - The migration name follows `apps/api/migrations/README.md`. The migration
    is idempotent and writes no rows.
- **Suspension post-commit work record (W4).** Either a column set on the
  request row above or a small system-only table with the same RLS and cascade
  position. W4's plan decides which.
- **Unchanged.** Every existing table touched by suspend, unsuspend, signals and
  trust keeps its current policy. Services keep reaching those tables under
  explicit system scope (#12303 pattern).
- **Not used:** the tenant `action_intents` table. Giving it a nullable
  `org_id` or a platform axis would touch the approvals inbox, approver
  resolution, release re-validation, org-merge and export. All of those assume
  a tenant axis (Decision 3a, option B).
- **OAuth.** Adds the platform audience and the `platform:read` /
  `platform:propose` scopes, plus a grant-time check that the consenting user
  is a platform admin. W2 verifies whether the grant tables need a column for
  the audience or the assurance timestamp. If they do, the column goes on the
  existing OAuth tables under their current RLS shape.

## 5. Out of scope

- Platform-admin MCP for any other `/admin/*` area (AI kill switch, billing
  re-drive, tenant erasure or export, entitlements). The registry is built so
  they could be added later, each with its own spec.
- Refunds or billing re-creation on unsuspend. These stay manual, as today.
- Partner-facing notifications that don't exist today. This spec preserves
  every existing notification and adds none.
- A general four-eyes primitive across all platform actions. #4119 covers a
  narrower case (catalog revision activation). Decision 7 covers suspend only.
- Changing what the trust signals detect, or their thresholds.
- In-app AI chat or Wisp access to these tools.

## 6. Open decisions

Each decision records Claude's recommendation. Where the independent `codex
exec` review (gpt-6.2-astra, xhigh, read-only) disagreed, its position is
stated next to it.

1. **First-wave scope.**
   - A: reads + preview first.
   - B: reads + reversible writes first.
   - C: everything at once.

   **Recommend A,** then reversible writes (ack, unsuspend, fraud-flag restore,
   restrict/promote) in W3, and `partner_suspend` alone in W4, after its
   hardening (§3.8). Reads and preview prove the principal, hiding and
   projection with no blast radius. *Codex: agrees.*
2. **Which credentials can be a platform-admin principal.**
   - A: dedicated platform OAuth grants only.
   - B: also user-created API keys with a platform scope.
   - C: tenant grants whose owner is a platform admin.

   **Recommend A.** Option B is a long-lived static key with partner-suspend
   power. Option C promotes a tenant credential to platform authority. *Codex:
   agrees, and adds the separate platform issuance path (§3.3).*
3. **Approval and step-up for writes.**

   **3a. Mechanism.**
   - A: a pending platform request plus browser confirmation in the admin app:
     a fresh TOTP, and `confirmEmail` for suspend. The service runs in that web
     request.
   - B: a platform axis on `action_intents`.
   - C: TOTP passed as a tool argument.

   **Recommend A.** It reuses `requireFreshMfaStepUp`, the single-use
   consume-before-act pattern from `trustAct.ts` and `platformAdminMiddleware`.
   It gives exact UI step-up and audit parity and leaves tenant intents
   untouched. Option C would send a live second factor through the model
   provider and the client transcript. *Codex: agrees.*

   **3b. Pending-request store.**
   - A: Redis only, like trust action tokens.
   - B: a durable system-only table, with the single-use token in Redis.

   **Recommend B.** Claude's first draft chose A (no migration). Codex argued
   for B, for status recovery after a lost response or a crash and for
   one-live-suspension enforcement. Claude agrees on the merits.
4. **Surface.**
   - A: a separate registry on `/api/v1/mcp/platform`.
   - B: the same `/api/v1/mcp`, with the group merged into the listing for
     platform principals.

   **Recommend A.** Hidden by construction from chat, Wisp, intents and the
   tool index. *Codex: agrees.*
5. **What signal and trust reads expose to the model.**
   - A: trust state, status, plan, timestamps, counts, fraud-restore episode
     metadata, and per-signal key, severity, score and timestamps. Signal
     evidence only with opt-in, size-capped. Never payment-instrument details,
     raw IPs, personal names or emails.
   - B (codex): ids, severity, status and timestamps only. No internal signal
     keys or scores, no evidence, no free-text reasons. Partner-controlled
     labels omitted where possible, otherwise capped, sanitized and delimited.

   **Claude recommends A without the evidence opt-in.** Triage over MCP needs
   to know what a signal is about, and the decision is confirmed in the web
   UI, where full evidence is shown. **Codex recommends B**, keeping detection
   internals out of a third-party model's context. Maintainer to choose.
6. **Add `partner_trust_restrict` / `partner_trust_promote`.** These are not in
   the issue's list.
   - A: both.
   - B: restrict only.
   - C: neither.

   **Recommend A.** Without restrict, the only containment tool over MCP is the
   irreversible one. *Codex: not asked.*
7. **Four-eyes for suspend over MCP.**
   - A: required. Two distinct active platform admins confirm the same
     preview. With one admin, MCP suspend is refused before any side effect,
     with a "second admin required" message.
   - B: optional, behind `PLATFORM_ADMIN_FOUR_EYES_SUSPEND`, default off. The
     request row supports `confirmed_by[]` and refuses self-confirmation when
     the flag is on.
   - C: defer to a generalised #4119.

   **Claude recommends B.** The single-admin confirm (live re-preview +
   `confirmEmail` + fresh TOTP in the web UI) is a human review at least as
   strong as today's UI suspend. Option A would make MCP suspend unusable
   while the platform-admin pool is small, and the UI path would still allow
   one admin. **Codex recommends A**: suspend is irreversible, and the tenant
   sole-operator fallback is the wrong model. A real disagreement; maintainer
   to choose.
8. **Assurance for reads over MCP.** The REST signal reads require a session
   MFA claim. The trust queue GET does not.
   - A: the platform grant's consent requires an MFA-satisfied session. The
     grant stores `assuranceAt`, and reads are allowed while it is newer than
     a window (proposed 12 h). After that, a browser step-up refreshes it.
   - B (codex): short-lived, issuer-verified evidence that an actual factor
     was used, bound to the human and the grant. Reads stay hidden until that
     exists, because `requireMfa()` reflects effective policy and can admit
     password-only sessions.

   **Recommend A, made factor-based to meet codex's point.** `assuranceAt` is
   set only from a real factor verification (TOTP or passkey) at consent or
   step-up, never from the policy flag. That closes most of the gap between A
   and B. Every write, including acknowledge, needs a fresh browser TOTP;
   *codex agrees*, because acknowledging suppresses further alerts.
9. **Preview drift at execution.**
   - A (codex): any material drift in the target identities requires a new
     preview.
   - B: never block; record both previewed and actual counts.
   - C: block on removed or changed targets, and on a status change such as
     already suspended. Growth alone does not block: newly enrolled devices are
     included and the confirm page shows them.

   **Recommend C.** Blocking on growth would let a partner under suspension
   race the suspend by enrolling devices. **Codex recommends A.**
10. **Trust mode required for writes.**
    - A: reads and writes in `shadow` and `enforce`.
    - B (codex): reads and preview in `shadow`, writes only in `enforce`.

    **Recommend A.** Suspend, unsuspend and acknowledge don't depend on trust
    enforcement, and the UI allows them in `shadow`. Fraud-flag restore is
    inert outside `enforce` anyway. **Codex recommends B** as a tighter rollout
    gate.
11. **`confirmEmail` on the evidence-card suspend.** The `/admin/trust/act`
    suspend currently has TOTP but no `confirmEmail`.
    - A: add it when the card path moves onto the shared confirm component.
    - B: leave it.

    **Recommend A,** as deliberate hardening called out in the W1 PR. *Codex:
    suggested it.*

## 7. Waves

| Wave | Content | Exit criteria |
|---|---|---|
| **W1: service extraction** (after #12303 merges) | `services/partnerLifecycle/*`; routes and `trustAct` become adapters; `PlatformActor` + `via` on UI audit rows; uninstall queueing safe to re-run (§3.8). No MCP code. | All existing admin route tests and the #12303 integration suite pass unchanged; new parity and re-run tests; no `db.` calls left in the adapters for these operations. |
| **W2: principal + surface + reads** | Platform OAuth audience, scopes, issuance and verification; live principal check; `/api/v1/mcp/platform` mount behind hosted + flag; `partner_lookup`, `partner_trust_get` (projection), `partner_signals_list`, `partner_suspend_preview`; platform rate limits; `platform_admin.mcp.*` audit. | The five hiding proofs (§3.4) pass over real transports, including a tenant grant owned by a platform admin. Integration tests run as `breeze_app` with a partner-scoped platform admin acting on another partner. Disabled-flag and self-hosted 404 tests pass. Instruction-shaped partner strings are tested against the projection. |
| **W3: reversible writes behind confirm** | `platform_action_requests` migration; confirm page and route; `platform_action_status`; tools in order ack (single and bounded bulk) → unsuspend → fraud-flag restore → restrict/promote. | Side-effect parity contract (§3.13); audit parity (§3.9); tests for `operator_mismatch`, replay, expiry and rejection; Playwright confirm flow (`data-testid`). |
| **W4: `partner_suspend`** | Suspension serialization, durable post-commit work record, drift policy (Decision 9), then the tool. | Tests for duplicate calls, concurrent change, crash recovery and failure of each downstream effect; stale-preview and drift tests; one-live-request index test. |
| **W5 (only if Decision 7 = B): four-eyes flag** | Second confirmer behind `PLATFORM_ADMIN_FOUR_EYES_SUSPEND`. | Self-confirmation refused when on; behaviour unchanged when off. If Decision 7 = A, this lands inside W4. |

## 8. Test and rollout notes

- **Rigor: high** (auth, platform scope, irreversible effects). Every wave gets
  an independent review. Integration suites run under **Integration Tests** in
  CI, not `pnpm test`. A stacked PR runs no CI, so use
  `gh workflow run CI --ref <branch>`.
- **DB context.** Every service test that touches another partner runs inside a
  partner-scoped request context. This is the #12299 failure mode, and a
  system-context-only test cannot catch it.
- **Contract tests to extend:**
  - `mcpCoverage` for the platform mount;
  - a new `platformAdminMcp.hidden.contract.test.ts` for the §3.4 proofs;
  - a new side-effect parity contract.

  W2 confirms that the tenant registry contracts (`TOOL_TIERS`, Wisp
  classification, the tool-index budget) do **not** apply, because the tools
  are outside `aiTools`. The chat and Wisp hidden-proof test guards that.
- **Rollout.**
  1. Ship W2 with `PLATFORM_ADMIN_MCP_ENABLED=false`.
  2. Enable it in one region on the operator's own account and exercise the
     reads.
  3. Enable W3 writes one tool at a time, then W4 suspend last.
  4. Exercise suspend first against a test partner, under a test-only
     configuration with no real billing subscription.
- **Docs.** Add an admin runbook for connecting the platform MCP server and
  for what each write confirms. Add the env var to the deploy environment page
  (hosted-only section).
- **No production data or hosts** appear in tests or docs. Fixtures use
  generated partners.
