# Reset-Password Temporary Credential Reveal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the `m365_reset_password` temporary credential stored in `action_intents.result` via a one-time, audited, requester-gated reveal endpoint with at-rest encryption, plus the ApprovalHistoryFeed UI to use it.

**Architecture:** The release worker seals `temporaryPassword` with `secretCrypto` (AES-256-GCM, AAD `action_intents.result`) before storage. A new narrow router `POST /action-intents/:id/reveal-secret` authorizes (requester, or `approvals:decide` fallback for API-key-requested intents), decrypts, then CAS-burns the ciphertext out of the jsonb — at most one reveal ever succeeds. The existing intent expiry reaper additionally redacts un-revealed secrets older than 7 days. The AI Risk dashboard feed gains `intentId` + `tempPasswordState` and a reveal panel.

**Tech Stack:** Hono, Drizzle + postgres.js, BullMQ (existing reaper), Vitest, React + i18next.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-07-19-reset-password-reveal-design.md`

## Global Constraints

- **The plaintext password must never appear in**: audit `details`, `console.*` output, error messages, metrics, or web console/analytics. Tests assert this with `JSON.stringify(...)` non-containment checks.
- **Fail closed**: any authz ambiguity → 403; missing intent / wrong status / no secret → uniform `404 { error: 'not_found' }` (no oracle).
- **Reveal window**: 7 days from `executedAt` — single source of truth `REVEAL_WINDOW_DAYS = 7` exported from `resultSecrets.ts`.
- **No DB migration in this plan.** Burn/reveal state lives inside the `result` jsonb; the `action_intents_immutable_trg` trigger already permits `result` UPDATEs (verified: `apps/api/migrations/2026-07-18-action-intents.sql:92-94`).
- **i18n parity**: every new translation key must be added to ALL five locales (`apps/web/src/locales/{en,de-DE,es-419,fr-FR,pt-BR}/security.json`) in the same commit — a parity test reds CI otherwise.
- **Never edit shipped migrations.** (None are touched here.)
- Legacy plaintext `temporaryPassword` values (rows completed before this ships — feature flag is default-off, so ~zero) are handled by the reveal path and the sweep, both of which recognize both keys.
- Deviation from spec §5, recorded here: the "cross-org reveal 404s as `breeze_app`" integration test is NOT re-implemented — `action_intents` is Shape-1 RLS and already covered by the auto-discovery in `rls-coverage.integration.test.ts`; the reveal route does a plain RLS-scoped select, adding no new SQL surface. The CAS-burn concurrency and sweep tests (Task 4) are the net-new real-DB coverage.

---

### Task 1: Secret seal/unseal/burn service — `resultSecrets.ts`

**Files:**
- Create: `apps/api/src/services/actionIntents/resultSecrets.ts`
- Test: `apps/api/src/services/actionIntents/resultSecrets.test.ts`

**Interfaces:**
- Consumes: `encryptSecret(value, { aad })` / `decryptSecret(value, { aad, strict })` from `apps/api/src/services/secretCrypto.ts` (both `(string | null | undefined, SecretCryptoOptions) => string | null`); `db` from `../../db`; `actionIntents` from `../../db/schema/actionIntents`.
- Produces (used by Tasks 2–5):
  - `sealActionResultSecrets(result: Record<string, unknown>): Record<string, unknown>`
  - `hasSealedTemporaryPassword(result: Record<string, unknown>): boolean`
  - `unsealTemporaryPassword(result: Record<string, unknown>): string | null` (throws on tampered ciphertext)
  - `burnTemporaryPassword(intentId: string, marker: { revealedByUserId: string } | { expired: true }): Promise<boolean>`
  - Constants: `REVEAL_WINDOW_DAYS`, `ACTION_INTENT_RESULT_AAD`, `TEMP_PASSWORD_ENC_KEY`, `TEMP_PASSWORD_LEGACY_KEY`, `TEMP_PASSWORD_REVEALED_KEY`, `TEMP_PASSWORD_EXPIRED_KEY`

- [ ] **Step 1: Write the failing test**

`apps/api/src/services/actionIntents/resultSecrets.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { encryptSecretMock, decryptSecretMock, updateMock } = vi.hoisted(() => ({
  encryptSecretMock: vi.fn(
    (v: string | null | undefined, opts?: { aad?: string }) =>
      v == null ? null : `enc:v3:test:${opts?.aad}:${v}`,
  ),
  decryptSecretMock: vi.fn(
    (v: string | null | undefined, opts?: { aad?: string; strict?: boolean }) => {
      if (v == null) return null;
      const prefix = `enc:v3:test:${opts?.aad}:`;
      if (!v.startsWith(prefix)) throw new Error('AAD mismatch / tampered ciphertext');
      return v.slice(prefix.length);
    },
  ),
  updateMock: vi.fn(),
}));

vi.mock('../secretCrypto', () => ({
  encryptSecret: encryptSecretMock,
  decryptSecret: decryptSecretMock,
}));
vi.mock('../../db', () => ({ db: { update: updateMock } }));
vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: { id: 'action_intents.id', result: 'action_intents.result' },
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join('?'), vals }),
    { raw: (s: string) => s },
  ),
}));

import {
  ACTION_INTENT_RESULT_AAD,
  burnTemporaryPassword,
  hasSealedTemporaryPassword,
  sealActionResultSecrets,
  unsealTemporaryPassword,
} from './resultSecrets';

const RESET_RESULT = {
  success: true,
  action: 'm365.user.reset_password',
  userId: 'target-user-1',
  temporaryPassword: 'Tmp-Pass-1234!',
  forceChangeNextSignIn: true,
};

function mockBurnReturning(rows: Array<{ id: string }>) {
  updateMock.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sealActionResultSecrets', () => {
  it('replaces temporaryPassword with AAD-bound ciphertext for reset results', () => {
    const sealed = sealActionResultSecrets(RESET_RESULT);
    expect(sealed.temporaryPasswordEnc).toBe(
      `enc:v3:test:${ACTION_INTENT_RESULT_AAD}:Tmp-Pass-1234!`,
    );
    expect(sealed).not.toHaveProperty('temporaryPassword');
    expect(JSON.stringify(sealed)).not.toContain('Tmp-Pass-1234!');
    // Non-secret fields pass through untouched.
    expect(sealed.userId).toBe('target-user-1');
    expect(sealed.forceChangeNextSignIn).toBe(true);
    expect(encryptSecretMock).toHaveBeenCalledWith('Tmp-Pass-1234!', {
      aad: ACTION_INTENT_RESULT_AAD,
    });
  });

  it('passes non-reset results through unchanged', () => {
    const other = { success: true, action: 'm365.user.disable', userId: 'u' };
    expect(sealActionResultSecrets(other)).toBe(other);
    expect(encryptSecretMock).not.toHaveBeenCalled();
  });

  it('passes a reset result with no password string through unchanged', () => {
    const noPw = { success: true, action: 'm365.user.reset_password', userId: 'u' };
    expect(sealActionResultSecrets(noPw)).toBe(noPw);
  });
});

describe('hasSealedTemporaryPassword', () => {
  it('detects the sealed key, the legacy plaintext key, and neither', () => {
    expect(hasSealedTemporaryPassword({ temporaryPasswordEnc: 'enc:v3:x' })).toBe(true);
    expect(hasSealedTemporaryPassword({ temporaryPassword: 'plain' })).toBe(true);
    expect(hasSealedTemporaryPassword({ temporaryPasswordRevealed: {} })).toBe(false);
    expect(hasSealedTemporaryPassword({})).toBe(false);
  });
});

