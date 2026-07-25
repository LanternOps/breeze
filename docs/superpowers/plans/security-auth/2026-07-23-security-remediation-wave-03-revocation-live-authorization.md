# Revocation and Live Authorization Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close `AUTH-OAUTH-001`, `P1-WS-003`, and `PUBLIC-REVOKE-001` by binding OAuth access to live user state, versioning event-socket permission authority, and consuming quote response capabilities transactionally.

**Architecture:** OAuth tokens carry `auth_epoch`, while bearer authentication proves live `users.status` and epoch from PostgreSQL before relying on Redis cleanup. Every grant/JTI marker call goes through one durable helper that records failed Redis work before its caller returns fail closed. Event tickets carry a new `permissions_epoch` advanced by database triggers for every membership, access, site, role assignment, or role-permission mutation; open sockets periodically compare the ticket epoch with live state. Quote viewing and quote response become separate capabilities: the quote row stores a versioned response JTI, and accept/decline lock, compare, consume, and transition in one transaction without revoking the read link. A route-specific external mutation barrier keeps public GET/assets available while accept/decline are paused for a fleet-atomic legacy-to-database cutover.

**Tech Stack:** Hono/TypeScript, oidc-provider, JOSE, PostgreSQL, Drizzle ORM, forced RLS, Redis, BullMQ, WebSocket, Vitest, PostgreSQL integration tests.

## Global Constraints

- Approved design: `docs/superpowers/specs/security-auth/2026-07-23-full-security-review-remediation-design.md`.
- Implementation branch: `fix/security-review-live-revocation`, created from a freshly fetched `origin/main` after Wave 1 is merged.
- The indexed live `users.id` lookup is correctness-critical. No cache may replace it during this wave.
- An inactive user, epoch mismatch, unverifiable database state, expired compatibility window, or bounded event revalidation failure denies access.
- Redis grant/JTI markers remain defense in depth. Redis cleanup failure must never preserve OAuth access for an inactive or auth-epoch-stale user.
- Permission epoch bumps are database-triggered so direct SQL, alternate routes, seeds, and background jobs cannot bypass them.
- Role-permission changes fan out to every user assigned that role in the same transaction.
- Quote read capability remains usable after accept/decline. Only the response capability is one-time; explicit read-link revocation uses a separate column.
- A quote response transaction that rolls back leaves both quote state and response capability unconsumed.
- Quote response mode is fleet-wide, never a per-instance canary. Before any instance serves database-mode accept/decline, an external routing barrier covering every old and new backend returns `503` plus `Retry-After` for the two exact mutation routes while allowing public GET/assets. Lift it only after the complete backend inventory proves every responder is the target Wave 3 release in `database` mode and every pre-wave/legacy responder is drained.
- Expansion migrations are additive, idempotent, forward-only, and safe with preceding API instances. Do not edit shipped migrations.
- Reserved migrations `2026-08-06-b-live-authorization.sql` and `2026-08-06-c-quote-response-capability.sql` must be unoccupied and sort after the current highest migration before implementation. If either condition fails, stop and revise the coordinated wave plans centrally; a worker must not invent or rename a migration.
- New `oauth_revocation_retries` data is user-scoped: ENABLE RLS, FORCE RLS, use `breeze_current_user_id()`, add coverage allowlisting, and prove a cross-user forge fails as `breeze_app`.
- Metrics and logs use bounded reason codes, epoch numbers, version numbers, and truncated stable IDs. Never log JWTs, response tokens, quote URLs, JTI values, customer content, or Redis keys containing capabilities.
- Rollback retains auth/permission epochs, retry work, quote capability state, and read-link revocation state. It may not return to a binary that authorizes OAuth solely from Redis, accepts indefinitely claimless tokens, or performs quote response consumption after commit. Once database-mode quote mutations have been exposed, quote rollback first restores the external mutation barrier and may target only a database-capable Wave 3 binary; it never restores a legacy responder.
- Obtain one independent security/code review after the wave passes, covering transaction boundaries, trigger fanout, compatibility deadlines, Redis/DB failure semantics, and exactly-once response behavior.

---

## Canonical Interfaces

OAuth live authorization:

```typescript
export interface OAuthAccessClaims {
  partner_id: string | null;
  org_id: string | null;
  grant_id: string | null;
  auth_epoch: number;
}

export type LiveOAuthUserResult =
  | { ok: true; userId: string; authEpoch: number; legacyClaim: boolean }
  | {
      ok: false;
      status: 401 | 503;
      reason:
        | 'user_missing'
        | 'user_inactive'
        | 'auth_epoch_mismatch'
        | 'legacy_claim_expired'
        | 'live_state_unavailable';
    };

export async function assertLiveOAuthUser(
  payload: JWTPayload,
  now: Date
): Promise<LiveOAuthUserResult>;
```

Event permission authority:

```typescript
export interface EventTicketV2 {
  version: 2;
  userId: string;
  orgId: string | null;
  partnerId: string;
  allowedOrgIds: string[];
  allowedSiteIds: string[] | null;
  permissionsEpoch: number;
  expiresAt: number;
}

export type EventAuthorizationCheck =
  | { ok: true; identity: EventTicketV2 }
  | {
      ok: false;
      reason:
        | 'user_inactive'
        | 'permission_epoch_mismatch'
        | 'membership_removed'
        | 'legacy_ticket_rejected'
        | 'live_state_unavailable';
    };

export async function resolveLiveEventAuthorization(
  ticket: EventTicketV2
): Promise<EventAuthorizationCheck>;
```

Quote response authority:

```typescript
export type QuoteResponseOutcome = 'accepted' | 'declined';
export type QuoteResponseMode = 'legacy' | 'paused' | 'database';

export interface QuoteResponseCapability {
  tokenVersion: 0 | 1;
  jti: string;
}

export type ConsumeQuoteResponseResult =
  | { ok: true; claimedLegacyJti: boolean }
  | {
      ok: false;
      reason:
        | 'read_link_revoked'
        | 'jti_mismatch'
        | 'already_consumed'
        | 'invalid_state';
    };

export function consumeQuoteResponseCapability(
  quote: typeof quotes.$inferSelect,
  capability: QuoteResponseCapability,
  outcome: QuoteResponseOutcome,
  now: Date
): ConsumeQuoteResponseResult;
```

The quote helper validates state and returns values to write; its caller performs the guarded row update inside the same transaction/lock. It does not perform Redis I/O.

## Configuration and Compatibility Contract

Add and validate:

```dotenv
OAUTH_AUTH_EPOCH_ENFORCE_AFTER=2026-08-06T00:30:00Z
EVENT_PERMISSION_EPOCH_MODE=compat
QUOTE_RESPONSE_CAPABILITY_MODE=legacy
```

