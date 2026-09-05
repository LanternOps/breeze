# RMM-QA-166 — Admin MFA Reset and User Neutralization Revoke Passkeys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every "this user's second factor is gone" operation (admin `POST /users/:id/mfa/reset`, last-membership neutralization, tombstone re-invite, access-review revocation) actually strip every factor — TOTP, SMS/phone, recovery codes, pending setup artifacts, and **`user_passkeys` rows** — through one in-transaction factor-reset service, so a reset user is no longer "protected" by a lost passkey, can re-enroll password-only, and the admin can reset a passkey-only leftover.

**Architecture:** A new `services/mfaFactorReset.ts` owns the factor write (`resetAllFactors(tx, userId)`: system-context guard → inventory snapshot → `UPDATE users` → `DELETE user_passkeys … RETURNING`) and an admin composite (`resetAllFactorsAndInvalidate(userId, reason)`) that folds it into the unchanged `invalidateMfaAssuranceAfterFactorChange` primitive under system context and sweeps the per-user Redis keys post-commit. `neutralizeUserIfOrphaned` moves to `services/userNeutralization.ts`, gains the factor reset, and is called by both `DELETE /users/:id` and access-review completion after the caller has advanced `{auth, mfa}` epochs and revoked families. The reset route gates on `userIsMfaProtected` instead of `users.mfa_enabled`; `GET /users` exposes `mfaProtected`; the web Reset MFA button keys on it.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Postgres (RLS as `breeze_app`), Redis (ioredis), Vitest (unit + real-Postgres integration), React + Testing Library (web), otplib (integration TOTP generation).

**Spec:** `docs/superpowers/specs/2026-09-01-rmm-qa-166-mfa-reset-revokes-passkeys-design.md` (same worktree). The plan argues from the spec's decisions D1–D12 and its §8 RED list; read both. Verified brief: `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/RMM-QA-166.brief.json`; exit-evidence contract: `…/scratchpad/s1/RMM-QA-166.row.md`.

## Global Constraints

- **Worktree (the ONLY tree you touch):** `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-166` — a git worktree of `/Users/toddhebebrand/breeze`. Never `cd` into or edit any other worktree; never push to `main`; never merge. All paths below are relative to this worktree root unless absolute.
- **Branch:** `fix/rmm-qa-166-mfa-reset-revokes-passkeys`, based on `origin/main @ fcd5b498a`. If the worktree is absent: `git -C /Users/toddhebebrand/breeze fetch origin main && git -C /Users/toddhebebrand/breeze worktree add -b fix/rmm-qa-166-mfa-reset-revokes-passkeys <worktree path> origin/main` (drop `-b` if the branch already exists).
- **Rigor: HIGH** (auth + rls-tenancy). Every behavior change is RED-first: write the test, run it, save the failing output to `<scratchpad>/rmm-qa-166-red/<test-id>.txt` where `<scratchpad>` = `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad`, and paste the salient failing lines (test name + assertion/error line) into the commit message under `RED (before):`. Every test control is mutation-proven: apply the named mutation, run, watch it fail, revert with `git checkout -- <file>`, re-run green, and record the mutation + observed failure under `Mutation control:` in the same commit message.
- **Install once, first:** `pnpm install --frozen-lockfile` at the worktree root (no `node_modules` exist in a fresh worktree). Node is pinned (`.nvmrc` 22.23.2).
- **Typecheck gate (API):** `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit`
- **Unit tests (API):** `pnpm --filter @breeze/api exec vitest run <paths>` — list files explicitly; never insert `--` before flags; vitest path filters are substring matches (see CLAUDE.md "Two traps").
- **Web tests:** `pnpm --filter @breeze/web exec vitest run <paths>`; web lint: `pnpm --filter @breeze/web exec eslint <files>`; web typecheck: `pnpm --filter @breeze/web exec tsc --noEmit`.
- **Integration tests (real Postgres as `breeze_app` + real Redis):** from the worktree root, `pnpm test-stack up` (private per-worktree stack; writes a worktree-local `.env.test`) → `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <paths>` → `pnpm test-stack down` when the plan is done. **Never** `pnpm --filter @breeze/api test:docker:up` (shared ports collide with other worktrees). New integration files go under `apps/api/src/__tests__/integration/` — the config's glob already includes them; do not edit `vitest.integration.config.ts`.
- **Migrations:** none are added by this plan (spec D10). If a migration is ever added, `bash scripts/check-migration-naming.sh --staged` and `pnpm --filter @breeze/api check:migrations` become mandatory gates, and never edit a shipped migration.
- **Commit trailer (every commit, verbatim, last two lines):**
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu
  ```
- **Codex (only if used, read-only analysis):** `codex exec "..." -s read-only -m gpt-5.6-sol -C <dir> < /dev/null`.
- **Do not edit** `docs/qa/probes/` in the QA repo (none exist for this finding), and do not edit anything outside the files named in each task.
- **Copy/strings kept verbatim:** the reset route's 400 message stays `MFA is not enabled for this user`; audit action stays `user.mfa_reset`; reasons are `admin-mfa-reset`, `membership-removed`, `invite-resurrect`; web label key `userList.actions.resetMfa` ("Reset MFA") is unchanged.
- **Non-goals (do not implement):** self-service `/auth/mfa/disable` or `DELETE /auth/passkeys/:id` changes; any change to `invalidateMfaAssuranceAfterFactorChange`; RLS policy changes; remote-session teardown on membership removal; data backfill.

## File map

| File | Responsibility |
|---|---|
| `apps/api/src/services/mfaFactorReset.ts` (new) | `resetAllFactors`, `resetAllFactorsAndInvalidate`, `sweepPendingFactorArtifacts`, `pendingFactorArtifactKeys`, `MfaFactorResetContextError`, types |
| `apps/api/src/services/mfaFactorReset.test.ts` (new) | unit: guard, zero-row, ordering, inventory, composite order + sweep, sweep never throws |
| `apps/api/src/services/userNeutralization.ts` (new) | `neutralizeUserIfOrphaned` (moved) + factor reset |
| `apps/api/src/services/userNeutralization.test.ts` (new) | unit: short-circuits, neutralize + reset order, return shape |
| `apps/api/src/routes/users.ts` | reset route gate/body/audit (D6, D7); membership-removal order (D3); invite pre-flight + phone parity (D9); list `mfaProtected` (D11) |
| `apps/api/src/routes/users.test.ts` | mock surface (D12); U-1..U-8 |
| `apps/api/src/routes/accessReviews.ts` | per-user `{auth,mfa}` → families → neutralize; `neutralizedUserIds` in audit (D5) |
| `apps/api/src/routes/accessReviews.test.ts` | mock surface (D12); U-9, U-10 |
| `apps/api/src/__tests__/integration/adminMfaReset.integration.test.ts` (new) | I-1, I-2 (mocked auth middleware, real route) |
| `apps/api/src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts` (new) | I-3 (REAL auth middleware + JWT; admin reset then password-only TOTP re-enrollment; credential-id reuse) |
| `apps/api/src/__tests__/integration/mfaFactorReset.integration.test.ts` (new) | I-4 (RLS guard), I-5 (atomicity), I-6 (disabled rows deleted too) |
| `apps/api/src/__tests__/integration/userDeleteResurrect.integration.test.ts` | I-7, I-8 appended |
| `apps/web/src/components/settings/UserList.tsx`, `UsersPage.tsx` | `mfaProtected` (D11) |
| `apps/web/src/components/settings/UserList.test.tsx` (new) | W-1..W-3 |

---

### Task 1: Bootstrap the worktree and commit the spec + this plan

**Files:**
- Commit: `docs/superpowers/specs/2026-09-01-rmm-qa-166-mfa-reset-revokes-passkeys-design.md`, `docs/superpowers/plans/2026-09-01-rmm-qa-166-mfa-reset-revokes-passkeys.md`

- [ ] **Step 1: Confirm the worktree and base**

Run:
```bash
WT=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-166
git -C "$WT" status --short && git -C "$WT" branch --show-current && git -C "$WT" log --oneline -1
```
Expected: branch `fix/rmm-qa-166-mfa-reset-revokes-passkeys`, HEAD `fcd5b498a`, only the two untracked docs files (spec + plan). If the worktree is missing, create it with the command in Global Constraints.

- [ ] **Step 2: Install dependencies**

Run (worktree root): `pnpm install --frozen-lockfile`
Expected: exits 0; `node_modules/` present.

- [ ] **Step 3: Baseline the suites this plan touches (must be green before any change)**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts src/routes/accessReviews.test.ts src/services/mfaAssurance.test.ts src/routes/auth/helpers.test.ts
```
Expected: all pass. Save the summary line to `<scratchpad>/rmm-qa-166-red/00-baseline.txt`.

- [ ] **Step 4: Commit docs**

```bash
git add docs/superpowers/specs/2026-09-01-rmm-qa-166-mfa-reset-revokes-passkeys-design.md docs/superpowers/plans/2026-09-01-rmm-qa-166-mfa-reset-revokes-passkeys.md
git commit -m "docs(auth): RMM-QA-166 design spec + executable plan — admin MFA reset revokes passkeys

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 2: Mock-surface commit (D12) — no behavior change

Adds the doubles the later REDs need so each RED fails on its assertion, not on a `TypeError`.

**Files:**
- Modify: `apps/api/src/routes/users.test.ts:118-166` (`../db`, `../db/schema` mocks), `:2004-2036` (`mockRemoveMembershipTx`), `:2137-2158` (`mockFactorChangeTx`), `:167-173` (drizzle-orm mock)
- Modify: `apps/api/src/routes/accessReviews.test.ts:13-53` (`../db`, `../db/schema` mocks), `:436-450` (`mockCompleteTx`)

**Interfaces:**
- Produces: in `users.test.ts` the helpers `mockRemoveMembershipTx({ deletedRows, hasOtherMembership?, passkeyRows?, targetId? })` returning `{ txDelete, txSelect, txUpdate, capturedUpdates, calls }`, and `mockFactorChangeTx({ inventory?, passkeyRows? })` returning `{ capturedUpdates, calls, txDelete }`; in `accessReviews.test.ts` `mockCompleteTx({ hasOtherMembership?, passkeyRows? })` returning `{ txDelete, txUpdate, txSelect, capturedUpdates, capturedDeletes }`.

- [ ] **Step 1: `users.test.ts` — extend the `../db` and `../db/schema` mocks and the drizzle spy**

In the `vi.mock('../db', …)` factory (line 118) add, next to `runOutsideDbContext`:
```ts
  // D12 (RMM-QA-166): the factor-reset service asserts it runs in system
  // context. Default to system so route tests exercise the real service.
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system', orgId: null, accessibleOrgIds: null })),
```
In the `vi.mock('../db/schema', …)` factory (line 151) add:
```ts
  userPasskeys: {
    id: { __column: 'user_passkeys.id' },
    userId: { __column: 'user_passkeys.user_id' },
    credentialId: { __column: 'user_passkeys.credential_id' },
    name: { __column: 'user_passkeys.name' },
    disabledAt: { __column: 'user_passkeys.disabled_at' },
  },
```
In the `vi.mock('drizzle-orm', …)` factory (line 167) add `inArray: vi.fn(actual.inArray),` after `eq: vi.fn(actual.eq),`.

Add to the import block after `import { eq } from 'drizzle-orm';` (line ~276):
```ts
import { inArray } from 'drizzle-orm';
import { users, userPasskeys } from '../db/schema';
import { getRedis } from '../services/redis';
```
(`users`/`userPasskeys` are the mocked schema objects — used for identity routing in tx stubs; `getRedis` is the global unit mock from `src/__tests__/setup.ts`, whose client has `del: vi.fn()`.)

- [ ] **Step 2: `users.test.ts` — reshape `mockRemoveMembershipTx` (DELETE describe, line ~2004)**

Replace the helper body with:
```ts
    function mockRemoveMembershipTx(opts: {
      deletedRows: Array<{ id: string }>;
      hasOtherMembership?: boolean;
      passkeyRows?: Array<{ id: string; credentialId: string; name: string | null }>;
      targetId?: string;
    }) {
      const { deletedRows, hasOtherMembership = true, passkeyRows = [], targetId = 'target' } = opts;
      const capturedUpdates: Array<Record<string, unknown>> = [];
      // Ordered trace of tx operations so tests can assert D3's order.
      const calls: string[] = [];
      const txDelete = vi.fn((table: unknown) => {
        calls.push(table === userPasskeys ? 'delete-passkeys' : 'delete-membership');
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(table === userPasskeys ? passkeyRows : deletedRows)
          })
        };
      });
      // Orphan checks read partnerUsers/organizationUsers; the factor-reset
      // inventory snapshot reads `users` — route by table identity.
      const txSelect = vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              table === users
                ? [{ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc', mfaRecoveryCodes: ['h1'], phoneNumber: '+15550100', phoneVerified: true }]
                : hasOtherMembership ? [{ id: 'other-link' }] : []
            )
          })
        }))
      }));
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          calls.push(
            'authEpoch' in values ? 'epochs'
              : 'revokedReason' in values ? 'families'
              : 'mfaSecret' in values ? 'clear-factors'
              : values.status === 'disabled' ? 'neutralize'
              : 'update'
          );
          return {
            where: () => {
              const ret: any = Promise.resolve(undefined);
              ret.returning = () =>
                'authEpoch' in values
                  ? Promise.resolve([{ authEpoch: 2, mfaEpoch: 2, emailEpoch: 0, passwordResetEpoch: 0 }])
                  : 'mfaSecret' in values
                    ? Promise.resolve([{ id: targetId }])
                    : Promise.resolve([]);
              return ret;
            }
          };
        }
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn: any) =>
        fn({ delete: txDelete, select: txSelect, update: txUpdate })
      );
      return { txDelete, txSelect, txUpdate, capturedUpdates, calls };
    }
```

- [ ] **Step 3: `users.test.ts` — reshape `mockFactorChangeTx` (reset describe, line ~2137)**

Replace with:
```ts
    // tx stub for resetAllFactorsAndInvalidate: advanceUserEpochs({mfa}) sets
    // `mfaEpoch` and RETURNs the epoch row; revokeAllRefreshFamilies sets
    // revoked_at/revoked_reason; resetAllFactors reads the inventory (select),
    // clears users columns (update … returning) and deletes passkeys
    // (delete … returning).
    function mockFactorChangeTx(opts: {
      inventory?: Partial<{ mfaEnabled: boolean; mfaMethod: string | null; mfaSecret: string | null; mfaRecoveryCodes: unknown; phoneNumber: string | null; phoneVerified: boolean }>;
      passkeyRows?: Array<{ id: string; credentialId: string; name: string | null }>;
    } = {}) {
      const inventoryRow = { mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false, ...opts.inventory };
      const passkeyRows = opts.passkeyRows ?? [];
      const capturedUpdates: Array<Record<string, unknown>> = [];
      const calls: string[] = [];
      const txSelect = vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([inventoryRow]) }) }))
      }));
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          calls.push('mfaEpoch' in values ? 'epochs' : 'revokedReason' in values ? 'families' : 'mfaSecret' in values ? 'clear-factors' : 'update');
          return {
            where: () => {
              const ret: any = Promise.resolve(undefined);
              ret.returning = () =>
                'mfaEpoch' in values
                  ? Promise.resolve([{ authEpoch: 0, mfaEpoch: 7, emailEpoch: 0, passwordResetEpoch: 0 }])
                  : 'mfaSecret' in values
                    ? Promise.resolve([{ id: TARGET }])
                    : Promise.resolve([]);
              return ret;
            }
          };
        }
      }));
      const txDelete = vi.fn((table: unknown) => {
        calls.push(table === userPasskeys ? 'delete-passkeys' : 'delete');
        return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(table === userPasskeys ? passkeyRows : []) }) };
      });
      vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ select: txSelect, update: txUpdate, delete: txDelete }));
      return { capturedUpdates, calls, txDelete };
    }
