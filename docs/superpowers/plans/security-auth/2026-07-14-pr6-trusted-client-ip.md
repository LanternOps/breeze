# PR 6 — Trusted Client-IP Boundary: Fail-Closed Allowlists + Spoof-Proof Rate Limits (SR2-16)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Branch from `origin/main` (NOT the current `core-auth-4-email-recovery` worktree branch). This is the sixth and final PR of the epic.

**Scope:** SR2-16 from `docs/superpowers/specs/security-auth/2026-07-11-core-authentication-hardening-design.md` — "Generic trusted-Caddy deployments can accept a client-supplied Cloudflare client-IP header and bypass partner IP allowlists." Severity HIGH / 8, **configuration-dependent**. Design invariant 9: "Client IP is derived at a trusted proxy boundary and cannot be selected by an untrusted request header."

**Goal:** When a partner IP allowlist is configured but the API cannot derive a *trusted* client IP (untrusted TCP peer, spoofed forwarded header, or no proxy-trust config), authorization must **fail closed (DENY)** — not silently skip the allowlist as it does today. Separately, per-IP rate limits must key on the un-spoofable TCP socket peer so an attacker rotating a forged `X-Forwarded-For` from an untrusted peer cannot mint a fresh limit bucket per request. Finally, migrate the last naive direct-header readers to the canonical resolver so enrollment/session IP attribution can't be spoofed.

