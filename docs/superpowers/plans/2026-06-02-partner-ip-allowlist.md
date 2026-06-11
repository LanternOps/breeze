# Partner-level Admin IP Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the existing-but-inert `partners.settings.security.ipAllowlist` so an MSP can restrict dashboard access to specific source IPs/CIDRs, with strong lockout protection and safe behavior when client IPs can't be trusted.

**Architecture:** A pure, fully-tested IP/CIDR matcher and a pure allowlist-decision function form the core. A thin async wrapper reads the partner's allowlist (in-process cached), resolves the trusted client IP, and returns allow/deny/skip. Enforcement is wired into the shared `authMiddleware` (covers every authenticated dashboard request; agents use a separate `agentAuth` and are structurally exempt) and into the login handler (clean pre-token error). Turning the allowlist on is gated on working proxy trust; at runtime it fails open with a warning when the client IP isn't trustable.

**Tech Stack:** Hono (TypeScript), Drizzle ORM, Vitest, Zod, Astro/React (web).

**Spec:** `docs/superpowers/specs/2026-06-02-partner-ip-allowlist-design.md`

---

## File Structure

**Create:**
- `apps/api/src/services/ipMatch.ts` — pure IPv4/IPv6 single-IP + CIDR matcher; `ipMatchesAny`, `isValidIpOrCidr`.
- `apps/api/src/services/ipMatch.test.ts` — matcher unit tests.
- `apps/api/src/services/ipAllowlist.ts` — `evaluateIpAllowlist` (pure), `ipAllowlistMode`, partner-allowlist cached read + invalidation, `enforceIpAllowlist` (IO + audit).
- `apps/api/src/services/ipAllowlist.test.ts` — decision + cache unit tests.
- `apps/api/src/middleware/ipAllowlistGuard.ts` — thin `ipAllowlistGuard(c, next)` middleware (kept out of `auth.ts` so it can be unit-tested without pulling auth's dependency graph).
- `apps/api/src/middleware/ipAllowlistGuard.test.ts` — guard unit test (mocked service).

**Modify:**
- `apps/api/src/config/validate.ts` — add `IP_ALLOWLIST_ENFORCEMENT_MODE` enum.
- `apps/api/src/middleware/auth.ts` — call `enforceIpAllowlist` after auth context is set.
- `apps/api/src/routes/auth/login.ts` — login-time IP check before minting tokens.
- `apps/api/src/routes/orgs.ts` — CIDR validation refinement, enable-gate, cache invalidation, status endpoint.
- `apps/api/src/routes/orgs.test.ts` (or nearest existing partner-route test) — route tests.
- `apps/web/src/components/settings/PartnerSecurityTab.tsx` — list editor, "Add my current IP", inactive banner, validation.
- `apps/web/src/components/settings/PartnerSettingsPage.tsx` — fetch status, pass to tab, surface enable-gate / warn-confirm.
- `.env.example` and `deploy/.env.example` — document `IP_ALLOWLIST_ENFORCEMENT_MODE`.
- `apps/docs/src/content/docs/security/*` or `deploy/environment.mdx` — document the feature + proxy-trust prerequisite.

---

## Task 1: IP/CIDR matcher (`ipMatch.ts`)

**Files:**
- Create: `apps/api/src/services/ipMatch.ts`
- Test: `apps/api/src/services/ipMatch.test.ts`

The existing matcher in `clientIp.ts` is IPv4-only. This builds a self-contained v4+v6 matcher using BigInt so the allowlist supports both families. Pure functions, no IO.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/ipMatch.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ipMatchesAny, isValidIpOrCidr } from './ipMatch';