```
Keep `mockMfaState` and `mockScopedUser` as they are for now (Task 6 removes `mockMfaState`).

- [ ] **Step 4: `accessReviews.test.ts` — extend mocks and `mockCompleteTx`**

In `vi.mock('../db', …)` (line 13) add after `withSystemDbAccessContext`:
```ts
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system', orgId: null, accessibleOrgIds: null }))
```
In `vi.mock('../db/schema', …)` (line 43) add:
```ts
  userPasskeys: {
    id: { __column: 'user_passkeys.id' },
    userId: { __column: 'user_passkeys.user_id' },
    credentialId: { __column: 'user_passkeys.credential_id' },
    name: { __column: 'user_passkeys.name' },
    disabledAt: { __column: 'user_passkeys.disabled_at' },
  }
```
Add after `import { db } from '../db';`:
```ts
import { users, userPasskeys } from '../db/schema';
```
Replace `mockCompleteTx` (line ~436) with:
```ts
    function mockCompleteTx(opts: {
      hasOtherMembership?: boolean;
      passkeyRows?: Array<{ id: string; credentialId: string; name: string | null }>;
    } = {}) {
      const { hasOtherMembership = true, passkeyRows = [] } = opts;
      const capturedUpdates: Array<Record<string, unknown>> = [];
      const capturedDeletes: unknown[] = [];
      const txDelete = vi.fn((table: unknown) => {
        capturedDeletes.push(table);
        return {
          where: vi.fn(() => {
            const ret: any = Promise.resolve(undefined);
            ret.returning = () => Promise.resolve(table === userPasskeys ? passkeyRows : []);
            return ret;
          })
        };
      });
      // Orphan checks read partnerUsers/organizationUsers; the factor-reset
      // inventory snapshot reads `users` — route by table identity.
      const txSelect = vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(
              table === users
                ? [{ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc', mfaRecoveryCodes: ['h1'], phoneNumber: null, phoneVerified: false }]
                : hasOtherMembership ? [{ id: 'other-link' }] : []
            )
          })
        }))
      }));
      const txUpdate = vi.fn((_table: any) => ({
        set: (values: Record<string, unknown>) => {
          capturedUpdates.push(values);
          return {
            where: () => {
              const ret: any = Promise.resolve(undefined);
              ret.returning = () => Promise.resolve('mfaSecret' in values ? [{ id: 'cleared' }] : [updatedReview]);
              return ret;
            }
          };
        }
      }));
      vi.mocked(db.transaction).mockImplementation(async (fn) => {
        return fn({ delete: txDelete, update: txUpdate, select: txSelect } as any);
      });
      return { txDelete, txUpdate, txSelect, capturedUpdates, capturedDeletes };
    }
```

- [ ] **Step 5: Run both suites — must stay green (no behavior changed)**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts src/routes/accessReviews.test.ts`
Expected: PASS, same test counts as the Task 1 baseline.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/users.test.ts apps/api/src/routes/accessReviews.test.ts
git commit -m "test(auth): widen users/accessReviews route doubles for factor-reset service (RMM-QA-166 D12)

Mock-surface only: getCurrentDbAccessContext + userPasskeys schema double,
tx stubs gain select/delete-returning routed by table identity. No behavior
change; both suites green at the Task 1 baseline counts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 3: Write the integration RED suite and capture its failures against current main

The real-Postgres tests are written BEFORE the implementation so their RED is observed against `fcd5b498a` code. They stay **uncommitted** until Task 11 turns them green (Tasks 4–10 `git add` explicit paths only). I-4..I-6 import the not-yet-existing service and are RED by non-existence; their discriminating proofs are the Task 11 mutations.

**Files:**
- Create: `apps/api/src/__tests__/integration/adminMfaReset.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/mfaFactorReset.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/userDeleteResurrect.integration.test.ts` (append I-7, I-8)

**Interfaces:**
- Consumes (from Task 4, not yet present): `resetAllFactors(tx, userId)`, `resetAllFactorsAndInvalidate(userId, reason)`, `MfaFactorResetContextError` from `../../services/mfaFactorReset`.
- Consumes (existing): `createPartner`, `createUser`, `createRole`, `assignUserToPartner`, `setupTestEnvironment` from `./db-utils`; `getTestDb`, `getTestRedis` from `./setup`; `mintRefreshTokenFamily`; `userIsMfaProtected`; `createAccessToken`; `authBindingRoutes`; `mfaRoutes`; `userRoutes`.

- [ ] **Step 1: Bring up the private stack**

