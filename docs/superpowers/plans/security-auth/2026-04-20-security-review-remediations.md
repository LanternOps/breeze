# Security Review Remediations — 2026-04-20

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the HIGH and priority-MEDIUM findings from the 2026-04-20 security review of `feature/device-org-move-wip`.

**Architecture:** Twelve independent, commit-sized fixes across the API, web, viewer, and agent. Each task is self-contained — one finding, one commit, one PR if desired. No shared state between tasks, so they can be parallelised.

**Tech Stack:** Hono + Zod + Drizzle + Redis (API), Vitest (API/web/viewer tests), React (web/viewer), Tauri 2 (viewer), Go (agent).

**Source of findings:** conversation dated 2026-04-20; no separate spec file.

---

## File Structure

Files touched by this plan (grouped by phase):

**Phase 1 — HIGH:**
- `apps/api/src/middleware/userRateLimit.ts` (new) — per-user sliding-window middleware factory
- `apps/api/src/routes/enrollmentKeys.ts` — apply rate limit middleware; rework public-download to use short-lived Redis handle
- `apps/api/src/routes/enrollmentKeys.test.ts` — rate limit + handle tests
- `apps/api/src/services/downloadHandle.ts` (new) — create/consume one-time handle
- `apps/api/src/services/downloadHandle.test.ts` (new)
- `apps/web/src/components/devices/AddDeviceModal.tsx` — swap direct-download link for handle-exchange POST
- `apps/web/public/scripts/SIGNING.md` (new) — doc file listing published SHA256s
- `apps/web/src/components/devices/UninstallScriptPanel.tsx` (modify or new) — surface SHA256 to the user; show verification command

**Phase 2 — quick MEDIUM:**
- `apps/api/src/routes/tunnels.ts` — add `.uuid()` validators on 6 param routes + query schema
- `apps/api/src/routes/tunnels.test.ts` — validator tests
- `apps/api/src/routes/enrollmentKeys.ts` — validate siteId against org before insert; fold expiry into atomic UPDATE
- `apps/api/src/services/installerBuilder.ts` — quote `ENROLLMENT_KEY` in `install.bat` template; validate key charset
- `apps/api/src/services/installerBuilder.test.ts` — malicious-key test
- `apps/viewer/src/lib/transports/vnc.ts` — allowlist/sanitise VNC reason strings
- `apps/viewer/src/lib/transports/vnc.test.ts`

**Phase 3 — deeper MEDIUM:**
- `apps/api/src/services/jwt.ts` — reduce VIEWER TTL, add `jti`
- `apps/api/src/services/viewerTokenRevocation.ts` (new) — Redis jti store
- `apps/api/src/services/viewerTokenRevocation.test.ts` (new)
- `apps/api/src/routes/tunnels.ts` — check revocation in `requireViewerToken`; revoke on tunnel close
- `apps/viewer/src/lib/protocol.ts` — restrict HTTP fallback to `127.0.0.1`, `localhost`, `::1`
- `apps/viewer/src/lib/protocol.test.ts`

**Phase 4 — LOW defense-in-depth:**
- `agent/internal/helper/install_linux.go` — quote `Exec=` via `%q`
- `agent/internal/helper/install_linux_test.go` (new)
- `agent/internal/helper/install_darwin.go` — XML-escape plist values via `encoding/xml`
- `agent/internal/helper/install_darwin_test.go` (new)
- `agent/internal/helper/migrate.go`, `manager.go` — tighten per-session config file permissions to `0600`

---

### Task 1: Create `userRateLimit` middleware factory

Finding #3 (HIGH). A small middleware wrapper around the existing `rateLimiter()` service, keyed per user. Reused by Tasks 2 and the viewer-token revocation later.

**Files:**
- Create: `apps/api/src/middleware/userRateLimit.ts`
- Test:   `apps/api/src/middleware/userRateLimit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/middleware/userRateLimit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from './auth';
import { userRateLimit } from './userRateLimit';

const mockRateLimiter = vi.fn();
vi.mock('../services/rate-limit', () => ({
  rateLimiter: (...args: unknown[]) => mockRateLimiter(...args),
}));
vi.mock('../services', () => ({
  getRedis: () => ({} as any),
}));

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', { user: { id: 'user-1' }, scope: 'organization' } as AuthContext);
    await next();
  });
  app.post('/write', userRateLimit('enroll-write', 10, 60), (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => mockRateLimiter.mockReset());

describe('userRateLimit', () => {
  it('allows the request when under the limit', async () => {
    mockRateLimiter.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
    const res = await makeApp().request('/write', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mockRateLimiter).toHaveBeenCalledWith(expect.anything(), 'rl:enroll-write:user-1', 10, 60);
  });

  it('returns 429 when rate-limit exceeded', async () => {
    mockRateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const res = await makeApp().request('/write', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  it('fails closed when auth context is missing (no user id)', async () => {
    const app = new Hono();
    app.post('/write', userRateLimit('enroll-write', 10, 60), (c) => c.json({ ok: true }));
    const res = await app.request('/write', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @breeze/api test -- userRateLimit
```

Expected: three failures (`Cannot find module './userRateLimit'`).