- `OAUTH_AUTH_EPOCH_ENFORCE_AFTER` is required when OAuth is enabled and must be at least `ACCESS_TOKEN_TTL_SECONDS` after the first new token-minting instance starts. Before the timestamp, claimless tokens still require the live user-status check. At and after it, claimless tokens are rejected automatically.
- `EVENT_PERMISSION_EPOCH_MODE=compat` allows version-one tickets only by resolving a fresh complete authority before upgrade; it never trusts the ticket's old site list. After every old ticket writer is drained and 60 seconds (the current ticket TTL) have elapsed, set `enforce` and reject tickets without `permissionsEpoch`.
- `QUOTE_RESPONSE_CAPABILITY_MODE=legacy` preserves current Redis response behavior while the expansion binary is deployed. `paused` leaves public quote GET, image, line-image, and contract-file routes available but makes exact accept/decline routes return `503` with `Retry-After: 60`. `paused` is defense in depth for Wave 3 binaries, not the fleet barrier: pre-wave instances do not understand it, so the external routing barrier must be active before any rolling mode change. `database` is exposed only as a fleet-atomic cutover after every pre-wave/legacy responder is drained; never canary database-mode mutations against a mixed fleet.
- Production and self-hosted compose mappings must pass all three variables into the API container. Operators choose an absolute OAuth deadline once per rollout; it is not extended by restarts.

Deployment sequence:

1. Apply migrations `2026-08-06-b-live-authorization.sql` and `2026-08-06-c-quote-response-capability.sql`.
2. Set the OAuth deadline, event `compat`, and quote `legacy`; deploy tolerant readers and new OAuth/event writers.
3. Drain old OAuth providers, wait through the OAuth deadline, and prove claimless traffic is zero/rejected.
4. Drain old event ticket writers, wait 60 seconds, then set event mode `enforce`.
5. Enable the external route-specific quote mutation barrier and prove exact public accept/decline requests return `503` plus `Retry-After: 60`, while GET and all three asset routes still reach the API. Keep the barrier active through every remaining quote step.
6. Set Wave 3 instances to quote `paused`, drain every pre-wave/legacy responder, and use the complete direct-backend inventory—not load-balanced sampling—to prove no missing/legacy mode remains.
7. Bring the entire replacement backend pool up in `database` mode behind the still-closed barrier. Do not send database-mode accept/decline traffic and do not run a database canary while any backend is legacy, paused, pre-wave, unknown, or not ready.
8. Prove every configured backend reports the same target release and `database` mode, atomically switch routing to only that pool, then lift the mutation barrier. Verify accept/decline no longer receive the barrier response and GET/assets stayed available throughout.
9. Canary OAuth clients and event sockets separately; public quote read-only traffic may be canaried while the barrier is closed, but mutation authority changes only through the fleet-atomic cutover above.

After the OAuth/event enforcement points or the database quote cutover, rollback is only to a Wave 3 binary that understands these modes and forward fields. If quote rollback is needed after database mode has been exposed, restore the external mutation barrier before changing the fleet and deploy only a compatible database-capable Wave 3 build. Do not roll back to the pre-wave bearer middleware, event ticket reader, or any legacy public quote responder.

---

### Task 1: Expand durable authorization and capability schema

**Files:**
- Modify: `apps/api/src/db/schema/users.ts`
- Modify: `apps/api/src/db/schema/oauth.ts`
- Modify: `apps/api/src/db/schema/quotes.ts`
- Create: `apps/api/migrations/2026-08-06-b-live-authorization.sql`
- Create: `apps/api/migrations/2026-08-06-c-quote-response-capability.sql`
- Modify: `apps/api/src/db/autoMigrate.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

**Interfaces:**
- Produces: `users.permissionsEpoch`, `oauth_revocation_retries`, and versioned quote response/read-revocation columns.

- [ ] **Step 1: Verify the coordinated migration reservation**

Run:

```bash
test ! -e apps/api/migrations/2026-08-06-b-live-authorization.sql
test ! -e apps/api/migrations/2026-08-06-c-quote-response-capability.sql
wave3_latest_migration="$(find apps/api/migrations -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort | tail -1)"
wave3_first_reserved_migration="apps/api/migrations/2026-08-06-b-live-authorization.sql"
test "$(printf '%s\n%s\n' "$wave3_latest_migration" "$wave3_first_reserved_migration" | LC_ALL=C sort | tail -1)" = "$wave3_first_reserved_migration"
```

Expected: all commands exit 0, and `b` sorts before `c`. If any check fails, stop and revise the reserved sequence in the central remediation plans; do not choose a new filename locally.

- [ ] **Step 2: Write failing schema, ordering, and RLS assertions**

Assert:

- `users.permissionsEpoch` maps `permissions_epoch bigint NOT NULL DEFAULT 0`;
- `oauthRevocationRetries` has `id`, `userId`, `markerType`, `markerId`, `expiresAt`, `attempts`, `nextAttemptAt`, `lastErrorCode`, `completedAt`, `createdAt`, and `updatedAt`;
- `quotes` has `publicTokenVersion`, `publicResponseJti`, `publicResponseConsumedAt`, `publicResponseOutcome`, and `publicLinkRevokedAt`;
- both migrations sort after existing migrations and in `b` then `c` order;
- `oauth_revocation_retries` appears in `USER_ID_SCOPED_TABLES`, denies a different request user,
  and permits the retry worker's explicit system context.

- [ ] **Step 3: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/db/autoMigrate.test.ts
```

Expected: FAIL because the schema and migrations do not exist. The real-database RLS coverage
contract runs after the migration is applied in Task 10; do not invoke the integration file under
the unit-test config.

- [ ] **Step 4: Add Drizzle schema**

Use:

```typescript
permissionsEpoch: bigint('permissions_epoch', { mode: 'number' }).notNull().default(0)
```

Make retry `markerId` `varchar(255)` and unique with `markerType` while incomplete. Keep errors as bounded codes in `varchar(64)`. Add indexes on `(completed_at, next_attempt_at)` and `user_id`.

On quotes, use integer token version safely defaulted to `0`, JTI `varchar(128)`, timezone-aware timestamps, outcome `varchar(16)`, and a separate timezone-aware read-link revocation timestamp.

- [ ] **Step 5: Write migration `b`**

Add `permissions_epoch` idempotently. Create `oauth_revocation_retries` with indexes, foreign key
to users, ENABLE RLS, FORCE RLS, and an exact policy for `breeze_app` whose `USING` and
`WITH CHECK` are both:

```sql
user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'
```

The user branch prevents cross-user request access; the explicit system branch is required by the
retry worker and transactional revocation call sites. Do not grant an organization- or
partner-wide branch. Add the table to `USER_ID_SCOPED_TABLES` in the same change and add
real-database tests proving own-user CRUD, different-user denial, and system-context CRUD.

Create idempotent trigger functions and `DROP TRIGGER IF EXISTS`/`CREATE TRIGGER` pairs:

- `organization_users`: bump old and new `user_id` on insert/update/delete, including `role_id` and `site_ids`;
- `partner_users`: bump old and new `user_id` on insert/update/delete, including `role_id`, `org_access`, and `org_ids`;
- `role_permissions`: bump every user currently assigned the old or new role on insert/update/delete;
- `roles`: bump assigned users when authorization-bearing role attributes change.