Run (worktree root): `pnpm test-stack up` then `pnpm test-stack info`
Expected: containers healthy; `.env.test` written in the worktree root. Sanity-run an existing suite: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/mfaAssurance.integration.test.ts` → PASS.

- [ ] **Step 2: Create `adminMfaReset.integration.test.ts` (I-1, I-2)**

```ts
/**
 * RMM-QA-166 — admin MFA reset strips EVERY factor, including user_passkeys.
 *
 * Drives the real POST /users/:id/mfa/reset against real Postgres (breeze_app,
 * RLS-enforced) + real Redis, with the auth middleware mocked the same way
 * userDeleteResurrect.integration.test.ts does (opens a real
 * withDbAccessContext for the caller's partner scope).
 *
 *   I-1 mixed-factor target (TOTP secret + recovery codes + mfaMethod='sms' +
 *       verified phone + two passkeys + refresh family + pending Redis keys):
 *       200; userIsMfaProtected === false; zero user_passkeys rows; all six
 *       columns cleared; auth_epoch unchanged, mfa_epoch > before; family
 *       revoked with reason admin-mfa-reset; both Redis keys gone; audit row
 *       user.mfa_reset with actor_id = admin and details.passkeysDeleted === 2.
 *   I-2 passkey-only target (mfa_enabled=false, one live passkey): 200 and the
 *       row is gone — main refuses this with 400 (column gate).
 *
 * Run:
 *   pnpm test-stack up   # worktree root
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/adminMfaReset.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

type AuthCtx = {
  scope: 'partner';
  partnerId: string;
  accessiblePartnerIds: string[];
  userId: string;
};

let activeAuthContext: AuthCtx | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      const ctx = activeAuthContext;
      c.set('auth', {
        scope: ctx.scope,
        partnerId: ctx.partnerId,
        partnerOrgAccess: 'all',
        orgId: null,
        accessibleOrgIds: [],
        user: { id: ctx.userId, email: 'admin@integration.test' },
        token: { mfa: true },
      });
      return withDbAccessContext(
        {
          scope: ctx.scope,
          orgId: null,
          accessibleOrgIds: [],
          accessiblePartnerIds: ctx.accessiblePartnerIds,
          userId: ctx.userId,
        },
        () => next(),
      );
    },
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

import { auditLogs, refreshTokenFamilies, userPasskeys, users } from '../../db/schema';
import { userIsMfaProtected } from '../../routes/auth/helpers';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { assignUserToPartner, createPartner, createRole, createUser } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

async function buildApp() {
  const { userRoutes } = await import('../../routes/users');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/users', userRoutes);
  return app;
}

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function passkeyRows(userId: string) {
  return getTestDb().select({ id: userPasskeys.id }).from(userPasskeys).where(eq(userPasskeys.userId, userId));
}

async function seedPasskey(userId: string, suffix: string, disabledAt: Date | null = null) {
  const [row] = await getTestDb()
    .insert(userPasskeys)
    .values({
      userId,
      credentialId: `cred-${suffix}-${userId}`,
      publicKey: 'dGVzdC1wdWJsaWMta2V5',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      name: `key-${suffix}`,
      disabledAt,
    })
    .returning();
  return row!;
}

async function waitForAuditRow(action: string, resourceId: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [row] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)))
      .limit(1);
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`audit row ${action} for ${resourceId} never appeared`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function seedTenant() {
  const partner = await createPartner();
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  const admin = await createUser({ partnerId: partner.id, email: `admin-${Date.now()}@example.com`, status: 'active' });
  await assignUserToPartner(admin.id, partner.id, role.id, 'all');
  activeAuthContext = { scope: 'partner', partnerId: partner.id, accessiblePartnerIds: [partner.id], userId: admin.id };
  return { partner, role, admin };
}

beforeEach(() => { activeAuthContext = null; });
afterEach(() => { activeAuthContext = null; vi.clearAllMocks(); });

describe('POST /users/:id/mfa/reset — strips every factor (RMM-QA-166)', () => {
  it('I-1: mixed TOTP+SMS+recovery+phone+two-passkey target is fully reset, sessions cut, audit names the admin', async () => {
    const { partner, role, admin } = await seedTenant();
    const target = await createUser({ partnerId: partner.id, email: `mixed-${Date.now()}@example.com`, status: 'active', mfaEnabled: true });
    await assignUserToPartner(target.id, partner.id, role.id);
    await getTestDb().update(users).set({
      mfaMethod: 'sms',
      mfaSecret: 'enc:seeded-secret',
      mfaRecoveryCodes: ['hash-a', 'hash-b'],
      phoneNumber: '+15550100',
      phoneVerified: true,
    }).where(eq(users.id, target.id));
    const pk1 = await seedPasskey(target.id, 'one');
    const pk2 = await seedPasskey(target.id, 'two');
    const familyId = await mintRefreshTokenFamily(target.id);
    const redis = getTestRedis();
    await redis.set(`mfa:setup:${target.id}`, JSON.stringify({ secret: 'pending' }), 'EX', 600);
    await redis.set(`passkey:challenge:registration:${target.id}`, '{}', 'EX', 300);

    const before = await readUser(target.id);
    expect(await userIsMfaProtected(target.id)).toBe(true);

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST' });
    expect(res.status).toBe(200);

    // Every factor is gone — this is the finding's core claim.
    expect(await userIsMfaProtected(target.id)).toBe(false);
    expect(await passkeyRows(target.id)).toHaveLength(0);
    const after = await readUser(target.id);
    expect(after).toMatchObject({
      mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false,
    });
    // Assurance invalidated: mfa_epoch advanced (auth_epoch is not the reset's concern).
    expect(after.mfaEpoch).toBeGreaterThan(before.mfaEpoch);
    expect(after.authEpoch).toBe(before.authEpoch);
    const [family] = await getTestDb().select().from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyId)).limit(1);
    expect(family?.revokedAt).not.toBeNull();
    expect(family?.revokedReason).toBe('admin-mfa-reset');
    // Pending artifacts swept.
    expect(await redis.exists(`mfa:setup:${target.id}`)).toBe(0);
    expect(await redis.exists(`passkey:challenge:registration:${target.id}`)).toBe(0);
    // Audit identifies the administrator and the deleted credentials.
    const audit = await waitForAuditRow('user.mfa_reset', target.id);
    expect(audit.actorId).toBe(admin.id);
    const details = audit.details as { passkeysDeleted: number; factors: { passkeys: Array<{ id: string }> } };
    expect(details.passkeysDeleted).toBe(2);
    expect(details.factors.passkeys.map((p) => p.id).sort()).toEqual([pk1.id, pk2.id].sort());
  });

  it('I-2: a passkey-only leftover (mfa_enabled=false, live passkey) is reset, not refused', async () => {
    const { partner, role } = await seedTenant();
    const target = await createUser({ partnerId: partner.id, email: `pkonly-${Date.now()}@example.com`, status: 'active', mfaEnabled: false });
    await assignUserToPartner(target.id, partner.id, role.id);
    await seedPasskey(target.id, 'only');
    expect(await userIsMfaProtected(target.id)).toBe(true);

    const app = await buildApp();
    const res = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await passkeyRows(target.id)).toHaveLength(0);
    expect(await userIsMfaProtected(target.id)).toBe(false);
  });
});
```

- [ ] **Step 3: Create `mfaReenrollmentAfterReset.integration.test.ts` (I-3)**

Uses the REAL `authMiddleware` with minted JWTs (no module mock) so the SR2-20 gate sees a real `auth.token.sid`.

```ts
/**
 * RMM-QA-166 I-3 — clean re-enrollment after an admin reset.
 *
 * Real Postgres + real Redis + the REAL authMiddleware (JWTs minted with
 * createAccessToken, epochs read from the live row). Proves the exit-contract
 * clause "old credentials fail, clean re-enrollment succeeds":
 *
 *   1. target holds TOTP + one passkey; admin resets via the real route → 200.
 *   2. userIsMfaProtected(target) === false (on main: still true — the
 *      passkey row survives the reset).
 *   3. POST /auth/mfa/setup with password only → 200 (no SR2-20 gate lives on
 *      /setup, so this is 200 on main too — recorded, not the discriminator).
 *   4. POST /auth/mfa/verify (Case 2, setup confirmation) with a VALID TOTP
 *      code and NO stepUpGrantId → 200 and the account is TOTP-enrolled. On
 *      main this is 403 `existing_factor_step_up_required`: the stale passkey
 *      makes enforceExistingFactorStepUp demand proof from the lost key.
 *   5. Re-inserting a passkey with the SAME credential_id as the deleted one
 *      succeeds (D1's UNIQUE-constraint argument, executed; on main it is a
 *      unique violation).
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { generate } from 'otplib';
import { partnerUsers, userPasskeys, users } from '../../db/schema';
import { authBindingRoutes } from '../../routes/auth/binding';
import { userIsMfaProtected } from '../../routes/auth/helpers';
import { mfaRoutes } from '../../routes/auth/mfa';
import { userRoutes } from '../../routes/users';
import { authMiddleware } from '../../middleware/auth';
import { createAccessToken } from '../../services/jwt';
import { assignUserToPartner, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';

const PASSWORD = 'TestPass123!';

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function mintToken(userId: string, email: string, partnerId: string, roleId: string, mfa: boolean) {
  const live = await readUser(userId);
  return createAccessToken({
    sub: userId, email, roleId, orgId: null, partnerId, scope: 'partner', mfa,
    aep: live.authEpoch, mep: live.mfaEpoch, sid: randomUUID(),
  });
}

async function browserBindingCookie(): Promise<string> {
  const response = await authBindingRoutes.request('/browser-binding/bootstrap', { method: 'POST' });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie') ?? '';
  const binding = /(?:^|,\s*)breeze_auth_binding=([0-9a-f]{64})/.exec(cookie)?.[1];
  if (!binding) throw new Error('bootstrap did not return an auth binding');
  return `breeze_auth_binding=${binding}`;
}

describe('admin reset → password-only TOTP re-enrollment (RMM-QA-166 I-3)', () => {
  it('a reset user re-enrolls with password only and can re-register the same authenticator', async () => {
    const partner = await createPartner();
    const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(adminRole.id, [{ resource: '*', action: '*' }]);
    const admin = await createUser({ partnerId: partner.id, email: `admin-${Date.now()}@example.com`, status: 'active' });
    await assignUserToPartner(admin.id, partner.id, adminRole.id, 'all');

    const target = await createUser({ partnerId: partner.id, email: `target-${Date.now()}@example.com`, status: 'active', password: PASSWORD, withMembership: true, mfaEnabled: true });
    await getTestDb().update(users).set({ mfaMethod: 'totp', mfaSecret: 'enc:old-secret', mfaRecoveryCodes: ['hash-old'] }).where(eq(users.id, target.id));
    const credentialId = `cred-reuse-${target.id}`;
    await getTestDb().insert(userPasskeys).values({
      userId: target.id, credentialId, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, deviceType: 'singleDevice', backedUp: false, name: 'lost-key',
    });
    const [membership] = await getTestDb().select({ roleId: partnerUsers.roleId }).from(partnerUsers).where(eq(partnerUsers.userId, target.id)).limit(1);
    if (!membership) throw new Error('target membership missing');

    const app = new Hono();
    app.use('/users/*', authMiddleware as never);
    app.route('/users', userRoutes);
    app.route('/auth', mfaRoutes);

    // 1. admin reset via the real route (requireMfa: admin token carries mfa:true).
    const adminToken = await mintToken(admin.id, admin.email, partner.id, adminRole.id, true);
    const reset = await app.request(`/users/${target.id}/mfa/reset`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    expect(reset.status).toBe(200);

    // 2. no factor remains — the gate that blocked re-enrollment is open.
    expect(await userIsMfaProtected(target.id)).toBe(false);

    // 3. password-only setup.
    const targetToken = await mintToken(target.id, target.email, partner.id, membership.roleId, false);
    const setup = await app.request('/auth/mfa/setup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${targetToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    });
    expect(setup.status).toBe(200);
    const { secret } = (await setup.json()) as { secret: string };
    expect(typeof secret).toBe('string');

    // 4. confirm with a valid code and NO stepUpGrantId (Case 2 of /mfa/verify).
    const code = await generate({ secret });
    const confirm = await app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${targetToken}`, 'Content-Type': 'application/json', cookie: await browserBindingCookie() },
      body: JSON.stringify({ code }),
    });
    expect(confirm.status).toBe(200);
    const enrolled = await readUser(target.id);
    expect(enrolled.mfaEnabled).toBe(true);
    expect(enrolled.mfaMethod).toBe('totp');

    // 5. the deleted credential id is free again (hard DELETE, not soft-disable).
    await expect(getTestDb().insert(userPasskeys).values({
      userId: target.id, credentialId, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, deviceType: 'singleDevice', backedUp: false, name: 'same-key-again',
    })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 4: Create `mfaFactorReset.integration.test.ts` (I-4, I-5, I-6)**

```ts
/**
 * RMM-QA-166 — resetAllFactors under real RLS (breeze_app) + real transactions.
 *
 *   I-4 RLS guard (verifier concern C1, executed): under a TENANT
 *       withDbAccessContext the service throws MfaFactorResetContextError and
 *       the passkey row + mfa_enabled are untouched. The row-count alternative
 *       was rejected because an ambient pre-read is RLS-filtered to zero too.
 *   I-5 atomicity: a throw injected AFTER resetAllFactors inside the
 *       invalidate primitive rolls back passkey delete, column clears, the
 *       mfa_epoch bump and the family revoke together.
 *   I-6 already-disabled passkey rows are deleted too (credential ids freed).
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/mfaFactorReset.integration.test.ts
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { refreshTokenFamilies, userPasskeys, users } from '../../db/schema';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { MfaFactorResetContextError, resetAllFactors } from '../../services/mfaFactorReset';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

async function readUser(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw new Error(`user ${id} not found`);
  return row;
}

async function passkeyCount(userId: string) {
  return (await getTestDb().select({ id: userPasskeys.id }).from(userPasskeys).where(eq(userPasskeys.userId, userId))).length;
}

async function seedPasskey(userId: string, suffix: string, disabledAt: Date | null = null) {
  await getTestDb().insert(userPasskeys).values({
    userId, credentialId: `cred-${suffix}-${userId}`, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, deviceType: 'singleDevice', backedUp: false, name: suffix, disabledAt,
  });
}

async function seedProtectedUser() {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id, withMembership: true, mfaEnabled: true });
  await getTestDb().update(users).set({ mfaMethod: 'totp', mfaSecret: 'enc:seed', mfaRecoveryCodes: ['h'] }).where(eq(users.id, user.id));
  await seedPasskey(user.id, 'live');
  return { partner, user };
}

describe('resetAllFactors — RLS guard, atomicity, disabled rows (RMM-QA-166)', () => {
  it('I-4: refuses to run under a tenant context and leaves the passkey + mfa_enabled untouched', async () => {
    const { partner, user } = await seedProtectedUser();

    await expect(
      withDbAccessContext(
        { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partner.id], userId: null },
        () => db.transaction((tx) => resetAllFactors(tx, user.id)),
      ),
    ).rejects.toBeInstanceOf(MfaFactorResetContextError);

    expect(await passkeyCount(user.id)).toBe(1);
    expect((await readUser(user.id)).mfaEnabled).toBe(true);
  });

  it('I-5: a failure after the factor write rolls back passkeys, columns, mfa_epoch and the family together', async () => {
    const { user } = await seedProtectedUser();
    const familyId = await mintRefreshTokenFamily(user.id);
    const before = await readUser(user.id);
    const boom = new Error('injected failure after resetAllFactors');

    await expect(
      withSystemDbAccessContext(() =>
        invalidateMfaAssuranceAfterFactorChange(user.id, 'test-rollback', async (tx) => {
          const inventory = await resetAllFactors(tx, user.id);
          expect(inventory.passkeysDeleted).toBe(1); // the delete DID run inside the tx
          throw boom;
        }),
      ),
    ).rejects.toThrow(boom);

    const after = await readUser(user.id);
    expect(await passkeyCount(user.id)).toBe(1);
    expect(after).toMatchObject({ mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc:seed', mfaEpoch: before.mfaEpoch });
    const [family] = await getTestDb().select().from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyId)).limit(1);
    expect(family?.revokedAt).toBeNull();
  });

  it('I-6: deletes already-disabled passkey rows too and reports the full count', async () => {
    const { user } = await seedProtectedUser();
    await seedPasskey(user.id, 'disabled', new Date());
    expect(await passkeyCount(user.id)).toBe(2);

    const inventory = await withSystemDbAccessContext(() => db.transaction((tx) => resetAllFactors(tx, user.id)));

    expect(inventory.passkeysDeleted).toBe(2);
    expect(inventory.passkeys.map((p) => p.name).sort()).toEqual(['disabled', 'live']);
    expect(await passkeyCount(user.id)).toBe(0);
  });
});
```

- [ ] **Step 5: Append I-7 and I-8 to `userDeleteResurrect.integration.test.ts`**

Add `userPasskeys` to the schema import (`import { users, partnerUsers, organizationUsers, userPasskeys } from '../../db/schema';`) and append at the end of the file:

```ts
async function seedPasskey(userId: string) {
  await getTestDb().insert(userPasskeys).values({
    userId, credentialId: `cred-${userId}`, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0, deviceType: 'singleDevice', backedUp: false, name: 'stale',
  });
}

async function passkeyCount(userId: string) {
  return (await getTestDb().select({ id: userPasskeys.id }).from(userPasskeys).where(eq(userPasskeys.userId, userId))).length;
}

describe('user delete / re-invite → factors stripped (RMM-QA-166)', () => {
  it('I-7: last-membership removal neutralizes TOTP, phone and passkeys and advances both epochs', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const caller = await createUser({ partnerId: partner.id, email: `caller-${Date.now()}@example.com`, status: 'active' });
    await assignUserToPartner(caller.id, partner.id, role.id, 'all');
    const target = await createUser({ partnerId: partner.id, email: `factors-${Date.now()}@example.com`, status: 'active', mfaEnabled: true });
    await assignUserToPartner(target.id, partner.id, role.id);
    await getTestDb().update(users).set({ mfaMethod: 'totp', mfaSecret: 'enc:seed', mfaRecoveryCodes: ['h'], phoneNumber: '+15550100', phoneVerified: true }).where(eq(users.id, target.id));
    await seedPasskey(target.id);
    const before = await readUser(target.id);

    activeAuthContext = { scope: 'partner', partnerId: partner.id, orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partner.id], userId: caller.id };
    const app = await buildApp();
    const res = await app.request(`/users/${target.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const row = await readUser(target.id);
    expect(row).toMatchObject({
      status: 'disabled', passwordHash: null,
      mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false,
    });
    expect(await passkeyCount(target.id)).toBe(0);
    expect(row.authEpoch).toBeGreaterThan(before.authEpoch);
    expect(row.mfaEpoch).toBeGreaterThan(before.mfaEpoch);
  });

  it('I-8: re-inviting a tombstone that still carries a stale passkey sweeps it before resurrection', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const caller = await createUser({ partnerId: partner.id, email: `caller-${Date.now()}@example.com`, status: 'active' });
    await assignUserToPartner(caller.id, partner.id, role.id, 'all');
    const email = `stale-${Date.now()}@example.com`;
    const target = await createUser({ partnerId: partner.id, email, name: 'Old Name', status: 'active' });
    // Tombstone as the pre-fix code (or the 2026-06-18 backfill) leaves it: disabled,
    // no password, no membership — but with a passkey row and a verified phone.
    await withSystemDbAccessContext(async () =>
      db.update(users).set({ status: 'disabled', disabledReason: 'removed', passwordHash: null, phoneNumber: '+15550100', phoneVerified: true }).where(eq(users.id, target.id)),
    );
    await seedPasskey(target.id);

    activeAuthContext = { scope: 'partner', partnerId: partner.id, orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partner.id], userId: caller.id };
    const app = await buildApp();
    const res = await app.request('/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name: 'New Name', roleId: role.id, orgAccess: 'none' }),
    });
    expect(res.status).toBe(201);

    const row = await readUser(target.id);
    expect(row.status).toBe('invited');
    expect(await passkeyCount(target.id)).toBe(0);
    expect(row.phoneVerified).toBe(false);
    expect(row.phoneNumber).toBeNull();
  });
});
```

- [ ] **Step 6: Run the four files and capture RED**

Run:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/adminMfaReset.integration.test.ts \
  src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts \
  src/__tests__/integration/mfaFactorReset.integration.test.ts \
  src/__tests__/integration/userDeleteResurrect.integration.test.ts 2>&1 | tee "<scratchpad>/rmm-qa-166-red/I-all-before.txt"
```
Expected RED (record each line):
- I-1: `expect(await userIsMfaProtected(target.id)).toBe(false)` → received `true` (passkeys survive).
- I-2: `expect(res.status).toBe(200)` → received `400`.
- I-3: `expect(await userIsMfaProtected(target.id)).toBe(false)` → received `true` (and, if you comment that line out to look further, `/auth/mfa/verify` → `403`).
- I-4/I-5/I-6: suite fails to load — `Failed to resolve import "../../services/mfaFactorReset"`.
- I-7: `expect(await passkeyCount(target.id)).toBe(0)` → received `1` (or the phone assertion first).
- I-8: `expect(await passkeyCount(target.id)).toBe(0)` → received `1`.
- The three pre-existing `#1367` tests in userDeleteResurrect still PASS.

Do **not** commit these files yet (Task 11 does). Leave the stack up.

---

### Task 4: `services/mfaFactorReset.ts` — the factor-reset service (D1, D2, D4, D8)

**Files:**
- Create: `apps/api/src/services/mfaFactorReset.ts`
- Create: `apps/api/src/services/mfaFactorReset.test.ts`

**Interfaces:**
- Consumes: `getCurrentDbAccessContext`, `runOutsideDbContext`, `withSystemDbAccessContext`, `db` from `../db`; `users`, `userPasskeys` from `../db/schema`; `invalidateMfaAssuranceAfterFactorChange`, `FactorChangeResult` from `./mfaAssurance`; `getRedis` from `./redis`; `captureException` from `./sentry`; `Tx` from `./authLifecycle`.
- Produces:
  - `class MfaFactorResetContextError extends Error` (name `MfaFactorResetContextError`)
  - `interface MfaFactorInventory { wasEnabled: boolean; previousMethod: 'totp'|'sms'|'passkey'|null; hadTotp: boolean; hadSms: boolean; hadRecoveryCodes: boolean; hadPhone: boolean; passkeys: Array<{ id: string; credentialId: string; name: string | null }>; passkeysDeleted: number }`
  - `interface AdminFactorResetResult extends FactorChangeResult { inventory: MfaFactorInventory; pendingSweepOk: boolean }`
  - `resetAllFactors(tx: Tx, userId: string): Promise<MfaFactorInventory>`
  - `resetAllFactorsAndInvalidate(userId: string, reason: string): Promise<AdminFactorResetResult>`
  - `pendingFactorArtifactKeys(userId: string): string[]`
  - `sweepPendingFactorArtifacts(userId: string): Promise<boolean>`
  - `MAX_AUDITED_PASSKEYS = 100`

- [ ] **Step 1: Write the failing unit test `apps/api/src/services/mfaFactorReset.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getCurrentDbAccessContextMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  invalidateMock,
  redisDelMock,
  getRedisMock,
  captureExceptionMock,
} = vi.hoisted(() => ({
  getCurrentDbAccessContextMock: vi.fn(),
  runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  invalidateMock: vi.fn(),
  redisDelMock: vi.fn(),
  getRedisMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../db/schema', () => ({
  users: { id: { __column: 'users.id' }, mfaEnabled: {}, mfaMethod: {}, mfaSecret: {}, mfaRecoveryCodes: {}, phoneNumber: {}, phoneVerified: {} },
  userPasskeys: { id: { __column: 'user_passkeys.id' }, userId: { __column: 'user_passkeys.user_id' }, credentialId: {}, name: {} },
}));

vi.mock('./mfaAssurance', () => ({ invalidateMfaAssuranceAfterFactorChange: invalidateMock }));
vi.mock('./redis', () => ({ getRedis: getRedisMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import {
  MAX_AUDITED_PASSKEYS,
  MfaFactorResetContextError,
  pendingFactorArtifactKeys,
  resetAllFactors,
  resetAllFactorsAndInvalidate,
  sweepPendingFactorArtifacts,
} from './mfaFactorReset';

const USER = '11111111-1111-1111-1111-111111111111';
const ROW = { mfaEnabled: true, mfaMethod: 'sms', mfaSecret: 'enc', mfaRecoveryCodes: ['h1', 'h2'], phoneNumber: '+15550100', phoneVerified: true };

function makeTx(opts: { inventory?: Record<string, unknown> | null; passkeys?: Array<{ id: string; credentialId: string; name: string | null }>; updatedRows?: number } = {}) {
  const calls: string[] = [];
  const setValues: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => { calls.push('select-inventory'); return opts.inventory === null ? [] : [opts.inventory ?? ROW]; }) })) })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      setValues.push(values);
      return { where: vi.fn(() => ({ returning: vi.fn(async () => { calls.push('update-users'); return Array.from({ length: opts.updatedRows ?? 1 }, () => ({ id: USER })); }) })) };
    }),
  }));
  const del = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => { calls.push('delete-passkeys'); return opts.passkeys ?? []; }) })) }));
  return { tx: { select, update, delete: del } as any, calls, setValues, select, update, del };
}

describe('resetAllFactors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null });
  });

  it.each([
    ['partner', { scope: 'partner', orgId: null, accessibleOrgIds: [] }],
    ['none', undefined],
  ])('throws MfaFactorResetContextError under a %s context and touches nothing', async (_label, ctx) => {
    getCurrentDbAccessContextMock.mockReturnValue(ctx);
    const { tx, select, update, del } = makeTx();
    await expect(resetAllFactors(tx, USER)).rejects.toBeInstanceOf(MfaFactorResetContextError);
    expect(select).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('throws when the users row is missing and issues no write', async () => {
    const { tx, update, del } = makeTx({ inventory: null });
    await expect(resetAllFactors(tx, USER)).rejects.toThrow(/no users row/);
    expect(update).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('throws when the users UPDATE matches zero rows (silent-zero-row guard) before deleting passkeys', async () => {
    const { tx, del } = makeTx({ updatedRows: 0 });
    await expect(resetAllFactors(tx, USER)).rejects.toThrow(/matched 0 rows/);
    expect(del).not.toHaveBeenCalled();
  });

  it('snapshots the inventory, clears every users column, then deletes passkeys — exactly one UPDATE and one DELETE, in that order', async () => {
    const passkeys = [
      { id: 'pk-1', credentialId: 'cred-1', name: 'YubiKey' },
      { id: 'pk-2', credentialId: 'cred-2', name: null },
    ];
    const { tx, calls, setValues, update, del } = makeTx({ passkeys });

    const inventory = await resetAllFactors(tx, USER);

    expect(calls).toEqual(['select-inventory', 'update-users', 'delete-passkeys']);
    expect(update).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(setValues[0]).toMatchObject({ mfaSecret: null, mfaEnabled: false, mfaMethod: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false });
    expect(setValues[0]).not.toHaveProperty('mfaEpoch'); // D3: the service never bumps epochs
    expect(setValues[0]).not.toHaveProperty('authEpoch');
    expect(inventory).toEqual({
      wasEnabled: true, previousMethod: 'sms', hadTotp: true, hadSms: true, hadRecoveryCodes: true, hadPhone: true,
      passkeys, passkeysDeleted: 2,
    });
  });

  it('reports an empty inventory for a bare account and zero passkeys', async () => {
    const { tx } = makeTx({ inventory: { mfaEnabled: false, mfaMethod: null, mfaSecret: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false } });
    const inventory = await resetAllFactors(tx, USER);
    expect(inventory).toEqual({ wasEnabled: false, previousMethod: null, hadTotp: false, hadSms: false, hadRecoveryCodes: false, hadPhone: false, passkeys: [], passkeysDeleted: 0 });
  });

  it(`caps the audited passkey list at ${MAX_AUDITED_PASSKEYS} while passkeysDeleted carries the full count`, async () => {
    const many = Array.from({ length: MAX_AUDITED_PASSKEYS + 1 }, (_, i) => ({ id: `pk-${i}`, credentialId: `cred-${i}`, name: null }));
    const { tx } = makeTx({ passkeys: many });
    const inventory = await resetAllFactors(tx, USER);
    expect(inventory.passkeys).toHaveLength(MAX_AUDITED_PASSKEYS);
    expect(inventory.passkeysDeleted).toBe(MAX_AUDITED_PASSKEYS + 1);
  });
});

describe('resetAllFactorsAndInvalidate', () => {
  const fakeTx = makeTx({ passkeys: [{ id: 'pk-1', credentialId: 'cred-1', name: null }] });

  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null });
    getRedisMock.mockReturnValue({ del: redisDelMock });
    redisDelMock.mockResolvedValue(3);
    invalidateMock.mockImplementation(async (_userId: string, _reason: string, mutate: (tx: unknown) => Promise<void>) => {
      await mutate(fakeTx.tx);
      return { mfaEpoch: 9, cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true }, remoteSessionsTerminated: 0 };
    });
  });

  it('escalates to system context, folds resetAllFactors into the assurance primitive, then sweeps the three keys after commit', async () => {
    const order: string[] = [];
    runOutsideDbContextMock.mockImplementation((fn: () => unknown) => { order.push('runOutsideDbContext'); return fn(); });
    withSystemDbAccessContextMock.mockImplementation(async (fn: () => Promise<unknown>) => { order.push('withSystemDbAccessContext'); return fn(); });
    invalidateMock.mockImplementation(async (_u: string, _r: string, mutate: (tx: unknown) => Promise<void>) => {
      order.push('invalidate:begin');
      await mutate(fakeTx.tx);
      order.push('invalidate:committed');
      return { mfaEpoch: 9, cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true }, remoteSessionsTerminated: 0 };
    });
    redisDelMock.mockImplementation(async () => { order.push('redis.del'); return 3; });

    const result = await resetAllFactorsAndInvalidate(USER, 'admin-mfa-reset');

    expect(order).toEqual(['runOutsideDbContext', 'withSystemDbAccessContext', 'invalidate:begin', 'invalidate:committed', 'redis.del']);
    expect(invalidateMock).toHaveBeenCalledWith(USER, 'admin-mfa-reset', expect.any(Function));
    expect(redisDelMock).toHaveBeenCalledWith(`mfa:setup:${USER}`, `passkey:challenge:registration:${USER}`, `passkey:challenge:authentication:${USER}`);
    expect(result).toEqual({
      mfaEpoch: 9,
      cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true },
      remoteSessionsTerminated: 0,
      pendingSweepOk: true,
      inventory: expect.objectContaining({ passkeysDeleted: 1, previousMethod: 'sms' }),
    });
  });

  it('propagates a transaction failure and never sweeps', async () => {
    invalidateMock.mockRejectedValue(new Error('tx failed'));
    await expect(resetAllFactorsAndInvalidate(USER, 'admin-mfa-reset')).rejects.toThrow('tx failed');
    expect(redisDelMock).not.toHaveBeenCalled();
  });

  it('reports pendingSweepOk=false when Redis is unavailable, without throwing', async () => {
    getRedisMock.mockReturnValue(null);
    const result = await resetAllFactorsAndInvalidate(USER, 'admin-mfa-reset');
    expect(result.pendingSweepOk).toBe(false);
  });
});

describe('sweepPendingFactorArtifacts', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists exactly the three per-user keys', () => {
    expect(pendingFactorArtifactKeys(USER)).toEqual([`mfa:setup:${USER}`, `passkey:challenge:registration:${USER}`, `passkey:challenge:authentication:${USER}`]);
  });

  it('swallows a Redis error, reports it to Sentry and returns false', async () => {
    getRedisMock.mockReturnValue({ del: vi.fn().mockRejectedValue(new Error('ECONNRESET')) });
    await expect(sweepPendingFactorArtifacts(USER)).resolves.toBe(false);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it — RED by non-existence**

Run: `pnpm --filter @breeze/api exec vitest run src/services/mfaFactorReset.test.ts 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T4-service.txt"`
Expected: FAIL — `Failed to resolve import "./mfaFactorReset"`.

- [ ] **Step 3: Create `apps/api/src/services/mfaFactorReset.ts`**

```ts
import { eq } from 'drizzle-orm';
import { getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users, userPasskeys } from '../db/schema';
import type { Tx } from './authLifecycle';
import { invalidateMfaAssuranceAfterFactorChange, type FactorChangeResult } from './mfaAssurance';
import { getRedis } from './redis';
import { captureException } from './sentry';

/**
 * RMM-QA-166 — the ONE place that removes every second factor from an account.
 *
 * `resetAllFactors(tx, userId)` is the in-transaction "mutate half": it clears
 * the `users` factor columns (TOTP secret, enabled flag, method, recovery
 * codes, phone) and hard-DELETEs every `user_passkeys` row (D1: rows are
 * deleted, never soft-disabled — `credential_id` is UNIQUE, so a disabled row
 * would block re-registering the same authenticator). It returns the prior
 * factor inventory for the caller's audit row.
 *
 * It NEVER advances epochs or revokes refresh families (D3). Two call shapes
 * are admitted, and both must run under a SYSTEM DB access context:
 *
 *   1. Admin/composite: `resetAllFactorsAndInvalidate(userId, reason)` — wraps
 *      this as the `mutate` of `invalidateMfaAssuranceAfterFactorChange`
 *      (mfa_epoch bump + family revoke precede the factor write inside one
 *      transaction; post-commit cleanup, remote-session teardown and the
 *      pending-artifact Redis sweep follow).
 *   2. Membership removal (`services/userNeutralization.ts`): the caller has
 *      ALREADY run `advanceUserEpochs(tx, id, { auth: true, mfa: true })` and
 *      `revokeAllRefreshFamilies(tx, id, …)` in the same transaction, then
 *      calls `neutralizeUserIfOrphaned`, which calls this last — global lock
 *      order user → families → factor rows holds at every site.
 *
 * Why the context guard (D4): `user_passkeys` RLS is
 * `user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'`
 * (FORCE). Under an admin's ambient tenant context the DELETE matches ZERO
 * rows and reports success — the silent-zero-row trap. A row-count check
 * cannot catch it either: the pre-read is filtered to zero by the same policy,
 * so 0 == 0 passes. The only guard that cannot be fooled is an explicit
 * assertion on the active context's scope, thrown loudly.
 */