describe('unsealTemporaryPassword', () => {
  it('decrypts the sealed key with strict AAD binding', () => {
    const sealed = sealActionResultSecrets(RESET_RESULT);
    expect(unsealTemporaryPassword(sealed)).toBe('Tmp-Pass-1234!');
    expect(decryptSecretMock).toHaveBeenCalledWith(sealed.temporaryPasswordEnc, {
      aad: ACTION_INTENT_RESULT_AAD,
      strict: true,
    });
  });

  it('returns legacy plaintext as-is', () => {
    expect(unsealTemporaryPassword({ temporaryPassword: 'Legacy-1!' })).toBe('Legacy-1!');
    expect(decryptSecretMock).not.toHaveBeenCalled();
  });

  it('returns null when no secret is present', () => {
    expect(unsealTemporaryPassword({ temporaryPasswordRevealed: {} })).toBeNull();
  });

  it('propagates decrypt failures (tampered ciphertext) instead of swallowing them', () => {
    expect(() => unsealTemporaryPassword({ temporaryPasswordEnc: 'enc:v3:wrong-aad:x' })).toThrow();
  });
});

describe('burnTemporaryPassword', () => {
  it('returns true when the CAS update burned a row', async () => {
    mockBurnReturning([{ id: 'intent-1' }]);
    await expect(
      burnTemporaryPassword('intent-1', { revealedByUserId: 'user-1' }),
    ).resolves.toBe(true);
  });

  it('returns false when the secret was already gone (lost the race)', async () => {
    mockBurnReturning([]);
    await expect(burnTemporaryPassword('intent-1', { expired: true })).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/actionIntents/resultSecrets.test.ts`
Expected: FAIL — `Cannot find module './resultSecrets'`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/actionIntents/resultSecrets.ts`:

```ts
/**
 * Seal/reveal handling for secrets inside action_intents.result.
 *
 * Registry of secret-bearing action results (today: only the M365 reset
 * password). The temporary password is encrypted at rest (AES-256-GCM via
 * secretCrypto, AAD-bound to action_intents.result), revealed AT MOST ONCE via
 * POST /action-intents/:id/reveal-secret, and burned out of the jsonb by a CAS
 * update the moment it is revealed — or redacted by the expiry reaper after
 * REVEAL_WINDOW_DAYS. The plaintext must never reach logs, audit details, or
 * metrics.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { decryptSecret, encryptSecret } from '../secretCrypto';

export const ACTION_INTENT_RESULT_AAD = 'action_intents.result';
export const TEMP_PASSWORD_ENC_KEY = 'temporaryPasswordEnc';
export const TEMP_PASSWORD_LEGACY_KEY = 'temporaryPassword';
export const TEMP_PASSWORD_REVEALED_KEY = 'temporaryPasswordRevealed';
export const TEMP_PASSWORD_EXPIRED_KEY = 'temporaryPasswordExpired';
export const REVEAL_WINDOW_DAYS = 7;

const SECRET_BEARING_ACTION = 'm365.user.reset_password';

/** Encrypt secret fields in an executor result before it is stored. */
export function sealActionResultSecrets(
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result.action !== SECRET_BEARING_ACTION) return result;
  const pw = result[TEMP_PASSWORD_LEGACY_KEY];
  if (typeof pw !== 'string' || pw.length === 0) return result;
  const sealed = encryptSecret(pw, { aad: ACTION_INTENT_RESULT_AAD });
  if (!sealed) return result;
  const { [TEMP_PASSWORD_LEGACY_KEY]: _plain, ...rest } = result;
  return { ...rest, [TEMP_PASSWORD_ENC_KEY]: sealed };
}

export function hasSealedTemporaryPassword(result: Record<string, unknown>): boolean {
  return (
    typeof result[TEMP_PASSWORD_ENC_KEY] === 'string' ||
    typeof result[TEMP_PASSWORD_LEGACY_KEY] === 'string'
  );
}

/**
 * Decrypt the sealed password (or return a legacy plaintext one). Throws on
 * tampered/AAD-mismatched ciphertext — callers must treat that as a 500 and
 * must NOT burn.
 */
export function unsealTemporaryPassword(result: Record<string, unknown>): string | null {
  const sealed = result[TEMP_PASSWORD_ENC_KEY];
  if (typeof sealed === 'string') {
    return decryptSecret(sealed, { aad: ACTION_INTENT_RESULT_AAD, strict: true });
  }
  const legacy = result[TEMP_PASSWORD_LEGACY_KEY];
  return typeof legacy === 'string' ? legacy : null;
}

/**
 * Atomically remove the secret from result, leaving a marker. The WHERE clause
 * requires the secret to still be present, so under concurrent reveals exactly
 * one caller gets `true` — only that caller may return the plaintext.
 * Runs in the ambient db context (request RLS context from routes; system
 * context from the reaper).
 */
export async function burnTemporaryPassword(
  intentId: string,
  marker: { revealedByUserId: string } | { expired: true },
): Promise<boolean> {
  const markerSql =
    'expired' in marker
      ? sql`jsonb_build_object(${TEMP_PASSWORD_EXPIRED_KEY}::text, true)`
      : sql`jsonb_build_object(${TEMP_PASSWORD_REVEALED_KEY}::text, jsonb_build_object('revealedAt', to_jsonb(now()), 'revealedByUserId', ${marker.revealedByUserId}::text))`;
  const rows = await db
    .update(actionIntents)
    .set({
      result: sql`(coalesce(${actionIntents.result}, '{}'::jsonb) - ${TEMP_PASSWORD_ENC_KEY}::text - ${TEMP_PASSWORD_LEGACY_KEY}::text) || ${markerSql}`,
    })
    .where(
      and(
        eq(actionIntents.id, intentId),
        sql`${actionIntents.result} ?| array[${TEMP_PASSWORD_ENC_KEY}::text, ${TEMP_PASSWORD_LEGACY_KEY}::text]`,
      ),
    )
    .returning({ id: actionIntents.id });
  return rows.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/actionIntents/resultSecrets.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/resultSecrets.ts apps/api/src/services/actionIntents/resultSecrets.test.ts
git commit -m "feat(api): seal/unseal/burn service for action-intent result secrets"
```

---

### Task 2: Seal at write time in the release worker

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (the `executing -> completed` transition, ~line 339; `MAX_RESULT_BYTES` is at line 54)
- Modify: `apps/api/src/services/m365ToolsHeadless.ts:87-90` (stale comment)
- Test: `apps/api/src/jobs/intentReleaseWorker.test.ts` (existing file — extend)

**Interfaces:**
- Consumes: `sealActionResultSecrets(result)` from Task 1.
- Produces: `action_intents.result` for completed reset intents now contains `temporaryPasswordEnc` (ciphertext), never `temporaryPassword`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/jobs/intentReleaseWorker.test.ts`:

1. Add a `secretCrypto` mock next to the other `vi.mock` calls (~line 119, after the m365ToolsHeadless mock) — the real `resultSecrets.ts` module stays unmocked so the worker exercises it:

```ts
// resultSecrets.ts stays REAL; only the crypto primitive is stubbed so sealing
// is deterministic and needs no APP_ENCRYPTION_KEY.
vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((v: string | null | undefined) => (v == null ? null : `enc:v3:test:${v}`)),
  decryptSecret: vi.fn(),
}));
```

2. Add this test inside `describe('releaseApprovedIntent', ...)`. Mirror the invocation style of the existing happy-path test (`'happy path: CAS -> revalidate -> executeTool -> CAS completed, with a JSON result'`, ~line 252) — same `primeThroughRevalidation` + same call under test:

```ts
it('m365 reset: temporaryPassword is sealed before the completed transition', async () => {
  const intent = baseIntent({ actionName: 'm365_reset_password' });
  primeThroughRevalidation(intent);
  googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(false);
  m365HeadlessMock.isHeadlessM365Tool.mockReturnValue(true);
  m365HeadlessMock.executeM365ToolHeadless.mockResolvedValueOnce(
    JSON.stringify({
      success: true,
      action: 'm365.user.reset_password',
      userId: 'target-user-1',
      temporaryPassword: 'Tmp-Pass-1234!',
      forceChangeNextSignIn: true,
    }),
  );
  intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

  await releaseApprovedIntent(intent.id); // ← use the exact call form of the happy-path test

  expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
    intent.id,
    'executing',
    'completed',
    expect.objectContaining({
      result: expect.objectContaining({
        temporaryPasswordEnc: 'enc:v3:test:Tmp-Pass-1234!',
        userId: 'target-user-1',
      }),
    }),
  );
  const lastPatch = intentServiceMock.transitionIntent.mock.lastCall![3] as {
    result: Record<string, unknown>;
  };
  expect(lastPatch.result).not.toHaveProperty('temporaryPassword');
  expect(JSON.stringify(lastPatch.result)).not.toContain('Tmp-Pass-1234!');
});
```

(If `releaseApprovedIntent` takes the intent object or a job payload rather than the id, copy the exact argument form from the happy-path test — do not guess.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/intentReleaseWorker.test.ts -t "sealed before the completed transition"`
Expected: FAIL — the `result` patch still contains plaintext `temporaryPassword` (assertion on `temporaryPasswordEnc` fails).