Use `UPDATE users SET permissions_epoch = permissions_epoch + 1`. Do not calculate epochs in application memory.

- [ ] **Step 6: Write migration `c`**

Add quote columns idempotently. Add named checks after `DROP CONSTRAINT IF EXISTS`:

- version is `0` or `1`;
- version `1` requires non-null response JTI;
- consumed timestamp and outcome are either both null or both non-null;
- outcome is null, `accepted`, or `declined`.

Do not backfill a JTI. Existing rows remain version `0` and atomically claim the presented signed JTI during their first response.

- [ ] **Step 7: Run schema and migration checks**

```bash
pnpm --filter=@breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm --filter=@breeze/api check:migrations
```

Expected: PASS; no inner transaction and both migrations are idempotent.

- [ ] **Step 8: Commit expansion**

```bash
git add apps/api/src/db/schema/users.ts apps/api/src/db/schema/oauth.ts apps/api/src/db/schema/quotes.ts apps/api/migrations/2026-08-06-b-live-authorization.sql apps/api/migrations/2026-08-06-c-quote-response-capability.sql apps/api/src/db/autoMigrate.test.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "fix(auth): expand live revocation state"
```

---

### Task 2: Mint OAuth access tokens with the live auth epoch

**Files:**
- Modify: `apps/api/src/oauth/provider.ts`
- Modify: `apps/api/src/oauth/provider.test.ts`
- Read: `apps/api/src/oauth/adapter.ts`

**Interfaces:**
- Consumes: grant account ID and indexed `users.authEpoch`.
- Produces: `OAuthAccessClaims` with a required numeric `auth_epoch`.

- [ ] **Step 1: Add failing provider tests**

Cover active user epoch inclusion, inactive/missing user mint denial, grant/account mismatch, and preserved partner/org/grant claims. Assert no token is minted if the user row cannot be proved.

- [ ] **Step 2: Run the red provider tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/oauth/provider.test.ts
```

Expected: FAIL because `buildExtraTokenClaims` does not emit `auth_epoch`.

- [ ] **Step 3: Extend `buildExtraTokenClaims`**

Resolve the grant's authoritative account/user ID, query `users.id`, `users.status`, and `users.authEpoch`, require active status, and return `auth_epoch` with the existing claims. Let database errors become OAuth `server_error`; do not mint a claimless token on failure.

- [ ] **Step 4: Run the green provider tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/oauth/provider.test.ts
```

Expected: PASS and `ACCESS_TOKEN_TTL_SECONDS` remains exactly `1800`.

- [ ] **Step 5: Commit token binding**

```bash
git add apps/api/src/oauth/provider.ts apps/api/src/oauth/provider.test.ts
git commit -m "fix(oauth): bind access tokens to auth epoch"
```

---

### Task 3: Enforce live OAuth user state independently of Redis

**Files:**
- Modify: `apps/api/src/middleware/bearerTokenAuth.ts`
- Modify: `apps/api/src/middleware/bearerTokenAuth.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`

**Interfaces:**
- Consumes: signed JWT `sub`, optional legacy `auth_epoch`, live user row, and `OAUTH_AUTH_EPOCH_ENFORCE_AFTER`.
- Produces: `assertLiveOAuthUser`.

- [ ] **Step 1: Add failing middleware tests**

Cover:

- matching epoch succeeds;
- inactive/missing/mismatched user returns `401`;
- claimless token before deadline succeeds only after the same active live lookup;
- claimless token at/after deadline returns `401 legacy_claim_expired`;
- database failure returns retryable `503`;
- Redis cleanup outage cannot turn an inactive or mismatched user into success;
- valid live state still honors JTI/grant revocation.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/middleware/bearerTokenAuth.test.ts
```

Expected: FAIL because bearer auth does not compare live `auth_epoch`.

- [ ] **Step 3: Validate and map the absolute deadline**

Parse `OAUTH_AUTH_EPOCH_ENFORCE_AFTER` as a valid absolute ISO timestamp. Require it when OAuth is enabled in production/staging. Map it explicitly into API services in both compose files and document a generic example value in `.env.example`.

- [ ] **Step 4: Implement the live lookup**

Immediately after signature/issuer/audience validation and required subject extraction, query `users` by primary key in a system DB context. Translate database unavailability to `503`; translate missing/inactive/mismatch/expired legacy compatibility to `401`. Only then perform Redis JTI/grant checks and tenant-status checks.

Emit counters by bounded reason and `legacyClaim=true|false`; never include subject, token, JTI, or grant ID in labels.

- [ ] **Step 5: Run the green middleware tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/middleware/bearerTokenAuth.test.ts
```

Expected: PASS, including DB-down `503` and Redis-down inactive-user denial.

- [ ] **Step 6: Commit live bearer enforcement**

```bash
git add apps/api/src/middleware/bearerTokenAuth.ts apps/api/src/middleware/bearerTokenAuth.test.ts apps/api/src/config/env.ts .env.example docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "fix(oauth): enforce live user authorization"
```

---

### Task 4: Make Redis revocation cleanup durable

**Files:**
- Create: `apps/api/src/oauth/revocationRetry.ts`
- Create: `apps/api/src/oauth/revocationRetry.test.ts`
- Create: `apps/api/src/oauth/revocationCallsites.test.ts`
- Create: `apps/api/src/jobs/oauthRevocationRetryWorker.ts`
- Create: `apps/api/src/jobs/oauthRevocationRetryWorker.test.ts`
- Modify: `apps/api/src/oauth/adapter.ts`
- Modify: `apps/api/src/oauth/adapter.test.ts`
- Modify: `apps/api/src/oauth/provider.ts`
- Modify: `apps/api/src/oauth/provider.test.ts`
- Modify: `apps/api/src/routes/oauth.ts`
- Modify: `apps/api/src/routes/oauth.revocation.test.ts`
- Modify: `apps/api/src/oauth/grantRevocation.ts`
- Modify: `apps/api/src/oauth/grantRevocation.test.ts`
- Modify: `apps/api/src/oauth/revocationService.ts`
- Modify: `apps/api/src/oauth/revocationService.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces:

```typescript
export type OAuthRevocationMarkerType = 'grant' | 'jti';

export type OAuthRevocationMarkerInput = {
  userId: string;
  markerType: OAuthRevocationMarkerType;
  markerId: string;
  expiresAt: Date;
};

export type OAuthRevocationMarkerResult =
  | { status: 'written' }
  | {
      status: 'retry_queued';
      errorCode: 'redis_unavailable' | 'redis_write_failed';
    };

export async function writeOAuthRevocationMarkerDurably(
  tx: DbTransaction,
  input: OAuthRevocationMarkerInput
): Promise<OAuthRevocationMarkerResult>;

