# Auth Hardening Performance Analysis (PR #568, SR-001..SR-024)

Date: 2026-05-04 — branch `security-hardening` vs `main`.

## 1. Findings: queries-pre vs queries-post per hot route

Each `withSystemDbAccessContext` / `withDbAccessContext` call that is **not nested** inside an existing context opens a fresh Postgres transaction with five `set_config` statements (`apps/api/src/db/index.ts:103-119`). Each top-level call therefore costs **6 RTTs** (BEGIN+5×set_config) before the first business query, plus the query itself, plus COMMIT. None of the new auth-time helpers nest, so each new lookup is a separate transaction.

| Route | Auth path | Pre-hardening DB ops | Post-hardening DB ops | Net delta |
|---|---|---|---|---|
| `POST /agents/:id/heartbeat` | `agentAuthMiddleware` (`routes/agents/index.ts:29-42`) | 1 device SELECT + RLS context txn for handler | **same** — `assertActiveTenantContext` is **NOT** invoked | 0 |
| `POST /agents/:id/logs` | `agentAuthMiddleware` | same as heartbeat | **same** | 0 |
| WebSocket handshake (`agentWs`, `desktopWs`, `terminalWs`) | hashed token compare in handler | unchanged | unchanged | 0 |
| User JWT, **org-scope** (e.g. dashboard, fleet UI) | `authMiddleware` | 1 user SELECT + 1 wrapper context txn | 1 user + 1 org SELECT + 1 partner SELECT + 1 wrapper context | **+2 transactions** (org, partner) |
| User JWT, **partner-scope** (MSP console, RMM admin) | `authMiddleware` | 1 user + 1 partnerUsers + 1 organizations(by partner) + 1 wrapper | 1 user + 1 partner SELECT + 1 partnerUsers + 1 organizations + 1 wrapper | **+1 transaction** (partner) |
| User JWT, **system** | `authMiddleware` | 1 user + 1 wrapper | **same** — `assertActiveTenantContext` early-returns for system scope (`tenantStatus.ts:55`) | 0 |
| `apiKeyAuth` (Bearer `bk_*`) | `apiKeyAuthMiddleware` | 1 api_keys SELECT + 1 wrapper | + `getActiveOrgTenant` (org SELECT + partner SELECT) | **+2 transactions** |
| `bearerTokenAuth` (third-party OAuth) | `bearerTokenAuth.ts:241` | 1 lookup + wrapper | +1 `assertActiveTenantContext` | +1–2 transactions |

All new SELECTs hit primary-key indexes (`partners.id`, `organizations.id`) so individual query latency is sub-ms warm; the cost is almost entirely the transaction-setup roundtrips, which on a network-attached pgBouncer pool typically run 0.3–0.8 ms each. **A partner-scope authed request now incurs ~5 extra RTTs (one extra txn × 5 setup statements) over the pre-hardening baseline. Org-scope incurs ~10 RTTs (two extra txns).**

## 2. Agent heartbeat answer — does hardening hit it?

**No.** Evidence:

- `apps/api/src/routes/agents/index.ts:29-42` mounts `agentAuthMiddleware` (not `authMiddleware`) for all `/:id/*` paths including heartbeat.
- `apps/api/src/middleware/agentAuth.ts` does **not** import `assertActiveTenantContext` (verified by grep across the diff). It performs exactly one device SELECT and one RLS context wrapper, identical to pre-hardening except for the new role-scoped token matching (in-process compare, no DB).
- The 10K-agent steady-state hot path is therefore unchanged. This is the most important finding to lead with — heartbeat throughput targets are unaffected.

## 3. Recommendation: cache `getActivePartner` and `getActiveOrgTenant`

The `partners.id` and `organizations.id` lookups dominate the new cost and are extremely cacheable: tenants change status on the order of minutes (admin action), and `tokenRevocation` already provides a sub-second blast-radius cut for any user/session under a suspended tenant.

**Design:**

- **Layer**: in-process LRU first (capacity 5–10k tenant rows; partner+org), backed by Redis for cross-instance coherence. In-process is sufficient for correctness because invalidation is event-driven; Redis layer is optional but cheap.
- **Keys**:
  - `tenant:partner:{partnerId}:v1` → `{ status, deletedAt | null }` or `null` for hard-miss
  - `tenant:org:{orgId}:v1` → `{ status, deletedAt | null, partnerId }` or `null`
- **TTL**: 60 s for in-process, 300 s for Redis. Justification: `revokePartnerTenantAccess` / `revokeOrganizationTenantAccess` (`services/tenantLifecycle.ts`) already revoke all user JWTs and API keys synchronously — a stale "active" cache cannot grant access to a token that no longer exists. The cache only fronts the *additional* check that the lifecycle code already enforces upstream. 60 s is well under any human-operator tolerance for "I just suspended this customer."
- **Invalidation hooks** (synchronous, in `tenantLifecycle.ts`):
  - In `revokeOrganizationTenantAccess(orgId)`: `cache.delete('tenant:org:'+orgId)` immediately after the DB writes complete; also publish a Redis pub/sub message on `tenant:invalidate` so peer API instances drop their in-process entry.
  - In `revokePartnerTenantAccess(partnerId)`: delete partner key + all org keys for the partner (the function already enumerates `orgIds`).
  - Add equivalent invalidation in any code that flips `partners.status`/`organizations.status` or sets `deletedAt`. Search now: `git grep -n "partners.status\|organizations.status\|deletedAt"` in `services/`.
- **Negative caching**: cache the `null` result for 30 s to absorb the case where a deleted/wrong tenant id is hammered by a stuck client.

**Expected impact**: removes ~5–10 RTTs from every authenticated browser/API request when warm. The per-instance cache hit ratio on a steady tenant population is effectively 100 % outside of deploys.

## 4. Other observations

- **Real win, not flagged in prompt**: `apiKeyAuthMiddleware` (`apiKeyAuth.ts:143`) now calls `getActiveOrgTenant` on every API-key request. Same cache fixes this for free.
- **Non-win**: pre-fetching the user row at line 319 of `auth.ts` is unavoidable (RLS bootstrap chicken-and-egg) and already cheap (PK lookup).
- **Worth flagging**: `withSystemDbAccessContext` does not reuse a request-scoped transaction. Three sequential top-level calls in `authMiddleware` (user, tenant assertion, computeAccessibleOrgIds) is wasteful even with caching — a follow-up could batch them under a single outer `withSystemDbAccessContext`, saving 2 BEGIN/COMMIT pairs (~10 RTTs) on cache misses. Low priority once the cache lands.
- **Confirmed not affected**: WebSocket connect-time auth runs once per connection (long-lived), so the org-scope penalty there is amortized over many messages and not worth optimizing first.
- **Unrelated to perf but worth noting**: `partnerCondition` in `computeAccessibleOrgIds` for the `selected` branch could be merged with the `all` branch via a single query — but again, sub-ms PK/FK lookup, not a hot fix.
