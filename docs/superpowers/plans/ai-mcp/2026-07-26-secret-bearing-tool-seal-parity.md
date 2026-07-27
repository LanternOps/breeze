# Secret-Bearing Tool Seal Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every temporary credential minted by an AI tool exist as plaintext in exactly two places — the provider API call that created it, and one AES-256-GCM v3 sealed blob in `action_intents.result` — across both the inline chat path and the durable release worker.

**Architecture:** Two reset handlers stop returning prose with the credential interpolated and instead return a discriminated `SecretToolResult` carrier. A pure `sealToolSecrets` function splits that carrier into `llmText` (safe for the model, transcript, and stream) and `sealedResult` (destined for the intent row). Both execution paths route through it, and a post-condition guard asserts the invariant on what actually gets persisted rather than trusting the code path.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, Vitest, BullMQ.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-07-26-secret-bearing-tool-seal-parity-design.md`

## Global Constraints

- Fail closed on confidentiality. The provider-side reset already happened and cannot be undone, so every failure path drops the credential and tells the operator to re-reset. Never store plaintext as a fallback.
- Only v3 ciphertext (`enc:v3:`) is acceptable. Sealing that produces anything else drops the plaintext and sets `temporaryPasswordSealFailed`. This mirrors `resultSecrets.ts:43-56` exactly — do not re-litigate it.
- Seal with AAD `ACTION_INTENT_RESULT_AAD` (`'action_intents.result'`). Any other AAD makes `unsealTemporaryPassword` (`resultSecrets.ts:81`, `strict: true`) throw on every reveal.
- The credential must never appear in `llmText`, logs, audit details, metrics, or error messages.
- Tool names arrive both bare and `mcp__breeze__`-prefixed. Every registry membership test must normalize first.
- Test files live beside their source (`foo.ts` → `foo.test.ts`).
- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`, never edit a shipped migration.
- No new tables and no new `org_id` columns — no RLS shape work and no cascade-list registration is required by this plan.

## Correction to the spec

Spec §4.3 states that widening `PostToolUseCallback` touches "~50 `makeHandler` registrations". That is wrong. Registrations *pass* the callback as a parameter; only `aiAgentSdk.createSessionPostToolUse` *implements* it. Adding an optional sixth parameter affects the single implementer plus `safePostToolUse`. The decision to widen stands; the cost is much lower than stated.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/actionIntents/secretBearingTools.ts` (new) | Registry, `SecretToolResult` carrier, `sealToolSecrets`, `assertNoPlaintextSecret` |
| `apps/api/src/services/actionIntents/secretBearingTools.test.ts` (new) | Unit tests for the above |
| `apps/api/src/services/aiToolsGoogle.ts` | `googleResetPasswordAction` returns the carrier |
| `apps/api/src/services/googleToolsHeadless.ts` | Separate typed map for secret-bearing actions |
| `apps/api/src/jobs/intentReleaseWorker.ts` | Seals Google results; guards both persistence paths |
| `apps/api/src/services/aiToolsM365.ts` | `m365ResetPasswordHandler` returns the carrier |
| `apps/api/src/services/aiAgentSdkTools.ts` | Widened callbacks; the inline split; missing-intent fail-closed |
| `apps/api/src/services/aiAgentSdk.ts` | Supplies `intentId`; routes `sealedResult` to the intent write; plan-mode fix |
| `apps/api/src/__tests__/integration/secretBearingToolSeal.integration.test.ts` (new) | Real-Postgres proof, both tools × both paths |
| `apps/api/migrations/2026-07-26-scrub-plaintext-temp-passwords.sql` (new) | Historical redaction |
| `internal/security/temp-password-exposure-survey.sql` (new) | Read-only survey, operator-run |

---

### Task 1: Registry, carrier, and seal chokepoint

**Files:**
- Create: `apps/api/src/services/actionIntents/secretBearingTools.ts`
- Test: `apps/api/src/services/actionIntents/secretBearingTools.test.ts`

**Interfaces:**
- Consumes: `encryptSecret` from `../secretCrypto`; `ACTION_INTENT_RESULT_AAD`, `TEMP_PASSWORD_ENC_KEY`, `TEMP_PASSWORD_LEGACY_KEY`, `TEMP_PASSWORD_SEAL_FAILED_KEY`, `TEMP_PASSWORD_EXPIRED_KEY` from `./resultSecrets`
- Produces: `isSecretBearingTool(toolName: string): boolean`; `type SecretToolResult`; `sealToolSecrets(result: SecretToolResult): { llmText: string; sealedResult: Record<string, unknown> }`; `assertNoPlaintextSecret(toolName: string, result: Record<string, unknown>): void`; `SECRET_UNAVAILABLE_TEXT: string`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/actionIntents/secretBearingTools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isSecretBearingTool,
  sealToolSecrets,
  assertNoPlaintextSecret,
  SECRET_UNAVAILABLE_TEXT,
  type SecretToolResult,
} from './secretBearingTools';
import { TEMP_PASSWORD_ENC_KEY, TEMP_PASSWORD_SEAL_FAILED_KEY } from './resultSecrets';

const PW = 'Bz9!oVnL920blvsjqqMy';

describe('isSecretBearingTool', () => {
  it('matches both reset tools bare and mcp-prefixed', () => {
    expect(isSecretBearingTool('m365_reset_password')).toBe(true);
    expect(isSecretBearingTool('google_reset_password')).toBe(true);
    expect(isSecretBearingTool('mcp__breeze__m365_reset_password')).toBe(true);
    expect(isSecretBearingTool('mcp__breeze__google_reset_password')).toBe(true);
  });

  it('does not match non-secret tools', () => {
    expect(isSecretBearingTool('m365_disable_user')).toBe(false);
    expect(isSecretBearingTool('google_suspend_user')).toBe(false);
  });
});

describe('sealToolSecrets', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('seals the credential and keeps it out of llmText', () => {
    const carrier: SecretToolResult = {
      kind: 'success',
      llmText: 'Reset the password for a@b.com. The temporary credential is available for one-time reveal.',
      secrets: { temporaryPassword: PW },
    };
    const { llmText, sealedResult } = sealToolSecrets(carrier);

    expect(llmText).not.toContain(PW);
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toMatch(/^enc:v3:/);
    expect(JSON.stringify(sealedResult)).not.toContain(PW);
  });

  it('preserves carrier meta in the sealed result', () => {
    const { sealedResult } = sealToolSecrets({
      kind: 'success',
      llmText: 'done',
      secrets: { temporaryPassword: PW },
      meta: { delegantToolCallId: 'dtc-123' },
    });
    expect(sealedResult.delegantToolCallId).toBe('dtc-123');
  });

  it('substitutes llmText when it would leak the secret', () => {
    const { llmText, sealedResult } = sealToolSecrets({
      kind: 'success',
      llmText: `Temporary password: ${PW}`,
      secrets: { temporaryPassword: PW },
    });
    expect(llmText).toBe(SECRET_UNAVAILABLE_TEXT);
    expect(llmText).not.toContain(PW);
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toMatch(/^enc:v3:/);
  });

  it('drops the plaintext and substitutes llmText when sealing is not v3', () => {
    delete process.env.APP_ENCRYPTION_KEY_ID;
    const { llmText, sealedResult } = sealToolSecrets({
      kind: 'success',
      llmText: 'Reset done, credential available for one-time reveal.',
      secrets: { temporaryPassword: PW },
    });
    expect(sealedResult[TEMP_PASSWORD_SEAL_FAILED_KEY]).toBe(true);
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toBeUndefined();
    expect(JSON.stringify(sealedResult)).not.toContain(PW);
    expect(llmText).toBe(SECRET_UNAVAILABLE_TEXT);
  });

  it('passes an error carrier through with no secret keys', () => {
    const { llmText, sealedResult } = sealToolSecrets({
      kind: 'error',
      llmText: JSON.stringify({ error: 'not_found', message: 'no such user' }),
    });
    expect(llmText).toContain('not_found');
    expect(sealedResult[TEMP_PASSWORD_ENC_KEY]).toBeUndefined();
    expect(sealedResult[TEMP_PASSWORD_SEAL_FAILED_KEY]).toBeUndefined();
  });
});

describe('assertNoPlaintextSecret', () => {
  it('accepts a sealed result for a secret-bearing tool', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      [TEMP_PASSWORD_ENC_KEY]: 'enc:v3:abc',
    })).not.toThrow();
  });

  it('accepts a seal-failed marker', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      [TEMP_PASSWORD_SEAL_FAILED_KEY]: true,
    })).not.toThrow();
  });

  it('throws on a legacy plaintext key', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      temporaryPassword: PW,
    })).toThrow(/plaintext credential/i);
  });

  it('throws on the prose shape that caused the original leak', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      raw: `Reset the password for a@b.com. Temporary password: ${PW} (the user must change it at next sign-in).`,
    })).toThrow(/plaintext credential/i);
  });

  it('ignores results for tools that never mint credentials', () => {
    expect(() => assertNoPlaintextSecret('google_suspend_user', {
      raw: 'Temporary password: whatever',
    })).not.toThrow();
  });

  it('accepts an error result that carries no credential and no marker', () => {
    // A secret-bearing tool that fails legitimately persists an error result
    // with no marker. Requiring one here would throw on every error release.
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      raw: JSON.stringify({ error: 'not_found', message: 'no such user' }),
    })).not.toThrow();
  });

  it('accepts an already-redacted historical row', () => {
    expect(() => assertNoPlaintextSecret('google_reset_password', {
      raw: 'Reset the password for a@b.com. Temporary password: [REDACTED] (the user must change it at next sign-in).',
    })).not.toThrow();
  });
});

describe('seal invariant', () => {
  it('a success carrier always yields exactly one of enc or seal-failed', () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';
    const withKey = sealToolSecrets({
      kind: 'success', llmText: 'ok', secrets: { temporaryPassword: PW },
    }).sealedResult;

    delete process.env.APP_ENCRYPTION_KEY_ID;
    const withoutKey = sealToolSecrets({
      kind: 'success', llmText: 'ok', secrets: { temporaryPassword: PW },
    }).sealedResult;

    for (const r of [withKey, withoutKey]) {
      const markers = [TEMP_PASSWORD_ENC_KEY, TEMP_PASSWORD_SEAL_FAILED_KEY]
        .filter((k) => k in r);
      expect(markers).toHaveLength(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/actionIntents/secretBearingTools.test.ts`