- [ ] **Step 3: Implement sealing in the worker**

In `apps/api/src/jobs/intentReleaseWorker.ts`, add the import:

```ts
import { sealActionResultSecrets } from '../services/actionIntents/resultSecrets';
```

Replace the completed transition (currently):

```ts
  const completed = await transitionIntent(intent.id, 'executing', 'completed', {
    executedAt: new Date(),
    result: storedResult,
  });
```

with:

```ts
  // Seal any secret fields (reset_password temporaryPassword) before storage.
  // Re-check the size cap afterwards: ciphertext is larger than plaintext.
  let finalResult = sealActionResultSecrets(storedResult);
  if (Buffer.byteLength(JSON.stringify(finalResult), 'utf8') > MAX_RESULT_BYTES) {
    finalResult = { truncated: true };
  }
  const completed = await transitionIntent(intent.id, 'executing', 'completed', {
    executedAt: new Date(),
    result: finalResult,
  });
```

(The `failed:tool_returned_error` path keeps storing `storedResult` unsealed — error bodies fail the `writeActionResultSchema` success shape and never contain a password.)

- [ ] **Step 4: Update the stale comment in `m365ToolsHeadless.ts`**

Replace lines 87-89:

```ts
  // Success body is stored verbatim into intent.result (has `success`, so the
  // worker's isReturnedToolError treats it as a completion). For reset it
  // carries temporaryPassword for the approvals-UI reveal.
```

with:

```ts
  // Success body is normalized and passed through sealActionResultSecrets by
  // the release worker before storage (has `success`, so isReturnedToolError
  // treats it as a completion). For reset the temporaryPassword is encrypted
  // at rest in intent.result and revealed once via
  // POST /action-intents/:id/reveal-secret.
```

- [ ] **Step 5: Run the full worker suite**

Run: `cd apps/api && npx vitest run src/jobs/intentReleaseWorker.test.ts`
Expected: PASS — the new test and all pre-existing tests (sealing is a pass-through for non-reset results, so nothing else changes).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts apps/api/src/services/m365ToolsHeadless.ts
git commit -m "feat(api): seal reset-password temp credential before storing intent result"
```

---

### Task 3: Reveal endpoint — `POST /action-intents/:id/reveal-secret`

**Files:**
- Create: `apps/api/src/routes/actionIntents.ts`
- Modify: `apps/api/src/services/actionIntents/metrics.ts:33-42` (add `'revealed'` to the outcome union)
- Modify: `apps/api/src/index.ts` (import + mount near line 896)
- Test: `apps/api/src/routes/actionIntents.test.ts`

**Interfaces:**
- Consumes: Task 1's `hasSealedTemporaryPassword`, `unsealTemporaryPassword`, `burnTemporaryPassword`, `REVEAL_WINDOW_DAYS`; `writeRouteAudit(c, RouteAuditInput)` from `../services/auditEvents`; `recordActionIntentEvent(ActionIntentAuditInput)` from `../services/actionIntents/metrics`; `getUserPermissions` / `canAccessOrg` / `userCanDecideApprovals` from `../services/permissions`; `authMiddleware` from `../middleware/auth`.
- Produces: `POST /action-intents/:id/reveal-secret` → `200 { data: { temporaryPassword, userId, forceChangeNextSignIn, revealedAt } }` | `400` (bad uuid) | `403 { error: 'forbidden' }` | `404 { error: 'not_found' }` | `410 { error: 'reveal_expired' | 'already_revealed' }` | `500`. The web UI (Task 6) calls this.

- [ ] **Step 1: Add `'revealed'` to the outcome union**

In `apps/api/src/services/actionIntents/metrics.ts`, extend `ActionIntentOutcome`:

```ts
export type ActionIntentOutcome =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'executed'
  | 'revealed'
  | 'self_approved_sole_operator'
  | 'digest_mismatch'
  | 'approver_unauthorized';
