# Enrollment Link Expiry & Partner Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the enrollment-link expiry a user's actual choice everywhere it is offered, expose it on the CLI tab where it is missing entirely, and let a partner set house defaults and a hard ceiling for link TTL and device count.

**Architecture:** Three sequential PRs. PR 1 (#2777) is self-contained client-side work — the API already accepts `ttlMinutes` on the CLI path. PR 2 (#2775) gives bootstrap tokens their own independent TTL, applying to bootstrap tokens the same correction `enrollmentKeys.ts:91-96` already applied to child enrollment keys. PR 3 (#2776) adds `defaults.defaultEnrollmentTtlMinutes`, `defaults.defaultEnrollmentDeviceCount` (inherit-with-override) and `defaults.maxEnrollmentLinkTtlMinutes` (partner-locked) to the existing JSONB settings, with server-side rejection above the cap.

**Tech Stack:** Hono + Zod (API), Drizzle ORM, React + Vitest/jsdom (web), `packages/shared` for cross-cutting types.

## Global Constraints

- Node 22.20.0. Package manager is `pnpm`.
- **No DB migration is required by any task in this plan.** `partners.settings` / `organizations.settings` are schemaless `jsonb` (`apps/api/src/db/schema/orgs.ts:26`, `:86`). If a task appears to need one, stop and escalate.
- Never edit a shipped migration. Fix forward.
- Test files live alongside sources (`routes/devices.ts` → `routes/devices.test.ts`).
- Every new user-visible web string needs an i18n key in the `settings` or `devices` namespace — no literal strings in JSX (there is a lint gate on this).
- `packages/shared` is the home for any type used by both API and web.
- Web mutation handlers use `runAction` (`apps/web/src/lib/runAction.ts`). The Add Device modal predates this and is on the allowlist; do **not** refactor it as part of this work.
- **Never silently clamp a user's expiry selection.** This entire plan exists because a selection was silently discarded. Out-of-range input must 400 with a message naming the cap, never get quietly reduced.

## Decision Record

Three design decisions were settled before this plan was written. Implementers should not relitigate them, but should know the reasoning:

1. **Bootstrap tokens get an independent TTL; the parent enrollment key stays transient.** PR #739 review finding #1 deliberately moved `ttlMinutes` off the parent onto the child, and the merge review ratified "no API path extends an existing key's expiry." That decision stands. Revocation does not depend on the parent's TTL — `parent_enrollment_key_id UUID NOT NULL REFERENCES enrollment_keys(id) ON DELETE CASCADE` (`apps/api/migrations/2026-04-19-a-installer-bootstrap-tokens.sql:16`) means deleting a parent key hard-deletes its tokens at any TTL.
2. **"Never expires" is out of scope.** `installer_bootstrap_tokens.expires_at` is `NOT NULL` with a `CHECK (expires_at > created_at)`, so it would need a migration plus null-handling through issuance, consume, the cleanup job and the expiry UI. 1 year (525,600 min) remains the maximum. The partner cap ships regardless, which is what the `AddDeviceModal.tsx:130-132` comment was blocking on.
3. **Split lock semantics.** The two default *values* are inherit-with-override (an org may deviate); the *cap* is partner-locked (a ceiling an org can raise is not a ceiling).

---

## File Structure

**PR 1 — CLI tab expiry (#2777)**

| File | Responsibility |
|---|---|
| `apps/api/src/routes/devices/core.ts` | Add a Zod schema to `POST /devices/onboarding-token`; keep existing clamp semantics for `count` only |
| `apps/api/src/routes/devices.test.ts` | Assert the new validation rejects bad input and honours `ttlMinutes` |
| `apps/web/src/components/devices/AddDeviceModal.tsx` | Render the TTL select on the CLI panel; send `ttlMinutes` + `content-type` |
| `apps/web/src/components/devices/AddDeviceModal.test.tsx` | Assert the CLI POST carries the selected TTL |

**PR 2 — Bootstrap token TTL (#2775)**

| File | Responsibility |
|---|---|
| `apps/api/src/services/installerBootstrapTokenIssuance.ts` | Accept `ttlMinutes`; stop capping token expiry to the parent |
| `apps/api/src/services/installerBootstrapTokenIssuance.test.ts` | **New file** — first direct test of the issuance service |
| `apps/api/src/routes/enrollmentKeys.ts` | Pass the picker TTL at the three issuance call sites; accept `ttlMinutes` on `POST /:id/bootstrap-token` |
| `apps/api/src/routes/installer.ts` | Stop clamping the minted child key to the parent's expiry |
| `apps/api/src/routes/installer.test.ts` | Assert a live token against an expired parent still consumes |

**PR 3 — Partner defaults & cap (#2776)**

| File | Responsibility |
|---|---|
| `packages/shared/src/types/index.ts` | Extend `InheritableDefaultSettings` |
| `packages/shared/src/validators/enrollmentDefaults.ts` | **New file** — bounds + the shared `resolveEnrollmentDefaults` merge |
| `packages/shared/src/validators/enrollmentDefaults.test.ts` | **New file** |
| `apps/api/src/services/enrollmentDefaults.ts` | **New file** — org⋈partner join resolver (mirrors `getOrgAgentUpdateConfig`) |
| `apps/api/src/routes/orgs.ts` | Partner Zod block; lock exemption; org-side hand validation |
| `apps/api/src/routes/enrollmentKeys.ts` | Reject `ttlMinutes` above the resolved cap |
| `apps/web/src/components/settings/PartnerDefaultsTab.tsx` | Three new fields |
| `apps/web/src/components/settings/OrgDefaultsEditor.tsx` | Two new fields + `locked` threading |
| `apps/web/src/components/devices/AddDeviceModal.tsx` | Seed pickers from resolved defaults; hide options above cap |

---

# PR 1 — CLI tab expiry (#2777)

**Interfaces produced:** none consumed by later PRs. This PR is independently shippable.

### Task 1.1: Validate `POST /devices/onboarding-token`

The route currently parses its body with `c.req.json().catch(() => ({}))` and hand-clamps (`core.ts:325-334`). That laxness is why the missing `ttlMinutes` failed silently instead of erroring. Add a schema; keep `count`'s clamping behaviour (existing clients rely on out-of-range counts being clamped rather than rejected — see `devices.test.ts:211+`), but reject a malformed `ttlMinutes`.

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:277-334`
- Test: `apps/api/src/routes/devices.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `POST /devices/onboarding-token` accepts `{ count?: number, ttlMinutes?: number }`; `ttlMinutes` in `1..525_600`; out-of-range 400s.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/devices.test.ts` inside the existing onboarding-token describe block:

```ts
it('honours ttlMinutes from the request body', async () => {
  const res = await app.request('/devices/onboarding-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ count: 1, ttlMinutes: 10080 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
  // 7 days, allowing 60s of test-execution drift
  expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
  expect(ttlMs).toBeLessThan(10080 * 60 * 1000 + 60_000);
});

it('rejects ttlMinutes above the 525_600 cap', async () => {
  const res = await app.request('/devices/onboarding-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ ttlMinutes: 525_601 }),
  });
  expect(res.status).toBe(400);
});

it('rejects a non-numeric ttlMinutes instead of silently defaulting', async () => {
  const res = await app.request('/devices/onboarding-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ ttlMinutes: 'forever' }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/devices.test.ts -t 'ttlMinutes'
```
Expected: FAIL — the cap test and the non-numeric test both return 200, because `Number('forever')` is `NaN` and falls through to the default.

- [ ] **Step 3: Add the schema**

In `apps/api/src/routes/devices/core.ts`, near the existing constants at `:274-275`:

```ts
const ENROLL_TOKEN_MAX_COUNT = 1000;
const ENROLL_TOKEN_MAX_TTL_MINUTES = 525_600; // 365 days

// count is CLAMPED (long-standing behaviour relied on by existing clients);
// ttlMinutes is REJECTED when out of range — a silently reduced expiry is the
// exact failure mode #2775 was filed for.
const onboardingTokenSchema = z.object({
  count: z.number().int().min(1).optional(),
  ttlMinutes: z.number().int().min(1).max(ENROLL_TOKEN_MAX_TTL_MINUTES).optional(),
}).strict();
```

Register it on the route (registered at `:280`):

```ts
devicesRoutes.post(
  '/onboarding-token',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE),
  requireMfa(),
  zValidator('json', onboardingTokenSchema),
  async (c) => {
```

Replace the ad-hoc parse at `:325-334`:

```ts
    const data = c.req.valid('json');
    const maxUsage = data.count !== undefined
      ? Math.min(ENROLL_TOKEN_MAX_COUNT, data.count)
      : 1;
    const ttlMinutes = data.ttlMinutes
      ?? envInt('ENROLLMENT_KEY_DEFAULT_TTL_MINUTES', 60);
```

Ensure `z` and `zValidator` are imported in this file (they are already used at `:388` and `:1060`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/devices.test.ts
```
Expected: PASS, including the pre-existing count/limit cases at `:211+`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/routes/devices.test.ts
git commit -m "fix(api): validate onboarding-token body; reject out-of-range ttlMinutes (#2777)"
```

### Task 1.2: Render the expiry picker on the CLI tab

**Files:**
- Modify: `apps/web/src/components/devices/AddDeviceModal.tsx` (state `:133`, `initializeCli` `:217-232`, `regenerateCliToken` `:294`, CLI panel `:956-990`)
- Test: `apps/web/src/components/devices/AddDeviceModal.test.tsx`

**Interfaces:**
- Consumes: `POST /devices/onboarding-token` accepting `ttlMinutes` (Task 1.1)
- Produces: `cliTtlMinutes` state, `data-testid="cli-link-ttl"` on the select

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/devices/AddDeviceModal.test.tsx`:

```tsx
it('sends the selected expiry on the CLI onboarding-token request', async () => {
  fetchWithAuthMock.mockImplementation(async () =>
    new Response(JSON.stringify({
      token: 'enroll_abc', maxUsage: 1,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      enrollmentSecretMode: 'none', additionalSecretRequired: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  render(<AddDeviceModal isOpen onClose={() => {}} />);
  await userEvent.click(screen.getByTestId('tab-cli'));
  await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
  fetchWithAuthMock.mockClear();

  await userEvent.selectOptions(screen.getByTestId('cli-link-ttl'), '10080');
  await userEvent.click(screen.getByTestId('cli-regenerate-token'));

  await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
  const call = fetchWithAuthMock.mock.calls[0];
  expect(String(call[0])).toBe('/devices/onboarding-token');
  const init = call[1] as RequestInit;
  expect(JSON.parse(init.body as string)).toMatchObject({ ttlMinutes: 10080 });
  expect((init.headers as Record<string, string>)['Content-Type'])
    .toBe('application/json');
});
```

If `data-testid="tab-cli"` / `data-testid="cli-regenerate-token"` are absent, add them in Step 3 — the tab bar is at `:571-588` and the regenerate button at `:983-988`.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/devices/AddDeviceModal.test.tsx -t 'CLI onboarding-token'
```
Expected: FAIL — `Unable to find an element by: [data-testid="cli-link-ttl"]`.

- [ ] **Step 3: Implement**

Add state next to `cliDeviceCount` (`:154`):

```tsx
  // Independent of the installer tab's ttlMinutes: the CLI command is
  // typically pasted into a GPO/imaging script that runs later, so its
  // useful default is longer than a hand-carried installer's.
  const [cliTtlMinutes, setCliTtlMinutes] = useState<number>(1440);
```

Change `initializeCli`'s signature and body (`:217`, `:229-232`):

```tsx
  const initializeCli = useCallback(async (count: number, ttlMinutes: number) => {
```
```tsx
      const response = await fetchWithAuth("/devices/onboarding-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count, ttlMinutes }),
      });
```

Update all three call sites to pass the TTL — `:328` (`void initializeCli(cliDeviceCount, cliTtlMinutes)`), `:941`, and `regenerateCliToken` at `:294` (widen it the same way and forward both). Add `cliTtlMinutes` to the `useEffect` dependency array at `:330`.

Add the select inside the CLI panel, immediately after the device-count field (`:981`), mirroring the installer markup at `:700-726`:

```tsx
                      <div>
                        <label
                          htmlFor="cli-link-ttl"
                          className="mb-1 block text-sm font-medium"
                        >
                          {t("addDeviceModal.linkExpiresIn")}
                        </label>
                        <select
                          id="cli-link-ttl"
                          data-testid="cli-link-ttl"
                          value={cliTtlMinutes}
                          onChange={(e) => setCliTtlMinutes(Number(e.target.value))}
                          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                        >
                          <option value={60}>{t("addDeviceModal.ttl1Hour")}</option>
                          <option value={1440}>{t("addDeviceModal.ttl24Hours")}</option>
                          <option value={10080}>{t("addDeviceModal.ttl7Days")}</option>
                          <option value={43200}>{t("addDeviceModal.ttl30Days")}</option>
                          <option value={129600}>{t("addDeviceModal.ttl90Days")}</option>
                          <option value={525600}>{t("addDeviceModal.ttl1Year")}</option>
                        </select>
                      </div>
```

Reuse the existing `addDeviceModal.*` i18n keys from the installer select — do not add duplicates.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/devices/AddDeviceModal.test.tsx
pnpm --filter=@breeze/web exec tsc --noEmit
```
Expected: PASS, including the pre-existing installer-tab assertions at `:203-209` and `:266-272` (this task must not change the installer POST body).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/AddDeviceModal.tsx apps/web/src/components/devices/AddDeviceModal.test.tsx
git commit -m "fix(web): add expiry picker to Add Device CLI tab (#2777)"
```

---

# PR 2 — Bootstrap token independent TTL (#2775)

**Background for the implementer:** `issueBootstrapTokenForKey` currently sets `expiresAt = min(parent.expiresAt, now + 24h)`. Since the modal creates a 60-minute parent, every bootstrap token gets 60 minutes regardless of the picker. Child *enrollment keys* already dodge this via `freshChildExpiresAt` — see the rationale comment at `enrollmentKeys.ts:91-96`. This PR extends that same treatment to bootstrap tokens.

### Task 2.1: Give the issuance service its own TTL

**Files:**
- Modify: `apps/api/src/services/installerBootstrapTokenIssuance.ts:10-22`, `:69-78`
- Create: `apps/api/src/services/installerBootstrapTokenIssuance.test.ts`

**Interfaces:**
- Produces: `IssueBootstrapTokenInput` gains `ttlMinutes?: number`. When supplied, `expiresAt = now + ttlMinutes*60_000`, uncapped by the parent. When omitted, `expiresAt = bootstrapTokenExpiresAt()` (24h), also uncapped.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/installerBootstrapTokenIssuance.test.ts`. This service has never had a direct test — its cap logic has only ever run under `vi.mock`. Mock the `db` module the same way `apps/api/src/routes/enrollmentKeys_installer.test.ts` does.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserted: Array<Record<string, unknown>> = [];
vi.mock('../db/index.js', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: 'tok-1', ...v }] };
      },
    }),
    query: {
      enrollmentKeys: {
        findFirst: async () => ({
          id: 'parent-1',
          name: 'Add device installer',
          orgId: 'org-1',
          siteId: 'site-1',
          // deliberately near-dead: the transient 60-min parent, 59 min in
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
    },
  },
}));

const { issueBootstrapTokenForKey } = await import('./installerBootstrapTokenIssuance.js');

describe('issueBootstrapTokenForKey', () => {
  beforeEach(() => { inserted.length = 0; });

  it('honours ttlMinutes even when the parent expires sooner (#2775)', async () => {
    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
      maxUsage: 5,
      ttlMinutes: 10080, // 7 days
    });
    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(10080 * 60 * 1000 - 60_000);
  });

  it('falls back to the 24h base TTL when ttlMinutes is omitted', async () => {
    const result = await issueBootstrapTokenForKey({
      parentEnrollmentKeyId: 'parent-1',
      createdByUserId: 'user-1',
    });
    const ttlMs = result.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/installerBootstrapTokenIssuance.test.ts
```
Expected: FAIL — both tokens come back with ~60s of life, capped to the parent.

- [ ] **Step 3: Implement**

In `apps/api/src/services/installerBootstrapTokenIssuance.ts`, extend the input interface (`:10-22`):

```ts
  maxUsage?: number;
  installerPlatform?: "windows" | "macos";
  /**
   * Absolute lifetime for this token, in minutes, as chosen by the admin in
   * the Add Device modal. Omitted → the 24h base from bootstrapTokenExpiresAt().
   * Bounds are enforced upstream by the route Zod schemas (1..525_600).
   */
  ttlMinutes?: number;
```

Replace the cap block (`:69-78`):

```ts
  const token = generateBootstrapToken();
  // The token gets a fresh, independent lifetime — it is NOT bounded by the
  // parent's remaining life. The parent created by the Add Device modal is a
  // deliberately transient 60-minute container (PR #739 review finding #1),
  // so capping to it made every installer die in an hour whatever the admin
  // picked (#2775). This mirrors the identical correction already made for
  // child enrollment keys — see CHILD_ENROLLMENT_KEY_TTL_MINUTES in
  // routes/enrollmentKeys.ts.
  //
  // Revocation does NOT depend on this cap: installer_bootstrap_tokens
  // .parent_enrollment_key_id is ON DELETE CASCADE, so deleting the parent
  // key still destroys every outstanding token immediately.
  //
  // Freshness at ISSUE time is still enforced by the caller via
  // parentKeyTooCloseToExpiry().
  const expiresAt = input.ttlMinutes !== undefined
    ? new Date(Date.now() + input.ttlMinutes * 60 * 1000)
    : bootstrapTokenExpiresAt();
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/installerBootstrapTokenIssuance.test.ts
```
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/installerBootstrapTokenIssuance.ts apps/api/src/services/installerBootstrapTokenIssuance.test.ts
git commit -m "fix(api): give bootstrap tokens an independent TTL, uncapped by the transient parent (#2775)"
```

### Task 2.2: Pass the picker TTL at every issuance call site

Three call sites currently drop the TTL on the floor. `childTtlMinutes` is already in scope at two of them.

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts:1086-1090` (macOS app-bundle), `:1202-1207` (Windows MSI), `:1845` (short-link public download), `:1418-1420` + `:1458` (`POST /:id/bootstrap-token`)
- Test: `apps/api/src/routes/enrollmentKeys_installer.test.ts`, `apps/api/src/routes/enrollmentKeys.test.ts`

**Interfaces:**
- Consumes: `IssueBootstrapTokenInput.ttlMinutes` (Task 2.1)
- Produces: `POST /:id/bootstrap-token` body gains optional `ttlMinutes`

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/routes/enrollmentKeys_installer.test.ts`, alongside the existing `maxUsage` assertion at `:462`:

```ts
it('passes the ttlMinutes query param through to the bootstrap token (windows)', async () => {
  await app.request(
    '/enrollment-keys/key-1/installer/windows?count=5&ttlMinutes=43200',
    { headers: authHeaders },
  );
  expect(issueBootstrapTokenForKeyMock).toHaveBeenCalledWith(
    expect.objectContaining({ maxUsage: 5, ttlMinutes: 43200 }),
  );
});

it('passes the ttlMinutes query param through to the bootstrap token (macos app bundle)', async () => {
  await app.request(
    '/enrollment-keys/key-1/installer/macos?count=2&ttlMinutes=10080',
    { headers: authHeaders },
  );
  expect(issueBootstrapTokenForKeyMock).toHaveBeenCalledWith(
    expect.objectContaining({ ttlMinutes: 10080 }),
  );
});
```

In `apps/api/src/routes/enrollmentKeys.test.ts`, in the `POST /:id/bootstrap-token` block at `:1223+`:

```ts
it('honours ttlMinutes on the bootstrap-token route', async () => {
  const res = await app.request('/enrollment-keys/key-1/bootstrap-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ maxUsage: 3, ttlMinutes: 129600 }),
  });
  expect(res.status).toBe(200);
  expect(issueBootstrapTokenForKeyMock).toHaveBeenCalledWith(
    expect.objectContaining({ ttlMinutes: 129600 }),
  );
});

it('rejects ttlMinutes above the cap on the bootstrap-token route', async () => {
  const res = await app.request('/enrollment-keys/key-1/bootstrap-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ ttlMinutes: 525_601 }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/enrollmentKeys_installer.test.ts src/routes/enrollmentKeys.test.ts -t ttlMinutes
```
Expected: FAIL — `issueBootstrapTokenForKey` is called without a `ttlMinutes` property.

- [ ] **Step 3: Implement**

At `:1086-1090` (macOS app bundle) and `:1202-1207` (Windows MSI), add `ttlMinutes: childTtlMinutes` to the existing call object — the variable is already destructured at `:970-971`:

```ts
      const issued = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: key.id,
        createdByUserId: auth.userId ?? null,
        maxUsage: childMaxUsage,
        ttlMinutes: childTtlMinutes,
        installerPlatform: "windows",
      });
```

At `:1845` (short-link public download), thread the TTL from the short-link's own record if one is stored; if not available in scope, pass nothing and leave the 24h base — but add a comment saying so explicitly, since silent omission is the bug being fixed:

```ts
      // Short-link downloads carry no per-request picker (the link was
      // generated once, by an admin who already chose a TTL for the CHILD
      // key). The token therefore takes the 24h base rather than inheriting
      // a stale selection. Deliberate — not an oversight (#2775).
```

Extend the bootstrap-token schema at `:1418-1420`:

```ts
const bootstrapTokenSchema = z.object({
  maxUsage: z.number().int().min(1).max(1000).optional(),
  ttlMinutes: z.number().int().min(1).max(MAX_TTL_MINUTES).optional(),
}).strict();
```

and forward it at the `issueBootstrapTokenForKey` call at `:1458`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/enrollmentKeys_installer.test.ts src/routes/enrollmentKeys.test.ts
```
Expected: PASS. The pre-existing case at `:348` ("windows bootstrap does not create a child enrollment key") must still pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys_installer.test.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "fix(api): thread the per-link TTL into bootstrap token issuance (#2775)"
```

### Task 2.3: Stop clamping the minted child key to the parent at consume time

With Task 2.1 done, a 30-day token can still be neutered at redemption: `installer.ts:147-160` clamps the child key to the parent's expiry and 404s `parent_already_expired` when the parent is dead. The token's own expiry is now the authority.

**Files:**
- Modify: `apps/api/src/routes/installer.ts:15-33`, `:145-160`
- Test: `apps/api/src/routes/installer.test.ts`

**Interfaces:**
- Consumes: tokens issued with independent TTLs (Task 2.1)
- Produces: consume succeeds against an expired parent so long as the token itself is live

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/installer.test.ts`, near the expired-token case at `:207`:

```ts
it('consumes a live token whose parent key has already expired (#2775)', async () => {
  mockTokenRow({
    id: 'tok-1',
    parentEnrollmentKeyId: 'parent-1',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000), // token: 7 days left
    maxUsage: 10,
    consumedCount: 0,
  });
  mockParentRow({
    id: 'parent-1',
    orgId: 'org-1',
    siteId: 'site-1',
    expiresAt: new Date(Date.now() - 3600_000), // parent: dead an hour ago
  });

  const res = await app.request('/api/v1/installer/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'bst_' + 'a'.repeat(48) }),
  });

  expect(res.status).toBe(200);
  const body = await res.json();
  // Child key gets its own fresh TTL, not the parent's dead one
  expect(new Date(body.enrollmentKey.expiresAt).getTime())
    .toBeGreaterThan(Date.now());
});
```

Match `mockTokenRow` / `mockParentRow` to whatever helpers the file already uses; if none exist, follow the mocking shape used by the expired-token test at `:207`.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/installer.test.ts -t 'parent key has already expired'
```
Expected: FAIL with 404 and a `reason: "parent_already_expired"` console line.

- [ ] **Step 3: Implement**

Replace `freshChildExpiresAt` (`:15-33`):

```ts
/**
 * Returns the child enrollment key expiry: now + CHILD_TTL_MIN.
 *
 * The parent's expiry is deliberately NOT an upper bound. The parent created
 * by the Add Device modal is a transient 60-minute container (PR #739 review
 * finding #1); bounding the child by it made a 30-day installer link die in an
 * hour (#2775). The bootstrap token carries its own independent expiry, which
 * is checked before this is called — that is the authority on whether the
 * installer is still valid.
 *
 * Revocation is unaffected: installer_bootstrap_tokens.parent_enrollment_key_id
 * is ON DELETE CASCADE, so deleting the parent destroys outstanding tokens
 * before they can ever reach this function.
 */
function freshChildExpiresAt(): Date {
  return new Date(Date.now() + CHILD_TTL_MIN * 60 * 1000);
}
```

Replace the call block (`:145-160`) with:

```ts
    const childExpiresAt = freshChildExpiresAt();
```

Delete the now-unreachable `parent_already_expired` branch. Grep for other references before deleting:

```bash
grep -rn "parent_already_expired" apps/api/src apps/docs
```

Update any doc or test that asserts the old behaviour, and note the behaviour change in the PR body.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/installer.test.ts
pnpm --filter=@breeze/api exec tsc --noEmit
```
Expected: PASS. The genuinely-expired-*token* case at `:207` must still 404 — that check is untouched and is now the sole gate.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/installer.ts apps/api/src/routes/installer.test.ts
git commit -m "fix(api): let a live bootstrap token outlive its transient parent key (#2775)"
```

### Task 2.4: End-to-end integration test against real Postgres

There is currently **no** integration coverage of bootstrap token issuance — `installerBootstrapTokenIssuance.ts` is `vi.mock`ed everywhere it appears, so the cap logic never executed under test. That is why this bug survived. Close the hole for real.

**Files:**
- Create: `apps/api/src/__tests__/integration/installerBootstrapTokenTtl.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts` (only if the file needs adding to the explicit allowlist — check the include globs first)

**Interfaces:**
- Consumes: everything from Tasks 2.1-2.3

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../../db/index.js';
import { issueBootstrapTokenForKey } from '../../services/installerBootstrapTokenIssuance.js';
import { withSystemDbAccessContext } from '../../db/index.js';
// plus the suite's usual fixture helpers for creating a partner/org/site

describe('installer bootstrap token TTL (#2775)', () => {
  it('a 30-day token issued from a 60-minute parent really lives 30 days', async () => {
    await withSystemDbAccessContext(async () => {
      const { orgId, siteId } = await createTestOrgAndSite();
      const [parent] = await db.insert(enrollmentKeys).values({
        orgId, siteId, name: 'transient parent',
        keyHash: 'x'.repeat(64),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 60 min
        maxUsage: 1,
      }).returning();

      const issued = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: parent.id,
        createdByUserId: null,
        maxUsage: 25,
        ttlMinutes: 43200, // 30 days
      });

      const row = await db.query.installerBootstrapTokens.findFirst({
        where: eq(installerBootstrapTokens.id, issued.id),
      });
      const ttlMs = new Date(row!.expiresAt).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    });
  });
});
```

- [ ] **Step 2: Run against a real DB to verify it fails on the pre-fix code**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/installerBootstrapTokenTtl.integration.test.ts
```
Expected on `main`: FAIL (~60 min). On this branch: PASS.

- [ ] **Step 3: Confirm the file is picked up**

```bash
grep -n "installerBootstrapTokenTtl\|__tests__/integration" apps/api/vitest.integration.config.ts
```
If the config uses an explicit allowlist rather than a glob, add the file to it.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/installerBootstrapTokenTtl.integration.test.ts apps/api/vitest.integration.config.ts
git commit -m "test(api): integration coverage for bootstrap token TTL (#2775)"
```

---

# PR 3 — Partner defaults & cap (#2776)

**Background:** `defaults` lives in the `partners.settings` / `organizations.settings` JSONB blobs. `mergeCategory` (`effectiveSettings.ts:76-98`) makes partner fields win unconditionally and pushes them into `locked[]`. `agentVersionPins` escapes this via a *dedicated resolver* — `getOrgAgentUpdateConfig` (`routes/agents/helpers.ts:2183-2197`) does its own org⋈partner join with an inverted, presence-keyed ternary — plus a lock exemption at `orgs.ts:1326-1327`. Copy that three-part contract; do **not** teach `mergeCategory` about these fields.

> **Known wart, explicitly out of scope:** `GET /orgs/organizations/:id/effective-settings` returns a `defaults.agentVersionPins` that is not the runtime-effective value and lists it in `locked` even though nothing enforces that lock. `OrgSettingsPage.tsx:296-306` knowingly *depends* on this, repurposing the lock list as a "the partner has a pin" flag. A shared `INHERIT_WITH_OVERRIDE_FIELDS` set consumed by both `mergeCategory` and the lock loop would fix it properly — but doing so would break that compensation. File it separately; do not attempt it here.

### Task 3.1: Shared types, bounds, and the merge rule

**Files:**
- Modify: `packages/shared/src/types/index.ts:617-640`
- Create: `packages/shared/src/validators/enrollmentDefaults.ts`
- Create: `packages/shared/src/validators/enrollmentDefaults.test.ts`
- Modify: `packages/shared/src/validators/index.ts`

**Interfaces:**
- Produces:
  - `InheritableDefaultSettings.defaultEnrollmentTtlMinutes?: number`
  - `InheritableDefaultSettings.defaultEnrollmentDeviceCount?: number`
  - `InheritableDefaultSettings.maxEnrollmentLinkTtlMinutes?: number`
  - `ENROLLMENT_TTL_OPTIONS: readonly number[]`
  - `ENROLLMENT_TTL_I18N_KEYS: Record<number, string>` — the option→key map every surface renders from. PR 1 ships before this exists and uses the same key literals inline; PR 3 should switch the Add Device selects over to this map so there is one option set, not three.
  - `MAX_ENROLLMENT_TTL_MINUTES = 525_600`
  - `enrollmentDefaultsSchema: ZodObject`
  - `resolveEnrollmentDefaults(partnerDefaults, orgDefaults): ResolvedEnrollmentDefaults`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/validators/enrollmentDefaults.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveEnrollmentDefaults, enrollmentDefaultsSchema } from './enrollmentDefaults.js';

describe('resolveEnrollmentDefaults', () => {
  it('inherits the partner value when the org has not set one', () => {
    const r = resolveEnrollmentDefaults(
      { defaultEnrollmentTtlMinutes: 10080 },
      {},
    );
    expect(r.ttlMinutes).toBe(10080);
  });

  it('lets an org OVERRIDE the partner value (inherit-with-override)', () => {
    const r = resolveEnrollmentDefaults(
      { defaultEnrollmentTtlMinutes: 10080 },
      { defaultEnrollmentTtlMinutes: 60 },
    );
    expect(r.ttlMinutes).toBe(60);
  });

  it('keys on presence, not truthiness', () => {
    const r = resolveEnrollmentDefaults(
      { defaultEnrollmentDeviceCount: 25 },
      { defaultEnrollmentDeviceCount: 0 },
    );
    // 0 is invalid and must be rejected by the schema, but the resolver
    // itself must not silently fall back to the partner value on a falsy 0
    expect(r.deviceCount).toBe(0);
  });

  it('takes the cap from the PARTNER only — an org cannot raise it', () => {
    const r = resolveEnrollmentDefaults(
      { maxEnrollmentLinkTtlMinutes: 1440 },
      { maxEnrollmentLinkTtlMinutes: 525600 },
    );
    expect(r.maxTtlMinutes).toBe(1440);
  });

  it('falls back to product defaults when neither level sets anything', () => {
    const r = resolveEnrollmentDefaults({}, {});
    expect(r.ttlMinutes).toBe(1440);
    expect(r.deviceCount).toBe(1);
    expect(r.maxTtlMinutes).toBe(525600);
  });
});

describe('enrollmentDefaultsSchema', () => {
  it('rejects a TTL above the product maximum', () => {
    expect(enrollmentDefaultsSchema.safeParse({
      defaultEnrollmentTtlMinutes: 525601,
    }).success).toBe(false);
  });

  it('rejects a zero device count', () => {
    expect(enrollmentDefaultsSchema.safeParse({
      defaultEnrollmentDeviceCount: 0,
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter=@breeze/shared exec vitest run src/validators/enrollmentDefaults.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/shared/src/validators/enrollmentDefaults.ts`:

```ts
import { z } from 'zod';

export const MAX_ENROLLMENT_TTL_MINUTES = 525_600; // 365 days
export const MAX_ENROLLMENT_DEVICE_COUNT = 1000;

/** Selectable TTLs, in minutes. Mirrors the Add Device modal's option set. */
export const ENROLLMENT_TTL_OPTIONS = [60, 1440, 10080, 43200, 129600, 525600] as const;

/**
 * i18n key per option, so the Add Device modal and both settings tabs render
 * one option set from one source. Keys match the existing literals already in
 * the `devices` namespace — do not mint parallel ones.
 */
export const ENROLLMENT_TTL_I18N_KEYS: Record<number, string> = {
  60: 'addDeviceModal.ttl1Hour',
  1440: 'addDeviceModal.ttl24Hours',
  10080: 'addDeviceModal.ttl7Days',
  43200: 'addDeviceModal.ttl30Days',
  129600: 'addDeviceModal.ttl90Days',
  525600: 'addDeviceModal.ttl1Year',
};

/** Product fallbacks when neither partner nor org has expressed a preference. */
export const PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES = 1440;
export const PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT = 1;

export const enrollmentDefaultsSchema = z.object({
  defaultEnrollmentTtlMinutes: z.number().int().min(1).max(MAX_ENROLLMENT_TTL_MINUTES).optional(),
  defaultEnrollmentDeviceCount: z.number().int().min(1).max(MAX_ENROLLMENT_DEVICE_COUNT).optional(),
  maxEnrollmentLinkTtlMinutes: z.number().int().min(1).max(MAX_ENROLLMENT_TTL_MINUTES).optional(),
});

export interface ResolvedEnrollmentDefaults {
  ttlMinutes: number;
  deviceCount: number;
  maxTtlMinutes: number;
}

type Defaults = Record<string, unknown>;

/**
 * Partner→org resolution for enrollment defaults.
 *
 * The two default VALUES are inherit-with-override: an org-set value wins for
 * that org, an unset org inherits the partner's. Keyed on presence (`in`), not
 * truthiness — same contract as agentVersionPins in getOrgAgentUpdateConfig.
 *
 * The CAP is partner-only. A ceiling an org can raise is not a ceiling, so the
 * org's value is ignored entirely here and rejected at write time by the lock.
 */
export function resolveEnrollmentDefaults(
  partnerDefaults: Defaults,
  orgDefaults: Defaults,
): ResolvedEnrollmentDefaults {
  const pick = (field: string, fallback: number): number => {
    const raw = field in orgDefaults ? orgDefaults[field] : partnerDefaults[field];
    return typeof raw === 'number' ? raw : fallback;
  };
  const rawCap = partnerDefaults.maxEnrollmentLinkTtlMinutes;
  return {
    ttlMinutes: pick('defaultEnrollmentTtlMinutes', PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES),
    deviceCount: pick('defaultEnrollmentDeviceCount', PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT),
    maxTtlMinutes: typeof rawCap === 'number' ? rawCap : MAX_ENROLLMENT_TTL_MINUTES,
  };
}
```

Export it from `packages/shared/src/validators/index.ts` alongside the `agentVersionPins` export at `:27`.

Extend `InheritableDefaultSettings` in `packages/shared/src/types/index.ts:617-640`:

```ts
  /** Pre-selected link TTL in the Add Device modal. Inherit-with-override. */
  defaultEnrollmentTtlMinutes?: number;
  /** Pre-selected device count in the Add Device modal. Inherit-with-override. */
  defaultEnrollmentDeviceCount?: number;
  /** Hard ceiling on link TTL. Partner-only — orgs cannot raise it. */
  maxEnrollmentLinkTtlMinutes?: number;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/shared exec vitest run src/validators/enrollmentDefaults.test.ts
pnpm --filter=@breeze/shared exec tsc --noEmit
```
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): enrollment default settings types, bounds, and resolver (#2776)"
```

### Task 3.2: Server-side resolver over the org⋈partner join

**Files:**
- Create: `apps/api/src/services/enrollmentDefaults.ts`
- Create: `apps/api/src/services/enrollmentDefaults.test.ts`

**Interfaces:**
- Consumes: `resolveEnrollmentDefaults` (Task 3.1)
- Produces: `getEnrollmentDefaultsForOrg(orgId: string): Promise<ResolvedEnrollmentDefaults>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/enrollmentDefaults.test.ts`, mocking `db` in the style of `apps/api/src/routes/agents/helpers.agentUpdatePolicy.test.ts:337-412`:

```ts
it('resolves org-over-partner for the TTL default', async () => {
  mockJoinRow({
    orgSettings: { defaults: { defaultEnrollmentTtlMinutes: 60 } },
    partnerSettings: { defaults: { defaultEnrollmentTtlMinutes: 10080 } },
  });
  const r = await getEnrollmentDefaultsForOrg('org-1');
  expect(r.ttlMinutes).toBe(60);
});

it('ignores an org attempt to raise the partner cap', async () => {
  mockJoinRow({
    orgSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 525600 } },
    partnerSettings: { defaults: { maxEnrollmentLinkTtlMinutes: 1440 } },
  });
  const r = await getEnrollmentDefaultsForOrg('org-1');
  expect(r.maxTtlMinutes).toBe(1440);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/enrollmentDefaults.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/enrollmentDefaults.ts`. Model the join on `getOrgAgentUpdateConfig` (`apps/api/src/routes/agents/helpers.ts:2172-2199`) — a single org⋈partner select, not two round trips:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { organizations, partners } from '../db/schema/orgs.js';
import {
  resolveEnrollmentDefaults,
  type ResolvedEnrollmentDefaults,
} from '@breeze/shared';

function asDefaults(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== 'object') return {};
  const d = (settings as Record<string, unknown>).defaults;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
}

/**
 * Resolve the effective enrollment defaults for an org.
 *
 * Deliberately does NOT go through getEffectiveOrgSettings: mergeCategory
 * makes partner fields win unconditionally, which is wrong for the two
 * inherit-with-override values. Same reason getOrgAgentUpdateConfig exists.
 */
export async function getEnrollmentDefaultsForOrg(
  orgId: string,
): Promise<ResolvedEnrollmentDefaults> {
  const [row] = await db
    .select({
      orgSettings: organizations.settings,
      partnerSettings: partners.settings,
    })
    .from(organizations)
    .leftJoin(partners, eq(organizations.partnerId, partners.id))
    .where(eq(organizations.id, orgId))
    .limit(1);

  return resolveEnrollmentDefaults(
    asDefaults(row?.partnerSettings),
    asDefaults(row?.orgSettings),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/services/enrollmentDefaults.test.ts
```
Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/enrollmentDefaults.ts apps/api/src/services/enrollmentDefaults.test.ts
git commit -m "feat(api): org-over-partner resolver for enrollment defaults (#2776)"
```

### Task 3.3: Accept the fields on write; exempt the values from the lock

**Files:**
- Modify: `apps/api/src/routes/orgs.ts:454-479` (partner `defaults` Zod block), `:1310` area (org-side hand validation), `:1326-1327` (lock exemption)
- Test: `apps/api/src/routes/orgs.test.ts`

**Interfaces:**
- Consumes: `enrollmentDefaultsSchema` (Task 3.1)
- Produces: partner PATCH accepts all three fields; org PATCH accepts the two values and 403s on the cap

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/orgs.test.ts`:

```ts
it('persists partner enrollment defaults through PATCH /partners/me', async () => {
  const res = await app.request('/orgs/partners/me', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...partnerAuthHeaders },
    body: JSON.stringify({ settings: { defaults: {
      defaultEnrollmentTtlMinutes: 10080,
      maxEnrollmentLinkTtlMinutes: 43200,
    } } }),
  });
  expect(res.status).toBe(200);
  expect(updatedSettings.defaults.defaultEnrollmentTtlMinutes).toBe(10080);
  expect(updatedSettings.defaults.maxEnrollmentLinkTtlMinutes).toBe(43200);
});

it('lets an org override the partner TTL default without a 403', async () => {
  mockPartnerLocked(['defaults.defaultEnrollmentTtlMinutes']);
  const res = await app.request('/orgs/organizations/org-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ settings: { defaults: { defaultEnrollmentTtlMinutes: 60 } } }),
  });
  expect(res.status).toBe(200);
});

it('403s when an org tries to set the partner-owned cap', async () => {
  mockPartnerLocked(['defaults.maxEnrollmentLinkTtlMinutes']);
  const res = await app.request('/orgs/organizations/org-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ settings: { defaults: { maxEnrollmentLinkTtlMinutes: 525600 } } }),
  });
  expect(res.status).toBe(403);
});

it('400s on an out-of-range org enrollment default (org settings are z.any())', async () => {
  const res = await app.request('/orgs/organizations/org-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ settings: { defaults: { defaultEnrollmentTtlMinutes: 525601 } } }),
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/orgs.test.ts -t enrollment
```
Expected: FAIL — the partner test loses the fields (Zod strips unknown keys), the org override 403s, and the out-of-range test returns 200.

- [ ] **Step 3: Implement**

Extend the partner `defaults` Zod block at `orgs.ts:454-479` with the three fields from `enrollmentDefaultsSchema` — the block has no `.passthrough()`, so unlisted keys are silently stripped:

```ts
    defaultEnrollmentTtlMinutes: z.number().int().min(1).max(MAX_ENROLLMENT_TTL_MINUTES).optional(),
    defaultEnrollmentDeviceCount: z.number().int().min(1).max(MAX_ENROLLMENT_DEVICE_COUNT).optional(),
    maxEnrollmentLinkTtlMinutes: z.number().int().min(1).max(MAX_ENROLLMENT_TTL_MINUTES).optional(),
```

Extend the lock exemption at `:1326-1327`:

```ts
        // Issue #2124: `agentVersionPins` is INHERIT-WITH-OVERRIDE, not partner-
        // locked ... (existing comment retained verbatim)
        //
        // Issue #2776: the two enrollment default VALUES are likewise
        // inherit-with-override — a partner sets a house default, an org may
        // deviate for a customer with different staging needs. The CAP
        // (maxEnrollmentLinkTtlMinutes) is deliberately NOT exempt: a ceiling
        // an org can raise is not a ceiling.
        if (category === 'defaults') {
          fields = fields.filter((f) =>
            f !== 'agentVersionPins' &&
            f !== 'defaultEnrollmentTtlMinutes' &&
            f !== 'defaultEnrollmentDeviceCount',
          );
        }
```

The org `settings` blob is `z.any()` (`orgs.ts:168-179`), so nothing validates it. Add an explicit check beside the existing `validateAgentVersionPins` call at `:1310`:

```ts
    // The org `settings` blob is z.any(), so validate explicitly — same reason
    // maintenanceWindow and agentVersionPins are hand-checked here.
    const enrollmentParsed = enrollmentDefaultsSchema.safeParse(
      (settingsObj.defaults ?? {}) as Record<string, unknown>,
    );
    if (!enrollmentParsed.success) {
      return c.json({ error: 'Invalid enrollment defaults', details: enrollmentParsed.error.issues }, 400);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/orgs.test.ts
```
Expected: PASS, including the existing version-pin lock-exemption cases at `:1633-1739`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/orgs.ts apps/api/src/routes/orgs.test.ts
git commit -m "feat(api): accept enrollment defaults; exempt values from partner lock, keep cap locked (#2776)"
```

### Task 3.4: Enforce the cap at the mint routes

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts` (installer download `:970`, installer-link `:1524`, bootstrap-token `:1458`), `apps/api/src/routes/devices/core.ts`
- Test: `apps/api/src/routes/enrollmentKeys.test.ts`

**Interfaces:**
- Consumes: `getEnrollmentDefaultsForOrg` (Task 3.2)
- Produces: 400 `{ error: 'ttlMinutes exceeds the partner maximum of N minutes' }`

- [ ] **Step 1: Write the failing test**

```ts
it('rejects a ttlMinutes above the partner cap', async () => {
  mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
  const res = await app.request('/enrollment-keys/key-1/installer-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ platform: 'windows', count: 1, ttlMinutes: 43200 }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain('1440');
});

it('allows a ttlMinutes at exactly the cap', async () => {
  mockEnrollmentDefaults({ maxTtlMinutes: 1440 });
  const res = await app.request('/enrollment-keys/key-1/installer-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders },
    body: JSON.stringify({ platform: 'windows', count: 1, ttlMinutes: 1440 }),
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/enrollmentKeys.test.ts -t 'partner cap'
```
Expected: FAIL — 200 with a 30-day link.

- [ ] **Step 3: Implement**

Add a helper in `apps/api/src/routes/enrollmentKeys.ts` near `parentKeyTooCloseToExpiry` (`:134`):

```ts
/**
 * Reject — never clamp — a TTL above the partner ceiling. Silently reducing a
 * chosen expiry is precisely the failure mode of #2775; a 400 that names the
 * cap is the only honest response. The UI hides out-of-range options, so this
 * is defense in depth rather than a routine path.
 */
async function assertTtlWithinCap(orgId: string, ttlMinutes: number | undefined) {
  if (ttlMinutes === undefined) return null;
  const { maxTtlMinutes } = await getEnrollmentDefaultsForOrg(orgId);
  if (ttlMinutes > maxTtlMinutes) {
    return `ttlMinutes exceeds the partner maximum of ${maxTtlMinutes} minutes`;
  }
  return null;
}
```

Call it after the parent key is loaded (so `orgId` is known) in the installer download route, the installer-link route, and the bootstrap-token route:

```ts
    const capError = await assertTtlWithinCap(key.orgId, childTtlMinutes);
    if (capError) return c.json({ error: capError }, 400);
```

Do the same in `POST /devices/onboarding-token` (`devices/core.ts`) after org resolution at `:287-307`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/api exec vitest run src/routes/enrollmentKeys.test.ts src/routes/devices.test.ts
pnpm --filter=@breeze/api exec tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/devices/core.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "feat(api): reject enrollment link TTLs above the partner cap (#2776)"
```

### Task 3.5: Settings UI for both scopes

**Files:**
- Modify: `apps/web/src/components/settings/PartnerDefaultsTab.tsx`
- Modify: `apps/web/src/components/settings/OrgDefaultsEditor.tsx:43-55` (local `DefaultsData` type), `:184-196` (`handleSave`), `:483` area (props)
- Modify: `apps/web/src/components/settings/OrgSettingsPage.tsx:701-708` (thread `locked`)
- Test: `apps/web/src/components/settings/OrgDefaultsEditor.test.tsx`

**Interfaces:**
- Consumes: `InheritableDefaultSettings` (Task 3.1)
- Produces: partner tab renders all three fields; org editor renders the two values

> **Trap:** `OrgDefaultsEditor` keeps a *duplicated* local `DefaultsData` type at `:43-55` and does **not** import `InheritableDefaultSettings`. `handleSave` at `:184-196` rebuilds the whole object field by field — a field missing there is silently dropped on every save. Update both.
>
> **Trap:** `OrgSettingsPage.tsx:701-708` does not currently pass `locked` to `OrgDefaultsEditor`, unlike branding/notifications/security. Without threading it, a locked field 403s on save with no UI affordance.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/settings/OrgDefaultsEditor.test.tsx`:

```tsx
it('includes the enrollment defaults in the saved payload', async () => {
  const onSave = vi.fn();
  render(<OrgDefaultsEditor data={{}} onSave={onSave} locked={[]} />);

  await userEvent.selectOptions(
    screen.getByTestId('org-default-enrollment-ttl'), '10080',
  );
  await userEvent.click(screen.getByTestId('org-defaults-save'));

  expect(onSave).toHaveBeenCalledWith(
    expect.objectContaining({ defaultEnrollmentTtlMinutes: 10080 }),
  );
});

it('disables a field the partner has locked', () => {
  render(
    <OrgDefaultsEditor
      data={{}}
      onSave={vi.fn()}
      locked={['defaults.maxEnrollmentLinkTtlMinutes']}
    />,
  );
  expect(screen.queryByTestId('org-max-enrollment-ttl')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/settings/OrgDefaultsEditor.test.tsx
```
Expected: FAIL — testids absent, `locked` not a prop.

- [ ] **Step 3: Implement**

In `PartnerDefaultsTab.tsx`, add three fields following the existing `set()` pattern at `:75-84`:

```tsx
      <div className="space-y-2">
        <label htmlFor="partner-enrollment-ttl" className="text-sm font-medium">
          {t('partnerDefaults.enrollmentTtl')}
        </label>
        <select
          id="partner-enrollment-ttl"
          data-testid="partner-enrollment-ttl"
          value={data.defaultEnrollmentTtlMinutes ?? ''}
          onChange={e => set({
            defaultEnrollmentTtlMinutes: e.target.value ? Number(e.target.value) : undefined,
          })}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{t('partnerDefaults.notSet')}</option>
          {ENROLLMENT_TTL_OPTIONS.map(m => (
            <option key={m} value={m}>{t(ENROLLMENT_TTL_I18N_KEYS[m])}</option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t('partnerDefaults.enrollmentTtlHint')}
        </p>
      </div>
```

Repeat for `defaultEnrollmentDeviceCount` (number input, 1..1000) and `maxEnrollmentLinkTtlMinutes` (same select, with a hint saying orgs cannot raise it).

In `OrgDefaultsEditor.tsx`: add both value fields to the local `DefaultsData` type at `:43-55`, add `useState` for each, add them to the `handleSave` rebuild at `:184-196`, add a `locked?: string[]` prop, and add the `isLocked` helper used by the sibling editors (`OrgSecuritySettings.tsx:45`):

```tsx
  const isLocked = (field: string) => locked?.includes(`defaults.${field}`) ?? false;
```

Render the cap read-only (or omit it) when partner-set. Thread `locked={locked}` at `OrgSettingsPage.tsx:701-708`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/settings/
pnpm --filter=@breeze/web exec tsc --noEmit
```
Expected: PASS, including the 7 pre-existing maintenance-window cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/
git commit -m "feat(web): enrollment default settings on partner and org tabs (#2776)"
```

### Task 3.6: Seed the Add Device modal from resolved defaults

**Files:**
- Modify: `apps/web/src/components/devices/AddDeviceModal.tsx` (`deviceCount` `:124`, `ttlMinutes` `:133`, `cliTtlMinutes` from Task 1.2, both selects)
- Modify: `apps/api/src/routes/orgs.ts` — expose the resolved values on an existing org read so the modal has them without a new round trip
- Test: `apps/web/src/components/devices/AddDeviceModal.test.tsx`

**Interfaces:**
- Consumes: `getEnrollmentDefaultsForOrg` (Task 3.2)

- [ ] **Step 1: Write the failing test**

```tsx
it('pre-selects the partner default TTL and hides options above the cap', async () => {
  mockEnrollmentDefaults({ ttlMinutes: 10080, deviceCount: 25, maxTtlMinutes: 43200 });
  render(<AddDeviceModal isOpen onClose={() => {}} />);

  await waitFor(() =>
    expect((screen.getByTestId('link-ttl') as HTMLSelectElement).value).toBe('10080'),
  );
  expect((screen.getByTestId('device-count') as HTMLInputElement).value).toBe('25');
  // 90d and 1y are above the 30d cap
  expect(screen.queryByRole('option', { name: /90 days/i })).toBeNull();
  expect(screen.queryByRole('option', { name: /1 year/i })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/devices/AddDeviceModal.test.tsx -t 'pre-selects'
```
Expected: FAIL — value is the hardcoded `1440`.

- [ ] **Step 3: Implement**

Add the resolved defaults to the org payload the modal already fetches (do not add a new endpoint — the modal is on the device-add hot path). Initialise the three pieces of state from it, and filter both option lists:

```tsx
  const ttlOptions = ENROLLMENT_TTL_OPTIONS.filter(m => m <= (defaults?.maxTtlMinutes ?? MAX_ENROLLMENT_TTL_MINUTES));
```

Guard against a stale selection when the cap tightens: if `ttlMinutes > maxTtlMinutes`, reset to `maxTtlMinutes`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter=@breeze/web exec vitest run src/components/devices/AddDeviceModal.test.tsx
pnpm --filter=@breeze/web exec tsc --noEmit
```
Expected: PASS.

- [ ] **Step 5: Resolve the dangling comment**

Delete the now-obsolete note at `AddDeviceModal.tsx:130-132` about `maxEnrollmentLinkTtlMinutes` landing "in a sibling PR" and replace it with a pointer to the shipped cap, noting that "Never expires" remains deferred and why (see Decision Record #2).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/AddDeviceModal.tsx apps/web/src/components/devices/AddDeviceModal.test.tsx
git commit -m "feat(web): seed Add Device pickers from partner/org enrollment defaults (#2776)"
```

### Task 3.7: Document the undocumented env vars

`CHILD_ENROLLMENT_KEY_TTL_MINUTES`, `INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES` and `INSTALLER_PARENT_MIN_REMAINING_SECONDS` are live knobs with no `.env.example` entry. Only `ENROLLMENT_KEY_DEFAULT_TTL_MINUTES` is documented (`.env.example:322`).

**Files:**
- Modify: `.env.example`, `apps/docs/src/content/docs/deploy/environment.mdx`, `apps/docs/src/content/docs/agents/enrollment-keys.mdx`

- [ ] **Step 1: Add the entries**

Add all three beside the existing `ENROLLMENT_KEY_DEFAULT_TTL_MINUTES` entry, each with its default and a one-line description. In `enrollment-keys.mdx`, document the new partner-level defaults and cap, and state plainly that a TTL above the cap is rejected rather than reduced.

- [ ] **Step 2: Verify the docs build**

```bash
pnpm --filter=@breeze/docs build
```
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add .env.example apps/docs/src/content/docs
git commit -m "docs: document enrollment TTL env vars and partner defaults (#2776)"
```

---

## Verification Before Each PR

```bash
pnpm --filter=@breeze/api exec tsc --noEmit
pnpm --filter=@breeze/web exec tsc --noEmit
pnpm --filter=@breeze/shared exec tsc --noEmit
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/web
pnpm test --filter=@breeze/shared
```

PR 2 additionally requires the integration suite against a real database:

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter=@breeze/api exec vitest run --config vitest.integration.config.ts
```

No task in this plan adds a tenant-scoped table, so the RLS and cascade contracts are untouched — but if any implementer finds themselves writing a migration, stop and escalate: that is a signal the design drifted.

## Manual QA (after PR 2 and PR 3)

1. Add Device → Download Installer → pick **30 days** → download the MSI.
2. Confirm in the DB that the token's TTL is 30 days, not 60 minutes:
   ```sql
   SELECT id, created_at, expires_at, expires_at - created_at AS ttl
   FROM installer_bootstrap_tokens ORDER BY created_at DESC LIMIT 1;
   ```
   Expected `ttl`: `30 days`. Pre-fix this reads `00:59:59`.
3. Wait past the 60-minute parent expiry, then run the installer. It must enroll — this is the #2775 regression, and the behaviour change from Task 2.3.
4. Delete the parent enrollment key, then run a second copy of the installer. It must fail — this proves cascade revocation still works without the TTL cap.
5. Set a partner cap of 24 hours; confirm the modal no longer offers 7d/30d/90d/1y, and that a forged request with `ttlMinutes: 43200` returns 400 naming the cap.
6. Set a partner default of 7 days, then override one org to 1 hour; confirm the modal reflects each and that the org save does not 403.

## Follow-ups Deliberately Excluded

- **"Never expires"** — needs a migration on `installer_bootstrap_tokens.expires_at` plus null-handling through issuance, consume, the cleanup job, and the expiry UI. Track on #2776.
- **The `effective-settings` lock wart** — `GET /orgs/organizations/:id/effective-settings` reports inherit-with-override fields as `locked` and returns a non-runtime-effective value. `OrgSettingsPage.tsx:296-306` depends on that behaviour, so fixing it properly needs a shared `INHERIT_WITH_OVERRIDE_FIELDS` set consumed by both `mergeCategory` and the lock loop, plus a UI change. File separately.
- **Revocation discoverability** — after Task 2.3, an admin seeing an expired parent key in `EnrollmentKeyManager` may wrongly assume its installers are dead. Surfacing outstanding bootstrap tokens per key (with a revoke action) is the real fix. File separately.
- **`AddDeviceModal` `runAction` adoption** — the modal predates the convention and is allowlisted. Out of scope.