export class MfaFactorResetContextError extends Error {
  constructor(scope: string | undefined) {
    super(
      `resetAllFactors requires a system DB access context (active scope: ${scope ?? 'none'}); ` +
        'an ambient tenant context would delete zero user_passkeys rows under RLS',
    );
    this.name = 'MfaFactorResetContextError';
  }
}

export interface MfaFactorInventory {
  wasEnabled: boolean;
  previousMethod: 'totp' | 'sms' | 'passkey' | null;
  hadTotp: boolean;
  hadSms: boolean;
  hadRecoveryCodes: boolean;
  hadPhone: boolean;
  /** Deleted passkey rows, capped at MAX_AUDITED_PASSKEYS for the audit payload. */
  passkeys: Array<{ id: string; credentialId: string; name: string | null }>;
  /** Full count of deleted passkey rows (uncapped). */
  passkeysDeleted: number;
}

export interface AdminFactorResetResult extends FactorChangeResult {
  inventory: MfaFactorInventory;
  /** false when the post-commit Redis sweep could not run — recorded in audit, never thrown. */
  pendingSweepOk: boolean;
}

export const MAX_AUDITED_PASSKEYS = 100;

export async function resetAllFactors(tx: Tx, userId: string): Promise<MfaFactorInventory> {
  const ctx = getCurrentDbAccessContext();
  if (ctx?.scope !== 'system') {
    throw new MfaFactorResetContextError(ctx?.scope);
  }

  const [before] = await tx
    .select({
      mfaEnabled: users.mfaEnabled,
      mfaMethod: users.mfaMethod,
      mfaSecret: users.mfaSecret,
      mfaRecoveryCodes: users.mfaRecoveryCodes,
      phoneNumber: users.phoneNumber,
      phoneVerified: users.phoneVerified,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!before) {
    throw new Error(`resetAllFactors: no users row for ${userId}`);
  }

  // Lock order: the users row first (this UPDATE), then factor rows.
  const cleared = await tx
    .update(users)
    .set({
      mfaSecret: null,
      mfaEnabled: false,
      mfaMethod: null,
      mfaRecoveryCodes: null,
      phoneNumber: null,
      phoneVerified: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (cleared.length !== 1) {
    throw new Error(`resetAllFactors: users UPDATE matched ${cleared.length} rows for ${userId}`);
  }

  // Every row — including already-disabled ones — so all credential ids are freed.
  const deleted = await tx
    .delete(userPasskeys)
    .where(eq(userPasskeys.userId, userId))
    .returning({ id: userPasskeys.id, credentialId: userPasskeys.credentialId, name: userPasskeys.name });

  return {
    wasEnabled: before.mfaEnabled === true,
    previousMethod: before.mfaMethod ?? null,
    hadTotp: before.mfaSecret != null,
    hadSms: before.mfaMethod === 'sms',
    hadRecoveryCodes: before.mfaRecoveryCodes != null,
    hadPhone: before.phoneNumber != null || before.phoneVerified === true,
    passkeys: deleted.slice(0, MAX_AUDITED_PASSKEYS).map((row) => ({ id: row.id, credentialId: row.credentialId, name: row.name ?? null })),
    passkeysDeleted: deleted.length,
  };
}

/**
 * Admin-path composite (cross-user by definition, so the system-context
 * escalation lives here; authorization — requirePermission, requireMfa,
 * getScopedUser — stays in the route BEFORE this call). One transaction:
 * mfa_epoch bump → family revoke → resetAllFactors; then post-commit cleanup,
 * remote-session teardown, and the best-effort pending-artifact sweep.
 */
export async function resetAllFactorsAndInvalidate(userId: string, reason: string): Promise<AdminFactorResetResult> {
  let inventory: MfaFactorInventory | undefined;
  const result = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      invalidateMfaAssuranceAfterFactorChange(userId, reason, async (tx) => {
        inventory = await resetAllFactors(tx, userId);
      }),
    ),
  );
  if (!inventory) {
    throw new Error('resetAllFactorsAndInvalidate: factor write did not run');
  }
  const pendingSweepOk = await sweepPendingFactorArtifacts(userId);
  return { ...result, inventory, pendingSweepOk };
}

/**
 * Per-user Redis artifacts a reset must not leave behind (D8). Step-up grants
 * (`mfa:stepup:<grantId>`) and pending logins (`mfa:pending:<tempToken>`) are
 * keyed by opaque ids and are NOT swept — they are dead by construction after
 * the mfa_epoch bump (they bind the live epochs).
 */
export function pendingFactorArtifactKeys(userId: string): string[] {
  return [
    `mfa:setup:${userId}`,
    `passkey:challenge:registration:${userId}`,
    `passkey:challenge:authentication:${userId}`,
  ];
}

/** Best-effort, post-commit, never throws. Returns false when the sweep could not run. */
export async function sweepPendingFactorArtifacts(userId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    if (!redis) {
      console.warn('[mfa-factor-reset] pending-artifact sweep skipped: Redis unavailable', { userId });
      return false;
    }
    await redis.del(...pendingFactorArtifactKeys(userId));
    return true;
  } catch (err) {
    console.error('[mfa-factor-reset] pending-artifact sweep failed', { userId });
    captureException(err);
    return false;
  }
}
```

- [ ] **Step 4: GREEN + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/services/mfaFactorReset.test.ts` → PASS (12 tests).
Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` → exits 0.

- [ ] **Step 5: Mutation controls (apply → run → observe fail → `git checkout -- apps/api/src/services/mfaFactorReset.ts` → re-run green)**

  1. Change the guard to `if (ctx?.scope !== 'system' && ctx !== undefined)` → the `none` case of the guard test fails (`resolves` instead of rejecting). Record.
  2. Move the `DELETE user_passkeys` block above the `UPDATE users` block → the ordering test fails (`['select-inventory','delete-passkeys','update-users']`). Record.
  3. Drop `phoneNumber: null` from the `set({...})` → the inventory test's `toMatchObject` on `setValues[0]` fails. Record.
  4. Remove `passkey:challenge:authentication:${userId}` from `pendingFactorArtifactKeys` → the composite sweep test and the key-list test fail. Record.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/mfaFactorReset.ts apps/api/src/services/mfaFactorReset.test.ts
git commit -m "feat(auth): add mfaFactorReset service — one transactional factor reset incl. passkeys (RMM-QA-166 D1/D2/D4/D8)

resetAllFactors(tx, userId): system-context guard (MfaFactorResetContextError),
inventory snapshot, UPDATE users (six factor columns) RETURNING-checked,
hard DELETE user_passkeys RETURNING ids into the inventory. Never bumps
epochs (D3). resetAllFactorsAndInvalidate wraps it as the mutate of the
unchanged invalidateMfaAssuranceAfterFactorChange under system context and
sweeps mfa:setup + both passkey challenge keys post-commit, best-effort.

RED (before): <paste from T4-service.txt: 'Failed to resolve import \"./mfaFactorReset\"'>
Mutation control: <paste the four observed failures from Step 5>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 5: `services/userNeutralization.ts` — neutralization owns the factor reset (D5)

**Files:**
- Create: `apps/api/src/services/userNeutralization.ts`
- Create: `apps/api/src/services/userNeutralization.test.ts`

**Interfaces:**
- Consumes: `resetAllFactors`, `MfaFactorInventory` from `./mfaFactorReset`; `users`, `partnerUsers`, `organizationUsers` from `../db/schema`; `Tx` from `./authLifecycle`.
- Produces: `interface NeutralizationResult { neutralized: boolean; inventory?: MfaFactorInventory }`; `neutralizeUserIfOrphaned(tx: Tx, userId: string): Promise<NeutralizationResult>`.

- [ ] **Step 1: Write the failing unit test `apps/api/src/services/userNeutralization.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resetAllFactorsMock } = vi.hoisted(() => ({ resetAllFactorsMock: vi.fn() }));

