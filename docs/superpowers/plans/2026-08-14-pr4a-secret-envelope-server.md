# Tenant Variables #3409 — PR4a Implementation Plan (server-side secret machinery, inert)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every server-side mechanism a secret needs — encrypted envelope, AAD binding, agent capability storage, exact-value output redaction, centralized terminal payload erasure — while secrets remain **blocked** at script save and at dispatch, so nothing secret ever reaches the wire in this PR.

**Architecture:** A script command's secret map is serialized to one canonical JSON string and sealed as a single top-level payload field `secretEnvEnvelope` (ciphertext), AAD-bound to schema version + command type + field + command id + device id. It opens back to `secretEnv` (object) only at delivery. Because AAD needs the command id, `scriptDispatch` now reserves the command UUID before encrypting and hands it to `queueCommand`. On the return leg, both agent-result ingest chokepoints open the envelope solely to build an exact-value redactor, redact stdout/stderr/error before anything is persisted, and strip the sensitive payload keys in the same terminal CAS statement. **`secretEnv` is never populated by any caller in this PR** — the seal path is exercised only by tests.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL (jsonb), Vitest, Zod 4.

## Global Constraints

- **Branch:** `ToddHebebrand/tenant-variables-pr4` (already rebased onto `origin/main`). Do not merge 4b/4c work into it.
- **No behavior change for existing traffic.** Every new code path must be unreachable until a caller sets `secretEnv`, which nothing does in this PR.
- **v3 encryption is mandatory for the envelope.** `encryptSecret` silently falls back to `enc:v1:` (AAD ignored) when `APP_ENCRYPTION_KEY_ID` is unset — `apps/api/src/services/secretCrypto.ts`, `encryptSecret`. The envelope codec MUST throw instead of degrading.
- **Redaction marker is exactly `[REDACTED]`** — never a marker naming the variable key.
- **Verification-failure marker is exactly `[OUTPUT_REDACTED:VERIFICATION_FAILED]`.**
- **Migration naming:** new file must sort after the newest shipped migration, currently `apps/api/migrations/2026-08-21-patch-reboot-delay-minutes.sql`. Use `2026-08-22-<slug>.sql`. Idempotent, no inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration.
- **`devices` is org-scoped and already in every cascade/export list**, but **adding a COLUMN to it fires the export-policy contract** — `CORE_TENANT_EXPORT_POLICY` in `apps/api/src/services/tenantExportPolicyRegistry.ts` must gain the new column in the same PR (see Task 4). This is the step that historically gets missed.
- **Test command:** `pnpm --filter @breeze/api test -- <path>` for a slice; the **full** API suite (`pnpm --filter @breeze/api test`) before opening the PR — PR3 shipped 5 failures in a file no per-task run had opened.
- **Mutation-verify every guard test.** For each new guard: force it off (invert the condition / return a constant), confirm the new tests fail *and nothing else does*, restore.

---

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `apps/api/src/services/scriptSecretEnvelope.ts` | Canonical serialize + seal/open of the `secretEnv` map; AAD construction; v3 requirement; strict post-decrypt validation. |
| `apps/api/src/services/scriptSecretEnvelope.test.ts` | Round-trip, AAD-mismatch, v1-fallback-refusal, validation-rejection tests. |
| `apps/api/src/services/exactSecretRedaction.ts` | `buildExactValueRedactor(values)` → pure `(text) => string`; dedupe, overlap merge, single pass over the original text. |
| `apps/api/src/services/exactSecretRedaction.test.ts` | Overlap/dedupe/idempotence/marker tests. |
| `apps/api/src/services/commandSecretRedaction.ts` | Ingest-side glue: open a stored command's envelope and redact `{normalizedResult, stdout}`, or fail closed to `[OUTPUT_REDACTED:VERIFICATION_FAILED]`. |
| `apps/api/src/services/commandSecretRedaction.test.ts` | Happy path, no-envelope passthrough, decrypt-failure fail-closed. |
| `apps/api/migrations/2026-08-22-device-script-secret-env-capability.sql` | `devices.script_secret_env_version integer NOT NULL DEFAULT 0`. |

**Modify**

| File | Change |
|---|---|
| `apps/api/src/services/sensitiveCommandPayload.ts` | Envelope registry entry for `script`; `SecretPayloadContext`; `terminalPayloadErasureSet()`; `DeliverableCommand` gains `deviceId`. |
| `apps/api/src/services/commandQueue.ts` | `queueCommand` accepts an explicit `commandId`; thread `deviceId` into the 2 decrypt call sites; resurrection guard at the re-arm site. |
| `apps/api/src/services/commandDelivery.ts` | Thread `deviceId` through `decryptClaimedCommandsForDelivery`. |
| `apps/api/src/services/scriptDispatch.ts` | Reserve the command UUID; pass encryption context; pass `deviceId` to `decryptCommandForDelivery`. |
| 11 terminal-update sites (Task 1 table) | Apply `terminalPayloadErasureSet()`. |
| `apps/api/src/routes/agentWs.ts`, `apps/api/src/routes/agents/commands.ts` | Exact-value redaction between normalization and the terminal CAS. |
| `apps/api/src/routes/agents/schemas.ts`, `apps/api/src/routes/agents/heartbeat.ts` | `securityCapabilities.scriptSecretEnvVersion` in, non-sticky write out. |
| `apps/api/src/db/schema/devices.ts` | `scriptSecretEnvVersion` column. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Classify the new column. |
| `packages/shared/src/validators/tenantVariables.ts` | Secret values must be ≥ 4 characters. |

---

### Task 1: Centralized terminal payload erasure

Today only **one** of eleven terminal-state writers blanks a sensitive payload (`routes/agents/commands.ts`). `encryption_rotate_key` already ships `password` + `currentRecoveryKey` in `device_commands.payload`, and that table is deliberately RLS-free/system-scoped with unbounded retention. PR4a adds a second sensitive key (`secretEnvEnvelope`), so the fix has to be one shared expression applied everywhere rather than eleven ad-hoc spreads.

The existing site sets `payload: null`. We switch to **key-stripping** so non-secret payload fields survive for forensics, and so the same expression is safe on bulk updates that never load individual rows.

**Files:**
- Modify: `apps/api/src/services/sensitiveCommandPayload.ts`
- Test: `apps/api/src/services/sensitiveCommandPayload.test.ts`
- Modify (11 call sites, enumerated in Step 6)

**Interfaces:**
- Produces: `TERMINAL_PAYLOAD_STRIP_KEYS: readonly string[]`, `terminalPayloadErasureSet(): { payload: SQL }`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/sensitiveCommandPayload.test.ts`:

```ts
import { TERMINAL_PAYLOAD_STRIP_KEYS, terminalPayloadErasureSet } from './sensitiveCommandPayload';