export async function drainOAuthRevocationRetries(limit: number): Promise<number>;
```

- [ ] **Step 1: Inventory every current raw marker caller and freeze the inventory**

Before changing imports, record every production `revokeGrant`/`revokeJti` call:

- `oauth/adapter.ts`: revoked-refresh-token reuse in `find`, JTI plus grant writes in `cacheRevocation`, and `revokeByGrantId`;
- `oauth/provider.ts`: `handleRevocationSuccess`;
- `routes/oauth.ts`: JWT revocation pre-handler JTI plus sibling grant;
- `oauth/grantRevocation.ts`: tenant-lifecycle refresh JTI and grant loops;
- `oauth/revocationService.ts`: client-family grant and refresh-JTI loops.

Create `revocationCallsites.test.ts` to scan all non-test TypeScript under `apps/api/src`. It must fail if `revokeGrant` or `revokeJti` is imported or called anywhere except their definitions in `revocationCache.ts` and the single raw-marker dispatch inside `revocationRetry.ts`. The retry worker also calls the durable helper, never the raw Redis primitives.

- [ ] **Step 2: Add failing helper, caller, and worker tests**

Prove:

- a Redis marker failure inserts or updates one durable retry row owned by the exact user in the caller's DB transaction;
- the retry row is committed and visible through an independent DB read before the caller returns `503`, throws its existing fail-closed error, or returns the invalid-token result;
- repeated failures are idempotent, an existing incomplete marker cannot be reassigned to another user, and a DB enqueue failure still fails closed;
- a successful Redis write creates no retry row;
- expired work completes without a Redis write; successful retry marks completion; failure schedules bounded exponential backoff; and logs contain no marker ID;
- `adapter.test.ts` covers revoked-refresh-token replay, AccessToken/RefreshToken `destroy`, and `revokeByGrantId`;
- refresh replay under forced Redis failure records the grant retry before `find` returns `undefined`, and cannot mint a replacement token;
- `provider.test.ts` covers `handleRevocationSuccess`;
- `routes/oauth.revocation.test.ts` covers failure of the first JTI write and the later sibling-grant write;
- `grantRevocation.test.ts` covers tenant lifecycle JTI/grant loops;
- `revocationService.test.ts` covers client-family JTI/grant loops;
- when a caller has multiple failed markers, every failed marker is durably represented before the fail-closed result.

- [ ] **Step 3: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/oauth/revocationRetry.test.ts \
  src/oauth/revocationCallsites.test.ts \
  src/jobs/oauthRevocationRetryWorker.test.ts \
  src/oauth/adapter.test.ts \
  src/oauth/provider.test.ts \
  src/routes/oauth.revocation.test.ts \
  src/oauth/grantRevocation.test.ts \
  src/oauth/revocationService.test.ts
```

Expected: FAIL because raw call sites remain and no single durable helper covers them.

- [ ] **Step 4: Implement the one transactional marker helper**

`writeOAuthRevocationMarkerDurably` is the only production function allowed to dispatch to raw `revokeGrant`/`revokeJti`. It attempts the correct marker using the exact remaining lifetime. On failure, it upserts the retry intent with its authoritative owner, bounded error code, and due time through the supplied transaction, then returns `retry_queued`; it does not throw after writing the retry because that would roll the retry row back. Use `ON CONFLICT` to advance attempts and `nextAttemptAt`, require any conflicting incomplete row to have the same `userId`, and never store a token, URL, or Redis key.

Every caller opens or joins one DB transaction, resolves ownership before the marker attempt, calls the helper, and commits any associated database revocation plus retry intent. Use `withDbAccessContext` for authenticated request paths and `withSystemDbAccessContext` only for existing provider/background paths that have first derived the authoritative user owner; do not broaden a request route to system context merely to insert the retry. Only after commit may the caller translate `retry_queued` to its existing fail-closed result. Derive ownership from the signed access-token subject, `oauth_grants.account_id`, or `oauth_refresh_tokens.user_id`; tenant-lifecycle callers carry each affected row's user ID rather than substituting the initiating administrator. Missing or contradictory ownership fails closed without attempting an unowned marker.

- [ ] **Step 5: Route every inventoried caller through the helper**

Remove direct raw-cache imports and duplicated `try/catch` handling from all five inventoried production files. Preserve each public behavior:

- provider and route revocation return their existing retryable server error only after durable commit;
- adapter destroy/revoke methods throw only after durable commit;
- refresh replay remains an invalid-token/`undefined` result after queuing the retry, rather than masking the replay signal with an unrelated success;
- tenant and client-family revocation commit authoritative DB revocation state plus every failed retry intent atomically, then return fail closed;
- successful marker writes retain current status/response behavior.

- [ ] **Step 6: Implement the worker through the same helper**

Claim due rows with `FOR UPDATE SKIP LOCKED`, process a bounded batch, and call `writeOAuthRevocationMarkerDurably` rather than importing the raw cache primitives. Mark successful work complete, cap backoff, stop retrying after expiry, and make duplicate workers safe. Register initialization and graceful shutdown with the API job lifecycle.

- [ ] **Step 7: Run the green tests and the static call-site gate**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/oauth/revocationRetry.test.ts \
  src/oauth/revocationCallsites.test.ts \
  src/jobs/oauthRevocationRetryWorker.test.ts \
  src/oauth/adapter.test.ts \
  src/oauth/provider.test.ts \
  src/routes/oauth.revocation.test.ts \
  src/oauth/grantRevocation.test.ts \
  src/oauth/revocationService.test.ts
```

Expected: PASS; every forced Redis failure has durable evidence before the caller's fail-closed result, refresh replay remains denied, and the static scan reports no direct production caller outside `revocationRetry.ts`.

- [ ] **Step 8: Commit durable cleanup**

```bash
git add \
  apps/api/src/oauth/revocationRetry.ts \
  apps/api/src/oauth/revocationRetry.test.ts \
  apps/api/src/oauth/revocationCallsites.test.ts \
  apps/api/src/jobs/oauthRevocationRetryWorker.ts \
  apps/api/src/jobs/oauthRevocationRetryWorker.test.ts \
  apps/api/src/oauth/adapter.ts \
  apps/api/src/oauth/adapter.test.ts \
  apps/api/src/oauth/provider.ts \
  apps/api/src/oauth/provider.test.ts \
  apps/api/src/routes/oauth.ts \
  apps/api/src/routes/oauth.revocation.test.ts \
  apps/api/src/oauth/grantRevocation.ts \
  apps/api/src/oauth/grantRevocation.test.ts \
  apps/api/src/oauth/revocationService.ts \
  apps/api/src/oauth/revocationService.test.ts \
  apps/api/src/index.ts