Expected: FAIL — `Failed to resolve import "./secretBearingTools"`

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/actionIntents/secretBearingTools.ts`:

```ts
/**
 * Registry and seal chokepoint for AI tools that mint a credential.
 *
 * A secret-bearing tool never returns its credential in the string that
 * reaches the model, the chat transcript, or the SSE stream. It returns a
 * SecretToolResult carrier; sealToolSecrets splits that into `llmText`
 * (safe everywhere) and `sealedResult` (destined for action_intents.result,
 * with the credential encrypted under the same v3/AAD contract the reveal
 * endpoint already expects).
 *
 * The registry is a readonly tuple with a module-private predicate, not an
 * exported Set: an exported mutable Set would let any importer edit the
 * security registry at runtime.
 */
import { encryptSecret } from '../secretCrypto';
import {
  ACTION_INTENT_RESULT_AAD,
  TEMP_PASSWORD_ENC_KEY,
  TEMP_PASSWORD_LEGACY_KEY,
  TEMP_PASSWORD_SEAL_FAILED_KEY,
  TEMP_PASSWORD_EXPIRED_KEY,
} from './resultSecrets';

const SECRET_BEARING_TOOLS = ['m365_reset_password', 'google_reset_password'] as const;

const ENC_V3_PREFIX = 'enc:v3:';

/** Shown to the operator whenever the credential could not be made revealable. */
export const SECRET_UNAVAILABLE_TEXT =
  'The password was reset, but the temporary credential could not be stored securely and is '
  + 'unavailable. Reset the password again to obtain a new one.';

/** Prose tripwire for the shape that caused the original Google leak. */
const PROSE_CREDENTIAL_PATTERN = /Temporary password:\s*(?!\[REDACTED\]|\[redacted\])\S/;

/**
 * Local copy of aiAgentSdk's stripMcpPrefix. Duplicated rather than imported
 * to avoid an import cycle (aiAgentSdk imports this module).
 */
function stripMcpPrefix(toolName: string): string {
  return toolName.startsWith('mcp__breeze__') ? toolName.slice('mcp__breeze__'.length) : toolName;
}

export function isSecretBearingTool(toolName: string): boolean {
  const bare = stripMcpPrefix(toolName);
  return (SECRET_BEARING_TOOLS as readonly string[]).includes(bare);
}

export type SecretToolResult =
  | {
      kind: 'success';
      llmText: string;
      secrets: { temporaryPassword: string };
      meta?: { delegantToolCallId?: string };
    }
  | { kind: 'error'; llmText: string };

/**
 * Split a carrier into the model-facing text and the intent-facing result.
 * Pure and synchronous: no DB access, no intent id.
 */
export function sealToolSecrets(
  result: SecretToolResult,
): { llmText: string; sealedResult: Record<string, unknown> } {
  if (result.kind === 'error') {
    return { llmText: result.llmText, sealedResult: { raw: result.llmText } };
  }

  const pw = result.secrets.temporaryPassword;
  const base: Record<string, unknown> = { ...(result.meta ?? {}) };

  const sealed = encryptSecret(pw, { aad: ACTION_INTENT_RESULT_AAD });
  if (!sealed || !sealed.startsWith(ENC_V3_PREFIX)) {
    // secretCrypto produced v1 (or nothing) — almost certainly APP_ENCRYPTION_KEY_ID
    // is unset. v1 is not AAD-bound, so storing it would allow ciphertext
    // substitution across intents. Fail closed on confidentiality: drop the
    // plaintext. The provider-side reset already happened and cannot be undone,
    // and forceChangePasswordNextSignIn bounds the impact.
    console.error(
      '[secretBearingTools] seal produced non-v3 ciphertext — APP_ENCRYPTION_KEY_ID missing? '
      + 'Temp password dropped (fail closed).',
    );
    return {
      llmText: SECRET_UNAVAILABLE_TEXT,
      sealedResult: { ...base, [TEMP_PASSWORD_SEAL_FAILED_KEY]: true },
    };
  }

  // Defence in depth: if a handler ever reintroduces interpolation, do not ship
  // the credential to the model just because sealing succeeded.
  const llmText = result.llmText.includes(pw) ? SECRET_UNAVAILABLE_TEXT : result.llmText;

  return { llmText, sealedResult: { ...base, [TEMP_PASSWORD_ENC_KEY]: sealed } };
}

/**
 * Post-condition guard. Asserts the invariant on what is about to be
 * persisted, rather than trusting that a particular code path was taken —
 * this way the M365 durable path (which seals via resultSecrets' structured
 * gate) and the Google path (which seals via sealToolSecrets) are both
 * covered by one check.
 */
export function assertNoPlaintextSecret(
  toolName: string,
  result: Record<string, unknown>,
): void {
  if (!isSecretBearingTool(toolName)) return;

  if (TEMP_PASSWORD_LEGACY_KEY in result) {
    throw new Error(
      `[secretBearingTools] refusing to persist plaintext credential for ${toolName}: `
      + `result carries the legacy ${TEMP_PASSWORD_LEGACY_KEY} key`,
    );
  }

  for (const value of Object.values(result)) {
    if (typeof value === 'string' && PROSE_CREDENTIAL_PATTERN.test(value)) {
      throw new Error(
        `[secretBearingTools] refusing to persist plaintext credential for ${toolName}: `
        + 'result contains an unredacted credential in prose',
      );
    }
  }
}
```

**Do not add a "must carry a seal marker" check here.** A secret-bearing tool
that fails (user not found, connection unavailable) legitimately persists an
error result with no credential and therefore no marker; requiring one would
throw on every error release. The "sealing actually happened" invariant is
guaranteed by construction instead — `sealToolSecrets` always emits either
`temporaryPasswordEnc` or `temporaryPasswordSealFailed` for a success carrier —
and is pinned by the unit test below rather than by a runtime check that cannot
distinguish success from failure.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/actionIntents/secretBearingTools.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/secretBearingTools.ts apps/api/src/services/actionIntents/secretBearingTools.test.ts
git commit -m "feat(intents): registry + seal chokepoint for secret-bearing AI tools"
```

