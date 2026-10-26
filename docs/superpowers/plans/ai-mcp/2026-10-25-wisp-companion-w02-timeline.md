---
spec: docs/superpowers/specs/ai-mcp/2026-10-25-wisp-home-companion.md
wave: W02 (W02a API, W02b web)
tracking_issue: LanternOps/breeze#10210
---

# Wisp companion W02 — Thread timeline and proactive posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wisp's proactive output (morning brief, concern nudges, digest) becomes durable posts on the thread, and the Wisp home reads one timeline that merges every attached session's messages with those posts, so the conversation is the single record, pageable backwards.

**Architecture:** A new partner-anchored, org-optional table `wisp_thread_posts` (the quorum's option B, 2026-10-25) is written by `notifyUser` in its database phase, independent of the in-app and push channels, keyed by the same dedupe key as the notification, and linked to the notification row when one was created. A derived keyset read, `listThreadTimeline`, unions `ai_messages` across the thread's sessions (per-session org inside the grant's live ceiling) with the posts, newest first, in the activity timeline's cursor style. The web thread column renders the timeline (older sessions + posts) before the live session's messages from the store, with "Load earlier". Budget notices keep using the delivery primitive but never become posts: a post is written only when the caller passes an explicit post.

**Tech Stack:** Hono + Drizzle + hand-written SQL migrations with forced RLS (API), Zod in `@breeze/shared`, Astro + React + Zustand (web), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-25-wisp-home-companion.md` §5 (waves), §6 (contract; quorum verdict B and its adjustments), §4.2 (posts).

## Quorum verdict (Codex gpt-6-astra, xhigh, read-only, 2026-10-25)

Chosen: **B, a posts table**, messages stay derived from `ai_messages`. Adjustments adopted: (1) persist the post in `notifyUser`'s database phase regardless of channel selection, otherwise push-only users have no history; (2) the in-app write and the post write share one system-context callback in `deliverInApp` when the in-app channel is on, commit before push; (3) explicit post kinds, never "everything else is a nudge" (budget notices also call `deliverInApp`); (4) `notification_id` nullable `ON DELETE SET NULL`; (5) backfill from surviving notifications by `metadata.wispThreadId` (the real key; not `threadId`), idempotent, original timestamps; (6) keep `excludeSessionId` because streaming ids and persisted ids differ; (7) keyset `(created_at ms-truncated, source, id)` with the activity timeline's UTC rule for timezone-less columns; (8) preserve message `id` and `contentBlocks` in the DTO. Noted, not built here: historical scope leakage (an accessible session may quote an org the grant has since lost; today's single-session history has the same property), recorded as a follow-up issue by W02a Task 9.

## Execution split and parallelism

Two sub-issues, run **in parallel**, each based on `origin/main` and targeting `main`:
- **W02a — API** (owns `apps/api/**`, `packages/shared/**`, `apps/docs/**` API notes): Tasks 1–9.
- **W02b — Web** (owns `apps/web/**`, `e2e-tests/**`, the docs home section): Tasks 10–15. **Starts after W01 merges** (it extends W01's grouping module and thread column). It builds against W02a's contract (this doc, Task 4 Interfaces) with mocked `fetchWithAuth`; if W02a's shared types are not on main yet, copy `packages/shared/src/types/wispTimeline.ts` and the validator additions **verbatim** from `origin/feature/10210-wisp-companion/wave-10212`.

PARALLEL GROUPS (W02a): G1 = Task 1 (migration + schema + registries). G2 = Task 2 ∥ Task 3. G3 = Task 4 ∥ Task 5. G4 = Task 6. G5 = Task 7 ∥ Task 8. Task 9 last.
PARALLEL GROUPS (W02b): G1 = Task 10 ∥ Task 11. G2 = Task 12. G3 = Task 13 ∥ Task 14. Task 15 last.
**Sonnet:** Task 3 (shared types + validator), Task 8 (docs), Task 11 (`WispPost` rendering), Task 14 (thread page), Task 15 docs half. Everything else Opus (migration, RLS, registries, delivery path, ceiling, the store seam).
- Concurrent subagents never `git commit`; the fixer commits once per group. Groups run in order.
- Scoped tests: `cd apps/api && pnpm exec vitest run <path>`; the org-cascade, merge-registry, export-policy and rls-coverage suites fail only under **Integration Tests** (never Test API), and a PR targeting `main` runs them; do not stack.
- Never touch an existing file under `apps/api/migrations/`; never rename one.

## Global Constraints

- **Migration name** sorts after the newest committed migration. At plan time that is `2027-01-06-130000-flow-runs.sql`; the slot is `2027-01-06-140000-wisp-thread-posts.sql`. Re-check `ls apps/api/migrations/*.sql | sort | tail -1` before writing; if something newer landed, take the next `-XX0000` slot after it. Idempotent, no inner `BEGIN;`/`COMMIT;`; the backfill writes rows, so `SELECT set_config('breeze.scope', 'system', true);` comes first.
- **Tenancy obligations** for `wisp_thread_posts` (partner-anchored, org-optional, the `wisp_thread_links` shape): RLS enabled and forced in the same migration; policy `org_id IS NOT NULL AND breeze_has_org_access(org_id) OR org_id IS NULL AND breeze_has_partner_access(partner_id)` for USING and WITH CHECK; `GRANT SELECT, INSERT, UPDATE, DELETE TO breeze_app`; every composite FK to an `org_id` column `DEFERRABLE INITIALLY IMMEDIATE`; registered beside `wisp_thread_links` in **every** list that names it: `grep -rn "wisp_thread_links\|wispThreadLinks" apps/api/src --include='*.ts'` and add `wisp_thread_posts` / `wispThreadPosts` next to each hit that is a registry or allowlist (`CORE_ORG_CASCADE_DELETE_ORDER` in `services/tenantCascade.ts`, alphabetical; `services/orgMergeRegistry.ts` with `repoint`; `CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts` with `sections` in `excludedOpen`; the rls-coverage allowlists). Grep, don't judge.
- **Dark by default:** every new route is under the `wispRoutes` hub (404 while `wispEnabled()` is false, partner scope, `ai_sessions:use`, `requireEntitlement('wisp')` inherited); the contract test `routes/wisp.entitlement.contract.test.ts` enumerates it automatically.
- **New service files** under `apps/api/src/services/wisp/` are classified in `apps/api/src/__tests__/parkedFanoutModules.ts` (they select no device targets).
- **No network inside an open DB context** (`notifyUser` two-phase shape, #1105): the post write is a DB write and lives inside the system-context callback; push stays after every context has closed.
- Copy: no em dashes, no apologies; Wisp is "Wisp".
- Locale keys in all eight locales; baseline updated (W01 rules).

## Review Focus

1. **Both channels off.** A user with in-app and push disabled still gets the brief as a thread post. Pinned in Task 5.
2. **Dedupe across retries.** A retried brief (same local date) writes one post and one notification; a retried nudge within one backoff window writes nothing new; the post's `notification_id` is set when the notification was created in the same call and null when the notification already existed. Pinned in Task 5.
3. **Paused grant reads history, ended grant does not.** Pinned in Task 6.
4. **Live-session seam.** The timeline excludes the bound session; rebinding to a new session refetches with the new exclusion and the formerly excluded session's rows now come from the timeline, never duplicated and never lost. Pinned in Task 13.
5. **Timezone-less timestamps.** A cursor built from an `ai_messages.created_at` value (timestamp without time zone) pages correctly across a post (timestamptz) with the same millisecond; the UTC bound rule from `activity.ts` is reused, not re-derived. Pinned in Task 4.

---

## W02a — API

### Task 1: Table, schema, registries, backfill

**Files:**
- Create: `apps/api/migrations/2027-01-06-140000-wisp-thread-posts.sql`, `apps/api/src/db/schema/wispThreadPosts.ts`
- Modify: `apps/api/src/db/schema/index.ts` (export), `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, the rls-coverage allowlist(s) found by the grep in Global Constraints, `apps/api/src/__tests__/parkedFanoutModules.ts` (entries for Task 2 and Task 4 files, added now so the contract stays green per group).
- Test: `apps/api/src/db/schema/wispThreadPosts.test.ts` (shape assertions as `wispThreadLinks` has, if such a test exists; else skip), plus the existing contract suites.

**Interfaces:**
- Produces table `wisp_thread_posts`:
  - `id uuid PK DEFAULT gen_random_uuid()`
  - `thread_id uuid NOT NULL`, `partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE`, FK `(thread_id, partner_id) → wisp_threads(id, partner_id) ON DELETE CASCADE`
  - `grant_id uuid NOT NULL`, FK `(grant_id, partner_id) → wisp_grants(id, partner_id) ON DELETE CASCADE`
  - `org_id uuid NULL`, FK `(org_id, partner_id) → organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`
  - `kind text NOT NULL CHECK (kind IN ('brief','nudge','digest'))`
  - `title varchar(255) NOT NULL`, `body text NULL`, `link varchar(500) NULL` with the same relative-path CHECK `user_notifications.link` carries (copy its expression from the notifications migration)
  - `sections jsonb NULL` (brief sections, `BriefSection[]`)
  - `concern_id uuid NULL REFERENCES wisp_concerns(id) ON DELETE SET NULL`
  - `notification_id uuid NULL REFERENCES user_notifications(id) ON DELETE SET NULL`
  - `dedupe_key text NOT NULL`, `UNIQUE (thread_id, dedupe_key)`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - Indexes: `(thread_id, created_at DESC, id DESC)`, `(partner_id)`, `(grant_id)`, `(org_id) WHERE org_id IS NOT NULL`, `(concern_id) WHERE concern_id IS NOT NULL`, `(notification_id) WHERE notification_id IS NOT NULL`.
  - RLS + GRANT per Global Constraints.
  - Backfill (same file, after the table, idempotent): `INSERT INTO wisp_thread_posts (thread_id, partner_id, grant_id, org_id, kind, title, body, link, sections, concern_id, notification_id, dedupe_key, created_at) SELECT t.id, t.partner_id, t.grant_id, n.org_id, CASE WHEN n.dedupe_key LIKE 'wisp.brief:%' THEN 'brief' WHEN n.dedupe_key LIKE 'wisp.digest:%' THEN 'digest' ELSE 'nudge' END, n.title, n.message, n.link, n.metadata->'brief', c.id, n.id, n.dedupe_key, n.created_at AT TIME ZONE 'UTC' FROM user_notifications n JOIN wisp_threads t ON t.id = (n.metadata->>'wispThreadId')::uuid JOIN wisp_grants g ON g.id = t.grant_id AND g.partner_id = t.partner_id AND g.grantor_user_id = n.user_id LEFT JOIN wisp_concerns c ON c.id = (n.metadata->>'concernId')::uuid AND c.partner_id = t.partner_id WHERE n.dedupe_key LIKE 'wisp.brief:%' OR n.dedupe_key LIKE 'wisp.nudge:%' OR n.dedupe_key LIKE 'wisp.digest:%' ON CONFLICT (thread_id, dedupe_key) DO NOTHING;` (guard the uuid casts with a regex check on the metadata text so a malformed value cannot abort the migration).
- Drizzle: `export const wispThreadPosts = pgTable('wisp_thread_posts', …)` mirroring the SQL (composite FKs declared, as `wispThreadLinks.ts` does).

- [ ] **Step 1:** Write the migration and the Drizzle schema; export from the schema index.
- [ ] **Step 2:** `cd apps/api && pnpm db:migrate && pnpm db:check-drift` against a local stack → no drift.
- [ ] **Step 3:** Register in every list the grep finds; run `pnpm exec vitest run src/__tests__/parkedFanout.contract.test.ts src/services/orgMerge.test.ts` (Test API side) → PASS. The Integration suites (`tenantCascade.integration`, `orgMergeRegistry.integration`, `tenant-export-policy.integration`, `rls-coverage.integration`, `migrationRlsScope`) run on the PR; run `rls-coverage` and `migrationRlsScope` locally if the test stack is up (`docs/agents/testing.md`).
- [ ] **Step 4: Commit** `feat(api): wisp_thread_posts table with RLS, registries and notification backfill`.

### Task 2: `recordThreadPost`

**Files:**
- Create: `apps/api/src/services/wisp/threadPosts.ts`, `apps/api/src/services/wisp/threadPosts.test.ts`

**Interfaces:**
- Produces:
```ts
export type ThreadPostKind = 'brief' | 'nudge' | 'digest';
export type ThreadPostInput = {
  threadId: string; partnerId: string; grantId: string; orgId: string | null;
  kind: ThreadPostKind; title: string; body: string | null; link: string;
  sections: BriefSection[] | null; concernId: string | null; notificationId: string | null;
  dedupeKey: string;
};
/** INSERT … ON CONFLICT (thread_id, dedupe_key) DO NOTHING. Runs on the caller's connection/context (no context of its own). */
export async function recordThreadPost(input: ThreadPostInput): Promise<{ created: boolean; id: string | null }>;
```
Validation: `title` truncated to 255; a `concernId` whose concern is not under `partnerId` throws (`notifyUser` already checks this; the function re-asserts with one select).

- [ ] **Step 1: Tests** (mocked `db` as `activity.test.ts` does): `inserts with ON CONFLICT DO NOTHING and returns created=true with the id`, `conflict returns created=false, id=null`, `concern under another partner throws`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(api): recordThreadPost`.

### Task 3: Shared types and validator (Sonnet)

**Files:**
- Create: `packages/shared/src/types/wispTimeline.ts`
- Modify: `packages/shared/src/types/index.ts` (export), `packages/shared/src/validators/wisp.ts` (`wispTimelineQuerySchema`), `packages/shared/src/validators/wisp.test.ts` (or the nearest existing wisp validator test).

**Interfaces:**
```ts
export const WISP_TIMELINE_DEFAULT_LIMIT = 50;
export const WISP_TIMELINE_MAX_LIMIT = 100;
export type WispTimelineMessage = {
  source: 'message'; id: string; sessionId: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string | null; contentBlocks: unknown | null;
  toolName: string | null; toolInput: unknown | null; toolOutput: unknown | null; toolUseId: string | null;
  createdAt: string; // ISO
};
export type WispTimelinePost = {
  source: 'post'; id: string; kind: 'brief' | 'nudge' | 'digest';
  title: string; body: string | null; link: string | null;
  sections: BriefSection[] | null; concernId: string | null; orgId: string | null;
  read: boolean | null; // the linked notification's read flag, null when unlinked
  createdAt: string;
};
export type WispTimelineItem = WispTimelineMessage | WispTimelinePost;
export interface WispTimelineResponse { data: { items: WispTimelineItem[]; nextCursor: string | null } }
// validators/wisp.ts
export const wispTimelineQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(WISP_TIMELINE_MAX_LIMIT).default(WISP_TIMELINE_DEFAULT_LIMIT),
  excludeSessionId: z.guid().optional(),
});
```
- [ ] **Step 1: Test** the schema (defaults, max, bad uuid). **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(shared): Wisp timeline types and query schema`.

### Task 4: `listThreadTimeline`

**Files:**
- Create: `apps/api/src/services/wisp/threadTimeline.ts`, `apps/api/src/services/wisp/threadTimeline.test.ts`

**Interfaces:**
- Consumes: `GrantCeiling` (`./grantAuthority`), the cursor helpers' style from `./activity.ts` (`ms()`, the `noTz` bound in `keysetAfter`; export `ms` and a generalized `keysetAfterSource` from `activity.ts` or duplicate the 15 lines with a comment naming the source, implementer's choice, but the UTC rule is identical), `wispThreadSessions`, `aiMessages`, `aiSessions`, `wispThreadPosts`, `userNotifications`.
- Produces:
```ts
export type TimelineCursor = { at: Date; source: 'message' | 'post'; id: string };
export class InvalidTimelineCursorError extends Error {}
export function encodeTimelineCursor(item: Pick<WispTimelineItem, 'createdAt' | 'source' | 'id'>): string;
export function decodeTimelineCursor(cursor: string): TimelineCursor;
export async function listThreadTimeline(
  ceiling: GrantCeiling,
  threadId: string,
  opts: { cursor?: string; limit?: number; excludeSessionId?: string } = {},
): Promise<{ items: WispTimelineItem[]; nextCursor: string | null }>;
```
Rules: newest first; messages = `ai_messages` joined through `wisp_thread_sessions` (thread = `threadId`, `wisp_thread_sessions.org_id ∈ ceiling.orgIds`, session ≠ `excludeSessionId`); posts = `wisp_thread_posts` (thread = `threadId`, `org_id IS NULL OR org_id ∈ ceiling.orgIds`), left-joined to `user_notifications` for `read`. Each source takes `limit + 1` after the cursor, merged in memory by `(ms, source COLLATE "C" desc, id desc)` exactly as `listActivity` merges its sources; `nextCursor` from the last returned item when more exist. `ai_messages.created_at` is timezone-less: use the `noTz` bound. Tool outputs are returned as stored (tombstones included).

- [ ] **Step 1: Tests**: `cursor round-trips and rejects malformed`, `messages outside the ceiling are filtered`, `excludeSessionId drops that session`, `posts with null org pass, posts with an out-of-ceiling org do not`, `keyset page boundary across a message and a post with the same millisecond is stable`, `read comes from the linked notification`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(api): listThreadTimeline — messages across sessions merged with posts`.

### Task 5: Posts written by `notifyUser`

**Files:**
- Modify: `apps/api/src/services/wisp/deliver.ts` (`deliverInApp` returns `{ created, id }` and accepts `post?: Omit<ThreadPostInput, 'notificationId' | 'dedupeKey'>`; when `post` is given, `recordThreadPost({ …post, dedupeKey: d.dedupeKey, notificationId: created ? id : null })` runs inside the same `inSystemContext` callback after `createNotification`), `apps/api/src/services/wisp/notifyUser.ts` (builds the post from `p`: kind maps `concern → 'nudge'`, `digest → 'digest'`, `brief → 'brief'`; `orgId = concern?.orgId ?? null`; `sections = p.kind === 'brief' ? p.briefSections ?? null : null`; `link = webDeepLink(p.threadId, p.concernId)`; when `decision.inApp` is false, the post is still written via `recordThreadPost` under its own system context at the same point in phase 2, before any push).
- Test: `apps/api/src/services/wisp/notifyUser.test.ts` (extend), `apps/api/src/services/wisp/deliver.test.ts` (extend), `apps/api/src/services/wisp/notifyUser.callers.contract.test.ts` (unchanged and green), `apps/api/src/services/wisp/budget.test.ts` (extend: no post).

- [ ] **Step 1: Tests**: `brief with both channels off writes a post and no notification`, `nudge with in-app on writes notification and post with notification_id in one callback`, `retry within the same dedupe key writes nothing new`, `budget notice writes no post`, `push still happens after the post write (order of calls)`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm exec vitest run src/services/wisp/` → PASS. **Step 5: Commit** `feat(api): proactive Wisp output is recorded as thread posts, independent of channel`.

### Task 6: Route `GET /wisp/thread/:id/timeline`

**Files:**
- Modify: `apps/api/src/routes/wispThreads.ts` (route; `ceilingOf` gains `{ allowPaused: boolean }`, default false, so the timeline is readable for a `paused` grant from its stored revision while `revoked`/`expired` keep refusing), `apps/api/src/routes/wispThreads.test.ts` (extend).

Route: `wispThreadRoutes.get('/:id/timeline', zValidator('query', wispTimelineQuerySchema), …)` → `loadOwnThread` (404), `ceilingOf(own, { allowPaused: true })` (409 via `ceilingRefusal` for revoked/expired/corrupt), `listThreadTimeline(ceiling, own.thread.id, { cursor, limit, excludeSessionId })`, 400 `invalid_cursor` on `InvalidTimelineCursorError`; response `{ data: { items, nextCursor } }`. Document the route in the file's header comment block beside `/:id/activity`.

- [ ] **Step 1: Tests**: `404 unknown thread`, `400 invalid cursor`, `409 revoked grant`, `200 paused grant`, `passes excludeSessionId and limit through`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS, plus `pnpm exec vitest run src/routes/wisp.entitlement.contract.test.ts` → PASS. **Step 5: Commit** `feat(api): GET /wisp/thread/:id/timeline`.

### Task 7: Home payload keeps working; MCP coverage and tool index untouched

- [ ] **Step 1:** `GET /wisp/home` is unchanged (mobile keeps reading `brief` from it). Run `pnpm exec vitest run src/services/wisp/home src/routes/wispHome` → PASS.
- [ ] **Step 2:** Run the API typecheck the way CI does (`pnpm exec tsc --build tsconfig.tests.json` from `apps/api`, 12 GB heap, check the exit code) → 0.
- [ ] **Step 3: Commit** anything the typecheck required.

### Task 8: Docs (Sonnet)

- [ ] **Step 1:** `apps/docs/src/content/docs/features/wisp.mdx`: in "Nudges, quiet hours and the morning brief", add that every brief, nudge and digest is also kept on the thread as a post regardless of channel settings, and that clearing notifications does not remove posts.
- [ ] **Step 2: Commit** `docs: Wisp posts live on the thread`.

### Task 9: Whole-wave verification and PR

- [ ] **Step 1:** `cd apps/api && pnpm test` (unit) → PASS; integration contract suites per `docs/agents/testing.md` if the test stack is up; `pnpm db:check-drift` → clean.
- [ ] **Step 2:** Open a follow-up issue "Wisp timeline: historical scope leakage across sessions (provenance)" quoting the quorum note, labelled `wisp`, `security`, linked from the PR body.
- [ ] **Step 3:** PR to `main` with `Closes #<W02a sub-issue>`, the migration name, the registry diff summary, "no setting added" (Settings rule 9), and the tenancy checklist ticked.

---

## W02b — Web (after W01 merges)

### Task 10: Timeline fetch and mapping

**Files:**
- Create: `apps/web/src/components/wisp/wispTimeline.ts`, `apps/web/src/components/wisp/wispTimeline.test.ts`

**Interfaces:**
- Consumes: `fetchWithAuth`, `mapMessagesFromApi` (`@/stores/processStreamEvent`), `WispTimelineItem`, `WispTimelinePost` (`@breeze/shared`).
- Produces:
```ts
export async function fetchWispTimeline(threadId: string, opts: { cursor?: string | null; limit?: number; excludeSessionId?: string | null }): Promise<{ items: WispTimelineItem[]; nextCursor: string | null }>;
/** Splits a page into the kit's inputs: messages (oldest first, via mapMessagesFromApi) and posts. */
export function splitTimelinePage(items: WispTimelineItem[]): { messages: AiMessage[]; posts: WispTimelinePost[] };
```
- [ ] **Step 1: Tests**: `builds the query string and unwraps data`, `splits and orders oldest first`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(web): Wisp timeline fetch`.

### Task 11: `WispPost` (Sonnet)

**Files:**
- Create: `apps/web/src/components/wisp/WispPost.tsx`, `apps/web/src/components/wisp/WispPost.test.tsx`
- Modify: `apps/web/src/components/wisp/WispBriefPost.tsx` (accept the post shape too, or be wrapped).

**Interfaces:**
- Produces: `export default function WispPost(props: { post: WispTimelinePost; threadId: string; grantId: string }): JSX.Element` — `data-testid="wisp-post"` with `data-kind`. `brief` → `WispBriefPost`. `nudge` → eyebrow `t('wisp.post.nudge')`, title (`font-medium`), body, and the concern's actions inline: if `WispConcernsPanel` exports its row component, render it for `concernId` (`crossOrg`); otherwise render a link `t('wisp.post.open')` ("Open") to `post.link` and record a follow-up in the PR body. `digest` → eyebrow `t('wisp.post.digest')`, title, body, link. Unread posts (`read === false`) get a small primary dot before the eyebrow.
- [ ] **Step 1: Tests** per kind + unread dot. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5: Commit** `feat(web): Wisp post rendering`.

### Task 12: Kit: `extras` interleaved by time, "Load earlier"

**Files:**
- Modify: `apps/web/src/components/ai/aiChatGrouping.ts`, `apps/web/src/components/ai/AiChatMessages.tsx`
- Test: `aiChatGrouping.test.ts`, `AiChatMessages.test.tsx` (extend)

**Interfaces:**
- `ChatUnit` gains `{ kind: 'extra'; id: string; at: Date }`; `groupChatUnits(messages, { …, extras?: Array<{ id: string; at: Date }> })` merges extras by time (an extra does not reset `firstOfRun`; dividers apply to it).
- `AiChatMessages` gains `extras?: Array<{ id: string; at: Date; render: () => ReactNode }>`, `onLoadEarlier?: () => void`, `hasEarlier?: boolean`, `loadingEarlier?: boolean`. When `hasEarlier`, a button `data-testid="ai-chat-load-earlier"` (`t('aiChatMessages.loadEarlier')`, "Load earlier") renders at the top of the scroll container before `leading`; while `loadingEarlier` it is disabled with a spinner. Prepending content keeps the viewport anchored: record `scrollHeight` before the update and restore `scrollTop += delta` after paint (rAF), and do not auto-scroll to the bottom on a prepend.

- [ ] **Step 1: Tests**: grouping: `extras interleave by time and do not reset the run`; messages: `renders an extra via its render fn in order`, `load earlier button and anchoring (scrollTop adjusted by the height delta)`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm exec vitest run src/components/ai/` → PASS. **Step 5: Commit** `feat(web): chat kit — timed extras and Load earlier with scroll anchoring`.

### Task 13: Thread column reads the timeline

**Files:**
- Modify: `apps/web/src/components/wisp/WispHomeThread.tsx`, `apps/web/src/components/wisp/WispHomeContent.tsx` (drop the `leading` brief post; pass `refreshKey`), `apps/web/src/components/wisp/WispHomeThread.test.tsx` (extend)

**Interfaces:**
- `WispHomeThread` gains `refreshKey?: number` (the home's `activityKey`, bumped by the poll when a check starts or finishes) and drops the brief `leading` (the thread page's summary `leading` stays).
Behavior: once bound (`binding === 'live'`), fetch the first timeline page with `excludeSessionId = useAiStore.getState().sessionId`; keep `olderMessages` (oldest first) and `posts` in state; render `messages={[...olderMessages, ...storeMessages]}`, `extras={posts.map(p => ({ id: p.id, at: new Date(p.createdAt), render: () => <WispPost …/> }))}`, `hasEarlier={nextCursor !== null}`, `onLoadEarlier` fetches the next page and prepends. On `refreshKey` change, refetch the first page and merge new posts by id (messages from the live session keep coming from the store). On rebind (`sessionId` in the store changes), cancel in-flight fetches (token ref) and refetch page one with the new exclusion, replacing `olderMessages` and `posts`.

- [ ] **Step 1: Tests**: `first page loads after bind with excludeSessionId`, `load earlier prepends and keeps order`, `rebind refetches with the new session excluded and the old session's rows now come from the timeline (no duplicates)`, `poll refresh adds a new post once`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm exec vitest run src/components/wisp/` → PASS. **Step 5: Commit** `feat(web): Wisp thread renders the full timeline with posts`.

### Task 14: Thread page (Sonnet)

- [ ] **Step 1:** `WispThreadPage` passes `refreshKey={activityKey}` and keeps the summary `leading`; test updated. **Step 2:** PASS. **Step 3: Commit** `feat(web): Wisp thread page reads the timeline`.

### Task 15: Docs, e2e, verification, PR

- [ ] **Step 1 (Sonnet):** `wisp.mdx` home section: the thread shows every brief, nudge and digest as posts and pages backwards with Load earlier.
- [ ] **Step 2:** e2e `wisp-home.spec.ts`: unchanged assertions pass on a stack with W02a merged; add one assertion that `ai-chat-load-earlier` is absent on a fresh thread.
- [ ] **Step 3:** `cd apps/web && pnpm test` → PASS; typecheck → 0; locale parity and baseline → PASS (new keys: `aiChatMessages.loadEarlier`, `wisp.post.open`).
- [ ] **Step 4:** PR to `main` with `Closes #<W02b sub-issue>`, screenshots of a thread with a brief post and a nudge post.