vi.mock('./mfaFactorReset', () => ({ resetAllFactors: resetAllFactorsMock }));
vi.mock('../db/schema', () => ({
  users: { id: { __column: 'users.id' } },
  partnerUsers: { id: { __column: 'partner_users.id' }, userId: { __column: 'partner_users.user_id' } },
  organizationUsers: { id: { __column: 'organization_users.id' }, userId: { __column: 'organization_users.user_id' } },
}));

import { partnerUsers, organizationUsers } from '../db/schema';
import { neutralizeUserIfOrphaned } from './userNeutralization';

const USER = '11111111-1111-1111-1111-111111111111';
const INVENTORY = { wasEnabled: true, previousMethod: 'totp', hadTotp: true, hadSms: false, hadRecoveryCodes: true, hadPhone: false, passkeys: [], passkeysDeleted: 0 };

function makeTx(links: { partner?: boolean; org?: boolean }) {
  const calls: string[] = [];
  const setValues: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          calls.push(table === partnerUsers ? 'select-partner-link' : table === organizationUsers ? 'select-org-link' : 'select-other');
          if (table === partnerUsers) return links.partner ? [{ id: 'p-link' }] : [];
          if (table === organizationUsers) return links.org ? [{ id: 'o-link' }] : [];
          return [];
        }),
      })),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      setValues.push(values);
      return { where: vi.fn(async () => { calls.push('update-users'); }) };
    }),
  }));
  return { tx: { select, update } as any, calls, setValues, update };
}

describe('neutralizeUserIfOrphaned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllFactorsMock.mockImplementation(async () => INVENTORY);
  });

  it('short-circuits when a partner membership remains (no update, no factor reset)', async () => {
    const { tx, update, calls } = makeTx({ partner: true });
    await expect(neutralizeUserIfOrphaned(tx, USER)).resolves.toEqual({ neutralized: false });
    expect(update).not.toHaveBeenCalled();
    expect(resetAllFactorsMock).not.toHaveBeenCalled();
    expect(calls).toEqual(['select-partner-link']);
  });

  it('short-circuits when an organization membership remains', async () => {
    const { tx, update } = makeTx({ org: true });
    await expect(neutralizeUserIfOrphaned(tx, USER)).resolves.toEqual({ neutralized: false });
    expect(update).not.toHaveBeenCalled();
    expect(resetAllFactorsMock).not.toHaveBeenCalled();
  });

  it('neutralizes an orphan (disabled, reason removed, no password) and THEN resets every factor on the same tx', async () => {
    const { tx, calls, setValues } = makeTx({});
    resetAllFactorsMock.mockImplementation(async (passedTx: unknown) => {
      expect(passedTx).toBe(tx);
      calls.push('resetAllFactors');
      return INVENTORY;
    });

    const result = await neutralizeUserIfOrphaned(tx, USER);

    expect(calls).toEqual(['select-partner-link', 'select-org-link', 'update-users', 'resetAllFactors']);
    expect(setValues[0]).toMatchObject({ status: 'disabled', disabledReason: 'removed', passwordHash: null });
    expect(setValues[0]).not.toHaveProperty('authEpoch'); // D3: epochs are the caller's
    expect(resetAllFactorsMock).toHaveBeenCalledWith(tx, USER);
    expect(result).toEqual({ neutralized: true, inventory: INVENTORY });
  });
});
```

- [ ] **Step 2: Run — RED by non-existence**

Run: `pnpm --filter @breeze/api exec vitest run src/services/userNeutralization.test.ts 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T5-neutralization.txt"`
Expected: FAIL — `Failed to resolve import "./userNeutralization"`.

- [ ] **Step 3: Create `apps/api/src/services/userNeutralization.ts`**

```ts
import { eq } from 'drizzle-orm';
import { users, partnerUsers, organizationUsers } from '../db/schema';
import type { Tx } from './authLifecycle';
import { resetAllFactors, type MfaFactorInventory } from './mfaFactorReset';

export interface NeutralizationResult {
  neutralized: boolean;
  inventory?: MfaFactorInventory;
}

/**
 * When a user's LAST membership anywhere has just been removed, neutralize the
 * orphaned `users` row so it cannot authenticate: status='disabled',
 * password_hash=NULL, and (RMM-QA-166) every second factor stripped —
 * TOTP secret, recovery codes, method flag, phone, and all `user_passkeys`
 * rows — via `resetAllFactors`. Closes the #1367 login hole (a "deleted" user
 * could still log in) and the RMM-QA-166 passkey leftover (a tombstone that
 * still carried a stranger's credential).
 *
 * MUST run under a SYSTEM DB access context, on the caller's `tx`: the orphan
 * check has to see memberships across EVERY tenant (an org admin's RLS view
 * hides partner memberships and other orgs' rows, so a request-scoped check
 * would falsely report a still-active multi-org user as orphaned and wrongly
 * disable them), the just-deleted membership — still uncommitted on this
 * connection — must be visible to the SELECTs below, and `resetAllFactors`
 * itself throws outside system context (its passkey DELETE would silently
 * match zero rows under RLS).
 *
 * Contract with callers (D3): this function NEVER advances epochs or revokes
 * refresh families. Callers do that first —
 * `advanceUserEpochs(tx, id, { auth: true, mfa: true })` then
 * `revokeAllRefreshFamilies(tx, id, 'membership-removed')` — and call this
 * LAST, so the global lock order user → families → factor rows holds. Both
 * current callers (`routes/users.ts` removeMembershipForScope and
 * `routes/accessReviews.ts` completion) follow that order.
 */
export async function neutralizeUserIfOrphaned(tx: Tx, userId: string): Promise<NeutralizationResult> {
  const [partnerLink] = await tx
    .select({ id: partnerUsers.id })
    .from(partnerUsers)
    .where(eq(partnerUsers.userId, userId))
    .limit(1);
  if (partnerLink) return { neutralized: false };

  const [orgLink] = await tx
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(eq(organizationUsers.userId, userId))
    .limit(1);
  if (orgLink) return { neutralized: false };

  await tx
    .update(users)
    .set({
      status: 'disabled',
      disabledReason: 'removed',
      passwordHash: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  const inventory = await resetAllFactors(tx, userId);
  return { neutralized: true, inventory };
}
```

- [ ] **Step 4: GREEN + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/services/userNeutralization.test.ts` → PASS (3 tests).
Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` → exits 0.

- [ ] **Step 5: Mutation controls (apply → fail → `git checkout -- apps/api/src/services/userNeutralization.ts` → green)**

  1. Move `const inventory = await resetAllFactors(tx, userId);` above the status UPDATE → the order test fails (`'resetAllFactors'` before `'update-users'`). Record.
  2. Remove the `if (orgLink) return …` line → the org short-circuit test fails (`update` called). Record.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/userNeutralization.ts apps/api/src/services/userNeutralization.test.ts
git commit -m "feat(auth): userNeutralization service — orphan neutralization strips every factor (RMM-QA-166 D5)

neutralizeUserIfOrphaned moves out of routes/users.ts (unchanged orphan
check), disables + de-passwords the row, then calls resetAllFactors on the
same tx. Callers own epochs/families and call it last (D3). routes/users.ts
still carries its local copy until Task 7 rewires it.

RED (before): <paste from T5-neutralization.txt>
Mutation control: <paste the two observed failures>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 6: Admin reset route — inventory gate, composite, audit from inventory (D6, D7; U-1..U-4)

**Files:**
- Modify: `apps/api/src/routes/users.ts:45` (import), `:1733-1810` (reset route)
- Modify: `apps/api/src/routes/users.test.ts` reset describe (`:2113-2237`)

**Interfaces:**
- Consumes: `resetAllFactorsAndInvalidate` (Task 4); `userIsMfaProtected` (already imported at `users.ts:41`); `TEARDOWN_FAILED`.
- Produces: audit `user.mfa_reset` details `{ method, factors: { totp, sms, recoveryCodes, phone, passkeys }, passkeysDeleted, mfaEpoch, teardownFailed, pendingSweepOk }`.

- [ ] **Step 1: Rewrite the reset describe's tests (RED)**

In `users.test.ts` inside `describe('POST /users/:id/mfa/reset …')`: delete `mockMfaState`; replace the four existing `it(...)` blocks with these six (keep `mockScopedUser` and the Task 2 `mockFactorChangeTx`):

```ts
    it('U-1: resets a passkey-only target even when users.mfaEnabled is false (inventory gate, not the column)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockScopedUser(true));
      userIsMfaProtectedMock.mockResolvedValue(true);
      const { capturedUpdates, calls } = mockFactorChangeTx({
        inventory: { mfaEnabled: false, mfaMethod: null },
        passkeyRows: [{ id: 'pk-1', credentialId: 'cred-1', name: 'Lost key' }],
      });

      const res = await app.request(`/users/${TARGET}/mfa/reset`, { method: 'POST', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      expect(userIsMfaProtectedMock).toHaveBeenCalledWith(TARGET);
      // Cross-user write went through the system-context escape.
      expect(runOutsideDbContext).toHaveBeenCalled();
      expect(withSystemDbAccessContext).toHaveBeenCalled();
      // One transaction: mfa_epoch bump → families → users clear → passkey delete.
      expect(calls).toEqual(['epochs', 'families', 'clear-factors', 'delete-passkeys']);
      expect(capturedUpdates.some((v) => v.mfaEnabled === false && v.mfaSecret === null && v.phoneNumber === null && v.phoneVerified === false)).toBe(true);
      expect(capturedUpdates.some((v) => 'mfaEpoch' in v)).toBe(true);
      expect(capturedUpdates.some((v) => 'revokedReason' in v)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith(TARGET);
      expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
        action: 'user.mfa_reset', resourceId: TARGET, actorId: 'user-123',
        details: expect.objectContaining({ method: 'passkey', passkeysDeleted: 1, mfaEpoch: 7, pendingSweepOk: true }),
      }));
    });

    it('U-2: resets every factor for a mixed TOTP+SMS+recovery+two-passkey target and audits each deleted credential', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockScopedUser(true));
      userIsMfaProtectedMock.mockResolvedValue(true);
      const { capturedUpdates } = mockFactorChangeTx({
        inventory: { mfaEnabled: true, mfaMethod: 'sms', mfaSecret: 'enc', mfaRecoveryCodes: ['h1'], phoneNumber: '+15550100', phoneVerified: true },
        passkeyRows: [{ id: 'pk-1', credentialId: 'cred-1', name: 'A' }, { id: 'pk-2', credentialId: 'cred-2', name: 'B' }],
      });

      const res = await app.request(`/users/${TARGET}/mfa/reset`, { method: 'POST', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      const clear = capturedUpdates.find((v) => 'mfaSecret' in v)!;
      expect(clear).toMatchObject({ mfaSecret: null, mfaEnabled: false, mfaMethod: null, mfaRecoveryCodes: null, phoneNumber: null, phoneVerified: false });
      const audit = createAuditLogAsyncMock.mock.calls.find(([p]) => p.action === 'user.mfa_reset')![0];
      expect(audit.details).toMatchObject({
        method: 'sms',
        factors: { totp: true, sms: true, recoveryCodes: true, phone: true, passkeys: [{ id: 'pk-1', credentialId: 'cred-1', name: 'A' }, { id: 'pk-2', credentialId: 'cred-2', name: 'B' }] },
        passkeysDeleted: 2,
        teardownFailed: false,
      });
    });

    it('U-3: sweeps mfa:setup and both passkey challenge keys after the transaction committed', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockScopedUser(true));
      userIsMfaProtectedMock.mockResolvedValue(true);
      mockFactorChangeTx({ inventory: { mfaEnabled: true, mfaMethod: 'totp', mfaSecret: 'enc' } });
      const redis = getRedis() as unknown as { del: ReturnType<typeof vi.fn> };

      const res = await app.request(`/users/${TARGET}/mfa/reset`, { method: 'POST', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      expect(redis.del).toHaveBeenCalledWith(`mfa:setup:${TARGET}`, `passkey:challenge:registration:${TARGET}`, `passkey:challenge:authentication:${TARGET}`);
      expect(redis.del.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(db.transaction).mock.invocationCallOrder[0]);
    });

    it('U-4: 400s when the inventory is empty (no enabled factor AND no live passkey) and opens no transaction', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockScopedUser(true));
      userIsMfaProtectedMock.mockResolvedValue(false);

      const res = await app.request(`/users/${TARGET}/mfa/reset`, { method: 'POST', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'MFA is not enabled for this user' });
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });

    it('refuses to reset the caller’s own MFA (must use self-service disable)', async () => {
      vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
        c.set('auth', { scope: 'partner', partnerId: 'partner-123', orgId: null, user: { id: TARGET, email: 'target@example.com' } });
        return next();
      });
      const res = await app.request(`/users/${TARGET}/mfa/reset`, { method: 'POST', headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(400);
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });

    it('404s for a target outside the caller’s tenant (no cross-tenant reset; no inventory probe)', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockScopedUser(false));
      const res = await app.request(`/users/${TARGET}/mfa/reset`, { method: 'POST', headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(404);
      expect(userIsMfaProtectedMock).not.toHaveBeenCalled();
      expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run — RED**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts -t "mfa/reset" 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T6-reset-route.txt"`
