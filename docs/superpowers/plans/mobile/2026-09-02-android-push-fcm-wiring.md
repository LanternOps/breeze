# Android Push (FCM) Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Android push notifications actually deliver — the server currently detects raw (non-Expo-relay) FCM tokens and silently skips them, and the mobile app's Android registration path is gated on an `extra.eas.projectId` that no longer exists in `app.json`, so `registerForPushNotifications()` returns `unsupported` on every Android device.

**Architecture:** Move Android onto the same native-token pattern iOS already uses (native APNs, no Expo relay, no EAS account) instead of restoring the abandoned Expo-relay path. Server: add `apps/api/src/services/fcm.ts`, a native FCM sender mirroring the existing `apns.ts` contract (never throws, returns a structured `{ok, reason, unregistered}` result), and wire it into `expoPush.ts`'s `dispatchPushToTokens` fcm branch — the exact branch that currently just logs and skips. Mobile: `registerForPushNotifications()` calls `Notifications.getDevicePushTokenAsync()` unconditionally (both platforms), which on Android returns a native FCM registration token once `google-services.json` is present in the native build — no `projectId`, no Expo/EAS account involvement on either platform.

**Tech Stack:** Hono API (TypeScript) + Drizzle, `firebase-admin` (already a dependency), Expo SDK 57 / `expo-notifications`, Vitest.

**Spec:** None — this plan is scoped directly from issue #3639 and the code gaps it documents (`apps/mobile/STORE_SUBMISSION.md` "Push notifications" section, `apps/api/src/services/expoPush.ts:411-421`, `apps/mobile/src/services/notifications.ts:59-77`).

## Design Decision — native FCM vs. restoring the Expo relay

Two ways to close the gap; this plan picks the second.