```

Do NOT add `revealed` to `FAILURE_OUTCOMES` — a reveal is a success event (`action_intent.revealed`, result `success`).

- [ ] **Step 2: Write the failing route tests**

`apps/api/src/routes/actionIntents.test.ts` (template: `apps/api/src/routes/security/recoveryKeys.test.ts` — same Hono-app build + chain mocks):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  selectMock,
  getUserPermissionsMock,
  canAccessOrgMock,
  userCanDecideApprovalsMock,
  writeRouteAuditMock,
  recordActionIntentEventMock,
  hasSealedMock,
  unsealMock,
  burnMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  canAccessOrgMock: vi.fn(() => true),
  userCanDecideApprovalsMock: vi.fn(() => true),
  writeRouteAuditMock: vi.fn(),
  recordActionIntentEventMock: vi.fn(),
  hasSealedMock: vi.fn(() => true),
  unsealMock: vi.fn(() => 'Tmp-Pass-1234!'),
  burnMock: vi.fn(async () => true),
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema/actionIntents', () => ({
  actionIntents: { id: 'action_intents.id' },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../services/permissions', () => ({
  getUserPermissions: getUserPermissionsMock,
  canAccessOrg: canAccessOrgMock,
  userCanDecideApprovals: userCanDecideApprovalsMock,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: recordActionIntentEventMock,
}));
vi.mock('../services/actionIntents/resultSecrets', () => ({
  REVEAL_WINDOW_DAYS: 7,
  hasSealedTemporaryPassword: hasSealedMock,
  unsealTemporaryPassword: unsealMock,
  burnTemporaryPassword: burnMock,
}));

import { actionIntentsRoutes } from './actionIntents';

const INTENT_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '44444444-4444-4444-8444-444444444444';
const PLAINTEXT = 'Tmp-Pass-1234!';

function baseIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    orgId: ORG_ID,
    requestedByUserId: 'user-1',
    requestingApiKeyId: null,
    source: 'chat',
    actionName: 'm365_reset_password',
    argumentDigest: 'a'.repeat(64),
    status: 'completed',
    executedAt: new Date(), // inside the window
    result: {
      success: true,
      action: 'm365.user.reset_password',
      userId: 'target-user-1',
      temporaryPasswordEnc: 'enc:v3:x',
      forceChangeNextSignIn: true,
    },
    ...overrides,
  };
}

function mockIntentSelect(rows: unknown[]) {
  selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

function buildApp(userId = 'user-1'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: userId, email: 'tech@example.com', name: 'Tech' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as never);
    await next();
  });
  app.route('/action-intents', actionIntentsRoutes);
  return app;
}

function reveal(app: Hono, id = INTENT_ID) {
  return app.request(`/action-intents/${id}/reveal-secret`, { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasSealedMock.mockReturnValue(true);
  unsealMock.mockReturnValue(PLAINTEXT);
  burnMock.mockResolvedValue(true);
  canAccessOrgMock.mockReturnValue(true);
  userCanDecideApprovalsMock.mockReturnValue(true);
});

describe('POST /action-intents/:id/reveal-secret', () => {
  it('requester happy path: returns the password once, burns, audits without plaintext', async () => {
    mockIntentSelect([baseIntent()]);
    const res = await reveal(buildApp('user-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.temporaryPassword).toBe(PLAINTEXT);
    expect(body.data.userId).toBe('target-user-1');
    expect(body.data.forceChangeNextSignIn).toBe(true);

    expect(burnMock).toHaveBeenCalledWith(INTENT_ID, { revealedByUserId: 'user-1' });

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeRouteAuditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(audit.action).toBe('action_intent.temp_password.reveal');
    expect(audit.result).toBe('success');
    expect((audit.details as Record<string, unknown>).revealPath).toBe('requester');
    expect(JSON.stringify(audit)).not.toContain(PLAINTEXT);

    expect(recordActionIntentEventMock).toHaveBeenCalledTimes(1);
    const evt = recordActionIntentEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(evt.outcome).toBe('revealed');
    expect(JSON.stringify(evt)).not.toContain(PLAINTEXT);
  });

  it('a different user than the requester gets 403, burn never called, denial audited', async () => {
    mockIntentSelect([baseIntent()]);
    const res = await reveal(buildApp('someone-else'));
    expect(res.status).toBe(403);
    expect(burnMock).not.toHaveBeenCalled();
    expect(unsealMock).not.toHaveBeenCalled();
    const audit = writeRouteAuditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(audit.result).toBe('denied');
  });

  it('API-key-requested intent: decide-holder with org access may reveal (admin_fallback)', async () => {
    mockIntentSelect([
      baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1', source: 'mcp_api' }),
    ]);
    getUserPermissionsMock.mockResolvedValueOnce({ some: 'perms' });
    const res = await reveal(buildApp('admin-1'));
    expect(res.status).toBe(200);
    const audit = writeRouteAuditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect((audit.details as Record<string, unknown>).revealPath).toBe('admin_fallback');
  });

  it('API-key-requested intent: user without approvals:decide gets 403', async () => {
    mockIntentSelect([baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1' })]);
    getUserPermissionsMock.mockResolvedValueOnce({ some: 'perms' });
    userCanDecideApprovalsMock.mockReturnValue(false);
    const res = await reveal(buildApp('admin-1'));
    expect(res.status).toBe(403);
    expect(burnMock).not.toHaveBeenCalled();
  });

  it('API-key-requested intent: decide-holder without org access gets 403', async () => {
    mockIntentSelect([baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1' })]);
    getUserPermissionsMock.mockResolvedValueOnce({ some: 'perms' });
    canAccessOrgMock.mockReturnValue(false);
    const res = await reveal(buildApp('admin-1'));
    expect(res.status).toBe(403);
  });

  it('unknown intent id (RLS-invisible) is a uniform 404', async () => {
    mockIntentSelect([]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(404);
  });

  it('non-completed intent is a uniform 404', async () => {
    mockIntentSelect([baseIntent({ status: 'executing' })]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(404);
  });

  it('completed intent without a secret is a uniform 404', async () => {
    hasSealedMock.mockReturnValue(false);
    mockIntentSelect([baseIntent({ result: { success: true } })]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(404);
  });

  it('double reveal: burn CAS lost -> 410, response contains no password', async () => {
    mockIntentSelect([baseIntent()]);
    burnMock.mockResolvedValueOnce(false);
    const res = await reveal(buildApp());
    expect(res.status).toBe(410);
    expect(JSON.stringify(await res.json())).not.toContain(PLAINTEXT);
  });

  it('outside the 7-day window: 410 + lazy redact with the expired marker', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    mockIntentSelect([baseIntent({ executedAt: old })]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(410);
    expect(burnMock).toHaveBeenCalledWith(INTENT_ID, { expired: true });
    expect(unsealMock).not.toHaveBeenCalled();
  });

  it('decrypt failure: 500 and the secret is NOT burned', async () => {
    mockIntentSelect([baseIntent()]);
    unsealMock.mockImplementationOnce(() => {
      throw new Error('AAD mismatch');
    });
    const res = await reveal(buildApp());
    expect(res.status).toBe(500);
    expect(burnMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain(PLAINTEXT);
  });

  it('non-uuid id is rejected with 400 before any db access', async () => {
    const res = await reveal(buildApp(), 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/actionIntents.test.ts`
Expected: FAIL — `Cannot find module './actionIntents'`.

- [ ] **Step 4: Implement the route**

`apps/api/src/routes/actionIntents.ts`:

```ts
/**
 * Narrow, security-sensitive surface for action_intents. Deliberately NOT part
 * of the mobile /mobile/approvals router. Today it exposes exactly one thing:
 * the one-time reveal of a headless reset-password temporary credential.
 *
 * Security contract (spec 2026-07-19-reset-password-reveal-design.md):
 * - Shape-1 org RLS scopes every read and the burn write; fail closed.
 * - Requester-only; admin fallback (approvals:decide + org access) exists only
 *   for API-key-requested intents, which have no requesting user.
 * - At most one reveal ever succeeds (CAS burn); 7-day window from executedAt.
 * - The plaintext appears ONLY in the success response body — never in audit
 *   details, logs, metrics, or error messages.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { authMiddleware } from '../middleware/auth';
import { canAccessOrg, getUserPermissions, userCanDecideApprovals } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import { recordActionIntentEvent } from '../services/actionIntents/metrics';
import {
  REVEAL_WINDOW_DAYS,
  burnTemporaryPassword,
  hasSealedTemporaryPassword,
  unsealTemporaryPassword,
} from '../services/actionIntents/resultSecrets';

export const actionIntentsRoutes = new Hono();

actionIntentsRoutes.use('*', authMiddleware);

const REVEAL_WINDOW_MS = REVEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const revealParamSchema = z.object({ id: z.string().uuid() });

actionIntentsRoutes.post(
  '/:id/reveal-secret',
  zValidator('param', revealParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    // Shape-1 org RLS scopes this select — rows outside the caller's orgs are
    // simply invisible, which folds into the uniform 404 below.
    const [intent] = await db
      .select()
      .from(actionIntents)
      .where(eq(actionIntents.id, id))
      .limit(1);

    // Uniform 404: no oracle distinguishing "no such intent" from "wrong
    // status" from "nothing to reveal".
    const result = (intent?.result ?? {}) as Record<string, unknown>;
    if (!intent || intent.status !== 'completed' || !hasSealedTemporaryPassword(result)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const revealPath = intent.requestedByUserId ? 'requester' : 'admin_fallback';
    const audit = (outcome: 'success' | 'denied') =>
      writeRouteAudit(c, {
        orgId: intent.orgId,
        action: 'action_intent.temp_password.reveal',
        resourceType: 'action_intent',
        resourceId: intent.id,
        result: outcome,
        details: { intentId: intent.id, actionName: intent.actionName, revealPath },
      });

    if (intent.requestedByUserId) {
      if (intent.requestedByUserId !== auth.user.id) {
        audit('denied');
        return c.json({ error: 'forbidden' }, 403);
      }
    } else {
      // API-key/MCP-requested intent: no requesting user exists. Mirror the
      // decide path's live permission re-resolution (approvals.ts:540-566).
      const perms = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          getUserPermissions(auth.user.id, {
            partnerId: auth.partnerId ?? undefined,
            orgId: intent.orgId,
          }),
        ),
      );
      if (!perms || !canAccessOrg(perms, intent.orgId) || !userCanDecideApprovals(perms)) {
        audit('denied');
        return c.json({ error: 'forbidden' }, 403);
      }
    }

    const executedAtMs = intent.executedAt ? new Date(intent.executedAt).getTime() : 0;
    if (!executedAtMs || Date.now() - executedAtMs > REVEAL_WINDOW_MS) {
      // Lazily redact so the ciphertext doesn't outlive its window.
      await burnTemporaryPassword(intent.id, { expired: true });
      return c.json({ error: 'reveal_expired' }, 410);
    }

    // Decrypt BEFORE burning — never burn a secret we could not return.
    let temporaryPassword: string | null;
    try {
      temporaryPassword = unsealTemporaryPassword(result);
    } catch (err) {
      console.error('[action-intents] temp password decrypt failed:', {
        intentId: intent.id,
        error: err,
      });
      return c.json(
        { error: 'Failed to decrypt secret — check APP_ENCRYPTION_KEY configuration' },
        500,
      );
    }
    if (!temporaryPassword) {
      return c.json({ error: 'Secret material is empty' }, 500);
    }

    // CAS burn: exactly one concurrent caller wins; only the winner returns
    // the plaintext.
    const burned = await burnTemporaryPassword(intent.id, {
      revealedByUserId: auth.user.id,
    });
    if (!burned) {
      return c.json({ error: 'already_revealed' }, 410);
    }

    audit('success');
    recordActionIntentEvent({
      orgId: intent.orgId,
      intentId: intent.id,
      actionName: intent.actionName,
      argumentDigest: intent.argumentDigest,
      source: intent.source,
      outcome: 'revealed',
      actorId: auth.user.id,
      details: { revealPath },
    });

    return c.json({
      data: {
        temporaryPassword,
        userId: typeof result.userId === 'string' ? result.userId : null,
        forceChangeNextSignIn: result.forceChangeNextSignIn !== false,
        revealedAt: new Date().toISOString(),
      },
    });
  },
);
```

- [ ] **Step 5: Mount the router**

In `apps/api/src/index.ts`, add with the other route imports:

```ts
import { actionIntentsRoutes } from './routes/actionIntents';
```

and next to `api.route('/mobile/approvals', approvalRoutes);` (line ~896):

```ts
api.route('/action-intents', actionIntentsRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/actionIntents.test.ts src/services/actionIntents/resultSecrets.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Typecheck**

Run: `cd apps/api && npx tsc --noEmit -p tsconfig.json`
Expected: clean (the `'revealed'` union addition and new route compile).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/actionIntents.ts apps/api/src/routes/actionIntents.test.ts apps/api/src/services/actionIntents/metrics.ts apps/api/src/index.ts
git commit -m "feat(api): one-time audited reveal endpoint for reset-password temp credential"
```

---

### Task 4: Expiry-reaper redaction sweep + real-DB integration tests

**Files:**
- Modify: `apps/api/src/jobs/intentExpiryReaper.ts` (new exported sweep + call it in `createWorker`)
- Test: `apps/api/src/services/actionIntents/resultSecrets.integration.test.ts` (new; covers CAS burn concurrency AND the sweep against real Postgres)

**Interfaces:**
- Consumes: `extractRows` (already in `intentExpiryReaper.ts`), `runWithSystemDbAccess` (already in the file), Task 1's `burnTemporaryPassword`, `REVEAL_WINDOW_DAYS`.
- Produces: `redactExpiredUnrevealedSecrets(): Promise<number>` exported from `intentExpiryReaper.ts`, executed every reaper pass (30s cadence — the query is a cheap indexed-status scan over completed tier-3 intents).

- [ ] **Step 1: Add the sweep to the reaper**

In `apps/api/src/jobs/intentExpiryReaper.ts`, add (after `reapStaleExecutingIntents`):

```ts
import { REVEAL_WINDOW_DAYS } from '../services/actionIntents/resultSecrets';
```