git commit -m "fix(oauth): retry revocation markers durably"
```

---

### Task 5: Prove permission epoch trigger coverage

**Files:**
- Create: `apps/api/src/__tests__/integration/permission-epoch.integration.test.ts`

**Interfaces:**
- Consumes: triggers from `2026-08-06-b-live-authorization.sql`.
- Produces: transactional epoch evidence for every authorization mutation.

- [ ] **Step 1: Write real-database trigger tests**

Create users sharing and not sharing roles. Assert exactly the affected users' epochs advance for:

- organization membership insert/update/delete;
- organization `role_id` change;
- organization `site_ids` change, including `NULL` to empty array;
- partner membership insert/update/delete;
- partner `role_id`, `org_access`, and `org_ids` changes;
- role-permission insert/delete/update;
- relevant role-definition update.

Also assert rollback restores the original epoch and role changes fan out to all assigned users without touching users assigned elsewhere.

- [ ] **Step 2: Run the tests against the migration**

```bash
pnpm --filter=@breeze/api test:docker:up
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/permission-epoch.integration.test.ts
pnpm --filter=@breeze/api test:docker:down
```

Expected: PASS; rollback and fanout assertions prove the bump is transactional.

- [ ] **Step 3: Commit trigger evidence**

```bash
git add apps/api/src/__tests__/integration/permission-epoch.integration.test.ts
git commit -m "test(auth): verify permission epoch fanout"
```

---

### Task 6: Version event tickets and close stale sockets

**Files:**
- Modify: `apps/api/src/routes/eventWs.ts`
- Modify: `apps/api/src/routes/eventWs.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`

**Interfaces:**
- Consumes: `EventTicketV2`, `users.status`, `users.permissionsEpoch`, and authoritative current membership/site access.
- Produces: `resolveLiveEventAuthorization` and bounded jittered revalidation.

- [ ] **Step 1: Add failing ticket and socket tests**

Cover:

- ticket mint snapshots current permission epoch;
- `allowedSiteIds: []` remains restricted-to-none rather than becoming unrestricted;
- `compat` version-one ticket is accepted only after fresh complete authorization resolution;
- `enforce` rejects a ticket without epoch;
- inactive, epoch mismatch, membership removal, role change, and site change close the socket;
- DB error gets one short retry and closes by the second failed interval;
- Redis pub/sub absence does not extend the DB close bound.

Use fake timers and deterministic jitter injection.

- [ ] **Step 2: Run the red event tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/eventWs.test.ts
```

Expected: FAIL because tickets do not snapshot/revalidate `permissionsEpoch`.

- [ ] **Step 3: Add validated configuration**

Validate `EVENT_PERMISSION_EPOCH_MODE` as `compat` or `enforce`, default to `compat` outside production, and require an explicit value in production/staging. Map it to the API service in both compose files.

- [ ] **Step 4: Mint version-two tickets**

Load active user and current epoch with the existing permission snapshot. Preserve `allowedSiteIds` as `null` for unrestricted and `[]` for restricted-to-none. Store version `2` and the epoch in both memory and Redis ticket representations.

- [ ] **Step 5: Revalidate open sockets**

Run at `30_000 + jitter(0..5_000)` milliseconds. Query live user status/epoch and current membership. Any mismatch closes with a bounded policy code. Permit at most one failed database check and no more than 65 seconds from the first inability to prove authorization. Optional pub/sub may call the same close routine earlier.

- [ ] **Step 6: Run the green event tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/eventWs.test.ts
```

Expected: PASS, including empty-site and bounded DB-failure cases.

- [ ] **Step 7: Commit event authorization**

```bash
git add apps/api/src/routes/eventWs.ts apps/api/src/routes/eventWs.test.ts apps/api/src/config/env.ts .env.example docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "fix(events): revalidate permission epoch live"
```

---

### Task 7: Define quote response capability state and mode

**Files:**
- Create: `apps/api/src/services/quoteResponseCapability.ts`
- Create: `apps/api/src/services/quoteResponseCapability.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/src/index.quote-response-mode.test.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`

**Interfaces:**
- Produces: `QuoteResponseCapability`, `QuoteResponseMode`, `ConsumeQuoteResponseResult`, and mode parsing.

- [ ] **Step 1: Add failing pure capability tests**

Cover:

- version 1 exact JTI succeeds once;
- version 1 wrong JTI fails;
- consumed capability fails regardless of outcome;
- version 0/null stored JTI may claim the presented signed JTI exactly once;
- terminal quote state fails;
- explicit `publicLinkRevokedAt` fails read and response;
- an unconsumed rollback-shaped row remains consumable;
- mode parsing accepts only `legacy`, `paused`, or `database`.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/quoteResponseCapability.test.ts src/index.quote-response-mode.test.ts
```

Expected: FAIL because the helper and health mode probe do not exist.

- [ ] **Step 3: Implement the pure state transition**

Return guarded update values:

```typescript
{
  publicResponseJti: capability.jti,
  publicResponseConsumedAt: now,
  publicResponseOutcome: outcome
}
```

For version `1`, require exact stored JTI. For version `0`, require stored JTI null and allow atomic claim. Never mutate `publicLinkRevokedAt`, and never call Redis.

- [ ] **Step 4: Add validated mode configuration and an instance-local mode probe**

Validate `QUOTE_RESPONSE_CAPABILITY_MODE` as `legacy`, `paused`, or `database`, default to `legacy` outside production, require an explicit value in production/staging, and map it in both compose files. `paused` is a fail-closed mutation mode: exact public accept/decline routes return `503` with `Retry-After: 60`; it does not block quote GET/assets.

Add `quoteResponseCapabilityMode` to the existing `/health` JSON beside `version`. This bounded non-secret value lets the operator probe each backend directly. A pre-wave instance has no such field and therefore fails the cutover inventory rather than being guessed compatible. Add an isolated health contract test for exact version/mode serialization.

- [ ] **Step 5: Run the green tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/quoteResponseCapability.test.ts src/index.quote-response-mode.test.ts
```

Expected: PASS for version 0/1, rollback-shaped rows, all three validated modes, and the health mode probe.

- [ ] **Step 6: Commit the capability contract**

```bash
git add apps/api/src/services/quoteResponseCapability.ts apps/api/src/services/quoteResponseCapability.test.ts apps/api/src/config/env.ts apps/api/src/index.ts apps/api/src/index.quote-response-mode.test.ts .env.example docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "fix(quotes): define transactional response capability"
```

---

### Task 8: Write version-one quote capability in the draft-to-sent transaction

**Files:**
- Modify: `apps/api/src/services/quoteLifecycle.ts`
- Modify: `apps/api/src/services/quoteLifecycle.test.ts`
- Modify: `apps/api/src/jobs/quoteSendQueue.test.ts`
- Modify: `apps/api/src/routes/quotes/lifecycle.ts`
- Modify: `apps/api/src/routes/quotes/lifecycle.test.ts`

**Interfaces:**
- Consumes: `createQuoteAcceptToken(...): { token, jti }` and `QUOTE_RESPONSE_CAPABILITY_MODE`.
- Produces: atomic `status='sent'`, `publicTokenVersion=1`, and `publicResponseJti=jti` in database mode.

- [ ] **Step 1: Add failing send tests**

Prove:

- database mode mints before the guarded draft-to-sent update and writes version/JTI in that update;
- failed/rolled-back send leaves draft status and no stored JTI;
- a concurrent lost claim does not email or expose the unused token;
- legacy mode preserves the current old-fleet-compatible behavior;
- paused mode preserves legacy/version-zero issuance while public response mutations are barred, so a send during the short barrier window remains consumable after the fleet-atomic database cutover;
- re-send/clone/reset clears prior consumption only as explicitly allowed by the existing lifecycle;
- `POST /quotes/:id/revoke-public-link` sets only `publicLinkRevokedAt` after existing quote write authorization, while a new successful send explicitly clears it.

- [ ] **Step 2: Run the red send tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/quoteLifecycle.test.ts src/jobs/quoteSendQueue.test.ts
```