- [ ] **Step 3: Implement the middleware**

Create `apps/api/src/middleware/userRateLimit.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import type { AuthContext } from './auth';
import { getRedis } from '../services';
import { rateLimiter } from '../services/rate-limit';

/**
 * Per-user sliding-window rate limit. Must run AFTER authMiddleware.
 * Keyed on the authenticated user id so one user cannot consume another's
 * budget. Fails closed (401) if no auth context is present.
 */
export function userRateLimit(bucket: string, limit: number, windowSeconds: number): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('auth') as AuthContext | undefined;
    const userId = auth?.user?.id;
    if (!userId) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    const redis = getRedis();
    const result = await rateLimiter(redis, `rl:${bucket}:${userId}`, limit, windowSeconds);
    if (!result.allowed) {
      return c.json(
        { error: 'Rate limit exceeded', retryAfter: result.resetAt.toISOString() },
        429,
      );
    }
    await next();
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm --filter @breeze/api test -- userRateLimit
```

Expected: 3/3 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/userRateLimit.ts apps/api/src/middleware/userRateLimit.test.ts
git commit -m "feat(api): add per-user sliding-window rate limit middleware"
```

---

### Task 2: Apply rate limit to enrollment-key write routes

Finding #3 (HIGH). Wire `userRateLimit` onto the four mutation routes: create, rotate, delete, installer-link.

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts:281,389,457,728`
- Test:   `apps/api/src/routes/enrollmentKeys.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe('POST /enrollment-keys', ...)` block in `apps/api/src/routes/enrollmentKeys.test.ts` (pattern-match on how existing rate-limit tests stub Redis if any; otherwise use the `mockRateLimiter` from Task 1 test as a reference):

```ts
it('returns 429 when per-user rate limit is exceeded', async () => {
  mockRateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
  const res = await app.request('/enrollment-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${validToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test', orgId: testOrgId }),
  });
  expect(res.status).toBe(429);
});
```

(If the test file does not already mock `rate-limit`, mirror the mock setup from `userRateLimit.test.ts`.)

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @breeze/api test -- enrollmentKeys
```

Expected: the new test fails with `200` instead of `429`.

- [ ] **Step 3: Add the middleware to each write route**

At the top of `apps/api/src/routes/enrollmentKeys.ts`, add the import:

```ts
import { userRateLimit } from '../middleware/userRateLimit';
```

At the four call sites — line 281 (POST `/`), line 389 (POST `/:id/rotate`), line 457 (DELETE `/:id`), line 728 (POST `/:id/installer-link`) — insert `userRateLimit('enroll-write', 10, 60),` *before* `requireMfa()`:

```ts
enrollmentKeyRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-write', 10, 60),
  requireMfa(),
  zValidator('json', createEnrollmentKeySchema),
  async (c) => { /* ... */ },
);
```

Repeat for the other three routes.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
pnpm --filter @breeze/api test -- enrollmentKeys
```

Expected: all tests pass, including the new 429 test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "feat(api): rate-limit enrollment-key write routes per user (10/min)"
```

---

### Task 3: Replace public-download `?token=` with one-time handle

Finding #2 (HIGH). Instead of `/enrollment-keys/public-download/windows?token=<raw-key>`, the web UI exchanges the enrollment key for a short-lived opaque handle via a POST, then navigates to `/enrollment-keys/public-download/windows?h=<handle>`. The handle is stored in Redis with a 5-minute TTL and is single-use.

**Files:**
- Create: `apps/api/src/services/downloadHandle.ts`
- Create: `apps/api/src/services/downloadHandle.test.ts`
- Modify: `apps/api/src/routes/enrollmentKeys.ts` (public-download handler + new POST `/:id/download-handle`)
- Modify: `apps/web/src/components/devices/AddDeviceModal.tsx` (swap to handle exchange)

- [ ] **Step 1: Write the failing handle-service test**

Create `apps/api/src/services/downloadHandle.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { issueDownloadHandle, consumeDownloadHandle } from './downloadHandle';