```ts
/**
 * Redact un-revealed reset-password secrets past the reveal window so no
 * ciphertext (or legacy plaintext) outlives REVEAL_WINDOW_DAYS at rest.
 * Counterpart of the reveal endpoint's lazy redaction; count-only logging.
 */
export async function redactExpiredUnrevealedSecrets(): Promise<number> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE ${actionIntents}
    SET result = (result - 'temporaryPasswordEnc' - 'temporaryPassword')
                 || jsonb_build_object('temporaryPasswordExpired', true)
    WHERE ${actionIntents.status} = 'completed'
      AND ${actionIntents.result} ?| array['temporaryPasswordEnc', 'temporaryPassword']
      AND ${actionIntents.executedAt} < now() - make_interval(days => ${REVEAL_WINDOW_DAYS})
    RETURNING ${actionIntents.id} AS id;
  `);
  const rows = extractRows<{ id: string }>(res);
  if (rows.length > 0) {
    console.log(
      `[IntentExpiryReaper] Redacted ${rows.length} expired un-revealed temp password(s)`,
    );
  }
  return rows.length;
}
```

In `createWorker` (lines ~281-305), extend the run:

```ts
      try {
        const expired = await runWithSystemDbAccess(reapExpiredIntents);
        const staleFailed = await runWithSystemDbAccess(reapStaleExecutingIntents);
        const secretsRedacted = await runWithSystemDbAccess(redactExpiredUnrevealedSecrets);
        // ... keep the existing logging ...
        return { expired, staleFailed, secretsRedacted };
      } catch (err) {
```

- [ ] **Step 2: Write the integration tests**

`apps/api/src/services/actionIntents/resultSecrets.integration.test.ts` — boilerplate copied from `apps/api/src/jobs/intentExpiryReaper.integration.test.ts` (shared setup TRUNCATEs tenant tables on every `beforeEach`, so all seeding lives in `beforeEach`):

```ts
import '../../__tests__/integration/setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { burnTemporaryPassword } from './resultSecrets';
import { redactExpiredUnrevealedSecrets } from '../../jobs/intentExpiryReaper';
import {
  createPartner,
  createOrganization,
  createUser,
} from '../../__tests__/integration/db-utils';

describe('resultSecrets burn + sweep (real PG)', () => {
  let orgId: string;
  let requestedByUserId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    requestedByUserId = user.id;
  });

  async function seedCompleted(fields: {
    executedAt: Date;
    result: Record<string, unknown>;
  }): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(actionIntents)
        .values({
          orgId,
          requestedByUserId,
          source: 'chat',
          actionName: 'm365_reset_password',
          arguments: {},
          argumentDigest: 'a'.repeat(64),
          targetSummary: 't',
          impactSummary: 'i',
          riskTier: 3,
          idempotencyKey: randomUUID(),
          correlationId: randomUUID(),
          status: 'completed',
          expiresAt: new Date(Date.now() + 3_600_000),
          decidedAt: new Date(),
          executedAt: fields.executedAt,
          result: fields.result,
        })
        .returning({ id: actionIntents.id });
      return row!.id;
    });
  }

  async function loadResult(id: string): Promise<Record<string, unknown>> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ result: actionIntents.result })
        .from(actionIntents)
        .where(eq(actionIntents.id, id))
        .limit(1);
      return (row!.result ?? {}) as Record<string, unknown>;
    });
  }

  const SEALED = {
    success: true,
    action: 'm365.user.reset_password',
    userId: 'u-1',
    temporaryPasswordEnc: 'enc:v3:integration-fake',
    forceChangeNextSignIn: true,
  };

  it('concurrent burns: exactly one caller wins the CAS', async () => {
    const id = await seedCompleted({ executedAt: new Date(), result: SEALED });
    const outcomes = await withSystemDbAccessContext(() =>
      Promise.all([
        burnTemporaryPassword(id, { revealedByUserId: requestedByUserId }),
        burnTemporaryPassword(id, { revealedByUserId: requestedByUserId }),
      ]),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const result = await loadResult(id);
    expect(result).not.toHaveProperty('temporaryPasswordEnc');
    expect(result).not.toHaveProperty('temporaryPassword');
    expect(result.temporaryPasswordRevealed).toMatchObject({
      revealedByUserId: requestedByUserId,
    });
    // Non-secret fields survive the burn.
    expect(result.userId).toBe('u-1');
  });

  it('sweep redacts old un-revealed secrets (both key forms), leaves recent and revealed rows alone', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldSealed = await seedCompleted({ executedAt: eightDaysAgo, result: SEALED });
    const oldLegacy = await seedCompleted({
      executedAt: eightDaysAgo,
      result: { ...SEALED, temporaryPasswordEnc: undefined, temporaryPassword: 'Plain-1!' },
    });
    const recent = await seedCompleted({ executedAt: new Date(), result: SEALED });
    const oldRevealed = await seedCompleted({
      executedAt: eightDaysAgo,
      result: {
        success: true,
        action: 'm365.user.reset_password',
        userId: 'u-1',
        temporaryPasswordRevealed: { revealedAt: eightDaysAgo.toISOString(), revealedByUserId: requestedByUserId },
      },
    });

    const count = await withSystemDbAccessContext(redactExpiredUnrevealedSecrets);
    expect(count).toBe(2);

    for (const id of [oldSealed, oldLegacy]) {
      const r = await loadResult(id);
      expect(r).not.toHaveProperty('temporaryPasswordEnc');
      expect(r).not.toHaveProperty('temporaryPassword');
      expect(r.temporaryPasswordExpired).toBe(true);
    }
    expect(await loadResult(recent)).toHaveProperty('temporaryPasswordEnc');
    const revealedResult = await loadResult(oldRevealed);
    expect(revealedResult.temporaryPasswordRevealed).toBeTruthy();
    expect(revealedResult).not.toHaveProperty('temporaryPasswordExpired');
  });
});
```

(Note: the seed helper writes `temporaryPasswordEnc: undefined` for the legacy row — strip undefined keys with `JSON.parse(JSON.stringify(...))` or build the object explicitly without the key if the insert complains.)

- [ ] **Step 3: Run the integration tests**

Requires the integration Postgres (port 5433 stack) to be up.
Run: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/actionIntents/resultSecrets.integration.test.ts`
Expected: PASS both tests. (First run before Step 1 would fail on the missing `redactExpiredUnrevealedSecrets` export — the import error is the failing-test signal here.)

- [ ] **Step 4: Run the existing reaper suites to catch regressions**

Run: `cd apps/api && npx vitest run src/jobs/intentExpiryReaper*.test.ts 2>/dev/null; npx vitest run -c vitest.integration.config.ts src/jobs/intentExpiryReaper.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/intentExpiryReaper.ts apps/api/src/services/actionIntents/resultSecrets.integration.test.ts
git commit -m "feat(api): reaper sweep redacts un-revealed temp passwords past the 7-day window"
```

---

### Task 5: `GET /ai/admin/tool-executions` — add `intentId` + `tempPasswordState`

**Files:**
- Modify: `apps/api/src/routes/ai.ts` (the executions select, lines ~1253-1272)
- Test: `apps/api/src/routes/ai_admin.test.ts` (existing `describe('GET /ai/admin/tool-executions')` block, line ~340)

**Interfaces:**
- Consumes: `aiToolExecutions.intentId` (`apps/api/src/db/schema/ai.ts:115`), `actionIntents` schema, Task 1's `REVEAL_WINDOW_DAYS` (jsonb key names are inlined as string literals in SQL).
- Produces: each row in `executions` additionally carries `intentId: string | null` and `tempPasswordState: 'available' | 'revealed' | 'expired' | null`. Task 6's UI consumes this.

- [ ] **Step 1: Extend the executions query**

In `apps/api/src/routes/ai.ts`, add `actionIntents` to the schema imports at the top of the file (it may already be imported — check) plus:

```ts
import { REVEAL_WINDOW_DAYS } from '../services/actionIntents/resultSecrets';
```

then change query 4 ("Raw executions list"):

```ts
    // 4. Raw executions list (leftJoin: only reset-password rows have an
    // intent with a revealable secret; everything else derives NULL state)
    const executions = await db
      .select({
        id: aiToolExecutions.id,
        sessionId: aiToolExecutions.sessionId,
        toolName: aiToolExecutions.toolName,
        status: aiToolExecutions.status,
        toolInput: aiToolExecutions.toolInput,
        approvedBy: aiToolExecutions.approvedBy,
        approvedAt: aiToolExecutions.approvedAt,
        durationMs: aiToolExecutions.durationMs,
        errorMessage: aiToolExecutions.errorMessage,
        createdAt: aiToolExecutions.createdAt,
        completedAt: aiToolExecutions.completedAt,
        intentId: aiToolExecutions.intentId,
        tempPasswordState: drizzleSql<'available' | 'revealed' | 'expired' | null>`CASE
          WHEN ${actionIntents.id} IS NULL THEN NULL
          WHEN ${actionIntents.result} ?| array['temporaryPasswordEnc', 'temporaryPassword'] THEN
            CASE
              WHEN ${actionIntents.executedAt} < now() - make_interval(days => ${REVEAL_WINDOW_DAYS}) THEN 'expired'
              ELSE 'available'
            END
          WHEN ${actionIntents.result} ? 'temporaryPasswordRevealed' THEN 'revealed'
          WHEN ${actionIntents.result} ? 'temporaryPasswordExpired' THEN 'expired'
          ELSE NULL
        END`,
      })
      .from(aiToolExecutions)
      .innerJoin(aiSessions, eq(aiToolExecutions.sessionId, aiSessions.id))
      .leftJoin(actionIntents, eq(aiToolExecutions.intentId, actionIntents.id))
      .where(and(...baseConditions))
      .orderBy(desc(aiToolExecutions.createdAt))
      .limit(limit);
```

(RLS note: this runs in the request's org context; the `action_intents` select policy admits the same org's rows, so the join can never leak cross-org state. The CASE only ever exposes key *presence*, never values.)

- [ ] **Step 2: Extend the tests**

In `apps/api/src/routes/ai_admin.test.ts`, inside `describe('GET /ai/admin/tool-executions')`, reuse the block's existing happy-path mock setup (generic db.select chain mocks). If the chain mock lacks `leftJoin`, add `leftJoin: vi.fn().mockReturnThis()` (or the file's equivalent chaining style) to it. Then add:

```ts
    it('selects intentId and tempPasswordState for the executions list', async () => {
      // ...reuse the existing happy-path arrangement from this describe block...
      // after the request:
      const selectCalls = vi.mocked(db.select).mock.calls;
      const execFields = selectCalls[selectCalls.length - 1]![0] as Record<string, unknown>;
      expect(execFields).toHaveProperty('intentId');
      expect(execFields).toHaveProperty('tempPasswordState');
    });
```

(The executions select is the last `db.select` call in the handler; asserting on the field map proves the new columns are requested. Real SQL semantics are covered by Task 4's integration tests — mocked chains cannot verify jsonb operators, per the repo's known mocked-execute blindspot.)

- [ ] **Step 3: Run tests**

Run: `cd apps/api && npx vitest run src/routes/ai_admin.test.ts`
Expected: PASS (new test + all pre-existing ones; fix the chain mock if `leftJoin` breaks earlier tests).

- [ ] **Step 4: Typecheck + commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
git add apps/api/src/routes/ai.ts apps/api/src/routes/ai_admin.test.ts
git commit -m "feat(api): expose intentId + tempPasswordState on admin tool-executions feed"
```

---

### Task 6: Web reveal UI in ApprovalHistoryFeed (+ i18n ×5 locales)

**Files:**
- Modify: `apps/web/src/components/ai-risk/AiRiskDashboard.tsx` (ToolExecution type, lines 38-50)
- Modify: `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx` (TIER3_TOOLS, expandable panel, new inline section component)
- Modify: `apps/web/src/locales/en/security.json`, `apps/web/src/locales/de-DE/security.json`, `apps/web/src/locales/es-419/security.json`, `apps/web/src/locales/fr-FR/security.json`, `apps/web/src/locales/pt-BR/security.json`
- Test: `apps/web/src/components/ai-risk/ApprovalHistoryFeed.test.tsx` (net-new)

**Interfaces:**
- Consumes: Task 5's `intentId` / `tempPasswordState` fields; Task 3's endpoint (`POST /action-intents/:intentId/reveal-secret` → `{ data: { temporaryPassword } }`, 403/410 errors); `runAction`/`ActionError`/`handleActionError` from `@/lib/runAction`; `fetchWithAuth` from `@/stores/auth`.
- Produces: user-visible reveal flow; no new exports.

- [ ] **Step 1: Extend the `ToolExecution` type**

In `apps/web/src/components/ai-risk/AiRiskDashboard.tsx` (lines 38-50), add two fields:

```tsx
export interface ToolExecution {
  id: string;
  sessionId: string;
  toolName: string;
  status: string;
  toolInput: unknown;
  approvedBy: string | null;
  approvedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
  intentId: string | null;
  tempPasswordState: "available" | "revealed" | "expired" | null;
}
```

- [ ] **Step 2: Write the failing component test**

`apps/web/src/components/ai-risk/ApprovalHistoryFeed.test.tsx` (pattern: `apps/web/src/components/security/RecoveryKeysPanel.test.tsx`; the feed takes props directly, so only `runAction`/auth need mocking):

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock, runActionMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  runActionMock: vi.fn(),
}));

vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/lib/runAction', () => ({
  runAction: runActionMock,
  handleActionError: vi.fn(),
  ActionError: class ActionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

import ApprovalHistoryFeed from './ApprovalHistoryFeed';
import type { ToolExecution } from './AiRiskDashboard';

const INTENT_ID = '22222222-2222-4222-8222-222222222222';

function resetExecution(overrides: Partial<ToolExecution> = {}): ToolExecution {
  return {
    id: 'exec-1',
    sessionId: 'sess-1',
    toolName: 'm365_reset_password',
    status: 'completed',
    toolInput: { userPrincipalName: 'jane@customer.com' },
    approvedBy: 'admin-1',
    approvedAt: '2026-07-19T00:00:00Z',
    durationMs: 1200,
    errorMessage: null,
    createdAt: '2026-07-19T00:00:00Z',
    completedAt: '2026-07-19T00:01:00Z',
    intentId: INTENT_ID,
    tempPasswordState: 'available',
    ...overrides,
  };
}

async function expandRow() {
  fireEvent.click(screen.getByText(/reset password/i));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApprovalHistoryFeed temp-password reveal', () => {
  it('shows a reveal button for an available secret and displays the password once revealed', async () => {
    runActionMock.mockResolvedValue('Tmp-Pass-1234!');
    render(<ApprovalHistoryFeed executions={[resetExecution()]} loading={false} />);
    await expandRow();
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }));
    await waitFor(() => expect(screen.getByText('Tmp-Pass-1234!')).toBeTruthy());
    expect(runActionMock).toHaveBeenCalledTimes(1);
    // shown-once warning is visible alongside the password
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy();
  });

  it('renders a static "already revealed" state with no button', async () => {
    render(
      <ApprovalHistoryFeed
        executions={[resetExecution({ tempPasswordState: 'revealed' })]}
        loading={false}
      />,
    );
    await expandRow();
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
    expect(screen.getByText(/already been revealed/i)).toBeTruthy();
  });

  it('renders an expired state with no button', async () => {
    render(
      <ApprovalHistoryFeed
        executions={[resetExecution({ tempPasswordState: 'expired' })]}
        loading={false}
      />,
    );
    await expandRow();
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
    expect(screen.getByText(/expired/i)).toBeTruthy();
  });

  it('shows nothing extra for executions without a temp password state', async () => {
    render(
      <ApprovalHistoryFeed
        executions={[
          resetExecution({ toolName: 'run_script', tempPasswordState: null, intentId: null }),
        ]}
        loading={false}
      />,
    );
    fireEvent.click(screen.getByText(/run script/i));
    expect(screen.queryByRole('button', { name: /reveal/i })).toBeNull();
  });
});
```