Expected: FAIL because token mint currently follows the status transition.

- [ ] **Step 3: Reorder the database-mode send**

Within the existing transaction, mint the signed token first, then make the guarded draft-to-sent update include token version `1`, JTI, null consumption/outcome, and null read revocation. Only the transaction winner may email or return the public URL.

Keep `legacy` mode unchanged for phase-one deployment. `paused` uses the same version-zero issuance shape; its safety comes from blocking response mutations at both the external barrier and Wave 3 route guard. Do not use dual-write after database mode begins; Redis response revocation would break viewing through old readers, which is why old readers must be drained first.

- [ ] **Step 4: Add the explicit read-link revocation action**

Export `revokeQuotePublicReadLink(quoteId, actor)` from `quoteLifecycle.ts` and expose `POST /quotes/:id/revoke-public-link` through the existing quote lifecycle router and authorization middleware. The service performs a tenant-scoped guarded update of `publicLinkRevokedAt` and `updatedAt`; it does not alter response JTI, response consumption, or quote terminal status. Use `runAction` in any web caller added later; this API wave does not add a UI control.

- [ ] **Step 5: Run the green send tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/quoteLifecycle.test.ts src/jobs/quoteSendQueue.test.ts src/routes/quotes/lifecycle.test.ts
```

Expected: PASS, including rollback, concurrent-loser, authorized revocation, cross-tenant denial, and re-send assertions.

- [ ] **Step 6: Commit atomic issuance and read revocation**

```bash
git add apps/api/src/services/quoteLifecycle.ts apps/api/src/services/quoteLifecycle.test.ts apps/api/src/jobs/quoteSendQueue.test.ts apps/api/src/routes/quotes/lifecycle.ts apps/api/src/routes/quotes/lifecycle.test.ts
git commit -m "fix(quotes): issue response capability atomically"
```

---

### Task 9: Consume accept and decline capability in the terminal-state transaction

**Files:**
- Modify: `apps/api/src/routes/quotesPublic.ts`
- Modify: `apps/api/src/routes/quotesPublic.test.ts`
- Create: `apps/api/src/routes/quotesPublic.cutover.test.ts`
- Modify: `apps/api/src/services/quoteAcceptService.ts`
- Modify: `apps/api/src/services/quoteAcceptService.test.ts`
- Modify: `apps/api/src/services/quoteResponseCapability.ts`

**Interfaces:**
- Consumes: signature-verified quote claims/JTI and locked quote row.
- Produces: separate read resolution and transactional response resolution.

- [ ] **Step 1: Add failing route/service tests**

Cover:

- GET, image, line-image, and contract-file continue after accepted/declined response;
- explicit read-link revocation blocks all public reads;
- two concurrent accept requests yield one success;
- concurrent accept/decline yield exactly one terminal outcome;
- wrong version-one JTI fails;
- version-zero row atomically claims/consumes the signed JTI;
- a forced failure after capability comparison rolls back both state and consumption;
- Redis failure in database mode cannot make a consumed response replayable;
- local `paused` mode returns exact `503` plus `Retry-After: 60` for accept and decline before token resolution, Redis, database, invoice, email, or audit side effects;
- local `paused` mode leaves GET, image, line-image, and contract-file behavior unchanged;
- a simulated external barrier in front of two differently configured instances—one `legacy`, one `database`—returns the same `503`/`Retry-After` for both instances' accept/decline paths while continuing to distribute GET/assets. This test represents the mandatory fleet barrier that protects pre-wave instances which cannot implement `paused`.

- [ ] **Step 2: Run the red tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/quotesPublic.test.ts src/routes/quotesPublic.cutover.test.ts src/services/quoteAcceptService.test.ts
```

Expected: FAIL because Redis revocation occurs after commit and decline does not lock/consume transactionally.

- [ ] **Step 3: Split read and response resolution**

`resolveReadCapability` verifies signature, quote/org/partner binding, expiry, and `publicLinkRevokedAt`; it does not reject a consumed response. `resolveResponseCapability` additionally passes the JTI/version into the transactional service.

- [ ] **Step 4: Add the local paused-mode mutation guard**

Check mode before resolving the token or entering any database/system context. In `paused`, exact `POST /:token/accept` and `POST /:token/decline` return:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 60
Content-Type: application/json

{"error":"quote_response_temporarily_unavailable"}
```

Do not apply the guard to GET or asset routes. The external barrier uses the same method/path/status/header contract but remains independently required until the complete fleet is database-only.

- [ ] **Step 5: Lock and consume on accept**

In `acceptQuote`, select the quote `FOR UPDATE`, validate terminal state/expiry and capability, then update response JTI/consumed timestamp/outcome in the same transaction as acceptance, contract, invoice, and quote status. A thrown error rolls everything back.

- [ ] **Step 6: Lock and consume on decline**

Extract `declineQuoteByCapability`. Use `FOR UPDATE`, the same response helper, and one guarded update for decline state plus response consumption. Remove post-commit `revokeQuoteAcceptJti` from database mode.

- [ ] **Step 7: Preserve legacy mode only during the drain phase**

When mode is `legacy`, keep current Redis checks/revocation. When mode is `paused`, preserve read behavior but execute neither legacy nor database response mutation. When mode is `database`, ignore Redis response revocation for quote reads and responses; the row is authoritative. Reject an unknown mode at startup. No deployment may expose `database` accept/decline while another reachable instance is legacy, paused, pre-wave, or unknown.

- [ ] **Step 8: Run the green tests**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/quotesPublic.test.ts src/routes/quotesPublic.cutover.test.ts src/services/quoteAcceptService.test.ts
```

Expected: PASS; post-response assets work, all response races have one winner, paused mode has zero mutation side effects, and the mixed legacy/database fixture remains mutation-safe only while the external barrier is closed.

- [ ] **Step 9: Commit transactional response**

```bash
git add apps/api/src/routes/quotesPublic.ts apps/api/src/routes/quotesPublic.test.ts apps/api/src/routes/quotesPublic.cutover.test.ts apps/api/src/services/quoteAcceptService.ts apps/api/src/services/quoteAcceptService.test.ts apps/api/src/services/quoteResponseCapability.ts
git commit -m "fix(quotes): consume public responses transactionally"
```