Expected: U-1 FAIL `expected 200, received 400` (column gate: the route's own `mfaState` select is consumed from the default `db.select` chain → `[]` → 400); U-2 FAIL same; U-3 FAIL same; U-4 PASSES by accident of the column gate (documented in spec §8 — its discriminator is U-1); the two negative cases pass.

- [ ] **Step 3: Implement the route (`users.ts:1733-1810`)**

Replace the import at line 45 `import { invalidateMfaAssuranceAfterFactorChange } from '../services/mfaAssurance';` with:
```ts
import { resetAllFactorsAndInvalidate } from '../services/mfaFactorReset';
```
(`invalidateMfaAssuranceAfterFactorChange` has no other use in `users.ts` — verify with `grep -n invalidateMfaAssuranceAfterFactorChange apps/api/src/routes/users.ts` → only a comment may remain; delete that comment line too.)

Replace the route body from `const record = await getScopedUser(userId, scopeContext);` to the end of the handler with:
```ts
    // Tenant boundary: getScopedUser only resolves a target that has a
    // membership in the caller's org/partner, so an admin cannot reset a user
    // outside their tenant (RLS on `users` is the second line of defense).
    const record = await getScopedUser(userId, scopeContext);
    if (!record) {
      return c.json({ error: 'User not found' }, 404);
    }

    // RMM-QA-166 (D6): the gate is the factor INVENTORY, not `users.mfa_enabled`.
    // userIsMfaProtected = mfa_enabled OR a live user_passkeys row — the same
    // predicate every enrollment gate uses. A passkey-only leftover (enabled
    // flag already cleared, passkey rows still present) must be resettable,
    // otherwise the account stays "protected" by a credential nobody holds.
    if (!(await userIsMfaProtected(userId))) {
      return c.json({ error: 'MFA is not enabled for this user' }, 400);
    }

    // Cross-user write: clear EVERY factor (TOTP secret, method, recovery
    // codes, phone, and all passkey rows) + advance mfa_epoch (kills the
    // target's live access/refresh JWTs and epoch-bound step-up grants) +
    // revoke refresh families + post-commit token/OAuth cutoff + remote-session
    // teardown + pending-artifact sweep. The composite runs under system
    // context — the target's `refresh_token_families` and `user_passkeys` rows
    // are user-scoped RLS and the admin's ambient context would write zero of
    // them (see services/mfaFactorReset.ts).
    const result = await resetAllFactorsAndInvalidate(userId, 'admin-mfa-reset');
    const { inventory } = result;

    writeUserAudit(c, auth, scopeContext, {
      action: 'user.mfa_reset',
      resourceId: userId,
      resourceName: record.email,
      details: {
        method: inventory.previousMethod ?? (inventory.passkeysDeleted > 0 ? 'passkey' : 'totp'),
        factors: {
          totp: inventory.hadTotp,
          sms: inventory.hadSms,
          recoveryCodes: inventory.hadRecoveryCodes,
          phone: inventory.hadPhone,
          passkeys: inventory.passkeys
        },
        passkeysDeleted: inventory.passkeysDeleted,
        mfaEpoch: result.mfaEpoch,
        teardownFailed: result.remoteSessionsTerminated === TEARDOWN_FAILED,
        pendingSweepOk: result.pendingSweepOk
      }
    });

    return c.json({ success: true, message: 'MFA reset for user' });
  }
);
```
Update the route's leading comment block (`users.ts:1716-1732`) by appending one bullet:
```ts
//  - RMM-QA-166: gated on the factor inventory (userIsMfaProtected), not the
//    mfa_enabled column, and strips passkeys too — a reset must leave NO factor.
```

- [ ] **Step 4: GREEN + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts` → all PASS (whole file, not just the describe).
Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` → exits 0.

- [ ] **Step 5: Mutation controls (apply → fail → `git checkout -- <file>` → green)**

  1. In `services/mfaFactorReset.ts` comment out the `tx.delete(userPasskeys)` statement (return `const deleted: Array<{id:string;credentialId:string;name:string|null}> = [];`) → U-1 fails on `calls` (`'delete-passkeys'` missing) and U-2 on `passkeysDeleted`. Record; revert.
  2. In `users.ts` replace the gate with `if (!(await userIsMfaProtected(userId)) && false)` → U-4 fails (200, transaction opened). Record; revert.
  3. In `users.ts` drop `pendingSweepOk` from the audit details → U-1 fails on the audit `objectContaining`. Record; revert.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts
git commit -m "fix(auth): admin MFA reset gates on the factor inventory and strips passkeys (RMM-QA-166 D6/D7)

POST /users/:id/mfa/reset now refuses only when userIsMfaProtected is false
(no enabled factor AND no live passkey), runs resetAllFactorsAndInvalidate
(system context, one tx: mfa_epoch → families → users clear → passkey DELETE)
and writes user.mfa_reset from the returned inventory (factors, passkeysDeleted,
deleted credential ids, pendingSweepOk) with actorId = the admin.

RED (before): <paste U-1/U-2/U-3 lines from T6-reset-route.txt>
Mutation control: <paste the three observed failures>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 7: Membership removal — epochs `{auth, mfa}` → families → neutralize via the service (D3, D5; U-5, U-6)

**Files:**
- Modify: `apps/api/src/routes/users.ts:1579-1619` (delete local `neutralizeUserIfOrphaned` + its comment block), `:1643-1664` (`removeMembershipForScope` order), imports
- Modify: `apps/api/src/routes/users.test.ts` DELETE describe (`:1995-2111`)

**Interfaces:**
- Consumes: `neutralizeUserIfOrphaned` from `../services/userNeutralization` (Task 5).

- [ ] **Step 1: Add U-5 and U-6 to the DELETE describe (RED)**

Append inside `describe('DELETE /users/:id …')`:
```ts
    it('U-5: advances {auth, mfa} epochs + revokes families BEFORE neutralizing, and deletes an orphan’s passkeys', async () => {
      const TARGET = '11111111-1111-1111-1111-111111111111';
      const { capturedUpdates, calls } = mockRemoveMembershipTx({
        deletedRows: [{ id: 'link-1' }], hasOtherMembership: false, targetId: TARGET,
        passkeyRows: [{ id: 'pk-1', credentialId: 'cred-1', name: null }],
      });

      const res = await app.request(`/users/${TARGET}`, { method: 'DELETE', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      expect(calls).toEqual(['delete-membership', 'epochs', 'families', 'neutralize', 'clear-factors', 'delete-passkeys']);
      const epochs = capturedUpdates.find((v) => 'authEpoch' in v)!;
      expect(epochs).toHaveProperty('mfaEpoch'); // D3: neutralization bumps BOTH epochs
      expect(capturedUpdates.filter((v) => 'authEpoch' in v)).toHaveLength(1); // exactly one bump — no double-bump
      expect(capturedUpdates.some((v) => v.status === 'disabled' && v.passwordHash === null)).toBe(true);
      expect(capturedUpdates.some((v) => v.mfaEnabled === false && v.phoneNumber === null)).toBe(true);
      expect(runPostCommitCleanup).toHaveBeenCalledWith(TARGET);
    });

    it('U-6: a user with another membership is not neutralized and keeps their passkeys', async () => {
      const { capturedUpdates, calls } = mockRemoveMembershipTx({ deletedRows: [{ id: 'link-1' }], hasOtherMembership: true });

      const res = await app.request('/users/11111111-1111-1111-1111-111111111111', { method: 'DELETE', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      expect(calls).toEqual(['delete-membership', 'epochs', 'families']);
      expect(capturedUpdates.some((v) => v.status === 'disabled')).toBe(false);
      expect(calls).not.toContain('delete-passkeys');
    });
```

- [ ] **Step 2: Run — RED**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts -t "DELETE /users/:id" 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T7-membership.txt"`
Expected: U-5 FAIL — `calls` equals `['delete-membership', 'neutralize', 'epochs', 'families']` (neutralize first, no passkey delete, no `mfaEpoch`); U-6 FAIL — `calls` equals `['delete-membership', 'epochs', 'families']`? No: today the orphan check runs first and, with a remaining link, short-circuits — so U-6 may pass on main; its discriminator is the `hasOtherMembership` branch of D5 and the Task 5 unit test. Record whatever is observed.

- [ ] **Step 3: Implement in `users.ts`**

1. Delete the local `async function neutralizeUserIfOrphaned(…)` (lines 1591-1619) **and** its preceding comment block (from `// Neutralize an orphaned user …` through the line before the function; lines 1579-1590).
2. Add the import next to the Task 6 import:
```ts
import { neutralizeUserIfOrphaned } from '../services/userNeutralization';
```
3. In `removeMembershipForScope`, replace
```ts
        await neutralizeUserIfOrphaned(tx, userId);
        await advanceUserEpochs(tx, userId, { auth: true });
        await revokeAllRefreshFamilies(tx, userId, 'membership-removed');
        return { deleted: true };
```
with
```ts
        // D3 (RMM-QA-166): epochs → families → factor rows. Both epochs advance:
        // `auth` because the membership set changed, `mfa` because an orphan's
        // factors are about to be stripped (kills epoch-bound step-up grants and
        // pending logins by construction). neutralizeUserIfOrphaned runs LAST and
        // never bumps epochs itself, so there is exactly one bump per removal.
        await advanceUserEpochs(tx, userId, { auth: true, mfa: true });
        await revokeAllRefreshFamilies(tx, userId, 'membership-removed');
        await neutralizeUserIfOrphaned(tx, userId);
        return { deleted: true };
```
4. In the `removeMembershipForScope` docstring, change "orphan neutralize, epoch advance and refresh-family revoke" to "epoch advance, refresh-family revoke and orphan neutralize (incl. every MFA factor and passkey — RMM-QA-166)".
5. If `Tx` from `../services/authLifecycle` is now unused in `users.ts` (`grep -n "Tx\b" apps/api/src/routes/users.ts`), drop `type Tx` from that import.

- [ ] **Step 4: GREEN + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts src/services/userNeutralization.test.ts` → PASS.
Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` → exits 0.
Run: `grep -n "neutralizeUserIfOrphaned" apps/api/src/routes/users.ts` → exactly the import line and the one call.

- [ ] **Step 5: Mutation controls (apply → fail → `git checkout -- apps/api/src/routes/users.ts` → green)**

  1. Swap the order back (neutralize before `advanceUserEpochs`) → U-5 `calls` assertion fails. Record.
  2. Change `{ auth: true, mfa: true }` to `{ auth: true }` → U-5 `toHaveProperty('mfaEpoch')` fails. Record.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts
git commit -m "fix(auth): membership removal bumps {auth,mfa} then families then neutralizes incl. passkeys (RMM-QA-166 D3/D5)

removeMembershipForScope now orders epochs → families → neutralizeUserIfOrphaned
(services/userNeutralization) so an orphan loses password, TOTP, recovery,
phone and every user_passkeys row in the same system-scoped transaction. The
local neutralize copy in routes/users.ts is deleted.

RED (before): <paste from T7-membership.txt>
Mutation control: <paste the two observed failures>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 8: Invite — tombstone pre-flight reset before the ambient-context transaction (D9; U-7)

**Files:**
- Modify: `apps/api/src/routes/users.ts:1183-1252` (invite handler: pre-flight before `db.transaction`; phone parity in the tombstone branch)
- Modify: `apps/api/src/routes/users.test.ts` (`../services/mfaFactorReset` spy mock; U-7 in the invite describe)

**Interfaces:**
- Consumes: `resetAllFactorsAndInvalidate` (Task 4).

- [ ] **Step 1: Add the pass-through spy mock and U-7 (RED)**

Near the other `vi.mock` calls in `users.test.ts` (after the `../services/pendingEmail` mock) add:
```ts
// RMM-QA-166: spy on the admin composite so the invite pre-flight can be
// observed without stubbing the tx-level behavior the reset tests exercise.
const { resetAllFactorsAndInvalidateMock } = vi.hoisted(() => ({ resetAllFactorsAndInvalidateMock: vi.fn() }));
vi.mock('../services/mfaFactorReset', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/mfaFactorReset')>();
  resetAllFactorsAndInvalidateMock.mockImplementation(actual.resetAllFactorsAndInvalidate);
  return { ...actual, resetAllFactorsAndInvalidate: resetAllFactorsAndInvalidateMock };
});
```
Append inside `describe('POST /users/invite')`:
```ts
    it('U-7: a tombstone email pre-flights the composite factor reset BEFORE the invite transaction', async () => {
      const TOMBSTONE = '44444444-4444-4444-4444-444444444444';
      // Selects before the transaction, in order: scoped role, parent role,
      // partner-wide gate membership, then the NEW tombstone pre-flight.
      vi.mocked(db.select)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: '22222222-2222-2222-2222-222222222222', scope: 'partner', name: 'Admin', description: null, isSystem: true, partnerId: null, orgId: null }]) }) }) } as any)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ parentRoleId: null }]) }) }) } as any)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }) } as any)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: TOMBSTONE, status: 'disabled', passwordHash: null }]) }) }) } as any);
      resetAllFactorsAndInvalidateMock.mockResolvedValueOnce({
        mfaEpoch: 3, cleanup: { redisOk: true, permissionCacheOk: true, oauthOk: true }, remoteSessionsTerminated: 0, pendingSweepOk: true,
        inventory: { wasEnabled: false, previousMethod: null, hadTotp: false, hadSms: false, hadRecoveryCodes: false, hadPhone: true, passkeys: [{ id: 'pk', credentialId: 'c', name: null }], passkeysDeleted: 1 },
      });

      const capturedTxSets: Array<Record<string, unknown>> = [];
      const txSelect = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: TOMBSTONE, email: 'revive@example.com', status: 'disabled', passwordHash: null }]) }) }) });
      const txUpdate = vi.fn(() => ({ set: (values: Record<string, unknown>) => { capturedTxSets.push(values); return { where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: TOMBSTONE, email: 'revive@example.com', name: 'Revived', status: 'invited' }]) }) }; } }));
      const txInsert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'link-1' }]) }) });
      vi.mocked(db.transaction).mockImplementation(async (fn) => fn({ select: txSelect, update: txUpdate, insert: txInsert } as any));

      const res = await app.request('/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'revive@example.com', name: 'Revived', roleId: '22222222-2222-2222-2222-222222222222', orgAccess: 'none' })
      });

      expect(res.status).toBe(201);
      expect(resetAllFactorsAndInvalidateMock).toHaveBeenCalledWith(TOMBSTONE, 'invite-resurrect');
      expect(resetAllFactorsAndInvalidateMock.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(db.transaction).mock.invocationCallOrder[0]);
      // Phone parity in the in-tx tombstone branch.
      expect(capturedTxSets.some((v) => v.status === 'invited' && v.phoneNumber === null && v.phoneVerified === false)).toBe(true);
    });

    it('U-7b: an existing ACTIVE user (multi-scope add) is not pre-flight reset', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: '22222222-2222-2222-2222-222222222222', scope: 'partner', name: 'Admin', description: null, isSystem: true, partnerId: null, orgId: null }]) }) }) } as any)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ parentRoleId: null }]) }) }) } as any)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }) } as any)
        .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: '55555555-5555-5555-5555-555555555555', status: 'active', passwordHash: 'hash' }]) }) }) } as any);
      const txSelect = vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: '55555555-5555-5555-5555-555555555555', email: 'active@example.com', status: 'active', passwordHash: 'hash' }]) }) }) });
      const txInsert = vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'link-1' }]) }) });
      vi.mocked(db.transaction).mockImplementation(async (fn) => fn({ select: txSelect, insert: txInsert } as any));

      const res = await app.request('/users/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'active@example.com', name: 'Active', roleId: '22222222-2222-2222-2222-222222222222', orgAccess: 'none' })
      });

      expect(res.status).toBe(201);
      expect(resetAllFactorsAndInvalidateMock).not.toHaveBeenCalled();
    });
```
(If the existing invite test's `db.select` sequencing changes because the pre-flight consumes a fourth select, extend that test's chain with a fourth `mockReturnValueOnce` returning `limit → []` — the pre-flight sees no existing user and does nothing.)

- [ ] **Step 2: Run — RED**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts -t "POST /users/invite" 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T8-invite.txt"`
Expected: U-7 FAIL — `resetAllFactorsAndInvalidateMock` never called (`toHaveBeenCalledWith` → 0 calls).

- [ ] **Step 3: Implement in `users.ts` (invite handler)**

Immediately before `const result = await db.transaction(async (tx) => {` (line ~1184) insert:
```ts
    // RMM-QA-166 (D9): a neutralized tombstone (disabled + no password) may still
    // carry factor rows — user_passkeys left by pre-fix neutralization or by the
    // 2026-06-18 backfill, a verified phone, a stale secret. The invite
    // transaction below runs in the caller's AMBIENT context, where a
    // user_passkeys DELETE silently matches zero rows under RLS (and the reset
    // service refuses to run). So sweep every factor through the system-context
    // composite BEFORE opening the invite transaction. Same visibility as the
    // in-tx lookup: both read `users` by email under the caller's context. A
    // tombstone cannot acquire factors between here and the resurrect (no
    // password, disabled, epochs bumped — no token can be minted), and a
    // failure here fails the invite before any write.
    const [tombstone] = await db
      .select({ id: users.id, status: users.status, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);
    if (tombstone && tombstone.status === 'disabled' && tombstone.passwordHash === null) {
      await resetAllFactorsAndInvalidate(tombstone.id, 'invite-resurrect');
    }
```
In the in-tx tombstone branch's `.set({...})` (line ~1230) add after `mfaRecoveryCodes: null,`:
```ts
            phoneNumber: null,
            phoneVerified: false,
```
and extend that branch's comment with: `// Factor rows (incl. passkeys) were already swept by the pre-flight above (RMM-QA-166).`

- [ ] **Step 4: GREEN + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts` → PASS.
Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` → exits 0.

- [ ] **Step 5: Mutation controls (apply → fail → `git checkout -- apps/api/src/routes/users.ts` → green)**

  1. Move the pre-flight block to AFTER the `db.transaction(...)` call → U-7's `invocationCallOrder` assertion fails. Record.
  2. Change the predicate to `tombstone.status === 'disabled'` only (drop the password check) → U-7b passes still (status active) — so instead change it to `tombstone.status === 'active'` → U-7 fails (not called) and U-7b fails (called). Record.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts
git commit -m "fix(auth): invite pre-flights a full factor reset for a tombstone before resurrecting it (RMM-QA-166 D9)

POST /users/invite looks the email up before the ambient-context invite
transaction and, for a disabled + password-less tombstone, runs
resetAllFactorsAndInvalidate(id, 'invite-resurrect') so stale passkeys/phone
are gone before status flips to invited; the in-tx branch also clears phone.

RED (before): <paste from T8-invite.txt>
Mutation control: <paste the two observed failures>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 9: `GET /users` exposes `mfaProtected` from tenant-resolved ids (D11; U-8)

**Files:**
- Modify: `apps/api/src/routes/users.ts:7` (drizzle imports), `:11` (schema import), `:1027-1074` (list route) + new helper `annotateMfaProtected`
- Modify: `apps/api/src/routes/users.test.ts` `describe('GET /users')` (`:363-419`)

**Interfaces:**
- Produces: each `GET /users` row gains `mfaProtected: boolean` (= `mfaEnabled || live passkey`); helper `annotateMfaProtected<T extends { id: string; mfaEnabled: boolean }>(rows: T[]): Promise<Array<T & { mfaProtected: boolean }>>`.

- [ ] **Step 1: Rewrite the list tests (RED)**

Replace `it('should list partner users', …)` with:
```ts
    const MEMBER = '11111111-1111-1111-1111-111111111111';
    function mockTenantList(rows: Array<Record<string, unknown>>) {
      return { from: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) }) }) } as any;
    }
    function mockPasskeyProbe(rows: Array<{ userId: string }>) {
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }) } as any;
    }

    it('should list partner users with mfaProtected derived from mfaEnabled when no passkeys exist', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockTenantList([{ id: MEMBER, email: 'user@example.com', name: 'Partner User', status: 'active', mfaEnabled: true, roleId: 'role-1', roleName: 'Admin', orgAccess: 'all', orgIds: null }]))
        .mockReturnValueOnce(mockPasskeyProbe([]));

      const res = await app.request('/users', { method: 'GET', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ email: 'user@example.com', mfaEnabled: true, mfaProtected: true });
    });

    it('U-8: a passkey-only member (mfaEnabled=false) is reported mfaProtected=true; the probe runs under system context AFTER the tenant select and only over its ids', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce(mockTenantList([
          { id: MEMBER, email: 'pk@example.com', name: 'Passkey Only', status: 'active', mfaEnabled: false, roleId: 'role-1', roleName: 'Tech', orgAccess: 'none', orgIds: null },
          { id: '22222222-2222-2222-2222-222222222222', email: 'plain@example.com', name: 'Plain', status: 'active', mfaEnabled: false, roleId: 'role-1', roleName: 'Tech', orgAccess: 'none', orgIds: null },
        ]))
        .mockReturnValueOnce(mockPasskeyProbe([{ userId: MEMBER }]));

      const res = await app.request('/users', { method: 'GET', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.find((u: any) => u.id === MEMBER)).toMatchObject({ mfaEnabled: false, mfaProtected: true });
      expect(body.data.find((u: any) => u.id !== MEMBER)).toMatchObject({ mfaEnabled: false, mfaProtected: false });
      // C4: the system-context read is keyed to the ids the tenant join returned.
      const selectOrder = vi.mocked(db.select).mock.invocationCallOrder;
      const sysOrder = vi.mocked(withSystemDbAccessContext).mock.invocationCallOrder[0];
      expect(sysOrder).toBeGreaterThan(selectOrder[0]);
      expect(sysOrder).toBeLessThan(selectOrder[1]);
      expect(vi.mocked(inArray)).toHaveBeenCalledWith(userPasskeys.userId, [MEMBER, '22222222-2222-2222-2222-222222222222']);
    });

    it('issues no passkey probe (no system-context read) when the tenant has no members', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockTenantList([]));

      const res = await app.request('/users', { method: 'GET', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([]);
      expect(withSystemDbAccessContext).not.toHaveBeenCalled();
      expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
    });
```
Keep `it('should reject missing partner/org context', …)` unchanged.

- [ ] **Step 2: Run — RED**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts -t "GET /users" 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T9-list.txt"`
Expected: first test FAIL (`mfaProtected` undefined), U-8 FAIL (`mfaProtected` undefined / `withSystemDbAccessContext` never called), empty-list test PASS.

- [ ] **Step 3: Implement in `users.ts`**

Line 7: `import { and, eq, inArray, isNull, or } from 'drizzle-orm';`
Line 11: add `userPasskeys` to the `../db/schema` import list.

Add above `userRoutes.get('/', …)` (before line ~1027):
```ts
/**
 * RMM-QA-166 (D11): `mfaProtected` = mfa_enabled OR a live (non-disabled)
 * user_passkeys row — the same predicate `userIsMfaProtected` applies — so the
 * operator UI can offer "Reset MFA" for a passkey-only leftover whose
 * mfa_enabled flag was already cleared. The passkey probe runs under system
 * context (user_passkeys RLS is self-or-system) but ONLY over the ids the
 * caller's own tenant-scoped membership join just returned — it never widens
 * the row set (precedent: routes/sso.ts member passkey annotation).
 */
async function annotateMfaProtected<T extends { id: string; mfaEnabled: boolean }>(
  rows: T[]
): Promise<Array<T & { mfaProtected: boolean }>> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const passkeyRows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ userId: userPasskeys.userId })
        .from(userPasskeys)
        .where(and(inArray(userPasskeys.userId, ids), isNull(userPasskeys.disabledAt)))
    )
  );
  const withPasskey = new Set(passkeyRows.map((row) => row.userId));
  return rows.map((row) => ({ ...row, mfaProtected: row.mfaEnabled === true || withPasskey.has(row.id) }));
}
```
In the list route replace both `return c.json({ data });` with `return c.json({ data: await annotateMfaProtected(data) });`.

- [ ] **Step 4: GREEN + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts` → PASS.
Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` → exits 0.

- [ ] **Step 5: Mutation controls (apply → fail → `git checkout -- apps/api/src/routes/users.ts` → green)**

  1. Change the map to `mfaProtected: row.mfaEnabled === true` (ignore the probe) → U-8 fails (`mfaProtected: false` for the passkey-only member). Record.
  2. Remove `isNull(userPasskeys.disabledAt)` → no unit test can see it (the mock ignores predicates) — this predicate is covered by I-2/I-6 semantics only via `userIsMfaProtected`; record it as **not mutation-provable at unit level** and rely on the grep tripwire in Task 13 (`grep -n "isNull(userPasskeys.disabledAt)" apps/api/src/routes/users.ts` → 1 hit).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts
git commit -m "feat(users): GET /users reports mfaProtected (mfa_enabled OR live passkey) per tenant-resolved id (RMM-QA-166 D11)

RED (before): <paste from T9-list.txt>
Mutation control: <paste mutation 1; note mutation 2 as tripwire-only>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 10: Access-review completion neutralizes orphaned revoked users (D3, D5; U-9, U-10)

**Files:**
- Modify: `apps/api/src/routes/accessReviews.ts:20` (imports), `:475-478` (per-user loop), `:497-500` (result), `:531-537` (audit details)
- Modify: `apps/api/src/routes/accessReviews.test.ts` (`writeRouteAudit` mock; U-9, U-10)

**Interfaces:**
- Consumes: `neutralizeUserIfOrphaned` (Task 5).
- Produces: `access_review.complete` audit details gain `neutralizedUserIds: string[]`.

- [ ] **Step 1: Add the audit mock and U-9/U-10 (RED)**

After the `../services/authLifecycle` mock in `accessReviews.test.ts` add:
```ts
const { writeRouteAuditMock } = vi.hoisted(() => ({ writeRouteAuditMock: vi.fn() }));
vi.mock('../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/auditEvents')>()),
  writeRouteAudit: writeRouteAuditMock,
}));
```
Append inside `describe('POST /access-reviews/:id/complete')`:
```ts
    it('U-9: a revoked user with no remaining membership is neutralized (disabled, no password, passkeys deleted) AFTER {auth,mfa} epochs + families, and is named in the audit', async () => {
      seedReviewSelects([{ userId: 'user-1' }]);
      const { capturedUpdates, capturedDeletes } = mockCompleteTx({ hasOtherMembership: false, passkeyRows: [{ id: 'pk-1', credentialId: 'cred-1', name: null }] });

      const res = await app.request('/access-reviews/review-1/complete', { method: 'POST', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      const epochIdx = capturedUpdates.findIndex((v) => 'authEpoch' in v);
      const familyIdx = capturedUpdates.findIndex((v) => 'revokedReason' in v);
      const neutralizeIdx = capturedUpdates.findIndex((v) => v.status === 'disabled' && v.passwordHash === null);
      const clearIdx = capturedUpdates.findIndex((v) => v.mfaEnabled === false && v.mfaSecret === null);
      expect(epochIdx).toBeGreaterThanOrEqual(0);
      expect(capturedUpdates[epochIdx]).toHaveProperty('mfaEpoch'); // D3: both epochs
      expect(familyIdx).toBeGreaterThan(epochIdx);
      expect(neutralizeIdx).toBeGreaterThan(familyIdx);
      expect(clearIdx).toBeGreaterThan(neutralizeIdx);
      expect(capturedDeletes).toContain(userPasskeys);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'access_review.complete',
        details: expect.objectContaining({ revokedUserIds: ['user-1'], neutralizedUserIds: ['user-1'] }),
      }));
    });

    it('U-10: a revoked user who still holds another membership is NOT neutralized and keeps passkeys', async () => {
      seedReviewSelects([{ userId: 'user-1' }]);
      const { capturedUpdates, capturedDeletes } = mockCompleteTx({ hasOtherMembership: true });

      const res = await app.request('/access-reviews/review-1/complete', { method: 'POST', headers: { Authorization: 'Bearer token' } });

      expect(res.status).toBe(200);
      expect(capturedUpdates.some((v) => v.status === 'disabled')).toBe(false);
      expect(capturedDeletes).not.toContain(userPasskeys);
      expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({ neutralizedUserIds: [] }),
      }));
    });
```

- [ ] **Step 2: Run — RED**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/accessReviews.test.ts 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T10-access-reviews.txt"`
Expected: U-9 FAIL (`neutralizeIdx` is -1; no `mfaEpoch` on the epoch update); U-10 FAIL on `neutralizedUserIds` (details lack the key). Existing completion tests still PASS.

- [ ] **Step 3: Implement in `accessReviews.ts`**

Line 20 area, add:
```ts
import { neutralizeUserIfOrphaned } from '../services/userNeutralization';
```
Replace the per-user loop (lines ~475-478):
```ts
            for (const userId of uniqueRevokedUserIds) {
              // D3/D5 (RMM-QA-166): epochs {auth, mfa} → families → neutralize.
              // A user whose LAST membership anywhere was just revoked is an
              // orphan and is neutralized exactly as DELETE /users/:id does —
              // disabled, no password, every factor incl. passkeys stripped.
              // The orphan check is valid cross-tenant because this transaction
              // is system-scoped; a user with a remaining membership elsewhere
              // is untouched.
              await advanceUserEpochs(tx, userId, { auth: true, mfa: true });
              await revokeAllRefreshFamilies(tx, userId, 'membership-removed');
              const { neutralized } = await neutralizeUserIfOrphaned(tx, userId);
              if (neutralized) neutralizedUserIds.push(userId);
            }
```
Declare `const neutralizedUserIds: string[] = [];` as the first line inside the `db.transaction(async (tx) => {` callback. Change the returned object to `return { review: updatedReview, revokedCount: revokedItems.length, neutralizedUserIds };`. In `writeRouteAudit` details: `details: { revokedCount: result.revokedCount, revokedUserIds: uniqueRevokedUserIds, neutralizedUserIds: result.neutralizedUserIds }`.

- [ ] **Step 4: GREEN + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/accessReviews.test.ts` → PASS.
Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` → exits 0.

- [ ] **Step 5: Mutation controls (apply → fail → `git checkout -- apps/api/src/routes/accessReviews.ts` → green)**

  1. Drop `mfa: true` → U-9's `toHaveProperty('mfaEpoch')` fails. Record.
  2. Call `neutralizeUserIfOrphaned` before `advanceUserEpochs` → U-9's `neutralizeIdx > familyIdx` fails. Record.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/accessReviews.ts apps/api/src/routes/accessReviews.test.ts
git commit -m "fix(auth): access-review completion neutralizes orphaned revoked users incl. passkeys (RMM-QA-166 D5)

Per revoked user, inside the existing system-scoped tx: advanceUserEpochs
{auth,mfa} → revokeAllRefreshFamilies → neutralizeUserIfOrphaned. Behavior
change stated: revoking a user's LAST membership anywhere now disables the
account and strips password + every factor, same as DELETE /users/:id; users
with any remaining membership are untouched. Audit gains neutralizedUserIds.

RED (before): <paste from T10-access-reviews.txt>
Mutation control: <paste the two observed failures>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 11: Integration GREEN + real-Postgres mutation proofs; commit the integration suite

**Files:**
- Commit: the four files from Task 3.

- [ ] **Step 1: Run the RED suite from Task 3 — now GREEN**

Run:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/adminMfaReset.integration.test.ts \
  src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts \
  src/__tests__/integration/mfaFactorReset.integration.test.ts \
  src/__tests__/integration/userDeleteResurrect.integration.test.ts 2>&1 | tee "<scratchpad>/rmm-qa-166-red/I-all-after.txt"
```
Expected: all PASS (I-1..I-8 + the three pre-existing `#1367` tests). If I-3 fails at step 4 with anything other than a 200, debug with `superpowers:systematic-debugging` — the likeliest causes are (a) the admin token lacking `mfa: true` (requireMfa 403), (b) `aep`/`mep` not read from the live row AFTER the reset (401 `epoch_stale`), (c) the binding cookie regex not matching the `set-cookie` header (bootstrap 204 but empty cookie). None of these is a product defect.

- [ ] **Step 2: Real-Postgres mutation proofs (apply → run → fail → `git checkout -- <file>` → re-run green)**

  1. **C1 guard (I-4):** in `services/mfaFactorReset.ts` replace the guard with `if (false)` → I-4 fails: no rejection and `passkeyCount === 1` still — i.e. the executed proof that an ambient context silently deletes zero rows while reporting success. Record the exact assertion line.
  2. **Atomicity (I-5):** cannot be mutated without editing `mfaAssurance.ts` (out of scope) — the control discriminates by construction (the injected throw is inside the transaction); record "control is the injected-fault design; no product mutation applied".
  3. **D1 hard delete (I-3 step 5, I-6):** change the DELETE to `UPDATE user_passkeys SET disabled_at = now()` (`tx.update(userPasskeys).set({ disabledAt: new Date() }).where(...).returning(...)`) → I-3's same-credential insert rejects with a unique violation and I-6's `passkeyCount` is 2. Record.
  4. **D9 pre-flight (I-8):** delete the pre-flight block in `users.ts` → I-8 fails (`passkeyCount === 1`). Record.
  5. **D3 both epochs (I-7):** `{ auth: true }` only in `removeMembershipForScope` → I-7's `mfaEpoch > before` fails. Record.

- [ ] **Step 3: Run the adjacent tripwires**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/mfaAssurance.integration.test.ts \
  src/__tests__/integration/passkeyMfaVerify.integration.test.ts \
  src/__tests__/integration/mfaEnrollmentSession.integration.test.ts \
  src/__tests__/integration/refreshEpoch.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
```
Expected: all PASS (no schema/policy change; `rls-coverage` is a tripwire, not a coverage claim). If `refreshEpoch.integration.test.ts` does not exist, drop it from the list.

- [ ] **Step 4: Commit the integration suite**

```bash
git add apps/api/src/__tests__/integration/adminMfaReset.integration.test.ts apps/api/src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts apps/api/src/__tests__/integration/mfaFactorReset.integration.test.ts apps/api/src/__tests__/integration/userDeleteResurrect.integration.test.ts
git commit -m "test(auth): real-Postgres proofs for full factor reset — admin reset, re-enrollment, RLS guard, atomicity, neutralization (RMM-QA-166 I-1..I-8)

RED (before, at fcd5b498a): <paste per-test lines from I-all-before.txt>
GREEN: <paste summary line from I-all-after.txt>
Mutation control (real PG): <paste the observed failures from Step 2, incl. the C1 silent-zero-row proof>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 12: Web — Reset MFA keys on `mfaProtected` (D11; W-1..W-3)

**Files:**
- Modify: `apps/web/src/components/settings/UserList.tsx:8-16` (type), `:155` (render condition)
- Modify: `apps/web/src/components/settings/UsersPage.tsx:79` (mapping)
- Create: `apps/web/src/components/settings/UserList.test.tsx`

- [ ] **Step 1: Write the failing web test**

```tsx
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { i18n } from '@/lib/i18n';
import UserList, { type User } from './UserList';

const base: User = {
  id: 'user-1',
  name: 'Pat Example',
  email: 'pat@example.com',
  role: 'Technician',
  status: 'active',
  lastLogin: 'Never',
};

function renderRow(user: User) {
  return render(<UserList users={[user]} currentUserId="admin-1" />);
}

describe('UserList — Reset MFA visibility (RMM-QA-166)', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  afterEach(() => cleanup());

  it('W-1: shows Reset MFA for a passkey-only user (mfaEnabled=false, mfaProtected=true)', () => {
    renderRow({ ...base, mfaEnabled: false, mfaProtected: true });
    expect(screen.getByRole('button', { name: 'Reset MFA' })).toBeInTheDocument();
  });

  it('W-2: hides Reset MFA when mfaProtected=false even if a stale mfaEnabled=true is sent', () => {
    renderRow({ ...base, mfaEnabled: true, mfaProtected: false });
    expect(screen.queryByRole('button', { name: 'Reset MFA' })).toBeNull();
  });

  it('W-3: falls back to mfaEnabled when the payload has no mfaProtected (legacy API)', () => {
    renderRow({ ...base, mfaEnabled: true });
    expect(screen.getByRole('button', { name: 'Reset MFA' })).toBeInTheDocument();
    cleanup();
    renderRow({ ...base, mfaEnabled: false });
    expect(screen.queryByRole('button', { name: 'Reset MFA' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — RED**

Run: `pnpm --filter @breeze/web exec vitest run src/components/settings/UserList.test.tsx 2>&1 | tee "<scratchpad>/rmm-qa-166-red/T12-web.txt"`
Expected: W-1 FAIL (`Unable to find role="button" and name "Reset MFA"`), W-2 FAIL (button present), W-3 PASS. (TypeScript may also flag `mfaProtected` on `User` — that is part of the RED.)

- [ ] **Step 3: Implement**

`UserList.tsx` type:
```ts
export type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: UserStatus | string;
  lastLogin: string;
  mfaEnabled?: boolean;
  /**
   * RMM-QA-166: true when the account holds ANY second factor (mfa_enabled OR a
   * live passkey). Drives the Reset MFA action; `mfaEnabled` alone hides the
   * button for a passkey-only leftover the admin must be able to reset.
   * Optional so a payload from an older API still renders (falls back to mfaEnabled).
   */
  mfaProtected?: boolean;
};
```
Render condition at line 155: replace `{user.mfaEnabled && (` with `{(user.mfaProtected ?? user.mfaEnabled) && (`.

`UsersPage.tsx` line 79: after `mfaEnabled: Boolean(u.mfaEnabled),` add
```ts
        mfaProtected: Boolean(u.mfaProtected ?? u.mfaEnabled),
```

- [ ] **Step 4: GREEN + lint + typecheck**

Run: `pnpm --filter @breeze/web exec vitest run src/components/settings/UserList.test.tsx src/lib/__tests__/no-silent-mutations.test.ts` → PASS.
Run: `pnpm --filter @breeze/web exec eslint src/components/settings/UserList.tsx src/components/settings/UsersPage.tsx src/components/settings/UserList.test.tsx` → clean.
Run: `pnpm --filter @breeze/web exec tsc --noEmit` → exits 0.

- [ ] **Step 5: Mutation control (apply → fail → `git checkout -- apps/web/src/components/settings/UserList.tsx` → green)**

  1. Revert the condition to `{user.mfaEnabled && (` → W-1 and W-2 fail. Record.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/UserList.tsx apps/web/src/components/settings/UsersPage.tsx apps/web/src/components/settings/UserList.test.tsx
git commit -m "fix(web): show Reset MFA when the user is MFA-protected by any factor, incl. passkey-only (RMM-QA-166 D11)

RED (before): <paste from T12-web.txt>
Mutation control: <paste the observed failure>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 13: Verification battery, tripwires, push, draft PR

**Files:** none modified (evidence only).

- [ ] **Step 1: Full local battery (retain every summary line in `<scratchpad>/rmm-qa-166-red/99-battery.txt`)**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/api exec vitest run src/services/mfaFactorReset.test.ts src/services/userNeutralization.test.ts src/services/mfaAssurance.test.ts src/routes/users.test.ts src/routes/accessReviews.test.ts src/routes/auth/helpers.test.ts
pnpm --filter @breeze/api exec eslint src/services/mfaFactorReset.ts src/services/userNeutralization.ts src/routes/users.ts src/routes/accessReviews.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/adminMfaReset.integration.test.ts src/__tests__/integration/mfaReenrollmentAfterReset.integration.test.ts src/__tests__/integration/mfaFactorReset.integration.test.ts src/__tests__/integration/userDeleteResurrect.integration.test.ts src/__tests__/integration/mfaAssurance.integration.test.ts src/__tests__/integration/passkeyMfaVerify.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
pnpm --filter @breeze/web exec vitest run src/components/settings/UserList.test.tsx src/lib/__tests__/no-silent-mutations.test.ts
pnpm --filter @breeze/web exec tsc --noEmit
```
Expected: every command exits 0.

- [ ] **Step 2: Post-implementation grep tripwires (each must match exactly as stated)**

```bash
grep -n "mfaEnabled" apps/api/src/routes/users.ts | grep -n "reset"            # → no hits: no column gate on the reset route
grep -rn "neutralizeUserIfOrphaned" apps/api/src --include=*.ts | grep -v test  # → services/userNeutralization.ts (definition) + routes/users.ts + routes/accessReviews.ts, nothing else
grep -rn "delete(userPasskeys)" apps/api/src --include=*.ts | grep -v test      # → routes/auth/passkeys.ts (self-service) + services/mfaFactorReset.ts only
grep -rn "disabledAt: new Date()" apps/api/src/services/mfaFactorReset.ts apps/api/src/services/userNeutralization.ts  # → no hits (no soft-disable introduced)
grep -n "isNull(userPasskeys.disabledAt)" apps/api/src/routes/users.ts          # → exactly 1 hit (list probe keeps the live-passkey predicate)
git -C . status --short                                                         # → clean (no stray files; .env.test is gitignored — verify with `git check-ignore .env.test`)
```

- [ ] **Step 3: Tear down the private stack**

Run: `pnpm test-stack down` → containers and volumes removed, `.env.test` deleted.

- [ ] **Step 4: Push and open a DRAFT PR against main**

```bash
git push -u origin fix/rmm-qa-166-mfa-reset-revokes-passkeys
gh pr create --draft --base main --title "fix(auth): admin MFA reset and user neutralization revoke passkeys (RMM-QA-166)" --body-file "<scratchpad>/rmm-qa-166-pr-body.md"
```
Write `<scratchpad>/rmm-qa-166-pr-body.md` with exactly this structure (fill every `<…>` from the retained evidence; do not leave placeholders):

```text
## Summary

RMM-QA-166: `POST /users/:id/mfa/reset`, last-membership neutralization, tombstone re-invite and access-review revocation cleared only `users` columns and never touched `user_passkeys`; because `userIsMfaProtected` counts live passkey rows, a "reset" user stayed protected/locked out and could not re-enroll password-only, and the admin could not reset again (column gate + hidden button). This PR adds one transactional factor-reset service and wires it into all four paths.

Spec: docs/superpowers/specs/2026-09-01-rmm-qa-166-mfa-reset-revokes-passkeys-design.md — decisions D1–D12; verifier concerns C1–C6 each satisfied or refuted with an executed proof (C1 → I-4, C2 → I-3/I-6, C5 → U-5/U-9 no double bump, C6 → D7 post-commit audit).

Finding IDs: RMM-QA-166
Branch / commit / PR: fix/rmm-qa-166-mfa-reset-revokes-passkeys / <head sha> / <this PR URL>
Behavior changed:
- Admin reset gates on the factor inventory (userIsMfaProtected), not users.mfa_enabled; strips TOTP/SMS/recovery/phone AND hard-deletes every user_passkeys row (credential ids into audit); sweeps mfa:setup + passkey challenge keys post-commit.
- DELETE /users/:id (last membership) and access-review completion: epochs {auth, mfa} → families → neutralize incl. all factors/passkeys. STATED CHANGE: an access review that revokes a user's LAST membership anywhere now disables the account and strips password + factors (same as DELETE /users/:id); users with any other membership are untouched.
- POST /users/invite pre-flights the composite reset for a tombstone (disabled + no password) before the ambient-context invite transaction; in-tx branch also clears phone.
- GET /users adds `mfaProtected`; web Reset MFA renders on `mfaProtected ?? mfaEnabled`.
- No data migration (D10): historical passkey-only leftovers are remediated by running the now-working reset per account; tombstones with stale passkeys are inert until re-invited, where D9 sweeps them.
Exit-contract clauses proved:
- one transactional service revokes passkeys, TOTP, SMS, recovery, pending setup, grants (via mfa_epoch), sessions (families + post-commit) — I-1, I-5, U-1..U-3
- every factor and a mixed-factor user — I-1, U-2
- old credentials fail — I-1 (userIsMfaProtected false, family revoked, mfa_epoch advanced), I-3 step 2
- clean re-enrollment succeeds — I-3 (password-only /mfa/setup + /mfa/verify Case 2 → 200; same credential_id re-registers)
- audit identifies the administrator — I-1 (actor_id = admin, passkeysDeleted, credential ids), U-1
Exit-contract clauses still open: none at implementation level; candidate-bound proof below.
Tests run and exact results: <paste each battery command + summary line from 99-battery.txt; list RED→GREEN pairs per task with the retained failing lines>
Migration / RLS / config / rollout impact: no migration; no RLS policy change (rls-coverage tripwire green); no config/env change; rollout-safe (additive API field; UI falls back to mfaEnabled for older payloads).
Security and tenant/site negative cases: I-4 (tenant-context call throws MfaFactorResetContextError, passkey row intact — executed C1 proof; mutation shows the silent-zero-row trap when the guard is removed); U-4 (empty inventory → 400, no tx); reset route 404 for cross-tenant target with no inventory probe; U-6/U-10 (user with a remaining membership not neutralized); U-8 (list probe runs only over tenant-resolved ids, under system context, after the tenant select).
Operator/UI states checked: W-1 passkey-only → Reset MFA visible; W-2 mfaProtected=false hides despite stale mfaEnabled; W-3 legacy payload falls back to mfaEnabled; no-silent-mutations suite green.
Candidate-bound evidence still required: QA coordinator to re-run the RMM-QA-166 characterization against a release candidate (admin reset of a passkey-only user via the real UI, then password-only re-enrollment; access-review last-membership revocation → account disabled) and record in docs/qa/evidence.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu
```

- [ ] **Step 5: Confirm CI attached to the head**

Run: `gh run list --branch fix/rmm-qa-166-mfa-reset-revokes-passkeys --limit 5` → workflow runs present for the head sha (fallback if none: `gh workflow run ci.yml --ref fix/rmm-qa-166-mfa-reset-revokes-passkeys`). Report the PR URL, head sha, and which of **Test API**, **Test Web**, **Integration Tests (shard */4)** are attached. Do not merge; do not push to main.

---

## Self-review (done while writing; re-check at execution)

- **Spec coverage:** D1 (Task 4 hard delete + I-3/I-6), D2 (Task 4), D3 (Tasks 7, 10; U-5/U-9 single bump), D4 (Task 4 guard + I-4), D5 (Tasks 5, 10 + U-9/U-10), D6 (Task 6 + U-1/U-4/I-2), D7 (Task 6 audit from inventory), D8 (Task 4 sweep + U-3/I-1), D9 (Task 8 + I-8), D10 (no migration — PR body), D11 (Tasks 9, 12), D12 (Task 2). §8 tests: U-1..U-10, I-1..I-8, W-1..W-3 all placed. §9 battery: Task 13. §10 non-claims carried into the PR body.
- **Placeholder scan:** the only `<…>` tokens are evidence slots in commit/PR bodies that the executor fills from retained files; every code step is complete.
- **Type consistency:** `resetAllFactors(tx, userId)`, `resetAllFactorsAndInvalidate(userId, reason)`, `sweepPendingFactorArtifacts(userId)`, `pendingFactorArtifactKeys(userId)`, `MfaFactorResetContextError`, `MfaFactorInventory`, `AdminFactorResetResult`, `neutralizeUserIfOrphaned(tx, userId): Promise<NeutralizationResult>`, `annotateMfaProtected(rows)`, `mfaProtected` — used with the same names and shapes in Tasks 3–12.
- **Known judgment calls recorded in the plan:** I-3 drives `/auth/mfa/verify` Case 2 (the SR2-20 gate lives there and on `/mfa/enable`, NOT on `/mfa/setup` — the spec's §8 wording "setup 403s" is corrected here: setup is 200 on main too; the discriminator is the verify step); U-3's sweep assertion uses the global unit Redis mock's `del` spy; the `isNull(disabledAt)` list predicate is tripwire-covered, not mutation-provable at unit level.