(If the row-header text assertion (`/reset password/i`) doesn't match `formatToolName('m365_reset_password')`'s output, adjust the matcher to the actual formatted label — check `formatToolName` in `apps/web/src/lib/utils`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/ai-risk/ApprovalHistoryFeed.test.tsx`
Expected: FAIL — reset rows are filtered out by `TIER3_TOOLS` and no reveal UI exists.

- [ ] **Step 4: Implement the UI**

In `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx`:

1. Add `'m365_reset_password'` to the `TIER3_TOOLS` set (lines 18-27).
2. Add imports:

```tsx
import { Copy, Eye, Loader2 } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { ActionError, handleActionError, runAction } from "../../lib/runAction";
```

(Merge with the existing lucide-react import line; keep the file's relative-import style.)

3. Add the inline section component (above the default export):

```tsx
function TempPasswordSection({
  intentId,
  state,
}: {
  intentId: string;
  state: "available" | "revealed" | "expired";
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState<"forbidden" | "gone" | null>(null);

  const reveal = async () => {
    setBusy(true);
    try {
      const pw = await runAction<string>({
        request: () =>
          fetchWithAuth(`/action-intents/${intentId}/reveal-secret`, {
            method: "POST",
          }),
        errorFallback: t("aiRiskApprovalHistoryFeed.tempPasswordRevealFailed"),
        parseSuccess: (body) =>
          (body as { data: { temporaryPassword: string } }).data.temporaryPassword,
      });
      setPassword(pw);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.status === 403) setBlocked("forbidden");
      else if (err instanceof ActionError && err.status === 410) setBlocked("gone");
      else if (!(err instanceof ActionError))
        handleActionError(err, t("aiRiskApprovalHistoryFeed.tempPasswordRevealFailed"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; user can still select the text manually.
    }
  };

  if (state === "revealed" || blocked === "gone") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordAlreadyRevealed")}
      </p>
    );
  }
  if (state === "expired") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordExpired")}
      </p>
    );
  }
  if (blocked === "forbidden") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordForbidden")}
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordTitle")}
      </p>
      {password ? (
        <div className="rounded bg-muted/40 p-2">
          <code className="break-all font-mono text-sm">{password}</code>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40"
            >
              <Copy className="h-3 w-3" />
              {copied
                ? t("aiRiskApprovalHistoryFeed.tempPasswordCopied")
                : t("aiRiskApprovalHistoryFeed.tempPasswordCopy")}
            </button>
            <span className="text-xs font-medium text-amber-700">
              {t("aiRiskApprovalHistoryFeed.tempPasswordShownOnce")}
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={reveal}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
          {t("aiRiskApprovalHistoryFeed.tempPasswordReveal")}
        </button>
      )}
    </div>
  );
}
```

(If the feed component doesn't already call `useTranslation()`, follow however it obtains `t` — it renders `t("aiRiskApprovalHistoryFeed.toolInput")` today, so the hook or equivalent is already in scope.)

4. In the expanded panel (after the `toolInput` `<pre>` block, lines ~171-178), insert:

```tsx
{exec.intentId && exec.tempPasswordState && (
  <TempPasswordSection intentId={exec.intentId} state={exec.tempPasswordState} />
)}
```

- [ ] **Step 5: Add the i18n keys to ALL five locales**

Inside the existing `"aiRiskApprovalHistoryFeed"` object of each `security.json` (key order: alphabetical if the file is sorted, otherwise append):

`apps/web/src/locales/en/security.json`:

```json
"tempPasswordTitle": "Temporary password",
"tempPasswordReveal": "Reveal temporary password",
"tempPasswordRevealFailed": "Failed to reveal the temporary password",
"tempPasswordCopy": "Copy",
"tempPasswordCopied": "Copied",
"tempPasswordShownOnce": "Save it now — it will not be shown again. The user must change it at next sign-in.",
"tempPasswordAlreadyRevealed": "The temporary password has already been revealed.",
"tempPasswordExpired": "The temporary password expired without being revealed.",
"tempPasswordForbidden": "Only the technician who requested this reset can reveal the password."
```

`apps/web/src/locales/de-DE/security.json`:

```json
"tempPasswordTitle": "Temporäres Passwort",
"tempPasswordReveal": "Temporäres Passwort anzeigen",
"tempPasswordRevealFailed": "Temporäres Passwort konnte nicht angezeigt werden",
"tempPasswordCopy": "Kopieren",
"tempPasswordCopied": "Kopiert",
"tempPasswordShownOnce": "Jetzt speichern — es wird nicht erneut angezeigt. Der Benutzer muss es bei der nächsten Anmeldung ändern.",
"tempPasswordAlreadyRevealed": "Das temporäre Passwort wurde bereits angezeigt.",
"tempPasswordExpired": "Das temporäre Passwort ist abgelaufen, ohne angezeigt zu werden.",
"tempPasswordForbidden": "Nur der Techniker, der dieses Zurücksetzen angefordert hat, kann das Passwort anzeigen."
```

`apps/web/src/locales/es-419/security.json`:

```json
"tempPasswordTitle": "Contraseña temporal",
"tempPasswordReveal": "Revelar contraseña temporal",
"tempPasswordRevealFailed": "No se pudo revelar la contraseña temporal",
"tempPasswordCopy": "Copiar",
"tempPasswordCopied": "Copiado",
"tempPasswordShownOnce": "Guárdala ahora — no se volverá a mostrar. El usuario deberá cambiarla en su próximo inicio de sesión.",
"tempPasswordAlreadyRevealed": "La contraseña temporal ya fue revelada.",
"tempPasswordExpired": "La contraseña temporal expiró sin ser revelada.",
"tempPasswordForbidden": "Solo el técnico que solicitó este restablecimiento puede revelar la contraseña."
```

`apps/web/src/locales/fr-FR/security.json`:

```json
"tempPasswordTitle": "Mot de passe temporaire",
"tempPasswordReveal": "Révéler le mot de passe temporaire",
"tempPasswordRevealFailed": "Échec de la révélation du mot de passe temporaire",
"tempPasswordCopy": "Copier",
"tempPasswordCopied": "Copié",
"tempPasswordShownOnce": "Enregistrez-le maintenant — il ne sera plus affiché. L'utilisateur devra le changer à sa prochaine connexion.",
"tempPasswordAlreadyRevealed": "Le mot de passe temporaire a déjà été révélé.",
"tempPasswordExpired": "Le mot de passe temporaire a expiré sans avoir été révélé.",
"tempPasswordForbidden": "Seul le technicien ayant demandé cette réinitialisation peut révéler le mot de passe."
```

`apps/web/src/locales/pt-BR/security.json`:

```json
"tempPasswordTitle": "Senha temporária",
"tempPasswordReveal": "Revelar senha temporária",
"tempPasswordRevealFailed": "Falha ao revelar a senha temporária",
"tempPasswordCopy": "Copiar",
"tempPasswordCopied": "Copiado",
"tempPasswordShownOnce": "Salve agora — ela não será exibida novamente. O usuário deverá alterá-la no próximo login.",
"tempPasswordAlreadyRevealed": "A senha temporária já foi revelada.",
"tempPasswordExpired": "A senha temporária expirou sem ser revelada.",
"tempPasswordForbidden": "Somente o técnico que solicitou esta redefinição pode revelar a senha."
```

- [ ] **Step 6: Run the web tests**

Run: `cd apps/web && npx vitest run src/components/ai-risk/ApprovalHistoryFeed.test.tsx`
Expected: PASS all four tests.

Then run the i18n parity / literal-key guard and the broader web suite:
Run: `cd apps/web && npx vitest run src/lib` (includes the key-parity and no-silent-mutations guards) — Expected: PASS.

- [ ] **Step 7: Typecheck web**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json` (or `pnpm --filter @breeze/web check` if that's the repo script — use whichever the CI TypeCheck job runs).
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/ai-risk/AiRiskDashboard.tsx apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx apps/web/src/components/ai-risk/ApprovalHistoryFeed.test.tsx apps/web/src/locales/en/security.json apps/web/src/locales/de-DE/security.json apps/web/src/locales/es-419/security.json apps/web/src/locales/fr-FR/security.json apps/web/src/locales/pt-BR/security.json
git commit -m "feat(web): one-time temp-password reveal in the approval history feed"
```

---

## Final verification (after all tasks)

- [ ] `cd apps/api && npx vitest run src/services/actionIntents src/routes/actionIntents.test.ts src/jobs/intentReleaseWorker.test.ts src/routes/ai_admin.test.ts` — all green.
- [ ] Integration suite (needs the 5433 stack): `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/actionIntents/resultSecrets.integration.test.ts src/jobs/intentExpiryReaper.integration.test.ts` — green.
- [ ] `cd apps/web && npx vitest run` — green (parity guards included).
- [ ] Both typechecks clean.
- [ ] Grep sweep — the plaintext must have no new escape routes: `grep -rn "temporaryPassword" apps/api/src --include="*.ts" | grep -v test | grep -iv "enc\|sealed\|redact\|reveal\|burn"` and eyeball every hit; none may be a log/audit/metric write.

## Known limitations (accepted in the spec)

- MCP/API-key-requested reset intents have no `ai_tool_executions` row, so they never appear in the ApprovalHistoryFeed — the admin-fallback authz exists, but there is no UI surface for those intents yet (spec §6 defers a general intents list).
- The feed's reveal button visibility is derived state (`tempPasswordState`), but the endpoint remains the sole authority — a non-requester who sees an `available` row gets the friendly 403 state on click.