---

### Task 10: Prove RLS, failure, concurrency, and mixed-version gates

**Files:**
- Create: `apps/api/src/__tests__/integration/live-revocation.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/quote-response-capability.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/oauth-revocation-service.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/quotesPublic.integration.test.ts`
- Create: `scripts/security/check-quote-response-cutover.sh`
- Create: `scripts/security/check-quote-response-cutover.test.sh`
- Modify: `package.json`
- Create: `docs/operations/quote-response-capability-cutover.md`
- Modify after deployment from the canonical primary checkout: `internal/security-remediation/2026-07-23-execution-ledger.md` (gitignored; never stage or commit)

**Interfaces:**
- Produces: release evidence for all three Wave 3 findings.

- [ ] **Step 1: Add real-database OAuth and event scenarios**

Prove:

- inactive and stale-auth-epoch OAuth tokens fail while Redis is unavailable;
- a matching token works while Redis is healthy;
- database unavailability returns `503`, never success;
- claimless behavior changes at the exact configured deadline;
- membership, role, and site mutations advance epoch and close a socket within 65 seconds;
- a real cross-user insert into `oauth_revocation_retries` as `breeze_app` fails with RLS;
- own-user request-context CRUD is limited to that user's retry rows, while
  `withSystemDbAccessContext` can insert/select/update/delete retry rows for the worker;
- for adapter refresh replay/destroy/grant revocation, provider success handling, the OAuth route, tenant lifecycle, and client-family revocation, forced Redis failure leaves the exact retry row committed before the caller's fail-closed result is observed.

- [ ] **Step 2: Add real quote concurrency scenarios**

Use independent DB connections to race accept/accept and accept/decline. Assert one terminal state, one consumption timestamp/outcome, one acceptance/invoice side-effect set, and no partial loser writes. Force a transaction error after capability validation and prove the capability remains usable. Verify GET/assets after response and explicit read-link revocation.

Also run one legacy-mode and one database-mode API fixture behind the simulated external mutation barrier. Prove both accept/decline destinations return exact `503` plus `Retry-After: 60`, GET/assets remain routed to both, and lifting the barrier while the fixture inventory is mixed fails the cutover check. Change both fixtures to database mode, prove the closed-barrier fleet check passes, then open it and prove a version-zero first response plus version-one response still have exactly one winner.

- [ ] **Step 3: Run focused integration and RLS tests**

```bash
pnpm --filter=@breeze/api test:docker:up
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/live-revocation.integration.test.ts \
  src/__tests__/integration/oauth-revocation-service.integration.test.ts \
  src/__tests__/integration/quote-response-capability.integration.test.ts \
  src/__tests__/integration/quotesPublic.integration.test.ts
pnpm --filter=@breeze/api test:rls-coverage
```

Expected: PASS; cross-user retry forge is rejected, every forced Redis failure has a committed retry intent before fail-closed return, concurrency has exactly one quote outcome, and a mixed quote fleet cannot pass the closed-barrier cutover gate.

- [ ] **Step 4: Run all focused unit suites**

```bash
pnpm --filter=@breeze/api exec vitest run \
  src/oauth/provider.test.ts \
  src/middleware/bearerTokenAuth.test.ts \
  src/oauth/revocationRetry.test.ts \
  src/oauth/revocationCallsites.test.ts \
  src/jobs/oauthRevocationRetryWorker.test.ts \
  src/oauth/adapter.test.ts \
  src/routes/oauth.revocation.test.ts \
  src/oauth/grantRevocation.test.ts \
  src/oauth/revocationService.test.ts \
  src/routes/eventWs.test.ts \
  src/services/quoteResponseCapability.test.ts \
  src/services/quoteLifecycle.test.ts \
  src/services/quoteAcceptService.test.ts \
  src/routes/quotesPublic.test.ts \
  src/routes/quotesPublic.cutover.test.ts \
  src/index.quote-response-mode.test.ts
bash scripts/security/check-quote-response-cutover.test.sh
pnpm --filter=@breeze/api db:check-drift
pnpm --filter=@breeze/api check:migrations
pnpm --filter=@breeze/api build
pnpm --filter=@breeze/api test:docker:down
```

Expected: PASS, clean drift, and build exit 0.

- [ ] **Step 5: Implement the exact cutover verifier and operator runbook**

Add root command `pnpm check:quote-response-cutover` for `scripts/security/check-quote-response-cutover.sh`. The script accepts:

```text
QUOTE_CUTOVER_PHASE=barrier-closed|fleet-closed|complete
QUOTE_CUTOVER_PUBLIC_ORIGIN=https://public.example.com
QUOTE_CUTOVER_BACKENDS_JSON=/secure/runtime/backend-inventory.json
QUOTE_CUTOVER_EXPECTED_BACKEND_COUNT=<positive integer>
QUOTE_CUTOVER_EXPECTED_VERSION=<exact API version>
QUOTE_CUTOVER_EXPECTED_MODE=paused|database
```

The operator-generated JSON is an array of unique `{ "instanceId": "...", "directOrigin": "..." }` records for every backend registered or draining in the deployment controller. It is confidential runtime evidence, not a repository file. `barrier-closed` needs only the public origin and checks:

- fixed invalid token `quote-cutover-probe-token` on exact accept and decline routes returns `503` with `Retry-After: 60`;
- GET plus image, line-image, and contract-file probes with that invalid token and valid sentinel
  UUID path parameters pass through the barrier and return exact API status `401` with JSON
  `{"error":"This link is invalid or has expired"}`. A `404`, `5xx`, HTML response, wrong content
  type, malformed JSON, or any other body fails the check.

`fleet-closed` additionally requires the inventory inputs, checks the exact unique count, directly
queries every instance's `/health` for exact target version/mode, and requires HTTP 200 from that
instance's `/health/ready`. A missing mode field, unreachable or unready instance, duplicate, count
mismatch, pre-wave version, legacy mode, mixed paused/database mode, or public barrier not closed
exits nonzero. `complete` repeats those exact backend health/readiness checks with expected mode
`database`, but requires schema-valid accept and decline requests using the fixed invalid token to
return the same exact API `401` JSON as the GET/assets probes. It rejects `404`, `502`, unrelated
`5xx`, HTML, wrong content type, and every other response; merely receiving “not 503” is never
success. The probes send non-sensitive bodies and never use or print a real capability.

The shell test uses local fake backends to cover missing mode, pre-wave response, legacy/database
mix, duplicate/count mismatch, closed barrier, exact `401` API pass-through, wrong
`404`/HTML/`502` responses, readiness failure, all-database readiness, and final barrier removal.
The runbook includes the exact route regex:

```text
method = POST
path = ^/api/v1/quotes/public/[^/]+/(accept|decline)$
response = 503, Retry-After: 60
```

It requires the final edge/load-balancer layer to apply the barrier before backend selection so pre-wave instances are covered. It also requires operators to record the deployment-controller command that produced the complete inventory and reconcile its count before trusting the script.