- **A — Restore `extra.eas.projectId` in `app.json`.** Cheapest: Android goes back through `getExpoPushTokenAsync()` and `expoPush.ts`'s existing `expo` branch already sends those. But this reintroduces an EAS/Expo-account dependency that iOS deliberately dropped (`STORE_SUBMISSION.md`: "iOS push uses native APNs, not the Expo relay ... so no Expo account is needed"), and does nothing for the raw FCM tokens already sitting in `mobile_devices.fcm_token` from `notifications.ts`'s independent alert-push path — those still get skipped by `expoPush.ts` today. Reintroducing an asymmetry the codebase just finished removing on iOS is the "works now, retrofit later" shape CLAUDE.md's Working Style section calls out — not the long-term-best option.
- **B — Native FCM.** Android calls `getDevicePushTokenAsync()` like iOS; no EAS project needed on either platform, only `google-services.json` bundled into the native build (an Android analogue of iOS's `.p8` APNs key). Server-side, `firebase-admin` is already a runtime dependency and `notifications.ts` already has a working `sendFCM` for the older alert-push path — extracting it into a shared `fcm.ts` (mirroring `apns.ts`) removes the last special case in `expoPush.ts`'s dispatcher and gives every provider (expo/apns/fcm) the same never-throws contract.

**Recommendation: B.** It matches the architecture iOS already committed to, deletes the FCM/Expo split instead of adding a third path, and needs no store-review or EAS-account setup this repo doesn't already have. The cost is real infra work Todd has to do outside this repo (Firebase Console) — flagged as its own wave below, same shape as the Apple Team ID / `.p8` key work in `STORE_SUBMISSION.md`.

## Global Constraints

- **No migration.** `mobile_devices.fcm_token` and `mobile_devices.platform` already exist (`apps/api/src/db/schema/mobile.ts:9-35`, migration `2026-05-07-mobile-device-and-oauth-lifecycle.sql` predates this plan). No schema change in any wave.
- **RLS shape:** `mobile_devices` and `push_notifications` are already Shape 6 (user-id scoped, `breeze_current_user_id()`) and already listed in `USER_ID_SCOPED_TABLES` (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:688-689`). No RLS policy change.
- **Cascade/export registration lists — all four N/A.** Neither table has an `org_id` column, so `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` (org-cascade families) don't apply; neither table has a `device_id` column referencing the fleet `devices` table, so `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` don't apply either. This plan adds no columns to any registered table, so the export-policy "new column on a registered table" trigger doesn't fire.
- **Partner-Wide-First ownership:** N/A — no new config/policy table.
- **CI:** Branch each wave directly off latest `origin/main`, not off a sibling wave's unmerged branch — stacked PRs against `main` get zero CI (`ci.yml` triggers on `pull_request: branches: [main]` only). If a later wave must build on an earlier wave that hasn't merged yet, dispatch `gh workflow run CI --ref <branch>` before merging, per the CLAUDE.md tenancy-section CI trap. No migration/cascade code is touched here, so the RLS/integration contract suites are not expected to change — still run `pnpm --filter @breeze/api test` (unit) before every PR; the separate integration configs (`vitest.config.rls.ts`, `vitest.config.integration.config.ts`) are unaffected by this plan's changes and don't need a special run, but note `pnpm test` never runs them regardless.
- **Token hygiene:** never log a raw push token in full — follow the existing `redactPushToken()` pattern (`expoPush.ts:24-28`) for any new log line touching an FCM token.
- **Test scoping trap:** when running a single file, use `cd apps/api && npx vitest run <path>` or `pnpm --filter @breeze/api test --run <path>` (no bare `--`) — see CLAUDE.md Testing Standards.

---

## Wave 1 — Server: native FCM sender + dispatch wiring

**Independently shippable:** yes. Ships real FCM delivery for any raw `fcm`-tagged token already in the database (from the older alert-push registration path) even before Wave 2's mobile change lands. No behavior change for `expo`/`apns` tokens.

### Task 1.1: Create `apps/api/src/services/fcm.ts`

**Files:**
- Create: `apps/api/src/services/fcm.ts`
- Test: `apps/api/src/services/fcm.test.ts`

**Interfaces:**
- Produces: `isFcmConfigured(): boolean`, `sendFcmNotification(token: string, payload: FcmPayload): Promise<FcmResult>`, `__resetFcmAppForTests(): void`, and the `FcmPayload`/`FcmResult` types, all consumed by Task 1.2 (`notifications.ts`) and Task 1.3 (`expoPush.ts`).

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/services/fcm.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const messagingSend = vi.fn();
const initializeApp = vi.fn(() => ({}));
const cert = vi.fn((sa: unknown) => sa);
const appsList: unknown[] = [];

vi.mock('firebase-admin', () => ({
  default: {
    get apps() {
      return appsList;
    },
    app: vi.fn(() => ({})),
    initializeApp,
    credential: { cert },
    messaging: () => ({ send: messagingSend }),
  },
}));

import {
  isFcmConfigured,
  sendFcmNotification,
  __resetFcmAppForTests,
} from './fcm';

const ORIGINAL_ENV = process.env.FIREBASE_SERVICE_ACCOUNT;

beforeEach(() => {
  __resetFcmAppForTests();
  messagingSend.mockReset();
  initializeApp.mockClear();
  appsList.length = 0;
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
  else process.env.FIREBASE_SERVICE_ACCOUNT = ORIGINAL_ENV;
});

describe('isFcmConfigured', () => {
  it('is false when FIREBASE_SERVICE_ACCOUNT is unset', () => {
    expect(isFcmConfigured()).toBe(false);
  });

  it('is true once FIREBASE_SERVICE_ACCOUNT is set', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    expect(isFcmConfigured()).toBe(true);
  });
});

describe('sendFcmNotification', () => {
  it('returns not_configured without touching firebase-admin when unset', async () => {
    const res = await sendFcmNotification('tok', { title: 't', body: 'b' });
    expect(res).toEqual({ ok: false, reason: 'not_configured' });
    expect(messagingSend).not.toHaveBeenCalled();
  });

  it('sends with android-specific fields and stringified data on success', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    messagingSend.mockResolvedValueOnce('projects/p/messages/123');

    const res = await sendFcmNotification('tok', {
      title: 'Approval requested',
      body: 'Claude Desktop: Delete devices',
      data: { type: 'approval', approvalId: 'ap-1' },
      ttl: 60,
      channelId: 'approvals',
      collapseId: 'approval:ap-1',
    });

    expect(res).toEqual({ ok: true, messageId: 'projects/p/messages/123' });
    expect(messagingSend).toHaveBeenCalledWith({
      token: 'tok',
      notification: { title: 'Approval requested', body: 'Claude Desktop: Delete devices' },
      data: { type: 'approval', approvalId: 'ap-1' },
      android: {
        priority: 'high',
        ttl: 60_000,
        collapseKey: 'approval:ap-1',
        notification: { channelId: 'approvals' },
      },
    });
  });

  it('reports unregistered:true for a dead token without throwing', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    messagingSend.mockRejectedValueOnce({ code: 'messaging/registration-token-not-registered' });

    const res = await sendFcmNotification('dead-tok', { title: 't', body: 'b' });

    expect(res).toEqual({
      ok: false,
      reason: 'messaging/registration-token-not-registered',
      unregistered: true,
    });
  });

  it('reports a live failure without unregistered on any other error', async () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ private_key: 'x', client_email: 'y' });
    messagingSend.mockRejectedValueOnce({ code: 'messaging/internal-error' });

    const res = await sendFcmNotification('tok', { title: 't', body: 'b' });

    expect(res).toEqual({ ok: false, reason: 'messaging/internal-error' });
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/services/fcm.test.ts`
Expected: FAIL — `Cannot find module './fcm'` (file doesn't exist yet).

- [ ] **Step 3: Implement `fcm.ts`**

```typescript
// apps/api/src/services/fcm.ts
import admin from 'firebase-admin';

/**
 * Native Firebase Cloud Messaging (FCM) sender for Android. Mirrors apns.ts's
 * never-throws, structured-result contract so expoPush.ts's dispatcher can
 * treat both native providers identically (#3639).
 */

let firebaseApp: admin.app.App | null = null;

function parseServiceAccount(raw: string): admin.ServiceAccount {
  let parsed: { privateKey?: string; private_key?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  if (parsed.private_key && !parsed.privateKey) {
    parsed.privateKey = parsed.private_key;
  }
  if (typeof parsed.privateKey === 'string') {
    parsed.privateKey = parsed.privateKey.replace(/\\n/g, '\n');
  }
  return parsed as admin.ServiceAccount;
}

/** True iff FIREBASE_SERVICE_ACCOUNT is present. Mirrors isApnsConfigured(). */
export function isFcmConfigured(): boolean {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT;
}

function initFirebase(): admin.app.App {
  if (firebaseApp) return firebaseApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const serviceAccount = parseServiceAccount(raw);
  firebaseApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return firebaseApp;
}

/** Test-only: clears the module-level Firebase app cache. */
export function __resetFcmAppForTests(): void {
  firebaseApp = null;
}

// FCM rejects a `data` payload whose values aren't strings.
function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

// FCM error codes that mean the registration token is permanently dead.
const UNREGISTERED_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export interface FcmPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Store-and-forward window in seconds. */
  ttl?: number;
  /** Android notification channel; must match a channel created client-side. */
  channelId?: string;
  /** Coalesces multiple notifications, mirroring apns-collapse-id. */
  collapseId?: string;
}

export interface FcmResult {
  ok: boolean;
  messageId?: string;
  reason?: string;
  unregistered?: boolean;
}

/**
 * Sends a single notification via FCM. Never throws — returns a structured
 * result, exactly like sendApnsNotification. Returns
 * {ok:false, reason:'not_configured'} when FIREBASE_SERVICE_ACCOUNT is
 * absent, and {unregistered:true} for dead tokens the caller should purge.
 */
export async function sendFcmNotification(token: string, payload: FcmPayload): Promise<FcmResult> {
  if (!isFcmConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }
  try {
    initFirebase();
    const messageId = await admin.messaging().send({
      token,
      notification: { title: payload.title, body: payload.body },
      data: stringifyData(payload.data),
      android: {
        priority: 'high',
        ttl: (payload.ttl ?? 3600) * 1000,
        collapseKey: payload.collapseId,
        notification: payload.channelId ? { channelId: payload.channelId } : undefined,
      },
    });
    return { ok: true, messageId };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && UNREGISTERED_CODES.has(code)) {
      console.warn('[fcm] token unregistered', { code });
      return { ok: false, reason: code, unregistered: true };
    }
    console.error('[fcm] send failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: code ?? 'send_error' };
  }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `cd apps/api && npx vitest run src/services/fcm.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/fcm.ts apps/api/src/services/fcm.test.ts
git commit -m "feat(mobile-push): add native FCM sender mirroring apns.ts contract"
```

### Task 1.2: Refactor `notifications.ts`'s `sendFCM` to delegate to `fcm.ts`

Closes a real, currently-untested gap: `sendPushToDevice`'s Android branch calls `sendFCM` directly with zero test coverage today (confirmed: no `describe('sendFCM')` or `firebase-admin` mock exists in `notifications.test.ts`), and never purges a dead FCM token the way `sendAPNS` purges a dead APNs token. This task also adds that purge, matching APNs behavior — the "server send path parity with iOS" the issue asks for.

**Files:**
- Modify: `apps/api/src/services/notifications.ts:1-10` (imports), `:30-69` (delete local `initFirebase`), `:150-174` (rewrite `sendFCM`)
- Test: `apps/api/src/services/notifications.test.ts`

**Interfaces:**
- Consumes: `sendFcmNotification`, `isFcmConfigured` from `./fcm` (Task 1.1).
- Produces: `sendFCM(token, payload): Promise<PushSendResult>` — same public signature as before, so `sendPushToDevice` (line 118-128) is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/notifications.test.ts` (mirror the existing `describe('sendAPNS', ...)` block's mocking style — mock `./fcm`, not `firebase-admin`, since Task 1.1 already covers `firebase-admin` mocking directly):

```typescript
vi.mock('./fcm', () => ({
  sendFcmNotification: vi.fn(),
}));

// ... alongside the existing sendAPNS import:
import { sendFCM } from './notifications';
import { sendFcmNotification } from './fcm';

const sendFcmNotificationMock = vi.mocked(sendFcmNotification);

describe('sendFCM', () => {
  beforeEach(() => {
    sendFcmNotificationMock.mockReset();
    vi.mocked(db.update).mockClear();
  });

  it('returns sent with the provider messageId on success', async () => {
    sendFcmNotificationMock.mockResolvedValueOnce({ ok: true, messageId: 'msg-1' });

    const res = await sendFCM('tok', {
      title: 'Alert Triggered',
      body: 'Disk full',
      data: {},
      alertId: 'al-1',
      eventType: 'alert.triggered',
    });

    expect(res).toEqual({ messageId: 'msg-1', status: 'sent' });
    expect(sendFcmNotificationMock).toHaveBeenCalledWith('tok', {
      title: 'Alert Triggered',
      body: 'Disk full',
      data: { alertId: 'al-1', eventType: 'alert.triggered' },
    });
  });

  it('purges the fcm token column and throws when the provider reports unregistered', async () => {
    sendFcmNotificationMock.mockResolvedValueOnce({
      ok: false,
      reason: 'messaging/registration-token-not-registered',
      unregistered: true,
    });

    await expect(
      sendFCM('dead-tok', { title: 't', body: 'b', data: {}, alertId: null, eventType: 'alert.triggered' })
    ).rejects.toThrow('FCM delivery failed');
    expect(db.update).toHaveBeenCalled();
  });

  it('throws without purging on a non-unregistered failure', async () => {
    sendFcmNotificationMock.mockResolvedValueOnce({ ok: false, reason: 'messaging/internal-error' });

    await expect(
      sendFCM('tok', { title: 't', body: 'b', data: {}, alertId: null, eventType: 'alert.triggered' })
    ).rejects.toThrow('FCM delivery failed');
    expect(db.update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/services/notifications.test.ts`
Expected: FAIL — `sendFCM` still calls the real `admin.messaging()` path (not mocked via `./fcm`), so the new assertions on `sendFcmNotificationMock` fail (it was never called).

- [ ] **Step 3: Rewrite `sendFCM`, remove the local Firebase init**

Remove lines 1-10's `firebase-admin` import and lines 30-69 (`firebaseApp`, `initFirebase`) entirely — nothing outside this file imports `initFirebase` (verified: no other module in `apps/` or `ee/` references it). Add the import and replace `sendFCM` (old lines 150-174):

```typescript
import { sendFcmNotification } from './fcm';
// (remove: import admin from 'firebase-admin';)

export async function sendFCM(token: string, payload: PushPayload): Promise<PushSendResult> {
  const data: Record<string, unknown> = { ...payload.data };
  if (payload.alertId) data.alertId = payload.alertId;
  if (payload.eventType) data.eventType = payload.eventType;

  const res = await sendFcmNotification(token, { title: payload.title, body: payload.body, data });
  if (res.ok) {
    return { messageId: res.messageId ?? `fcm-${Date.now()}`, status: 'sent' };
  }

  // Dead token: purge it so we stop targeting it, then surface the failure —
  // mirrors sendAPNS's unregistered-token handling below.
  if (res.unregistered) {
    try {
      await db.update(mobileDevices).set({ fcmToken: null }).where(eq(mobileDevices.fcmToken, token));
    } catch (err) {
      console.error('[Notifications] failed to purge unregistered FCM token', err);
    }
  }

  throw new Error(`FCM delivery failed${res.reason ? ` (${res.reason})` : ''}`);
}
```

- [ ] **Step 4: Run and verify pass**

Run: `cd apps/api && npx vitest run src/services/notifications.test.ts`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && npx tsc --noEmit` (or the workspace's turbo typecheck if faster to target) — confirm no leftover reference to the removed `admin`/`initFirebase` symbols.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/notifications.ts apps/api/src/services/notifications.test.ts
git commit -m "refactor(mobile-push): delegate sendFCM to shared fcm.ts, purge dead tokens"
```

### Task 1.3: Wire the `fcm` branch of `dispatchPushToTokens`

**Files:**
- Modify: `apps/api/src/services/expoPush.ts:1-4` (imports), `:307-320` (add `purgeFcmToken` next to `purgeApnsToken`), `:411-421` (replace the skip branch)
- Test: `apps/api/src/services/expoPush.test.ts:392-402` (replace the "skip" test), plus new dispatch/purge tests

**Interfaces:**
- Consumes: `sendFcmNotification` from `./fcm` (Task 1.1).
- Produces: no signature change to `dispatchPushToTokens`, `dispatchApprovalPushToTokens`, `dispatchApprovalPush`, or `DispatchPushResult` — only its internal fcm branch changes behavior.

- [ ] **Step 1: Write the failing tests**

Replace the existing test at `expoPush.test.ts:392-402` ("counts native android (fcm) tokens as found-but-skipped, not errors") and add two more, in the same `describe('dispatchApprovalPush routing', ...)` block. Add `vi.mock('./fcm', ...)` near the file's existing `vi.mock('./apns', ...)`:

```typescript
// near the top, alongside the existing apns mock:
const sendFcmNotificationMock = vi.fn();
vi.mock('./fcm', () => ({
  sendFcmNotification: (...args: unknown[]) => sendFcmNotificationMock(...args),
}));

// inside describe('dispatchApprovalPush routing', ...), replacing the old skip test:
it('dispatches native android (fcm) tokens via sendFcmNotification', async () => {
  stubSelectRows([{ fcm: 'native-fcm-token', apns: null, platform: 'android' }]);
  sendFcmNotificationMock.mockResolvedValueOnce({ ok: true, messageId: 'fcm-msg-1' });

  const res = await dispatchApprovalPush('u1', pushArgs);

  expect(sendFcmNotificationMock).toHaveBeenCalledWith('native-fcm-token', {
    title: 'Approval requested',
    body: 'Claude Desktop: Delete devices',
    data: { type: 'approval', approvalId: 'ap-1' },
    ttl: 60,
    channelId: 'approvals',
  });
  expect(res).toEqual({ tokensFound: 1, dispatched: 1, errors: 0 });
});

it('purges the fcm column when the native fcm sender reports the token unregistered', async () => {
  stubSelectRows([{ fcm: 'dead-fcm-token', apns: null, platform: 'android' }]);
  sendFcmNotificationMock.mockResolvedValueOnce({
    ok: false,
    reason: 'messaging/registration-token-not-registered',
    unregistered: true,
  });

  const res = await dispatchApprovalPush('u1', pushArgs);

  expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 1 });
  expect(db.update).toHaveBeenCalled();
  expect(updateSetCalls.some((s) => s.fcmToken === null)).toBe(true);
});

it('counts a live fcm failure as an error without purging when not unregistered', async () => {
  stubSelectRows([{ fcm: 'fcm-token', apns: null, platform: 'android' }]);
  sendFcmNotificationMock.mockResolvedValueOnce({ ok: false, reason: 'messaging/internal-error' });

  const res = await dispatchApprovalPush('u1', pushArgs);

  expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 1 });
  expect(db.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/api && npx vitest run src/services/expoPush.test.ts`
Expected: FAIL — `dispatchPushToTokens` still only logs and skips `fcm` tokens, so `sendFcmNotificationMock` is never called and `dispatched`/`errors` stay 0.

- [ ] **Step 3: Implement the fcm branch**

Add near `purgeApnsToken` (after line ~320):

```typescript
/** Purges a single dead native-FCM token, mirroring purgeApnsToken. */
async function purgeFcmToken(token: string): Promise<void> {
  try {
    await db.update(mobileDevices).set({ fcmToken: null }).where(eq(mobileDevices.fcmToken, token));
  } catch (err) {
    console.error('[push] failed to purge unregistered fcm token', {
      token: redactPushToken(token),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
```

Add the import at the top: `import { sendFcmNotification } from './fcm';`

Replace the skip block (old lines 411-421) with:

```typescript
  // Native FCM (Android) tokens — one send each; purge on unregistered.
  // Mirrors the APNs branch above exactly (#3639).
  const fcmTokens = tokens.filter((t) => t.provider === 'fcm');
  for (const t of fcmTokens) {
    try {
      const res = await sendFcmNotification(t.token, {
        title: spec.title,
        body: spec.body,
        data: spec.data,
        ttl: spec.ttl,
        channelId: spec.channelId,
        collapseId: spec.collapseId,
      });
      if (res.ok) {
        result.dispatched++;
      } else {
        result.errors++;
        if (res.unregistered) await purgeFcmToken(t.token);
      }
    } catch (err) {
      console.error(`[push] fcm ${logLabel} dispatch failed`, {
        token: redactPushToken(t.token),
        error: err instanceof Error ? err.message : String(err),
      });
      result.errors++;
    }
  }
```

- [ ] **Step 4: Run and verify pass**

Run: `cd apps/api && npx vitest run src/services/expoPush.test.ts`
Expected: PASS, all tests including the 3 new/replaced ones.

- [ ] **Step 5: Full API unit suite + typecheck**

Run: `pnpm --filter @breeze/api test` and the workspace typecheck (`pnpm build` or the CI-equivalent turbo typecheck target — there is no root `pnpm typecheck` script per CLAUDE.md).
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/expoPush.ts apps/api/src/services/expoPush.test.ts
git commit -m "feat(mobile-push): dispatch approval/ticket pushes to native FCM tokens (#3639)"
```

**Open the PR here** (Wave 1 is independently mergeable): title referencing #3639, body noting this only activates for tokens already tagged `provider: 'fcm'` — none exist yet from a fresh Android install until Wave 2 ships, but any legacy raw token from before the Expo-relay migration starts working immediately.

---

## Wave 2 — Mobile: native Android token registration

**Independently shippable:** yes, but only useful once Wave 1 has merged (or is in flight — the mobile change alone doesn't regress anything: a raw FCM token registers fine today via the existing `registerDeviceSchema`/`registerPushTokenSchema` routes regardless of whether the server dispatches to it yet).

### Task 2.1: Switch `registerForPushNotifications()` to a single native-token path

**Files:**
- Modify: `apps/mobile/src/services/notifications.ts:1-4` (drop the now-unused `expo-constants` import), `:53-77` (collapse the iOS/Android branch into one call)
- Test: `apps/mobile/src/services/notifications.test.ts:18-19` (drop `expo-constants` mock's relevance to Android), `:82-104` (replace the two projectId-branch tests), `:152-164` (drop the projectId setup), `:427-440` (drop the projectId setup)

- [ ] **Step 1: Write the failing test**

Replace the two tests at lines 82-104 (`'Android without a projectId reports UNSUPPORTED, not failed'` and `'Android WITH a projectId still uses the Expo relay'`) with:

```typescript
  it('Android uses the NATIVE FCM token, never the Expo relay', async () => {
    platform.OS = 'android';
    notif.getDevicePushTokenAsync.mockResolvedValue({ data: 'FCM-TOKEN' });

    const out = await registerForPushNotifications();

    expect(out).toEqual({ status: 'ok', token: 'FCM-TOKEN' });
    expect(notif.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    expect(notif.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(api.registerPushToken).toHaveBeenCalledWith('FCM-TOKEN', 'android');
  });

  it('Android does not need an EAS projectId', async () => {
    platform.OS = 'android';
    constants.expoConfig = { extra: {} }; // no eas.projectId anywhere
    await expect(registerForPushNotifications()).resolves.toMatchObject({ status: 'ok' });
  });
```

Also update the two other tests that still set a `projectId` as scaffolding for Android (they no longer need it, and it now has no effect):
- Line ~152-164 (`'Android channel-setup failure does not reject...'`): delete the `constants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };` line and change the expected resolved value from `{ status: 'ok', token: 'ExponentPushToken[x]' }` to `{ status: 'ok', token: 'APNS-TOKEN' }` (the default `getDevicePushTokenAsync` mock from `beforeEach`, since Android now goes through the same mock as iOS).
- Line ~427-440 (`'the tickets Android channel'` test): delete its `constants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };` line; no other change needed.

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/mobile && npx vitest run src/services/notifications.test.ts`
Expected: FAIL — the new "native FCM token" test fails because the current code still calls `getExpoPushTokenAsync` and returns `unsupported` (no projectId configured in `beforeEach`).

- [ ] **Step 3: Implement**

Remove the `Constants` import (`apps/mobile/src/services/notifications.ts:3`, `import Constants from 'expo-constants';` — no longer used anywhere in this file). Replace the `if (Platform.OS === 'ios') { ... } else { ... }` block (old lines 53-77) with:

```typescript
    // Native device push token for both platforms: raw APNs token on iOS,
    // raw FCM registration token on Android. Needs NO Expo projectId/account
    // on either platform — Android instead requires google-services.json
    // bundled into the native build (see STORE_SUBMISSION.md). The server
    // routes both natively via services/apns.ts and services/fcm.ts (#3639);
    // the Expo push relay is no longer used by this app on either platform.
    const tokenData = await Notifications.getDevicePushTokenAsync();
    token = String(tokenData.data);
```

- [ ] **Step 4: Run and verify pass**

Run: `cd apps/mobile && npx vitest run src/services/notifications.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/notifications.ts apps/mobile/src/services/notifications.test.ts
git commit -m "feat(mobile-push): register Android via native FCM token, drop Expo relay (#3639)"
```

### Task 2.2: Retire the `android_push_not_configured` copy branch

Now unreachable — `registerForPushNotifications()` (Task 2.1) never returns that reason anymore. Android's only remaining `unsupported` reason is the pre-existing `not_physical_device` (emulators), same as iOS simulators.

**Files:**
- Modify: `apps/mobile/src/screens/chat/components/pushUnavailableCopy.ts:19-27` (remove the `'android_push_not_configured'` case)
- Test: `apps/mobile/src/screens/chat/components/pushUnavailableCopy.test.ts:10-16, 32, 40, 65-66` (remove the now-meaningless reason from every case list)

- [ ] **Step 1: Update the test file**

Remove the test `'names Android for the not-built-yet reason (#3118)'` (lines 10-16) entirely. In every remaining test that iterates a `REASONS`/reason list containing `'android_push_not_configured'` (the `for (const reason of [...])` loops around lines 32 and 65, and the `REASONS` const around line 40), drop that string from the list — the surrounding assertions (generic fallback / no-error-phrasing / verbatim reuse) still hold for the reasons that remain.

- [ ] **Step 2: Run and verify failure**

Run: `cd apps/mobile && npx vitest run src/screens/chat/components/pushUnavailableCopy.test.ts`
Expected: FAIL — the deleted test file still imports/asserts against `pushUnavailableCopy('android_push_not_configured')` returning Android-specific copy that the next step removes... actually this direction is inverted: deleting an assertion doesn't fail. Instead, verify by RUNNING FIRST before Step 3, confirming it still passes (baseline), then apply Step 3's source change and re-run to confirm nothing else broke (the `default` branch must still produce sane copy for the now-unused string, since removing the `case` doesn't remove callers passing that literal — there are none after Task 2.1, but the copy function itself must not crash on an arbitrary unknown string, which it already handles via `default`).

- [ ] **Step 3: Implement**

In `pushUnavailableCopy.ts`, delete the `case 'android_push_not_configured':` block (lines 19-26), leaving `not_physical_device` and `default`.

- [ ] **Step 4: Run and verify pass**

Run: `cd apps/mobile && npx vitest run src/screens/chat/components/pushUnavailableCopy.test.ts`
Expected: PASS.

- [ ] **Step 5: Full mobile suite + typecheck**

Run: `pnpm --filter=breeze-mobile test` and `pnpm --filter=breeze-mobile typecheck`.
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/screens/chat/components/pushUnavailableCopy.ts apps/mobile/src/screens/chat/components/pushUnavailableCopy.test.ts
git commit -m "chore(mobile-push): retire the unreachable android_push_not_configured copy (#3639)"
```

### Task 2.3: Wire `google-services.json` into the Android build config

**Files:**
- Modify: `apps/mobile/app.json` (`android` block, around line 36)

- [ ] **Step 1: Add the config field**

```json
    "android": {
      "googleServicesFile": "./google-services.json",
      "adaptiveIcon": {
```

- [ ] **Step 2: Verify iOS and CI are unaffected**

`expo-notifications`' Android config plugin only resolves `googleServicesFile` during `expo prebuild --platform android` (or an Android EAS/Gradle build) — it plays no part in `expo prebuild --platform ios`, and `test-mobile` CI runs only `vitest` + `tsc`, never `expo prebuild`, so this is safe to land even before the real file exists (added in Wave 3). Confirm: `pnpm --filter=breeze-mobile test && pnpm --filter=breeze-mobile typecheck` still green, and `git grep -n googleServicesFile apps/mobile` shows only this one line.

**Do not run `npx expo prebuild --platform android` yet** — `apps/mobile/google-services.json` does not exist in the repo until Wave 3, and prebuild will fail loudly (by design — this is the same "fail the build rather than ship broken" posture as the Sentry DSN and API URL guards in `app.config.js`, except here Expo's own config plugin provides it for free, so no new guard code is needed).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app.json
git commit -m "chore(mobile-push): reference google-services.json for Android FCM (#3639)"
```

**Open the PR here** (Wave 2, independently mergeable, does not depend on the real `google-services.json` file existing to merge — only to actually prebuild/ship an Android build).

---

## Wave 3 — Firebase Android app registration (operational, Todd)

**Independently shippable:** yes — this wave produces no code diff by itself beyond the two doc updates below; its deliverable is external state (a Firebase Android app + a real `google-services.json`) plus prod env var confirmation. Blocks Wave 4 (nothing to verify on-device without it).

- [ ] **Step 1: Confirm or create the Firebase Android app**

The server already has *some* Firebase project configured — `notifications.ts`'s `sendFCM` (pre-Wave-1) has been sending alert pushes via `admin.messaging().send()` using whatever `FIREBASE_SERVICE_ACCOUNT` is set in production today. Before assuming new infra is needed: in the Firebase Console for that existing project, check whether an Android app with package name `com.breeze.rmm` is already registered (it may predate this plan, from whoever originally wired `notifications.ts`). If yes, skip to Step 2. If no project exists at all, or the existing service account belongs to an unrelated project, create/select a Firebase project and add an Android app there with package name `com.breeze.rmm` (must match `apps/mobile/app.json`'s `android.package`).

- [ ] **Step 2: Download `google-services.json` and add it to the repo**

Download the file from the Firebase Console (Project Settings → your Android app → "Download google-services.json") and commit it at `apps/mobile/google-services.json` (the path Task 2.3 referenced). This file is not a secret by Google's own documentation — it identifies the project and carries a client API key restricted by Android package name + signing certificate, not a bearer credential — so it is safe to commit alongside the already-public `com.breeze.rmm` bundle/package identifiers. If preferred, it can instead be kept out of git and injected at build time (matching how `.env`-derived secrets are handled elsewhere in `apps/mobile`); **flag this choice to Todd explicitly rather than deciding it here** (see the open question below).

- [ ] **Step 3: Confirm `FIREBASE_SERVICE_ACCOUNT` on both droplets**

`FIREBASE_SERVICE_ACCOUNT` is read directly via `process.env` in `apps/api/src/services/fcm.ts` (moved from `notifications.ts` in Wave 1) — unlike `APNS_*`, it is not validated through `apps/api/src/config/validate.ts`, so a missing value fails silently at first send (`isFcmConfigured()` returns false, `sendFcmNotification` returns `{ok:false, reason:'not_configured'}`, no error until someone notices Android pushes never arrive). SSH to each droplet and confirm `FIREBASE_SERVICE_ACCOUNT` is present in `/opt/breeze/.env` and mapped in the `api` service's `environment:` block of `/opt/breeze/docker-compose.yml` (per CLAUDE.md's "new required env var" rule) for **both** US and EU regions — it must correspond to the same Firebase project as the `google-services.json` from Step 2, or every Android token will fail with `messaging/mismatched-credential` or a similar SDK error even though the sender reports itself configured.

- [ ] **Step 4: Update `STORE_SUBMISSION.md`**

Replace the "Android push is **not wired**..." paragraph in the "Push notifications — server side is already live" section with a parallel Android subsection documenting: native FCM (not Expo relay) mirroring the iOS native-APNs approach, the `google-services.json` location and how to regenerate it, and the same droplet env var caveat as iOS's `APNS_ENVIRONMENT` warning (FCM has no sandbox/production split the way APNs does, so there is no equivalent gotcha to flag — call that out explicitly so a future reader doesn't go looking for one).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/google-services.json apps/mobile/STORE_SUBMISSION.md
git commit -m "chore(mobile-push): register Firebase Android app, document Android push (#3639)"
```

**Open the PR here** (Wave 3).

---

## Wave 4 — Verification: TestFlight regression + Play internal-testing track

**Independently shippable:** this is a verification pass, not new code — no PR of its own unless it surfaces a bug, in which case file it as a normal fix (small findings get fixed inline per the fix-inline convention, larger ones get their own issue).

- [ ] **Step 1: iOS regression via TestFlight**

Confirm Waves 1-3 caused no iOS regression: `notifications.ts`'s `sendFCM` refactor (Task 1.2) and `expoPush.ts`'s new fcm branch (Task 1.3) touch code paths iOS never enters (`provider === 'apns'`/`'expo'` branches are untouched), and Task 2.1's mobile change collapses the iOS branch to the same `getDevicePushTokenAsync()` call it already made — so this should be a no-op regression check, not new work. Install the current TestFlight build (or cut a new one per `STORE_SUBMISSION.md`'s build/archive steps if the mobile changes haven't shipped there yet), trigger an approval push and a ticket push from a test org, and confirm both still arrive and deep-link correctly.

- [ ] **Step 2: Build an Android release artifact**

`google-services.json` (Wave 3) must exist in the repo before this step — `expo prebuild --platform android` fails otherwise, by design. Run `npx expo prebuild --platform android` to generate the native Android project (carries the Firebase config, notification icon/color from `app.json`'s `expo-notifications` plugin block, and permissions into the generated manifest), then build a release AAB/APK via the generated Gradle project (`cd android && ./gradlew bundleRelease` for an AAB, or `assembleRelease` for a directly-installable APK). Put `EXPO_PUBLIC_API_URL` (and, per the Sentry guard, `EXPO_PUBLIC_SENTRY_DSN` unless deliberately suppressed with `BREEZE_MOBILE_ALLOW_NO_SENTRY=1`) in `apps/mobile/.env` first, same as the iOS release path.

- [ ] **Step 3: Play Console — internal testing track**

Create (or reuse, if one already exists from earlier exploratory work — check the Play Console before assuming none exists) a Play Console app record for `com.breeze.rmm`, upload the AAB from Step 2 to the **Internal testing** track (no store review required, fastest path to a real device), and add the test account as an internal tester. This is scoped to push verification only — a full Play Store *listing* submission (description, screenshots, content rating, Data Safety form) mirrors the iOS `STORE_SUBMISSION.md`/#1155 checklist and is out of scope for this plan; file it as a follow-up issue ("Breeze Mobile on Google Play", mirroring #1155) once this verification confirms push actually works end-to-end.

- [ ] **Step 4: End-to-end push verification on a real Android device**

Install the internal-testing build on a physical Android device (FCM does not reliably deliver to the Android Emulator's default image without Google Play services configured — use a real device or a Play-Store-enabled emulator image). Sign in, confirm `registerForPushNotifications()` reports `{status: 'ok'}` (Settings sheet shows the "delivered to this phone" copy from `notificationsRowCopy`, not the retired unsupported copy), and confirm the registered token is a raw FCM token (not `ExponentPushToken[...]`) in the `mobile_devices.fcm_token` column. Trigger the same approval push and ticket push as Step 1 from the API/web side and confirm delivery, lock-screen content (action verb + client label only, per the existing lock-screen-safe contract in `buildApprovalPush`/`buildTicketPush`), and tap-to-navigate.

- [ ] **Step 5: Confirm dead-token purge behavior**

Uninstall the app (or revoke notification permission and let the OS invalidate the token, if that's reliably reproducible — uninstall is the more deterministic trigger), then trigger another push to the same user from a device that still has a *different* valid token, and confirm in server logs / the `mobile_devices` table that the dead FCM token was purged (via Task 1.3's `purgeFcmToken`) rather than retried indefinitely.

- [ ] **Step 6: Record results**

Note the outcome (pass/fail per step, any bugs filed) in a comment on issue #3639, and close it once Steps 1-5 all pass.

---

## Self-Review Notes

- **Spec coverage:** issue #3639's two named symptoms — "server skips raw FCM tokens" (Wave 1) and "no Expo project config" (Wave 2, resolved by removing the dependency on `projectId` rather than restoring it — see Design Decision) — are both covered. "Token registration path" = Wave 2. "Server send path parity with iOS" = Wave 1's `fcm.ts`/`apns.ts` mirroring. "TestFlight/Play-track verification" = Wave 4.
- **Placeholder scan:** no TBD/"add error handling"/"similar to Task N" phrasing; every code step has real, complete code.
- **Type consistency:** `FcmPayload`/`FcmResult` (Task 1.1) are used identically in Task 1.2 and Task 1.3; `dispatchPushToTokens`'s existing `PushSpec` fields (`title`, `body`, `data`, `ttl`, `channelId`, `collapseId`) map 1:1 onto the new fcm branch's call, matching the apns branch's existing mapping.
- **Open questions for Todd (not blocking Waves 1-2, blocking Wave 3 step 2):**
  1. Does a Firebase project + Android app for `com.breeze.rmm` already exist (backing `notifications.ts`'s pre-existing alert-push `sendFCM`), or does one need to be created from scratch?
  2. Commit `google-services.json` to the (public) repo, or keep it out of git and inject at build time? Recommendation in Wave 3 Step 2 is "commit it" (Google's own guidance treats it as safe), but this repo is unusually strict about not committing infra identifiers — flagging rather than deciding.