describe('ipMatchesAny — IPv4', () => {
  it('matches an exact IPv4 address', () => {
    expect(ipMatchesAny('203.0.113.10', ['203.0.113.10'])).toBe(true);
    expect(ipMatchesAny('203.0.113.11', ['203.0.113.10'])).toBe(false);
  });

  it('matches inside an IPv4 CIDR range', () => {
    expect(ipMatchesAny('10.0.5.7', ['10.0.0.0/16'])).toBe(true);
    expect(ipMatchesAny('10.1.5.7', ['10.0.0.0/16'])).toBe(false);
  });

  it('treats /0 as matching everything', () => {
    expect(ipMatchesAny('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
  });

  it('returns false for an empty list', () => {
    expect(ipMatchesAny('1.2.3.4', [])).toBe(false);
  });

  it('ignores blank/whitespace entries', () => {
    expect(ipMatchesAny('1.2.3.4', ['  ', '1.2.3.4'])).toBe(true);
  });
});

describe('ipMatchesAny — IPv6', () => {
  it('matches an exact IPv6 address regardless of compression', () => {
    expect(ipMatchesAny('2001:db8::1', ['2001:0db8:0000:0000:0000:0000:0000:0001'])).toBe(true);
  });

  it('matches inside an IPv6 CIDR range', () => {
    expect(ipMatchesAny('2001:db8:0:0:0:0:0:abcd', ['2001:db8::/32'])).toBe(true);
    expect(ipMatchesAny('2001:db9::1', ['2001:db8::/32'])).toBe(false);
  });

  it('does not cross address families', () => {
    expect(ipMatchesAny('203.0.113.10', ['2001:db8::/32'])).toBe(false);
    expect(ipMatchesAny('2001:db8::1', ['10.0.0.0/8'])).toBe(false);
  });
});

describe('isValidIpOrCidr', () => {
  it('accepts valid IPv4, IPv6, and CIDR', () => {
    expect(isValidIpOrCidr('203.0.113.10')).toBe(true);
    expect(isValidIpOrCidr('10.0.0.0/16')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::1')).toBe(true);
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true);
  });

  it('rejects malformed entries', () => {
    expect(isValidIpOrCidr('999.1.1.1')).toBe(false);
    expect(isValidIpOrCidr('10.0.0.0/33')).toBe(false);
    expect(isValidIpOrCidr('2001:db8::/129')).toBe(false);
    expect(isValidIpOrCidr('not-an-ip')).toBe(false);
    expect(isValidIpOrCidr('')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ipMatch.test.ts`
Expected: FAIL — cannot resolve `./ipMatch`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/ipMatch.ts`:

```typescript
// Pure IPv4/IPv6 single-address and CIDR matching. No IO.
// Used by the partner IP allowlist. BigInt-based so IPv6 is supported.

function ipv4ToInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8n) | BigInt(n);
  }
  return result;
}

function ipv6ToInt(ip: string): bigint | null {
  let s = ip;
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // strip zone id

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const expand = (segment: string): string[] | null => {
    if (!segment) return [];
    const out: string[] = [];
    for (const p of segment.split(':')) {
      if (p.includes('.')) {
        // embedded IPv4 (e.g. ::ffff:1.2.3.4)
        const v4 = ipv4ToInt(p);
        if (v4 === null) return null;
        out.push(((v4 >> 16n) & 0xffffn).toString(16));
        out.push((v4 & 0xffffn).toString(16));
      } else {
        out.push(p);
      }
    }
    return out;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (head === null || tail === null) return null;

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

function isV6(s: string): boolean {
  return s.includes(':');
}

function matchOne(ip: string, entry: string): boolean {
  const slash = entry.indexOf('/');
  const network = slash === -1 ? entry : entry.slice(0, slash);
  const entryIsV6 = isV6(network);
  if (entryIsV6 !== isV6(ip)) return false; // never cross families

  const toInt = entryIsV6 ? ipv6ToInt : ipv4ToInt;
  const totalBits = entryIsV6 ? 128n : 32n;
  const maxBits = entryIsV6 ? 128 : 32;

  const ipNum = toInt(ip);
  const netNum = toInt(network);
  if (ipNum === null || netNum === null) return false;

  if (slash === -1) {
    return ipNum === netNum;
  }

  const bits = Number(entry.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return false;
  const mask =
    bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << (totalBits - BigInt(bits));
  return (ipNum & mask) === (netNum & mask);
}

/** True if `ip` matches any IP or CIDR entry. Blank entries are ignored. */
export function ipMatchesAny(ip: string, entries: string[]): boolean {
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (matchOne(ip, entry)) return true;
  }
  return false;
}

/** Validates a single allowlist entry: an IPv4/IPv6 address or CIDR. */
export function isValidIpOrCidr(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  const slash = trimmed.indexOf('/');
  const network = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const v6 = isV6(network);
  const parsed = v6 ? ipv6ToInt(network) : ipv4ToInt(network);
  if (parsed === null) return false;
  if (slash === -1) return true;
  const bits = Number(trimmed.slice(slash + 1));
  const maxBits = v6 ? 128 : 32;
  return Number.isInteger(bits) && bits >= 0 && bits <= maxBits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ipMatch.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ipMatch.ts apps/api/src/services/ipMatch.test.ts
git commit -m "feat(api): IPv4/IPv6 IP+CIDR matcher for allowlist"
```

---

## Task 2: Allowlist decision + enforcement service (`ipAllowlist.ts`)

**Files:**
- Create: `apps/api/src/services/ipAllowlist.ts`
- Test: `apps/api/src/services/ipAllowlist.test.ts`

`evaluateIpAllowlist` is pure (heavily unit-tested). `readPartnerAllowlist` reads `partners.settings.security.ipAllowlist` with a 30s in-process cache. `enforceIpAllowlist` ties it together and emits audit on deny / platform-admin bypass.

- [ ] **Step 1: Write the failing test for the pure decision function**

Create `apps/api/src/services/ipAllowlist.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateIpAllowlist } from './ipAllowlist';

describe('evaluateIpAllowlist', () => {
  const base = {
    mode: 'enforce' as const,
    allowlist: ['203.0.113.0/24'],
    clientIp: '203.0.113.10' as string | undefined,
    isPlatformAdmin: false,
  };

  it('allows when the client IP matches', () => {
    expect(evaluateIpAllowlist(base)).toEqual({ decision: 'allow' });
  });

  it('denies when the client IP does not match', () => {
    expect(evaluateIpAllowlist({ ...base, clientIp: '198.51.100.1' })).toEqual({
      decision: 'deny',
      reason: 'not_in_list',
    });
  });

  it('skips when mode is off', () => {
    expect(evaluateIpAllowlist({ ...base, mode: 'off', clientIp: '198.51.100.1' })).toEqual({
      decision: 'skip',
      reason: 'mode_off',
    });
  });

  it('skips when the allowlist is empty or undefined', () => {
    expect(evaluateIpAllowlist({ ...base, allowlist: [] })).toEqual({ decision: 'skip', reason: 'empty_list' });
    expect(evaluateIpAllowlist({ ...base, allowlist: undefined })).toEqual({ decision: 'skip', reason: 'empty_list' });
  });

  it('skips (fail-open) when the client IP is not trustable', () => {
    expect(evaluateIpAllowlist({ ...base, clientIp: undefined })).toEqual({
      decision: 'skip',
      reason: 'untrusted_ip',
    });
  });

  it('skips for platform admins (break-glass), even on a non-matching IP', () => {
    expect(evaluateIpAllowlist({ ...base, clientIp: '198.51.100.1', isPlatformAdmin: true })).toEqual({
      decision: 'skip',
      reason: 'platform_admin',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ipAllowlist.test.ts`
Expected: FAIL — cannot resolve `./ipAllowlist`.

- [ ] **Step 3: Write the service (pure decision + helpers)**

Create `apps/api/src/services/ipAllowlist.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema/orgs';
import { ipMatchesAny } from './ipMatch';
import { getTrustedClientIpOrUndefined } from './clientIp';
import { writeAuditEvent, type RequestLike } from './auditEvents';

export type IpAllowlistMode = 'enforce' | 'off';

export type IpAllowlistDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'not_in_list' }
  | { decision: 'skip'; reason: 'mode_off' | 'empty_list' | 'untrusted_ip' | 'platform_admin' };

/** Pure decision. `clientIp === undefined` means the IP is not trustable. */
export function evaluateIpAllowlist(params: {
  mode: IpAllowlistMode;
  allowlist: string[] | undefined;
  clientIp: string | undefined;
  isPlatformAdmin: boolean;
}): IpAllowlistDecision {
  const { mode, allowlist, clientIp, isPlatformAdmin } = params;
  if (mode === 'off') return { decision: 'skip', reason: 'mode_off' };
  if (!allowlist || allowlist.length === 0) return { decision: 'skip', reason: 'empty_list' };
  if (isPlatformAdmin) return { decision: 'skip', reason: 'platform_admin' };
  if (clientIp === undefined) return { decision: 'skip', reason: 'untrusted_ip' };
  return ipMatchesAny(clientIp, allowlist)
    ? { decision: 'allow' }
    : { decision: 'deny', reason: 'not_in_list' };
}

/** Reads the global enforcement mode from env (mirrors clientIp.ts env reads). */
export function ipAllowlistMode(): IpAllowlistMode {
  return process.env.IP_ALLOWLIST_ENFORCEMENT_MODE === 'off' ? 'off' : 'enforce';
}

// --- Per-partner allowlist read with a short in-process cache -----------------
// Trade-off (per spec): a change propagates to other API instances within the
// TTL; the writing instance invalidates immediately. The login check is always
// immediate because it reads fresh below only on a cache miss.

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: string[]; expiresAt: number }>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export async function readPartnerAllowlist(partnerId: string): Promise<string[]> {
  const now = Date.now();
  const hit = cache.get(partnerId);
  if (hit && hit.expiresAt > now) return hit.value;

  const [row] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const security = asRecord(asRecord(row?.settings).security);
  const raw = security.ipAllowlist;
  const value = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];

  cache.set(partnerId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

export function clearPartnerAllowlistCache(partnerId: string): void {
  cache.delete(partnerId);
}

/**
 * Full enforcement for a request. Reads mode, allowlist, and trusted client IP,
 * evaluates, and writes audit on deny / platform-admin bypass. Returns the
 * decision so the caller can respond (middleware throws 403; login returns 403).
 */
export async function enforceIpAllowlist(
  c: RequestLike,
  params: { partnerId: string | null; isPlatformAdmin: boolean; actorId?: string | null; actorEmail?: string | null },
): Promise<IpAllowlistDecision> {
  if (!params.partnerId) return { decision: 'skip', reason: 'empty_list' };

  const mode = ipAllowlistMode();
  const allowlist = mode === 'off' ? [] : await readPartnerAllowlist(params.partnerId);
  const clientIp = getTrustedClientIpOrUndefined(c);

  const decision = evaluateIpAllowlist({
    mode,
    allowlist,
    clientIp,
    isPlatformAdmin: params.isPlatformAdmin,
  });

  if (decision.decision === 'deny') {
    writeAuditEvent(c, {
      orgId: null,
      action: 'ip_allowlist.denied',
      resourceType: 'partner',
      resourceId: params.partnerId,
      result: 'denied',
      actorType: 'user',
      actorId: params.actorId ?? null,
      actorEmail: params.actorEmail ?? undefined,
      details: { clientIp: clientIp ?? null },
    });
  } else if (decision.decision === 'skip' && decision.reason === 'platform_admin') {
    writeAuditEvent(c, {
      orgId: null,
      action: 'ip_allowlist.bypass_platform_admin',
      resourceType: 'partner',
      resourceId: params.partnerId,
      result: 'success',
      actorType: 'user',
      actorId: params.actorId ?? null,
      actorEmail: params.actorEmail ?? undefined,
      details: { clientIp: clientIp ?? null },
    });
  } else if (decision.decision === 'skip' && decision.reason === 'untrusted_ip') {
    console.warn(
      `[ipAllowlist] configured but inactive: client IP not trusted for partner ${params.partnerId}`,
    );
  }

  return decision;
}
```

- [ ] **Step 4: Run the pure-function test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ipAllowlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a cache test**

Append to `apps/api/src/services/ipAllowlist.test.ts`:

```typescript
import { readPartnerAllowlist, clearPartnerAllowlistCache } from './ipAllowlist';

vi.mock('../db', () => {
  const limit = vi.fn();
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
      __limit: limit,
    },
  };
});

describe('readPartnerAllowlist caching', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let limit: any;
  beforeEach(async () => {
    const mod = await import('../db');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    limit = (mod.db as any).__limit;
    limit.mockReset();
    clearPartnerAllowlistCache('p1');
  });

  it('caches the result and serves the second call without a DB read', async () => {
    limit.mockResolvedValueOnce([{ settings: { security: { ipAllowlist: ['10.0.0.0/8'] } } }]);
    expect(await readPartnerAllowlist('p1')).toEqual(['10.0.0.0/8']);
    expect(await readPartnerAllowlist('p1')).toEqual(['10.0.0.0/8']);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('returns [] when no allowlist is set', async () => {
    limit.mockResolvedValueOnce([{ settings: {} }]);
    expect(await readPartnerAllowlist('p1')).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the full service test**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ipAllowlist.test.ts`
Expected: PASS. If the `db` schema import path (`../db/schema/orgs`) or `auditEvents` `RequestLike` export differs, fix the import to match the verbatim paths used in `apps/api/src/routes/orgs.ts` and `apps/api/src/services/clientIp.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/ipAllowlist.ts apps/api/src/services/ipAllowlist.test.ts
git commit -m "feat(api): partner IP allowlist decision + cached enforcement service"
```

---

## Task 3: Config env var (`IP_ALLOWLIST_ENFORCEMENT_MODE`)

**Files:**
- Modify: `apps/api/src/config/validate.ts`
- Modify: `.env.example`, `deploy/.env.example`

- [ ] **Step 1: Add the enum to the schema**

In `apps/api/src/config/validate.ts`, next to the other enum env vars (e.g. near `MCP_LLM_PROVIDER`), add:

```typescript
  IP_ALLOWLIST_ENFORCEMENT_MODE: z.enum(['enforce', 'off']).default('enforce'),
```

- [ ] **Step 2: Verify type-check passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit`
Expected: no NEW errors (pre-existing test-file errors in `agents.test.ts` / `apiKeyAuth.test.ts` are unrelated, per repo notes).

- [ ] **Step 3: Document it in both env examples**

Add to `.env.example` and `deploy/.env.example`, near the `TRUST_PROXY_HEADERS` / `TRUSTED_PROXY_CIDRS` block:

```bash
# --------------------------------------------
# Admin IP allowlist (partner-level)
# --------------------------------------------
# Break-glass switch for the partner dashboard IP allowlist. Default 'enforce'.
# Set to 'off' to globally disable enforcement (e.g. if an allowlist locks
# everyone out). The allowlist only acts when a partner has configured one AND
# the API can see real client IPs (requires TRUST_PROXY_HEADERS + TRUSTED_PROXY_CIDRS).
IP_ALLOWLIST_ENFORCEMENT_MODE=enforce
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/config/validate.ts .env.example deploy/.env.example
git commit -m "feat(api): IP_ALLOWLIST_ENFORCEMENT_MODE config + env docs"
```

---

## Task 4: Per-request enforcement guard + wire into `authMiddleware`

**Files:**
- Create: `apps/api/src/middleware/ipAllowlistGuard.ts`
- Test: `apps/api/src/middleware/ipAllowlistGuard.test.ts`
- Modify: `apps/api/src/middleware/auth.ts`

The shared `authMiddleware` already resolves `partnerId` and `isPlatformAdmin` and calls `c.set('auth', {...})` near line 436. The guard lives in its own small module (so it's unit-testable without importing auth's dependency graph) and is invoked from `authMiddleware` after the auth context is set. Agent routes use `agentAuth`, not this middleware, so they are unaffected.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/ipAllowlistGuard.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Mock the enforcement service so we control the decision.
const enforceMock = vi.fn();
vi.mock('../services/ipAllowlist', () => ({
  enforceIpAllowlist: (...args: unknown[]) => enforceMock(...args),
}));

import { ipAllowlistGuard } from './ipAllowlistGuard';

function appWithAuth(auth: Record<string, unknown>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    return ipAllowlistGuard(c, next);
  });
  app.get('/x', (c) => c.json({ ok: true }));
  return app;
}

describe('ipAllowlistGuard', () => {
  beforeEach(() => enforceMock.mockReset());

  it('passes the request through on allow', async () => {
    enforceMock.mockResolvedValue({ decision: 'allow' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(200);
  });

  it('passes the request through on skip', async () => {
    enforceMock.mockResolvedValue({ decision: 'skip', reason: 'empty_list' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(200);
  });

  it('returns 403 with ip_not_allowed on deny', async () => {
    enforceMock.mockResolvedValue({ decision: 'deny', reason: 'not_in_list' });
    const res = await appWithAuth({
      user: { id: 'u1', email: 'a@b.c', isPlatformAdmin: false },
      partnerId: 'p1',
    }).request('/x');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'ip_not_allowed' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/middleware/ipAllowlistGuard.test.ts`
Expected: FAIL — cannot resolve `./ipAllowlistGuard`.

- [ ] **Step 3a: Create the guard module**

Create `apps/api/src/middleware/ipAllowlistGuard.ts`:

```typescript
import type { Context, Next } from 'hono';
import { enforceIpAllowlist } from '../services/ipAllowlist';

/**
 * Enforces the partner IP allowlist for an already-authenticated request.
 * Assumes c.get('auth') is set. Returns a 403 on deny; otherwise calls next().
 */
export async function ipAllowlistGuard(c: Context, next: Next): Promise<void | Response> {
  const auth = c.get('auth');
  const decision = await enforceIpAllowlist(c, {
    partnerId: auth?.partnerId ?? null,
    isPlatformAdmin: auth?.user?.isPlatformAdmin === true,
    actorId: auth?.user?.id ?? null,
    actorEmail: auth?.user?.email ?? null,
  });
  if (decision.decision === 'deny') {
    return c.json({ code: 'ip_not_allowed', error: 'Access denied from this IP address' }, 403);
  }
  await next();
}
```

- [ ] **Step 3b: Call the guard from `authMiddleware`**

In `apps/api/src/middleware/auth.ts`, add the import near the top:

```typescript
import { ipAllowlistGuard } from './ipAllowlistGuard';
```

In `authMiddleware`, find the end where it currently does `await next();` after `c.set('auth', {...})` (around line 453-457). Replace that trailing `await next();` with:

```typescript
  // (existing) c.set('auth', { ... });

  return ipAllowlistGuard(c, next);
}
```

The guard calls `next()` on allow/skip, so behavior is preserved except that a denied IP returns 403 instead of proceeding.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/middleware/ipAllowlistGuard.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the existing auth middleware tests to confirm no regression**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/middleware/auth.test.ts`
Expected: PASS (if the file exists; otherwise skip). Then run any `*authMiddleware*` tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/middleware/ipAllowlistGuard.ts apps/api/src/middleware/ipAllowlistGuard.test.ts apps/api/src/middleware/auth.ts
git commit -m "feat(api): enforce partner IP allowlist in authMiddleware"
```

---

## Task 5: Login-time check

**Files:**
- Modify: `apps/api/src/routes/auth/login.ts`
- Test: add a case to the nearest existing login test (`apps/api/src/routes/auth/login.test.ts` if present; otherwise create it).

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/auth/login.test.ts` (create if missing, mirroring an existing auth route test's mock setup). The key assertion:

```typescript
it('returns 403 ip_not_allowed when the login IP is outside the partner allowlist', async () => {
  // Arrange: a valid user whose partner has an allowlist that excludes the request IP,
  // with proxy trust resolving a client IP not in the list.
  // (Reuse this file's existing harness for building a login request + mocked user lookup.)
  vi.mocked(enforceIpAllowlist).mockResolvedValueOnce({ decision: 'deny', reason: 'not_in_list' });

  const res = await postLogin({ email: 'admin@msp.com', password: 'correct-horse' });

  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'ip_not_allowed' });
});
```

Add the mock near the top of the test file:

```typescript
import { enforceIpAllowlist } from '../../services/ipAllowlist';
vi.mock('../../services/ipAllowlist', () => ({ enforceIpAllowlist: vi.fn() }));
```

For all other login tests in the file, default the mock to allow in `beforeEach`:

```typescript
beforeEach(() => {
  vi.mocked(enforceIpAllowlist).mockResolvedValue({ decision: 'allow' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/auth/login.test.ts`
Expected: FAIL — login still returns 200/401, not 403.

- [ ] **Step 3: Insert the check in `login.ts`**

In `apps/api/src/routes/auth/login.ts`, add the import:

```typescript
import { enforceIpAllowlist } from '../../services/ipAllowlist';
```

After `context = await resolveCurrentUserTokenContext(user.id)` succeeds and before `createTokenPair(...)` is called (the MFA branch may sit between; place this immediately after `context` is resolved, around line 341), insert:

```typescript
  // Partner IP allowlist: block before issuing tokens so the login form shows
  // a precise error. Platform admins and untrusted-IP fail-open are handled
  // inside enforceIpAllowlist.
  const ipDecision = await enforceIpAllowlist(c, {
    partnerId: context.partnerId,
    isPlatformAdmin: user.isPlatformAdmin === true,
    actorId: user.id,
    actorEmail: user.email,
  });
  if (ipDecision.decision === 'deny') {
    void auditUserLoginFailure(c, {
      userId: user.id,
      email: user.email,
      name: user.name,
      reason: 'ip_not_allowed',
      result: 'denied',
      details: { method: 'password' },
    });
    await floorPromise;
    return c.json({ code: 'ip_not_allowed', error: 'Access denied from this IP address' }, 403);
  }
```

If `auditUserLoginFailure`'s `reason` is a constrained union that doesn't include `'ip_not_allowed'`, widen that type to add the literal (it lives near the top of the same file or in the audit helper), or omit the `auditUserLoginFailure` call and rely on the audit already emitted inside `enforceIpAllowlist`. `floorPromise` is the existing timing-floor promise used by other failure branches in this handler — reuse the same identifier.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/auth/login.test.ts`
Expected: PASS, and the other login tests still pass (allow mock).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth/login.ts apps/api/src/routes/auth/login.test.ts
git commit -m "feat(api): block login from non-allowlisted IPs before token mint"
```

---

## Task 6: Settings validation, enable-gate, cache invalidation (`orgs.ts`)

**Files:**
- Modify: `apps/api/src/routes/orgs.ts`
- Test: `apps/api/src/routes/orgs.test.ts` (or the nearest existing partner-settings route test)

- [ ] **Step 1: Write the failing tests**

Add to the partner-settings route test file:

```typescript
describe('PATCH /partners/me — ipAllowlist', () => {
  it('rejects a malformed CIDR entry with 400', async () => {
    const res = await patchPartner({ settings: { security: { ipAllowlist: ['not-an-ip'] } } });
    expect(res.status).toBe(400);
  });

  it('rejects enabling the allowlist when proxy trust is not configured (proxy_trust_required)', async () => {
    // Current partner has no allowlist (empty -> non-empty transition).
    // Request resolves NO trusted client IP (getTrustedClientIpOrUndefined -> undefined).
    const res = await patchPartner({ settings: { security: { ipAllowlist: ['203.0.113.0/24'] } } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'proxy_trust_required' });
  });

  it('accepts a valid allowlist when proxy trust is working', async () => {
    // Request resolves a trusted client IP.
    const res = await patchPartner({ settings: { security: { ipAllowlist: ['203.0.113.0/24'] } } });
    expect(res.status).toBe(200);
  });
});
```

Mock the trusted-IP resolver in this test file:

```typescript
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
vi.mock('../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn() }));
// allow case: vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');
// gate case:  vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue(undefined);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgs.test.ts -t ipAllowlist`
Expected: FAIL — malformed entries accepted; no enable-gate.

- [ ] **Step 3: Add CIDR validation to the Zod schema**

In `apps/api/src/routes/orgs.ts`, add the import:

```typescript
import { isValidIpOrCidr } from '../services/ipMatch';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { clearPartnerAllowlistCache } from '../services/ipAllowlist';
```

Replace the `ipAllowlist` line in `partnerSettingsSchema.security` (currently `ipAllowlist: z.array(z.string()).optional(),`) with:

```typescript
    ipAllowlist: z
      .array(z.string())
      .optional()
      .refine(
        (list) => !list || list.every((entry) => isValidIpOrCidr(entry)),
        { message: 'Each IP allowlist entry must be a valid IP address or CIDR range' },
      ),
```

- [ ] **Step 4: Add the enable-gate and cache invalidation to the PATCH handler**

In the `PATCH /partners/me` handler, after `current` is fetched and `newSettings` is computed, before the `db.update(...)`:

```typescript
    // Enable-gate: turning the allowlist on (empty -> non-empty) requires that
    // the API can actually see real client IPs, otherwise enforcement would
    // silently fail open (false security).
    const prevAllowlist = ((((current.settings as Record<string, unknown>)?.security) as Record<string, unknown>)?.ipAllowlist) as string[] | undefined;
    const nextAllowlist = ((newSettings.security as Record<string, unknown>)?.ipAllowlist) as string[] | undefined;
    const turningOn = (!prevAllowlist || prevAllowlist.length === 0) && Array.isArray(nextAllowlist) && nextAllowlist.length > 0;
    if (turningOn && getTrustedClientIpOrUndefined(c) === undefined) {
      return c.json(
        {
          code: 'proxy_trust_required',
          error:
            'Configure proxy trust (TRUST_PROXY_HEADERS + TRUSTED_PROXY_CIDRS) before enabling the IP allowlist, so the API can see real client IPs.',
        },
        400,
      );
    }
```

After the successful `db.update(...).returning()` and existing `clearPartnerScopePolicyCache(partner.id)` call, add:

```typescript
  clearPartnerAllowlistCache(partner.id);
```

The existing `writeRouteAudit(c, { action: 'partner.settings.update', ... })` already records the change; no new audit call is needed here.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgs.test.ts -t ipAllowlist`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(api): validate IP allowlist entries + enable-gate on proxy trust"
```

---

## Task 7: Status endpoint (`GET /partners/me/ip-allowlist/status`)

**Files:**
- Modify: `apps/api/src/routes/orgs.ts`
- Test: `apps/api/src/routes/orgs.test.ts`

Drives the "Add my current IP" button and the inactive banner.

- [ ] **Step 1: Write the failing test**

```typescript
describe('GET /partners/me/ip-allowlist/status', () => {
  it('reports the current trusted IP and active=false when not enforced', async () => {
    vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');
    // partner has no allowlist
    const res = await getStatus();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      currentIp: '203.0.113.10',
      proxyTrustOk: true,
      enforced: false,
      active: false,
    });
  });

  it('reports active=true when an allowlist is set and the IP is trusted', async () => {
    vi.mocked(getTrustedClientIpOrUndefined).mockReturnValue('203.0.113.10');
    // partner has ['203.0.113.0/24']
    const res = await getStatus();
    expect(await res.json()).toMatchObject({ enforced: true, proxyTrustOk: true, active: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgs.test.ts -t "ip-allowlist/status"`
Expected: FAIL — route 404s.

- [ ] **Step 3: Add the route**

In `apps/api/src/routes/orgs.ts`, add the import (if not already added in Task 6):

```typescript
import { ipAllowlistMode, readPartnerAllowlist } from '../services/ipAllowlist';
```

Add next to the other `/partners/me` routes:

```typescript
orgRoutes.get('/partners/me/ip-allowlist/status', requireScope('partner'), requirePartner, requireOrgRead, async (c) => {
  const auth = c.get('auth');
  const partnerId = auth.partnerId as string;

  const currentIp = getTrustedClientIpOrUndefined(c) ?? null;
  const allowlist = await readPartnerAllowlist(partnerId);
  const enforced = ipAllowlistMode() === 'enforce' && allowlist.length > 0;
  const proxyTrustOk = currentIp !== null;

  return c.json({
    currentIp,
    proxyTrustOk,
    enforced,
    active: enforced && proxyTrustOk,
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/orgs.test.ts -t "ip-allowlist/status"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(api): partner IP allowlist status endpoint"
```

---

## Task 8: Web UI (`PartnerSecurityTab` + `PartnerSettingsPage`)

**Files:**
- Modify: `apps/web/src/components/settings/PartnerSecurityTab.tsx`
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx`
- Test: `apps/web/src/components/settings/PartnerSecurityTab.test.tsx`

Adds a one-click "Add my current IP", an inactive banner, and inline validation. The save flow already goes through `runPartnerSave` → `runAction`, so the `proxy_trust_required` error surfaces as a toast automatically; we add an explicit warn/confirm when the admin's own IP isn't covered.

- [ ] **Step 1: Write a failing test for the entry parser/validator**

Create `apps/web/src/components/settings/PartnerSecurityTab.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseAllowlistInput, currentIpCovered } from './PartnerSecurityTab';

describe('parseAllowlistInput', () => {
  it('splits lines, trims, and drops blanks', () => {
    expect(parseAllowlistInput('203.0.113.0/24\n  \n10.0.0.1')).toEqual(['203.0.113.0/24', '10.0.0.1']);
  });
});

describe('currentIpCovered', () => {
  it('is true when the current IP is inside a listed range', () => {
    expect(currentIpCovered('203.0.113.10', ['203.0.113.0/24'])).toBe(true);
  });
  it('is false when not covered', () => {
    expect(currentIpCovered('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
  });
  it('is true (no false lockout warning) when current IP is unknown', () => {
    expect(currentIpCovered(null, ['203.0.113.0/24'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/PartnerSecurityTab.test.tsx`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Add the helpers + UI to `PartnerSecurityTab.tsx`**

At the top of `apps/web/src/components/settings/PartnerSecurityTab.tsx`, add exported helpers (the web bundle can import the shared matcher; if `@breeze/shared` does not already export an IP matcher, inline a minimal client check that mirrors `isValidIpOrCidr` for IPv4/CIDR and exact IPv6 — validation is also enforced server-side, so the client check is advisory):

```typescript
export function parseAllowlistInput(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Advisory client-side coverage check for the lockout warning. Returns true
// (no warning) when the current IP is unknown, so we never block on uncertainty.
export function currentIpCovered(currentIp: string | null, list: string[]): boolean {
  if (!currentIp) return true;
  // Exact match is enough for the warning; server enforces real CIDR logic.
  if (list.includes(currentIp)) return true;
  // Lightweight IPv4 /24-and-up CIDR check for the common case.
  return list.some((entry) => {
    const [net, bitsRaw] = entry.split('/');
    const bits = Number(bitsRaw);
    if (!net.includes('.') || !Number.isInteger(bits)) return entry === currentIp;
    const toInt = (ip: string) => ip.split('.').reduce((a, p) => (a << 8) + Number(p), 0) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(net) & mask) === (toInt(currentIp) & mask);
  });
}
```

Add props for status + a status fetch. Extend the component `Props`:

```typescript
type Props = {
  data: InheritableSecuritySettings;
  onChange: (data: InheritableSecuritySettings) => void;
  status?: { currentIp: string | null; proxyTrustOk: boolean; enforced: boolean; active: boolean } | null;
};
```

Replace the existing IP Allowlist `<textarea>` block with one that includes the banner and the "Add my current IP" button:

```tsx
      <div className="space-y-2">
        <label className="text-sm font-medium">IP Allowlist</label>

        {status && status.enforced && !status.active && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
            Allowlist configured but <strong>inactive</strong> — the API isn’t seeing real client IPs.
            Configure proxy trust (TRUST_PROXY_HEADERS + TRUSTED_PROXY_CIDRS) for it to take effect.
          </div>
        )}

        <textarea
          value={(data.ipAllowlist ?? []).join('\n')}
          onChange={(e) => {
            const lines = parseAllowlistInput(e.target.value);
            set({ ipAllowlist: lines.length > 0 ? lines : undefined });
          }}
          rows={4}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Enter one IP or CIDR range per line. Leave blank to let each org decide."
        />

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Leave blank to let each organization configure individually. Use CIDR notation for ranges.
          </p>
          {status?.currentIp && (
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => {
                const list = data.ipAllowlist ?? [];
                if (!list.includes(status.currentIp as string)) {
                  set({ ipAllowlist: [...list, status.currentIp as string] });
                }
              }}
            >
              Add my current IP ({status.currentIp})
            </button>
          )}
        </div>
      </div>
```

- [ ] **Step 4: Wire status fetch + warn/confirm into `PartnerSettingsPage.tsx`**

In `apps/web/src/components/settings/PartnerSettingsPage.tsx`:

1. Fetch the status on mount and pass it to `PartnerSecurityTab`:

```typescript
const [ipStatus, setIpStatus] = useState<null | { currentIp: string | null; proxyTrustOk: boolean; enforced: boolean; active: boolean }>(null);

useEffect(() => {
  fetchWithAuth('/orgs/partners/me/ip-allowlist/status')
    .then((r) => (r.ok ? r.json() : null))
    .then(setIpStatus)
    .catch(() => setIpStatus(null));
}, []);
```

Pass `status={ipStatus}` where `<PartnerSecurityTab ... />` is rendered.

2. Before calling `runPartnerSave` with a security payload, add the lockout confirmation:

```typescript
const nextList = (payload?.settings as any)?.security?.ipAllowlist as string[] | undefined;
if (nextList && nextList.length > 0 && ipStatus && !currentIpCovered(ipStatus.currentIp, nextList)) {
  const proceed = window.confirm(
    'Your current IP is not in this allowlist. Saving may lock you out of the dashboard. Continue?',
  );
  if (!proceed) return;
}
```

Import `currentIpCovered` from `./PartnerSecurityTab`.

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/settings/PartnerSecurityTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Type-check the web app**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/settings/PartnerSecurityTab.tsx apps/web/src/components/settings/PartnerSecurityTab.test.tsx apps/web/src/components/settings/PartnerSettingsPage.tsx
git commit -m "feat(web): IP allowlist editor — add-my-IP, inactive banner, lockout confirm"
```

---

## Task 9: Documentation

**Files:**
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (env var) and the most relevant security feature doc (e.g. `apps/docs/src/content/docs/features/security.mdx` or `security/overview` — pick whichever documents partner security settings).
- Modify: `scripts/docs-review/mapping.json`

- [ ] **Step 1: Document the env var**

In `apps/docs/src/content/docs/deploy/environment.mdx`, near the proxy-trust variables, add a row/section for `IP_ALLOWLIST_ENFORCEMENT_MODE` (values `enforce` default / `off` break-glass) and note that the allowlist requires working proxy trust.

- [ ] **Step 2: Document the feature**

Add a short "Admin IP allowlist" subsection to the partner/security feature doc: where to set it (Settings → Security → IP Allowlist), that it is partner-level, that proxy trust must be configured first (link to the Cloudflare Tunnel / environment docs), the platform-admin break-glass, and `IP_ALLOWLIST_ENFORCEMENT_MODE=off`.

- [ ] **Step 3: Update the docs-review mapping**

Add to `scripts/docs-review/mapping.json`:

```json
{ "pattern": "apps/api/src/services/ipAllowlist.ts", "docs": ["deploy/environment.mdx", "features/security.mdx"] }
```

- [ ] **Step 4: Build docs to verify**

Run: `cd apps/docs && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx astro build 2>&1 | tail -3`
Expected: build completes, page count unchanged or +0 (no new page).

- [ ] **Step 5: Commit**

```bash
git add apps/docs scripts/docs-review/mapping.json
git commit -m "docs: partner IP allowlist + IP_ALLOWLIST_ENFORCEMENT_MODE"
```

---

## Task 10: Full verification pass

- [ ] **Step 1: Run all new + adjacent API tests**

Run:
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/services/ipMatch.test.ts \
  src/services/ipAllowlist.test.ts \
  src/middleware/ipAllowlistGuard.test.ts \
  src/routes/auth/login.test.ts \
  src/routes/orgs.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Type-check API and web**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit` then the same in `apps/web`.
Expected: no new errors beyond the documented pre-existing ones.

- [ ] **Step 3: Manual smoke (optional, needs local stack + proxy trust)**

With `TRUST_PROXY_HEADERS=true` and `TRUSTED_PROXY_CIDRS` set so the API sees a real client IP:
1. Set a partner allowlist that includes your IP → dashboard still works.
2. Change it to exclude your IP via the confirm dialog → next request returns `403 ip_not_allowed`; login returns `403 ip_not_allowed`.
3. Set `IP_ALLOWLIST_ENFORCEMENT_MODE=off`, restart API → access restored (break-glass).
4. With proxy trust disabled, try to enable an allowlist → `400 proxy_trust_required`.

- [ ] **Step 4: Final review of the diff against the spec**

Confirm each spec section maps to a task (see Self-Review below). Then hand off per the executing skill.

---

## Notes for the implementer

- **Verbatim paths matter.** Before writing imports, open the real files quoted in the spec/research to confirm export names: `getTrustedClientIpOrUndefined` (`services/clientIp.ts`), `writeAuditEvent` + `RequestLike` (`services/auditEvents.ts`), `partners` (`db/schema/orgs.ts`), `db` (`db/index.ts` re-exported as `../db`). Match whatever the neighboring route/service files import.
- **Agents are exempt by construction.** Do not add the guard to any agent router or to `agentAuth`. Enforcement lives only in the shared `authMiddleware` and the login handler.
- **Do not widen scope.** Org-level and WebSocket enforcement are explicitly out of scope for v1 (see spec non-goals).
- **TDD discipline:** each task writes the test first, watches it fail, implements, watches it pass, commits.