**Architecture / what already exists (READ THIS FIRST):** The heavy lifting shipped in prior hardening work (`#524`, `#568`, `#1194`, `#2364`) and is on `origin/main`:
- `apps/api/src/services/clientIp.ts` — the canonical resolver `getTrustedClientIp(c, fallback)` / `getTrustedClientIpOrUndefined(c)` is **already correct**: it only honors `CF-Connecting-IP` / `X-Forwarded-For` / `X-Real-IP` when the immediate TCP peer (`c.env.incoming.socket.remoteAddress`, the Node adapter's socket) is inside `TRUSTED_PROXY_CIDRS` (BigInt CIDR match, IPv4 + IPv6, IPv4-mapped handling); otherwise it returns the fallback and, in production, warns loudly + increments a Prometheus counter (`#2364`). Trust is off-by-default in production (`TRUST_PROXY_HEADERS` `auto` ⇒ false in prod).
- Most naive readers were **already migrated** to this resolver on `origin/main`: `routes/auth/helpers.ts getClientIP`, `routes/portal/helpers.ts getClientIp`, `routes/sso.ts getClientIP`, `routes/tunnels.ts getClientIp`, `routes/oauth.ts`, `routes/mcpServer.ts`, `routes/enrollmentKeys.ts`, and `services/auditEvents.ts` (`getTrustedClientIpOrUndefined`) all delegate correctly.
- `config/validate.ts` already validates `TRUST_PROXY_HEADERS` + `TRUSTED_PROXY_CIDRS` in production (refuses all-private / all-source, requires non-empty when trust enabled).
- The partner allowlist enforcement (`services/ipAllowlist.ts`, `middleware/ipAllowlistGuard.ts`) and its per-request/login/MCP call sites already exist and already use `getTrustedClientIpOrUndefined`.

**Therefore this PR is NOT the big migration sweep the design section anticipated — most of it already landed.** The net-new work is four residual gaps this plan closes: (1) the allowlist **fail-OPEN** when no trusted IP can be derived, (2) the rate-limit **fingerprint** built from spoofable headers, (3) three remaining raw-header readers (`installer.ts`, `devices/provision.ts`, `llm/openaiSessionManager.ts`), and (4) the shipped self-host Compose stack declaring its trust mode so it derives a real client IP out of the box.

**Tech Stack:** Hono (TypeScript, Node adapter), Drizzle ORM, PostgreSQL (RLS via `breeze_app`), Redis (ioredis), Vitest, Docker Compose + Caddy. **No database migration** — this PR is config + code only.

---

## Open Questions / Plan Conflicts / Current State — ADJUDICATE BEFORE EXECUTION

**CURRENT STATE (verified against `origin/main`, commit range through `#2364`/`#1194`):**
- **Where the client IP is extracted today:** the single canonical resolver `getTrustedClientIp` / `getTrustedClientIpOrUndefined` in `apps/api/src/services/clientIp.ts` (peer read at `getImmediatePeerIp`, `c.env.incoming.socket.remoteAddress`). It is **already correct and fail-safe** — untrusted peer ⇒ forwarded headers ignored ⇒ returns fallback / `undefined`.
- **Trusted-proxy config that already exists:** env vars `TRUST_PROXY_HEADERS` (auto|true|false, auto⇒false in prod) and `TRUSTED_PROXY_CIDRS` (comma-separated exact CIDRs, `/32`-style; drift to broad ranges was hardened out in `#2364`, IPv6 matching in `#1194`), validated in `config/validate.ts`. Caddy side: `CADDY_TRUSTED_PROXIES` + `CADDY_CLIENT_IP_HEADERS` in `docker/Caddyfile.prod` (`trusted_proxies static` + `client_ip_headers`). Allowlist enforcement mode: `IP_ALLOWLIST_ENFORCEMENT_MODE` (enforce|off, default enforce).
- **Already partially correct?** YES — substantially. The *header-trust* half of SR2-16 (don't honor a spoofed header from an untrusted peer) is DONE. What remains BROKEN is the *consumer* half: `evaluateIpAllowlist` (`services/ipAllowlist.ts:36`) returns `{ decision: 'skip', reason: 'untrusted_ip' }` when `clientIp === undefined`, and `isBlocked` treats `skip` as **allow**. So in any deployment where a partner has an allowlist but proxy-trust is unconfigured/stale/spoofed, the allowlist is **silently bypassed** (fail-OPEN). `routes/auth/login.ts:412` even documents it in a comment ("untrusted-IP fail-open are handled inside enforceIpAllowlist"). All three enforcement sites (`ipAllowlistGuard`, `login.ts`, `mcpServer.ts`) route through `isBlocked`, so a single change to `evaluateIpAllowlist` closes all three.
- **Rate-limit gap:** `routes/auth/helpers.ts getClientRateLimitKey` falls back to a SHA-256 fingerprint of `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip` (spoofable) when the trusted IP is `unknown` — so an untrusted peer rotating `X-Forwarded-For` mints a new bucket per request and evades the per-IP limit.
- **Residual naive readers (still raw):** `routes/installer.ts:86` (`cf-connecting-ip`), `routes/devices/provision.ts:354` (`cf-connecting-ip`), `services/llm/openaiSessionManager.ts:63` (`x-forwarded-for`/`x-real-ip`). These feed enrollment/session abuse attribution and are spoofable.

**Q-A — Design-doc "fail closed / DENY" vs the task brief's "fall back to the DIRECT socket IP" for the ALLOWLIST. THESE CONFLICT. PLAN DEFAULT: fail closed / DENY for the allowlist; socket IP for rate limits. RECOMMENDED.**
The design doc (source of truth) is explicit: *"When a partner IP allowlist is configured but no trusted client IP can be derived, authorization fails closed."* The task's generic constraint says "fall back to the direct socket IP … an allowlist that can't determine the true client IP must DENY." These are reconcilable per surface, and using the raw socket IP *as an allowlist value* is actively wrong in the hosted topology: the socket peer is ALWAYS Caddy/cloudflared, so comparing the proxy's IP to a partner's list would deny every legitimate user (and, if the operator ever allowlisted an infra IP, allow everyone). **Recommendation: allowlist ⇒ DENY when no trusted client IP (Task 1); rate-limit ⇒ key on the socket peer (Task 2).** This honors both documents ("must DENY" for the allowlist; "fall back to socket IP" for the throttle key). Flag for controller.

**Q-B — Hosted vs self-hosted default. PLAN DEFAULT: trust NOTHING by default; honor forwarded headers only with explicit trusted-proxy config; shipped Compose stacks declare trust explicitly. RECOMMENDED — confirm.**
The *code* default is already correct (`TRUST_PROXY_HEADERS=auto` ⇒ false in prod ⇒ no header trust ⇒ allowlist now fail-closes). The gap is the shipped **self-host** `docker-compose.yml`, which runs the bundled Caddy in front of the API yet ships `TRUST_PROXY_HEADERS=false` — so a self-hoster who enables a partner allowlist is locked out (fail-closed, correct but surprising) and their rate limits pool onto Caddy. Task 4 makes the bundled stack declare trust explicitly (pin the Caddy container IP into `TRUSTED_PROXY_CIDRS`, mirroring `deploy/docker-compose.prod.yml`). **This is opinionated and touches infra defaults — confirm before executing Task 4.** A deployment with NO proxy in front should keep `TRUST_PROXY_HEADERS=false` and simply not configure partner allowlists (or accept fail-closed).

**Q-C — Header set + XFF parsing (SR2-16 ambiguity).** The resolver already fixes precedence: `CF-Connecting-IP` (single canonical, Cloudflare-set) > left-most valid `X-Forwarded-For` > `X-Real-IP`, and only from a trusted peer. This plan does NOT change precedence or add right-most-untrusted XFF chain walking (unnecessary: we only trust the header at all when the immediate peer is a configured proxy, so the head of the chain is the real client that our own edge wrote). No multi-hop proxy chain support is added. If the controller wants right-most-untrusted parsing for a multi-proxy topology, that is a separate change to `clientIp.ts` precedence — out of scope here.

**Q-D — Is this env-only or code?** BOTH, but primarily CODE. The security fix is code (Tasks 1-3 in `services/ipAllowlist.ts`, `routes/auth/helpers.ts`, `services/clientIp.ts`, `routes/installer.ts`, `routes/devices/provision.ts`, `services/llm/openaiSessionManager.ts`). Task 4 is env/Compose only. **No new env var is introduced** (`TRUST_PROXY_HEADERS`, `TRUSTED_PROXY_CIDRS`, `CADDY_TRUSTED_PROXIES`, `IP_ALLOWLIST_ENFORCEMENT_MODE` all already exist and are already mapped through Compose), so the CLAUDE.md "map new env vars through compose" rule imposes no new work — Task 4 only changes DEFAULT VALUES / adds a static IP. **No DB migration** (latest shipped migration is `2026-07-18-pending-email-and-verification-purpose.sql`; this PR adds none).

**Q-E — Lockout blast radius of Task 1.** Flipping `untrusted_ip` from skip→deny converts today's silent bypass into a hard 403 for any partner-with-allowlist whenever proxy trust is misconfigured or `TRUSTED_PROXY_CIDRS` has gone STALE (the `#2364` container-recreated-without-static-IP scenario). This is the CORRECT fail-closed behavior and `#2364` already warns loudly, but it IS a change from "everyone gets in" to "everyone with an allowlist is locked out" under misconfiguration. `routes/orgs.ts:697` already refuses to let a partner enable the allowlist without proxy trust configured — verify that guard still holds. Release notes MUST call this out.

---

## Global Constraints

- **Node 22.20.0.** Prefix every `pnpm`/`node`/`vitest` command with `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"` (no version manager is installed; the pinned binary lives there).
- **FAIL CLOSED / FAIL SAFE (the whole point of this PR).** If trust cannot be established — no `TRUST_PROXY_HEADERS`/`TRUSTED_PROXY_CIDRS` config, untrusted TCP peer, unparseable/spoofed forwarded header, or socket IP unavailable — the app MUST NOT trust an unverified header. For the **partner IP allowlist**, a request whose true client IP cannot be determined is DENIED, never allowed (Task 1). For **rate limits**, the key falls back to the un-spoofable TCP socket peer, and only to a non-IP UA fingerprint when even the socket is unavailable — never to a fingerprint of spoofable IP headers (Task 2). Each task restates its fail-safe rule.
- **CONFIGURATION-DEPENDENT — do not break either topology.** Hosted (real Cloudflare/Caddy edge in `TRUSTED_PROXY_CIDRS`) must keep working unchanged: trusted peer ⇒ real client IP ⇒ normal allow/deny. Self-hosted/generic-Caddy must not be spoofable-by-default: either it declares trust (Task 4) and derives a real client IP, or it has no proxy trust and the allowlist fail-closes. Every allowlist/IP task includes BOTH a trusted-peer test and an untrusted-peer test.
- **Multi-tenant.** Partner IP allowlists are the enforcement target. A regression either locks out legitimate partners (real IP wrongly rejected) or lets attackers spoof past the list. Every allowlist task tests BOTH directions.
- **Every security gate needs a GUARD-BITING test** — one that provably goes RED if the protection is deleted. A test that would still pass with the guard removed (e.g. one that only exercises the trusted-peer happy path) is vacuous. Each task names its guard-bite test; each must include a **spoofed-header-from-untrusted-peer** assertion that the header is IGNORED.
- **The API connects to Postgres as unprivileged `breeze_app`.** `enforceIpAllowlist` reads the partner row via `runOutsideDbContext(() => withSystemDbAccessContext(...))` (already correct — do not remove; an org-scoped caller cannot see the `partners` row and a contextless read returns 0 rows). A 0-row/errored read must NOT become "no allowlist ⇒ allow": `ipAllowlistGuard` already converts a throw to a 503, not an allow — preserve that.
- **Reuse existing machinery, do not reinvent.** `services/clientIp.ts` is the ONLY place that decides header trust — new readers call it, none re-read `c.req.header('cf-connecting-ip')` directly. `services/ipMatch.ts ipMatchesAny` is the CIDR matcher. Do not add a second env-parsing path.
- **Test-mock hazard.** `services/ipAllowlist.test.ts` and `routes/auth/helpers.test.ts` mock env (`process.env.TRUST_PROXY_HEADERS` / `TRUSTED_PROXY_CIDRS` / `NODE_ENV`) in `beforeEach`/`afterEach` — restore them (see `clientIp.test.ts` for the canonical save/restore pattern). Route tests that mock Drizzle use ordered `mockReturnValueOnce` queues — if you add a `db.select`, re-prime the queue; never delete assertions to make a suite pass. `enforceIpAllowlist` consumes one `partners` select from the queue (see `__tests__/setup.ts:9`).
- **No new env var, no migration, no schema.** Task 4 changes Compose default values only. If any task finds itself writing a migration or a new env var, STOP — it is out of scope for SR2-16.
- **Commit after each green task.** Strict red-green TDD: write the failing test, observe the reviewed failure, then implement.

---

## File Structure

**Modify (code)**
- `apps/api/src/services/ipAllowlist.ts` — `evaluateIpAllowlist`: `untrusted_ip` becomes a DENY; `enforceIpAllowlist` audits the deny + keeps the loud operator warning (Task 1).
- `apps/api/src/services/clientIp.ts` — export `getImmediatePeerIpOrUndefined(c)` (socket-only peer, no header trust) for the rate-limit key (Task 2).
- `apps/api/src/routes/auth/helpers.ts` — `getClientRateLimitKey`: key on `socket:<peer>` when no trusted IP; UA-only fingerprint fallback; NEVER fingerprint IP headers (Task 2).
- `apps/api/src/routes/installer.ts` — bootstrap enrollment IP via `getTrustedClientIp` (Task 3).
- `apps/api/src/routes/devices/provision.ts` — provision-handle IP via `getTrustedClientIpOrUndefined` (Task 3).
- `apps/api/src/services/llm/openaiSessionManager.ts` — audit snapshot IP via `getTrustedClientIpOrUndefined` (Task 3).

**Modify (config, Task 4 — gated on Q-B confirmation)**
- `docker-compose.yml` — bundled self-host stack: pin the `caddy` service IP; default `TRUST_PROXY_HEADERS=true` + `TRUSTED_PROXY_CIDRS=<caddy-ip>/32`.
- `.env.example` — document the self-host trust default.

**Create (tests)**
- `apps/api/src/__tests__/integration/ipAllowlistTrustBoundary.integration.test.ts` — real-DB fail-closed allowlist proof across direct/CF/generic modes (Task 5).
- New unit tests added to existing files: `services/ipAllowlist.test.ts`, `services/clientIp.test.ts`, `routes/auth/helpers.test.ts`, `routes/installer.test.ts`, `routes/devices/provision.test.ts` (Tasks 1-3). Add `services/llm/openaiSessionManager.test.ts` (new file, Task 3).

---

### Task 1: Fail-closed partner IP allowlist when no trusted client IP can be derived

**Files:**
- Modify: `apps/api/src/services/ipAllowlist.ts`
- Test: `apps/api/src/services/ipAllowlist.test.ts` (extend)

**Interfaces / behavior change:**
- `IpAllowlistDecision`: move `untrusted_ip` from the `skip` union into the `deny` union.
  ```ts
  export type IpAllowlistDecision =
    | { decision: 'allow' }
    | { decision: 'deny'; reason: 'not_in_list' | 'untrusted_ip' }
    | { decision: 'skip'; reason: 'mode_off' | 'empty_list' | 'platform_admin' | 'no_partner' };
  ```
- `evaluateIpAllowlist`: when `allowlist` is non-empty and `clientIp === undefined`, return `{ decision: 'deny', reason: 'untrusted_ip' }`. (Order matters: `mode_off`, `empty_list`, `platform_admin` skips still short-circuit FIRST — an empty list or admin is not denied, and enforcement-off is not denied. Only a CONFIGURED allowlist with an untrustable IP denies.)
- `enforceIpAllowlist`: the deny branch (`isBlocked`) now also fires for `untrusted_ip`; when the reason is `untrusted_ip`, ALSO call `warnInactiveAllowlist(params.partnerId)` (keep the loud operator signal) and record `reason` in the audit `details`. Remove the old `else if (decision.decision === 'skip' && decision.reason === 'untrusted_ip')` branch.
- **Fail-safe rule:** a configured allowlist + undetermined true client IP = DENY. `mode='off'`, empty list, and platform-admin still bypass (unchanged). `isBlocked` unchanged (`decision === 'deny'`) so `ipAllowlistGuard` (403), `login.ts` (generic auth error), and `mcpServer.ts` (403) all fail closed in one change.

- [ ] **Step 1: Write the failing tests** — extend `apps/api/src/services/ipAllowlist.test.ts`:

```ts
describe('evaluateIpAllowlist — fail-closed on untrusted IP (SR2-16)', () => {
  it('DENIES when an allowlist is configured but the client IP is not trustable (untrusted peer / spoofed header / no proxy-trust config)', () => {
    // GUARD-BITE: this is RED today (returns { decision: 'skip', reason: 'untrusted_ip' }
    // and isBlocked(skip)===false ⇒ the request is silently allowed past the allowlist).
    const d = evaluateIpAllowlist({
      mode: 'enforce',
      allowlist: ['203.0.113.0/24'],
      clientIp: undefined,
      isPlatformAdmin: false,
    });
    expect(d).toEqual({ decision: 'deny', reason: 'untrusted_ip' });
    expect(isBlocked(d)).toBe(true);
  });

  it('does NOT deny when there is no allowlist (empty list) even if the IP is untrustable', () => {
    const d = evaluateIpAllowlist({ mode: 'enforce', allowlist: [], clientIp: undefined, isPlatformAdmin: false });
    expect(d).toEqual({ decision: 'skip', reason: 'empty_list' });
  });

  it('does NOT deny a platform admin even with an allowlist + untrustable IP', () => {
    const d = evaluateIpAllowlist({ mode: 'enforce', allowlist: ['203.0.113.0/24'], clientIp: undefined, isPlatformAdmin: true });
    expect(d).toEqual({ decision: 'skip', reason: 'platform_admin' });
  });

  it('does NOT deny when enforcement mode is off', () => {
    const d = evaluateIpAllowlist({ mode: 'off', allowlist: ['203.0.113.0/24'], clientIp: undefined, isPlatformAdmin: false });
    expect(d).toEqual({ decision: 'skip', reason: 'mode_off' });
  });

  it('still allows a trusted client IP that is in the list, and denies one that is not (regression)', () => {
    expect(evaluateIpAllowlist({ mode: 'enforce', allowlist: ['203.0.113.5/32'], clientIp: '203.0.113.5', isPlatformAdmin: false }))
      .toEqual({ decision: 'allow' });
    expect(evaluateIpAllowlist({ mode: 'enforce', allowlist: ['203.0.113.5/32'], clientIp: '198.51.100.9', isPlatformAdmin: false }))
      .toEqual({ decision: 'deny', reason: 'not_in_list' });
  });
});
```

Guard-bite: the first test goes RED if `untrusted_ip` ever returns `skip`; tests 2-4 prove we did NOT over-deny (an empty list / admin / mode-off must still pass) — dropping any one risks a lockout regression.

- [ ] **Step 2: Run to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/ipAllowlist.test.ts
```
Expected: FAIL — the first test asserts `deny`/`untrusted_ip` but the code returns `{ decision: 'skip', reason: 'untrusted_ip' }`, so `isBlocked` is `false`.

- [ ] **Step 3: Implement** — in `apps/api/src/services/ipAllowlist.ts`:
  1. Change the `IpAllowlistDecision` type as above (`untrusted_ip` under `deny`).
  2. In `evaluateIpAllowlist`, change line 36 to:
     ```ts
     if (clientIp === undefined) return { decision: 'deny', reason: 'untrusted_ip' };
     ```
  3. In `enforceIpAllowlist`, replace the trailing branches so the deny path also handles `untrusted_ip`:
     ```ts
     if (isBlocked(decision)) {
       if (decision.reason === 'untrusted_ip') warnInactiveAllowlist(params.partnerId);
       writeAuditEvent(c, {
         orgId: null,
         action: 'ip_allowlist.denied',
         resourceType: 'partner',
         resourceId: params.partnerId,
         result: 'denied',
         actorType: 'user',
         actorId: params.actorId ?? null,
         actorEmail: params.actorEmail ?? undefined,
         details: { clientIp: clientIp ?? null, reason: decision.reason },
       });
     } else if (decision.decision === 'skip' && decision.reason === 'platform_admin') {
       // unchanged platform-admin bypass audit
     }
     ```
     Delete the old `else if (... reason === 'untrusted_ip')` skip branch.

- [ ] **Step 4: Run to verify GREEN**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/services/ipAllowlist.test.ts
```
Expected: PASS (all cases). Then confirm no caller relied on the old skip shape:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/middleware/ipAllowlistGuard.test.ts src/routes/auth/login.test.ts src/routes/mcpServer.test.ts 2>&1 | tail -20
```
Expected: PASS — update any test that asserted the old `untrusted_ip` allow-through to assert a deny (these are the tests the fix is SUPPOSED to flip; do not weaken them, flip them).

- [ ] **Step 5: Update the misleading comment** in `apps/api/src/routes/auth/login.ts` (~line 412): replace "Platform admins and untrusted-IP fail-open are handled inside enforceIpAllowlist." with "Platform admins bypass; an untrusted/undeterminable client IP now FAILS CLOSED (deny) inside enforceIpAllowlist (SR2-16)."

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "fix(security): partner IP allowlist fails closed when no trusted client IP can be derived (SR2-16)

An allowlist-protected partner was silently BYPASSED (skip⇒allow) whenever the
API could not derive a trusted client IP — untrusted TCP peer, spoofed forwarded
header, or missing/stale TRUST_PROXY_HEADERS/TRUSTED_PROXY_CIDRS. Move untrusted_ip
from skip to deny so ipAllowlistGuard/login/MCP all fail closed. Empty-list,
platform-admin, and mode-off still bypass (no over-deny).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rate-limit key uses the un-spoofable socket peer, never a spoofable-header fingerprint

**Files:**
- Modify: `apps/api/src/services/clientIp.ts` (export socket-only peer getter)
- Modify: `apps/api/src/routes/auth/helpers.ts` (`getClientRateLimitKey`)
- Test: `apps/api/src/services/clientIp.test.ts`, `apps/api/src/routes/auth/helpers.test.ts`

**Interfaces:**
- Add to `clientIp.ts`:
  ```ts
  // The immediate TCP peer, socket-only — NEVER consults forwarded headers, so
  // it cannot be spoofed at L7. Used as a rate-limit key of last resort when no
  // trusted client IP is available. Unlike getTrustedClientIp this does NOT gate
  // on TRUST_PROXY_HEADERS: the socket address is always the real peer.
  export function getImmediatePeerIpOrUndefined(c: RequestLike): string | undefined {
    const ctx = c as RequestLike & { env?: { incoming?: { socket?: { remoteAddress?: string } } } };
    return normalizeIpCandidate(ctx.env?.incoming?.socket?.remoteAddress ?? '') ?? undefined;
  }
  ```
- **Fail-safe rule:** `getClientRateLimitKey` prefers the trusted client IP (`ip:<ip>`); if none, it keys on the socket peer (`socket:<peer>`); only if even the socket is unavailable does it fall back to a UA/lang/origin fingerprint (`fp:<hash>`) — which NEVER includes `x-forwarded-for` / `x-real-ip` / `cf-connecting-ip`.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/routes/auth/helpers.test.ts` (add; mirror the `makeContext(headers, remoteAddress)` shim from `clientIp.test.ts`, and force `TRUST_PROXY_HEADERS='false'` so no trusted IP is derived):

```ts
describe('getClientRateLimitKey — spoof-proof per-IP key (SR2-16)', () => {
  const origTrust = process.env.TRUST_PROXY_HEADERS;
  beforeEach(() => { process.env.TRUST_PROXY_HEADERS = 'false'; }); // untrusted / no proxy trust
  afterEach(() => { if (origTrust === undefined) delete process.env.TRUST_PROXY_HEADERS; else process.env.TRUST_PROXY_HEADERS = origTrust; });

  it('keys on the SOCKET peer, so a rotating spoofed X-Forwarded-For from the same peer yields the SAME key (cannot evade the per-IP limit)', () => {
    // GUARD-BITE: RED today — the fingerprint hashes x-forwarded-for, so the two
    // keys differ and an attacker mints a fresh bucket per request.
    const a = getClientRateLimitKey(makeContext({ 'x-forwarded-for': '1.2.3.4' }, '198.51.100.77'));
    const b = getClientRateLimitKey(makeContext({ 'x-forwarded-for': '5.6.7.8' }, '198.51.100.77'));
    expect(a).toBe('socket:198.51.100.77');
    expect(b).toBe('socket:198.51.100.77');
    expect(a).toBe(b);
  });

  it('never includes spoofable IP headers in the fingerprint fallback (no socket, no trusted IP)', () => {
    const withHdr = getClientRateLimitKey(makeContext({ 'x-forwarded-for': '9.9.9.9', 'user-agent': 'UA' }));
    const noHdr = getClientRateLimitKey(makeContext({ 'user-agent': 'UA' }));
    expect(withHdr.startsWith('fp:')).toBe(true);
    expect(withHdr).toBe(noHdr); // x-forwarded-for must NOT change the fingerprint
  });

  it('prefers the trusted client IP when proxy trust is properly configured', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_CIDRS = '198.51.100.77/32';
    const key = getClientRateLimitKey(makeContext({ 'cf-connecting-ip': '203.0.113.5' }, '198.51.100.77'));
    expect(key).toBe('ip:203.0.113.5');
    delete process.env.TRUSTED_PROXY_CIDRS;
  });
});
```

Add a matching unit test for `getImmediatePeerIpOrUndefined` in `clientIp.test.ts` (returns the socket address regardless of `TRUST_PROXY_HEADERS`; returns `undefined` when no socket).

- [ ] **Step 2: Run to verify it fails**
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/helpers.test.ts src/services/clientIp.test.ts
```
Expected: FAIL — the first two tests: current code returns `fp:<hash>` derived from the differing `x-forwarded-for`, so `a !== b` and the fingerprint differs when the header changes.

- [ ] **Step 3: Implement**
  1. Add `getImmediatePeerIpOrUndefined` to `clientIp.ts` (above).
  2. In `apps/api/src/routes/auth/helpers.ts`, import it and rewrite `getClientRateLimitKey`:
     ```ts
     import { getTrustedClientIp, getImmediatePeerIpOrUndefined } from '../../services/clientIp';

     export function getClientRateLimitKey(c: RequestLike): string {
       const trustedIp = getClientIP(c);
       if (trustedIp && trustedIp !== 'unknown') {
         return `ip:${trustedIp}`;
       }
       // No proxy-verified client IP. Do NOT fingerprint forwarded IP headers —
       // an attacker rotating X-Forwarded-For from an untrusted peer would mint a
       // fresh bucket per request and evade the per-IP limit (SR2-16). Key on the
       // immediate TCP peer, which cannot be spoofed at L7.
       const peerIp = getImmediatePeerIpOrUndefined(c);
       if (peerIp) {
         return `socket:${peerIp}`;
       }
       // Only when even the socket address is unavailable (non-Node runtime / test
       // shim) fall back to a NON-IP fingerprint. Never include x-forwarded-for /
       // x-real-ip / cf-connecting-ip here — they are attacker-controlled.
       const read = (name: string) => c.req.header(name) ?? c.req.header(name.toLowerCase()) ?? '';
       const fingerprintSource = [read('user-agent'), read('accept-language'), read('origin')].join('|');
       const digest = createHash('sha256')
         .update(fingerprintSource || 'no-client-fingerprint')
         .digest('hex')
         .slice(0, 24);
       return `fp:${digest}`;
     }
     ```

- [ ] **Step 4: Run to verify GREEN**
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/helpers.test.ts src/services/clientIp.test.ts
```
Expected: PASS. Also run the rate-limit consumers to catch key-shape assumptions:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/auth/login.test.ts src/routes/auth/password.test.ts src/routes/auth/invite.test.ts src/routes/auth/accountDeletion.test.ts 2>&1 | tail -20
```
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "fix(security): rate-limit key uses the un-spoofable TCP socket peer, not a spoofable-header fingerprint (SR2-16)

getClientRateLimitKey fell back to a SHA-256 of x-forwarded-for/x-real-ip/
cf-connecting-ip when no trusted client IP was available, letting an untrusted
peer rotate a forged X-Forwarded-For and mint a fresh per-IP bucket every
request. Key on socket:<peer> instead; UA-only fingerprint of last resort.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migrate the last three naive direct-header readers to the canonical resolver

**Files:**
- Modify: `apps/api/src/routes/installer.ts`, `apps/api/src/routes/devices/provision.ts`, `apps/api/src/services/llm/openaiSessionManager.ts`
- Test: `apps/api/src/routes/installer.test.ts`, `apps/api/src/routes/devices/provision.test.ts`, `apps/api/src/services/llm/openaiSessionManager.test.ts` (new)

**Interfaces / changes (each preserves the existing null/unknown semantics):**
- `installer.ts:86` — `const ip = c.req.header("cf-connecting-ip") ?? "unknown";` becomes
  `const ip = getTrustedClientIp(c, c.env?.incoming?.socket?.remoteAddress ?? "unknown");` (mirror `oauth.ts:59`/`mcpServer.ts:99`). Import `getTrustedClientIp` from `../services/clientIp`.
- `devices/provision.ts:354` — `const ip = c.req.header('cf-connecting-ip') ?? null;` becomes
  `const ip = getTrustedClientIpOrUndefined(c) ?? null;`. Import `getTrustedClientIpOrUndefined` from `../../services/clientIp`.
- `llm/openaiSessionManager.ts:63` — `ip: requestContext?.req.header('x-forwarded-for') ?? requestContext?.req.header('x-real-ip'),` becomes
  `ip: requestContext ? getTrustedClientIpOrUndefined(requestContext) : undefined,`. Import `getTrustedClientIpOrUndefined` from `./clientIp` (adjust relative path from `services/llm/` ⇒ `../clientIp`).
- **Fail-safe rule:** each records the resolver's fallback (`unknown`/`null`/`undefined`) when the peer is untrusted — never the raw spoofed header value. Enrollment/session abuse attribution can no longer be poisoned by a forged header from an untrusted peer.

- [ ] **Step 1: Write the failing guard-bite tests** — for each reader, assert that with `TRUST_PROXY_HEADERS='false'` (untrusted / no proxy trust) a request carrying a SPOOFED header records the fallback, NOT the header value. Example for `installer.test.ts`:

```ts
it('records the fallback, not a spoofed cf-connecting-ip, when the peer is untrusted (SR2-16)', async () => {
  process.env.TRUST_PROXY_HEADERS = 'false';
  // ...drive the bootstrap route with header cf-connecting-ip: '203.0.113.5' and
  // socket remoteAddress '198.51.100.77'...
  // GUARD-BITE: RED today — installer.ts reads the header raw, so the persisted
  // enrollment IP is '203.0.113.5' (the spoof). After the fix it is the socket
  // fallback '198.51.100.77' (or 'unknown' if no socket in the shim).
  expect(persistedEnrollmentIp).not.toBe('203.0.113.5');
});
```
Add the trusted-peer counterpart (`TRUST_PROXY_HEADERS='true'`, `TRUSTED_PROXY_CIDRS` includes the socket peer, `cf-connecting-ip: '203.0.113.5'` ⇒ persisted IP IS `203.0.113.5`). Mirror for `provision.test.ts` and a new `openaiSessionManager.test.ts` (assert `session.auditSnapshot.ip` is `undefined`/socket-fallback for the untrusted spoof, and the CF IP for the trusted peer).

- [ ] **Step 2: Run to verify failure**
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/installer.test.ts src/routes/devices/provision.test.ts src/services/llm/openaiSessionManager.test.ts
```
Expected: FAIL — spoofed header value is recorded.

- [ ] **Step 3: Implement** the three edits above (imports + the single line each).

- [ ] **Step 4: Verify GREEN**
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/routes/installer.test.ts src/routes/devices/provision.test.ts src/services/llm/openaiSessionManager.test.ts
```
Expected: PASS. Then confirm no raw readers remain:
```bash
grep -rnE "req\.header\((['\"])(cf-connecting-ip|x-forwarded-for|x-real-ip)\1\)" apps/api/src --include='*.ts' | grep -viE '__tests__|\.test\.|services/clientIp\.ts|services/auditEvents\.ts'
```
Expected: NO output (the only legitimate header reads left are inside `clientIp.ts` itself and the `requestLikeFromSnapshot` shim in `auditEvents.ts`).

- [ ] **Step 5: Commit**
```bash
git add -A && git commit -m "fix(security): route the last enrollment/session IP readers through the trusted-proxy resolver (SR2-16)

installer bootstrap, device provision, and the OpenAI session audit snapshot
read cf-connecting-ip/x-forwarded-for/x-real-ip raw, so a forged header from an
untrusted peer poisoned enrollment/session IP attribution. Route them through
getTrustedClientIp(OrUndefined). No raw forwarded-header readers remain outside
services/clientIp.ts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4 (GATED on Q-B confirmation): Shipped self-host Compose stack declares its trust mode explicitly

> **Do not execute without controller sign-off on Q-B** — this changes infra defaults for self-hosters. If declined, skip Task 4; the code fixes (Tasks 1-3) already make self-host fail-closed rather than spoofable.

**Files:** `docker-compose.yml`, `.env.example`. **No new env var; no code.**

**Change:** The bundled `docker-compose.yml` runs Caddy in front of `api` but ships `TRUST_PROXY_HEADERS=false` + empty `TRUSTED_PROXY_CIDRS`, so the API ignores Caddy's overwritten client-IP header — self-host allowlists fail-closed and rate limits pool onto Caddy. Mirror `deploy/docker-compose.prod.yml`:
1. Give the `caddy` service a static address on the compose network (add a named network with a subnet and `ipv4_address`, matching how `deploy/docker-compose.prod.yml` pins `172.30.0.10`).
2. Default the API env to trust exactly that peer:
   ```yaml
   TRUST_PROXY_HEADERS: ${TRUST_PROXY_HEADERS:-true}
   TRUSTED_PROXY_CIDRS: ${TRUSTED_PROXY_CIDRS:-172.30.0.10/32}
   ```
   Keep `CADDY_TRUSTED_PROXIES` as-is (loopback default is fine — Caddy's own upstream is the host/CF).
3. Update `.env.example` to document that the bundled stack trusts the pinned Caddy container IP by default, and that a **proxy-less** deployment must set `TRUST_PROXY_HEADERS=false` and not rely on partner IP allowlists.

- [ ] **Step 1: Write the failing static check** — new `apps/api/src/config/proxyTrustCompose.test.ts` parses `docker-compose.yml` (via `js-yaml`, already a dep) and asserts: (a) the `api` service default for `TRUST_PROXY_HEADERS` is `true`; (b) its `TRUSTED_PROXY_CIDRS` default is non-empty and equals the `caddy` service's pinned `ipv4_address` + `/32`; (c) `docker/Caddyfile.prod` still sets `client_ip_headers` (headers overwritten at the edge). GUARD-BITE: (b) goes RED if the self-host stack ever ships trust-on without pinning the peer (which would trust an arbitrary upstream).

- [ ] **Step 2: Run RED**, then **Step 3: edit compose/.env**, then **Step 4: run GREEN**:
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api && pnpm vitest run src/config/proxyTrustCompose.test.ts
```
- [ ] **Step 5: Bring the stack up and confirm a real client IP is derived** (manual smoke, not required to pass CI):
```bash
docker compose up -d caddy api && sleep 5
docker compose exec caddy sh -c 'apk add --no-cache curl >/dev/null 2>&1; curl -s -H "X-Real-IP: 203.0.113.42" http://api:3001/health >/dev/null'
docker compose logs api | grep -i proxy-trust | tail -5   # expect NO stale-pin warnings
docker compose down
```
- [ ] **Step 6: Commit** `chore(deploy): self-host Compose declares proxy trust and pins the Caddy peer so real client IPs are derived out of the box (SR2-16)` with the standard Co-Authored-By trailer.

---

### Task 5: Real-DB integration proof across direct / Cloudflare / generic-proxy modes + whole-PR gate

**Files:** Create `apps/api/src/__tests__/integration/ipAllowlistTrustBoundary.integration.test.ts` (private Postgres, `breeze_app` RLS context, following the harness in the existing `*.integration.test.ts` files and `__tests__/integration/db-utils.ts`).

**Coverage (a partner with `settings.security.ipAllowlist = ['203.0.113.5/32']`):**
- **Hosted / Cloudflare mode** — `TRUST_PROXY_HEADERS='true'`, `TRUSTED_PROXY_CIDRS='198.51.100.10/32'`, socket peer `198.51.100.10` (trusted), `CF-Connecting-IP: 203.0.113.5` ⇒ `enforceIpAllowlist` ⇒ `allow`. Same peer, `CF-Connecting-IP: 198.51.100.9` ⇒ `deny`/`not_in_list`.
- **Spoof from untrusted peer (THE guard-bite)** — same trust config, socket peer `45.66.77.88` (NOT in `TRUSTED_PROXY_CIDRS`), `CF-Connecting-IP: 203.0.113.5` (spoof of an allowlisted IP) ⇒ `deny`/`untrusted_ip`. The forged header does NOT get the attacker in. This test would PASS vacuously if the header were trusted — assert the reason is `untrusted_ip`, not `allow`.
- **Generic / no-trust mode** — `TRUST_PROXY_HEADERS='false'`, any headers ⇒ `deny`/`untrusted_ip` (allowlist configured, no trusted IP ⇒ fail closed).
- **Rate-limit evasion** — with `TRUST_PROXY_HEADERS='false'`, drive `getClientRateLimitKey` for two requests from socket peer `45.66.77.88` carrying different `X-Forwarded-For` values ⇒ identical `socket:45.66.77.88` key (attacker cannot rotate past the per-IP limit).
- **Audit** — a `untrusted_ip` deny writes an `ip_allowlist.denied` audit event with `details.reason='untrusted_ip'` and `details.clientIp=null` (no spoofed value leaks into the log).

- [ ] **Step 1-4:** RED → implement (mostly assertions over the already-fixed services) → GREEN, per TDD.

- [ ] **Step 5: Whole-PR verification gate**
```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
cd apps/api
pnpm build && pnpm typecheck
pnpm vitest run src/services/ipAllowlist.test.ts src/services/clientIp.test.ts \
  src/routes/auth/helpers.test.ts src/routes/installer.test.ts \
  src/routes/devices/provision.test.ts src/services/llm/openaiSessionManager.test.ts \
  src/middleware/ipAllowlistGuard.test.ts src/routes/auth/login.test.ts src/routes/mcpServer.test.ts \
  src/config/proxyTrustCompose.test.ts
# migration drift must be a NO-OP (this PR adds none):
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
# real-DB integration (private Postgres per the integration harness):
pnpm vitest run src/__tests__/integration/ipAllowlistTrustBoundary.integration.test.ts
```
Expected: build/typecheck clean; all unit + integration suites PASS; `db:check-drift` reports no drift (no schema change). No raw forwarded-header reader remains (Task 3 grep is empty).

- [ ] **Step 6: Commit** the integration test: `test(security): real-DB fail-closed allowlist + spoof-proof rate-limit proof across direct/CF/generic modes (SR2-16)` with the standard trailer.

- [ ] **Step 7: Release notes** — call out (a) partner IP allowlists now FAIL CLOSED when proxy trust is misconfigured/stale (a partner with an allowlist + broken `TRUSTED_PROXY_CIDRS` will be denied, not silently allowed — Q-E), and (b) self-host operators behind the bundled Caddy get real client IPs by default (Task 4). Cross-reference `#2364`'s stale-pin warning as the diagnostic.

---

## Whole-PR summary of the SR2-16 close-out

Prior hardening (`#524/#568/#1194/#2364`) already made the *resolver* refuse to trust a spoofed header from an untrusted peer. This PR closes the four residual consumer-side gaps: the allowlist now DENIES (not skips) when no trusted IP exists; the rate-limit key uses the socket peer, not a spoofable-header fingerprint; the last three raw readers route through the resolver; and the shipped self-host stack declares its trust mode so it derives a real client IP. Config + code only — no migration, no new env var, no schema.

### Critical Files for Implementation
- /Users/toddhebebrand/orca/workspaces/breeze/core-auth-hardening/apps/api/src/services/ipAllowlist.ts
- /Users/toddhebebrand/orca/workspaces/breeze/core-auth-hardening/apps/api/src/services/clientIp.ts
- /Users/toddhebebrand/orca/workspaces/breeze/core-auth-hardening/apps/api/src/routes/auth/helpers.ts
- /Users/toddhebebrand/orca/workspaces/breeze/core-auth-hardening/apps/api/src/middleware/ipAllowlistGuard.ts
- /Users/toddhebebrand/orca/workspaces/breeze/core-auth-hardening/docker-compose.yml
