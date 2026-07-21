# WS-A — Action Feedback & Error Legibility

**Date:** 2026-05-15
**Status:** Design — approved, awaiting spec review
**Issues addressed:** #720 (silent action feedback + `last_tested_at`), #725 (alerts/channel test feedback), #727 (UI half — patch scan), residual of #678 (`deviceActions.ts` weak parser)
**Branch:** `feat/ws-a-action-feedback`

## Problem

Recently-merged action features call their API correctly, receive a well-formed result, and surface **nothing** to the user — no toast, no inline message, no state change. The QA sweep proved this is a *class*, not isolated incidents (Wake-on-LAN, Pushover channel Test). Investigation refined the picture:

- `apps/web/src/lib/apiError.ts` `extractApiError` is **already robust** for the common shapes (`{error}`, zod `{error:{issues}}`, `{error,details}`, Hono `{message}`, legacy `errorMessage`). The `[object Object]` pattern (#678) has already been migrated out of 46 files.
- The **real remaining gap**: `extractApiError` does not handle `{success:false, message}` nor the case of **HTTP 200 with a failure body** (`{success:false}` / `{testResult:{success:false, message}}`). The channel Test endpoint returns `200` with `{testResult:{success:false, message:"application token is invalid…"}}`; `handleTest` only checks `response.ok`, so a failed test produces no feedback at all.
- There is **no shared action→feedback wrapper**. Every mutation handler is ad-hoc `try/catch` around raw `fetchWithAuth`; the "do nothing on result" and "setError but no toast" variants are the bug class. The single best existing pattern is the Wake triad: `services/deviceActions.ts` (`sendWakeCommand`) + `WakeCommandError{code}` + `wakeFriendlyErrorMessage(code)`.
- `notification_channels` card already renders `lastTestedAt`/`lastTestStatus` (`NotificationChannelList.tsx:273-286`) but the backend never persists them (no columns; test endpoint computes `testResult` but does not write it). The card is permanently `"Never tested"`.

## Goals / Non-goals

**Goals**
- Make the targeted action surfaces always tell the user the outcome (success confirmation or a readable failure), including the 200-with-failure-body case.
- Generalize the proven Wake pattern into one reusable helper so new handlers get correct feedback by default.
- Persist and surface notification-channel test results (#720).
- A lightweight, non-blocking guardrail so the silent-failure class cannot quietly return.

**Non-goals (YAGNI)**
- Sweeping migration of all ~298 `fetchWithAuth` call sites.
- A stateful `useAction` React hook (the codebase uses plain `useState`/`useEffect`; revisit only if pain emerges).
- CI-blocking enforcement of the guardrail.
- Modifying the `fetchWithAuth` transport (used by GETs/stores; transport-layer toasting is unsafe).

## Architecture

### New unit: `apps/web/src/lib/runAction.ts` (~80 lines, no state deps)

```
runAction<T>(opts: {
  request: () => Promise<Response>;          // typically () => fetchWithAuth(url, {method:'POST', ...})
  successMessage?: string | ((data: T) => string);   // omit ⇒ no success toast (caller may toast itself)
  errorFallback: string;                     // used when no readable message can be extracted
  parseSuccess?: (data: unknown) => T;       // default: return data as T
  friendly?: (code: string) => string | undefined;   // optional code→copy map (e.g. wakeFriendlyErrorMessage)
  onUnauthorized?: () => void;               // default: navigate to /login (preserve existing behavior)
}): Promise<T>
```

Behavior:
1. `await opts.request()`.
2. If `status === 401` → call `onUnauthorized` (default `navigateTo('/login',{replace:true})`) and throw `ActionError`.
3. Parse JSON (tolerant of empty/non-JSON bodies).
4. Determine failure via new `isApiFailure(data, status)`:
   - `!response.ok`, **or**
   - body has `success === false`, **or**
   - body has `testResult && testResult.success === false`.
5. On failure: build message via `extractApiError` (extended — see below) + optional `friendly(code)`; `showToast({type:'error', message})`; throw `ActionError{ code?, message, status }`.
6. On success: if `successMessage` provided, `showToast({type:'success', message})`; return `parseSuccess(data)`.

`ActionError extends Error` with `code?: string`, `status?: number`. Callers that need to branch (rare) still can; callers that don't get correct toasts for free.

### Extended `apps/web/src/lib/apiError.ts`

- New exported `isApiFailure(data: unknown, httpStatus: number): boolean` — `httpStatus >= 400 || data.success === false || data.testResult?.success === false`.
- `extractApiError` gains two cases, appended **after** existing logic so all current shapes are unchanged: `{success:false, message}` → `message`; `{testResult:{success:false, message}}` → `testResult.message`. (Falls through to existing logic / fallback otherwise.)

### Backend: notification-channel test persistence (#720)

- New idempotent migration `apps/api/migrations/2026-05-15-notification-channel-test-result.sql` (adjust the date prefix to the actual merge date if later; it only needs to sort after the existing `2026-05-14-b-*` migration): `ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS last_tested_at timestamptz`, `ADD COLUMN IF NOT EXISTS last_test_status varchar(16)`. `notification_channels` is org-scoped (direct `org_id`, RLS shape 1) → policies auto-cover the columns; no allowlist change. Update the Drizzle schema in `apps/api/src/db/schema/alerts.ts`.
- `apps/api/src/routes/alerts/channels.ts` test endpoint: after computing `testResult`, `UPDATE notification_channels SET last_tested_at = now(), last_test_status = (testResult.success ? 'success' : 'failed') WHERE id = …` (within the existing request DB context). Include both fields in `toChannelResponse`.
- Frontend already renders these (`NotificationChannelList.tsx`) — **no UI change for the card**.

## Components / data flow

```
component handler
  └─ runAction({ request: () => fetchWithAuth(url, {method}), successMessage, errorFallback, friendly? })
       ├─ fetchWithAuth (unchanged transport)
       ├─ isApiFailure(data, status)  ── apiError.ts (extended)
       ├─ extractApiError(data, fallback) (extended)  ── readable message
       ├─ showToast(success|error)  ── existing singleton (Toast.tsx)
       └─ returns parsed T  |  throws ActionError{code,status}
```

The channel Test card flow additionally: test endpoint persists `last_tested_at`/`last_test_status` → `toChannelResponse` → existing `NotificationChannelList` render path (already implemented).

## In-scope fixes & targeted adoption

| Site | Change |
|---|---|
| `NotificationChannelsPage.handleTest` | Use `runAction`; inspect `testResult.success`; toast pass/fail |
| `notification_channels` (API) | Migration + persist `last_tested_at`/`last_test_status` + `toChannelResponse` |
| Patch Run-Scan handler (Patches page) | Route through `runAction` so `success:false` surfaces (pairs with merged #734) |
| `apps/web/src/services/deviceActions.ts:16-23` | Replace weak `data?.error || data?.message` with `extractApiError` |
| Device actions (`DevicesPage`/`DeviceDetailPage`/`DeviceActions`, non-Wake) | Migrate handlers to `runAction` |
| Alerts channels create/update/delete | Migrate handlers to `runAction` |
| Partner Settings save | Migrate handler to `runAction` (surfaces the specific server error instead of generic) |

Wake stays as-is (already correct; the model the helper generalizes). All other mutation handlers: documented pattern, migrate opportunistically (out of scope to migrate now).

## Recurrence guardrail

`apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (runs in the normal `pnpm test` / `test-web` job, **not** a separate CI gate):

- Statically scan the **targeted** component set (an explicit list of globs covering the adopted directories) for `fetchWithAuth(` calls whose options include `method:` of `POST|PUT|PATCH|DELETE` that are not lexically inside a `runAction(` call.
- An exported allowlist array (path + reason) for legitimate exceptions (e.g. Wake's typed service, store-level calls).
- Failure message points at this spec and `runAction`. Non-blocking philosophy: it lives in the existing web test suite so it shows up in `test-web` but is scoped to the targeted set, so it does not break unrelated areas during gradual rollout.

## Error handling

- `runAction` never throws raw/unparsed errors to the UI: all failures become an `ActionError` with a human message already toasted.
- Empty / non-JSON bodies tolerated (`.json().catch(() => null)`), fall back to `errorFallback`.
- `401` preserves existing redirect-to-login behavior.
- Network/transport throw (fetch rejects) → caught, `errorFallback` toasted, `ActionError{status:0}` thrown.
- Pages without a mounted `ToastContainer` are out of the targeted set (the targeted set is all under `DashboardLayout`, which mounts the container) — documented constraint.

## Testing

- `runAction` unit tests: success toast; error toast on `!ok`; error on `{success:false}`; error on `200 + {testResult:{success:false,message}}`; `ActionError.code/status`; `401`→`onUnauthorized`; non-JSON body → fallback; network reject → fallback.
- `extractApiError`/`isApiFailure` new-shape tests (existing shapes regression-covered).
- `NotificationChannelsPage.handleTest` regression: failed test shows error toast, card reflects result after refetch.
- Backend: migration applies idempotently; test endpoint persists `last_tested_at`/`last_test_status`; `toChannelResponse` includes them; RLS unaffected (org-scoped).
- The guardrail test itself (asserts a known-bad fixture is flagged, allowlisted entry is not).

## Build sequence (for the implementation plan)

1. Extend `apiError.ts` (`isApiFailure` + two cases) + tests.
2. Add `runAction.ts` + `ActionError` + tests.
3. Backend: migration + schema + channels test-endpoint persistence + `toChannelResponse` + tests.
4. Fix `NotificationChannelsPage.handleTest` + patch-scan handler + `deviceActions.ts` parser.
5. Migrate the targeted device-action / channel CRUD / Partner Settings handlers.
6. Guardrail test + allowlist.
7. Full `test-web` + targeted `test-api` green.

## Rollback / risk

- Frontend changes are additive (`runAction` is new; handlers migrate incrementally). Reverting a handler to its prior `try/catch` is local.
- The migration is idempotent and additive (nullable columns); safe to ship independently of the frontend.
- Guardrail scoped to the targeted set ⇒ cannot block unrelated work.
