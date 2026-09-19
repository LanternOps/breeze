---
tracking_issue: LanternOps/breeze#3206
wave: W07
wave_issue: LanternOps/breeze#3901
spec: docs/superpowers/specs/mobile/2026-08-29-ticket-push-categories-design.md
---

# Ticket Push Categories (Assignment + SLA Breach) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician gets an iOS push when a ticket is assigned to them, and when a ticket they own (or, by opt-in, any ticket in their partner) breaches its response or resolution SLA; tapping the push opens `TicketDetail`.

**Architecture:** The existing `ticket-events` consumer (`apps/api/src/jobs/ticketNotifyWorker.ts`) gains a push phase: recipients are discovered and re-authorised inside `withSystemDbAccessContext`, in-app rows are written through `createNotification()` with a `dedupeKey` (the idempotency anchor), push specs are collected, and `dispatchPushToTokens` sends after the context exits (#1105). Per-user preferences live in a new Shape-6 table `ticket_push_preferences` behind `GET/PATCH /api/v1/users/me/ticket-push-preferences`. On the phone a sibling `PushTapRouter` next to `ApprovalGate` routes `data.type === 'ticket'` taps through a module-level `navigationRef`; three preference controls land in the existing Settings sheet.

**Tech Stack:** Hono + Drizzle + BullMQ (API), Postgres RLS, APNs HTTP/2 (`services/apns.ts`), Expo push relay (`services/expoPush.ts`), Zod validators in `packages/shared`, React Native (Expo SDK 55) + Redux Toolkit + React Navigation (mobile), Vitest everywhere.

**Spec:** `docs/superpowers/specs/mobile/2026-08-29-ticket-push-categories-design.md` (decisions D1–D13, data model, backend flow, mobile flow, failure modes). Evidence labels in this plan: [verified] = read in this worktree on 2026-08-29; [inferred] = design conclusion; [not-checked] = confirm during implementation.

## Global Constraints

- **Migration filename is a moving target.** The newest shipped migration is `2026-09-22-ai-alert-verdicts-live-unique.sql` [verified `ls apps/api/migrations | tail`]. Name the new file `2026-09-23-ticket-push-preferences.sql`; on the day the PR opens re-run `ls apps/api/migrations | tail -3` and bump the date if anything newer has shipped. Never edit it after it ships (`breeze_migrations` keys on filename).
- **Migration is idempotent, has RLS in the same file, no inner `BEGIN;`/`COMMIT;`.** `CREATE TYPE` inside `DO $$ ... EXCEPTION WHEN duplicate_object`, `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` then `CREATE POLICY`.
- **Registration lists (mechanical grep, decided in spec §Data model):** `ticket_push_preferences` is added to `USER_ID_SCOPED_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` and **nowhere else** — it has no `org_id` (no `CORE_ORG_CASCADE_DELETE_ORDER`, no `CORE_TENANT_EXPORT_POLICY` entry), no `device_id`, is not append-only. No existing org-cascade table gains a column in this wave, so the export-policy registry is untouched. Task 3 runs the cascade/export suites to prove "no diff expected".
- **Not a Partner-Wide-First config table.** It is a personal preference keyed by `user_id` (same category as `mobile_devices`); this sentence is the CLAUDE.md-required justification for having no `org_id`/`partner_id`.
- **System context is discovery only, never authority (D5).** Every push recipient is re-checked: `users.partner_id === event.partnerId`, `users.status = 'active'`, `getUserPermissions(userId, { partnerId, orgId })` + `hasPermission(perms, 'tickets', 'read')` + `canAccessOrg(perms, event.orgId)`.
- **Network I/O after the DB context exits (#1105).** Token reads happen inside `runWithSystemDbAccess`; `dispatchPushToTokens` is called only after it returns.
- **At-most-once push, exactly-once in-app row (D2).** `createNotification({ dedupeKey })` returning `null` means replay: no push, no email.
- **Lock-screen body never contains the ticket subject (D11).** Body is `<internalNumber ?? 'Ticket'> · <org name>`.
- **Throttle every push, never in-app rows (D6):** `checkNotificationThrottle('mobile-ticket', \`user:${userId}\`, 20, 300)`.
- **Quiet hours drop, never defer (D12).** In-app + email still written.
- **Short-circuit on `!isApnsConfigured()` (D8)** before any token read, logged once per process.
- **Defaults (D13):** `assignedEnabled = true`, `slaScope = 'owned'`; `'any'` is opt-in only. Missing row = defaults via `resolveTicketPushPrefs`.
- **Preference route is self-only:** `user_id` is always `auth.user.id`, never from the body.
- **Mobile tests are node-only `*.test.ts`** (`apps/mobile/vitest.config.ts` [verified]); `.tsx` never gets a unit test. Mock RN leaves with `vi.mock` factories as `services/notifications.test.ts` does.
- **Mobile mutation feedback:** optimistic update + rollback + toast; controls disabled when `useNetworkConnected()` is false; no offline write queue.
- **Android/FCM out of scope.** Only the inert `channelId: 'tickets'` string ships.
- **Rigor markers:** tasks are labelled `Rigor: high` (migrations/RLS/auth/push fan-out) or `Rigor: low`. Author markers: `Author: codex` means Codex can write it from a named reference file (`codex exec` with the repo contracts pasted in); `Author: Claude` means RN screens or cross-module wiring.
- **Two branches, created up front (Task 1).** Tasks 2–12 commit on `feature/3206-mobile-ticketing-time-entry/wave-3901-api`; Tasks 13–18 commit on `feature/3206-mobile-ticketing-time-entry/wave-3901-mobile`, branched from the API branch. Task 1 creates both; every later task says which branch it belongs on. Executed without Task 1, the plan would produce a single branch and Task 19's stacked-PR step would be impossible.
- **Branch-prefix conflict, resolved.** `AGENTS.md:309` enumerates `fix/ feat/ docs/ chore/ ops/ hotfix/ integration/` and does not list `feature/`; CLAUDE.md's Feature Lifecycle section prescribes `feature/<parent#>-<slug>/wave-<subissue#>` for wave work. **Follow CLAUDE.md** — it is the more specific rule for this exact situation and the repo has already shipped waves W01–W03 of this very feature under it [verified `git ls-remote --heads origin 'refs/heads/feature/*'` → `feature/3206-mobile-ticketing-time-entry/wave-3896`, `-3897`, `-3898`]. Reuse the same slug (`3206-mobile-ticketing-time-entry`) rather than inventing `3206-ticket-push`, so W07's branches sort next to its siblings. Note the conflict in the PR body; do not "fix" it by renaming to `feat/`.
- **PR issue keywords (`AGENTS.md:315-333`).** `Part of #N` is not a recognised keyword and is banned here. The API PR (partial) uses **`Refs #3901`** plus an explicit sentence naming what shipped and what did not; the mobile PR (completes the wave) uses **`Closes #3901`**. A bare `Refs` with no scope note is how a fixed issue becomes permanent backlog.
- **A preference on `slaScope='off'` suppresses the PUSH only (spec D6).** In-app `user_notifications` rows and emails are written regardless of any preference or throttle. This is the spec's rule and the UI copy in Task 17 states it; do not let the implementation drift into suppressing the inbox row.
- **`pnpm --filter <pkg> test` is watch-mode for `@breeze/shared` and `@breeze/api`** [verified `packages/shared/package.json:21` and `apps/api/package.json:25` are both bare `"vitest"`; only `apps/mobile/package.json:11` is `"vitest run"`]. Every run command in this plan uses `exec vitest run` so nothing hangs an agent shell.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/validators/ticketPushPreferences.ts` (create) | Zod schemas, `TICKET_PUSH_PREFERENCE_DEFAULTS`, total `resolveTicketPushPrefs`. Shared by API and app. |
| `packages/shared/src/validators/ticketPushPreferences.test.ts` (create) | Validator + totality tests. |
| `packages/shared/src/validators/index.ts` (modify) | Re-export. |
| `apps/api/migrations/2026-09-23-ticket-push-preferences.sql` (create) | Enum, table, partial index, RLS, grant. |
| `apps/api/src/db/schema/ticketPushPreferences.ts` (create) | Drizzle `pgEnum` + `pgTable`. |
| `apps/api/src/db/schema/index.ts` (modify) | Export the schema. |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (modify) | `USER_ID_SCOPED_TABLES` entry. |
| `apps/api/src/__tests__/integration/ticketPushPreferencesRls.integration.test.ts` (create) | Behavioural user-axis isolation + cascade on user delete. |
| `apps/api/src/services/ticketEvents.ts` (modify) | `eventId` on the envelope, stamped in `emitTicketEvent`. |
| `apps/api/src/services/quietHours.ts` (create) | `QuietHoursConfig`, `isInQuietHours` moved out of the Firebase module. |
| `apps/api/src/services/notifications.ts` (modify) | Re-export from `quietHours.ts`; delete the local copy. |
| `apps/api/src/services/apns.ts` (modify) | `ApnsPayload.threadId` / `.category`; emitted only when set. |
| `apps/api/src/services/expoPush.ts` (modify) | `PushSpec`, `dispatchPushToTokens`, `buildTicketPush`; approval dispatch becomes a wrapper. |
| `apps/api/src/services/ticketPush.ts` (create) | Recipient discovery + authorisation + per-user push collection. Pure functions over injected deps so the worker test can mock one module. |
| `apps/api/src/services/ticketPush.test.ts` (create) | Unit tests incl. compiled-SQL assertion of the partner filter. |
| `apps/api/src/jobs/ticketNotifyWorker.ts` (modify) | `createNotification` + dedupe, push collection, send-after-context. |
| `apps/api/src/jobs/ticketNotifyWorker.test.ts` (modify) | Existing tests updated for `createNotification`; new push cases. |
| `apps/api/src/routes/users.ts` (modify) | `GET/PATCH /me/ticket-push-preferences` **and** widening the router's self-service exemption so the new route is reachable by the technician it targets. |
| `apps/api/src/routes/users.test.ts` (modify) | Route tests **and** a partner-scope / `orgAccess: 'selected'` gate regression test. |
| `apps/api/src/__tests__/integration/ticketPushFanout.integration.test.ts` (create) | Real-DB fan-out: cross-partner isolation, org scoping, cap, dedupe replay. |
| `apps/mobile/src/services/notifications.ts` (modify) | `parseTicketNotification`, `tickets` channel, badge-aware handler. |
| `apps/mobile/src/services/notifications.test.ts` (modify) | Parser tests. |
| `apps/mobile/src/navigation/pushRouting.ts` (create) | Pure `resolvePushRoute`, `shouldReplayResponse`. |
| `apps/mobile/src/navigation/pushRouting.test.ts` (create) | Tests. |
| `apps/mobile/src/navigation/navigationRef.ts` (create) | `navigationRef`, `navigateToTicket`, `flushPendingNavigation`. |
| `apps/mobile/src/navigation/navigationRef.test.ts` (create) | Buffer-before-ready, flush-once tests. |
| `apps/mobile/src/navigation/PushTapRouter.tsx` (create) | Ticket-only listeners + cold-start replay. |
| `apps/mobile/src/navigation/RootNavigator.tsx` (modify) | `ref`, `onReady`, mount `PushTapRouter`. |
| `apps/mobile/src/services/api.ts` (modify) | `getTicketPushPrefs`, `updateTicketPushPrefs`. |
| `apps/mobile/src/store/notificationPrefsSlice.ts` (create) | Load/save thunks, optimistic + rollback. |
| `apps/mobile/src/store/notificationPrefsSlice.test.ts` (create) | Reducer tests. |
| `apps/mobile/src/store/index.ts` (modify) | Register the slice. |
| `apps/mobile/src/screens/chat/components/SettingsSheet.tsx` (modify) | "Assigned to me" switch + "SLA breaches" segmented control. |
| `apps/docs/src/content/docs/features/mobile.mdx` (modify) | Document the two ticket push categories, the tap-to-open behaviour, and the preference endpoints. |
| `apps/docs/src/content/docs/features/notifications.mdx` (modify) | Retire the stale "APNS is stubbed" note that this wave makes false. |

---

### Task 1: Create both wave branches and open the wave

**Rigor: low. Author: Claude.** This task writes no product code and it is a plan failure to skip it: every later task ends in `git commit`, and Task 19 opens two stacked PRs from two branches that nothing else creates.

**Files:** none.

**Interfaces:**
- Produces: local branches `feature/3206-mobile-ticketing-time-entry/wave-3901-api` (Tasks 2–12) and `feature/3206-mobile-ticketing-time-entry/wave-3901-mobile` (Tasks 13–18, stacked on the first).

- [ ] **Step 1: Confirm the wave state on GitHub before branching**

State on GitHub is the source of truth, never this plan doc (CLAUDE.md, Feature Lifecycle Tracking). Run the `feature-lifecycle` MCP `get_feature_status` for `LanternOps/breeze#3206` and confirm `#3901` is the open W07 sub-issue and is not already in progress. If another agent holds it, stop and hand back.

- [ ] **Step 2: Create the API branch from a fresh `main`**

```bash
git fetch origin main
git switch -c feature/3206-mobile-ticketing-time-entry/wave-3901-api origin/main
git log --oneline -1   # record the base SHA; Task 19 Step 4 needs it for the post-squash rebase
```

The slug matches the sibling wave branches already on origin (`.../wave-3896`, `-3897`, `-3898`) — do not invent a new one. See the branch-prefix note in Global Constraints for why `feature/` and not `feat/`.

- [ ] **Step 3: Create the mobile branch stacked on it**

```bash
git switch -c feature/3206-mobile-ticketing-time-entry/wave-3901-mobile
git switch feature/3206-mobile-ticketing-time-entry/wave-3901-api
```

Both branches now point at the same commit. Tasks 2–12 advance the API branch; Task 13 starts by fast-forwarding the mobile branch onto the finished API branch (`git switch ...-mobile && git merge --ff-only ...-api`).

- [ ] **Step 4: Mark the wave started**

Call `start_wave` for `#3901` via the `feature-lifecycle` MCP server. No commit — this task produces branches, not files.

---

### Task 2: Shared validator and `resolveTicketPushPrefs`

**Rigor: low. Author: codex** (reference: `packages/shared/src/validators/tickets.ts` for style; `packages/shared/src/validators/index.ts:1069` for the export line).

**Files:**
- Create: `packages/shared/src/validators/ticketPushPreferences.ts`
- Modify: `packages/shared/src/validators/index.ts` (append after line 1074 `export * from './ticketConfig';`)
- Test: `packages/shared/src/validators/ticketPushPreferences.test.ts`

**Interfaces:**
- Produces:
  - `ticketSlaPushScopeSchema: z.ZodEnum<['off','owned','any']>`, `type TicketSlaPushScope`
  - `ticketPushPreferencesSchema`, `type TicketPushPreferences = { assignedEnabled: boolean; slaScope: TicketSlaPushScope }`
  - `updateTicketPushPreferencesSchema` (partial, strict, at least one key)
  - `TICKET_PUSH_PREFERENCE_DEFAULTS: { assignedEnabled: true; slaScope: 'owned' }`
  - `resolveTicketPushPrefs(row: Partial<TicketPushPreferences> | null | undefined): TicketPushPreferences`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/validators/ticketPushPreferences.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolveTicketPushPrefs,
  updateTicketPushPreferencesSchema,
  ticketPushPreferencesSchema,
  TICKET_PUSH_PREFERENCE_DEFAULTS,
} from './ticketPushPreferences';

describe('resolveTicketPushPrefs', () => {
  it('returns defaults for null and undefined', () => {
    expect(resolveTicketPushPrefs(null)).toEqual({ assignedEnabled: true, slaScope: 'owned' });
    expect(resolveTicketPushPrefs(undefined)).toEqual(TICKET_PUSH_PREFERENCE_DEFAULTS);
  });
  it('fills missing fields from defaults and keeps provided ones', () => {
    expect(resolveTicketPushPrefs({ slaScope: 'any' })).toEqual({ assignedEnabled: true, slaScope: 'any' });
    expect(resolveTicketPushPrefs({ assignedEnabled: false })).toEqual({ assignedEnabled: false, slaScope: 'owned' });
  });
  it('never returns an unknown scope', () => {
    expect(resolveTicketPushPrefs({ slaScope: 'bogus' as never }).slaScope).toBe('owned');
  });
});

describe('updateTicketPushPreferencesSchema', () => {
  it('rejects an empty patch', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({}).success).toBe(false);
  });
  it('rejects unknown keys (strict)', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({ userId: 'x', slaScope: 'off' }).success).toBe(false);
  });
  it('accepts a partial patch', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({ slaScope: 'any' }).success).toBe(true);
    expect(updateTicketPushPreferencesSchema.safeParse({ assignedEnabled: false }).success).toBe(true);
  });
  it('rejects an invalid scope', () => {
    expect(updateTicketPushPreferencesSchema.safeParse({ slaScope: 'all' }).success).toBe(false);
  });
});

describe('ticketPushPreferencesSchema', () => {
  it('requires both fields', () => {
    expect(ticketPushPreferencesSchema.safeParse({ assignedEnabled: true }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/ticketPushPreferences.test.ts`
Expected: FAIL — `Failed to resolve import "./ticketPushPreferences"`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/shared/src/validators/ticketPushPreferences.ts
import { z } from 'zod';

/**
 * Per-user mobile push preferences for ticket events (W07, #3901).
 * Stored in `ticket_push_preferences` (Shape 6, user-scoped). A missing row
 * means "defaults" — resolveTicketPushPrefs is the single place that says so,
 * for API and app alike (spec D13).
 */
export const ticketSlaPushScopeSchema = z.enum(['off', 'owned', 'any']);
export type TicketSlaPushScope = z.infer<typeof ticketSlaPushScopeSchema>;

export const ticketPushPreferencesSchema = z.object({
  assignedEnabled: z.boolean(),
  slaScope: ticketSlaPushScopeSchema,
});
export type TicketPushPreferences = z.infer<typeof ticketPushPreferencesSchema>;

export const updateTicketPushPreferencesSchema = ticketPushPreferencesSchema
  .partial()
  .strict()
  .refine((v) => v.assignedEnabled !== undefined || v.slaScope !== undefined, {
    message: 'No settings provided',
  });
export type UpdateTicketPushPreferences = z.infer<typeof updateTicketPushPreferencesSchema>;

export const TICKET_PUSH_PREFERENCE_DEFAULTS: TicketPushPreferences = Object.freeze({
  assignedEnabled: true,
  slaScope: 'owned',
}) as TicketPushPreferences;

/** Total: any input (including garbage scopes) resolves to a valid preference set. */
export function resolveTicketPushPrefs(
  row: Partial<TicketPushPreferences> | null | undefined
): TicketPushPreferences {
  const scopeParsed = ticketSlaPushScopeSchema.safeParse(row?.slaScope);
  return {
    assignedEnabled:
      typeof row?.assignedEnabled === 'boolean'
        ? row.assignedEnabled
        : TICKET_PUSH_PREFERENCE_DEFAULTS.assignedEnabled,
    slaScope: scopeParsed.success ? scopeParsed.data : TICKET_PUSH_PREFERENCE_DEFAULTS.slaScope,
  };
}
```

Append to `packages/shared/src/validators/index.ts` after the `ticketConfig` export:

```ts
export * from './ticketPushPreferences';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/shared exec vitest run src/validators/ticketPushPreferences.test.ts`
Expected: PASS (8 tests). Then `pnpm --filter @breeze/shared build` (the API and app consume the built package [not-checked: confirm whether workspaces resolve `src` or `dist`; if `dist`, the build step is mandatory before Tasks 8 and 10, the two API consumers of `@breeze/shared`. `apps/mobile` never imports it — see Task 16]).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/ticketPushPreferences.ts packages/shared/src/validators/ticketPushPreferences.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): ticket push preference validators + resolveTicketPushPrefs (#3901)"
```

---

### Task 3: Migration, Drizzle schema, RLS registration and RLS proof

**Rigor: high. Author: Claude** designs; codex may execute the SQL and the integration test from `apps/api/src/__tests__/integration/userNotificationsRls.integration.test.ts` once handed this task verbatim.

**Files:**
- Create: `apps/api/migrations/2026-09-23-ticket-push-preferences.sql`
- Create: `apps/api/src/db/schema/ticketPushPreferences.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './ticketPushPreferences';` next to line 44 `export * from './notifications';`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:652` (`USER_ID_SCOPED_TABLES`, after `'mobile_devices'`)
- Test: `apps/api/src/__tests__/integration/ticketPushPreferencesRls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle `ticketPushPreferences` table (`userId`, `assignedEnabled`, `slaScope`, `createdAt`, `updatedAt`) and `ticketSlaPushScopeEnum`; DB enum `ticket_sla_push_scope`.

- [ ] **Step 1: Write the failing RLS integration test**

```ts
// apps/api/src/__tests__/integration/ticketPushPreferencesRls.integration.test.ts
/**
 * ticket_push_preferences RLS — user axis, behaviourally (W07, #3901).
 * The coverage contract only proves the policy MENTIONS breeze_current_user_id;
 * this file proves one user cannot read/insert/update another's row as
 * breeze_app, that the system context sees everything (the notify worker reads
 * this table inside withSystemDbAccessContext), and that deleting a user
 * cascades the row.
 *
 * Prerequisites: docker compose -f docker-compose.test.yml up -d
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { ticketPushPreferences, users } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const userA = await createUser({ partnerId: partner.id, orgId: org.id });
  const userB = await createUser({ partnerId: partner.id, orgId: org.id });
  const ctx = (userId: string): DbAccessContext => ({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId,
  });
  return { partner, org, userA, userB, ctxA: ctx(userA.id), ctxB: ctx(userB.id) };
}

describe('ticket_push_preferences RLS — user axis', () => {
  runDb('a user can upsert and read their own row', async () => {
    const fx = await seed();
    await withDbAccessContext(fx.ctxA, () =>
      db.insert(ticketPushPreferences).values({ userId: fx.userA.id, slaScope: 'any' }));
    const rows = await withDbAccessContext(fx.ctxA, () =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userA.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slaScope).toBe('any');
  });

  runDb('THE GUARD: a same-partner peer cannot read, update or forge the row', async () => {
    const fx = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(ticketPushPreferences).values({ userId: fx.userA.id, assignedEnabled: false }));

    const read = await withDbAccessContext(fx.ctxB, () =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userA.id)));
    expect(read).toHaveLength(0);

    const updated = await withDbAccessContext(fx.ctxB, () =>
      db.update(ticketPushPreferences).set({ slaScope: 'off' })
        .where(eq(ticketPushPreferences.userId, fx.userA.id)).returning({ userId: ticketPushPreferences.userId }));
    expect(updated).toHaveLength(0);

    // Forging a row for someone else fails WITH CHECK → 42501.
    await expectSqlState(
      () => withDbAccessContext(fx.ctxB, () =>
        db.insert(ticketPushPreferences).values({ userId: fx.userA.id, slaScope: 'any' })
          .onConflictDoUpdate({ target: ticketPushPreferences.userId, set: { slaScope: 'any' } })),
      '42501'
    );

    const still = await withSystemDbAccessContext(() =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userA.id)));
    expect(still[0]!.assignedEnabled).toBe(false);
  });

  runDb('system context sees every row (worker discovery path)', async () => {
    const fx = await seed();
    await withDbAccessContext(fx.ctxA, () =>
      db.insert(ticketPushPreferences).values({ userId: fx.userA.id, slaScope: 'any' }));
    await withDbAccessContext(fx.ctxB, () =>
      db.insert(ticketPushPreferences).values({ userId: fx.userB.id, slaScope: 'any' }));
    const rows = await withSystemDbAccessContext(() =>
      db.select({ userId: ticketPushPreferences.userId }).from(ticketPushPreferences)
        .where(eq(ticketPushPreferences.slaScope, 'any')));
    const ids = rows.map((r) => r.userId);
    expect(ids).toEqual(expect.arrayContaining([fx.userA.id, fx.userB.id]));
  });

  runDb('deleting the user cascades the preference row', async () => {
    const fx = await seed();
    await withSystemDbAccessContext(() =>
      db.insert(ticketPushPreferences).values({ userId: fx.userB.id }));
    await withSystemDbAccessContext(() => db.delete(users).where(eq(users.id, fx.userB.id)));
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, fx.userB.id)));
    expect(rows).toHaveLength(0);
  });
});
```

[not-checked] `createUser` may create dependent rows (roles/memberships) that block a bare `DELETE FROM users`; if the cascade test fails on an FK other than `ticket_push_preferences`, delete those rows first inside the same system context — the property under test is only that the preference row is gone.

- [ ] **Step 2: Run the test to verify it fails**

Run (stack up: `docker compose -f docker-compose.test.yml up -d`):
`pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketPushPreferencesRls.integration.test.ts`
Expected: FAIL — `ticketPushPreferences` is not exported from `../../db/schema`. Confirm in the log that the four tests were collected (not skipped — `runIf` needs `DATABASE_URL`).

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-09-23-ticket-push-preferences.sql
-- W07 (#3901): per-user mobile push preferences for ticket events.
-- Shape 6 (user-scoped). No org_id/partner_id by design: a personal preference,
-- same category as mobile_devices — NOT a Partner-Wide-First config table.
-- Idempotent; no inner BEGIN/COMMIT (autoMigrate wraps each file).

DO $$ BEGIN
  CREATE TYPE ticket_sla_push_scope AS ENUM ('off', 'owned', 'any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ticket_push_preferences (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assigned_enabled boolean NOT NULL DEFAULT true,
  sla_scope        ticket_sla_push_scope NOT NULL DEFAULT 'owned',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The 'any' fan-out query (services/ticketPush.ts) filters on sla_scope = 'any'
-- then joins users on partner_id; keep the opted-in set cheap to enumerate.
CREATE INDEX IF NOT EXISTS ticket_push_preferences_sla_any_idx
  ON ticket_push_preferences (user_id) WHERE sla_scope = 'any';

ALTER TABLE ticket_push_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_push_preferences FORCE ROW LEVEL SECURITY;

-- Policy spelling mirrors user_notifications_user_isolation
-- (2026-09-04-ai-agent-notifications.sql). The `system` branch is required:
-- the ticket notify worker reads this table inside withSystemDbAccessContext.
-- No partner/org admin branch is ORed in — nobody but the user and system
-- jobs needs a push preference.
DROP POLICY IF EXISTS ticket_push_preferences_user_isolation ON ticket_push_preferences;
CREATE POLICY ticket_push_preferences_user_isolation ON ticket_push_preferences
  FOR ALL
  USING      (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id())
  WITH CHECK (public.breeze_current_scope() = 'system' OR user_id = public.breeze_current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_push_preferences TO breeze_app;
```

- [ ] **Step 4: Write the Drizzle schema and export it**

```ts
// apps/api/src/db/schema/ticketPushPreferences.ts
import { pgTable, pgEnum, uuid, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';

export const ticketSlaPushScopeEnum = pgEnum('ticket_sla_push_scope', ['off', 'owned', 'any']);

/**
 * Per-user mobile push preferences for ticket events (W07, #3901).
 * Shape 6 (user-scoped RLS, breeze_current_user_id). Missing row = defaults;
 * see resolveTicketPushPrefs in @breeze/shared.
 */
export const ticketPushPreferences = pgTable('ticket_push_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  assignedEnabled: boolean('assigned_enabled').notNull().default(true),
  slaScope: ticketSlaPushScopeEnum('sla_scope').notNull().default('owned'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  slaAnyIdx: index('ticket_push_preferences_sla_any_idx').on(t.userId).where(sql`${t.slaScope} = 'any'`),
}));
```

In `apps/api/src/db/schema/index.ts`, after `export * from './notifications';` add:

```ts
export * from './ticketPushPreferences';
```

- [ ] **Step 5: Register in the RLS coverage allowlist**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, inside `USER_ID_SCOPED_TABLES` directly after `'mobile_devices',`:

```ts
  // ticket_push_preferences: W07 (#3901) per-user ticket push preferences.
  // Pure Shape 6 — user_id PK, no org/partner axis. Behavioural proof is
  // ticketPushPreferencesRls.integration.test.ts; this entry only pins that
  // the policy references breeze_current_user_id.
  'ticket_push_preferences',
```

- [ ] **Step 6: Apply the migration and run the contract tests**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
pnpm db:check-drift
bash scripts/check-migration-naming.sh
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketPushPreferencesRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api test:rls
```

Expected: all PASS. The cascade + export suites must pass **with no edits** — that is the proof no registration is expected (no `org_id`). If `rls-coverage` reports `ticket_push_preferences` as unregistered, the Step 5 entry did not land.

- [ ] **Step 7: Forge a cross-user insert as `breeze_app` — with a positive control**

The GUCs are `breeze.scope` and `breeze.user_id` [verified `apps/api/src/db/index.ts:465,469`; `breeze_current_user_id()` is `SELECT NULLIF(current_setting('breeze.user_id', true), '')::uuid` — verified `apps/api/migrations/2026-04-11-a-rls-function-bootstrap.sql:49-55`]. **Do not use `app.scope` / `app.user_id`:** with no context established at all the INSERT is denied anyway, so the check would pass for the wrong reason and could not tell a working policy from a broken one. The positive control below is what makes the negative meaningful — run both, in this order, and do not accept the negative alone.

Pick two real user ids first:

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -tAc \
  "SELECT id FROM users ORDER BY created_at LIMIT 2;"
# -> USER_A, USER_B
```

**Positive control (MUST succeed):** user A writing user A's own row.

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze <<SQL
SELECT set_config('breeze.scope','partner',false);
SELECT set_config('breeze.user_id','<USER_A>',false);
INSERT INTO ticket_push_preferences (user_id, sla_scope) VALUES ('<USER_A>','any')
  ON CONFLICT (user_id) DO UPDATE SET sla_scope = 'any';
SELECT user_id, sla_scope FROM ticket_push_preferences;
SQL
```

Expected: `INSERT 0 1`, and the SELECT returns **exactly one row** (A's) — proving both that the context is being read and that the policy is not silently allow-all.

**Negative (MUST fail):** the same session forging a row for user B.

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze <<SQL
SELECT set_config('breeze.scope','partner',false);
SELECT set_config('breeze.user_id','<USER_A>',false);
INSERT INTO ticket_push_preferences (user_id) VALUES ('<USER_B>');
SQL
```

Expected: `ERROR: new row violates row-level security policy for table "ticket_push_preferences"`. If the positive control errored, the context is not reaching the policy — fix that before trusting the negative. Clean up with `DELETE FROM ticket_push_preferences WHERE user_id = '<USER_A>';` in the same session.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-09-23-ticket-push-preferences.sql apps/api/src/db/schema/ticketPushPreferences.ts apps/api/src/db/schema/index.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/ticketPushPreferencesRls.integration.test.ts
git commit -m "feat(api): ticket_push_preferences table (Shape 6 RLS) + contract registration (#3901)"
```

---

### Task 4: `eventId` on the ticket event envelope

**Rigor: low. Author: codex** (reference: `apps/api/src/services/ticketEvents.ts`, test `apps/api/src/services/ticketEvents.test.ts`).

**Files:**
- Modify: `apps/api/src/services/ticketEvents.ts:12-17` (envelope) and `emitTicketEvent`
- Test: `apps/api/src/services/ticketEvents.test.ts`

**Interfaces:**
- Produces: `TicketEvent` now carries `eventId: string` (required on the consumed type); `TicketEventInput = Omit<TicketEvent,'eventId'> & { eventId?: string }` accepted by `emitTicketEvent(event: TicketEventInput)`. No emitter changes. **Task 11**'s worker (`jobs/ticketNotifyWorker.ts`) reads `event.eventId ?? job.id` — not Task 10, which is `services/ticketPush.ts` and never sees the envelope.

- [ ] **Step 1: Write the failing tests** (append to the existing `describe('emitTicketEvent')`)

```ts
  it('stamps a uuid eventId when the emitter did not provide one', async () => {
    await emitTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    });
    const [, data] = addMock.mock.calls[0]!;
    expect((data as { eventId: string }).eventId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves a caller-provided eventId', async () => {
    await emitTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'fixed-id', payload: { assigneeId: 'u-2' }
    });
    const [, data] = addMock.mock.calls[0]!;
    expect((data as { eventId: string }).eventId).toBe('fixed-id');
  });

  it('does NOT use eventId as the BullMQ jobId (queue dedupe semantics unchanged)', async () => {
    await emitTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', eventId: 'fixed-id', payload: { assigneeId: 'u-2' }
    });
    const [, , opts] = addMock.mock.calls[0]!;
    expect((opts as { jobId?: string }).jobId).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/ticketEvents.test.ts`
Expected: first two FAIL (`eventId` undefined / TS excess-property error on `eventId`); third passes already — keep it as the regression guard.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/ticketEvents.ts — replace the envelope + emit
import { randomUUID } from 'crypto';

interface TicketEventEnvelope {
  ticketId: string;
  orgId: string;
  partnerId: string | null;
  actorUserId?: string | null;
  /**
   * W07 (#3901): unique per emitted event; the notify worker uses it in the
   * user_notifications dedupe key so a BullMQ retry never re-pushes while a
   * genuine A→B→A reassignment does. Stamped by emitTicketEvent — emitters
   * never set it. Jobs queued before this shipped lack it; the worker falls
   * back to job.id.
   */
  eventId: string;
}

// ... TicketEvent union unchanged ...

/** What emitters pass: eventId is optional and normally omitted. */
export type TicketEventInput =
  { [K in keyof TicketEvent]: TicketEvent[K] } extends infer E
    ? E extends TicketEvent ? Omit<E, 'eventId'> & { eventId?: string } : never
    : never;

export async function emitTicketEvent(input: TicketEventInput): Promise<void> {
  const event = { ...input, eventId: input.eventId ?? randomUUID() } as TicketEvent;
  try {
    await getTicketEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[TicketEvents] failed to enqueue', event.type, `ticketId=${event.ticketId}`, `orgId=${event.orgId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
```

If the distributive `Omit` above fights `tsc`, use the simpler `type TicketEventInput = DistributiveOmit<TicketEvent, 'eventId'> & { eventId?: string }` with `type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/services/ticketEvents.test.ts src/services/ticketEventsContract.test.ts src/jobs/` and `pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS. Existing worker tests construct `TicketEvent` literals without `eventId` — they will now fail typecheck; add `eventId: 'evt-1'` to those literals (or cast `as never` where the file already does). Do that in this task so the worker test file compiles before Task 11.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketEvents.ts apps/api/src/services/ticketEvents.test.ts apps/api/src/jobs/ticketNotifyWorker.test.ts apps/api/src/jobs/ticketNotifyWorker.leak.test.ts apps/api/src/jobs/ticketNotifyWorker.graphFork.test.ts
git commit -m "feat(api): stamp eventId on ticket events for push/notification dedupe (#3901)"
```

---

### Task 5: Extract `isInQuietHours` to `services/quietHours.ts`

**Rigor: low. Author: codex** (reference: `apps/api/src/services/notifications.ts:17-22, 220-245, 308-345`).

**Files:**
- Create: `apps/api/src/services/quietHours.ts`, `apps/api/src/services/quietHours.test.ts`
- Modify: `apps/api/src/services/notifications.ts` (remove `QuietHoursConfig`, `isInQuietHours`, `parseMinutes`, `getMinutesInTimezone`; add `export { isInQuietHours, type QuietHoursConfig } from './quietHours';` and import `isInQuietHours` for the line-82 call).

**Interfaces:**
- Produces: `isInQuietHours(quietHours?: QuietHoursConfig | null, now?: Date): boolean` — the optional `now` is new (injected for tests; default `new Date()`). `QuietHoursConfig = { start: string; end: string; timezone?: string; enabled?: boolean }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/quietHours.test.ts
import { describe, it, expect } from 'vitest';
import { isInQuietHours } from './quietHours';

const at = (iso: string) => new Date(iso);

describe('isInQuietHours', () => {
  it('is false when unset or disabled', () => {
    expect(isInQuietHours(null)).toBe(false);
    expect(isInQuietHours({ start: '22:00', end: '07:00', enabled: false, timezone: 'UTC' })).toBe(false);
  });
  it('handles an overnight window in UTC', () => {
    const cfg = { start: '22:00', end: '07:00', timezone: 'UTC' };
    expect(isInQuietHours(cfg, at('2026-01-01T23:30:00Z'))).toBe(true);
    expect(isInQuietHours(cfg, at('2026-01-01T06:59:00Z'))).toBe(true);
    expect(isInQuietHours(cfg, at('2026-01-01T12:00:00Z'))).toBe(false);
  });
  it('handles a same-day window and treats start==end as always quiet', () => {
    expect(isInQuietHours({ start: '09:00', end: '17:00', timezone: 'UTC' }, at('2026-01-01T10:00:00Z'))).toBe(true);
    expect(isInQuietHours({ start: '09:00', end: '09:00', timezone: 'UTC' }, at('2026-01-01T03:00:00Z'))).toBe(true);
  });
  it('is false on a malformed time', () => {
    expect(isInQuietHours({ start: '25:00', end: '07:00', timezone: 'UTC' }, at('2026-01-01T03:00:00Z'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/quietHours.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — move the four symbols verbatim from `notifications.ts` into `quietHours.ts`, adding the `now` parameter:

```ts
// apps/api/src/services/quietHours.ts
export interface QuietHoursConfig {
  start: string;
  end: string;
  timezone?: string;
  enabled?: boolean;
}

/** Pure: no DB, no Firebase. `now` is injectable for tests. */
export function isInQuietHours(quietHours?: QuietHoursConfig | null, now: Date = new Date()): boolean {
  if (!quietHours || quietHours.enabled === false) return false;
  const startMinutes = parseMinutes(quietHours.start);
  const endMinutes = parseMinutes(quietHours.end);
  if (startMinutes === null || endMinutes === null) return false;
  const nowMinutes = getMinutesInTimezone(now, quietHours.timezone);
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

// parseMinutes + getMinutesInTimezone: copy the existing bodies from
// notifications.ts:308-345 unchanged.
```

In `notifications.ts`: delete the moved code, add `import { isInQuietHours, type QuietHoursConfig } from './quietHours';` and `export { isInQuietHours, type QuietHoursConfig };` so existing importers keep working.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/quietHours.test.ts src/services/notifications.test.ts` (if the latter exists) and `pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/quietHours.ts apps/api/src/services/quietHours.test.ts apps/api/src/services/notifications.ts
git commit -m "refactor(api): move isInQuietHours out of the Firebase notifications module (#3901)"
```

---

### Task 6: APNs `thread-id` and `category`

**Rigor: low. Author: codex** (reference: `apps/api/src/services/apns.ts:77-86, 150-185`, test `apns.test.ts:114-195`).

**Files:**
- Modify: `apps/api/src/services/apns.ts` (`ApnsPayload`, `buildApnsRequest`)
- Test: `apps/api/src/services/apns.test.ts`

**Interfaces:**
- Produces: `ApnsPayload` gains `threadId?: string; category?: string`. `buildApnsRequest` emits `aps['thread-id']` / `aps.category` only when set.

- [ ] **Step 1: Write the failing tests** (inside `describe('apns — buildApnsRequest')`, using the same config setup the neighbouring tests use)

```ts
  it('emits aps.thread-id and aps.category only when set', async () => {
    const req = buildApnsRequest('tok', { title: 'T', body: 'B', threadId: 'ticket:t-1', category: 'BREEZE_TICKET' }, 'jwt');
    const body = JSON.parse(req.body);
    expect(body.aps['thread-id']).toBe('ticket:t-1');
    expect(body.aps.category).toBe('BREEZE_TICKET');
  });

  it('keeps the approval request byte-identical when threadId/category are absent', async () => {
    const before = JSON.parse(buildApnsRequest('tok', { title: 'T', body: 'B', data: { type: 'approval' } }, 'jwt').body);
    expect(Object.keys(before.aps).sort()).toEqual(['alert', 'sound']);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/apns.test.ts`
Expected: first new test FAILS (`thread-id` undefined); second passes (regression guard).

- [ ] **Step 3: Implement**

```ts
export interface ApnsPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  collapseId?: string;
  ttl?: number;
  /** Groups notifications in Notification Center (aps.thread-id). */
  threadId?: string;
  /** UNNotificationCategory identifier (aps.category). No client category is registered in W07. */
  category?: string;
}
```

and in `buildApnsRequest` replace the `aps` literal:

```ts
  const aps: Record<string, unknown> = {
    alert: { title: payload.title, body: payload.body },
    sound: 'default',
  };
  if (payload.threadId) aps['thread-id'] = payload.threadId;
  if (payload.category) aps.category = payload.category;
  const body = JSON.stringify({ ...(payload.data ?? {}), aps });
```

- [ ] **Step 4: Run tests** — `pnpm --filter @breeze/api exec vitest run src/services/apns.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/apns.ts apps/api/src/services/apns.test.ts
git commit -m "feat(api): optional thread-id/category on APNs payloads (#3901)"
```

---

### Task 7: Generalise the push sender: `PushSpec`, `dispatchPushToTokens`, `buildTicketPush`

**Rigor: low. Author: codex** (reference: `apps/api/src/services/expoPush.ts:159-284`, test `expoPush.test.ts`).

**Files:**
- Modify: `apps/api/src/services/expoPush.ts`
- Test: `apps/api/src/services/expoPush.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PushSpec {
    title: string; body: string; data: Record<string, unknown>;
    ttl: number; channelId: string; collapseId?: string; threadId?: string; category?: string;
    /** Expo relay only; APNs always sounds. */ sound?: 'default' | null; priority?: 'default' | 'normal' | 'high';
  }
  export interface DispatchPushResult { tokensFound: number; dispatched: number; errors: number }
  export function buildTicketPush(args: {
    ticketId: string; reason: 'assigned' | 'sla_breached'; target?: 'response' | 'resolution';
    internalNumber: string | null; orgName: string;
  }): PushSpec;
  export async function dispatchPushToTokens(tokens: TaggedPushToken[], spec: PushSpec, logLabel?: string): Promise<DispatchPushResult>;
  ```
  `dispatchApprovalPushToTokens(tokens, args)` becomes `dispatchPushToTokens(tokens, buildApprovalPush(args) as PushSpec, 'approval')` and keeps its exported name and result type (`DispatchApprovalPushResult = DispatchPushResult`).
- Consumes: Task 6's `ApnsPayload.threadId/category`.

- [ ] **Step 1: Write the failing tests** (append to `expoPush.test.ts`)

```ts
import { buildTicketPush, dispatchPushToTokens, dispatchApprovalPushToTokens } from './expoPush';

describe('buildTicketPush', () => {
  it('assigned: lock-screen-safe body, 24h ttl, collapse/thread ids, no subject', () => {
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-2026-0042', orgName: 'Acme' });
    expect(spec.title).toBe('Ticket assigned to you');
    expect(spec.body).toBe('T-2026-0042 · Acme');
    expect(spec.data).toEqual({ type: 'ticket', ticketId: 't-1', reason: 'assigned', internalNumber: 'T-2026-0042' });
    expect(spec.ttl).toBe(86400);
    expect(spec.collapseId).toBe('ticket:t-1:assigned');
    expect(spec.threadId).toBe('ticket:t-1');
    expect(spec.category).toBe('BREEZE_TICKET');
    expect(spec.channelId).toBe('tickets');
    expect(JSON.stringify(spec)).not.toContain('subject');
  });
  it('sla_breached: target in title/collapse, 4h ttl, "Ticket" fallback label', () => {
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'sla_breached', target: 'response', internalNumber: null, orgName: 'Acme' });
    expect(spec.title).toBe('SLA breached (response)');
    expect(spec.body).toBe('Ticket · Acme');
    expect(spec.ttl).toBe(14400);
    expect(spec.collapseId).toBe('ticket:t-1:sla_breached:response');
    expect(spec.data).toEqual({ type: 'ticket', ticketId: 't-1', reason: 'sla_breached', target: 'response' });
  });
  it('truncates a long org name', () => {
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'x'.repeat(200) });
    expect(spec.body.length).toBeLessThanOrEqual('T-1 · '.length + 60);
  });
});

describe('dispatchPushToTokens', () => {
  beforeEach(() => { sendApnsNotificationMock.mockReset(); });
  it('forwards ttl, collapseId, threadId and category to APNs', async () => {
    sendApnsNotificationMock.mockResolvedValue({ ok: true, status: 200 });
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'Acme' });
    const res = await dispatchPushToTokens([{ token: 'apns-1', platform: 'ios', provider: 'apns' }], spec);
    expect(res).toEqual({ tokensFound: 1, dispatched: 1, errors: 0 });
    expect(sendApnsNotificationMock).toHaveBeenCalledWith('apns-1', expect.objectContaining({
      ttl: 86400, collapseId: 'ticket:t-1:assigned', threadId: 'ticket:t-1', category: 'BREEZE_TICKET',
    }));
  });
  it('purges an unregistered APNs token', async () => {
    sendApnsNotificationMock.mockResolvedValue({ ok: false, status: 410, unregistered: true });
    updateSetCalls.length = 0;
    await dispatchPushToTokens([{ token: 'dead', platform: 'ios', provider: 'apns' }],
      buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'Acme' }));
    expect(updateSetCalls).toContainEqual({ apnsToken: null });
  });
  it('approval wrapper output is unchanged', async () => {
    sendApnsNotificationMock.mockResolvedValue({ ok: true, status: 200 });
    await dispatchApprovalPushToTokens([{ token: 'apns-1', platform: 'ios', provider: 'apns' }],
      { approvalId: 'a1', actionLabel: 'Reboot', requestingClientLabel: 'Claude' });
    const [, payload] = sendApnsNotificationMock.mock.calls[0]!;
    expect(payload).toEqual({ title: 'Approval requested', body: 'Claude: Reboot', data: { type: 'approval', approvalId: 'a1' }, ttl: 60 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/expoPush.test.ts`
Expected: FAIL — `buildTicketPush`/`dispatchPushToTokens` not exported.

- [ ] **Step 3: Implement**

```ts
// expoPush.ts — additions/replacements
const TICKET_ASSIGNED_TTL_SECONDS = 86_400;
const TICKET_SLA_TTL_SECONDS = 14_400;

export interface PushSpec {
  title: string;
  body: string;
  data: Record<string, unknown>;
  ttl: number;
  channelId: string;
  collapseId?: string;
  threadId?: string;
  category?: string;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
}

export interface DispatchPushResult { tokensFound: number; dispatched: number; errors: number }
export type DispatchApprovalPushResult = DispatchPushResult;

// Lock-screen-safe (spec D11): number + org only; the subject loads after
// authenticated navigation. No badge — the badge is owned by the approval path.
export function buildTicketPush(args: {
  ticketId: string;
  reason: 'assigned' | 'sla_breached';
  target?: 'response' | 'resolution';
  internalNumber: string | null;
  orgName: string;
}): PushSpec {
  const label = (args.internalNumber ?? 'Ticket').slice(0, MAX_LABEL_LEN);
  const org = args.orgName.slice(0, MAX_LABEL_LEN);
  const isSla = args.reason === 'sla_breached';
  const data: Record<string, unknown> = { type: 'ticket', ticketId: args.ticketId, reason: args.reason };
  if (isSla && args.target) data.target = args.target;
  if (args.internalNumber) data.internalNumber = args.internalNumber;
  return {
    title: isSla ? `SLA breached (${args.target ?? 'response'})` : 'Ticket assigned to you',
    body: `${label} · ${org}`,
    data,
    ttl: isSla ? TICKET_SLA_TTL_SECONDS : TICKET_ASSIGNED_TTL_SECONDS,
    channelId: 'tickets',
    collapseId: isSla ? `ticket:${args.ticketId}:sla_breached:${args.target ?? 'response'}` : `ticket:${args.ticketId}:assigned`,
    threadId: `ticket:${args.ticketId}`,
    category: 'BREEZE_TICKET',
    sound: 'default',
    priority: 'high',
  };
}

/** Generalised fan-out; body of the former dispatchApprovalPushToTokens with `spec` in place of the approval payload. */
export async function dispatchPushToTokens(
  tokens: TaggedPushToken[],
  spec: PushSpec,
  logLabel = 'push'
): Promise<DispatchPushResult> {
  const result: DispatchPushResult = { tokensFound: tokens.length, dispatched: 0, errors: 0 };
  if (tokens.length === 0) return result;

  const expoTokens = tokens.filter((t) => t.provider === 'expo');
  if (expoTokens.length > 0) {
    try {
      const tickets = await sendExpoPush(expoTokens.map((t) => ({
        to: t.token, title: spec.title, body: spec.body, data: spec.data,
        sound: spec.sound ?? 'default', priority: spec.priority ?? 'high', channelId: spec.channelId, ttl: spec.ttl,
      })));
      for (const ticket of tickets) { if (ticket.status === 'ok') result.dispatched++; else result.errors++; }
    } catch (err) {
      console.error(`[push] expo ${logLabel} dispatch failed`, err);
      result.errors += expoTokens.length;
    }
  }

  const apnsTokens = tokens.filter((t) => t.provider === 'apns');
  for (const t of apnsTokens) {
    try {
      const payload: Parameters<typeof sendApnsNotification>[1] = {
        title: spec.title, body: spec.body, data: spec.data, ttl: spec.ttl,
      };
      if (spec.collapseId) payload.collapseId = spec.collapseId;
      if (spec.threadId) payload.threadId = spec.threadId;
      if (spec.category) payload.category = spec.category;
      const res = await sendApnsNotification(t.token, payload);
      if (res.ok) result.dispatched++;
      else { result.errors++; if (res.unregistered) await purgeApnsToken(t.token); }
    } catch (err) {
      console.error(`[push] apns ${logLabel} dispatch failed`, { token: redactPushToken(t.token), error: err instanceof Error ? err.message : String(err) });
      result.errors++;
    }
  }

  const fcmTokens = tokens.filter((t) => t.provider === 'fcm');
  if (fcmTokens.length > 0) {
    console.info(`[push] android ${logLabel} push not wired to FCM yet — ${fcmTokens.length} token(s) skipped`);
  }
  return result;
}

export async function dispatchApprovalPushToTokens(
  tokens: TaggedPushToken[],
  args: DispatchApprovalPushArgs
): Promise<DispatchApprovalPushResult> {
  const p = buildApprovalPush(args);
  return dispatchPushToTokens(tokens, {
    title: p.title, body: p.body, data: p.data ?? {}, ttl: p.ttl ?? APPROVAL_PUSH_TTL_SECONDS,
    channelId: p.channelId ?? 'approvals', sound: p.sound, priority: p.priority,
  }, 'approval');
}
```

The approval APNs payload must stay `{ title, body, data, ttl }` with no `collapseId`/`threadId`/`category` keys at all (the wrapper test above asserts `toEqual`, which is key-sensitive) — hence the conditional assignments.

- [ ] **Step 4: Run tests** — `pnpm --filter @breeze/api exec vitest run src/services/expoPush.test.ts src/services/apns.test.ts` and grep for other callers: `rg -n "dispatchApprovalPushToTokens|DispatchApprovalPushResult" apps/api/src` — all must still typecheck (`tsc --noEmit`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/expoPush.ts apps/api/src/services/expoPush.test.ts
git commit -m "feat(api): generalise push dispatch (PushSpec) and add buildTicketPush (#3901)"
```

---

### Task 8: Preference API `GET/PATCH /api/v1/users/me/ticket-push-preferences`

**Rigor: high (auth, self-only writes). Author: codex** with this task pasted verbatim (reference: `apps/api/src/routes/users.ts:312` GET `/me`, `apps/api/src/routes/mobile.ts:681` for `writeRouteAudit`, test harness `apps/api/src/routes/users.test.ts:1-215`).

**Files:**
- Modify: `apps/api/src/routes/users.ts` (add after the `GET /me` handler, before `PATCH /me` at line 464)
- Test: `apps/api/src/routes/users.test.ts`

**Interfaces:**
- Consumes: Task 2 (`updateTicketPushPreferencesSchema`, `resolveTicketPushPrefs`), Task 3 (`ticketPushPreferences` table).
- Produces: `GET → 200 { settings: { assignedEnabled, slaScope } }`; `PATCH → 200 { settings }`, `400` on empty/unknown-key/invalid body. Audit action `user.ticket_push_preferences.update`.

- [ ] **Step 1: Write the failing tests** (append to `users.test.ts`; the file already mocks `authMiddleware` to set `user.id = 'user-123'`, the db, and `createAuditLogAsync`). Add `writeRouteAudit` to the mocks:

```ts
const { writeRouteAuditMock } = vi.hoisted(() => ({ writeRouteAuditMock: vi.fn() }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
```

and add `ticketPushPreferences: { userId: { __column: 'ticket_push_preferences.user_id' }, assignedEnabled: {}, slaScope: {}, updatedAt: {} }` to the `vi.mock('../db/schema', ...)` object. Then:

```ts
describe('GET /me/ticket-push-preferences', () => {
  it('returns defaults when no row exists and does not insert', async () => {
    const app = new Hono().route('/users', userRoutes);
    const res = await app.request('/users/me/ticket-push-preferences');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: { assignedEnabled: true, slaScope: 'owned' } });
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it('returns the stored row', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ assignedEnabled: false, slaScope: 'any' }]) }) }),
    } as never);
    const app = new Hono().route('/users', userRoutes);
    const res = await app.request('/users/me/ticket-push-preferences');
    expect(await res.json()).toEqual({ settings: { assignedEnabled: false, slaScope: 'any' } });
  });
});

describe('PATCH /me/ticket-push-preferences', () => {
  const patch = (body: unknown) =>
    new Hono().route('/users', userRoutes).request('/users/me/ticket-push-preferences', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

  it('400 on empty body', async () => { expect((await patch({})).status).toBe(400); });
  it('400 on unknown key (strict) — userId can never come from the body', async () => {
    expect((await patch({ userId: 'someone-else', slaScope: 'off' })).status).toBe(400);
  });
  it('400 on invalid scope', async () => { expect((await patch({ slaScope: 'all' })).status).toBe(400); });

  it('upserts only the provided fields for auth.user.id and audits', async () => {
    const valuesMock = vi.fn(() => ({
      onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ assignedEnabled: true, slaScope: 'any' }])) })),
    }));
    vi.mocked(db.insert).mockReturnValueOnce({ values: valuesMock } as never);
    const res = await patch({ slaScope: 'any' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: { assignedEnabled: true, slaScope: 'any' } });
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-123', slaScope: 'any' }));
    expect(valuesMock.mock.calls[0]![0]).not.toHaveProperty('assignedEnabled');
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'user.ticket_push_preferences.update', resourceId: 'user-123',
    }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts -t "ticket-push-preferences"`
Expected: FAIL with 404s (route not mounted).

- [ ] **Step 3: Implement** (in `users.ts`; add imports `import { resolveTicketPushPrefs, updateTicketPushPreferencesSchema } from '@breeze/shared';`, `import { ticketPushPreferences } from '../db/schema';`, `import { writeRouteAudit } from '../services/auditEvents';`)

```ts
// W07 (#3901): per-user ticket push preferences. Self-only by construction —
// the user id is auth.user.id, never a param or body field (the schema is
// .strict(), so a smuggled userId is a 400). Lives on the core user route, not
// /mobile, so a web Settings toggle can reuse it later (spec D10).
userRoutes.get('/me/ticket-push-preferences', async (c) => {
  const auth = c.get('auth');
  const rows = await db
    .select({ assignedEnabled: ticketPushPreferences.assignedEnabled, slaScope: ticketPushPreferences.slaScope })
    .from(ticketPushPreferences)
    .where(eq(ticketPushPreferences.userId, auth.user.id))
    .limit(1);
  // Missing row = defaults; no insert on read.
  return c.json({ settings: resolveTicketPushPrefs(rows[0] ?? null) });
});

userRoutes.patch(
  '/me/ticket-push-preferences',
  zValidator('json', updateTicketPushPreferencesSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');
    const set: { assignedEnabled?: boolean; slaScope?: 'off' | 'owned' | 'any'; updatedAt: Date } = { updatedAt: new Date() };
    if (body.assignedEnabled !== undefined) set.assignedEnabled = body.assignedEnabled;
    if (body.slaScope !== undefined) set.slaScope = body.slaScope;

    const [row] = await db
      .insert(ticketPushPreferences)
      .values({ userId: auth.user.id, ...set })
      .onConflictDoUpdate({ target: ticketPushPreferences.userId, set })
      .returning({ assignedEnabled: ticketPushPreferences.assignedEnabled, slaScope: ticketPushPreferences.slaScope });

    writeRouteAudit(c, {
      // orgId is NOT optional on RouteAuditInput [verified `services/auditEvents.ts:119-127`:
      // `orgId: string | null | undefined` is a required property]. Omitting it fails
      // `tsc --noEmit`. A partner-scoped mobile token has no org, hence `?? null`.
      orgId: auth.orgId ?? null,
      action: 'user.ticket_push_preferences.update',
      resourceType: 'user',
      resourceId: auth.user.id,
      details: { ...body },
    });

    return c.json({ settings: resolveTicketPushPrefs(row ?? set) });
  }
);
```

[verified] `RouteAuditInput` = `{ orgId: string | null | undefined; action: string; resourceType: string; resourceId?; resourceName?; details?; result?; initiatedBy? }` (`apps/api/src/services/auditEvents.ts:119-127`). The block above matches it exactly.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts` and `pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`
Expected: PASS. Then hit it for real against the dev stack: `curl -s -H "Authorization: Bearer $TOKEN" localhost:3001/api/v1/users/me/ticket-push-preferences` → `{"settings":{"assignedEnabled":true,"slaScope":"owned"}}`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts
git commit -m "feat(api): GET/PATCH /users/me/ticket-push-preferences (#3901)"
```

---

### Task 9: Make the preference route reachable by the technician it targets

**Rigor: high (this is an authorisation gate on the entire `/users` router). Author: Claude.** Branch: `...-api`.

Without this task the feature is dead on arrival for its own target user, and **no test in Task 8 can catch it**: `users.test.ts`'s default `authMiddleware` mock sets `scope: 'partner'` but no `accessibleOrgIds` [verified `users.test.ts:181-189`], and the gate early-returns on `if (!Array.isArray(auth.accessibleOrgIds))` [verified `users.ts:78-81`], so the membership branch never runs in those tests.

The defect [verified]: `userRoutes.use('*')` (`apps/api/src/routes/users.ts:52-105`) rejects any `auth.scope === 'partner'` caller whose `partnerUsers.orgAccess !== 'all'` with `403 Full partner organization access required` (`:101-103`). Its self-service exemption is `/\/me(\/avatar)?$/` (`:66-68`), which `/api/v1/users/me/ticket-push-preferences` does **not** match. A field technician — a `'selected'`-access partner user, exactly this wave's target — is therefore 403'd on both GET and PATCH.

Mounting the route above the gate is not an option: `authMiddleware` is the preceding `use('*')` on the same router (`:51`), so a handler registered ahead of the gate would also skip authentication. Widening the exemption is the correct fix.

**Files:**
- Modify: `apps/api/src/routes/users.ts:60-72` (the `isSelfServiceRoute` predicate)
- Test: `apps/api/src/routes/users.test.ts` (new `describe` inside the existing `full partner access gate (orgAccess===all)` block, which already owns `seedMembership` and `authAsPartner` [verified `:2639-2672`])

**Interfaces:**
- Consumes: Task 8's mounted routes (the red step below requires them to exist).
- Produces: no new exports. Behaviour: `GET`/`PATCH /users/me/ticket-push-preferences` reach their handlers for every authenticated partner user regardless of `orgAccess`.

- [ ] **Step 1: Write the failing test**

Append inside `describe('full partner access gate (orgAccess===all)')` in `users.test.ts`, reusing its `seedMembership` and `authAsPartner` helpers verbatim:

```ts
    // W07 (#3901): the ticket push preference routes are self-service — the
    // subject is always auth.user.id and the body schema is .strict(), so a
    // smuggled userId is a 400, never an escalation. They must therefore be
    // exempt from the partner-wide MANAGEMENT gate, exactly as /me is. The
    // technician this feature targets is a 'selected'-access partner user; if
    // the gate applies, the whole wave is unreachable for them.
    it('exempts GET /me/ticket-push-preferences for a non-all partner admin', async () => {
      seedMembership('selected');
      authAsPartner();
      // Only select is the preference lookup (no row) — the gate must NOT run
      // its partnerUsers membership query on a self-service path.
      vi.mocked(db.select).mockReset().mockReturnValue({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) })),
      } as any);

      const res = await app.request('/users/me/ticket-push-preferences', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ settings: { assignedEnabled: true, slaScope: 'owned' } });
    });

    it('exempts PATCH /me/ticket-push-preferences for a non-all partner admin', async () => {
      seedMembership('none');
      authAsPartner();
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ assignedEnabled: true, slaScope: 'any' }])),
          })),
        })),
      } as never);

      const res = await app.request('/users/me/ticket-push-preferences', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ slaScope: 'any' }),
      });

      expect(res.status).toBe(200);
    });

    // Control: the gate itself must still bite on partner-wide MANAGEMENT.
    // Without this, widening the regex to something too broad passes silently.
    it("still denies a 'selected' partner-admin on partner-wide user management", async () => {
      seedMembership('selected');
      authAsPartner();
      const res = await app.request('/users', { method: 'GET', headers: { Authorization: 'Bearer token' } });
      expect(res.status).toBe(403);
    });
```

- [ ] **Step 2: Run to verify it fails for the right reason**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts -t "ticket-push-preferences"`

Expected: the two new exemption tests FAIL with **403 and the body `Full partner organization access required`** — not 404, not 500. A 404 means Task 8's routes are not mounted and this task is being run out of order; a 500 means the db mock shape is wrong. The third (control) test passes already and stays as the regression guard.

- [ ] **Step 3: Widen the self-service exemption**

In `apps/api/src/routes/users.ts`, replace the predicate:

```ts
  // Self-service routes (own profile + own/displayed avatar + own notification
  // preferences) must stay accessible to EVERY partner user regardless of
  // org-access level. This gate governs partner-wide user MANAGEMENT only —
  // without this exemption a 'selected'/'none' partner admin would be 403'd on
  // GET/PATCH /me, the top-bar avatar, and (W07, #3901) their own ticket push
  // preferences, which is the field technician this feature exists for.
  //
  // A route may be added here ONLY if its subject is derived from auth.user.id
  // and never from a path param or request body. Both /me/ticket-push-preferences
  // handlers satisfy that: the id is auth.user.id and the PATCH schema is
  // .strict(), so a smuggled `userId` is a 400.
  const path = c.req.path;
  const isSelfServiceRoute =
    /\/me(\/avatar|\/ticket-push-preferences)?$/.test(path) ||
    (c.req.method === 'GET' && /\/avatar$/.test(path));
```

Do **not** widen to `/\/me(\/.*)?$/`: that would auto-exempt every future `/me/*` route, including ones whose subject is not `auth.user.id`. The allowlist is the point.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/users.test.ts` and `pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json`

Expected: the whole file PASSes, including the pre-existing gate suite (`denies a 'selected' partner-admin (403)`, `exempts self-service GET /me`) — those prove the widening did not disable the gate.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/users.ts apps/api/src/routes/users.test.ts
git commit -m "fix(api): exempt /users/me/ticket-push-preferences from the partner-management gate (#3901)"
```

---

### Task 10: `services/ticketPush.ts` — recipient discovery, authorisation, per-user push collection

**Rigor: high (tenant boundary under a system context). Author: Claude.**

**Files:**
- Create: `apps/api/src/services/ticketPush.ts`
- Test: `apps/api/src/services/ticketPush.test.ts`

**Interfaces:**
- Consumes: Task 2 `resolveTicketPushPrefs`; Task 3 `ticketPushPreferences`; Task 5 `isInQuietHours`; Task 7 `buildTicketPush`, `PushSpec`, `TaggedPushToken`, `getUserPushTokens`; `checkNotificationThrottle` (`services/notificationThrottle.ts`); `isApnsConfigured` (`services/apns.ts`); `getUserPermissions/hasPermission/canAccessOrg/PERMISSIONS` (`services/permissions.ts`).
- Produces:
  ```ts
  export interface PushJob { tokens: TaggedPushToken[]; spec: PushSpec }
  export interface RecipientCandidate { userId: string; partnerId: string; status: string; email: string | null }
  export const ANY_SUBSCRIBER_CAP = 500;
  export function anySlaSubscribersQuery(partnerId: string)           // drizzle query, unexecuted (for toSQL tests)
  export async function listAnySlaSubscribers(partnerId: string): Promise<{ users: RecipientCandidate[]; truncated: boolean }>
  export async function loadUserCandidate(userId: string): Promise<RecipientCandidate | null>
  export async function loadTicketPushPrefs(userId: string): Promise<TicketPushPreferences>
  export function assertSamePartner(c: RecipientCandidate, eventPartnerId: string | null, ctx: { ticketId: string }): boolean  // warn+captureException on mismatch
  export async function isAuthorisedForTicket(userId: string, partnerId: string, orgId: string): Promise<boolean>
  export async function getUserPushTargets(userId: string, now?: Date): Promise<TaggedPushToken[]>  // tokens minus quiet-hours devices
  export async function collectTicketPush(userId: string, spec: PushSpec): Promise<PushJob | null>   // D8 + D6 + quiet hours
  export function __resetApnsWarnForTests(): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/ticketPush.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  isApnsConfigured: vi.fn(() => true),
  checkNotificationThrottle: vi.fn(async () => ({ allowed: true, currentCount: 1, windowExpiresAt: 0 })),
  getUserPermissions: vi.fn(),
  captureException: vi.fn(),
  selectRows: vi.fn(async () => [] as unknown[]),
}));
vi.mock('./apns', () => ({ isApnsConfigured: m.isApnsConfigured }));
vi.mock('./notificationThrottle', () => ({ checkNotificationThrottle: m.checkNotificationThrottle }));
vi.mock('./sentry', () => ({ captureException: m.captureException }));
vi.mock('./permissions', async (orig) => {
  const actual = await orig<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: m.getUserPermissions };
});
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const k of ['from', 'innerJoin', 'where', 'orderBy']) chain[k] = vi.fn(() => chain);
      chain.limit = vi.fn(() => m.selectRows());
      chain.then = (res: (v: unknown) => void) => m.selectRows().then(res); // awaited without limit()
      return chain;
    }),
  },
}));

import { db } from '../db';
import { ticketPushPreferences, users, mobileDevices } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import {
  anySlaSubscribersQuery, assertSamePartner, isAuthorisedForTicket, collectTicketPush,
  getUserPushTargets, ANY_SUBSCRIBER_CAP, __resetApnsWarnForTests,
} from './ticketPush';
import { buildTicketPush } from './expoPush';

const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'Acme' });

describe('anySlaSubscribersQuery — compiled SQL (vacuous-Drizzle trap)', () => {
  it('filters on sla_scope = any, users.partner_id = $partner, status = active, ordered, capped', async () => {
    // Real drizzle builder: use the actual db module for this one assertion.
    vi.doUnmock('../db');
    const { db: realDb } = await vi.importActual<typeof import('../db')>('../db');
    const { anySlaSubscribersQuery: build } = await vi.importActual<typeof import('./ticketPush')>('./ticketPush');
    const { sql, params } = build.call({ db: realDb }, 'p-1').toSQL();
    expect(sql).toMatch(/"ticket_push_preferences"\."sla_scope" = \$\d/);
    expect(sql).toMatch(/"users"\."partner_id" = \$\d/);
    expect(sql).toMatch(/"users"\."status" = \$\d/);
    expect(sql).toMatch(/order by "users"\."id"/i);
    expect(sql).toMatch(/limit \$\d/i);
    expect(params).toEqual(expect.arrayContaining(['any', 'p-1', 'active', ANY_SUBSCRIBER_CAP + 1]));
  });
});

describe('assertSamePartner', () => {
  it('returns false, warns and reports when the candidate is in another partner', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = assertSamePartner({ userId: 'u-9', partnerId: 'p-OTHER', status: 'active', email: null }, 'p-1', { ticketId: 't-1' });
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(m.captureException).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('returns true for the same partner', () => {
    expect(assertSamePartner({ userId: 'u-2', partnerId: 'p-1', status: 'active', email: null }, 'p-1', { ticketId: 't-1' })).toBe(true);
  });
  it('returns false when the event has no partner', () => {
    expect(assertSamePartner({ userId: 'u-2', partnerId: 'p-1', status: 'active', email: null }, null, { ticketId: 't-1' })).toBe(false);
  });
});

describe('isAuthorisedForTicket', () => {
  it('requires tickets:read AND org access', async () => {
    m.getUserPermissions.mockResolvedValueOnce({ scope: 'partner', orgAccess: 'selected', allowedOrgIds: ['o-2'], permissions: [{ resource: 'tickets', action: 'read' }] });
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(false);
    m.getUserPermissions.mockResolvedValueOnce({ scope: 'partner', orgAccess: 'all', permissions: [{ resource: 'devices', action: 'read' }] });
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(false);
    m.getUserPermissions.mockResolvedValueOnce({ scope: 'partner', orgAccess: 'all', permissions: [{ resource: 'tickets', action: 'read' }] });
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(true);
  });
  it('is false when permissions resolve to null', async () => {
    m.getUserPermissions.mockResolvedValueOnce(null);
    expect(await isAuthorisedForTicket('u-2', 'p-1', 'o-1')).toBe(false);
  });
});

describe('collectTicketPush', () => {
  beforeEach(() => { vi.clearAllMocks(); __resetApnsWarnForTests(); m.isApnsConfigured.mockReturnValue(true); });

  it('returns null without reading tokens when APNs is not configured (D8)', async () => {
    m.isApnsConfigured.mockReturnValue(false);
    expect(await collectTicketPush('u-2', spec)).toBeNull();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
  it('returns null when throttled (D6) and still does not read tokens', async () => {
    m.checkNotificationThrottle.mockResolvedValueOnce({ allowed: false, currentCount: 21, windowExpiresAt: 0 });
    expect(await collectTicketPush('u-2', spec)).toBeNull();
    expect(m.checkNotificationThrottle).toHaveBeenCalledWith('mobile-ticket', 'user:u-2', 20, 300);
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });
  it('drops devices in quiet hours and returns null when none remain (D12)', async () => {
    m.selectRows.mockResolvedValueOnce([{ apns: 'tok-1', fcm: null, platform: 'ios', quietHours: { start: '00:00', end: '00:00', timezone: 'UTC' } }]);
    expect(await collectTicketPush('u-2', spec)).toBeNull();
  });
  it('returns a PushJob with the tagged tokens otherwise', async () => {
    m.selectRows.mockResolvedValueOnce([{ apns: 'tok-1', fcm: null, platform: 'ios', quietHours: null }]);
    const job = await collectTicketPush('u-2', spec);
    expect(job).toEqual({ tokens: [{ token: 'tok-1', platform: 'ios', provider: 'apns' }], spec });
  });
});
```

If the `toSQL` test's `vi.doUnmock`/`importActual` dance proves brittle, split that single test into `ticketPush.sql.test.ts` with no db mock — the assertion on compiled SQL is the non-negotiable part (memory: vacuous Drizzle where-clause assertions).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/ticketPush.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/ticketPush.ts
/**
 * W07 (#3901): push fan-out helpers for ticket events.
 *
 * Everything here is called by ticketNotifyWorker INSIDE withSystemDbAccessContext,
 * which bypasses RLS. That context is DISCOVERY ONLY. Every recipient is
 * re-authorised (spec D5): same partner as the event, active, holds tickets:read
 * and can access the ticket's org. Network I/O (dispatchPushToTokens) is NOT
 * done here — the worker sends after the context exits (#1105).
 */
import { and, eq, asc } from 'drizzle-orm';
import { resolveTicketPushPrefs, type TicketPushPreferences } from '@breeze/shared';
import { db } from '../db';
import { mobileDevices, ticketPushPreferences, users } from '../db/schema';
import { isApnsConfigured } from './apns';
import { checkNotificationThrottle } from './notificationThrottle';
import { canAccessOrg, getUserPermissions, hasPermission, PERMISSIONS } from './permissions';
import { isInQuietHours, type QuietHoursConfig } from './quietHours';
import { captureException } from './sentry';
import type { PushSpec, TaggedPushToken } from './expoPush';

export interface PushJob { tokens: TaggedPushToken[]; spec: PushSpec }
export interface RecipientCandidate { userId: string; partnerId: string; status: string; email: string | null }

export const ANY_SUBSCRIBER_CAP = 500;
const THROTTLE_CHANNEL = 'mobile-ticket';
const THROTTLE_MAX = 20;
const THROTTLE_WINDOW_S = 300;

let warnedApnsUnconfigured = false;
export function __resetApnsWarnForTests(): void { warnedApnsUnconfigured = false; }

/** Unexecuted builder so the compiled SQL can be asserted (partner filter is the tenant boundary). */
export function anySlaSubscribersQuery(partnerId: string) {
  return db
    .select({ userId: users.id, partnerId: users.partnerId, status: users.status, email: users.email })
    .from(ticketPushPreferences)
    .innerJoin(users, eq(users.id, ticketPushPreferences.userId))
    .where(and(
      eq(ticketPushPreferences.slaScope, 'any'),
      eq(users.partnerId, partnerId),
      eq(users.status, 'active'),
    ))
    .orderBy(asc(users.id))
    .limit(ANY_SUBSCRIBER_CAP + 1); // +1 so truncation is observable
}

export async function listAnySlaSubscribers(partnerId: string): Promise<{ users: RecipientCandidate[]; truncated: boolean }> {
  const rows = await anySlaSubscribersQuery(partnerId);
  const truncated = rows.length > ANY_SUBSCRIBER_CAP;
  if (truncated) {
    console.warn(`[TicketPush] 'any' SLA subscribers exceed cap partner=${partnerId} cap=${ANY_SUBSCRIBER_CAP}; first ${ANY_SUBSCRIBER_CAP} by user id`);
  }
  return { users: rows.slice(0, ANY_SUBSCRIBER_CAP), truncated };
}

export async function loadUserCandidate(userId: string): Promise<RecipientCandidate | null> {
  const rows = await db
    .select({ userId: users.id, partnerId: users.partnerId, status: users.status, email: users.email })
    .from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

export async function loadTicketPushPrefs(userId: string): Promise<TicketPushPreferences> {
  const rows = await db
    .select({ assignedEnabled: ticketPushPreferences.assignedEnabled, slaScope: ticketPushPreferences.slaScope })
    .from(ticketPushPreferences).where(eq(ticketPushPreferences.userId, userId)).limit(1);
  return resolveTicketPushPrefs(rows[0] ?? null);
}

/** D5 step 1: cheap partner assertion. A mismatch is a forged/moved user — terminal + reported. */
export function assertSamePartner(c: RecipientCandidate, eventPartnerId: string | null, ctx: { ticketId: string }): boolean {
  if (eventPartnerId && c.partnerId === eventPartnerId) return true;
  const msg = `[TicketPush] recipient partner mismatch user=${c.userId} userPartner=${c.partnerId} eventPartner=${eventPartnerId} ticket=${ctx.ticketId}`;
  console.warn(msg);
  captureException(new Error(msg));
  return false;
}

/** D5 step 3: permission + org access, resolved through the normal permission service. */
export async function isAuthorisedForTicket(userId: string, partnerId: string, orgId: string): Promise<boolean> {
  const perms = await getUserPermissions(userId, { partnerId, orgId });
  if (!perms) return false;
  return hasPermission(perms, PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action) && canAccessOrg(perms, orgId);
}

/** Active, notifications-enabled devices, minus those inside quiet hours (D12). */
export async function getUserPushTargets(userId: string, now: Date = new Date()): Promise<TaggedPushToken[]> {
  const rows = await db
    .select({ fcm: mobileDevices.fcmToken, apns: mobileDevices.apnsToken, platform: mobileDevices.platform, quietHours: mobileDevices.quietHours })
    .from(mobileDevices)
    .where(and(eq(mobileDevices.userId, userId), eq(mobileDevices.notificationsEnabled, true), eq(mobileDevices.status, 'active')));
  const out: TaggedPushToken[] = [];
  for (const row of rows) {
    if (isInQuietHours(row.quietHours as QuietHoursConfig | null, now)) continue;
    for (const token of [row.fcm, row.apns]) {
      if (!token) continue;
      out.push({ token, platform: row.platform, provider: token.startsWith('ExponentPushToken') ? 'expo' : row.platform === 'ios' ? 'apns' : 'fcm' });
    }
  }
  return out;
}

/** D8 → D6 → tokens → quiet hours. Never throws; null = nothing to send. */
export async function collectTicketPush(userId: string, spec: PushSpec): Promise<PushJob | null> {
  if (!isApnsConfigured()) {
    if (!warnedApnsUnconfigured) {
      warnedApnsUnconfigured = true;
      console.info('[TicketPush] APNs not configured — ticket pushes skipped (in-app + email unaffected)');
    }
    return null;
  }
  const throttle = await checkNotificationThrottle(THROTTLE_CHANNEL, `user:${userId}`, THROTTLE_MAX, THROTTLE_WINDOW_S);
  if (!throttle.allowed) {
    console.warn(`[TicketPush] throttled user=${userId} count=${throttle.currentCount}`);
    return null;
  }
  const tokens = await getUserPushTargets(userId);
  if (tokens.length === 0) return null;
  return { tokens, spec };
}
```

`getUserPushTargets` re-selects rather than wrapping `getUserPushTokens` because that helper does not return `quiet_hours` [verified `expoPush.ts:132-156`]; the provider inference is duplicated deliberately (three lines) rather than exporting `inferProvider`.

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter @breeze/api exec vitest run src/services/ticketPush.test.ts` and `tsc --noEmit`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketPush.ts apps/api/src/services/ticketPush.test.ts
git commit -m "feat(api): ticket push recipient discovery + authorisation helpers (#3901)"
```

---

### Task 11: Worker fan-out — dedupe via `createNotification`, push collection, send after context

**Rigor: high. Author: Claude.**

**Files:**
- Modify: `apps/api/src/jobs/ticketNotifyWorker.ts` (`collectAssigneeNotification`, `collectSlaBreachNotification`, `handleTicketEvent`, the `Worker` processor)
- Test: `apps/api/src/jobs/ticketNotifyWorker.test.ts`

**Interfaces:**
- Consumes: Task 4 `event.eventId`; Task 10 helpers; Task 7 `buildTicketPush`, `dispatchPushToTokens`; `createNotification` (`services/userNotifications.ts`).
- Produces: `handleTicketEvent(event: TicketEvent, jobId?: string): Promise<void>`; the processor passes `job.id`. Dedupe keys: `ticket:<ticketId>:assigned:<assigneeId>:<eventId>` and `ticket:<ticketId>:sla:<target>:<userId>`.

- [ ] **Step 1: Update the test file's mocks and write the failing tests**

Replace the `db.insert` expectation model: the worker no longer calls `db.insert(userNotifications)` for these branches. Add hoisted mocks and module mocks at the top of `ticketNotifyWorker.test.ts`:

```ts
const push = vi.hoisted(() => ({
  createNotification: vi.fn(async () => 'n-1' as string | null),
  loadUserCandidate: vi.fn(async (id: string) => ({ userId: id, partnerId: 'p-1', status: 'active', email: 'tech@msp.example' })),
  loadTicketPushPrefs: vi.fn(async () => ({ assignedEnabled: true, slaScope: 'owned' as const })),
  listAnySlaSubscribers: vi.fn(async () => ({ users: [] as unknown[], truncated: false })),
  isAuthorisedForTicket: vi.fn(async () => true),
  collectTicketPush: vi.fn(async (_u: string, spec: unknown) => ({ tokens: [{ token: 'tok', platform: 'ios', provider: 'apns' }], spec })),
  dispatchPushToTokens: vi.fn(async () => ({ tokensFound: 1, dispatched: 1, errors: 0 })),
  order: [] as string[],
}));
vi.mock('../services/userNotifications', () => ({ createNotification: push.createNotification }));
vi.mock('../services/ticketPush', async (orig) => {
  const actual = await orig<typeof import('../services/ticketPush')>();
  return {
    ...actual,
    loadUserCandidate: push.loadUserCandidate,
    loadTicketPushPrefs: push.loadTicketPushPrefs,
    listAnySlaSubscribers: push.listAnySlaSubscribers,
    isAuthorisedForTicket: push.isAuthorisedForTicket,
    collectTicketPush: (...a: [string, unknown]) => { push.order.push('collect'); return push.collectTicketPush(...a); },
  };
});
vi.mock('../services/expoPush', async (orig) => {
  const actual = await orig<typeof import('../services/expoPush')>();
  return { ...actual, dispatchPushToTokens: (...a: unknown[]) => { push.order.push('dispatch'); return push.dispatchPushToTokens(...(a as [])); } };
});
```

and make `withSystemDbAccessContextMock` record boundaries: `vi.fn(async (fn) => { push.order.push('ctx:enter'); const r = await fn(); push.order.push('ctx:exit'); return r; })`. Also add `organizations: { id: 'id', name: 'name' }` rows to `selectMock` sequences where the worker now looks up the org name (see Step 3 — the assignee branch does `getTicket` → org name; `users` row now comes from `loadUserCandidate`, so the second `selectMock` value in existing tests becomes the org row `[{ name: 'Acme' }]`).

Then the new cases:

```ts
const assigned = (over: Partial<Parameters<typeof handleTicketEvent>[0]> = {}) => ({
  type: 'ticket.assigned' as const, ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1', actorUserId: 'u-1',
  eventId: 'evt-1', payload: { assigneeId: 'u-2' }, ...over,
});
const TICKET = { id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null };

describe('ticket push fan-out (W07)', () => {
  beforeEach(() => { push.order.length = 0; selectMock.mockResolvedValueOnce([TICKET]).mockResolvedValueOnce([{ name: 'Acme' }]); });

  it('assigned: writes the in-app row with the dedupe key, then pushes after the context exits', async () => {
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2', orgId: 'o-1', type: 'ticket', dedupeKey: 'ticket:t-1:assigned:u-2:evt-1',
    }));
    expect(push.dispatchPushToTokens).toHaveBeenCalledWith(
      [{ token: 'tok', platform: 'ios', provider: 'apns' }],
      expect.objectContaining({ title: 'Ticket assigned to you', body: 'T-2026-0042 · Acme' }),
      'ticket',
    );
    expect(push.order).toEqual(['ctx:enter', 'collect', 'ctx:exit', 'dispatch']);
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it('dedupe replay (createNotification → null): no push, no email', async () => {
    push.createNotification.mockResolvedValueOnce(null);
    await handleTicketEvent(assigned() as never);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('falls back to job.id when the event has no eventId (pre-deploy jobs)', async () => {
    await handleTicketEvent({ ...assigned(), eventId: undefined } as never, 'job-77');
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'ticket:t-1:assigned:u-2:job-77' }));
  });

  it('foreign-partner assignee: no row, no push, no email, reported', async () => {
    push.loadUserCandidate.mockResolvedValueOnce({ userId: 'u-2', partnerId: 'p-OTHER', status: 'active', email: 'x@y' });
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).not.toHaveBeenCalled();
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(vi.mocked((await import('../services/sentry')).captureException)).toHaveBeenCalled();
  });

  it('assignedEnabled=false: in-app + email, no push', async () => {
    push.loadTicketPushPrefs.mockResolvedValueOnce({ assignedEnabled: false, slaScope: 'owned' });
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();
    expect(push.collectTicketPush).not.toHaveBeenCalled();
  });

  it('assignee lacking org access is not pushed (row still written)', async () => {
    push.isAuthorisedForTicket.mockResolvedValueOnce(false);
    await handleTicketEvent(assigned() as never);
    expect(push.createNotification).toHaveBeenCalled();
    expect(push.collectTicketPush).not.toHaveBeenCalled();
  });

  it('collectTicketPush null (throttled/quiet/apns-off): row + email, no dispatch', async () => {
    push.collectTicketPush.mockResolvedValueOnce(null);
    await handleTicketEvent(assigned() as never);
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    expect(sendEmailMock).toHaveBeenCalled();
  });
});

describe('sla_breached fan-out (W07)', () => {
  const breach = (assigneeId: string | null) => ({
    type: 'ticket.sla_breached' as const, ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1', actorUserId: null, eventId: 'evt-2',
    payload: { target: 'response' as const, internalNumber: 'T-2026-0042', subject: 'Printer', assigneeId },
  });
  beforeEach(() => { push.order.length = 0; selectMock.mockResolvedValueOnce([TICKET]).mockResolvedValueOnce([{ name: 'Acme' }]); });

  it("owner with slaScope 'owned' gets row + push + email; key has no eventId", async () => {
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2', dedupeKey: 'ticket:t-1:sla:response:u-2' }));
    expect(push.dispatchPushToTokens).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'SLA breached (response)' }), 'ticket');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("owner with slaScope 'off' still gets the in-app row and the email — only the push stops (D6)", async () => {
    push.loadTicketPushPrefs.mockResolvedValueOnce({ assignedEnabled: true, slaScope: 'off' });
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-2', dedupeKey: 'ticket:t-1:sla:response:u-2' }));
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(push.collectTicketPush).not.toHaveBeenCalled();
    expect(push.dispatchPushToTokens).not.toHaveBeenCalled();
    // Short-circuit: 'off' must not cost a permission round-trip.
    expect(push.isAuthorisedForTicket).not.toHaveBeenCalled();
  });

  it("owner who cannot access the org keeps the row but is not pushed", async () => {
    push.isAuthorisedForTicket.mockResolvedValueOnce(false);
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledTimes(1);
    expect(push.collectTicketPush).not.toHaveBeenCalled();
  });

  it("an unauthorised 'any' subscriber gets NO row at all (asymmetry with the owner is deliberate)", async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-5', partnerId: 'p-1', status: 'active', email: null }], truncated: false });
    push.isAuthorisedForTicket.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await handleTicketEvent(breach('u-2') as never);
    const recipients = push.createNotification.mock.calls.map((c) => (c[0] as { userId: string }).userId);
    expect(recipients).toEqual(['u-2']);
  });

  it("unassigned breach reaches only 'any' subscribers; no email", async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [
      { userId: 'u-5', partnerId: 'p-1', status: 'active', email: null },
      { userId: 'u-6', partnerId: 'p-1', status: 'active', email: null },
    ], truncated: false });
    await handleTicketEvent(breach(null) as never);
    expect(push.createNotification).toHaveBeenCalledTimes(2);
    expect(push.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-5', dedupeKey: 'ticket:t-1:sla:response:u-5' }));
    expect(push.dispatchPushToTokens).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("'any' subscriber who is also the owner is notified once", async () => {
    push.loadTicketPushPrefs.mockResolvedValueOnce({ assignedEnabled: true, slaScope: 'any' });
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-2', partnerId: 'p-1', status: 'active', email: 'a@b' }], truncated: false });
    await handleTicketEvent(breach('u-2') as never);
    expect(push.createNotification).toHaveBeenCalledTimes(1);
  });

  it("'any' subscriber without org access is filtered", async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-5', partnerId: 'p-1', status: 'active', email: null }], truncated: false });
    push.isAuthorisedForTicket.mockResolvedValueOnce(false);
    await handleTicketEvent(breach(null) as never);
    expect(push.createNotification).not.toHaveBeenCalled();
  });

  it('every dispatch happens after the system context exits', async () => {
    push.listAnySlaSubscribers.mockResolvedValueOnce({ users: [{ userId: 'u-5', partnerId: 'p-1', status: 'active', email: null }], truncated: false });
    await handleTicketEvent(breach('u-2') as never);
    const exitAt = push.order.indexOf('ctx:exit');
    expect(push.order.filter((x) => x === 'dispatch').length).toBe(2);
    expect(push.order.slice(0, exitAt)).not.toContain('dispatch');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/ticketNotifyWorker.test.ts`
Expected: the new describes FAIL (`createNotification` never called; `dispatchPushToTokens` never called). Pre-existing tests that asserted `insertValuesMock` for the assignee/SLA branches also now fail — update them in Step 3 to assert `push.createNotification` instead (the `ticket.commented`/autoresponse tests are untouched).

- [ ] **Step 3: Implement**

```ts
// ticketNotifyWorker.ts — new imports
import { createNotification } from '../services/userNotifications';
import { buildTicketPush, dispatchPushToTokens } from '../services/expoPush';
import {
  assertSamePartner, collectTicketPush, isAuthorisedForTicket, listAnySlaSubscribers,
  loadTicketPushPrefs, loadUserCandidate, type PushJob,
} from '../services/ticketPush';

async function getOrgName(orgId: string): Promise<string> {
  const rows = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return rows[0]?.name ?? '';
}

/** Resolved once per event; collected results are sent after the context exits. */
interface Collected { emails: EmailPayload[]; pushes: PushJob[] }

async function collectAssigneeNotification(event: TicketEvent, assigneeId: string, eventId: string): Promise<Collected> {
  const none: Collected = { emails: [], pushes: [] };
  if (!assigneeId || assigneeId === event.actorUserId) return none;

  const ticket = await getTicket(event.ticketId);
  if (!ticket) throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);
  const label = ticket.internalNumber ?? ticket.ticketNumber ?? ticket.id;

  // Assignee lookup FIRST (deleted user = terminal), then the partner assertion (D5).
  const assignee = await loadUserCandidate(assigneeId);
  if (!assignee) return none;
  if (!assertSamePartner(assignee, event.partnerId, { ticketId: ticket.id })) return none;
  if (assignee.status !== 'active') return none;

  // Idempotency anchor (D2): null = replay → nothing else happens.
  const id = await createNotification({
    userId: assigneeId, orgId: event.orgId, type: 'ticket', priority: 'normal',
    title: `Ticket assigned: ${label}`, message: ticket.subject,
    link: `/tickets#${ticket.internalNumber ?? ticket.id}`,
    dedupeKey: `ticket:${ticket.id}:assigned:${assigneeId}:${eventId}`,
  });
  if (id === null) return none;

  const emails: EmailPayload[] = assignee.email ? [{
    to: assignee.email,
    subject: `[${label}] Assigned to you: ${ticket.subject}`,
    html: `<p>You have been assigned ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(ticket.subject)}</p>`,
    bestEffort: true,
  }] : [];

  const pushes: PushJob[] = [];
  const prefs = await loadTicketPushPrefs(assigneeId);
  if (prefs.assignedEnabled && event.partnerId && await isAuthorisedForTicket(assigneeId, event.partnerId, event.orgId)) {
    const spec = buildTicketPush({ ticketId: ticket.id, reason: 'assigned', internalNumber: ticket.internalNumber ?? null, orgName: await getOrgName(event.orgId) });
    const job = await collectTicketPush(assigneeId, spec);
    if (job) pushes.push(job);
  }
  return { emails, pushes };
}

async function collectSlaBreachNotification(event: Extract<TicketEvent, { type: 'ticket.sla_breached' }>): Promise<Collected> {
  const ticket = await getTicket(event.ticketId);
  if (!ticket) throw new Error(`Ticket not found (likely uncommitted): ${event.ticketId}`);

  const label = event.payload.internalNumber ?? event.ticketId;
  const target = event.payload.target;
  const emails: EmailPayload[] = [];
  const pushes: PushJob[] = [];
  const notified = new Set<string>();
  let orgName: string | null = null;
  const spec = async () => buildTicketPush({
    ticketId: ticket.id, reason: 'sla_breached', target, internalNumber: event.payload.internalNumber,
    orgName: orgName ?? (orgName = await getOrgName(event.orgId)),
  });

  /**
   * The in-app row is ALWAYS written for a candidate that reaches here; `push`
   * governs the phone only (spec D6: "throttle applies to every push, never to
   * in-app rows", and every push-drop row in the spec's failure-modes table
   * keeps "in-app row + email written"). Suppressing the inbox row would also
   * be a silent behaviour regression: the owner's SLA row is unconditional on
   * main today.
   */
  const notify = async (userId: string, opts: { push: boolean }): Promise<void> => {
    if (notified.has(userId)) return;
    notified.add(userId);
    const id = await createNotification({
      userId, orgId: event.orgId, type: 'ticket', priority: 'normal',
      title: `SLA breached: ${label}`, message: `${target} SLA breached for ${event.payload.subject}`,
      link: `/tickets#${event.payload.internalNumber ?? event.ticketId}`,
      dedupeKey: `ticket:${ticket.id}:sla:${target}:${userId}`,
    });
    if (id === null) return;               // replay — nothing further
    if (!opts.push) return;                // preference says no phone; row already written
    const job = await collectTicketPush(userId, await spec());
    if (job) pushes.push(job);
  };

  // Owner: email and in-app row as before (unconditional). slaScope governs the
  // PUSH only — 'off' means "stop buzzing my phone", not "hide it from my inbox".
  const assigneeId = event.payload.assigneeId;
  if (assigneeId) {
    const assignee = await loadUserCandidate(assigneeId);
    if (assignee && assertSamePartner(assignee, event.partnerId, { ticketId: ticket.id }) && assignee.status === 'active') {
      if (assignee.email) {
        emails.push({
          to: assignee.email,
          subject: `SLA breached: ${label} — ${event.payload.subject}`,
          html: `<p>The ${escapeHtml(target)} SLA breached for ticket <strong>${escapeHtml(label)}</strong>: ${escapeHtml(event.payload.subject)}</p>`,
          bestEffort: true,
        });
      }
      const prefs = await loadTicketPushPrefs(assigneeId);
      // Short-circuit deliberately: skip the permission round-trip when the
      // preference already rules the push out.
      const pushOwner =
        prefs.slaScope !== 'off' &&
        !!event.partnerId &&
        (await isAuthorisedForTicket(assigneeId, event.partnerId, event.orgId));
      await notify(assigneeId, { push: pushOwner });
    }
  }

  // 'any' subscribers (D5): partner-filtered in SQL, re-authorised per user. Push only — no email (spec Q9).
  // NOTE the asymmetry with the owner branch above and it is intentional: an
  // 'any' subscriber gets NO row at all when unauthorised, because they would
  // not otherwise be a recipient of this ticket — writing an inbox row for
  // someone who cannot access the org would leak the ticket's existence. The
  // owner is already a legitimate recipient, so only their push is gated.
  if (event.partnerId) {
    const { users: subs } = await listAnySlaSubscribers(event.partnerId);
    for (const s of subs) {
      if (notified.has(s.userId)) continue;
      if (!assertSamePartner(s, event.partnerId, { ticketId: ticket.id })) continue;
      if (!(await isAuthorisedForTicket(s.userId, event.partnerId, event.orgId))) continue;
      await notify(s.userId, { push: true });
    }
  }
  return { emails, pushes };
}
```

In `handleTicketEvent`:

```ts
export async function handleTicketEvent(event: TicketEvent, jobId?: string): Promise<void> {
  const eventId = event.eventId ?? jobId ?? `legacy:${event.ticketId}:${event.type}`;
  let emailPayloads: EmailPayload[] = [];
  let pushJobs: PushJob[] = [];

  await runWithSystemDbAccess(async () => {
    switch (event.type) {
      case 'ticket.created':
      case 'ticket.assigned': {
        const assigneeId = event.payload.assigneeId;
        if (assigneeId) {
          const c = await collectAssigneeNotification(event, assigneeId, eventId);
          emailPayloads = c.emails; pushJobs = c.pushes;
        }
        return;
      }
      case 'ticket.sla_breached': {
        const c = await collectSlaBreachNotification(event);
        emailPayloads = c.emails; pushJobs = c.pushes;
        return;
      }
      // ... other cases unchanged ...
    }
  });

  // Emails: unchanged loop.
  // Pushes — OUTSIDE the DB context (#1105). Best-effort; dispatchPushToTokens never throws.
  for (const job of pushJobs) {
    const r = await dispatchPushToTokens(job.tokens, job.spec, 'ticket');
    if (r.errors > 0) console.warn(`[TicketNotify] ticket push partial failure ticket=${event.ticketId} dispatched=${r.dispatched} errors=${r.errors}`);
  }
}
```

Make the early `if (emailPayloads.length === 0) return;` NOT skip the push loop (move the push loop above it, or change the guard to `if (emailPayloads.length > 0) { ...email loop... }`). Processor: `async (job: Job<TicketEvent>) => handleTicketEvent(job.data, job.id)`.

- [ ] **Step 4: Run all worker tests + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/jobs/ticketNotifyWorker.test.ts src/jobs/ticketNotifyWorker.leak.test.ts src/jobs/ticketNotifyWorker.graphFork.test.ts src/services/ticketPush.test.ts` and `tsc --noEmit`
Expected: PASS. The leak test's "never leaks an internal note" invariant must still hold — `buildTicketPush` never receives `subject`; grep the diff: `git diff apps/api/src/jobs/ticketNotifyWorker.ts | grep -n "subject" ` shows subject only in email/in-app strings.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.test.ts
git commit -m "feat(api): ticket assignment + SLA breach push fan-out with dedupe (#3901)"
```

---

### Task 12: Fan-out integration test against real Postgres

**Rigor: high. Author: Claude** (codex may draft from `userNotificationsRls.integration.test.ts` + `db-utils.ts` once handed this task).

**Files:**
- Test: `apps/api/src/__tests__/integration/ticketPushFanout.integration.test.ts`

**Interfaces:**
- Consumes: `handleTicketEvent` (Task 11), `ticketPushPreferences`, `userNotifications`, `db-utils` (`createPartner`, `createOrganization`, `createUser`, `createRole`, **`grantRolePermissions`**, `assignUserToPartner`, `assignUserToOrganization` [verified exports at `db-utils.ts:59, 106, 146, 254, 279, 314, 335`]). There is **no** `createTicket` factory [verified] — the test inserts into `tickets` directly.

**Two seeding traps this task must not fall into** (both verified against `db-utils.ts` on origin/main):

1. **`createUser({ withMembership: true })` grants zero permissions.** It calls `createRole` (`db-utils.ts:254-270`), which inserts a `roles` row and nothing else; grants come only from the separate `grantRolePermissions` (`:279-303`), which this plan must call explicitly. The fan-out gate is `hasPermission(perms, 'tickets', 'read')` (`services/permissions.ts:210`), so a `withMembership` user is filtered out — every assertion would see `[]` and the "obvious fix" (loosening the expectation to `[]`) would be a vacuously green test that proves nothing. **Do not use `withMembership`; build the role explicitly.**
2. **`tickets.ticket_number` is `NOT NULL` with no default** [verified `apps/api/src/db/schema/portal.ts:72`, `varchar('ticket_number',{length:50}).notNull().unique()`; DDL confirmed at `apps/api/migrations/0001-baseline.sql:5865`]. An insert that omits it dies at seed time with a `23502` not-null violation, taking every test in the file with it. Do **not** silence the resulting type error with `as never` — that cast is exactly what would hide the missing column. `status` is the `ticket_status` enum `['new','open','pending','on_hold','resolved','closed']` [verified `portal.ts:7`].

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/__tests__/integration/ticketPushFanout.integration.test.ts
/**
 * W07 (#3901): the push fan-out's tenant boundary, proven against real Postgres.
 * The worker runs in a system context (RLS bypass), so isolation is entirely
 * app-layer: partner filter in SQL + per-user permission re-check. Push
 * transport is mocked (no APNs in CI); the observable is user_notifications.
 */
import './setup';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';

vi.mock('../../services/apns', async (orig) => ({ ...(await orig<typeof import('../../services/apns')>()), isApnsConfigured: () => true }));
const dispatch = vi.fn(async () => ({ tokensFound: 1, dispatched: 1, errors: 0 }));
vi.mock('../../services/expoPush', async (orig) => ({ ...(await orig<typeof import('../../services/expoPush')>()), dispatchPushToTokens: dispatch }));
vi.mock('../../services/email', () => ({ getEmailService: () => null }));

import { db, withSystemDbAccessContext } from '../../db';
import { mobileDevices, ticketPushPreferences, tickets, userNotifications } from '../../db/schema';
import { handleTicketEvent } from '../../jobs/ticketNotifyWorker';
import { ANY_SUBSCRIBER_CAP } from '../../services/ticketPush';
import {
  assignUserToOrganization, assignUserToPartner, createOrganization, createPartner,
  createRole, createUser, grantRolePermissions,
} from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`;

/**
 * A user who actually passes the fan-out gate: membership + a role that really
 * holds `tickets:read` through the permissions catalog getUserPermissions
 * resolves at runtime. `createUser({withMembership:true})` is NOT enough — its
 * role has zero permissions (db-utils.ts:254-270); grants live in the separate
 * grantRolePermissions (db-utils.ts:279-303). Pass `perms: []` to build the
 * negative control: same shape, no tickets:read.
 */
async function makeUser(opts: {
  partnerId: string;
  orgId?: string | null;
  perms?: Array<{ resource: string; action: string }>;
  orgAccess?: 'all' | 'selected' | 'none';
}) {
  const perms = opts.perms ?? [{ resource: 'tickets', action: 'read' }];
  const user = await createUser({ partnerId: opts.partnerId, orgId: opts.orgId ?? null, email: `${uniq('fanout')}@example.com` });
  if (opts.orgId) {
    const role = await createRole({ scope: 'organization', orgId: opts.orgId, partnerId: opts.partnerId });
    if (perms.length) await grantRolePermissions(role.id, perms);
    await assignUserToOrganization(user.id, opts.orgId, role.id);
  } else {
    const role = await createRole({ scope: 'partner', partnerId: opts.partnerId });
    if (perms.length) await grantRolePermissions(role.id, perms);
    await assignUserToPartner(user.id, opts.partnerId, role.id, opts.orgAccess ?? 'all');
  }
  return user;
}

async function seed() {
  const p1 = await createPartner();
  const p2 = await createPartner();
  const orgA = await createOrganization({ partnerId: p1.id });
  const orgB = await createOrganization({ partnerId: p1.id });

  // Partner-wide, tickets:read, orgAccess 'all' — the ticket's assignee.
  const owner = await makeUser({ partnerId: p1.id });
  // Org-scoped to orgA (the ticket's org) — must receive.
  const anyA = await makeUser({ partnerId: p1.id, orgId: orgA.id });
  // Org-scoped to orgB — must NOT receive (canAccessOrg false).
  const anyB = await makeUser({ partnerId: p1.id, orgId: orgB.id });
  // Another partner entirely — must NOT receive (SQL partner filter).
  const foreign = await makeUser({ partnerId: p2.id });
  // NEGATIVE CONTROL: right partner, opted into 'any', but NO tickets:read.
  // Without this user a run where the permission grant silently failed would
  // still look "correct" — everyone excluded for the wrong reason.
  const noPerm = await makeUser({ partnerId: p1.id, perms: [] });

  await withSystemDbAccessContext(async () => {
    for (const u of [anyA, anyB, foreign, noPerm]) {
      await db.insert(ticketPushPreferences).values({ userId: u.id, slaScope: 'any' });
      await db.insert(mobileDevices).values({ userId: u.id, deviceId: uniq('dev'), platform: 'ios', apnsToken: `tok-${u.id}` });
    }
    await db.insert(mobileDevices).values({ userId: owner.id, deviceId: uniq('dev'), platform: 'ios', apnsToken: `tok-${owner.id}` });
  });

  // ticket_number is NOT NULL with no default; status is the ticket_status enum.
  // No `as never` — the cast is what would hide a missing required column.
  const [ticket] = await withSystemDbAccessContext(() =>
    db.insert(tickets).values({
      orgId: orgA.id,
      partnerId: p1.id,
      ticketNumber: uniq('TKT'),
      internalNumber: 'T-2026-0042',
      subject: 'Printer',
      status: 'open',
      assignedTo: owner.id,
    }).returning());

  return { p1, p2, orgA, orgB, owner, anyA, anyB, foreign, noPerm, ticket: ticket! };
}

const rowsFor = (ticketId: string) => withSystemDbAccessContext(() =>
  db.select({ userId: userNotifications.userId, dedupeKey: userNotifications.dedupeKey })
    .from(userNotifications).where(eq(userNotifications.link, `/tickets#${ticketId}`)));

describe('ticket push fan-out — tenant boundary', () => {
  beforeEach(() => dispatch.mockClear());

  runDb("cross-partner 'any' opt-in receives nothing; org-scoped user receives only own-org breaches", async () => {
    const fx = await seed();
    await handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: fx.ticket.id, orgId: fx.orgA.id, partnerId: fx.p1.id, actorUserId: null, eventId: 'e1',
      payload: { target: 'response', internalNumber: null, subject: 'Printer', assigneeId: fx.owner.id },
    });
    const ids = (await rowsFor(fx.ticket.id)).map((r) => r.userId).sort();

    // BOTH halves must fire. The positive half proves the permission grant
    // actually resolved (an empty `ids` is a broken fixture, not a pass);
    // the negative half proves the boundary discriminates.
    expect(ids).toContain(fx.owner.id);
    expect(ids).toContain(fx.anyA.id);
    expect(ids).not.toContain(fx.anyB.id);    // orgB — canAccessOrg false
    expect(ids).not.toContain(fx.foreign.id); // partner 2 — SQL partner filter
    expect(ids).not.toContain(fx.noPerm.id);  // no tickets:read
    expect(ids).toEqual([fx.owner.id, fx.anyA.id].sort());
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  runDb('replaying the same breach yields no second row and no second push', async () => {
    const fx = await seed();
    const ev = {
      type: 'ticket.sla_breached' as const, ticketId: fx.ticket.id, orgId: fx.orgA.id, partnerId: fx.p1.id, actorUserId: null, eventId: 'e1',
      payload: { target: 'resolution' as const, internalNumber: null, subject: 'Printer', assigneeId: fx.owner.id },
    };
    await handleTicketEvent(ev);
    dispatch.mockClear();
    await handleTicketEvent(ev);
    expect(dispatch).not.toHaveBeenCalled();
    const rows = await rowsFor(fx.ticket.id);
    expect(rows.filter((r) => r.userId === fx.owner.id)).toHaveLength(1);
  });

  runDb('A→B→A reassignment pushes twice; a retry of one event does not', async () => {
    const fx = await seed();
    const assign = (eventId: string) => handleTicketEvent({
      type: 'ticket.assigned', ticketId: fx.ticket.id, orgId: fx.orgA.id, partnerId: fx.p1.id, actorUserId: fx.anyB.id, eventId,
      payload: { assigneeId: fx.owner.id },
    });
    await assign('e-a1'); await assign('e-a1'); await assign('e-a2');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  runDb(`'any' fan-out is capped at ${ANY_SUBSCRIBER_CAP} and always includes the owner`, async () => {
    const fx = await seed();
    // makeUser goes through db-utils' own privileged handle; keep it OUTSIDE
    // withSystemDbAccessContext so the two connection paths never nest.
    const extras: string[] = [];
    for (let i = 0; i < ANY_SUBSCRIBER_CAP + 5; i++) {
      const u = await makeUser({ partnerId: fx.p1.id });   // real tickets:read grant, not withMembership
      extras.push(u.id);
    }
    await withSystemDbAccessContext(async () => {
      for (const id of extras) {
        await db.insert(ticketPushPreferences).values({ userId: id, slaScope: 'any' });
      }
    });
    await handleTicketEvent({
      type: 'ticket.sla_breached', ticketId: fx.ticket.id, orgId: fx.orgA.id, partnerId: fx.p1.id, actorUserId: null, eventId: 'e-cap',
      payload: { target: 'response', internalNumber: null, subject: 'Printer', assigneeId: fx.owner.id },
    });
    const rows = await rowsFor(fx.ticket.id);
    expect(rows.length).toBeLessThanOrEqual(ANY_SUBSCRIBER_CAP + 1);
    expect(rows.some((r) => r.userId === fx.owner.id)).toBe(true);
  });
});
```

This test is slow (505 users × role + grant). If it pushes the shard over its budget, drop `ANY_SUBSCRIBER_CAP` to a test-injectable constant rather than deleting the test — the cap is a tenant-blast-radius control, not a nicety.

- [ ] **Step 2: Run to verify failure, then prove every control discriminates**

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketPushFanout.integration.test.ts`

Expected: before Task 11 lands it fails on missing `eventId`/no rows; after Task 11 it PASSes. Confirm in the output that **4 tests ran, none skipped** — `runIf` silently skips the whole file without `DATABASE_URL`, and `0 tests` is a stall, not a pass.

Then run each mutation below one at a time, confirm the named test goes red, and revert before the next. A control that cannot be made to fail is not a control:

| Temporary mutation | Test that must go RED |
|---|---|
| `assertSamePartner` returns `true` unconditionally | first test — `fx.foreign.id` appears in `ids` |
| `isAuthorisedForTicket` returns `true` unconditionally | first test — `fx.anyB.id` and `fx.noPerm.id` appear |
| drop the `eq(users.partnerId, partnerId)` clause from `anySlaSubscribersQuery` | first test — `fx.foreign.id` appears |
| `createNotification` called without `dedupeKey` | replay test — two rows for the owner |

If a mutation leaves the suite green, the fixture is not exercising that path — fix the fixture, not the expectation.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/ticketPushFanout.integration.test.ts
git commit -m "test(api): real-DB tenant-boundary proof for ticket push fan-out (#3901)"
```

---

### Task 13: Mobile — `parseTicketNotification`, `tickets` channel, badge-aware handler

**Rigor: low. Author: Claude** (pure parser is codex-able from `parseApprovalNotification`; the handler change touches the shared `setNotificationHandler`).

**Branch switch — do this first.** Tasks 13–18 land on the stacked mobile branch created in Task 1:

```bash
git switch feature/3206-mobile-ticketing-time-entry/wave-3901-mobile
git merge --ff-only feature/3206-mobile-ticketing-time-entry/wave-3901-api
```

A non-fast-forward here means the API branch diverged after Task 1 — stop and reconcile rather than merging.

**Files:**
- Modify: `apps/mobile/src/services/notifications.ts`
- Test: `apps/mobile/src/services/notifications.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TicketPushData { ticketId: string; reason: 'assigned' | 'sla_breached'; target?: 'response' | 'resolution' }
  export function parseTicketData(data: Record<string, unknown> | null | undefined): TicketPushData | null   // pure
  export function parseTicketNotification(n: Notification | NotificationResponse['notification']): TicketPushData | null
  export function shouldSetBadgeFor(data: Record<string, unknown> | null | undefined): boolean  // false for type==='ticket'
  ```

- [ ] **Step 1: Write the failing tests** (append; the file already mocks `expo-notifications`)

```ts
import { parseTicketData, shouldSetBadgeFor } from './notifications';

describe('parseTicketData', () => {
  it('parses assigned and sla_breached payloads', () => {
    expect(parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'assigned' })).toEqual({ ticketId: 't-1', reason: 'assigned' });
    expect(parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'sla_breached', target: 'response' }))
      .toEqual({ ticketId: 't-1', reason: 'sla_breached', target: 'response' });
  });
  it('returns null for malformed or non-ticket data', () => {
    expect(parseTicketData(null)).toBeNull();
    expect(parseTicketData({ type: 'approval', approvalId: 'a' })).toBeNull();
    expect(parseTicketData({ type: 'ticket' })).toBeNull();
    expect(parseTicketData({ type: 'ticket', ticketId: 42, reason: 'assigned' })).toBeNull();
    expect(parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'bogus' })).toBeNull();
  });
  it('drops an unknown target but keeps the notification', () => {
    expect(parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'sla_breached', target: 'x' })).toEqual({ ticketId: 't-1', reason: 'sla_breached' });
  });
});

describe('shouldSetBadgeFor', () => {
  it('is false for ticket pushes and true otherwise (badge stays owned by approvals)', () => {
    expect(shouldSetBadgeFor({ type: 'ticket', ticketId: 't-1', reason: 'assigned' })).toBe(false);
    expect(shouldSetBadgeFor({ type: 'approval', approvalId: 'a' })).toBe(true);
    expect(shouldSetBadgeFor(undefined)).toBe(true);
  });
});

it('registers a tickets Android channel', async () => {
  platform.OS = 'android';
  constants.expoConfig = { extra: { eas: { projectId: 'proj' } } };
  notif.getPermissionsAsync.mockResolvedValue({ status: 'granted' });
  notif.getExpoPushTokenAsync.mockResolvedValue({ data: 'ExponentPushToken[x]' });
  await registerForPushNotifications();
  expect(notif.setNotificationChannelAsync).toHaveBeenCalledWith('tickets', expect.objectContaining({ name: 'Tickets' }));
});
```

(Adjust the last test's setup to match the existing android-channel test in the file — reuse its arrangement verbatim.)

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/mobile exec vitest run src/services/notifications.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement**

```ts
// notifications.ts
export interface TicketPushData { ticketId: string; reason: 'assigned' | 'sla_breached'; target?: 'response' | 'resolution' }

/** Pure parser over the `data` map. Server contract: services/expoPush.ts buildTicketPush. */
export function parseTicketData(data: Record<string, unknown> | null | undefined): TicketPushData | null {
  if (!data || data.type !== 'ticket') return null;
  if (typeof data.ticketId !== 'string' || data.ticketId.length === 0) return null;
  if (data.reason !== 'assigned' && data.reason !== 'sla_breached') return null;
  const out: TicketPushData = { ticketId: data.ticketId, reason: data.reason };
  if (data.target === 'response' || data.target === 'resolution') out.target = data.target;
  return out;
}

export function parseTicketNotification(
  notification: Notifications.Notification | Notifications.NotificationResponse['notification']
): TicketPushData | null {
  return parseTicketData(notification.request.content.data as Record<string, unknown> | undefined);
}

/** Ticket pushes never touch the badge — reconcileApprovalNotifications owns it. */
export function shouldSetBadgeFor(data: Record<string, unknown> | null | undefined): boolean {
  return !(data && data.type === 'ticket');
}
```

Replace the handler at the top of the file:

```ts
Notifications.setNotificationHandler({
  handleNotification: async (n) => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: shouldSetBadgeFor(n.request.content.data as Record<string, unknown> | undefined),
  }),
});
```

and in the Android channel block add, after the `approvals` channel:

```ts
      await Notifications.setNotificationChannelAsync('tickets', {
        name: 'Tickets',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200],
        lightColor: '#1c8a9e',
        sound: 'default',
      });
```

- [ ] **Step 4: Run tests** — `pnpm --filter @breeze/mobile exec vitest run src/services/notifications.test.ts` and `pnpm --filter @breeze/mobile exec tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/notifications.ts apps/mobile/src/services/notifications.test.ts
git commit -m "feat(mobile): parse ticket pushes; tickets channel; badge untouched by ticket pushes (#3901)"
```

---

### Task 14: Mobile — `pushRouting.ts` and `navigationRef.ts`

**Rigor: low. Author: Claude.**

**Files:**
- Create: `apps/mobile/src/navigation/pushRouting.ts`, `apps/mobile/src/navigation/pushRouting.test.ts`
- Create: `apps/mobile/src/navigation/navigationRef.ts`, `apps/mobile/src/navigation/navigationRef.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // pushRouting.ts (pure, no RN imports)
  export type PushRoute = { kind: 'ticket'; ticketId: string } | null;
  export function resolvePushRoute(data: Record<string, unknown> | null | undefined): PushRoute;
  export function shouldReplayResponse(identifier: string | null | undefined, lastHandled: string | null): boolean;
  export const LAST_HANDLED_RESPONSE_KEY = 'notif:lastHandledResponseId';
  // navigationRef.ts
  export const navigationRef: NavigationContainerRefWithCurrent<MainTabParamList>;
  export function navigateToTicket(ticketId: string): void;   // buffers when !isReady()
  export function flushPendingNavigation(): void;             // call from NavigationContainer onReady
  export function __resetPendingForTests(): void;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// pushRouting.test.ts
import { describe, it, expect } from 'vitest';
import { resolvePushRoute, shouldReplayResponse } from './pushRouting';

describe('resolvePushRoute', () => {
  it('routes ticket data to TicketDetail', () => {
    expect(resolvePushRoute({ type: 'ticket', ticketId: 't-1', reason: 'assigned' })).toEqual({ kind: 'ticket', ticketId: 't-1' });
  });
  it('ignores approvals, alerts and garbage', () => {
    expect(resolvePushRoute({ type: 'approval', approvalId: 'a' })).toBeNull();
    expect(resolvePushRoute({ alertId: 'x', eventType: 'alert.triggered' })).toBeNull();
    expect(resolvePushRoute(null)).toBeNull();
  });
});

describe('shouldReplayResponse', () => {
  it('replays a never-seen identifier once', () => {
    expect(shouldReplayResponse('r-1', null)).toBe(true);
    expect(shouldReplayResponse('r-1', 'r-1')).toBe(false);
    expect(shouldReplayResponse('r-2', 'r-1')).toBe(true);
  });
  it('never replays without an identifier', () => {
    expect(shouldReplayResponse(undefined, null)).toBe(false);
  });
});
```

```ts
// navigationRef.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ref = vi.hoisted(() => ({ ready: false, navigate: vi.fn() }));
vi.mock('@react-navigation/native', () => ({
  createNavigationContainerRef: () => ({ isReady: () => ref.ready, navigate: ref.navigate }),
}));

import { navigateToTicket, flushPendingNavigation, __resetPendingForTests } from './navigationRef';

describe('navigateToTicket', () => {
  beforeEach(() => { ref.ready = false; ref.navigate.mockClear(); __resetPendingForTests(); });

  it('navigates immediately when the container is ready', () => {
    ref.ready = true;
    navigateToTicket('t-1');
    expect(ref.navigate).toHaveBeenCalledWith('TicketsTab', { screen: 'TicketDetail', params: { ticketId: 't-1' } });
  });
  it('buffers one pending id before ready and flushes exactly once on onReady', () => {
    navigateToTicket('t-1');
    navigateToTicket('t-2'); // latest wins
    expect(ref.navigate).not.toHaveBeenCalled();
    ref.ready = true;
    flushPendingNavigation();
    flushPendingNavigation();
    expect(ref.navigate).toHaveBeenCalledTimes(1);
    expect(ref.navigate).toHaveBeenCalledWith('TicketsTab', { screen: 'TicketDetail', params: { ticketId: 't-2' } });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/mobile exec vitest run src/navigation/pushRouting.test.ts src/navigation/navigationRef.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// apps/mobile/src/navigation/pushRouting.ts
import { parseTicketData } from '../services/notifications';

export type PushRoute = { kind: 'ticket'; ticketId: string } | null;
export const LAST_HANDLED_RESPONSE_KEY = 'notif:lastHandledResponseId';

export function resolvePushRoute(data: Record<string, unknown> | null | undefined): PushRoute {
  const t = parseTicketData(data);
  return t ? { kind: 'ticket', ticketId: t.ticketId } : null;
}

/** Cold-start replay guard: getLastNotificationResponseAsync returns the same response on every mount. */
export function shouldReplayResponse(identifier: string | null | undefined, lastHandled: string | null): boolean {
  if (!identifier) return false;
  return identifier !== lastHandled;
}
```

`parseTicketData` lives in `services/notifications.ts`, which imports `expo-notifications` at module top — `pushRouting.test.ts` therefore needs the same `vi.mock('expo-notifications', ...)`, `vi.mock('react-native', ...)`, `vi.mock('expo-device', ...)`, `vi.mock('expo-constants', ...)` factories as `notifications.test.ts`. Copy that block to the top of `pushRouting.test.ts`.

```ts
// apps/mobile/src/navigation/navigationRef.ts
import { createNavigationContainerRef } from '@react-navigation/native';
import type { MainTabParamList } from './MainNavigator';

/**
 * Module-level ref so non-screen code (PushTapRouter) can navigate. The
 * container may not be ready on a cold-start tap; buffer the latest target and
 * flush from NavigationContainer onReady (spec D9). No `linking` config — no
 * URL-scheme consumer exists.
 */
export const navigationRef = createNavigationContainerRef<MainTabParamList>();

let pendingTicketId: string | null = null;

export function navigateToTicket(ticketId: string): void {
  if (!navigationRef.isReady()) {
    pendingTicketId = ticketId;
    return;
  }
  navigationRef.navigate('TicketsTab', { screen: 'TicketDetail', params: { ticketId } } as never);
}

export function flushPendingNavigation(): void {
  if (!pendingTicketId) return;
  const id = pendingTicketId;
  pendingTicketId = null;
  navigateToTicket(id);
}

export function __resetPendingForTests(): void { pendingTicketId = null; }
```

[not-checked] whether `navigate('TicketsTab', { screen, params })` typechecks against `MainTabParamList` (`TicketsTab: undefined`). If it does not, widen `MainTabParamList` in `MainNavigator.tsx` to `TicketsTab: NavigatorScreenParams<TicketsStackParamList> | undefined` (import `NavigatorScreenParams` from `@react-navigation/native`) rather than casting.

- [ ] **Step 4: Run tests + tsc** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/navigation/pushRouting.ts apps/mobile/src/navigation/pushRouting.test.ts apps/mobile/src/navigation/navigationRef.ts apps/mobile/src/navigation/navigationRef.test.ts apps/mobile/src/navigation/MainNavigator.tsx
git commit -m "feat(mobile): push route resolver + buffered navigationRef for ticket taps (#3901)"
```

---

### Task 15: Mobile — `PushTapRouter` and `RootNavigator` wiring

**Rigor: low. Author: Claude.**

**Files:**
- Create: `apps/mobile/src/navigation/PushTapRouter.tsx`
- Modify: `apps/mobile/src/navigation/RootNavigator.tsx:300-312`

**Interfaces:**
- Consumes: Task 13 `parseTicketNotification`, `getLastNotificationResponse`, listener helpers; Task 14 `navigateToTicket`, `flushPendingNavigation`, `navigationRef`, `shouldReplayResponse`, `LAST_HANDLED_RESPONSE_KEY`; `fetchTickets` from `store/ticketsSlice`.
- Produces: `<PushTapRouter />` (renders nothing).

No unit test (`.tsx` is outside the mobile vitest include); the behaviour is covered by Tasks 13–14 and the manual device checklist in Task 19.

- [ ] **Step 1: Implement `PushTapRouter.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useAppDispatch } from '../store';
import { fetchTickets } from '../store/ticketsSlice';
import {
  addNotificationReceivedListener,
  addNotificationResponseReceivedListener,
  getLastNotificationResponse,
  parseTicketNotification,
  removeNotificationSubscription,
} from '../services/notifications';
import { navigateToTicket } from './navigationRef';
import { LAST_HANDLED_RESPONSE_KEY, shouldReplayResponse } from './pushRouting';

/**
 * Ticket-only push listeners (spec D9). Sibling of ApprovalGate: expo
 * subscriptions are independently removable, so a second type-filtered
 * listener coexists with the approval ones. Never touches approval state — a
 * ticket tap while an approval is focused navigates underneath and is revealed
 * when the decision clears.
 */
export function PushTapRouter() {
  const dispatch = useAppDispatch();
  const lastHandled = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const handleTap = async (identifier: string, ticketId: string) => {
      lastHandled.current = identifier;
      try { await AsyncStorage.setItem(LAST_HANDLED_RESPONSE_KEY, identifier); } catch { /* best-effort */ }
      navigateToTicket(ticketId);
    };

    // Cold start: replay the launching response once, identifier-guarded.
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(LAST_HANDLED_RESPONSE_KEY);
        if (!cancelled && lastHandled.current === null) lastHandled.current = stored;
        const last = await getLastNotificationResponse();
        if (cancelled || !last) return;
        const parsed = parseTicketNotification(last.notification);
        if (!parsed) return;
        const id = last.notification.request.identifier;
        if (!shouldReplayResponse(id, lastHandled.current)) return;
        await handleTap(id, parsed.ticketId);
      } catch (err) {
        console.warn('[PushTapRouter] cold-start replay failed', err);
      }
    })();

    const recv = addNotificationReceivedListener((n) => {
      if (!parseTicketNotification(n)) return;
      // Foreground: keep the list fresh; the OS banner handles presentation.
      dispatch(fetchTickets({}));
    });
    const tap = addNotificationResponseReceivedListener((r) => {
      const parsed = parseTicketNotification(r.notification);
      if (!parsed) return;
      void handleTap(r.notification.request.identifier, parsed.ticketId);
    });

    return () => {
      cancelled = true;
      removeNotificationSubscription(recv);
      removeNotificationSubscription(tap);
    };
  }, [dispatch]);

  return null;
}
```

`fetchTickets` takes `{ statusGroup, assignee }` [verified `TicketsScreen.tsx:94`]; the reducer echoes params back and drops responses that lost the filter race, so dispatching with the current store values is correct: read them with `store.getState().tickets.queue` / `.assignee` (or select them in the component) and pass `fetchTickets({ statusGroup: queue, assignee })` instead of `fetchTickets({})`.

- [ ] **Step 2: Wire `RootNavigator.tsx`**

```tsx
import { PushTapRouter } from './PushTapRouter';
import { navigationRef, flushPendingNavigation } from './navigationRef';
// ...
    <NavigationContainer theme={navigationTheme} ref={navigationRef} onReady={flushPendingNavigation}>
      {token ? (
        hasOnboarded ? (
          <>
            <PushTapRouter />
            <ApprovalGate>
              <MainNavigator />
            </ApprovalGate>
          </>
        ) : (
```

**`PushTapRouter` is a SIBLING of `ApprovalGate`, never a child.** [verified `apps/mobile/src/navigation/ApprovalGate.tsx:81-83`] `ApprovalGate` does `if (focused) return <ApprovalScreen />;` — it does **not** render `children` while an approval is focused. A nested `PushTapRouter` would therefore unmount and tear down its notification subscriptions the moment an approval arrives, dropping exactly the taps spec D9 requires to survive: "a ticket tap while an approval is focused still navigates underneath and is revealed when the decision clears". As a sibling it stays mounted through the whole approval lifecycle. Current shape (no `ref`, no `linking`, `ApprovalGate` wrapping `MainNavigator`) verified at `apps/mobile/src/navigation/RootNavigator.tsx:299-312`.

It still must be inside the authenticated **and** onboarded branch, so a tap never navigates a logged-out container.

Belt-and-braces regression note for the reviewer: if a later refactor moves `PushTapRouter` under `ApprovalGate`, the symptom is silent — pushes still arrive, taps just stop routing while an approval is on screen. The manual check in Task 19 Step 2 ("approval overlay focused, then ticket tap") is the only thing that catches it; do not drop that line from the checklist.

- [ ] **Step 3: Typecheck and run on a device**

Run: `pnpm --filter @breeze/mobile exec tsc --noEmit`. Then on a dev build: send a ticket push (assign from web with APNs configured on the dev API, or `curl` the APNs sandbox), tap it from background → `TicketDetail` opens; force-quit, tap → opens after boot; relaunch normally → no navigation (replay guard).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/navigation/PushTapRouter.tsx apps/mobile/src/navigation/RootNavigator.tsx
git commit -m "feat(mobile): route ticket push taps to TicketDetail (warm + cold start) (#3901)"
```

---

### Task 16: Mobile — API client + `notificationPrefsSlice`

**Rigor: low. Author: codex** for the slice from `apps/mobile/src/store/ticketsSlice.ts` + its test; Claude wires `store/index.ts`.

**Files:**
- Modify: `apps/mobile/src/services/api.ts` (add two functions near `coreRequest`)
- Create: `apps/mobile/src/store/notificationPrefsSlice.ts`, `apps/mobile/src/store/notificationPrefsSlice.test.ts`
- Modify: `apps/mobile/src/store/index.ts` (register `notificationPrefs: notificationPrefsReducer`)

**Interfaces:**
- Consumes: nothing from `@breeze/shared` — [verified `grep @breeze/shared apps/mobile/package.json` → no match] the mobile app does not depend on the shared package, so the two types and the default object are declared locally in `services/api.ts` with the same names as Task 2 (the wire contract is the `settings` object, checked by Task 8's route tests).
- Produces:
  ```ts
  // services/api.ts
  export async function getTicketPushPrefs(): Promise<TicketPushPreferences>            // GET /users/me/ticket-push-preferences → settings
  export async function updateTicketPushPrefs(patch: UpdateTicketPushPreferences): Promise<TicketPushPreferences>
  // store/notificationPrefsSlice.ts
  interface NotificationPrefsState { prefs: TicketPushPreferences; status: 'idle'|'loading'|'ready'|'error'; saving: boolean; error: string | null }
  export const loadTicketPushPrefs = createAsyncThunk('notificationPrefs/load', ...)
  export const saveTicketPushPrefs = createAsyncThunk('notificationPrefs/save', async (patch) => ...)  // optimistic; rollback on reject
  export const selectTicketPushPrefs, selectTicketPushPrefsSaving, selectTicketPushPrefsError
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/mobile/src/store/notificationPrefsSlice.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import reducer, { loadTicketPushPrefs, saveTicketPushPrefs, clearError } from './notificationPrefsSlice';

const initial = reducer(undefined, { type: '@@init' });

describe('notificationPrefsSlice', () => {
  it('starts at defaults', () => {
    expect(initial.prefs).toEqual({ assignedEnabled: true, slaScope: 'owned' });
    expect(initial.status).toBe('idle');
  });

  it('load.fulfilled replaces prefs', () => {
    const s = reducer(initial, loadTicketPushPrefs.fulfilled({ assignedEnabled: false, slaScope: 'any' }, 'r', undefined));
    expect(s.prefs).toEqual({ assignedEnabled: false, slaScope: 'any' });
    expect(s.status).toBe('ready');
  });

  it('save.pending applies the patch optimistically; save.rejected rolls back and records the error', () => {
    const pending = reducer(initial, saveTicketPushPrefs.pending('r', { slaScope: 'any' }));
    expect(pending.prefs.slaScope).toBe('any');
    expect(pending.saving).toBe(true);
    const rejected = reducer(pending, saveTicketPushPrefs.rejected(null, 'r', { slaScope: 'any' }, 'Network down'));
    expect(rejected.prefs.slaScope).toBe('owned');
    expect(rejected.saving).toBe(false);
    expect(rejected.error).toBe('Network down');
  });

  it('save.fulfilled adopts the server echo', () => {
    const pending = reducer(initial, saveTicketPushPrefs.pending('r', { assignedEnabled: false }));
    const done = reducer(pending, saveTicketPushPrefs.fulfilled({ assignedEnabled: false, slaScope: 'owned' }, 'r', { assignedEnabled: false }));
    expect(done.prefs).toEqual({ assignedEnabled: false, slaScope: 'owned' });
    expect(done.saving).toBe(false);
  });

  it('clearError clears', () => {
    expect(reducer({ ...initial, error: 'x' }, clearError()).error).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/mobile exec vitest run src/store/notificationPrefsSlice.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// services/api.ts — append
export type TicketSlaPushScope = 'off' | 'owned' | 'any';
export interface TicketPushPreferences { assignedEnabled: boolean; slaScope: TicketSlaPushScope }
export type UpdateTicketPushPreferences = Partial<TicketPushPreferences>;

export async function getTicketPushPrefs(): Promise<TicketPushPreferences> {
  const res = await coreRequest<{ settings: TicketPushPreferences }>('/users/me/ticket-push-preferences');
  return res.settings;
}

export async function updateTicketPushPrefs(patch: UpdateTicketPushPreferences): Promise<TicketPushPreferences> {
  const res = await coreRequest<{ settings: TicketPushPreferences }>('/users/me/ticket-push-preferences', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.settings;
}
```

(Local copies are deliberate: the app has no `@breeze/shared` dependency [verified]. Do not add one for two types.)

```ts
// store/notificationPrefsSlice.ts
import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { getTicketPushPrefs, updateTicketPushPrefs, type TicketPushPreferences, type UpdateTicketPushPreferences } from '../services/api';

const DEFAULTS: TicketPushPreferences = { assignedEnabled: true, slaScope: 'owned' };

interface NotificationPrefsState {
  prefs: TicketPushPreferences;
  status: 'idle' | 'loading' | 'ready' | 'error';
  saving: boolean;
  /** Snapshot taken on save.pending so save.rejected can roll back. */
  rollback: TicketPushPreferences | null;
  error: string | null;
}

const initialState: NotificationPrefsState = { prefs: DEFAULTS, status: 'idle', saving: false, rollback: null, error: null };

export const loadTicketPushPrefs = createAsyncThunk('notificationPrefs/load', async (_: void, { rejectWithValue }) => {
  try { return await getTicketPushPrefs(); }
  catch (e: unknown) { return rejectWithValue((e as { message?: string }).message ?? 'Failed to load notification settings'); }
});

export const saveTicketPushPrefs = createAsyncThunk('notificationPrefs/save', async (patch: UpdateTicketPushPreferences, { rejectWithValue }) => {
  try { return await updateTicketPushPrefs(patch); }
  catch (e: unknown) { return rejectWithValue((e as { message?: string }).message ?? 'Failed to save notification settings'); }
});

const slice = createSlice({
  name: 'notificationPrefs',
  initialState,
  reducers: { clearError(state) { state.error = null; } },
  extraReducers: (b) => {
    b.addCase(loadTicketPushPrefs.pending, (s) => { s.status = 'loading'; });
    b.addCase(loadTicketPushPrefs.fulfilled, (s, a) => { s.prefs = a.payload; s.status = 'ready'; });
    b.addCase(loadTicketPushPrefs.rejected, (s, a) => { s.status = 'error'; s.error = (a.payload as string) ?? a.error.message ?? 'Failed'; });
    b.addCase(saveTicketPushPrefs.pending, (s, a) => {
      s.rollback = { ...s.prefs };
      s.prefs = { ...s.prefs, ...a.meta.arg };
      s.saving = true; s.error = null;
    });
    b.addCase(saveTicketPushPrefs.fulfilled, (s, a) => { s.prefs = a.payload; s.saving = false; s.rollback = null; });
    b.addCase(saveTicketPushPrefs.rejected, (s, a) => {
      if (s.rollback) s.prefs = s.rollback;
      s.rollback = null; s.saving = false;
      s.error = (a.payload as string) ?? a.error.message ?? 'Failed to save';
    });
  },
});

export const { clearError } = slice.actions;
export default slice.reducer;
export const selectTicketPushPrefs = (st: { notificationPrefs: NotificationPrefsState }) => st.notificationPrefs.prefs;
export const selectTicketPushPrefsSaving = (st: { notificationPrefs: NotificationPrefsState }) => st.notificationPrefs.saving;
export const selectTicketPushPrefsError = (st: { notificationPrefs: NotificationPrefsState }) => st.notificationPrefs.error;
```

Register in `store/index.ts`: `import notificationPrefsReducer from './notificationPrefsSlice';` and `notificationPrefs: notificationPrefsReducer,` in `combineReducers`. `withLogoutReset` wipes it on sign-out automatically; `logoutResetContract.test.ts` [not-checked] may enumerate slices — run it and add the slice if it asserts the list.

- [ ] **Step 4: Run tests + tsc** — `pnpm --filter @breeze/mobile exec vitest run src/store/` → PASS (including `logoutResetContract.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/services/api.ts apps/mobile/src/store/notificationPrefsSlice.ts apps/mobile/src/store/notificationPrefsSlice.test.ts apps/mobile/src/store/index.ts
git commit -m "feat(mobile): ticket push preference client + slice with optimistic save (#3901)"
```

---

### Task 17: Mobile — Settings sheet controls

**Rigor: low. Author: Claude.**

**Files:**
- Modify: `apps/mobile/src/screens/chat/components/SettingsSheet.tsx` (Notifications section around line 413; helpers at 692+)

**Interfaces:**
- Consumes: Task 16 slice/selectors; `useNetworkConnected` (`lib/useNetworkConnected.ts`); existing `ToggleRow`, `SectionDivider`, `setToast`.
- Produces: two new rows under the existing `NotificationsRow`, only when `pushRegistration === 'ok'`.

- [ ] **Step 1: Implement**

In the component body:

```tsx
const connected = useNetworkConnected();
const prefs = useAppSelector(selectTicketPushPrefs);
const prefsSaving = useAppSelector(selectTicketPushPrefsSaving);
const prefsError = useAppSelector(selectTicketPushPrefsError);

useEffect(() => {
  if (visible && pushRegistration === 'ok') void dispatch(loadTicketPushPrefs());
}, [visible, pushRegistration, dispatch]);

useEffect(() => {
  if (prefsError) {
    setToast({ kind: 'error', text: 'Could not save notification settings.' });
    dispatch(clearNotificationPrefsError());
  }
}, [prefsError, dispatch]);

const onToggleAssigned = (v: boolean) => { void dispatch(saveTicketPushPrefs({ assignedEnabled: v })); };
const onPickSlaScope = (scope: TicketSlaPushScope) => { if (scope !== prefs.slaScope) void dispatch(saveTicketPushPrefs({ slaScope: scope })); };
```

In JSX directly after `<NotificationsRow ... />`:

```tsx
{pushRegistration === 'ok' ? (
  <>
    <ToggleRow
      label="Assigned to me"
      description="Push when a ticket is assigned to you"
      value={prefs.assignedEnabled}
      onChange={onToggleAssigned}
      disabled={!connected || prefsSaving}
      theme={theme}
    />
    <SegmentedRow
      label="SLA breaches"
      // These controls govern PUSH only (spec D6). "Off" must not read as
      // "hide it entirely" — the in-app inbox row and the email are written
      // regardless, and Task 11 implements exactly that. Say so in the copy;
      // a toggle that quietly means more than it says is how support tickets
      // get filed against the notification system.
      description={
        connected
          ? 'Push when a ticket misses its response or resolution SLA. Your in-app inbox still records every breach.'
          : 'Offline — reconnect to change'
      }
      value={prefs.slaScope}
      options={[
        { value: 'off', label: 'Off' },
        { value: 'owned', label: 'My tickets' },
        { value: 'any', label: 'All tickets' },
      ]}
      onChange={onPickSlaScope}
      disabled={!connected || prefsSaving}
      theme={theme}
    />
  </>
) : null}
```

Add `disabled?: boolean` to `ToggleRow` (pass `disabled` to `<Switch>` and dim the label with `opacity: disabled ? 0.5 : 1`). Add a new `SegmentedRow` helper next to `ToggleRow`:

```tsx
function SegmentedRow<T extends string>({ label, description, value, options, onChange, disabled, theme }: {
  label: string; description?: string; value: T; options: { value: T; label: string }[];
  onChange: (v: T) => void; disabled?: boolean; theme: ReturnType<typeof useApprovalTheme>;
}) {
  return (
    <View style={{ paddingHorizontal: spacing[6], paddingVertical: spacing[3], opacity: disabled ? 0.5 : 1 }}>
      <Text style={[type.bodyMd, { color: theme.textHi }]}>{label}</Text>
      {description ? <Text style={[type.meta, { color: theme.textMd, marginTop: spacing[1] }]}>{description}</Text> : null}
      <View style={{ flexDirection: 'row', marginTop: spacing[2], borderRadius: radii.md, backgroundColor: theme.bg3, padding: 2 }}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="button"
              accessibilityState={{ selected, disabled: !!disabled }}
              disabled={disabled}
              onPress={() => onChange(o.value)}
              style={{ flex: 1, paddingVertical: spacing[2], alignItems: 'center', borderRadius: radii.sm, backgroundColor: selected ? palette.brand.deep : 'transparent' }}
            >
              <Text style={[type.meta, { color: selected ? palette.brand.base : theme.textMd }]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
```

Import `radii`, `Pressable` if not already imported in the file [not-checked]. Export `clearError as clearNotificationPrefsError` from the slice in `store/index.ts` (both slices export `clearError`, as the file's comment warns).

- [ ] **Step 2: Typecheck and verify on device**

`pnpm --filter @breeze/mobile exec tsc --noEmit`. On device: open Settings → rows appear only when push is registered; flip "Assigned to me" → `GET` from web (or `curl`) shows `assignedEnabled:false`; pick "All tickets" → `slaScope:'any'`; airplane mode → controls disabled; kill the API and flip → toast + value rolls back.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/screens/chat/components/SettingsSheet.tsx apps/mobile/src/store/index.ts
git commit -m "feat(mobile): ticket push preference controls in Settings (#3901)"
```

---

### Task 18: Documentation — ticket push categories and the preference endpoints

**Rigor: low. Author: codex** with this task pasted verbatim (reference: the `update-breeze-docs` skill for house style; existing tables in `apps/docs/src/content/docs/features/mobile.mdx:146-156` and `notifications.mdx:404-418` for the endpoint-table format). Branch: `...-mobile`.

This wave ships two user-visible push categories, a tap-to-open behaviour, and two new public endpoints, and it makes a shipped documentation claim **actively false**. Neither is optional: `apps/docs/src/content/docs/features/notifications.mdx:344` currently reads *"APNS (iOS) push delivery is currently stubbed and not yet fully implemented"* [verified], which contradicts both this wave and the already-shipped approval push path.

**Files:**
- Modify: `apps/docs/src/content/docs/features/mobile.mdx` (the `## Push Notifications` section, `:117-157`)
- Modify: `apps/docs/src/content/docs/features/notifications.mdx` (the `<Aside>` at `:343-345`)

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 7–17. Documentation only — no code, no exports.

- [ ] **Step 1: Correct the stale APNs claim**

In `notifications.mdx`, replace the `<Aside type="note">` at `:343-345`:

```mdx
<Aside type="note">
  APNs (iOS) delivery is live: it powers approval requests and ticket push
  categories. Android push via FCM is functional when `FIREBASE_SERVICE_ACCOUNT`
  is configured; ticket push categories are iOS-only today — the server logs and
  skips FCM tokens for them.
</Aside>
```

Do not simply delete the Aside. The FCM caveat is still true and self-hosters rely on it.

- [ ] **Step 2: Document the two ticket push categories**

In `mobile.mdx`, add a `### Ticket Notifications` subsection after `### Notification Handling` (`:137-145`):

```mdx
### Ticket Notifications

Technicians receive two categories of ticket push on iOS:

| Category | Sent when | Governed by |
|----------|-----------|-------------|
| **Assigned to me** | A ticket is assigned to you by someone else (self-assignment never pushes) | `assignedEnabled` |
| **SLA breach** | A ticket misses its response or resolution SLA | `slaScope` |

Tapping either notification opens that ticket's detail screen, from a cold start as well as from the background.

Notification bodies are lock-screen safe: they carry the ticket number and the customer organization only, never the ticket subject. The subject loads after you unlock and the app authenticates.

**What the preferences do and do not suppress.** These settings govern **push delivery only**. Your in-app notification inbox and any configured email still record every assignment and breach, so turning pushes off never hides work from you -- it only stops your phone buzzing.

Additional delivery rules:

- **Quiet hours** configured on the device suppress ticket pushes outright; they are dropped, not deferred.
- A **per-user burst cap** (20 pushes per 5 minutes) protects against bulk reassignment. Capped pushes are dropped; the in-app rows are still written.
- `All tickets` fans out to at most 500 opted-in technicians per breach event.
```

- [ ] **Step 3: Document the preference endpoints**

In `mobile.mdx`, extend the `### Notification Settings` section (`:146-156`) with:

```mdx
Ticket push categories are a **per-user** preference (they follow you across every phone you sign in on), configured from **Settings** in the app or through the API:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/users/me/ticket-push-preferences` | Read the caller's ticket push preferences. Returns defaults when nothing has been saved |
| PATCH | `/users/me/ticket-push-preferences` | Update one or both settings |

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `assignedEnabled` | `boolean` | `true` | Push when a ticket is assigned to you |
| `slaScope` | `"off" \| "owned" \| "any"` | `"owned"` | `off` = no SLA pushes; `owned` = tickets assigned to you; `any` = every ticket in your MSP you have access to |

Both endpoints act on the authenticated caller only -- there is no way to read or write another user's preferences, and a `userId` in the request body is rejected.
```

Contrast this with the per-**device** settings table directly above it (`enabled`, `severities`, `quietHours`, set via `PATCH /devices/:id/settings`); the difference is the thing readers get wrong.

- [ ] **Step 4: Build the docs site**

```bash
pnpm --filter @breeze/docs build
```

Expected: PASS. Starlight fails the build on a broken internal link or malformed MDX, so this is the check that matters. Note the escaped pipe (`\|`) inside the union type in the table cell — an unescaped one silently splits the column.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/features/mobile.mdx apps/docs/src/content/docs/features/notifications.mdx
git commit -m "docs: ticket push categories, preference endpoints, retire the stale APNs-stubbed note (#3901)"
```

---

### Task 19: Verification sweep and PRs

**Rigor: high (contract suites gate the merge). Author: Claude.**

**Files:** none new.

- [ ] **Step 1: Full local runs**

Every command uses `exec vitest run`. **Never `pnpm --filter @breeze/shared test` or `pnpm --filter @breeze/api test`** — both packages' `test` script is a bare `"vitest"` [verified `packages/shared/package.json:21`, `apps/api/package.json:25`], i.e. watch mode, which never returns in an agent shell. (`apps/mobile` is `"vitest run"` and would be safe, but stay uniform.)

```bash
pnpm --filter @breeze/shared exec vitest run
pnpm --filter @breeze/api exec vitest run --pool=threads --maxWorkers=2
pnpm --filter @breeze/mobile exec vitest run
pnpm lint
pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json
pnpm --filter @breeze/mobile exec tsc --noEmit
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
pnpm --filter @breeze/api test:rls
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/ticketPushPreferencesRls.integration.test.ts \
  src/__tests__/integration/ticketPushFanout.integration.test.ts \
  src/__tests__/integration/userNotificationsRls.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/docs build
ls apps/api/migrations | tail -3   # bump the migration date if anything newer than 2026-09-22 shipped
```

Expected: all green; the integration output lists each new file with a non-zero test count (a `0 tests` line is a stall or a skip, not a pass).

Also diff the migration against `origin/main` before pushing — a mid-flight sweep on another branch can have shipped a file that changes the ordering:

```bash
git diff --stat origin/main -- apps/api/migrations/
```

- [ ] **Step 2: Manual device checklist (TestFlight/dev build, iOS, APNs configured)**

Assign from web → push → tap from terminated / background / foreground; A→B→A pushes twice; response + resolution breach via a short SLA policy; unassigned breach with "All tickets" on one user and "My tickets" on another (only the first is pushed); approval overlay focused then ticket tap → ticket revealed after decision; revoke the user's org access → tap gives the 403 error state; badge unchanged after ticket pushes; offline tap → load-error + Retry; self-hosted stack without APNs → one `[TicketPush] APNs not configured` info line, no worker errors. Record outcomes in the PR body.

- [ ] **Step 3: Open the backend PR**

Branch `feature/3206-mobile-ticketing-time-entry/wave-3901-api` → `main` (Tasks 2–12).

Issue keyword: **`Refs #3901`**, never `Part of #3901`. `AGENTS.md:315-333` admits only `Closes` (full fix) or `Refs` (partial) — `Part of` is neither, closes nothing, and carries no scope note; that section exists because ~15 fully-fixed issues sat open for weeks under exactly this pattern. And a bare `Refs` is just as bad, so the body must state the split explicitly:

> `Refs #3901` — this PR ships the **backend half** of W07: the `ticket_push_preferences` table and its RLS, the preference endpoints, the push-sender generalisation, and the worker fan-out with dedupe. The mobile half (tap routing, Settings controls, docs) ships in the stacked PR and **that** one closes #3901.

Also include: the registration-list table from the spec (and the "no diff expected" cascade/export result), the migration-date re-check output, the contract-suite output with per-file test counts, and the deviations listed in §Self-review.

Open with `gh pr create`; **stop** — do not merge (plan rule: the final task opens the PR).

- [ ] **Step 4: Open the mobile PR**

Branch `feature/3206-mobile-ticketing-time-entry/wave-3901-mobile` → the backend branch (Tasks 13–18). Body: **`Closes #3901`** (this one completes the wave), the device checklist results from Step 2, and the docs diff.

A stacked PR whose base is not `main` runs **no CI** — `ci.yml` triggers on `pull_request: branches: [main]`, so `gh pr checks` reads as green off two smoke workflows. Dispatch explicitly:

```bash
gh workflow run CI --ref feature/3206-mobile-ticketing-time-entry/wave-3901-mobile
```

After the backend PR squash-merges, the mobile branch will show phantom conflicts against the squashed commit; fix with `git rebase --onto main <base-SHA-recorded-in-Task-1-Step-2>` and re-dispatch CI. Do not resolve those conflicts by hand.

- [ ] **Step 5: Do not merge, do not close**

Both PRs stay open for review. Do not `gh pr merge`, do not close #3901 — the `Closes` keyword on the mobile PR does that on merge, and merging is the user's call.

---

## Self-review against the spec

- **Spec coverage:** D1 (Task 11 in the worker), D2 (Tasks 4, 11, 12), D3/D4 (Task 3), D5 (Tasks 10, 11, 12), D6/D8/D12 (Tasks 10, 11), D7 (no audit rows — nothing added), D9 (Tasks 14–15), D10 (Tasks 8, 9), D11 (Task 7 + leak grep in Task 11), D13 (Task 2). Registration table → Task 3 Steps 5–6. API section → Tasks 2, 7, 8, 9. Backend flow → Tasks 10–11. Mobile flow → Tasks 13–17. Docs → Task 18. Testing section: every listed unit suite has a task; contract suites in Tasks 3, 12, 19; manual checks in Task 19.

- **Task → branch map.** Task 1 creates both branches. `...-api`: Tasks 2–12. `...-mobile` (stacked, fast-forwarded at Task 13): Tasks 13–18. Task 19 opens both PRs.

- **Rigor and authorship at a glance:**

  | Task | Rigor | Author |
  |---|---|---|
  | 1 branches + wave open | low | Claude |
  | 2 shared validator | low | codex |
  | 3 migration + RLS + registration | **high** | Claude designs, codex may execute the SQL/test verbatim |
  | 4 `eventId` envelope | low | codex |
  | 5 quiet-hours extraction | low | codex |
  | 6 APNs `thread-id`/`category` | low | codex |
  | 7 `PushSpec` / `buildTicketPush` | low | codex |
  | 8 preference endpoints | **high** (auth, self-only writes) | codex with the task pasted verbatim |
  | 9 self-service gate widening | **high** (authorisation gate on the whole `/users` router) | Claude |
  | 10 `ticketPush.ts` | **high** (tenant boundary under a system context) | Claude |
  | 11 worker fan-out | **high** | Claude |
  | 12 fan-out integration test | **high** | Claude (codex may draft from `userNotificationsRls.integration.test.ts`) |
  | 13 mobile parser | low | Claude (parser body codex-able) |
  | 14 `pushRouting` + `navigationRef` | low | Claude |
  | 15 `PushTapRouter` + `RootNavigator` | low | Claude |
  | 16 mobile client + slice | low | codex for the slice, Claude wires `store/index.ts` |
  | 17 Settings sheet | low | Claude |
  | 18 docs | low | codex |
  | 19 verification + PRs | **high** (contract suites gate the merge) | Claude |

- **Deviations to flag in the PR:** (a) `getUserPushTargets` re-selects devices instead of reusing `getUserPushTokens` because the latter drops `quiet_hours`. (b) The `TicketEventInput` type in Task 4 needs the distributive-omit form; existing worker tests get `eventId` literals. (c) Task 9 widens an authorisation predicate that governs the whole `/users` router — call it out explicitly for the reviewer rather than burying it in the preference-API diff. (d) `slaScope='off'` suppresses the owner's push but **not** their in-app row: this preserves today's unconditional-row behaviour and matches spec D6. An earlier draft of this plan had it suppress the row too; that was a spec contradiction and is resolved, not deferred.

- **Type consistency:** `PushJob`, `PushSpec`, `TaggedPushToken`, `RecipientCandidate`, `TicketPushPreferences`, `collectTicketPush(userId, spec)`, `dispatchPushToTokens(tokens, spec, label)`, `notify(userId, { push })`, `handleTicketEvent(event, jobId?)`, `navigateToTicket`/`flushPendingNavigation`, `parseTicketData`/`parseTicketNotification`, `makeUser(...)` are named identically across tasks.

- **Critic gaps closed in this revision** (each verified against origin/main at the cited path): preference route unreachable behind the partner-management gate → Task 9; fan-out integration test authorised nobody → Task 12 `makeUser` + `grantRolePermissions` + mutation table; `tickets.ticket_number` NOT NULL omitted from the seed → Task 12; `PushTapRouter` nested inside a gate that does not render children → Task 15; no `apps/docs` task and a false shipped claim → Task 18; vacuous `app.scope`/`app.user_id` RLS forge → Task 3 Step 7 with a positive control; `slaScope='off'` contradicting spec D6 → Task 11 + Task 17 copy; `writeRouteAudit` missing the required `orgId` → Task 8; no branch creation → Task 1; watch-mode `pnpm test` invocations → Task 19 Step 1; `Task 8`/`Task 11` mis-numbering → whole-plan renumber; `Part of #3901` → `Refs`/`Closes` split in Task 19; `feature/` vs `feat/` prefix conflict → resolved in Global Constraints with the origin-branch evidence.