describe('terminal payload erasure', () => {
  it('strips every field name any sensitive command type can carry', () => {
    // Derived from the registry, not hand-listed: adding a sensitive field to
    // a command type must automatically extend the erasure set.
    expect(TERMINAL_PAYLOAD_STRIP_KEYS).toEqual(
      expect.arrayContaining(['password', 'currentRecoveryKey', 'secretEnvEnvelope']),
    );
  });

  it('emits a jsonb key-subtraction that preserves a NULL payload', () => {
    const { payload } = terminalPayloadErasureSet();
    // Drizzle SQL object: assert on the rendered chunks, not object identity.
    const rendered = JSON.stringify(payload);
    expect(rendered).toContain('IS NULL');
    expect(rendered).toContain('password');
    expect(rendered).toContain('secretEnvEnvelope');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- src/services/sensitiveCommandPayload.test.ts`
Expected: FAIL — `TERMINAL_PAYLOAD_STRIP_KEYS` is not exported.

- [ ] **Step 3: Implement in `sensitiveCommandPayload.ts`**

Add near the top (after `SENSITIVE_PAYLOAD_FIELDS`), plus the imports `import { sql, type SQL } from 'drizzle-orm';` and `import { deviceCommands } from '../db/schema';`:

```ts
/**
 * Every payload field name that may hold credential material, across all
 * command types, plus the PR4 script secret envelope. Derived from the
 * registry so a new sensitive field is erased automatically — the historical
 * failure mode was a field added to one type and erased at one of eleven
 * terminal writers.
 */
export const TERMINAL_PAYLOAD_STRIP_KEYS: readonly string[] = [
  ...new Set([
    ...Object.values(SENSITIVE_PAYLOAD_FIELDS).flat(),
    SCRIPT_SECRET_ENVELOPE_FIELD,
  ]),
].sort();

/**
 * The `.set({...})` fragment every terminal `device_commands` update must
 * spread, so credential material stops living in an unbounded-retention,
 * RLS-free table the moment the command stops being deliverable.
 *
 * Key-subtraction rather than `payload: null`: the same expression is then
 * correct on the BULK cancellation/reaper updates that never load individual
 * rows, and non-secret payload fields (scriptId, type, target) survive for
 * forensics. Idempotent — jsonb `-` on an absent key is a no-op — so a row
 * driven terminal twice (WS/REST race) is fine. NULL is preserved as NULL
 * because `NULL - text[]` would otherwise yield NULL anyway, but the explicit
 * CASE documents the intent and keeps the expression readable in EXPLAIN.
 */
export function terminalPayloadErasureSet(): { payload: SQL } {
  return {
    payload: sql`CASE WHEN ${deviceCommands.payload} IS NULL THEN NULL
      ELSE ${deviceCommands.payload} - ${sql.raw(
        `ARRAY[${TERMINAL_PAYLOAD_STRIP_KEYS.map((k) => `'${k}'`).join(',')}]::text[]`,
      )} END`,
  };
}
```

`SCRIPT_SECRET_ENVELOPE_FIELD` is defined in Task 2; until Task 2 lands, define it inline in this file as `const SCRIPT_SECRET_ENVELOPE_FIELD = 'secretEnvEnvelope';` and move it to the envelope module in Task 2.

`sql.raw` is safe here and only here: the key list is a module-level constant of identifiers this repo controls, never request data.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test -- src/services/sensitiveCommandPayload.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/sensitiveCommandPayload.ts apps/api/src/services/sensitiveCommandPayload.test.ts
git commit -m "feat(api): shared terminal payload erasure expression for device_commands"
```

- [ ] **Step 6: Apply it at all eleven terminal writers**

Enumerate the candidates with:

```bash
grep -rn "update(deviceCommands)" apps/api/src --include='*.ts' | grep -v '\.test\.'
```

A site qualifies when its `.set({...})` writes a **terminal** status (`completed`, `failed`, `cancelled`, `timeout`). Claim/send transitions (`sent`, `running`) and the re-arm at `services/commandQueue.ts` do **not** qualify — the re-arm is handled in Step 8.

| Site | Terminal state |
|---|---|
| `routes/agents/commands.ts` (REST result CAS) | completed/failed — **replace** the existing `...(hasSensitivePayload(command.type) ? { payload: null } : {})` |
| `routes/agentWs.ts` (WS result CAS) | completed/failed |
| `services/commandQueue.ts` (sync-wait timeout) | failed/timeout |
| `services/commandQueue.ts` (`submitCommandResult`) | completed/failed |
| `jobs/staleCommandReaper.ts` (undelivered sweep) | failed |
| `jobs/staleCommandReaper.ts` (cancellation sweep) | cancelled |
| `routes/scripts.ts` | cancelled |
| `routes/software.ts` | cancelled |
| `routes/admin/abuse.ts` | cancelled |
| `routes/backup/verificationScheduled.ts` | failed |
| `services/tenantOffboarding.ts` (×3) | cancelled |

At each, add `...terminalPayloadErasureSet(),` to the `.set({ ... })` object and import the helper. Example (`routes/scripts.ts`):

```ts
        .set({
          status: 'cancelled',
          completedAt: new Date(),
          ...terminalPayloadErasureSet(),
        })
```

For `routes/agents/commands.ts`, delete the `hasSensitivePayload(command.type) ? { payload: null } : {}` spread and the now-unused `hasSensitivePayload` import if nothing else in the file uses it.

- [ ] **Step 7: Verify no terminal writer was missed**

Add a regression test at `apps/api/src/services/__tests__/terminalPayloadErasure.coverage.test.ts` that reads the source files and asserts the invariant statically — this is the only thing that catches the twelfth site someone adds later:

```ts
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const API_SRC = path.resolve(__dirname, '../..');

/**
 * Static guard, mirroring the cascade-list contract tests: every
 * `db.update(deviceCommands)` whose `.set({...})` drives a TERMINAL status
 * must also spread `terminalPayloadErasureSet()`. Code review has never
 * caught a missed site; a grep-shaped test does.
 */
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timeout'];

function updateBlocks(source: string): string[] {
  // Each `.update(deviceCommands)` through the end of its `.set({...})` call.
  return source.split('.update(deviceCommands)').slice(1).map((tail) => tail.slice(0, 800));
}

it('every terminal device_commands update erases sensitive payload keys', () => {
  const files = execSync(
    `grep -rl "update(deviceCommands)" ${API_SRC} --include='*.ts' | grep -v '\\.test\\.'`,
    { encoding: 'utf8' },
  ).trim().split('\n');

  const offenders: string[] = [];
  for (const file of files) {
    for (const block of updateBlocks(readFileSync(file, 'utf8'))) {
      const setsTerminal = TERMINAL_STATUSES.some((s) => block.includes(`status: '${s}'`));
      if (setsTerminal && !block.includes('terminalPayloadErasureSet()')) {
        offenders.push(`${path.relative(API_SRC, file)}: ${block.slice(0, 120).replace(/\s+/g, ' ')}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
```

Run: `pnpm --filter @breeze/api test -- src/services/__tests__/terminalPayloadErasure.coverage.test.ts`
Expected: PASS once all eleven sites are edited. **Mutation-verify:** remove the spread from one site, confirm this test fails naming that file, restore.

- [ ] **Step 8: Guard the resurrection path**

`services/commandQueue.ts` re-arms a **terminal** desktop-stream row back to `pending`. Because the erasure already ran, the row's payload no longer carries an envelope; re-arming it would deliver a script command whose secrets silently vanished — the exact "silent wrong run" this initiative exists to prevent. Add, immediately before that update:

```ts
    // #3409 PR4a: a terminal row has had its sensitive payload keys stripped
    // (terminalPayloadErasureSet). Re-arming such a row would re-deliver a
    // command whose secrets are gone — a silent wrong run. Only rows that
    // never carried secret material may be resurrected.
    const payloadKeys = existing.payload && typeof existing.payload === 'object'
      ? Object.keys(existing.payload as Record<string, unknown>)
      : [];
    if (TERMINAL_PAYLOAD_STRIP_KEYS.some((k) => payloadKeys.includes(k)) ||
        hasSensitivePayload(existing.type)) {
      console.warn('[commandQueue] refusing to re-arm a terminal command that carried secret material', {
        commandId: existing.id, type: existing.type,
      });
      return null;
    }
```

Adjust the early-return to the surrounding function's contract (it may need to fall through to the "enqueue a fresh command" branch rather than return `null` — read the function before editing).

- [ ] **Step 9: Run the touched slices and commit**

```bash
pnpm --filter @breeze/api test -- src/services/commandQueue.test.ts src/routes/agentWs.test.ts src/jobs/staleCommandReaper.test.ts src/routes/agents/commands.test.ts
git add -A apps/api/src
git commit -m "fix(api): erase sensitive device_commands payload at every terminal writer

Only the REST result route blanked the payload; ten other terminal writers
(WS ingest, reaper, six cancellation paths, offboarding) retained encrypted
credential material in an unbounded-retention, RLS-free table. Replaces the
one-off spread with a shared jsonb key-subtraction applied everywhere, plus a
static coverage test and a resurrection guard."
```

---

### Task 2: Secret envelope codec

**Files:**
- Create: `apps/api/src/services/scriptSecretEnvelope.ts`
- Create: `apps/api/src/services/scriptSecretEnvelope.test.ts`
- Modify: `packages/shared/src/validators/tenantVariables.ts`
- Test: `packages/shared/src/validators/tenantVariables.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`, `decryptSecret`, `getActiveKeyId` from `./secretCrypto`; `TENANT_VARIABLE_KEY_PATTERN`, `MAX_TENANT_VARIABLE_VALUE_LENGTH` from `@breeze/shared`.
- Produces:
  - `SCRIPT_SECRET_ENVELOPE_FIELD = 'secretEnvEnvelope'` (stored/ciphertext field name)
  - `SCRIPT_SECRET_ENV_FIELD = 'secretEnv'` (wire/plaintext field name)
  - `SCRIPT_SECRET_ENV_SCHEMA_VERSION = 1`
  - `MAX_SECRET_ENV_ENTRIES = 32`
  - (the 4-character floor is `MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH`, defined **once** in `@breeze/shared` — Step 5 — and imported here. Do not define a second constant in the API package.)
  - `type SecretPayloadContext = { commandId: string; deviceId: string }`
  - `buildSecretEnvAad(ctx: SecretPayloadContext): string`
  - `sealSecretEnv(secretEnv: Record<string, string>, ctx: SecretPayloadContext): string`
  - `openSecretEnv(envelope: string, ctx: SecretPayloadContext): Record<string, string>`

Both `seal` and `open` **throw** on every failure. Neither returns null, and neither ever includes a secret value in an error message.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/scriptSecretEnvelope.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH } from '@breeze/shared';
import {
  sealSecretEnv,
  openSecretEnv,
  buildSecretEnvAad,
  MAX_SECRET_ENV_ENTRIES,
} from './scriptSecretEnvelope';

const CTX = {
  commandId: '11111111-1111-4111-8111-111111111111',
  deviceId: '22222222-2222-4222-8222-222222222222',
};
const OTHER_CTX = { ...CTX, deviceId: '33333333-3333-4333-8333-333333333333' };

beforeAll(() => {
  // v3 (AAD-bound) encryption requires a keyed configuration; without a key id
  // secretCrypto silently degrades to v1 and IGNORES AAD.
  process.env.APP_ENCRYPTION_KEY_ID = 'test';
  process.env.APP_ENCRYPTION_KEYS = JSON.stringify({ test: 'a'.repeat(64) });
});

describe('sealSecretEnv / openSecretEnv', () => {
  it('round-trips a map under a matching context', () => {
    const sealed = sealSecretEnv({ api_token: 'super-secret-value' }, CTX);
    expect(sealed.startsWith('enc:v3:')).toBe(true);
    expect(sealed).not.toContain('super-secret-value');
    expect(openSecretEnv(sealed, CTX)).toEqual({ api_token: 'super-secret-value' });
  });

  it('refuses to open under a different device (AAD binding)', () => {
    const sealed = sealSecretEnv({ api_token: 'super-secret-value' }, CTX);
    expect(() => openSecretEnv(sealed, OTHER_CTX)).toThrow();
  });

  it('refuses to seal when no active key id is configured (v1 fallback ignores AAD)', () => {
    const saved = process.env.APP_ENCRYPTION_KEY_ID;
    delete process.env.APP_ENCRYPTION_KEY_ID;
    try {
      expect(() => sealSecretEnv({ api_token: 'super-secret-value' }, CTX)).toThrow(
        /AAD-bound/i,
      );
    } finally {
      process.env.APP_ENCRYPTION_KEY_ID = saved;
    }
  });

  it('rejects a value shorter than the redaction floor', () => {
    expect(() => sealSecretEnv({ api_token: 'ab' }, CTX)).toThrow(
      new RegExp(`${MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH}`),
    );
  });

  it('rejects an empty value', () => {
    expect(() => sealSecretEnv({ api_token: '' }, CTX)).toThrow();
  });

  it('rejects a key outside the tenant-variable grammar', () => {
    expect(() => sealSecretEnv({ 'BAD KEY': 'super-secret-value' }, CTX)).toThrow();
  });

  it('rejects more than the entry cap', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_SECRET_ENV_ENTRIES + 1 }, (_, i) => [`k${i}`, 'value-value']),
    );
    expect(() => sealSecretEnv(tooMany, CTX)).toThrow();
  });

  it('never leaks a secret value in an error message', () => {
    try {
      sealSecretEnv({ api_token: 'ab' }, CTX);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('ab');
      expect((err as Error).message).toContain('api_token');
    }
  });

  it('rejects a decrypted payload that is not a flat string map', () => {
    // Seal a hand-built envelope carrying a nested object, then prove open()
    // rejects it rather than handing a non-string to the wire.
    const { encryptSecret } = require('./secretCrypto');
    const bogus = encryptSecret(JSON.stringify({ v: 1, env: { a: { nested: true } } }), {
      aad: buildSecretEnvAad(CTX),
    });
    expect(() => openSecretEnv(bogus, CTX)).toThrow();
  });

  it('serializes deterministically regardless of insertion order', () => {
    const a = sealSecretEnv({ b_key: 'value-one', a_key: 'value-two' }, CTX);
    const b = sealSecretEnv({ a_key: 'value-two', b_key: 'value-one' }, CTX);
    // Ciphertext differs (random IV) but the decrypted canonical form matches.
    expect(openSecretEnv(a, CTX)).toEqual(openSecretEnv(b, CTX));
    expect(Object.keys(openSecretEnv(a, CTX))).toEqual(['a_key', 'b_key']);
  });
});
```

Confirm the `APP_ENCRYPTION_KEYS` env shape against `apps/api/src/services/secretCrypto.ts` before running — mirror whatever `secretCrypto.test.ts` already does to install a keyed configuration rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- src/services/scriptSecretEnvelope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `apps/api/src/services/scriptSecretEnvelope.ts`**

First add the shared constant this module imports — it is the single definition of the 4-character floor, used by the envelope codec, the redactor, and the save-time validation in Step 5. In `packages/shared/src/validators/tenantVariables.ts`, beside `MAX_TENANT_VARIABLE_VALUE_LENGTH`:

```ts
/**
 * A secret shorter than this cannot be exact-value-redacted from script output
 * without shredding the output itself (imagine redacting every "ab"). Dispatch
 * refuses to ship such a variable rather than choosing between destroying the
 * operator's output and leaking the credential, so it is also rejected at save
 * time. Non-secret variables are unaffected — `"3"` is a legitimate retry count.
 */
export const MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH = 4;
```

Export it from the package's validator barrel if that file re-exports explicitly rather than with `export *`. Then:

```ts
import {
  TENANT_VARIABLE_KEY_PATTERN,
  MAX_TENANT_VARIABLE_VALUE_LENGTH,
  MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH,
} from '@breeze/shared';
import { decryptSecret, encryptSecret, getActiveKeyId } from './secretCrypto';

/**
 * #3409 PR4 — secret delivery envelope.
 *
 * The whole `secretEnv` map is serialized to ONE canonical JSON string and
 * sealed as a SINGLE top-level payload field. Per-value encryption would
 * additionally leak variable names, the count of secrets, and each value's
 * length; one envelope leaks only "this command uses secrets" and an
 * approximate size. Nothing is lost by the coarser granularity: a single
 * corrupt value must fail the whole script anyway, because running with a
 * partial credential set is more dangerous than not running at all.
 *
 * Stored and wire field names are DISTINCT on purpose — `secretEnvEnvelope`
 * (ciphertext string) at rest, `secretEnv` (object) on the wire — so no field
 * ever changes type between storage and delivery and a half-applied decrypt
 * is structurally impossible to mistake for a plaintext map.
 */
export const SCRIPT_SECRET_ENVELOPE_FIELD = 'secretEnvEnvelope';
export const SCRIPT_SECRET_ENV_FIELD = 'secretEnv';
export const SCRIPT_SECRET_ENV_SCHEMA_VERSION = 1;

/** Bounds the redactor's work and the envelope size. */
export const MAX_SECRET_ENV_ENTRIES = 32;

export type SecretPayloadContext = { commandId: string; deviceId: string };

/**
 * Additional authenticated data. Binds schema version, command type, field,
 * command id AND device id, so a ciphertext lifted from one command row cannot
 * be replayed into another row or against another device. The pre-existing
 * global constant AAD (`device_commands.payload`) provides none of that.
 */
export function buildSecretEnvAad(ctx: SecretPayloadContext): string {
  return [
    'device_commands.payload',
    SCRIPT_SECRET_ENVELOPE_FIELD,
    `v${SCRIPT_SECRET_ENV_SCHEMA_VERSION}`,
    'script',
    ctx.commandId,
    ctx.deviceId,
  ].join('|');
}

function assertContext(ctx: SecretPayloadContext): void {
  if (!ctx?.commandId || !ctx?.deviceId) {
    throw new Error('[scriptSecretEnvelope] commandId and deviceId are required for AAD binding');
  }
}

function validateSecretEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('[scriptSecretEnvelope] secretEnv must be a plain object');
  }
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error('[scriptSecretEnvelope] secretEnv must not be empty');
  }
  if (entries.length > MAX_SECRET_ENV_ENTRIES) {
    throw new Error(
      `[scriptSecretEnvelope] secretEnv has ${entries.length} entries, max ${MAX_SECRET_ENV_ENTRIES}`,
    );
  }
  const out: Record<string, string> = {};
  // Sorted so the canonical serialization is order-independent.
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!TENANT_VARIABLE_KEY_PATTERN.test(key)) {
      throw new Error(`[scriptSecretEnvelope] invalid secret key "${key}"`);
    }
    if (typeof value !== 'string') {
      throw new Error(`[scriptSecretEnvelope] secret "${key}" is not a string`);
    }
    // Error messages name the KEY, never the value — these strings reach logs.
    // The floor exists because a secret shorter than this cannot be
    // exact-value-redacted from output without shredding the output itself
    // (imagine redacting every "ab"). Rather than choose between destroying
    // the operator's output and leaking the credential, refuse to ship at all.
    if (value.length < MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH) {
      throw new Error(
        `[scriptSecretEnvelope] secret "${key}" is shorter than ${MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH} characters and cannot be safely redacted from output`,
      );
    }
    if (value.length > MAX_TENANT_VARIABLE_VALUE_LENGTH) {
      throw new Error(`[scriptSecretEnvelope] secret "${key}" exceeds the maximum value length`);
    }
    out[key] = value;
  }
  return out;
}

export function sealSecretEnv(
  secretEnv: Record<string, string>,
  ctx: SecretPayloadContext,
): string {
  assertContext(ctx);
  // A live secret on the wire must never ride the v1 fallback: encryptSecret
  // silently drops to `enc:v1:` and IGNORES the AAD when no key id is set.
  // That degradation was accepted for tenant_variables at rest (PR1); it is
  // not acceptable here, where AAD binding is the whole defense.
  if (!getActiveKeyId()) {
    throw new Error(
      '[scriptSecretEnvelope] APP_ENCRYPTION_KEY_ID is not configured; AAD-bound (v3) encryption is required for secret delivery',
    );
  }
  const canonical = JSON.stringify({
    v: SCRIPT_SECRET_ENV_SCHEMA_VERSION,
    env: validateSecretEnv(secretEnv),
  });
  const sealed = encryptSecret(canonical, { aad: buildSecretEnvAad(ctx) });
  if (!sealed || !sealed.startsWith('enc:v3:')) {
    throw new Error('[scriptSecretEnvelope] encryption did not produce an AAD-bound envelope');
  }
  return sealed;
}

export function openSecretEnv(
  envelope: string,
  ctx: SecretPayloadContext,
): Record<string, string> {
  assertContext(ctx);
  if (typeof envelope !== 'string' || !envelope.startsWith('enc:v3:')) {
    throw new Error('[scriptSecretEnvelope] envelope is not AAD-bound ciphertext');
  }
  // Throws on AAD mismatch, wrong key, or corruption — never fail-soft.
  const plaintext = decryptSecret(envelope, { aad: buildSecretEnvAad(ctx) });
  if (!plaintext) {
    throw new Error('[scriptSecretEnvelope] envelope decrypted to empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('[scriptSecretEnvelope] envelope plaintext is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[scriptSecretEnvelope] envelope plaintext is not an object');
  }
  const { v, env, ...rest } = parsed as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new Error('[scriptSecretEnvelope] envelope has unexpected properties');
  }
  if (v !== SCRIPT_SECRET_ENV_SCHEMA_VERSION) {
    throw new Error(`[scriptSecretEnvelope] unsupported envelope schema version ${String(v)}`);
  }
  return validateSecretEnv(env);
}
```

If `getActiveKeyId` is not currently exported from `secretCrypto.ts`, export it (it already exists as a module-private helper) rather than re-deriving the env lookup here.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test -- src/services/scriptSecretEnvelope.test.ts`
Expected: PASS

- [ ] **Step 5: Enforce the 4-character floor at save time**

The floor must also fire in the Variables UI, not only at dispatch — otherwise an operator saves a 2-character secret and discovers the problem months later when a script fails on every device.

The constant already exists from Step 3. `value` currently has `.min(1)`; leave that (non-secret variables may legitimately be `"1"`) and add, on both `createTenantVariableSchema` and the object the update schema derives from, a `.superRefine` — **not** a `.refine` on `value` alone, which cannot see `isSecret`:

```ts
const secretValueFloor = (
  data: { value?: string; isSecret?: boolean },
  ctx: z.RefinementCtx,
) => {
  if (
    data.isSecret === true &&
    typeof data.value === 'string' &&
    data.value.length < MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: `Secret values must be at least ${MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH} characters so they can be redacted from script output`,
    });
  }
};
```

Apply with `.superRefine(secretValueFloor)` to the create schema and the update schema. **The update schema is `.partial()`, so a request that changes only `isSecret: true` without resending `value` will not trip this** — the route must therefore re-check against the stored value. Add that check in `apps/api/src/services/tenantVariables.ts` at the update path, where the existing row is already loaded, and return a 400 with the same message.

- [ ] **Step 6: Test the save-time floor**

Add to `packages/shared/src/validators/tenantVariables.test.ts`:

```ts
it('rejects a secret value below the redaction floor', () => {
  const res = createTenantVariableSchema.safeParse({
    ownerScope: 'organization', key: 'api_token', value: 'ab', isSecret: true,
  });
  expect(res.success).toBe(false);
});

it('still allows a short NON-secret value', () => {
  const res = createTenantVariableSchema.safeParse({
    ownerScope: 'organization', key: 'retries', value: '3', isSecret: false,
  });
  expect(res.success).toBe(true);
});
```

Add the service-layer twin in `apps/api/src/services/tenantVariables.test.ts`: flipping `isSecret` to `true` on a stored 2-character value is rejected.

Run: `pnpm --filter @breeze/shared test -- src/validators/tenantVariables.test.ts && pnpm --filter @breeze/api test -- src/services/tenantVariables.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/scriptSecretEnvelope.ts apps/api/src/services/scriptSecretEnvelope.test.ts packages/shared/src/validators/tenantVariables.ts packages/shared/src/validators/tenantVariables.test.ts apps/api/src/services/tenantVariables.ts apps/api/src/services/tenantVariables.test.ts
git commit -m "feat(api,shared): AAD-bound secret envelope codec and 4-char secret floor (#3409 PR4a)"
```

---

### Task 3: Wire the envelope into the payload registry, reserve the command id, thread the device id

**Files:**
- Modify: `apps/api/src/services/sensitiveCommandPayload.ts`
- Modify: `apps/api/src/services/commandQueue.ts`
- Modify: `apps/api/src/services/commandDelivery.ts`
- Modify: `apps/api/src/services/scriptDispatch.ts`
- Test: `apps/api/src/services/sensitiveCommandPayload.test.ts`, `apps/api/src/services/scriptDispatch.test.ts`

**Interfaces:**
- Consumes: `sealSecretEnv`, `openSecretEnv`, `SecretPayloadContext`, `SCRIPT_SECRET_ENVELOPE_FIELD`, `SCRIPT_SECRET_ENV_FIELD` (Task 2).
- Produces:
  - `encryptSensitivePayloadFields(type, payload, ctx?: SecretPayloadContext)`
  - `decryptSensitivePayloadFields(type, payload, ctx?: SecretPayloadContext)`
  - `type DeliverableCommand = { id: string; type: string; deviceId: string; payload: unknown }`
  - `queueCommand(deviceId, type, payload, userId?, options?: { commandId?: string })`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/sensitiveCommandPayload.test.ts`:

```ts
describe('script secret envelope in the payload registry', () => {
  const ctx = {
    commandId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  };

  it('replaces secretEnv with a sealed secretEnvEnvelope on encrypt', () => {
    const out = encryptSensitivePayloadFields(
      'script',
      { scriptId: 's', secretEnv: { api_token: 'super-secret-value' } },
      ctx,
    );
    expect(out.secretEnv).toBeUndefined();
    expect(String(out.secretEnvEnvelope).startsWith('enc:v3:')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('super-secret-value');
  });

  it('restores secretEnv from the envelope on decrypt', () => {
    const sealed = encryptSensitivePayloadFields(
      'script',
      { scriptId: 's', secretEnv: { api_token: 'super-secret-value' } },
      ctx,
    );
    const opened = decryptSensitivePayloadFields('script', sealed, ctx) as Record<string, unknown>;
    expect(opened.secretEnv).toEqual({ api_token: 'super-secret-value' });
    expect(opened.secretEnvEnvelope).toBeUndefined();
  });

  it('is a pure passthrough for a script payload with no secrets', () => {
    const payload = { scriptId: 's', content: 'echo hi' };
    expect(encryptSensitivePayloadFields('script', payload, ctx)).toEqual(payload);
    expect(decryptSensitivePayloadFields('script', payload, ctx)).toEqual(payload);
  });

  it('throws rather than shipping plaintext when no context is supplied', () => {
    expect(() =>
      encryptSensitivePayloadFields('script', { secretEnv: { api_token: 'super-secret-value' } }),
    ).toThrow();
  });

  it('drops the command (returns null) when the envelope will not open', () => {
    const sealed = encryptSensitivePayloadFields(
      'script',
      { secretEnv: { api_token: 'super-secret-value' } },
      ctx,
    );
    const wrongDevice = { ...ctx, deviceId: '33333333-3333-4333-8333-333333333333' };
    expect(
      decryptCommandForDelivery({
        id: wrongDevice.commandId,
        type: 'script',
        deviceId: wrongDevice.deviceId,
        payload: sealed,
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- src/services/sensitiveCommandPayload.test.ts`
Expected: FAIL — extra argument not accepted; `secretEnv` passes through untouched.

- [ ] **Step 3: Implement in `sensitiveCommandPayload.ts`**

Extend the two transform functions and the deliverable type. The pre-existing field-level path (`encryption_rotate_key`) is unchanged; the envelope is a second, separate mechanism keyed on command type `script`:

```ts
const ENVELOPE_COMMAND_TYPES = new Set(['script']);

export function encryptSensitivePayloadFields(
  type: string,
  payload: Record<string, unknown>,
  ctx?: SecretPayloadContext,
): Record<string, unknown> {
  let out: Record<string, unknown> = { ...payload };

  const fields = SENSITIVE_PAYLOAD_FIELDS[type];
  if (fields) {
    for (const field of fields) {
      const value = out[field];
      if (typeof value === 'string' && value) {
        out[field] = encryptSecret(value, { aad: AAD });
      }
    }
  }

  if (ENVELOPE_COMMAND_TYPES.has(type) && out[SCRIPT_SECRET_ENV_FIELD] !== undefined) {
    // Throwing (rather than passing the map through) is the whole point: a
    // caller that forgets the context must FAIL, not silently enqueue
    // plaintext credentials into a system-scoped, unbounded-retention table.
    if (!ctx) {
      throw new Error(
        '[sensitiveCommandPayload] script secretEnv requires an encryption context (commandId, deviceId)',
      );
    }
    const secretEnv = out[SCRIPT_SECRET_ENV_FIELD] as Record<string, string>;
    delete out[SCRIPT_SECRET_ENV_FIELD];
    out[SCRIPT_SECRET_ENVELOPE_FIELD] = sealSecretEnv(secretEnv, ctx);
  }

  return out;
}
```

`decryptSensitivePayloadFields` mirrors it: when `out[SCRIPT_SECRET_ENVELOPE_FIELD]` is a non-empty string, require `ctx`, `openSecretEnv`, `delete` the envelope field, and set `out[SCRIPT_SECRET_ENV_FIELD]`. A missing `ctx` on the decrypt side also throws — `decryptCommandForDelivery` already converts a throw into a dropped command plus a Sentry capture, which is the correct fail-closed behavior.

Then widen the delivery type and pass the context through:

```ts
export type DeliverableCommand = { id: string; type: string; deviceId: string; payload: unknown };

export function decryptCommandForDelivery(cmd: DeliverableCommand): DeliverableCommand | null {
  try {
    return {
      id: cmd.id,
      type: cmd.type,
      deviceId: cmd.deviceId,
      payload: decryptSensitivePayloadFields(cmd.type, cmd.payload, {
        commandId: cmd.id,
        deviceId: cmd.deviceId,
      }),
    };
  } catch (err) { /* unchanged: log + captureException + return null */ }
}
```

Update the module's leading comment block: it currently claims the result route clears the payload on terminal, which Task 1 generalized to every terminal writer.

- [ ] **Step 4: Fix the four `decryptCommandForDelivery` call sites**

TypeScript will name them. All four already have the device id in scope:

- `services/commandQueue.ts` (×2) — the `deviceId` parameter.
- `services/scriptDispatch.ts` — `device.id`.
- `services/commandDelivery.ts` — add `deviceId` to `ClaimedCommand` if it isn't already selected, and map it through in `decryptClaimedCommandsForDelivery`. Its three callers (`routes/agents/commands.ts`, `routes/agents/heartbeat.ts` ×2) claim per-device, so the id is available; prefer reading it off the claimed row over threading a new parameter.

The `sendCommandToAgent(...)` casts at those sites currently assert `{ id, type, payload }` — widen or drop the cast so the extra field is not accidentally forwarded onto the wire. **The agent must not receive `deviceId` in the command frame if it does not today**; strip it at the send boundary.

- [ ] **Step 5: Reserve the command id in `queueCommand`**

The AAD binds the command id, but `encryptSensitivePayloadFields` runs *before* the insert. Let the caller supply the id:

```ts
export async function queueCommand(
  deviceId: string,
  type: CommandType | string,
  payload: CommandPayload = {},
  userId?: string,
  options: { commandId?: string } = {},
): Promise<QueuedCommand> {
  const [command] = await db
    .insert(deviceCommands)
    .values({
      ...(options.commandId ? { id: options.commandId } : {}),
      deviceId,
      type,
      payload,
      status: 'pending',
      createdBy: userId || null,
    })
    .returning();
```

`device_commands.id` is `uuid ... defaultRandom()`, so omitting it keeps today's behavior for every other caller.

- [ ] **Step 6: Use it in `scriptDispatch.ts`**

In the guarded payload-build region, before `encryptSensitivePayloadFields`:

```ts
    // #3409 PR4a: the secret envelope's AAD binds the command id, so the id
    // must exist BEFORE encryption. Reserving it here (rather than reading it
    // back from the insert) keeps encryption inside the existing guarded
    // region, so a seal failure still discards the pending execution row.
    const reservedCommandId = randomUUID();
    payload = encryptSensitivePayloadFields(
      'script',
      { /* unchanged payload object */ },
      { commandId: reservedCommandId, deviceId: device.id },
    );
    stage = 'queueCommand';
    command = await queueCommand(device.id, 'script', payload, input.createdBy ?? undefined, {
      commandId: reservedCommandId,
    });
```

Import `randomUUID` from `node:crypto`. Replace the existing PR4 no-op comment above the call with a note that the seam is now live but no caller populates `secretEnv` until PR4c.

Pass `deviceId: device.id` at the `decryptCommandForDelivery` call further down.

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @breeze/api test -- src/services/sensitiveCommandPayload.test.ts src/services/scriptDispatch.test.ts src/services/commandQueue.test.ts src/services/commandDelivery.test.ts`
Expected: PASS. `scriptDispatch.test.ts` assertions that pin the enqueued payload shape must still pass unchanged — that is the proof this PR is inert.

- [ ] **Step 8: Commit**

```bash
git add -A apps/api/src
git commit -m "feat(api): seal script secretEnv into an AAD-bound envelope at dispatch (#3409 PR4a)

Reserves the command UUID before encryption so the AAD can bind command id and
device id, and threads deviceId through every just-in-time decrypt site. No
caller populates secretEnv yet — secrets remain blocked at save and dispatch."
```

---

### Task 4: Agent capability storage

An agent that ignores `secretEnv` runs the script with the credential env var **unset** — anonymous access, auth fallback, lockouts, or destructive operations against the wrong target. The gate must be an explicit capability version, not a semver comparison, and it must be **non-sticky** so a downgrade is detected. PR4a only *stores* the capability; PR4c gates on it.

**Files:**
- Create: `apps/api/migrations/2026-08-22-device-script-secret-env-capability.sql`
- Modify: `apps/api/src/db/schema/devices.ts`
- Modify: `apps/api/src/routes/agents/schemas.ts`
- Modify: `apps/api/src/routes/agents/heartbeat.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Test: `apps/api/src/routes/agents/heartbeat.test.ts`

**Interfaces:**
- Produces: `devices.scriptSecretEnvVersion: number` (0 = incapable), and `heartbeat.securityCapabilities.scriptSecretEnvVersion`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/agents/heartbeat.test.ts`, mirroring the existing `outboundNetworkPolicyVersion` cases (copy those and adapt — do not invent a new harness):

```ts
it('records scriptSecretEnvVersion 1 from a capable agent', async () => {
  await postHeartbeat({ securityCapabilities: { scriptSecretEnvVersion: 1 } });
  expect(lastDeviceUpdate()).toMatchObject({ scriptSecretEnvVersion: 1 });
});

it('records 0 when the agent omits the capability (old build)', async () => {
  await postHeartbeat({});
  expect(lastDeviceUpdate()).toMatchObject({ scriptSecretEnvVersion: 0 });
});

it('reports back down to 0 on a downgrade (non-sticky)', async () => {
  await postHeartbeat({ securityCapabilities: { scriptSecretEnvVersion: 1 } });
  await postHeartbeat({ securityCapabilities: {} });
  expect(lastDeviceUpdate()).toMatchObject({ scriptSecretEnvVersion: 0 });
});

it('records 0 for any unrecognized version', async () => {
  await postHeartbeat({ securityCapabilities: { scriptSecretEnvVersion: 99 } });
  expect(lastDeviceUpdate()).toMatchObject({ scriptSecretEnvVersion: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- src/routes/agents/heartbeat.test.ts`
Expected: FAIL — `scriptSecretEnvVersion` is not in the update set.

- [ ] **Step 3: Migration**

Create `apps/api/migrations/2026-08-22-device-script-secret-env-capability.sql`:

```sql
-- #3409 PR4a — agent capability handshake for encrypted secret-env delivery.
-- 0 = agent does not understand `secretEnv` (old build, or a downgrade). The
-- dispatch gate (PR4c) refuses to send a secret-bearing script to a 0 device
-- rather than letting it run with the credential unset. Written unconditionally
-- on every heartbeat (non-sticky), so a downgrade self-heals back to 0.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS script_secret_env_version integer NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Schema, zod, heartbeat write**

`apps/api/src/db/schema/devices.ts`, immediately after `outboundNetworkPolicyVersion`:

```ts
  // #3409 PR4 — agent capability for encrypted secret-env delivery. 0 for
  // every agent build that predates PR4b and for any heartbeat omitting the
  // field. Only the recognized integer version 1 is written as anything other
  // than 0. Non-sticky, so a downgrade reports back down and the PR4c dispatch
  // gate stops trusting a stale claim.
  scriptSecretEnvVersion: integer('script_secret_env_version').notNull().default(0),
```

`apps/api/src/routes/agents/schemas.ts`, inside the existing `securityCapabilities` object:

```ts
    scriptSecretEnvVersion: z.number().int().optional().catch(undefined),
```

`apps/api/src/routes/agents/heartbeat.ts`, inside `deviceUpdates` beside `outboundNetworkPolicyVersion`:

```ts
    // #3409 PR4 — same non-sticky contract as outboundNetworkPolicyVersion
    // above: written every beat so a downgrade is detected. PR4c re-checks
    // this at CLAIM time too, since an offline-queued command can be claimed
    // after a downgrade.
    scriptSecretEnvVersion: data.securityCapabilities?.scriptSecretEnvVersion === 1 ? 1 : 0,
```

- [ ] **Step 5: Register the column in the export policy**

`apps/api/src/services/tenantExportPolicyRegistry.ts` classifies **every column** of every org-cascade table; `devices` is registered, so this `ADD COLUMN` breaks `tenant-export-policy.integration.test.ts` until the column is classified. Add `scriptSecretEnvVersion` to the `included` group for `devices` — it is a monotonic capability counter, not credential material, and its name does not match `SUSPICIOUS_NAME_PARTS`.

No other list changes: `devices` is already in `CORE_ORG_CASCADE_DELETE_ORDER`, and this is a column, not a new table.

- [ ] **Step 6: Run tests and drift check**

```bash
pnpm --filter @breeze/api test -- src/routes/agents/heartbeat.test.ts
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```
Expected: heartbeat tests PASS; drift check reports no drift.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations apps/api/src/db/schema/devices.ts apps/api/src/routes/agents apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): store the agent scriptSecretEnv capability version (#3409 PR4a)"
```

---

### Task 5: Exact-value redactor

The existing `secretRedaction.ts` is **name-based**: it fires only when a secret sits next to a recognized key name (`token=...`). A script that echoes a bare credential on its own line survives it entirely. This task adds the value-based layer. It is a pure function with no I/O.

**Files:**
- Create: `apps/api/src/services/exactSecretRedaction.ts`
- Create: `apps/api/src/services/exactSecretRedaction.test.ts`

**Interfaces:**
- Produces: `EXACT_REDACTION_MARKER = '[REDACTED]'`, `buildExactValueRedactor(values: readonly string[]): (text: string) => string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildExactValueRedactor, EXACT_REDACTION_MARKER } from './exactSecretRedaction';

describe('buildExactValueRedactor', () => {
  it('replaces every occurrence with a generic marker', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    expect(redact('token=hunter2000 and again hunter2000')).toBe(
      `token=${EXACT_REDACTION_MARKER} and again ${EXACT_REDACTION_MARKER}`,
    );
  });

  it('never names the variable it redacted', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    expect(redact('hunter2000')).toBe(EXACT_REDACTION_MARKER);
  });

  it('treats values as literals, not patterns', () => {
    const redact = buildExactValueRedactor(['a.c*d']);
    expect(redact('abcd a.c*d')).toBe(`abcd ${EXACT_REDACTION_MARKER}`);
  });

  it('merges overlapping matches into a single marker', () => {
    // "abcabc" contains "abcabc", "abca", "bcabc" ... a naive longest-first
    // pass would rescan its own marker and emit nested markers.
    const redact = buildExactValueRedactor(['abcabc', 'bcab']);
    expect(redact('xxabcabcxx')).toBe(`xx${EXACT_REDACTION_MARKER}xx`);
  });

  it('does not rescan its own marker', () => {
    const redact = buildExactValueRedactor(['secret', 'REDACTED']);
    expect(redact('secret')).toBe(EXACT_REDACTION_MARKER);
  });

  it('is idempotent', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    const once = redact('x hunter2000 y');
    expect(redact(once)).toBe(once);
  });

  it('dedupes identical values', () => {
    const redact = buildExactValueRedactor(['same', 'same']);
    expect(redact('same')).toBe(EXACT_REDACTION_MARKER);
  });

  it('ignores empty and sub-floor values rather than shredding the output', () => {
    const redact = buildExactValueRedactor(['', 'ab']);
    expect(redact('ab and an empty  gap')).toBe('ab and an empty  gap');
  });

  it('is a passthrough when there is nothing to redact', () => {
    expect(buildExactValueRedactor([])('anything')).toBe('anything');
  });

  it('handles a large output without quadratic blowup', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    const text = `${'x'.repeat(500_000)}hunter2000${'y'.repeat(500_000)}`;
    const started = Date.now();
    expect(redact(text)).toContain(EXACT_REDACTION_MARKER);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- src/services/exactSecretRedaction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `exactSecretRedaction.ts`**

```ts
import { MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH } from '@breeze/shared';

/**
 * Deliberately generic. A marker naming the variable key would CONFIRM which
 * credential the script emitted, to an audience (`scripts:read`) wider than
 * the script's author — the leak this exists to prevent, minus the characters.
 */
export const EXACT_REDACTION_MARKER = '[REDACTED]';

/**
 * Build a redactor that removes every literal occurrence of the supplied
 * secret values from a text.
 *
 * Honest scope: this is ACCIDENTAL-LEAK protection, not DLP. It removes a
 * credential a script echoed, logged, or included in an error. It cannot catch
 * a value the script transformed, base64-encoded, hashed, reversed, or printed
 * one character per line. Treat it as a safety net over careless output, never
 * as a control against a hostile script author — who already holds the
 * credential by definition.
 *
 * Algorithm: collect ALL match ranges of ALL values against the ORIGINAL text,
 * merge overlaps, then rebuild the string in one pass. The naive alternative
 * (`String.replaceAll` per value, longest first) rescans text it has already
 * rewritten, so a value overlapping a previous match produces nested markers
 * and, worse, a value that happens to occur inside `[REDACTED]` re-fires.
 */
export function buildExactValueRedactor(
  values: readonly string[],
): (text: string) => string {
  const needles = [
    ...new Set(
      values.filter(
        (v) => typeof v === 'string' && v.length >= MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH,
      ),
    ),
  ];
  if (needles.length === 0) return (text) => text;

  return (text: string): string => {
    if (!text) return text;

    const ranges: Array<[number, number]> = [];
    for (const needle of needles) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(needle, from);
        if (at === -1) break;
        ranges.push([at, at + needle.length]);
        // Advance by one so overlapping self-occurrences are all found; the
        // merge below collapses them.
        from = at + 1;
      }
    }
    if (ranges.length === 0) return text;

    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of ranges) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) {
        if (end > last[1]) last[1] = end;
      } else {
        merged.push([start, end]);
      }
    }

    let out = '';
    let cursor = 0;
    for (const [start, end] of merged) {
      out += text.slice(cursor, start) + EXACT_REDACTION_MARKER;
      cursor = end;
    }
    return out + text.slice(cursor);
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test -- src/services/exactSecretRedaction.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/exactSecretRedaction.ts apps/api/src/services/exactSecretRedaction.test.ts
git commit -m "feat(api): exact-value output redactor with overlap merging (#3409 PR4a)"
```

---

### Task 6: Redact agent output against the command's own secrets

**Files:**
- Create: `apps/api/src/services/commandSecretRedaction.ts`
- Create: `apps/api/src/services/commandSecretRedaction.test.ts`
- Modify: `apps/api/src/routes/agentWs.ts`
- Modify: `apps/api/src/routes/agents/commands.ts`

**Interfaces:**
- Consumes: `openSecretEnv`, `SCRIPT_SECRET_ENVELOPE_FIELD` (Task 2); `buildExactValueRedactor` (Task 5).
- Produces:
  ```ts
  export const OUTPUT_VERIFICATION_FAILED_MARKER = '[OUTPUT_REDACTED:VERIFICATION_FAILED]';
  export function redactResultAgainstCommandSecrets<R extends {
    stdout?: string | null; stderr?: string | null; error?: string | null;
  }>(
    command: { id: string; type: string; deviceId: string; payload: unknown },
    result: R,
    stdout: string | null | undefined,
  ): { result: R; stdout: string | null | undefined };
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { encryptSensitivePayloadFields } from './sensitiveCommandPayload';
import {
  redactResultAgainstCommandSecrets,
  OUTPUT_VERIFICATION_FAILED_MARKER,
} from './commandSecretRedaction';
import { EXACT_REDACTION_MARKER } from './exactSecretRedaction';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY_ID = 'test';
  process.env.APP_ENCRYPTION_KEYS = JSON.stringify({ test: 'a'.repeat(64) });
});

function sealedCommand(secretEnv: Record<string, string>) {
  return {
    id: COMMAND_ID,
    type: 'script',
    deviceId: DEVICE_ID,
    payload: encryptSensitivePayloadFields('script', { scriptId: 's', secretEnv }, {
      commandId: COMMAND_ID, deviceId: DEVICE_ID,
    }),
  };
}

describe('redactResultAgainstCommandSecrets', () => {
  it('redacts stdout, stderr AND error', () => {
    const out = redactResultAgainstCommandSecrets(
      sealedCommand({ api_token: 'hunter2000' }),
      { stdout: 'a hunter2000', stderr: 'b hunter2000', error: 'c hunter2000' },
      'a hunter2000',
    );
    expect(out.result.stdout).toBe(`a ${EXACT_REDACTION_MARKER}`);
    expect(out.result.stderr).toBe(`b ${EXACT_REDACTION_MARKER}`);
    expect(out.result.error).toBe(`c ${EXACT_REDACTION_MARKER}`);
    expect(out.stdout).toBe(`a ${EXACT_REDACTION_MARKER}`);
  });

  it('is an identity passthrough for a command with no envelope', () => {
    const result = { stdout: 'hunter2000', stderr: null, error: null };
    const out = redactResultAgainstCommandSecrets(
      { id: COMMAND_ID, type: 'script', deviceId: DEVICE_ID, payload: { scriptId: 's' } },
      result,
      'hunter2000',
    );
    expect(out.result).toBe(result);
    expect(out.stdout).toBe('hunter2000');
  });

  it('fails closed when the envelope will not open', () => {
    const cmd = sealedCommand({ api_token: 'hunter2000' });
    const tampered = { ...cmd, deviceId: '33333333-3333-4333-8333-333333333333' };
    const out = redactResultAgainstCommandSecrets(
      tampered,
      { stdout: 'hunter2000', stderr: 'x', error: 'y' },
      'hunter2000',
    );
    expect(out.result.stdout).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
    expect(out.result.stderr).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
    expect(out.result.error).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
    expect(out.stdout).toBe(OUTPUT_VERIFICATION_FAILED_MARKER);
  });

  it('preserves null output fields as null on the happy path', () => {
    const out = redactResultAgainstCommandSecrets(
      sealedCommand({ api_token: 'hunter2000' }),
      { stdout: null, stderr: null, error: null },
      null,
    );
    expect(out.result.stderr).toBeNull();
    expect(out.result.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test -- src/services/commandSecretRedaction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commandSecretRedaction.ts`**

```ts
import { captureException } from './sentry';
import { buildExactValueRedactor } from './exactSecretRedaction';
import { SCRIPT_SECRET_ENVELOPE_FIELD, openSecretEnv } from './scriptSecretEnvelope';

/**
 * Replaces ALL output when the server cannot verify what the agent sent
 * against the secrets the command carried. Status and exit code survive — the
 * operator still learns whether the script succeeded — but unverifiable text
 * is never persisted, because it may contain a credential we no longer have
 * the means to find.
 */
export const OUTPUT_VERIFICATION_FAILED_MARKER = '[OUTPUT_REDACTED:VERIFICATION_FAILED]';

/**
 * Redact a command result against the secret values THAT COMMAND carried.
 *
 * Called at both agent-result ingest chokepoints, after normalization and
 * BEFORE anything is persisted (`device_commands.result` and, downstream,
 * `script_executions.stdout/stderr/error_message`). The envelope is opened for
 * this single purpose and the plaintext values never leave this function.
 *
 * The exact-value layer runs FIRST; the pre-existing name-based heuristic
 * (`redactSecretsFromOutput`) still runs at its established sites afterwards.
 * Both are idempotent, so the double pass costs nothing.
 */
export function redactResultAgainstCommandSecrets<
  R extends { stdout?: string | null; stderr?: string | null; error?: string | null },
>(
  command: { id: string; type: string; deviceId: string; payload: unknown },
  result: R,
  stdout: string | null | undefined,
): { result: R; stdout: string | null | undefined } {
  const payload = command.payload;
  const envelope =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)[SCRIPT_SECRET_ENVELOPE_FIELD]
      : undefined;
  if (typeof envelope !== 'string' || !envelope) {
    return { result, stdout };
  }

  let values: string[];
  try {
    values = Object.values(openSecretEnv(envelope, { commandId: command.id, deviceId: command.deviceId }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[commandSecretRedaction] could not open the secret envelope for a completed command; discarding its output',
      { commandId: command.id, deviceId: command.deviceId, error: message },
    );
    captureException(
      new Error(
        `[commandSecretRedaction] envelope open failed after execution (commandId=${command.id}): ${message}`,
      ),
    );
    return {
      result: {
        ...result,
        stdout: OUTPUT_VERIFICATION_FAILED_MARKER,
        stderr: OUTPUT_VERIFICATION_FAILED_MARKER,
        error: OUTPUT_VERIFICATION_FAILED_MARKER,
      },
      stdout: OUTPUT_VERIFICATION_FAILED_MARKER,
    };
  }

  const redact = buildExactValueRedactor(values);
  const apply = <T extends string | null | undefined>(text: T): T =>
    (text != null ? redact(text) : text) as T;

  return {
    result: { ...result, stdout: apply(result.stdout), stderr: apply(result.stderr), error: apply(result.error) },
    stdout: apply(stdout),
  };
}
```

- [ ] **Step 4: Wire the WS chokepoint**

In `apps/api/src/routes/agentWs.ts`, immediately after the `normalizeCriticalResultIfNeeded` destructuring and **before** the terminal CAS update, replace the destructured bindings with redacted ones:

```ts
    const {
      normalizedResult: rawNormalizedResult,
      stdout: rawStdout,
      validationError,
    } = normalizeCriticalResultIfNeeded(command.type, result);

    // #3409 PR4a: exact-value redaction against the secrets THIS command
    // carried, before either device_commands.result or (downstream, via the
    // per-type handlers) script_executions is written. The name-based
    // heuristic redaction already applied at the top of this function stays —
    // it catches secrets this command never carried. Inert until PR4c: no
    // command has an envelope yet.
    const { result: normalizedResult, stdout } = redactResultAgainstCommandSecrets(
      { id: command.id, type: command.type, deviceId: resolvedDeviceId, payload: command.payload },
      rawNormalizedResult,
      rawStdout,
    );
```

`normalizedResult` and `stdout` keep their existing names, so the CAS write and handler dispatch below are unchanged. Confirm nothing between the destructuring and the CAS reads `rawNormalizedResult`.

- [ ] **Step 5: Wire the REST chokepoint**

In `apps/api/src/routes/agents/commands.ts`, the same shape: the file already renames to `rawNormalizedData` / `normalizedData` for the `#2434` heuristic pass. Add the exact-value pass after it:

```ts
    const heuristicallyRedacted = redactAgentResultErrorFields(rawNormalizedData);
    // #3409 PR4a — REST twin of the WS exact-value pass.
    const { result: normalizedData, stdout: redactedStdout } = redactResultAgainstCommandSecrets(
      { id: commandId, type: command.type, deviceId, payload: command.payload },
      heuristicallyRedacted,
      stdout,
    );
```

Then use `redactedStdout` in place of `stdout` at the `buildStoredCommandResult(...)` call and at every downstream handler dispatch in this function. Grep the remainder of the function for `stdout` and confirm each use is the redacted binding — shadowing the original with `const stdout = redactedStdout` is acceptable if the original binding is `let`-free.

Confirm both files still have `command.payload` in scope at these points — both load the full `deviceCommands` row.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @breeze/api test -- src/services/commandSecretRedaction.test.ts src/routes/agentWs.test.ts src/routes/agents/commands.test.ts src/services/commandResultHandlers.test.ts
```
Expected: PASS, with no changes to existing assertions — a command with no envelope must produce byte-identical persisted output.

**Mutation-verify:** change `redactResultAgainstCommandSecrets` to return `{ result, stdout }` unconditionally; confirm only `commandSecretRedaction.test.ts` fails. Restore.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src
git commit -m "feat(api): redact agent output against the command's own secret values (#3409 PR4a)

Adds a value-based redaction layer at both result-ingest chokepoints. The
existing redaction is name-based and only fires when a secret sits beside a
recognized key name; a bare echoed credential survives it. Fails closed to
[OUTPUT_REDACTED:VERIFICATION_FAILED] when the envelope cannot be opened."
```

---

### Task 7: Full-suite verification and PR

- [ ] **Step 1: Rebase onto current main FIRST, not after CI is green**

```bash
git fetch origin main
git rebase origin/main
```

This ordering caught a namespace break in PR1 that would have gone green on the PR and reddened main.

- [ ] **Step 2: Typecheck and the FULL API suite**

```bash
pnpm --filter @breeze/api build
pnpm --filter @breeze/api test
pnpm --filter @breeze/shared test
```

Do **not** pipe through `tail` — you lose progress and cannot tell slow from wedged. PR3's per-task runs were all green while the full suite had 5 failures in an untouched file.

- [ ] **Step 3: Contract suites (a migration and a schema column changed)**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
pnpm --filter @breeze/api test:integration -- tenant-export-policy tenantCascade tenantExportErasureRoundtrip rls-coverage
```

`pnpm test` does not run these. The export-policy suite is the one that fires on the new `devices` column.

- [ ] **Step 4: Prove the PR is inert**

Confirm by grep that no production code path constructs a `secretEnv`:

```bash
grep -rn "secretEnv" apps/api/src --include='*.ts' | grep -v '\.test\.' | grep -vE "scriptSecretEnvelope|sensitiveCommandPayload|commandSecretRedaction"
```
Expected: no hits that assign a value into a dispatch payload. Also confirm the save/dispatch blocks on secrets from PR1–PR3 are untouched.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin ToddHebebrand/tenant-variables-pr4
gh pr create --base main --title "feat(api): secret delivery machinery, inert (#3409 PR4a)" --body "..."
```

The body must state, in the first paragraph, that **no secret reaches the wire in this PR** — secrets stay blocked at script save and at dispatch — and that 4b (agent) and 4c (activation) follow, with the fleet needing upgrade time between them.

Since this PR targets `main`, CI including the blocking `integration-test` job runs automatically. Do not hand-dispatch.

---

## Deferred to 4b / 4c — do not build here

| Item | PR |
|---|---|
| Agent decode of `secretEnv`, `BREEZE_VAR_*` injection, `runAs:'user'` block, agent-side redaction of stdout/stderr/**error** on local + helper paths, capability advertisement | 4b |
| Unblocking secrets at script save/import and at dispatch | 4c |
| Capability gate at **enqueue and at claim** | 4c |
| Digest pinning of variable references + canonicalized parameter definitions; drift-fails-approval | 4c |
| `result.Error` sanitization at the 8 agent sites | 4b |

## Also open (tracked elsewhere, not this PR)

- 0.106.0 release notes — 8 items across PR1–PR3, two of which will read as regressions if unannounced (`normalizeAutomationActions` re-validating stored actions; required `runtime` parameters now enforced server-side).
- The `encryption_rotate_key` retention leak deserves its own issue even though Task 1 fixes it here — it predates this initiative and stands on its own merits.
- PR3 follow-ups: automation parameter-capture UI, `aiToolsScripts` not surfacing `ignoredParameters`, `deviceCustomField` free-text binding.
