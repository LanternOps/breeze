# WS-A Action Feedback & Error Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make targeted action surfaces always tell the user the outcome (readable success/failure, including HTTP-200-with-failure bodies) via one shared `runAction` helper, persist notification-channel test results, and add a lightweight guard against regression.

**Architecture:** A new `runAction` helper wraps `fetchWithAuth` + an extended `extractApiError`/`isApiFailure` + the existing `showToast` singleton, throwing a typed `ActionError`. The notification-channel test endpoint gains `last_tested_at`/`last_test_status` persistence (frontend already renders them). Targeted high-traffic mutation handlers adopt `runAction`; a scoped test guards the pattern.

**Tech Stack:** TypeScript, React (Astro islands), Hono API, Drizzle ORM, Vitest (+ jsdom for web), Zustand. Spec: `docs/superpowers/specs/2026-05-15-ws-a-action-feedback-design.md`.

**Working dir:** worktree `feat/ws-a-action-feedback`. Run web tests from `apps/web`, api tests from `apps/api`.

---

### Task 1: Extend `extractApiError` with `isApiFailure` + `{success:false}`/`testResult` shapes

**Files:**
- Modify: `apps/web/src/lib/apiError.ts`
- Test: `apps/web/src/lib/apiError.test.ts`

- [ ] **Step 1: Read current behavior**

Read `apps/web/src/lib/apiError.ts` fully and `apps/web/src/lib/apiError.test.ts` if it exists. Confirm `extractApiError(data: unknown, fallback: string): string` and its existing shape handling. Do NOT change existing branches.

- [ ] **Step 2: Write failing tests**

Append to `apps/web/src/lib/apiError.test.ts` (create it if absent, mirroring existing test style — `import { describe, it, expect } from 'vitest'`):

```ts
import { extractApiError, isApiFailure } from './apiError';

describe('isApiFailure', () => {
  it('true when http status >= 400', () => {
    expect(isApiFailure({}, 400)).toBe(true);
    expect(isApiFailure({}, 500)).toBe(true);
  });
  it('true when body.success === false even on 200', () => {
    expect(isApiFailure({ success: false, message: 'nope' }, 200)).toBe(true);
  });
  it('true when testResult.success === false on 200', () => {
    expect(isApiFailure({ testResult: { success: false, message: 'bad token' } }, 200)).toBe(true);
  });
  it('false for a normal 200 success body', () => {
    expect(isApiFailure({ data: [1, 2] }, 200)).toBe(false);
    expect(isApiFailure({ success: true }, 200)).toBe(false);
    expect(isApiFailure(null, 200)).toBe(false);
  });
});

describe('extractApiError — new shapes', () => {
  it('reads {success:false, message}', () => {
    expect(extractApiError({ success: false, message: 'Invalid token' }, 'fb')).toBe('Invalid token');
  });
  it('reads {testResult:{success:false, message}}', () => {
    expect(extractApiError({ testResult: { success: false, message: 'application token is invalid' } }, 'fb'))
      .toBe('application token is invalid');
  });
  it('still honors existing {error} shape (regression)', () => {
    expect(extractApiError({ error: 'boom' }, 'fb')).toBe('boom');
  });
  it('falls back when nothing parses', () => {
    expect(extractApiError({ weird: 1 }, 'fallback msg')).toBe('fallback msg');
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd apps/web && npx vitest run src/lib/apiError.test.ts`
Expected: FAIL — `isApiFailure` is not exported; new-shape `extractApiError` cases return the fallback.

- [ ] **Step 4: Implement `isApiFailure` and extend `extractApiError`**

In `apps/web/src/lib/apiError.ts` add:

```ts
export function isApiFailure(data: unknown, httpStatus: number): boolean {
  if (httpStatus >= 400) return true;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d.success === false) return true;
    const tr = d.testResult as { success?: unknown } | undefined;
    if (tr && typeof tr === 'object' && tr.success === false) return true;
  }
  return false;
}
```

In `extractApiError`, immediately **before** the final `return fallback;`, insert (do not alter earlier branches):