---

### Task 2: Google reset action returns the carrier

**Files:**
- Modify: `apps/api/src/services/aiToolsGoogle.ts:271-291` (`googleResetPasswordAction`)
- Modify: `apps/api/src/services/googleToolsHeadless.ts:35` (types), `:46` (map)
- Test: `apps/api/src/services/aiToolsGoogle.test.ts`

**Interfaces:**
- Consumes: `SecretToolResult` from `./actionIntents/secretBearingTools`
- Produces: `googleResetPasswordAction(ctx: GoogleToolContext, input: Record<string, unknown>): Promise<SecretToolResult>`; `GOOGLE_HEADLESS_SECRET_ACTIONS: Record<string, GoogleSecretAction>` exported from `googleToolsHeadless.ts`

Keep the 20 non-secret actions on the existing `Promise<string>` map. Widening `GoogleAction` to a union would force every consumer to narrow a type only one action uses.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/aiToolsGoogle.test.ts`:

```ts
import { googleResetPasswordAction } from './aiToolsGoogle';

describe('googleResetPasswordAction carrier', () => {
  it('returns a success carrier whose llmText never contains the credential', async () => {
    const updated: Array<{ requestBody: { password: string } }> = [];
    const ctx = makeGoogleCtx({
      users: { update: async (args: any) => { updated.push(args); return {}; } },
    });

    const result = await googleResetPasswordAction(ctx, {
      userEmail: 'a@b.com',
      reason: 'helpdesk ticket 1',
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');

    const pw = updated[0]!.requestBody.password;
    expect(pw.length).toBeGreaterThan(0);
    expect(result.secrets.temporaryPassword).toBe(pw);
    expect(result.llmText).not.toContain(pw);
    expect(result.llmText).toContain('a@b.com');
  });

  it('returns an error carrier with no secrets when the reason is missing', async () => {
    const result = await googleResetPasswordAction(makeGoogleCtx({}), { userEmail: 'a@b.com' });
    expect(result.kind).toBe('error');
    expect(result).not.toHaveProperty('secrets');
  });
});
```

Reuse the file's existing context/mocking helper. If it has none, add:

```ts
function makeGoogleCtx(directory: any) {
  return {
    keyJson: '{}',
    conn: { adminEmail: 'admin@b.com', orgId: 'org-1' },
    __directory: directory,
  } as any;
}
```

and have the test stub `getDirectoryClient` via `vi.mock('./aiToolsGoogle', …)`'s existing pattern in that file — match whatever mocking style the file already uses rather than introducing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsGoogle.test.ts -t carrier`
Expected: FAIL — `result.kind` is `undefined` because the action still returns a string.

- [ ] **Step 3: Rewrite the action**

Replace `apps/api/src/services/aiToolsGoogle.ts:271-291` with:

```ts
export async function googleResetPasswordAction(
  ctx: GoogleToolContext,
  input: Record<string, unknown>,
): Promise<SecretToolResult> {
  const reason = requireString(input, 'reason');
  if (!reason) {
    return { kind: 'error', llmText: errorString('missing_reason', 'A reason is required for this action.') };
  }
  const email = requireString(input, 'userEmail');
  if (!email) {
    return { kind: 'error', llmText: errorString('missing_user', 'A user email is required.') };
  }

  const temp = generateTempPassword();
  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.update({
      userKey: email,
      requestBody: { password: temp, changePasswordAtNextLogin: true },
    });
    // The credential goes in `secrets`, NEVER in llmText — llmText reaches the
    // model, the transcript, and the browser.
    return {
      kind: 'success',
      llmText: `Reset the password for ${email}. The temporary credential is available for one-time reveal; the user must change it at next sign-in.`,
      secrets: { temporaryPassword: temp },
    };
  } catch (err) {
    return { kind: 'error', llmText: googleError(err) };
  }
}
```

Add to the imports at the top of `aiToolsGoogle.ts`:

```ts
import type { SecretToolResult } from './actionIntents/secretBearingTools';
```

- [ ] **Step 4: Split the headless map**

In `apps/api/src/services/googleToolsHeadless.ts`, change line 35 and the map entry:

```ts
type GoogleAction = (ctx: GoogleToolContext, input: Record<string, unknown>) => Promise<string>;
type GoogleSecretAction = (ctx: GoogleToolContext, input: Record<string, unknown>) => Promise<SecretToolResult>;

/** Secret-bearing headless actions. Kept in a separate, precisely-typed map so
 *  the 20 ordinary actions keep their Promise<string> contract. */
export const GOOGLE_HEADLESS_SECRET_ACTIONS: Record<string, GoogleSecretAction> = {
  google_reset_password: googleResetPasswordAction,
};
```

Remove the `google_reset_password: googleResetPasswordAction,` entry from `GOOGLE_HEADLESS_ACTIONS`, and add the import:

```ts
import type { SecretToolResult } from './actionIntents/secretBearingTools';
```

- [ ] **Step 5: Repair the existing parity invariant**

`googleToolsHeadless.ts` asserts `keys(GOOGLE_HEADLESS_ACTIONS) === tier-3 googleToolTiers` (comment at `:67`). Find the test enforcing it and change it to compare the **union** of both maps:

```ts
const headlessKeys = new Set([
  ...Object.keys(GOOGLE_HEADLESS_ACTIONS),
  ...Object.keys(GOOGLE_HEADLESS_SECRET_ACTIONS),
]);
const tier3 = new Set(Object.entries(googleToolTiers).filter(([, t]) => t === 3).map(([k]) => k));
expect(headlessKeys).toEqual(tier3);
```

Also update the `:67` comment to name both maps.

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsGoogle.test.ts src/services/googleToolsHeadless.test.ts`
Expected: PASS. Also run `pnpm --filter @breeze/api exec tsc --noEmit` — expect an error in `intentReleaseWorker.ts` (it still expects `Promise<string>`); Task 3 fixes it.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiToolsGoogle.ts apps/api/src/services/aiToolsGoogle.test.ts apps/api/src/services/googleToolsHeadless.ts
git commit -m "feat(intents): google reset action returns a secret carrier"
```

---

### Task 3: Worker seals the Google credential — closes the confirmed leak

This is the task that fixes the Critical defect. Everything before it is scaffolding.

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts:280-355`
- Test: `apps/api/src/jobs/intentReleaseWorker.test.ts`

**Interfaces:**
- Consumes: `GOOGLE_HEADLESS_SECRET_ACTIONS` (Task 2); `sealToolSecrets`, `assertNoPlaintextSecret`, `isSecretBearingTool` (Task 1)
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/jobs/intentReleaseWorker.test.ts`:

```ts
describe('secret-bearing release', () => {
  it('seals a google_reset_password credential instead of storing prose', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';

    const PW = 'Bz9!oVnL920blvsjqqMy';
    mockHeadlessGoogleSecret('google_reset_password', {
      kind: 'success',
      llmText: 'Reset the password for a@b.com. The temporary credential is available for one-time reveal.',
      secrets: { temporaryPassword: PW },
    });

    const stored = await runReleaseAndCaptureResult({
      actionName: 'google_reset_password',
      orgId: 'org-1',
    });

    expect(stored.temporaryPasswordEnc).toMatch(/^enc:v3:/);
    expect(JSON.stringify(stored)).not.toContain(PW);
    expect(stored.raw).toBeUndefined();
  });

  it('refuses to persist a plaintext credential if sealing is bypassed', async () => {
    await expect(
      persistResultForTest('google_reset_password', { raw: 'Temporary password: hunter2 (…)' }),
    ).rejects.toThrow(/plaintext credential/i);
  });
});
```

Match the file's existing mock helpers; if `mockHeadlessGoogleSecret` / `runReleaseAndCaptureResult` / `persistResultForTest` do not exist, write thin local helpers over the existing mock scaffolding rather than inventing a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/intentReleaseWorker.test.ts -t "secret-bearing release"`
Expected: FAIL — `stored.temporaryPasswordEnc` is `undefined` and `stored.raw` holds the prose.

- [ ] **Step 3a: Repair the routing gate FIRST — Task 2 broke it**

Task 2 removed `google_reset_password` from `GOOGLE_HEADLESS_ACTIONS`, but `isHeadlessGoogleTool` (`googleToolsHeadless.ts:79-81`) tests membership of that map alone. The worker's gate at `intentReleaseWorker.ts:265-267` is:

```ts
!isHeadlessGoogleTool(intent.actionName)
  && !isHeadlessM365Tool(intent.actionName)
  && requiresLiveSession(intent.actionName)
```

so on the current branch a durable `google_reset_password` release fails as `session_required` before it ever reaches the invoke. Fix the predicate to mean "this Google tool can run headless", which is true of the secret action too:

```ts
export function isHeadlessGoogleTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GOOGLE_HEADLESS_ACTIONS, name)
    || Object.prototype.hasOwnProperty.call(GOOGLE_HEADLESS_SECRET_ACTIONS, name);
}
```

The worker is its only non-test consumer, so this widening is contained.

**The worker's unit tests mock `isHeadlessGoogleTool`** (`intentReleaseWorker.test.ts:37`), so they cannot catch this class of regression — the full suite stayed green while the routing was broken. Add a real (unmocked) assertion in `googleToolsHeadless.test.ts` that `isHeadlessGoogleTool('google_reset_password') === true`, so the gate is pinned by a test that exercises the real function.

- [ ] **Step 3: Branch the invoke on secret-bearing tools**

In `apps/api/src/jobs/intentReleaseWorker.ts`, add imports:

```ts
import { GOOGLE_HEADLESS_SECRET_ACTIONS } from '../services/googleToolsHeadless';
import {
  sealToolSecrets,
  assertNoPlaintextSecret,
  isSecretBearingTool,
  type SecretToolResult,
} from '../services/actionIntents/secretBearingTools';
```

Replace the `invoke` selection at `:280-285` so a secret-bearing Google tool returns a carrier. Keep the other branches untouched:

```ts
const secretAction = GOOGLE_HEADLESS_SECRET_ACTIONS[intent.actionName];

let carrier: SecretToolResult | null = null;
let rawResult: string;
try {
  if (secretAction) {
    carrier = await withToolTimeout(
      runOutsideDbContext(() =>
        withDbAccessContext(dbAccessContextFromAuth(auth), () =>
          executeGoogleSecretToolHeadless(intent.actionName, intent.arguments, intent.orgId),
        ),
      ),
      getToolTimeout(intent.actionName),
      intent.actionName,
    );
    rawResult = carrier.llmText;
  } else {
    const invoke = isHeadlessGoogleTool(intent.actionName)
      ? () => executeGoogleToolHeadless(intent.actionName, intent.arguments, intent.orgId)
      : isHeadlessM365Tool(intent.actionName)
      ? () => executeM365ToolHeadless(intent.actionName, intent.arguments, intent.orgId, intent.id)
      : () => executeTool(intent.actionName, intent.arguments, auth);
    rawResult = await withToolTimeout(
      runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), invoke)),
      getToolTimeout(intent.actionName),
      intent.actionName,
    );
  }
} catch (err) {
  // unchanged — existing catch block
}
```

Add `executeGoogleSecretToolHeadless` to `googleToolsHeadless.ts`, mirroring `executeGoogleToolHeadless`'s connection resolution and `GoogleConnectionUnavailableError` behaviour exactly, but returning `SecretToolResult`:

```ts
export async function executeGoogleSecretToolHeadless(
  toolName: string,
  input: Record<string, unknown>,
  orgId: string,
): Promise<SecretToolResult> {
  const action = GOOGLE_HEADLESS_SECRET_ACTIONS[toolName];
  if (!action) throw new Error(`not a secret-bearing headless google tool: ${toolName}`);
  const ctx = await resolveGoogleContextOrThrow(orgId);   // same helper executeGoogleToolHeadless uses
  return action(ctx, input);
}
```

Use whatever the existing connection-resolution helper in that file is actually called; do not duplicate its logic.

- [ ] **Step 4: Seal, guard, and store**

Replace the `storedResult` derivation at `:318` and the seal at `:342`:

```ts
// Step 4: cap the result to 64 KiB; oversize -> {truncated:true}.
const resultBytes = Buffer.byteLength(rawResult, 'utf8');
const truncated = resultBytes > MAX_RESULT_BYTES;

let storedResult: Record<string, unknown>;
if (truncated) {
  storedResult = { truncated: true };
} else if (carrier) {
  storedResult = sealToolSecrets(carrier).sealedResult;
} else {
  storedResult = normalizeToolResult(rawResult);
}
```

`isReturnedToolError` must run against `rawResult` — which for a carrier is `llmText`, and error carriers keep the `errorString()` JSON shape, so the existing check at `:323` works unchanged. Add the guard to **both** persistence paths:

```ts
// returned-error path (existing, ~:324)
if (!truncated && isReturnedToolError(rawResult)) {
  assertNoPlaintextSecret(intent.actionName, storedResult);
  const failed = await transitionIntent(intent.id, 'executing', 'failed', { … });
  …
}
```

For the completion path, keep the existing `sealActionResultSecrets` call — it still covers the M365 structured shape — then guard:

```ts
let finalResult = sealActionResultSecrets(storedResult);
if (Buffer.byteLength(JSON.stringify(finalResult), 'utf8') > MAX_RESULT_BYTES) {
  if (TEMP_PASSWORD_ENC_KEY in finalResult) {
    console.warn(
      `[IntentReleaseWorker] Dropping sealed credential for intent ${intent.id} — result exceeded the size cap`,
    );
  }
  finalResult = { truncated: true };
}
assertNoPlaintextSecret(intent.actionName, finalResult);
const completed = await transitionIntent(intent.id, 'executing', 'completed', {
  executedAt: new Date(),
  result: finalResult,
});
```

`sealActionResultSecrets` is a no-op on an already-sealed carrier result (its `result.action` gate does not match), so double-sealing cannot occur.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/intentReleaseWorker.test.ts`
Expected: PASS, including the two new cases.

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts apps/api/src/services/googleToolsHeadless.ts
git commit -m "fix(intents): seal google reset credential on the durable release path

Closes the confirmed plaintext leak: google_reset_password returned prose
that normalizeToolResult stored as {raw}, which sealActionResultSecrets
skipped because its gate matches only the M365 structured shape."
```

---

### Task 4: M365 inline handler returns the carrier

**Files:**
- Modify: `apps/api/src/services/aiToolsM365.ts:244-275`
- Test: `apps/api/src/services/aiToolsM365.test.ts`

**Interfaces:**
- Consumes: `SecretToolResult` (Task 1)
- Produces: `m365ResetPasswordHandler(input, auth, sessionId): Promise<SecretToolResult>`

The M365 **durable** path is unchanged — it already seals via `writeActionResultSchema`'s structured shape.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/aiToolsM365.test.ts`:

```ts
describe('m365ResetPasswordHandler carrier', () => {
  it('keeps the credential out of llmText and carries it in secrets', async () => {
    mockDelegantOk({ temporaryPassword: 'Xy7#kLp2Qm', }, { toolCallId: 'dtc-9' });

    const result = await m365ResetPasswordHandler(
      { userIdentifier: 'a@b.com', reason: 'ticket 5' },
      authFixture,
      'session-1',
    );

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.secrets.temporaryPassword).toBe('Xy7#kLp2Qm');
    expect(result.llmText).not.toContain('Xy7#kLp2Qm');
    expect(result.meta?.delegantToolCallId).toBe('dtc-9');
  });

  it('returns an error carrier when the user cannot be resolved', async () => {
    mockDelegantUserNotFound();
    const result = await m365ResetPasswordHandler(
      { userIdentifier: 'ghost@b.com', reason: 'ticket 6' },
      authFixture,
      'session-1',
    );
    expect(result.kind).toBe('error');
    expect(result).not.toHaveProperty('secrets');
  });
});
```

Use the file's existing Delegant mocking helpers; match its style.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsM365.test.ts -t carrier`
Expected: FAIL — handler still returns a string.

- [ ] **Step 3: Rewrite the handler**

Replace `apps/api/src/services/aiToolsM365.ts:244-275`:

```ts
export async function m365ResetPasswordHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<SecretToolResult> {
  const reason = requireString(input, 'reason');
  if (!reason) return { kind: 'error', llmText: errorString('missing_reason', 'A reason is required for this action.') };

  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return { kind: 'error', llmText: ctx.error };
  const identifier = requireString(input, 'userIdentifier');
  if (!identifier) return { kind: 'error', llmText: errorString('missing_user', 'A user identifier (UPN or object id) is required.') };

  const resolved = await resolveUserId(identifier, ctx, auth, sessionId);
  if (!resolved.ok) {
    return {
      kind: 'error',
      llmText: resolved.error.code === 'not_found' ? unresolvedUser(identifier) : errorTemplate(resolved.error),
    };
  }

  const result = await call(ctx, auth, sessionId, 'reset_user_password', { userId: resolved.userId, reason });
  if (result.kind !== 'ok') {
    return { kind: 'error', llmText: errorTemplate({ code: result.code, message: result.message }) };
  }

  const temp = (result.data as { temporaryPassword?: unknown } | undefined)?.temporaryPassword;
  if (typeof temp !== 'string' || temp.length === 0) {
    // Backend returned no credential — surface success without promising a reveal.
    return {
      kind: 'error',
      llmText: errorString('no_credential', 'The password was reset but no temporary credential was returned.'),
    };
  }

  // The credential goes in `secrets`, NEVER in llmText.
  return {
    kind: 'success',
    llmText: `Reset the password for ${identifier}. The temporary credential is available for one-time reveal; the user must change it at next sign-in.`,
    secrets: { temporaryPassword: temp },
    ...(typeof result.toolCallId === 'string' ? { meta: { delegantToolCallId: result.toolCallId } } : {}),
  };
}
```

This bypasses `formatResultForLlm` for this handler, because that helper's job — folding the message and `delegantToolCallId` into one JSON envelope — is now the carrier's `meta` field. Leave `formatResultForLlm` itself unchanged; `m365DisableUserHandler` still uses it.

Add the import:

```ts
import type { SecretToolResult } from './actionIntents/secretBearingTools';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiToolsM365.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsM365.ts apps/api/src/services/aiToolsM365.test.ts
git commit -m "feat(intents): m365 inline reset handler returns a secret carrier"
```

---

### Task 5: Widen the callbacks and split the carrier in the wrapper

**Files:**
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:44-60` (types), `:228-245` (`safePostToolUse`), `:414-500` (`makeSessionAwareHandler`)
- Test: `apps/api/src/services/aiAgentSdkTools.sessionAware.test.ts`

**Interfaces:**
- Consumes: `sealToolSecrets`, `isSecretBearingTool`, `SECRET_UNAVAILABLE_TEXT` (Task 1)
- Produces: `PreToolUseCallback` returning `{ allowed: true; intentId?: string } | { allowed: false; error: string }`; `PostToolUseCallback` taking a 6th parameter `sealed?: { intentId: string; sealedResult: Record<string, unknown> }`; `makeSessionAwareHandler` accepting `sessionHandler` returning `Promise<string | SecretToolResult>`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/aiAgentSdkTools.sessionAware.test.ts`:

```ts
describe('secret-bearing session-aware handler', () => {
  it('returns only llmText to the model and hands sealedResult to postToolUse', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';
    const PW = 'Bz9!oVnL920blvsjqqMy';
    const post = vi.fn(async () => {});

    const handler = makeSessionAwareHandler(
      'm365_reset_password',
      () => authFixture,
      () => sessionFixture,
      async () => ({
        kind: 'success' as const,
        llmText: 'Reset done; credential available for one-time reveal.',
        secrets: { temporaryPassword: PW },
      }),
      async () => ({ allowed: true, intentId: 'intent-1' }),
      post,
    );

    const res = await handler({ userIdentifier: 'a@b.com', reason: 'r' });

    expect(JSON.stringify(res)).not.toContain(PW);
    const sealedArg = post.mock.calls[0]![5];
    expect(sealedArg.intentId).toBe('intent-1');
    expect(sealedArg.sealedResult.temporaryPasswordEnc).toMatch(/^enc:v3:/);
  });

  it('fails closed when a secret-bearing tool has no intent to seal into', async () => {
    const post = vi.fn(async () => {});
    const handler = makeSessionAwareHandler(
      'm365_reset_password',
      () => authFixture,
      () => sessionFixture,
      async () => ({
        kind: 'success' as const,
        llmText: 'Reset done; credential available for one-time reveal.',
        secrets: { temporaryPassword: 'Bz9!oVnL920blvsjqqMy' },
      }),
      async () => ({ allowed: true }),          // no intentId
      post,
    );

    const res = await handler({ userIdentifier: 'a@b.com', reason: 'r' });
    const text = res.content[0]!.text;

    expect(text).not.toContain('Bz9!oVnL920blvsjqqMy');
    expect(text).toMatch(/could not be stored securely|unavailable/i);
    expect(post.mock.calls[0]![5]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiAgentSdkTools.sessionAware.test.ts -t "secret-bearing"`
Expected: FAIL — type error / `post.mock.calls[0][5]` undefined.

- [ ] **Step 3: Widen the callback types**

`apps/api/src/services/aiAgentSdkTools.ts:44-60`:

```ts
export type PreToolUseCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ allowed: true; intentId?: string } | { allowed: false; error: string }>;

export type PostToolUseCallback = (
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
  /** Present only for secret-bearing tools that sealed a credential. Carries
   *  the blob destined for action_intents.result, which must never appear in
   *  `output`. */
  sealed?: { intentId: string; sealedResult: Record<string, unknown> },
) => Promise<void>;
```

Both additions are optional, so every existing implementation and registration still typechecks.

- [ ] **Step 4: Thread it through `safePostToolUse`**

`:228-245`:

```ts
async function safePostToolUse(
  onPostToolUse: PostToolUseCallback | undefined,
  toolName: string,
  args: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
  sealed?: { intentId: string; sealedResult: Record<string, unknown> },
): Promise<void> {
  if (!onPostToolUse) return;
  try {
    await withToolTimeout(
      onPostToolUse(toolName, args, output, isError, durationMs, sealed),
      POST_TOOL_USE_TIMEOUT_MS,
      `postToolUse:${toolName}`,
    );
  } catch (err) {
    // unchanged
  }
}
```

- [ ] **Step 5: Split the carrier in `makeSessionAwareHandler`**

Change the `sessionHandler` parameter type at `:418`:

```ts
sessionHandler: (
  args: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
) => Promise<string | SecretToolResult>,
```

Capture the `intentId` from the preToolUse result (find the existing `onPreToolUse` call in this function and keep its `allowed === false` handling unchanged):

```ts
const pre = await onPreToolUse?.(toolName, args);
if (pre && pre.allowed === false) {
  // unchanged existing early return
}
const intentId = pre && pre.allowed ? pre.intentId : undefined;
```

Then replace `:470-475`:

```ts
const handlerResult = await withToolTimeout(
  withDbAccessContext(dbContext, () => sessionHandler(args, auth, session.breezeSessionId)),
  toolTimeout,
  toolName,
);

// Split a secret carrier BEFORE anything else sees it. Everything downstream —
// compaction, the MCP/LLM response, the SSE stream, and DB persistence — may
// only ever see llmText.
let result: string;
let sealed: { intentId: string; sealedResult: Record<string, unknown> } | undefined;

if (typeof handlerResult === 'string') {
  result = handlerResult;
} else if (handlerResult.kind === 'error') {
  result = handlerResult.llmText;
} else if (!intentId) {
  // No intent row to seal into: the provider-side reset already happened and
  // cannot be undone, so fail closed on confidentiality and drop the credential.
  // This is raised HERE, not in postToolUse, because safePostToolUse swallows
  // callback throws and the response would already have been composed.
  console.error(
    `[AI-SDK] ${toolName} minted a credential with no action intent to seal it into — dropped (fail closed)`,
  );
  result = SECRET_UNAVAILABLE_TEXT;
} else {
  const split = sealToolSecrets(handlerResult);
  result = split.llmText;
  sealed = { intentId, sealedResult: split.sealedResult };
}

const compactResult = compactToolResultForChat(toolName, result);
```

Pass `sealed` to the postToolUse call at `:487`:

```ts
await safePostToolUse(onPostToolUse, toolName, args, compactResult, isToolError, durationMs, sealed);
```

Add imports:

```ts
import {
  sealToolSecrets,
  isSecretBearingTool,
  SECRET_UNAVAILABLE_TEXT,
  type SecretToolResult,
} from './actionIntents/secretBearingTools';
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiAgentSdkTools.sessionAware.test.ts`
Expected: PASS.

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: clean (registrations pass callbacks through; only the implementer changes, in Task 6).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiAgentSdkTools.sessionAware.test.ts
git commit -m "feat(intents): split secret carrier in the session-aware tool wrapper"
```

---

### Task 6: Route the sealed result to the intent write

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts:533-560` (return `intentId`), `:898-910` (callback signature), `:1034-1050` (intent write)
- Test: `apps/api/src/services/aiAgentSdk.test.ts`

**Interfaces:**
- Consumes: widened callbacks (Task 5); `assertNoPlaintextSecret` (Task 1)
- Produces: no new exports

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/aiAgentSdk.test.ts`:

```ts
describe('inline secret-bearing completion', () => {
  it('writes the sealed blob to the intent and the safe text to the chat tables', async () => {
    const captured = captureIntentTransitions();
    const post = createSessionPostToolUse(sessionFixture);

    await post(
      'm365_reset_password',
      { userIdentifier: 'a@b.com' },
      'Reset done; credential available for one-time reveal.',
      false,
      12,
      { intentId: 'intent-1', sealedResult: { temporaryPasswordEnc: 'enc:v3:abc' } },
    );

    expect(captured.last().result.temporaryPasswordEnc).toBe('enc:v3:abc');
    expect(JSON.stringify(captured.insertedAiMessages())).not.toContain('enc:v3:abc');
  });
});
```

Use the file's existing mocking scaffolding for `db` and `transitionIntent`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiAgentSdk.test.ts -t "inline secret-bearing"`
Expected: FAIL — the callback takes five parameters.

- [ ] **Step 3: Return the intentId from preToolUse**

The tier-3 branch does **not** return — every branch falls through to one shared terminal `return { allowed: true };` at `apps/api/src/services/aiAgentSdk.ts:874`. So thread the id through a local:

Declare it near the top of the preToolUse callback body, beside the other locals:

```ts
let createdIntentId: string | undefined;
```

Set it at `:719`, next to the existing WeakMap write:

```ts
pendingIntentBySession.set(session, intent.id);
createdIntentId = intent.id;
```

And carry it on the terminal return at `:874`:

```ts
return { allowed: true, intentId: createdIntentId };
```

`intentId` stays `undefined` for every non-tier-3 path, which is exactly what Task 5's fail-closed branch keys on. Leave `pendingIntentBySession` in place — the completion CAS still uses it for non-secret tier-3 tools.

- [ ] **Step 4: Accept and use `sealed` in the postToolUse implementation**

Add the sixth parameter to the callback implementation near `:898`:

```ts
async (
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  durationMs: number,
  sealed?: { intentId: string; sealedResult: Record<string, unknown> },
) => {
```

Then at `:1034-1050`, prefer the sealed blob for the intent result:

```ts
const pendingIntentId = sealed?.intentId ?? pendingIntentBySession.get(session);
if (pendingIntentId) {
  pendingIntentBySession.delete(session);
  const intentResult = sealed
    ? sealed.sealedResult
    : (parsedOutput as Record<string, unknown>);

  // Parity with the worker's MAX_RESULT_BYTES re-check (spec §6.3): ciphertext
  // is larger than plaintext, so the cap must be applied AFTER sealing.
  const sizedResult =
    Buffer.byteLength(JSON.stringify(intentResult), 'utf8') > MAX_INLINE_RESULT_BYTES
      ? { truncated: true }
      : intentResult;

  assertNoPlaintextSecret(toolName, sizedResult);
  try {
    await transitionIntent(pendingIntentId, 'executing', isError ? 'failed' : 'completed', {
      executedAt: new Date(),
      ...(isError
        ? { errorCode: INLINE_TOOL_EXECUTION_FAILED_ERROR_CODE, result: sizedResult }
        : { result: sizedResult }),
    });
  } catch (err) {
    console.error(`[AI-SDK] Failed to CAS action intent to ${isError ? 'failed' : 'completed'} for ${toolName}:`, pendingIntentId, err);
  }
}
```

Add the import:

```ts
import { assertNoPlaintextSecret } from './actionIntents/secretBearingTools';
```

- [ ] **Step 5: Declare the inline size cap constant**

The Step 4 block references `MAX_INLINE_RESULT_BYTES`. Declare it at module scope in `aiAgentSdk.ts`, beside the other module constants:

```ts
/** Mirrors MAX_RESULT_BYTES in intentReleaseWorker.ts — the inline path had no
 *  cap before, so an oversize sealed result could exceed the column budget. */
const MAX_INLINE_RESULT_BYTES = 64 * 1024;
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiAgentSdk.test.ts`
Expected: PASS.

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiAgentSdk.ts apps/api/src/services/aiAgentSdk.test.ts
git commit -m "feat(intents): route the sealed credential to the inline intent write"
```

---

### Task 7: Plan-mode minimal fix

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts:404-432`
- Test: `apps/api/src/services/aiAgentSdk.test.ts`

**Interfaces:**
- Consumes: `isSecretBearingTool` (Task 1)
- Produces: no new exports

Scope note: this fixes the credential case only. The general defect — any of the 36 tier-3 tools executing via an approved plan with no intent row — is recorded in `internal/security/tier3-plan-mode-intent-bypass.md` and is out of scope here.

- [ ] **Step 1: Write the failing test**

```ts
describe('plan mode and secret-bearing tools', () => {
  it.each(['action_plan', 'hybrid_plan'] as const)(
    'does not take the plan shortcut for a secret-bearing tool in %s mode',
    async (mode) => {
      const session = sessionFixture({ approvalMode: mode, activePlanId: 'plan-1' });
      stubMatchingPlanStep(session, 'm365_reset_password');
      const createIntent = spyOnCreateActionIntent();

      await runPreToolUse(session, 'm365_reset_password', { userIdentifier: 'a@b.com', reason: 'r' });

      expect(createIntent).toHaveBeenCalled();
    },
  );

  it('still takes the plan shortcut for a non-secret tool', async () => {
    const session = sessionFixture({ approvalMode: 'action_plan', activePlanId: 'plan-1' });
    stubMatchingPlanStep(session, 'get_device_details');
    const createIntent = spyOnCreateActionIntent();

    const res = await runPreToolUse(session, 'get_device_details', {});

    expect(res.allowed).toBe(true);
    expect(createIntent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiAgentSdk.test.ts -t "plan mode and secret-bearing"`
Expected: FAIL — `createActionIntent` not called; the plan shortcut returned `{allowed:true}`.

- [ ] **Step 3: Gate the plan shortcut**

At `apps/api/src/services/aiAgentSdk.ts:405`:

```ts
// Action plan / hybrid plan mode: check if tool matches an approved plan step.
// Secret-bearing tools are excluded — they must fall through to the tier-3
// createActionIntent branch so the minted credential has an immutable intent
// row to be sealed into. (The general case, where any tier-3 tool can execute
// via an approved plan with no intent row, is tracked separately in
// internal/security/tier3-plan-mode-intent-bypass.md.)
if (
  (effectiveMode === 'action_plan' || effectiveMode === 'hybrid_plan')
  && session.activePlanId
  && !isSecretBearingTool(toolName)
) {
```

Add the import:

```ts
import { isSecretBearingTool } from './actionIntents/secretBearingTools';
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/aiAgentSdk.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgentSdk.ts apps/api/src/services/aiAgentSdk.test.ts
git commit -m "fix(intents): secret-bearing tools bypass the plan-step shortcut

A matched plan step returned allowed:true before the tier-3
createActionIntent branch, so a reset executed with no intent row and the
credential had nowhere to be sealed."
```

---

### Task 8: Registry parity contract test

**Files:**
- Create: `apps/api/src/services/actionIntents/secretBearingTools.contract.test.ts`

**Interfaces:**
- Consumes: `isSecretBearingTool` (Task 1)
- Produces: no new exports

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSecretBearingTool } from './secretBearingTools';

/**
 * Files that legitimately mention credential identifiers without minting one.
 * Every entry needs a reason — an unexplained allowlist entry is how this test
 * decays into a rubber stamp.
 */
const ALLOWLIST: Record<string, string> = {
  'services/m365DirectGraph.ts': 'generates the credential for the M365 direct backend; returns it structured',
  'services/actionIntents/resultSecrets.ts': 'owns the seal/unseal/burn primitives',
  'services/actionIntents/secretBearingTools.ts': 'this registry',
  'services/writeActionService.ts': 'M365 control-plane write path; structured result',
  'routes/actionIntents.ts': 'the reveal endpoint',
  'routes/ai.ts': 'tempPasswordState projection (key presence only)',
  'jobs/intentExpiryReaper.ts': 'sweeps sealed credentials past the reveal window',
  'jobs/intentReleaseWorker.ts': 'seals on the durable path',
};

const MINTS_CREDENTIAL = /generateTempPassword\s*\(/;

describe('secret-bearing tool registry parity', () => {
  it('every file that mints a credential is covered by a registered tool', () => {
    const root = join(__dirname, '../..');
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;

        const rel = full.slice(root.length + 1);
        if (rel in ALLOWLIST) continue;
        if (MINTS_CREDENTIAL.test(readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    };
    walk(root);

    expect(offenders, `these files mint a credential but are neither registered nor allowlisted:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('both known credential-minting tools are registered', () => {
    expect(isSecretBearingTool('m365_reset_password')).toBe(true);
    expect(isSecretBearingTool('google_reset_password')).toBe(true);
  });

  it('the allowlist has no stale entries', () => {
    const root = join(__dirname, '../..');
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(() => readFileSync(join(root, rel), 'utf8'), `allowlisted file no longer exists: ${rel}`).not.toThrow();
    }
  });
});
```

Note `aiToolsGoogle.ts` is deliberately **absent** from the allowlist: it calls `generateTempPassword`, so if someone removes `google_reset_password` from the registry this test must fail. Add it to the allowlist only if the registry check is extended to prove coverage by tool name.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @breeze/api exec vitest run src/services/actionIntents/secretBearingTools.contract.test.ts`
Expected: FAIL initially, listing `services/aiToolsGoogle.ts`. Confirm that is the only offender, then extend the registry check so a file is accepted when it mints a credential **and** the tool it backs is registered — implement by mapping `aiToolsGoogle.ts` → `google_reset_password` and asserting `isSecretBearingTool` returns true for it:

```ts
const MINTER_TO_TOOL: Record<string, string> = {
  'services/aiToolsGoogle.ts': 'google_reset_password',
};
```

and in the walk, before flagging: `if (MINTER_TO_TOOL[rel] && isSecretBearingTool(MINTER_TO_TOOL[rel])) continue;`

- [ ] **Step 3: Re-run to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/actionIntents/secretBearingTools.contract.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/actionIntents/secretBearingTools.contract.test.ts
git commit -m "test(intents): parity contract for the secret-bearing tool registry"
```

---

### Task 9: Real-Postgres integration proof

**Files:**
- Create: `apps/api/src/__tests__/integration/secretBearingToolSeal.integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7
- Produces: no new exports

Requires a real database. Bring one up with `pnpm --filter @breeze/api run test:docker:up` if it is not already running.

- [ ] **Step 1: Write the tests**

Follow the setup/teardown pattern in `apps/api/src/__tests__/integration/intentFanout.integration.test.ts` — reuse its org/user/session fixtures rather than writing new ones.

```ts
describe('secret-bearing tool seal parity (real PG)', () => {
  it.each([
    ['google_reset_password', 'durable'],
    ['m365_reset_password', 'durable'],
    ['google_reset_password', 'inline'],
    ['m365_reset_password', 'inline'],
  ] as const)('%s on the %s path seals the credential', async (toolName, path) => {
    const { intentId, plaintext } = await executeApprovedReset(toolName, path);

    const [row] = await sysDb.select().from(actionIntents).where(eq(actionIntents.id, intentId));
    expect(row!.result).toHaveProperty('temporaryPasswordEnc');
    expect(String(row!.result!.temporaryPasswordEnc)).toMatch(/^enc:v3:/);
    expect(JSON.stringify(row!.result)).not.toContain(plaintext);

    const messages = await sysDb.select().from(aiMessages).where(eq(aiMessages.sessionId, sessionId));
    const executions = await sysDb.select().from(aiToolExecutions).where(eq(aiToolExecutions.sessionId, sessionId));
    expect(JSON.stringify(messages)).not.toContain(plaintext);
    expect(JSON.stringify(executions)).not.toContain(plaintext);
    expect(JSON.stringify(messages)).not.toContain('Temporary password:');
  });

  it('reveals the credential exactly once', async () => {
    const { intentId, plaintext } = await executeApprovedReset('google_reset_password', 'durable');

    const first = await revealSecret(intentId, requesterAuth);
    expect(first.status).toBe(200);
    expect((await first.json()).temporaryPassword).toBe(plaintext);

    const second = await revealSecret(intentId, requesterAuth);
    expect(second.status).toBe(410);
  });

  it('REGRESSION: google durable release stores no plaintext (fails on pre-fix main)', async () => {
    const { intentId, plaintext } = await executeApprovedReset('google_reset_password', 'durable');
    const [row] = await sysDb.select().from(actionIntents).where(eq(actionIntents.id, intentId));
    expect(JSON.stringify(row!.result)).not.toContain(plaintext);
    expect(row!.result).not.toHaveProperty('raw');
  });
});
```

`executeApprovedReset` must stub only the outermost provider client (Google Directory / Delegant or the M365 actions executor) so the credential is a known constant, and drive the real approval → release flow so the seal is exercised end to end.

- [ ] **Step 2: Run against a real database**

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/secretBearingToolSeal.integration.test.ts`
Expected: PASS, all cases.

- [ ] **Step 3: Prove the regression test is real**

```bash
git stash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/secretBearingToolSeal.integration.test.ts -t REGRESSION
git stash pop
```
Expected: FAIL while stashed. A regression test that passes against the unfixed code proves nothing — if it passes, the harness is not exercising the real path and must be fixed before proceeding.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/secretBearingToolSeal.integration.test.ts
git commit -m "test(intents): real-PG proof of seal parity across both tools and paths"
```

---

### Task 10: Survey query and scrub migration

**Files:**
- Create: `internal/security/temp-password-exposure-survey.sql` (gitignored — operator-run)
- Create: `apps/api/migrations/2026-07-26-scrub-plaintext-temp-passwords.sql`

**Interfaces:** none — SQL only.

- [ ] **Step 1: Write the survey**

Create `internal/security/temp-password-exposure-survey.sql`. Counts only; run per region, off-peak (no predicate here is indexable).

```sql
-- Read-only exposure survey for plaintext temporary passwords.
-- Counts only: no credential values, no tenant identifiers. Run on EU and US
-- separately. Safe to run on a replica.
--
-- "redacted" rows are safe (the inline path replaced the value); only
-- "suspected_plaintext" indicates a real exposure.

WITH intents AS (
  SELECT
    count(*) FILTER (
      WHERE result::text LIKE '%Temporary password: [REDACTED]%'
    ) AS redacted,
    count(*) FILTER (
      WHERE (result ? 'temporaryPassword')
         OR (result->>'raw' LIKE '%Temporary password:%'
             AND result->>'raw' NOT LIKE '%[REDACTED]%'
             AND result->>'raw' NOT LIKE '%[redacted]%')
    ) AS suspected_plaintext
  FROM action_intents
  WHERE action_name IN ('m365_reset_password', 'google_reset_password')
),
messages AS (
  SELECT
    count(*) FILTER (WHERE tool_output::text LIKE '%[REDACTED]%') AS redacted,
    count(*) FILTER (
      WHERE (coalesce(tool_output->>'raw', tool_output->>'message') LIKE '%Temporary password:%')
        AND coalesce(tool_output->>'raw', tool_output->>'message') NOT LIKE '%[REDACTED]%'
        AND coalesce(tool_output->>'raw', tool_output->>'message') NOT LIKE '%[redacted]%'
    ) AS suspected_plaintext
  FROM ai_messages
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
),
executions AS (
  SELECT
    count(*) FILTER (WHERE tool_output::text LIKE '%[REDACTED]%') AS redacted,
    count(*) FILTER (
      WHERE (coalesce(tool_output->>'raw', tool_output->>'message') LIKE '%Temporary password:%')
        AND coalesce(tool_output->>'raw', tool_output->>'message') NOT LIKE '%[REDACTED]%'
        AND coalesce(tool_output->>'raw', tool_output->>'message') NOT LIKE '%[redacted]%'
    ) AS suspected_plaintext
  FROM ai_tool_executions
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
)
SELECT 'action_intents' AS table_name, redacted, suspected_plaintext FROM intents
UNION ALL SELECT 'ai_messages', redacted, suspected_plaintext FROM messages
UNION ALL SELECT 'ai_tool_executions', redacted, suspected_plaintext FROM executions;
```

- [ ] **Step 2: Verify the survey is gitignored**

Run: `git check-ignore -v internal/security/temp-password-exposure-survey.sql`
Expected: a match on `.gitignore:82:/internal/*`. If it does NOT match, stop — do not commit the file.

- [ ] **Step 3: Write the scrub migration**

Create `apps/api/migrations/2026-07-26-scrub-plaintext-temp-passwords.sql`:

```sql
-- Redact historical plaintext temporary passwords.
--
-- Redact, do not re-seal: these credentials are weeks old, all carried
-- forceChangePasswordNextSignIn, and preserving a secret nobody asked to keep
-- is the opposite of the goal. Operators whose credential is burned here must
-- reset the password again.
--
-- Row counts are logged UNCONDITIONALLY, including zero. This deliberately
-- deviates from the CLAUDE.md `IF n > 0` snippet: a zero count is itself the
-- evidence that no exposure occurred, and this migration may be cited as
-- forensic record. Never log values, row ids, or org ids.

DO $$
DECLARE n bigint;
BEGIN
  UPDATE action_intents
  SET result = (result - 'temporaryPassword')
               || jsonb_build_object('temporaryPasswordExpired', true)
  WHERE action_name IN ('m365_reset_password', 'google_reset_password')
    AND result ? 'temporaryPassword';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: action_intents legacy-key rows redacted: %', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  UPDATE action_intents
  SET result = jsonb_set(
        result,
        '{raw}',
        to_jsonb(
          regexp_replace(
            result->>'raw',
            '(Temporary password: ).*?( \(the user must change it at next sign-in\).)',
            '\1[redacted]\2',
            'g'
          )
        )
      ) || jsonb_build_object('temporaryPasswordExpired', true)
  WHERE action_name IN ('m365_reset_password', 'google_reset_password')
    AND result->>'raw' LIKE '%Temporary password:%'
    AND result->>'raw' NOT LIKE '%[redacted]%'
    AND result->>'raw' NOT LIKE '%[REDACTED]%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: action_intents prose rows redacted: %', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  UPDATE ai_messages
  SET tool_output = jsonb_set(
        tool_output,
        '{raw}',
        to_jsonb(
          regexp_replace(
            tool_output->>'raw',
            '(Temporary password: ).*?( \(the user must change it at next sign-in\).)',
            '\1[redacted]\2',
            'g'
          )
        )
      )
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
    AND tool_output->>'raw' LIKE '%Temporary password:%'
    AND tool_output->>'raw' NOT LIKE '%[redacted]%'
    AND tool_output->>'raw' NOT LIKE '%[REDACTED]%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: ai_messages rows redacted: %', n;
END $$;

DO $$
DECLARE n bigint;
BEGIN
  UPDATE ai_tool_executions
  SET tool_output = jsonb_set(
        tool_output,
        '{raw}',
        to_jsonb(
          regexp_replace(
            tool_output->>'raw',
            '(Temporary password: ).*?( \(the user must change it at next sign-in\).)',
            '\1[redacted]\2',
            'g'
          )
        )
      )
  WHERE tool_name IN ('m365_reset_password', 'google_reset_password')
    AND tool_output->>'raw' LIKE '%Temporary password:%'
    AND tool_output->>'raw' NOT LIKE '%[redacted]%'
    AND tool_output->>'raw' NOT LIKE '%[REDACTED]%';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'scrub: ai_tool_executions rows redacted: %', n;
END $$;

-- Post-condition: no suspected plaintext may remain.
DO $$
DECLARE remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM action_intents
  WHERE action_name IN ('m365_reset_password', 'google_reset_password')
    AND ((result ? 'temporaryPassword')
      OR (result->>'raw' LIKE '%Temporary password:%'
          AND result->>'raw' NOT LIKE '%[redacted]%'
          AND result->>'raw' NOT LIKE '%[REDACTED]%'));
  IF remaining > 0 THEN
    RAISE EXCEPTION 'scrub incomplete: % action_intents rows still hold suspected plaintext', remaining;
  END IF;
  RAISE WARNING 'scrub: post-condition clean, 0 residual plaintext rows';
END $$;
```

Re-running is a no-op: every predicate excludes already-redacted rows.

- [ ] **Step 4: Verify idempotency against a real database**

```bash
pnpm --filter @breeze/api run db:migrate   # applies the scrub
pnpm --filter @breeze/api run db:migrate   # second run must be a clean no-op
```
Expected: both runs succeed. Note `breeze_migrations` keys on filename, so the second run will not re-execute the file — to genuinely prove idempotency, also run the migration body directly twice against a scratch database:

```bash
psql "$DATABASE_URL" -f apps/api/migrations/2026-07-26-scrub-plaintext-temp-passwords.sql
psql "$DATABASE_URL" -f apps/api/migrations/2026-07-26-scrub-plaintext-temp-passwords.sql
```
Expected: the second invocation logs zero counts for every table and the clean post-condition.

- [ ] **Step 5: Confirm no schema drift**

Run: `pnpm db:check-drift`
Expected: no drift (this migration changes data only).

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-07-26-scrub-plaintext-temp-passwords.sql
git commit -m "fix(intents): redact historical plaintext temporary passwords

Redact rather than re-seal; logs row counts unconditionally including zero
so the migration stands as forensic record. Survey query is operator-run and
lives in internal/ (gitignored)."
```

---

## Final verification

- [ ] `pnpm --filter @breeze/api exec tsc --noEmit` — clean
- [ ] `pnpm --filter @breeze/api run test:run` — full API unit suite green
- [ ] `pnpm --filter @breeze/api run test:integration` — integration suite green
- [ ] `pnpm db:check-drift` — no drift
- [ ] Task 9 Step 3 confirmed the regression test fails against pre-fix code
- [ ] `grep -rn "Temporary password: \${" apps/api/src` returns nothing outside tests

## Deployment note

`APP_ENCRYPTION_KEY_ID` and `APP_ENCRYPTION_KEY` must be present in `/opt/breeze/.env` **and** mapped in the compose `environment:` block on both EU and US. Without `APP_ENCRYPTION_KEY_ID`, every seal falls back to v1, which this code refuses — so every reset would report the credential as unavailable. Verify before enabling, and run the §7.1 survey before applying the scrub.