- [ ] **Step 6: Exercise compatibility transitions and the fleet-atomic quote cutover**

In staging:

1. start one preceding and one Wave 3 instance with quote `legacy` and event `compat`;
2. prove preceding OAuth access tokens pass only through live active-user checks;
3. drain preceding OAuth provider, wait past the fixed OAuth deadline, and prove claimless rejection;
4. drain preceding event writer, wait 60 seconds, set event `enforce`, and prove legacy ticket rejection;
5. enable the external quote mutation barrier before changing any quote mode; run:

   ```bash
   QUOTE_CUTOVER_PHASE=barrier-closed \
   QUOTE_CUTOVER_PUBLIC_ORIGIN=https://public.example.com \
   pnpm check:quote-response-cutover
   ```

   Expected: both exact mutation probes are `503` with `Retry-After: 60`; GET/assets pass through
   and return exact API `401` JSON.
6. while the barrier remains closed, set Wave 3 quote instances to `paused`, drain all pre-wave/legacy instances, and generate the complete direct-backend inventory from the deployment controller. Run:

   ```bash
   QUOTE_CUTOVER_PHASE=fleet-closed \
   QUOTE_CUTOVER_PUBLIC_ORIGIN=https://public.example.com \
   QUOTE_CUTOVER_BACKENDS_JSON=/secure/runtime/backend-inventory.json \
   QUOTE_CUTOVER_EXPECTED_BACKEND_COUNT=<exact-count> \
   QUOTE_CUTOVER_EXPECTED_VERSION=<wave-3-version> \
   QUOTE_CUTOVER_EXPECTED_MODE=paused \
   pnpm check:quote-response-cutover
   ```

   Expected: every directly probed instance is the target release in `paused` and returns 200 from
   `/health/ready`; missing, unready, pre-wave, legacy, or mixed instances fail.
7. replace the whole backend pool with Wave 3 instances configured `database` while the external
   barrier remains closed. Do not route accept/decline around the barrier and do not run a database
   mutation canary. Regenerate the inventory and rerun `fleet-closed` with
   `QUOTE_CUTOVER_EXPECTED_MODE=database`; expected: every backend is database mode, every direct
   `/health/ready` returns 200, and the public barrier is still closed.
8. atomically route only to the verified database pool, lift the exact mutation barrier, and run:

   ```bash
   QUOTE_CUTOVER_PHASE=complete \
   QUOTE_CUTOVER_PUBLIC_ORIGIN=https://public.example.com \
   QUOTE_CUTOVER_BACKENDS_JSON=/secure/runtime/backend-inventory.json \
   QUOTE_CUTOVER_EXPECTED_BACKEND_COUNT=<exact-count> \
   QUOTE_CUTOVER_EXPECTED_VERSION=<wave-3-version> \
   QUOTE_CUTOVER_EXPECTED_MODE=database \
   pnpm check:quote-response-cutover
   ```

   Expected: every direct backend remains ready and database-only; fixed invalid-token
   accept/decline and GET/assets probes return exact API `401` JSON rather than merely “not 503”;
   any edge/backend outage fails the verifier.
9. prove a real version-zero first response plus version-one send/response, each exactly once. If any verification fails, immediately restore the external barrier; do not switch any backend to legacy.
10. restart Wave 3 instances and prove the OAuth deadline does not move.

Expected: no stale OAuth/event authorization, no quote read outage, no mixed-mode database response traffic, and a recorded interval during which only accept/decline were temporarily unavailable.

- [ ] **Step 7: Record release evidence from the canonical primary checkout**

After deployment, update `internal/security-remediation/2026-07-23-execution-ledger.md` from the canonical primary checkout, not this implementation worktree. The coordinator ledger is gitignored and must never be staged or committed. Record fixed timestamps for old-provider drain, OAuth deadline, event drain/enforcement, external quote barrier on/off, complete backend inventories and counts, pre-wave/legacy drain, paused/database verification, retry backlog before/after, event close latency, quote concurrency evidence, and the Wave 3-only rollback version.

- [ ] **Step 8: Request independent review and commit verification**

The reviewer must inspect OAuth check ordering, DB error translation, every raw revocation caller/static gate, durable-before-fail-closed behavior, refresh replay, trigger coverage/fanout, socket close bound, quote row locks, legacy v0 claim, post-response read behavior, external barrier coverage, fleet inventory completeness, no-mixed-mode cutover, migration/RLS, and all three cutover gates.

```bash
git add \
  apps/api/src/__tests__/integration/live-revocation.integration.test.ts \
  apps/api/src/__tests__/integration/quote-response-capability.integration.test.ts \
  apps/api/src/__tests__/integration/oauth-revocation-service.integration.test.ts \
  apps/api/src/__tests__/integration/quotesPublic.integration.test.ts \
  scripts/security/check-quote-response-cutover.sh \
  scripts/security/check-quote-response-cutover.test.sh \
  package.json \
  docs/operations/quote-response-capability-cutover.md
git commit -m "test(auth): verify live revocation enforcement"
```

## Enforcement Stop Conditions

Stop the relevant canary or cutover immediately if:

- an inactive, mismatched, or claimless-after-deadline OAuth token succeeds;
- DB failure produces an authenticated bearer request;
- any production caller outside `revocationRetry.ts` imports or invokes raw `revokeGrant`/`revokeJti`;
- any forced Redis marker failure returns, throws, or reports invalid-token before the exact user-owned retry intent is committed and independently visible;
- revoked refresh-token replay can mint a replacement token, or its forced Redis failure lacks a committed grant retry before the replay is denied;
- a permission mutation does not advance every affected user's epoch transactionally;
- an event socket survives beyond 65 seconds after authorization can no longer be proved;
- the external quote mutation barrier does not intercept both exact accept/decline routes before backend selection with `503` plus `Retry-After: 60`, or it also blocks public GET/assets;
- database-mode accept/decline is exposed while any reachable responder is pre-wave, legacy, paused, unknown, unreachable, absent from the reconciled inventory, or on a different release;
- a database-mode mutation canary is attempted while the fleet is mixed, or the barrier is lifted before the complete direct-backend inventory passes;
- two quote responses succeed or a rolled-back response consumes the capability;
- accepted/declined quote reads or assets fail without explicit `publicLinkRevokedAt`;
- a cross-user retry row can be forged through the application role;
- logs or metrics contain any raw token, JTI, capability URL, or customer quote content.

Contain by keeping event mode `compat` only while fresh live resolution remains active, routing OAuth to the Wave 3 fleet, and restoring or retaining the external quote mutation barrier while the backend inventory is reconciled. Before database exposure, quote instances may remain `legacy` or `paused` behind that barrier; after database exposure, keep or restore the barrier and use only database-capable Wave 3 responders. Never disable live user checks, reset epochs, clear consumed quote state, return to post-commit response revocation, or reintroduce a legacy quote responder after database cutover.