```ts
if (data && typeof data === 'object') {
  const d = data as Record<string, unknown>;
  const tr = d.testResult as { message?: unknown } | undefined;
  if (tr && typeof tr === 'object' && typeof tr.message === 'string' && tr.message.trim()) {
    return tr.message;
  }
  if (d.success === false && typeof d.message === 'string' && d.message.trim()) {
    return d.message;
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/web && npx vitest run src/lib/apiError.test.ts`
Expected: PASS (all, including the regression case).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/apiError.ts apps/web/src/lib/apiError.test.ts
git commit -m "feat(web): isApiFailure + extractApiError handles {success:false}/testResult (#720)"
```

---

### Task 2: Add `runAction` helper + `ActionError`

**Files:**
- Create: `apps/web/src/lib/runAction.ts`
- Test: `apps/web/src/lib/runAction.test.ts`

- [ ] **Step 1: Confirm dependencies' import paths**

Confirm `showToast` is exported from `apps/web/src/components/shared/Toast.tsx` with signature `showToast({ message, type }: { message: string; type: 'success'|'error'|'undo'; onUndo?: () => void; duration?: number })`. Confirm `extractApiError`/`isApiFailure` from `apps/web/src/lib/apiError.ts`.

- [ ] **Step 2: Write failing tests**

Create `apps/web/src/lib/runAction.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const showToast = vi.fn();
vi.mock('../components/shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

import { runAction, ActionError } from './runAction';

function res(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => showToast.mockReset());

describe('runAction', () => {
  it('returns parsed data and toasts success when successMessage given', async () => {
    const out = await runAction<{ id: string }>({
      request: async () => res({ id: 'x' }),
      successMessage: 'Done',
      errorFallback: 'fb',
    });
    expect(out).toEqual({ id: 'x' });
    expect(showToast).toHaveBeenCalledWith({ message: 'Done', type: 'success' });
  });

  it('no success toast when successMessage omitted', async () => {
    await runAction({ request: async () => res({ ok: 1 }), errorFallback: 'fb' });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('toasts + throws ActionError on !ok with readable message', async () => {
    await expect(runAction({
      request: async () => res({ error: 'boom', code: 'X' }, 422),
      errorFallback: 'fb',
    })).rejects.toBeInstanceOf(ActionError);
    expect(showToast).toHaveBeenCalledWith({ message: 'boom', type: 'error' });
  });

  it('treats 200 + {success:false} as failure', async () => {
    await expect(runAction({
      request: async () => res({ success: false, message: 'nope' }, 200),
      errorFallback: 'fb',
    })).rejects.toMatchObject({ message: 'nope' });
    expect(showToast).toHaveBeenCalledWith({ message: 'nope', type: 'error' });
  });

  it('treats 200 + {testResult:{success:false}} as failure', async () => {
    await expect(runAction({
      request: async () => res({ testResult: { success: false, message: 'bad token' } }, 200),
      errorFallback: 'fb',
    })).rejects.toMatchObject({ message: 'bad token' });
  });

  it('applies friendly(code) when provided', async () => {
    await expect(runAction({
      request: async () => res({ error: 'raw', code: 'NO_MACS' }, 412),
      errorFallback: 'fb',
      friendly: (c) => (c === 'NO_MACS' ? 'No MAC on file' : undefined),
    })).rejects.toMatchObject({ code: 'NO_MACS', message: 'No MAC on file' });
    expect(showToast).toHaveBeenCalledWith({ message: 'No MAC on file', type: 'error' });
  });

  it('calls onUnauthorized and throws on 401', async () => {
    const onUnauthorized = vi.fn();
    await expect(runAction({
      request: async () => res({ error: 'unauth' }, 401),
      errorFallback: 'fb',
      onUnauthorized,
    })).rejects.toBeInstanceOf(ActionError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('non-JSON body -> fallback message', async () => {
    await expect(runAction({
      request: async () => new Response('<html>', { status: 500 }),
      errorFallback: 'Server error',
    })).rejects.toMatchObject({ message: 'Server error' });
  });

  it('network reject -> fallback toast + ActionError status 0', async () => {
    await expect(runAction({
      request: async () => { throw new Error('network down'); },
      errorFallback: 'Network error',
    })).rejects.toMatchObject({ message: 'Network error', status: 0 });
    expect(showToast).toHaveBeenCalledWith({ message: 'Network error', type: 'error' });
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd apps/web && npx vitest run src/lib/runAction.test.ts`
Expected: FAIL — `./runAction` module not found.

- [ ] **Step 4: Implement `runAction.ts`**

Create `apps/web/src/lib/runAction.ts`:

```ts
import { showToast } from '../components/shared/Toast';
import { extractApiError, isApiFailure } from './apiError';

export class ActionError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ActionError';
    this.status = status;
    this.code = code;
  }
}

export interface RunActionOptions<T> {
  request: () => Promise<Response>;
  errorFallback: string;
  successMessage?: string | ((data: T) => string);
  parseSuccess?: (data: unknown) => T;
  friendly?: (code: string) => string | undefined;
  onUnauthorized?: () => void;
}

export async function runAction<T = unknown>(opts: RunActionOptions<T>): Promise<T> {
  let response: Response;
  try {
    response = await opts.request();
  } catch {
    showToast({ message: opts.errorFallback, type: 'error' });
    throw new ActionError(opts.errorFallback, 0);
  }

  if (response.status === 401) {
    if (opts.onUnauthorized) opts.onUnauthorized();
    throw new ActionError('Unauthorized', 401);
  }

  const data: unknown = await response.json().catch(() => null);

  if (isApiFailure(data, response.status)) {
    let message = extractApiError(data, opts.errorFallback);
    const code = (data && typeof data === 'object'
      ? (data as Record<string, unknown>).code
      : undefined) as string | undefined;
    if (code && opts.friendly) {
      const friendly = opts.friendly(code);
      if (friendly) message = friendly;
    }
    showToast({ message, type: 'error' });
    throw new ActionError(message, response.status, code);
  }

  const result = (opts.parseSuccess ? opts.parseSuccess(data) : (data as T));
  if (opts.successMessage) {
    const msg = typeof opts.successMessage === 'function'
      ? opts.successMessage(result)
      : opts.successMessage;
    showToast({ message: msg, type: 'success' });
  }
  return result;
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/web && npx vitest run src/lib/runAction.test.ts`
Expected: PASS (all 9).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/runAction.ts apps/web/src/lib/runAction.test.ts
git commit -m "feat(web): add runAction helper + ActionError (#720)"
```

---

### Task 3: Backend — persist notification-channel test result

**Files:**
- Create: `apps/api/migrations/2026-05-15-notification-channel-test-result.sql`
- Modify: `apps/api/src/db/schema/alerts.ts` (the `notificationChannels` table def, ~lines 92-102)
- Modify: `apps/api/src/routes/alerts/channels.ts` (test endpoint ~306-609, and `toChannelResponse`)
- Test: `apps/api/src/routes/alerts/channels.test.ts` (or the existing channels test file — locate it)

- [ ] **Step 1: Write the idempotent migration**

Create `apps/api/migrations/2026-05-15-notification-channel-test-result.sql`:

```sql
-- WS-A (#720): persist notification-channel test outcome so the UI can show
-- last-tested status instead of a permanent "Never tested".
ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz;
ALTER TABLE notification_channels
  ADD COLUMN IF NOT EXISTS last_test_status varchar(16);
```

(notification_channels is org-scoped via `org_id` — RLS shape 1 — so existing policies cover the new columns; no allowlist change. No inner BEGIN/COMMIT.)

- [ ] **Step 2: Verify the migration sorts last & applies**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts`
Expected: PASS (filename sorts after `2026-05-14-b-*`). If a real DB is available also run `pnpm db:check-drift` after Step 3.

- [ ] **Step 3: Add columns to the Drizzle schema**

In `apps/api/src/db/schema/alerts.ts`, inside the `notificationChannels` `pgTable(...)` definition, add (match the file's column style; `timestamp`/`varchar` are already imported there):

```ts
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastTestStatus: varchar('last_test_status', { length: 16 }),
```

- [ ] **Step 4: Write the failing API test**

Locate the channels route test (e.g. `apps/api/src/routes/alerts/channels.test.ts`). Add a test asserting the test endpoint persists status and `toChannelResponse` returns it. Mirror the file's existing Drizzle-mock harness; assert: after `POST /alerts/channels/:id/test` the handler issues an `update(notificationChannels)` with `lastTestedAt`/`lastTestStatus`, and the channel list response includes `lastTestedAt`/`lastTestStatus`. (Use the existing mock-capture pattern in that file; if it asserts on `db.update` mock calls, assert the `.set(...)` payload contains `lastTestStatus: 'failed'` for a failing `testResult` and `'success'` otherwise.)

- [ ] **Step 5: Run it, verify fail**

Run: `cd apps/api && npx vitest run src/routes/alerts/channels.test.ts`
Expected: FAIL — handler does not update those columns / response lacks the fields.

- [ ] **Step 6: Persist in the test endpoint + expose in response**

In `apps/api/src/routes/alerts/channels.ts`, after `testResult` is computed and before returning, within the existing request DB context add:

```ts
await db.update(notificationChannels)
  .set({
    lastTestedAt: new Date(),
    lastTestStatus: testResult.success ? 'success' : 'failed',
  })
  .where(eq(notificationChannels.id, channel.id));
```

(Use the file's existing `db`, `eq`, `notificationChannels` imports — add `notificationChannels` to the schema import if not already present.) In `toChannelResponse`, add `lastTestedAt` and `lastTestStatus` to the returned object (the web `NotificationChannelList` already consumes `lastTestedAt`/`lastTestStatus`).

- [ ] **Step 7: Run tests, verify pass**

Run: `cd apps/api && npx vitest run src/routes/alerts/channels.test.ts src/db/autoMigrate.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-05-15-notification-channel-test-result.sql apps/api/src/db/schema/alerts.ts apps/api/src/routes/alerts/channels.ts apps/api/src/routes/alerts/channels.test.ts
git commit -m "feat(api): persist notification-channel last_tested_at/status (#720)"
```

---

### Task 4: Fix `NotificationChannelsPage.handleTest` (silent failure)

**Files:**
- Modify: `apps/web/src/components/alerts/NotificationChannelsPage.tsx` (`handleTest`, ~lines 99-119)
- Test: `apps/web/src/components/alerts/NotificationChannelsPage.test.tsx` (create if absent)

- [ ] **Step 1: Read the current handler**

Read `NotificationChannelsPage.tsx:99-130` and how `fetchChannels`, `setError`, and the 401 redirect (`navigateTo`) are used. Note the existing imports.

- [ ] **Step 2: Write failing test**

Create/extend `apps/web/src/components/alerts/NotificationChannelsPage.test.tsx`. Mock `showToast` and `fetchWithAuth`; render the page (or unit-test an extracted `handleTest` if the component is hard to mount — prefer extracting `handleTest` into a small testable function if needed). Assert: when the test endpoint returns `200 {testResult:{success:false,message:'application token is invalid'}}`, an error toast with that message is shown; when it returns `{testResult:{success:true}}`, a success toast is shown and `fetchChannels` is called. (Follow existing component-test patterns in `apps/web/src/components`.)

- [ ] **Step 3: Run it, verify fail**

Run: `cd apps/web && npx vitest run src/components/alerts/NotificationChannelsPage.test.tsx`
Expected: FAIL — current handler only checks `response.ok`, shows no toast on `testResult.success:false`.

- [ ] **Step 4: Rewrite `handleTest` using `runAction`**

Replace the body of `handleTest` with:

```ts
const handleTest = async (channel: { id: string; name: string }) => {
  try {
    await runAction<{ testResult?: { success: boolean; message?: string } }>({
      request: () => fetchWithAuth(`/alerts/channels/${channel.id}/test`, { method: 'POST' }),
      successMessage: `Test notification sent to "${channel.name}"`,
      errorFallback: 'Channel test failed',
      onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
    });
    await fetchChannels();
  } catch {
    // runAction already toasted + the card will reflect last_tested_at after refetch
    await fetchChannels();
  }
};
```

Add `import { runAction } from '../../lib/runAction';` (adjust relative depth to match the file). Remove the now-unused inline `setError`-only path if it was solely for test failures (keep `setError` if used elsewhere).

- [ ] **Step 5: Run tests, verify pass**

Run: `cd apps/web && npx vitest run src/components/alerts/NotificationChannelsPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/alerts/NotificationChannelsPage.tsx apps/web/src/components/alerts/NotificationChannelsPage.test.tsx
git commit -m "fix(web): channel Test surfaces pass/fail via runAction (#720, #725)"
```

---

### Task 5: Fix `deviceActions.ts` parser + patch-scan handler

**Files:**
- Modify: `apps/web/src/services/deviceActions.ts:16-23`
- Modify: the Patches page Run-Scan handler (locate: `apps/web/src/components/**` rendering `/patches` Run Scan — grep `patches/scan` / `Run Scan`)
- Test: extend `apps/web/src/services/deviceActions.test.ts` if present; add a focused test for the patch-scan handler

- [ ] **Step 1: Replace the weak parser in `deviceActions.ts`**

In `deviceActions.ts` lines ~16-23, replace the local `data?.error || data?.message || fallback` extraction with `extractApiError(data, fallback)` (import from `../lib/apiError`). Keep `WakeCommandError`/`wakeFriendlyErrorMessage` untouched.

- [ ] **Step 2: Write failing test for the parser change**

Add a test asserting a zod-style `{error:{issues:[{message:'bad'}]}}` body now yields `'bad'` (not `[object Object]`/fallback) through the device-action error path.

Run: `cd apps/web && npx vitest run src/services/deviceActions.test.ts` — Expected: FAIL then PASS after Step 1.

- [ ] **Step 3: Route the patch Run-Scan handler through `runAction`**

In the Patches Run-Scan handler, wrap the scan POST:

```ts
await runAction({
  request: () => fetchWithAuth(`/patches/scan${orgQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scanBody),
  }),
  successMessage: (d: { deviceCount?: number }) =>
    `Patch scan queued for ${d?.deviceCount ?? 0} device(s)`,
  errorFallback: 'Patch scan failed',
});
```

Because `runAction` treats `{success:false}` as failure, the merged backend (#734/#727) `success:false` now surfaces an error toast instead of a misleading "queued for 0 devices".

- [ ] **Step 4: Test + run**

Add a focused test: scan endpoint returns `{success:false, error:'no devices'}` → error toast (not success). Run the relevant vitest file; Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/deviceActions.ts apps/web/src/components apps/web/src/services/deviceActions.test.ts
git commit -m "fix(web): readable device-action errors + patch-scan failure surfaced (#727, #678)"
```

---

### Task 6: Adopt `runAction` in targeted high-traffic handlers

**Files (modify; migrate one file per commit):**
- `apps/web/src/components/devices/DevicesPage.tsx` (non-Wake actions in the action switch ~273-300)
- `apps/web/src/components/devices/DeviceDetailPage.tsx` (action handlers ~150-180)
- `apps/web/src/components/devices/DeviceActions.tsx`
- `apps/web/src/components/alerts/NotificationChannelsPage.tsx` (create/update/delete + routing-rule handlers)
- `apps/web/src/components/settings/PartnerSettingsPage.tsx` (save handler)

**Transform recipe (apply per handler — do NOT change Wake):**

For a handler currently shaped `try { const res = await fetchWithAuth(url,{method}); if(!res.ok){ const d=await res.json().catch(()=>null); throw new Error(extractApiError(d,'…')); } /* success */ } catch(e){ setError/showToast/nothing }`, replace the fetch+parse+manual-toast with:

```ts
await runAction({
  request: () => fetchWithAuth(url, { method, headers, body }),
  successMessage: '<concise success copy>',
  errorFallback: '<concise fallback>',
  onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
});
// then existing post-success refetch/state update
```

Keep any post-success refetch/navigation. Remove now-dead `if(!res.ok)` branches and redundant `setError`-only error display where `runAction`'s toast replaces it (leave inline form-field validation regions intact).

- [ ] **Step 1 (per file): Read the handler(s), identify each mutation call**
- [ ] **Step 2 (per file): Apply the recipe; add `runAction` import**
- [ ] **Step 3 (per file): Add/extend a component test** asserting success shows a success toast and a `{error}`/`{success:false}` response shows an error toast (mirror Task 4's test approach)
- [ ] **Step 4 (per file): Run** `cd apps/web && npx vitest run <that file's test>` — Expected: PASS
- [ ] **Step 5 (per file): Commit** `git commit -m "refactor(web): <file> mutations use runAction (#720)"`

Repeat Steps 1-5 for each file in the Files list above (5 commits).

---

### Task 7: Recurrence guardrail test

**Files:**
- Create: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`
- Create: `apps/web/src/lib/runActionAllowlist.ts`

- [ ] **Step 1: Define the allowlist**

Create `apps/web/src/lib/runActionAllowlist.ts`:

```ts
// Files in the targeted set permitted to call fetchWithAuth with a mutating
// method WITHOUT runAction, with the reason. Keep this list short and justified.
export const RUN_ACTION_ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
  { file: 'apps/web/src/services/deviceActions.ts', reason: 'typed Wake service (WakeCommandError) — the pattern runAction generalizes' },
  { file: 'apps/web/src/stores/auth.ts', reason: 'transport/auth store, not a UI action handler' },
];
```

- [ ] **Step 2: Write the guard test**

Create `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import { RUN_ACTION_ALLOWLIST } from '../runActionAllowlist';

// Targeted set only (the directories WS-A adopted). Expand deliberately.
const TARGET_GLOBS = [
  'src/components/devices/**/*.tsx',
  'src/components/alerts/**/*.tsx',
  'src/components/settings/PartnerSettingsPage.tsx',
];
const allow = new Set(RUN_ACTION_ALLOWLIST.map((a) => a.file));
const MUT = /fetchWithAuth\s*\([^)]*\{[^}]*method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/s;

describe('no silent mutations in targeted set', () => {
  const files = TARGET_GLOBS.flatMap((g) => globSync(g, { cwd: process.cwd() }));
  it('finds files to scan', () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    const rel = `apps/web/${f}`;
    if (allow.has(rel)) continue;
    it(`${f}: every mutating fetchWithAuth is inside runAction`, () => {
      const src = readFileSync(f, 'utf8');
      if (!MUT.test(src)) return; // no mutations -> fine
      // Heuristic: any mutating fetchWithAuth must co-occur with runAction in the file.
      expect(src.includes('runAction(')).toBe(true);
    });
  }
});
```

(If `glob` isn't already a dev dep, use `fast-glob` or `node:fs` recursion to match the repo's existing test utilities — check `apps/web/package.json` first and use what's present.)

- [ ] **Step 3: Run the guard**

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS after Tasks 4-6 (all targeted files route mutations through `runAction` or are allowlisted). If it fails, it correctly caught a missed handler — fix that handler, not the test.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/lib/runActionAllowlist.ts
git commit -m "test(web): guard targeted set against silent mutations (#720)"
```

---

### Task 8: Full suite + docs note

- [ ] **Step 1: Run targeted suites**

Run: `cd apps/web && npx vitest run src/lib src/components/alerts src/components/devices src/services` then `cd ../api && npx vitest run src/routes/alerts src/db/autoMigrate.test.ts`
Expected: PASS.

- [ ] **Step 2: Document the pattern**

Add a short note to `apps/web` developer docs / the relevant CLAUDE.md or skill: "Mutation handlers in the targeted set MUST go through `runAction` (see `docs/superpowers/specs/2026-05-15-ws-a-action-feedback-design.md`); the `no-silent-mutations` test enforces it."

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: document runAction as the mutation-handler pattern (#720)"
```

---

## Self-Review

**Spec coverage:** runAction (T2), extractApiError extension (T1), `isApiFailure`/200-failure (T1/T2), channel Test fix (T4), last_tested_at backend (T3), patch-scan UI + deviceActions residual (T5), targeted adoption (T6), guardrail (T7), testing throughout, docs (T8). All spec sections mapped.

**Placeholders:** Code provided for all novel units (T1-T4, T7). T5/T6 are mechanical migrations with an explicit recipe + enumerated files + exact `runAction` call shape (acceptable — repeating 6 near-identical blocks adds no information; the transform is fully specified). T3 Steps 4 and T6 Step 3 instruct mirroring the file's existing test harness rather than inventing a conflicting one — intentional, since those harnesses are codebase-specific and reading them is part of the step.

**Type consistency:** `runAction`/`ActionError`/`RunActionOptions` names consistent T2↔T4↔T5↔T6. `isApiFailure`/`extractApiError` signatures consistent T1↔T2. `lastTestedAt`/`lastTestStatus` consistent T3 (schema/endpoint/response) ↔ existing web `NotificationChannelList`. `RUN_ACTION_ALLOWLIST` consistent T7.

**Scope:** Single cohesive plan (one helper + parser + one backend migration + targeted migration + one guard). Appropriately sized.