const redisStore = new Map<string, string>();
vi.mock('./index', () => ({
  getRedis: () => ({
    set: vi.fn(async (k: string, v: string, _mode: string, _ttl: string, _ex: number) => {
      redisStore.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    del: vi.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  }),
}));

beforeEach(() => redisStore.clear());

describe('downloadHandle', () => {
  it('issues an opaque handle and consumes it once', async () => {
    const handle = await issueDownloadHandle('raw-enrollment-key');
    expect(handle).toMatch(/^dlh_[a-f0-9]{32}$/);
    const token = await consumeDownloadHandle(handle);
    expect(token).toBe('raw-enrollment-key');
    const second = await consumeDownloadHandle(handle);
    expect(second).toBeNull();
  });

  it('returns null for an unknown handle', async () => {
    expect(await consumeDownloadHandle('dlh_00000000000000000000000000000000')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @breeze/api test -- downloadHandle
```

Expected: import error (`Cannot find module`).

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/downloadHandle.ts`:

```ts
import { randomBytes } from 'crypto';
import { getRedis } from './index';

const HANDLE_TTL_SECONDS = 300; // 5 minutes
const PREFIX = 'dlh_';

export async function issueDownloadHandle(rawEnrollmentKey: string): Promise<string> {
  const redis = getRedis();
  if (!redis) {
    throw new Error('Redis unavailable; cannot issue download handle');
  }
  const handle = PREFIX + randomBytes(16).toString('hex');
  await redis.set(`download-handle:${handle}`, rawEnrollmentKey, 'EX', HANDLE_TTL_SECONDS);
  return handle;
}

export async function consumeDownloadHandle(handle: string): Promise<string | null> {
  if (!handle.startsWith(PREFIX)) return null;
  const redis = getRedis();
  if (!redis) return null;
  const key = `download-handle:${handle}`;
  const value = await redis.get(key);
  if (!value) return null;
  await redis.del(key); // single-use
  return value;
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
pnpm --filter @breeze/api test -- downloadHandle
```

Expected: 2/2 pass.

- [ ] **Step 5: Add POST `/:id/download-handle` route**

In `apps/api/src/routes/enrollmentKeys.ts`, add a new route *after* the existing installer-link handler (around line 820). This route issues a handle for an already-validated enrollment key:

```ts
// POST /enrollment-keys/:id/download-handle - Exchange key for a one-time handle.
// Moves the raw token out of the public URL; the handle survives ~5 min and is single-use.
enrollmentKeyRoutes.post(
  '/:id/download-handle',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-handle', 30, 60),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const body = await c.req.json().catch(() => ({})) as { rawToken?: string };
    if (!body.rawToken || typeof body.rawToken !== 'string') {
      return c.json({ error: 'rawToken is required' }, 400);
    }

    // Ownership check: caller must own the key row.
    const [row] = await db.select().from(enrollmentKeys)
      .where(and(eq(enrollmentKeys.id, keyId), auth.orgCondition(enrollmentKeys.orgId)))
      .limit(1);
    if (!row) return c.json({ error: 'Not found' }, 404);

    // Verify the raw token matches the stored hash.
    if (row.key !== hashEnrollmentKey(body.rawToken)) {
      return c.json({ error: 'Invalid token' }, 400);
    }

    const { issueDownloadHandle } = await import('../services/downloadHandle');
    const handle = await issueDownloadHandle(body.rawToken);
    return c.json({ handle });
  },
);
```

- [ ] **Step 6: Modify public-download to accept `h=` OR `token=` (back-compat)**

In the existing public-download handler (around line 1020), accept either a `handle` or legacy `token`. Prefer the handle. Deprecate the token path with a log line (remove in a later PR once the UI has shipped).

Replace the current query schema and handler entry block:

```ts
const publicDownloadQuerySchema = z.object({
  h: z.string().regex(/^dlh_[a-f0-9]{32}$/).optional(),
  token: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((v) => v.h || v.token, { message: 'h or token is required' });

// ...inside handler:
const { h, token } = c.req.valid('query');
let rawToken: string | null = null;
if (h) {
  const { consumeDownloadHandle } = await import('../services/downloadHandle');
  rawToken = await consumeDownloadHandle(h);
} else if (token) {
  console.warn('[enrollmentKeys] public-download used legacy ?token= path; expected ?h=');
  rawToken = token;
}
if (!rawToken) {
  return c.json({ error: 'Invalid or expired download link' }, 404);
}

const keyHash = hashEnrollmentKey(rawToken);
// ...existing logic continues...
```

- [ ] **Step 7: Update the web UI to exchange the token for a handle**

In `apps/web/src/components/devices/AddDeviceModal.tsx`, find the code that constructs the download URL (search for `public-download`). Replace direct navigation with a handle-exchange:

```tsx
async function downloadInstaller(keyId: string, rawToken: string, platform: 'windows' | 'macos') {
  const res = await fetchWithAuth(`/enrollment-keys/${keyId}/download-handle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rawToken }),
  });
  if (!res.ok) throw new Error('Failed to prepare download');
  const { handle } = (await res.json()) as { handle: string };
  window.location.href = `/api/v1/enrollment-keys/public-download/${platform}?h=${encodeURIComponent(handle)}`;
}
```

Replace both call sites (Windows + macOS buttons) with calls to this helper.

- [ ] **Step 8: Run tests**

```bash
pnpm --filter @breeze/api test -- enrollmentKeys
pnpm --filter @breeze/web test -- AddDeviceModal
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/downloadHandle.ts apps/api/src/services/downloadHandle.test.ts apps/api/src/routes/enrollmentKeys.ts apps/web/src/components/devices/AddDeviceModal.tsx
git commit -m "feat: replace public-download ?token= with one-time Redis handle"
```

---

### Task 4: Publish + surface SHA256 for uninstall scripts

Finding #1 (HIGH). Simplest defense: publish the SHA256 for each uninstall script in a stable, signed-commit location and surface it in the UI so users can verify before running. This does not solve the MITM-via-compromised-CDN case but closes the easy one (copy/paste without inspection).

A stronger follow-up (embedding signed scripts into the installer binary) is out of scope here — tracked separately.

**Files:**
- Create: `apps/web/public/scripts/SHA256SUMS` (auto-generated)
- Modify: `apps/web/public/scripts/uninstall-darwin.sh` (no content change; just hashed)
- Modify: `apps/web/public/scripts/uninstall-linux.sh` (no content change)
- Modify: `apps/web/src/components/devices/DeviceActions.tsx` (surface hash and verify command in UI)
- Create: `apps/web/scripts/compute-uninstall-sha256.ts` — build step that writes `SHA256SUMS`
- Modify: `package.json` at `apps/web` — add `prebuild` script

- [ ] **Step 1: Add the build-step script**

Create `apps/web/scripts/compute-uninstall-sha256.ts`:

```ts
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const dir = join(import.meta.dirname, '..', 'public', 'scripts');
const files = readdirSync(dir).filter((f) => f.startsWith('uninstall-') && f.endsWith('.sh')).sort();
const lines = files.map((f) => {
  const hash = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  return `${hash}  ${f}`;
});
writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(`Wrote SHA256SUMS for ${files.length} file(s)`);
```

- [ ] **Step 2: Add prebuild hook**

In `apps/web/package.json`, add to `scripts`:

```json
"prebuild": "tsx scripts/compute-uninstall-sha256.ts",
"presync:scripts": "tsx scripts/compute-uninstall-sha256.ts"
```

Run it once now:

```bash
cd apps/web && pnpm prebuild
```

Verify `apps/web/public/scripts/SHA256SUMS` now exists and contains two lines.

- [ ] **Step 3: Surface the hash in the uninstall UI**

In `apps/web/src/components/devices/DeviceActions.tsx`, locate the uninstall-script block (search `uninstall-`). Add a verification hint alongside the download link:

```tsx
const SHA256_URL = '/scripts/SHA256SUMS';
const [sha256s, setSha256s] = useState<Record<string, string>>({});
useEffect(() => {
  fetch(SHA256_URL).then((r) => r.text()).then((t) => {
    const map: Record<string, string> = {};
    for (const line of t.trim().split('\n')) {
      const [hash, name] = line.split(/\s+/, 2);
      if (hash && name) map[name] = hash;
    }
    setSha256s(map);
  }).catch(() => {});
}, []);

// In render, under each download link:
const scriptName = platform === 'darwin' ? 'uninstall-darwin.sh' : 'uninstall-linux.sh';
const expected = sha256s[scriptName];
{expected && (
  <div className="text-xs text-muted mt-1 font-mono">
    SHA256: {expected}
    <br />
    Verify before running:{' '}
    <code>shasum -a 256 {scriptName}</code>
  </div>
)}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/scripts/compute-uninstall-sha256.ts apps/web/package.json apps/web/public/scripts/SHA256SUMS apps/web/src/components/devices/DeviceActions.tsx
git commit -m "feat(web): publish SHA256 for uninstall scripts and surface in UI"
```

---

### Task 5: UUID validators on `tunnels.ts` path/query params

Finding #5, #6 (MEDIUM). Six routes consume `:id` via `c.req.param('id')!` and one query reads `siteId` without a schema. Add `zValidator('param', …)` and `zValidator('query', …)` so Zod rejects malformed input before it reaches the DB.

**Files:**
- Modify: `apps/api/src/routes/tunnels.ts`
- Test:   `apps/api/src/routes/tunnels.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/tunnels.test.ts`:

```ts
describe('tunnels param validation', () => {
  it('returns 400 on malformed :id', async () => {
    const res = await app.request('/tunnels/not-a-uuid', {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 on malformed siteId query', async () => {
    const res = await app.request('/tunnels?siteId=not-a-uuid', {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm --filter @breeze/api test -- tunnels
```

Expected: the new tests fail (most likely 404 or 500 instead of 400).

- [ ] **Step 3: Add the schemas**

At the top of `apps/api/src/routes/tunnels.ts` (near the existing schema block around line 35):

```ts
const idParamSchema = z.object({ id: z.string().uuid() });
const listQuerySchema = z.object({ siteId: z.string().uuid().optional() });
const allowlistIdParamSchema = idParamSchema;
```

- [ ] **Step 4: Apply to each route**

For the six routes that use `:id` (lines 306, 336, 386, 422, 538, 577) and the list route that reads `siteId` (line ~484), insert the validator between `requireScope()` and the async handler:

```ts
tunnelRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    // ...existing body, replacing c.req.param('id')! with the destructured id
  },
);
```

Repeat for DELETE `/:id`, POST `/:id/ws-ticket`, and the two allowlist routes. For the list route:

```ts
tunnelRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listQuerySchema),
  async (c) => {
    const { siteId } = c.req.valid('query');
    // ...
  },
);
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
pnpm --filter @breeze/api test -- tunnels
```

Expected: new tests pass; existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/tunnels.ts apps/api/src/routes/tunnels.test.ts
git commit -m "fix(api): validate tunnels :id params and siteId query as UUIDs"
```

---

### Task 6: Validate `siteId` ownership on enrollment-key create

Finding #10 (MEDIUM). `createEnrollmentKeySchema` allows `siteId` to be passed, but the create handler never verifies the site belongs to the target `orgId`. An org-scoped partner user could label a key with a site from a different org (or nonexistent).

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts` (POST `/`, around line 281)
- Test:   `apps/api/src/routes/enrollmentKeys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects siteId that does not belong to the target org', async () => {
  const res = await app.request('/enrollment-keys', {
    method: 'POST',
    headers: { Authorization: `Bearer ${validToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bad', orgId: testOrgId, siteId: otherOrgSiteId }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: /site/i });
});
```

Ensure `otherOrgSiteId` is seeded in test setup (a site that belongs to a different org than `testOrgId`).

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @breeze/api test -- enrollmentKeys
```

- [ ] **Step 3: Add the ownership check**

Inside the POST `/` handler, after `orgId` is finalised and *before* the insert:

```ts
if (data.siteId) {
  const [site] = await db.select({ id: sites.id })
    .from(sites)
    .where(and(eq(sites.id, data.siteId), eq(sites.orgId, orgId)))
    .limit(1);
  if (!site) {
    return c.json({ error: 'siteId does not belong to the specified org' }, 400);
  }
}
```

(Add `sites` to the schema imports if not already present.)

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm --filter @breeze/api test -- enrollmentKeys
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "fix(api): verify siteId belongs to target org on enrollment-key create"
```

---

### Task 7: Fold expiry into atomic usage-count UPDATE (short-link)

Finding #12 (MEDIUM). After the parent-row expiry check, the atomic UPDATE that bumps `usageCount` has no expiry guard. If the row expires between the check and the UPDATE, the slot is spent on an expired row and the child key is already inserted.

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts:1114-1125`

- [ ] **Step 1: Write the failing test (time-travel)**

Append to `apps/api/src/routes/enrollmentKeys.test.ts` a test using a seeded row whose `expiresAt` is 1 ms in the past *but* was in the future when the handler read the row. Easiest approximation: seed a row with `expiresAt = new Date(Date.now() + 50)`, call the short-link route, assert behaviour after the 50ms window.

Since this race is hard to hit deterministically, the more practical test is a regression assertion: seeding an already-expired row must not allow a child-key insert.

```ts
it('does not spawn a child key for an already-expired short-link parent', async () => {
  const expiredShort = await seedShortLinkRow({ expiresAt: new Date(Date.now() - 1000) });
  const res = await app.request(`/${expiredShort.shortCode}`); // publicShortLinkRoutes base path
  expect(res.status).toBe(410);
  const children = await db.select().from(enrollmentKeys).where(eq(enrollmentKeys.orgId, expiredShort.orgId));
  expect(children.filter((c) => c.name.includes('short-link download'))).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to confirm it fails**

Expected: the current code *does* spawn and then delete a child (visible as temporary row or error), and may return 410 but after an insert/delete round-trip. The test asserts *no* child key exists permanently.

Note: with current logic, the child is deleted on line 1129, so this test may already pass in steady state. The real fix is structural: move the child insert *after* the atomic claim.

- [ ] **Step 3: Refactor to claim-first-then-insert**

Replace the block at lines 1090-1133 with:

```ts
// Atomic claim: decrement usage budget with a combined WHERE that
// includes the expiry check. If this matches zero rows, we return 410
// without ever inserting a child key.
const claim = await db
  .update(enrollmentKeys)
  .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
  .where(
    and(
      eq(enrollmentKeys.id, row.id),
      row.maxUsage !== null
        ? lt(enrollmentKeys.usageCount, row.maxUsage)
        : sql`true`,
      or(
        isNull(enrollmentKeys.expiresAt),
        sql`${enrollmentKeys.expiresAt} > NOW()`,
      ),
    ),
  )
  .returning({ id: enrollmentKeys.id });

if (claim.length === 0) {
  return c.json({ error: 'This link has expired or reached its maximum usage limit.' }, 410);
}

// Only now create the child key — no cleanup needed on failure.
const rawToken = generateEnrollmentKey();
const tokenHash = hashEnrollmentKey(rawToken);
const [downloadKey] = await db
  .insert(enrollmentKeys)
  .values({
    orgId: row.orgId,
    siteId: row.siteId,
    name: `${row.name} (short-link download)`,
    key: tokenHash,
    keySecretHash: row.keySecretHash,
    maxUsage: 1,
    expiresAt: freshChildExpiresAt(),
    createdBy: null,
    installerPlatform: row.installerPlatform,
  })
  .returning();

if (!downloadKey) {
  // Very unlikely — the claim succeeded so storage is reachable.
  return c.json({ error: 'Failed to prepare installer' }, 500);
}

return serveInstaller(c, downloadKey, row.installerPlatform, rawToken, true);
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm --filter @breeze/api test -- enrollmentKeys
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "fix(api): claim short-link usage atomically before spawning child key"
```

---

### Task 8: Quote and validate `ENROLLMENT_KEY` in install.bat template

Finding #7 (MEDIUM). Today the format-enforced `brz_*` hex prevents exploit, but the batch template relies on implicit assumptions. Fail-closed: validate key charset at template-fill time and quote.

**Files:**
- Modify: `apps/api/src/services/installerBuilder.ts`
- Test:   `apps/api/src/services/installerBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects an enrollment key with shell-meaningful characters', async () => {
  await expect(
    buildWindowsInstallerZip({ enrollmentKey: 'brz_abc\nrm -rf /', /* ...rest */ } as any),
  ).rejects.toThrow(/invalid enrollment key/i);
});

it('quotes ENROLLMENT_KEY in install.bat', async () => {
  const zip = await buildWindowsInstallerZip({ enrollmentKey: 'brz_' + 'a'.repeat(60), /* ... */ } as any);
  const bat = extractFileFromZip(zip, 'install.bat');
  expect(bat).toMatch(/set ENROLLMENT_KEY="brz_/);
});
```

(`extractFileFromZip` is a small helper; if not present, add it in the test file.)

- [ ] **Step 2: Run the test**

Expected: both fail (no validation; no quotes).

- [ ] **Step 3: Add validation + quoting**

In `apps/api/src/services/installerBuilder.ts`, near the top:

```ts
const ENROLLMENT_KEY_PATTERN = /^brz_[a-f0-9]{60}$/;

function assertValidEnrollmentKey(key: string): void {
  if (!ENROLLMENT_KEY_PATTERN.test(key)) {
    throw new Error('Invalid enrollment key: must match brz_<60-hex>');
  }
}
```

Call `assertValidEnrollmentKey(enrollmentKey)` at the entry of `buildWindowsInstallerZip` and `buildMacosInstallerZip`.

In the batch template (search for `set ENROLLMENT_KEY`), wrap the value in quotes:

```bat
set ENROLLMENT_KEY="${enrollmentKey}"
```

And downstream in the template, use `%ENROLLMENT_KEY:"=%` if a literal (unquoted) copy is ever needed, or leave the quoted form which is correct for `start` / `breeze-agent --enroll`.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @breeze/api test -- installerBuilder
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/installerBuilder.ts apps/api/src/services/installerBuilder.test.ts
git commit -m "fix(api): validate and quote enrollment key in install.bat template"
```

---

### Task 9: Sanitise VNC error reason strings

Finding #9 (MEDIUM). Server-supplied `reason` fields are concatenated into user-facing UI text. Allowlist a small set of known reasons and drop/escape the rest.

**Files:**
- Modify: `apps/viewer/src/lib/transports/vnc.ts:67-78`
- Test:   `apps/viewer/src/lib/transports/vnc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('does not include raw server reason text in the error', () => {
  const seen: string[] = [];
  simulateVncAuthFailure('<script>alert(1)</script>', (msg) => seen.push(msg));
  expect(seen.some((m) => m.includes('<script>'))).toBe(false);
});

it('maps known reasons to friendly text', () => {
  const seen: string[] = [];
  simulateVncAuthFailure('authentication failed', (msg) => seen.push(msg));
  expect(seen.join('\n')).toMatch(/authentication failed/i);
});
```

(`simulateVncAuthFailure` is a small test helper that drives the reason-path in `vnc.ts` with the provided string — add it alongside existing vnc test helpers.)

- [ ] **Step 2: Run the test**

Expected: the XSS-in-reason test fails.

- [ ] **Step 3: Add the allowlist**

In `apps/viewer/src/lib/transports/vnc.ts`, near the top:

```ts
const KNOWN_VNC_REASONS = new Set([
  'authentication failed',
  'too many attempts',
  'unsupported security type',
  'unsupported protocol version',
]);

function friendlyReason(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (KNOWN_VNC_REASONS.has(lower)) return lower;
  return 'connection refused by remote';
}
```

Replace the site that builds the error message (line ~67-78):

```ts
deps.onError(`Security failure: ${friendlyReason(reason)}`);
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm --filter breeze-viewer test -- vnc
```

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/transports/vnc.ts apps/viewer/src/lib/transports/vnc.test.ts
git commit -m "fix(viewer): allowlist VNC error reasons to prevent injection via server text"
```

---

### Task 10: Shorten viewer JWT TTL + add `jti` revocation

Finding #4 (MEDIUM). Drop viewer TTL from 8h to 2h, add a `jti`, check a Redis revocation set on every `requireViewerToken`, and revoke on tunnel close.

**Files:**
- Modify: `apps/api/src/services/jwt.ts`
- Create: `apps/api/src/services/viewerTokenRevocation.ts`
- Create: `apps/api/src/services/viewerTokenRevocation.test.ts`
- Modify: `apps/api/src/routes/tunnels.ts` (revoke on close; check in `requireViewerToken`)

- [ ] **Step 1: Write the failing revocation test**

Create `apps/api/src/services/viewerTokenRevocation.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { revokeViewerJti, isViewerJtiRevoked } from './viewerTokenRevocation';

const redisStore = new Map<string, string>();
vi.mock('./index', () => ({
  getRedis: () => ({
    set: vi.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
  }),
}));

beforeEach(() => redisStore.clear());

describe('viewerTokenRevocation', () => {
  it('flags a jti as revoked after revokeViewerJti()', async () => {
    expect(await isViewerJtiRevoked('jti-1')).toBe(false);
    await revokeViewerJti('jti-1');
    expect(await isViewerJtiRevoked('jti-1')).toBe(true);
  });

  it('fails closed when redis is down', async () => {
    vi.resetModules();
    vi.doMock('./index', () => ({ getRedis: () => null }));
    const { isViewerJtiRevoked: isRevoked } = await import('./viewerTokenRevocation');
    expect(await isRevoked('jti-x')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter @breeze/api test -- viewerTokenRevocation
```

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/viewerTokenRevocation.ts`:

```ts
import { getRedis } from './index';

const REVOKE_TTL_SECONDS = 8 * 60 * 60; // Match max viewer TTL so keys auto-expire.

export async function revokeViewerJti(jti: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return; // Best-effort on the revoke side — check-side fails closed.
  await redis.set(`viewer-jti-revoked:${jti}`, '1', 'EX', REVOKE_TTL_SECONDS);
}

export async function isViewerJtiRevoked(jti: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    console.error('[viewerTokenRevocation] Redis unavailable — failing closed');
    return true;
  }
  return (await redis.get(`viewer-jti-revoked:${jti}`)) === '1';
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm --filter @breeze/api test -- viewerTokenRevocation
```

- [ ] **Step 5: Reduce TTL and add `jti` claim**

In `apps/api/src/services/jwt.ts`:

```ts
const VIEWER_ACCESS_TOKEN_EXPIRY = e2eMode ? '24h' : '2h';

export interface ViewerTokenPayload {
  sub: string;
  email: string;
  sessionId: string;
  purpose: 'viewer';
  jti: string;
  iat?: number;
}

export async function createViewerAccessToken(
  payload: Omit<ViewerTokenPayload, 'purpose' | 'jti'>,
): Promise<string> {
  const secret = getSecretKey();
  return new SignJWT({ ...payload, purpose: 'viewer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(VIEWER_ACCESS_TOKEN_EXPIRY)
    .setIssuer('breeze')
    .setAudience('breeze-viewer')
    .sign(secret);
}
```

In `verifyViewerAccessToken`, include `jti: payload.jti as string` in the returned object. Update the interface accordingly.

- [ ] **Step 6: Check revocation in `requireViewerToken`**

In `apps/api/src/routes/tunnels.ts`:

```ts
import { isViewerJtiRevoked } from '../services/viewerTokenRevocation';

async function requireViewerToken(c: Context): Promise<{ sessionId: string; jti: string } | Response> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid authorization header' }, 401);
  }
  const token = authHeader.slice(7);
  const payload = await verifyViewerAccessToken(token);
  if (!payload || !payload.jti) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
  if (await isViewerJtiRevoked(payload.jti)) {
    return c.json({ error: 'Token revoked' }, 401);
  }
  return { sessionId: payload.sessionId, jti: payload.jti };
}
```

- [ ] **Step 7: Revoke on tunnel close**

In the DELETE `/:id` handler (line 336), after the status update:

```ts
// Revoke any viewer JWTs minted for this tunnel. Since we don't store the
// jti→tunnel mapping, do best-effort by stamping a per-sessionId revoke key
// that the viewer check also honours.
import { revokeViewerJti } from '../services/viewerTokenRevocation';
// The current token model uses sessionId in the JWT; stamp that as a "revoked session":
await redis.set(`viewer-session-revoked:${id}`, '1', 'EX', 2 * 60 * 60);
```

Then in `requireViewerToken`, also check:

```ts
if (await getRedis()?.get(`viewer-session-revoked:${payload.sessionId}`)) {
  return c.json({ error: 'Session closed' }, 401);
}
```

(Simpler than tracking individual jtis; tunnel ID already identifies the session.)

- [ ] **Step 8: Run tests**

```bash
pnpm --filter @breeze/api test -- "(tunnels|viewerTokenRevocation|jwt)"
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/jwt.ts apps/api/src/services/viewerTokenRevocation.ts apps/api/src/services/viewerTokenRevocation.test.ts apps/api/src/routes/tunnels.ts
git commit -m "feat(api): viewer JWT drops to 2h and can be revoked on tunnel close"
```

---

### Task 11: Restrict HTTP fallback in the viewer to true localhost

Finding #8 (MEDIUM). `isPrivateHost()` currently allows `100.*` and RFC1918. On hostile WiFi, ARP/DNS spoof can redirect. Narrow the exception to literal `127.0.0.1`, `::1`, `localhost`.

**Files:**
- Modify: `apps/viewer/src/lib/protocol.ts:50-51`
- Test:   `apps/viewer/src/lib/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects HTTP API URLs on RFC1918 addresses', () => {
  const url = 'breeze://connect?session=a&code=b&api=http%3A%2F%2F192.168.1.5';
  expect(parseDeepLink(url)).toBeNull();
});

it('accepts HTTP API URLs on 127.0.0.1', () => {
  const url = 'breeze://connect?session=a&code=b&api=http%3A%2F%2F127.0.0.1%3A3000';
  expect(parseDeepLink(url)).not.toBeNull();
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm --filter breeze-viewer test -- protocol
```

- [ ] **Step 3: Tighten the allowlist**

In `apps/viewer/src/lib/protocol.ts`, replace `isPrivateHost()`:

```ts
function isLocalhost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}
```

Update the HTTP-scheme acceptance logic to call `isLocalhost()` instead of `isPrivateHost()`.

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter breeze-viewer test -- protocol
```

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/src/lib/protocol.ts apps/viewer/src/lib/protocol.test.ts
git commit -m "fix(viewer): restrict HTTP API URL fallback to literal localhost"
```

---

### Task 12: Defense-in-depth quoting in agent helper install

Finding #13, #14 (LOW). Hardcoded paths today, but make the templates robust. Also tighten per-session config perms from `0644` to `0600`.

**Files:**
- Modify: `agent/internal/helper/install_linux.go:58-78`
- Modify: `agent/internal/helper/install_darwin.go` (plist template)
- Modify: `agent/internal/helper/migrate.go:76`
- Modify: `agent/internal/helper/manager.go:312`
- Create: `agent/internal/helper/install_linux_test.go`

- [ ] **Step 1: Write a failing Go test**

Create `agent/internal/helper/install_linux_test.go`:

```go
//go:build linux

package helper

import (
	"strings"
	"testing"
)

func TestAutoStartEntryQuotesExecPath(t *testing.T) {
	entry := renderAutoStartEntry("/usr/local/bin/breeze helper")
	// %q quoting must wrap the path so spaces don't split the Exec line.
	if !strings.Contains(entry, `Exec="/usr/local/bin/breeze helper"`) {
		t.Fatalf("expected quoted Exec= line, got:\n%s", entry)
	}
}
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd agent && go test -race ./internal/helper/ -run TestAutoStartEntryQuotesExecPath
```

Expected: fails (function not defined or path not quoted).

- [ ] **Step 3: Extract and fix `renderAutoStartEntry`**

In `agent/internal/helper/install_linux.go`, replace the inline `fmt.Sprintf` in `installAutoStart` with a helper and use `%q`:

```go
func renderAutoStartEntry(binaryPath string) string {
	return fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=Breeze Helper
Exec=%q
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`, binaryPath)
}

func installAutoStart(binaryPath string) error {
	entry := renderAutoStartEntry(binaryPath)
	// ...existing MkdirAll + WriteFile...
}
```

- [ ] **Step 4: Fix plist XML escaping on darwin**

In `agent/internal/helper/install_darwin.go`, replace the raw `fmt.Sprintf` plist builder with `encoding/xml`-escaped values:

```go
import "encoding/xml"

func renderPlist(binaryPath, label string) (string, error) {
	var buf bytes.Buffer
	if err := xml.EscapeText(&buf, []byte(binaryPath)); err != nil {
		return "", err
	}
	escapedPath := buf.String()
	// ...build plist with escapedPath in place of %s...
}
```

Add a corresponding test `install_darwin_test.go` asserting that a path containing `<` does not appear unescaped in the output.

- [ ] **Step 5: Tighten file mode**

In `agent/internal/helper/migrate.go:76` and `agent/internal/helper/manager.go:312` (or wherever `os.WriteFile(..., 0644)` writes per-session config), change the mode to `0600`. Tests are not strictly required for a mode change, but add one assertion if a close-by test file already exists.

- [ ] **Step 6: Run all helper tests**

```bash
cd agent && go test -race ./internal/helper/...
```

- [ ] **Step 7: Commit**

```bash
git add agent/internal/helper/install_linux.go agent/internal/helper/install_linux_test.go agent/internal/helper/install_darwin.go agent/internal/helper/install_darwin_test.go agent/internal/helper/migrate.go agent/internal/helper/manager.go
git commit -m "chore(agent): defensive quoting in helper install templates; 0600 session configs"
```

---

## Out of scope (follow-ups)

The following lower-priority items from the review are intentionally deferred:

- TOCTOU on `/proc/<pid>/exe` match in `process_check_*` (finding #15) — very low risk, requires UID ownership verification scaffolding.
- `AbortController` on org-switch reload (#16) — cosmetic; middleware re-validates anyway.
- Consistent `error` vs `message` key naming across `aiTools*` (#17) — ergonomics; no security impact.
- Deep-link code in URL (#18) — acceptable given millisecond-window single-use redemption.
- Full MITM-proof signed uninstall scripts — a real fix needs a signing infra decision; Task 4 covers the practical short-term gap.
- Encrypted `enrollment.json` inside the installer zip (#11) — needs a key-distribution decision for the agent to decrypt.

---

## Self-review

- **Spec coverage:** 3/3 HIGH, 6/9 MEDIUM fully addressed, 2/9 MEDIUM partially (token-in-URL gets a primary fix, installer `enrollment.json` encryption deferred), 2/5 LOW addressed. Deferred items are documented above with reasoning.
- **Placeholder scan:** No TBD/TODO/"handle edge cases" strings. Every step includes a concrete code block, command, or expected output.
- **Type consistency:** `userRateLimit(bucket, limit, windowSeconds)` signature is consistent in Tasks 1, 2, 3. `issueDownloadHandle`/`consumeDownloadHandle`, `revokeViewerJti`/`isViewerJtiRevoked` pairs match across their definition and use sites. `ViewerTokenPayload` gains `jti: string` in Task 10 and is read back accordingly.

---
