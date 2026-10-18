---
title: Trust Center W02 follow-ups (implementation plan)
spec: docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md
tracking_issue: LanternOps/breeze#8768
anchor_issue: LanternOps/breeze#9087
status: plan-drafted 2026-10-18; awaiting Todd's review (Open Decisions below); execution method to be chosen
previous_wave_plans: docs/superpowers/plans/2026-10-17-trust-center-w2.md, docs/superpowers/plans/2026-10-17-trust-center-w3.md
---

# Trust Center W02 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Read "PRs and file ownership" before touching any file: each PR owns only the files it lists.**

**Goal:** Close the seven still-open items of #9087, the follow-ups from the nine W02 sub-wave reviews: a publish can no longer lose its serving-set member, the CIS switch cuts off at read time, the editor sends both revisions it loaded, a revoked M365 connection stops claiming "MFA enforced", one malformed old snapshot cannot break a page's history, and two small robustness fixes.

**Architecture:** Four file-disjoint PRs against `main`. PR-A (public serving path, high rigor) moves the serving-set write after the publish transaction commits. It turns every serving-set writer (publish, unpublish, partner refresh, full rebuild) into one epoch-checked reconcile against fresh DB rows, so no writer can apply a stale view over a newer one. It also adds one shared served-payload reader that applies the CIS gate at read time. PR-B (editor revision contract) makes the snapshot build report the template revision it used and makes the web editor send both revisions. PR-C (evidence gating) drops `mfa_enforced_m365` evidence when the M365 connection is revoked, suspended or lost consent. PR-D (robustness) makes history parsing total, adds retry buttons and gives Trust Center tickets their own actor source. No table, no column, no migration, no new env var, no agent change.

**Tech Stack:** TypeScript, Hono, Drizzle (queries only), PostgreSQL 16 RLS, Redis (ioredis, Lua via `redis.eval`), Zod 4, Astro 7 + React 19 (web), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/trust-center/2026-10-12-trust-center-design.md`: §7 (publish/unpublish/refresh/serve, L207–211: "Add the page's `partnerSlug/orgSlug` to the Redis serving-set … Live when the toast says so"), §13, §19 items 25 (CIS gate), 30 (`mfa_enforced_m365` on the trust path only), 33 (template revision, 409 `TEMPLATE_CHANGED`), 34 (revision discipline). The W2 plan (`2026-10-17-trust-center-w2.md`) and W3 plan (`2026-10-17-trust-center-w3.md`) bind where this plan does not say otherwise.

## Premise check (done at plan time on `origin/main` 23648a6246)

| #9087 item | State on main | This plan |
|---|---|---|
| 1 Serving-set miss after publish | **Open.** `publishTrustPage` (`services/trustPage/publication.ts`) calls `addServing` inside the request transaction. `rebuildServingSetFromDb` / `refreshServingForPartner` (`servingSet.ts`) read the DB, then overwrite or `SREM` with no guard. | PR-A, Tasks A1–A2 |
| 2 `TrustDocumentsList.tsx` not localized | **Already fixed** by W02d #9056: it reads `accessCopy` (`download`, `availableOnRequest`) through `pickTrustCopy` and dates through `formatTrustDate(iso, locale)`. Parity is covered by `apps/portal/src/components/trust/access/accessCopy.test.ts`. | Dropped |
| 3 `TrustCenterTab.tsx` omits `expectedRevision` | **Open.** L99 renders `<TrustDocumentsSection … />` without it. | PR-B, Task B2 |
| 4 Stale `cis_v8` after the flag turns off | **Open.** `payloadFor` is duplicated in `routes/trustPagePublic.ts`, `routes/trustPageAttestation.ts` and `routes/trustAccessPublic.ts`, and none applies the gate. | PR-A, Task A3 |
| 5 `mfa_enforced_m365` on a revoked connection | **Open.** `trustOnlyEvidence.ts` gates only on `maxSecurityStatusAgeDays`. | PR-C |
| 6 Template-revision race | **Open, and wider than reported:** the check pre-reads the template before `buildSnapshotForPage` reads it again, and the web `TrustPublishDialog.tsx` (L48) **never sends `expectedTemplateRevision`**, so `TEMPLATE_CHANGED` never fires from the UI. | PR-B, Tasks B1–B2 |
| 7 `buildHistory` robustness + retry | **Open.** `sections/history.ts` casts with `::int` in SQL, so one non-integer value throws and fails the whole build (publish or refresh). Unreadable rows are skipped without any signal. The missing retry is in the **FAQ and subprocessors** editor sections (`TrustFaqSection.tsx`, `TrustSubprocessorsSection.tsx`), which load data. `TrustHistorySection.tsx` is a toggle and loads nothing. | PR-D, Tasks D1–D2 |
| 8 Ticket actor `inbound_email` | **Open.** `access/requests.ts` `TRUST_ACCESS_TICKET_ACTOR` uses `source: 'inbound_email'`. `TicketSystemSource` (`services/ticketService.ts` L104) is a TypeScript union with one consumer (`systemSource` in the ticket audit details, L205). There is no DB enum and no `switch`. | PR-D, Task D3 |

## Global Constraints

- **W1/W2/W3 public contracts still bind.** Every non-serving public case returns the same `{ error: 'Not found', code: 'NOT_FOUND' }` 404 with `Cache-Control: no-store`. A card-path miss stays DB-free: slug regex, then serving set, and SQL only on a hit. Redis unavailable on the card path is still 503 + `Retry-After: 30`. Public DB work stays inside `runOutsideDbContext(() => withSystemDbAccessContext(...))`.
- **The serving set stays an admission filter, not an authority** (`servingSet.ts` header, spec §7). A false-positive member costs one indexed query that answers 404. A false-negative member hides a live page. Every design choice below errs toward false positives.
- **"Live when the toast says so"** (spec §7 L207). The publish response returns only after the member is in Redis and the publishing transaction has committed.
- **CIS gate, amendment 25:** `BREEZE_TRUST_CIS_FRAMEWORK_VIEW` stays default **OFF**, and this plan does not change the default. While the flag is off, CIS v8 is not in the framework view, the picker or the W3e `hardening_baseline` safeguards. **CIS chips and attribution on control cards are unchanged.** Copy never says "compliant with", "certified" or "meets IG1".
- **No schema change.** No new table or column, so no migration, `CORE_TENANT_EXPORT_POLICY`, cascade or merge registration. A task that finds it needs a column stops and asks. If one is ever needed, the reserved slot is `apps/api/migrations/2026-12-31-235000-<slug>.sql`. The newest committed migration on main is `2026-12-31-170000-m365-consent-sessions-v2-only.sql`, and 210000/220000/230000/233000/234000/234500 are reserved. Re-verify with `ls apps/api/migrations | sort | tail -3`.
- **No agent wire change**, so no `MIN_AGENT_VERSION_*` bump. **No new env var** (`internalEnvVars.ts` untouched), **no new route or MCP tool** (`mcp-coverage.test.ts` untouched), **no new job** (worker readiness/closure/parked-fanout contracts untouched).
- **Web mutations** go through `runAction`, so `no-silent-mutations.test.ts` stays green. **A new web locale key** goes into all 8 `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/organizations.json` (namespace `organizations`, prefix `orgRecord.trust.`), really translated. Run `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`. PR-B's body carries `pt-BR strings are machine-drafted pending native review` and `es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review`.
- **Typecheck:** `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p <pkg>`, then **read the exit code** (never pipe to `tail`).
- **Integration suites** (`apps/api/src/__tests__/integration/*.integration.test.ts`) need a live Postgres and Redis. `pnpm test` does not run them. Run them on a per-worktree stack (see Exit checklist).

## Decisions (quorum: own position, then `codex exec` read-only `xhigh`)

**D1 — Classification and grouping.** Bugs, each with a red test first: 1, 3, 4, 5, 6, 7a (cast). Enhancements: 7b (retry), 8 (actor). 2 is dropped (already fixed). Nothing is deferred: item 8 turned out to be a one-line union widening, with no DB enum and no consumer `switch`. Item 4 was accepted in #9061 at "≤ 1 h", but a deployment switch that does not switch is a bug, and the fix is read-time and cheap. Grouping: PR-A (1, 4), PR-B (3, 6), PR-C (5), PR-D (7, 8). Item 8 is folded into PR-D to save a CI cycle, and the files stay disjoint.

**D2 — Serving-set race.** *Root cause (inferred from code; Task A1's and A2's red tests prove it):* the auth middleware wraps the whole publish handler in one transaction (`middleware/auth.ts` L919). `publishTrustPage`'s `db.transaction` is only a savepoint, so `addServing` runs **before the commit**. Two other writers race it. `rebuildServingSetFromDb` (worker boot, the hourly sweep, and the self-heal) reads the live rows, then `RENAME`s a fresh set over the old one. `refreshServingForPartner` (org/partner PATCH, archive, trust state, partner home) reads the rows, then `SREM`s the "stale" members. Either one, if its read misses the uncommitted publish but its write lands after the `SADD`, deletes the member. The set stays "built", so the card answers a DB-free 404 until the next hourly rebuild. On a fresh stack the worker's boot and sweep rebuild overlaps the E2E publishes, which explains the 1-in-4 flake.
Fix, in two parts. Both are needed: ordering alone still loses to a rebuild whose read came before the commit.
1. **Commit, then serve, awaited.** `POST /orgs/:orgId/trust-page/publish` and `/unpublish` join `SELF_MANAGED_DB_CONTEXT_ROUTES`. The handler runs its DB work in `withAuthDbAccessContext(auth, …)`. After that resolves (committed), it awaits the serving reconcile and the snapshot cache write before it responds. `publishTrustPage` / `unpublishTrustPage` stop touching Redis.
2. **No blind point writes. Every serving-set writer is one epoch-checked reconcile against fresh DB rows.** Publish, unpublish, the partner refresh (org/partner PATCH, archive, restore, trust state, partner home, portal unpublish) and the full rebuild (boot, sweep, self-heal) all run the same steps. First, read `trust:serving:epoch`. Next, read the live rows: the partner's rows, or all rows. Last, run a Lua script that applies the set **and `INCR`s the epoch** only if the epoch has not changed since the first read. Otherwise it writes nothing and returns `conflict`. On a conflict the writer re-reads and retries, up to 3 attempts. After that it applies non-destructively (the rebuild takes the union with the live set; the partner reconcile `SADD`s without `SREM`). It logs and calls Sentry `captureMessage` once.
   If Redis answers but the apply fails, the writer best-effort `DEL`s `trust:serving:built`. `isServing` then returns `null`: payload routes resolve live, the card answers 503, and the existing self-heal rebuilds the set. A false negative becomes "unknown", never a hidden page. The publish still answers 200, because the DB committed. When Redis is down, publish answers 200 and the set is unknown, so everything falls through or 503s as today.
   *Why it is correct (quorum-hardened):* every successful apply bumps the epoch, so successful applies are serialized. Each one's DB read is later than the previous successful apply. Every commit that changes membership (a publish, an unpublish, or a tenant change already wired to `scheduleServingRefreshForPartner`) triggers a reconcile whose epoch read comes after that commit. That reconcile either applies with a read that sees the commit, or conflicts and retries. So the last apply always reflects every committed change.
   This closes both holes codex found in a point-write-only epoch. First, an older rebuild can no longer overwrite a newer refresh, because the refresh's apply bumped the epoch. Second, a delayed unpublish can no longer remove the member of a later publish, because the unpublish re-reads the DB instead of running a blind `SREM`.
   The cost is one partner-scoped indexed query per publish, plus the existing `SMEMBERS` in the partner apply, which is O(set size). That is acceptable at today's set sizes; per-partner sets are a follow-up if needed.
Rejected:
- Treating a 404 inside a "publish window" as a fall-through to SQL: it masks the race without fixing it, and touches Postgres on a miss.
- `runAfterDbContextCommit`: it is fire-and-forget, so the response can beat the write and break "live when the toast says so".
- A short negative-cache bypass: it also masks the race.
- WATCH/MULTI: unsafe on the shared ioredis connection. Lua is the repo pattern (e.g. `services/agentPresence.ts`).
- Point `SADD`/`SREM` plus an epoch (the first draft): codex showed the two holes above.

**D3 — Revision contract.** `TrustCenterTab` passes `expectedRevision={page.page.publicationRevision}` to `TrustDocumentsSection`. On a 409, the section keeps its inline error and **also calls `onReload()`**; today it only sets the message, so every retry would 409 again. The reload is safe for unsaved edits: the section re-seeds its links only when the *saved* list changed (`TrustDocumentsSection.tsx` L60–68). `buildSnapshotForPage` returns `templateRevision: number | null`, the revision the **draft** build actually resolved (`null` for frozen-config builds and when no template exists). `publishTrustPage` compares `expectedTemplateRevision` with `built.templateRevision` **after** the build, and the separate pre-read is removed. No lock inside the transaction is needed: the frozen config is exactly the revision compared, and a template change after the build does not alter what is frozen. The web `TrustPublishDialog` always sends `expectedTemplateRevision` (`state.template?.revision ?? null`), maps `TEMPLATE_CHANGED` to a friendly message and reloads, the same as `REVISION_MISMATCH`. **The API keeps `expectedTemplateRevision` optional** (`undefined` = not checked). API-key and MCP clients send no template revision today, and requiring it would break them. See Open Decision 2.

**D4 — Gating.**
- (5) A clean disconnect of the read profile already deletes `m365_sync_state` and `m365_ca_policies` in the same transaction (`m365ControlPlane/connectionService.ts` ~L1397 → `m365Sync/lifecycle.ts` `onConnectionDisconnected`). That case already reports no data today. The live bug is a connection that is **suspended**, or **degraded with a consent error** (consent withdrawn on the tenant side), whose rows are kept for up to 30 days. A `revoked` row whose sync rows somehow survived is the defensive case. `loadMfaEnforcedM365` reads the `ca_policies` sync row together with its `m365_connections` row, joined on both `connection_id` and `org_id`. It looks only at the `ca_policies` domain, so a consent failure on another domain does not suppress this evidence. It returns `NO_DATA` (rendered as "Not assessed") when `m365ConnectionHealth(conn)` is retired or permanent, or when the `ca_policies` `lastStatus` is `needs_consent`. Transient states (`degraded` with a non-consent code, `error`, `throttled`) keep the last complete snapshot under the existing 30-day freshness. The verdict comes from `services/integrationStates.ts`, so "revoked" has one definition. A public page picks the change up at its next hourly refresh, which is accepted: the bug is 30 days, not 1 hour.
- (4) One shared reader, `loadServedPayload(resolved)` in a new `services/trustPage/servedPayload.ts`, does cache, then normalize, then `gateCisFrameworkView(payload, trustCisFrameworkViewEnabled())`. All three public readers use it. While the flag is off, the gate removes `'cis_v8'` from `payload.frameworks`, strips `controls[].safeguards`, and recomputes `footer.frameworkAttributions` with the builder's own rule. That rule is extracted from `payloadBuilder.ts` so both sides share it, and CIS refs on control cards still count (amendment 25). The gate runs at read time, so no cache invalidation is needed and the payload hash is unaffected. The attestation token-cache key gains the gate bit, so a token signed while the flag was ON is never served after it turns OFF. Flag back ON: the gate is the identity. CIS content returns at the next refresh (a snapshot built while the flag was off lacks it) or at a republish. A page *published* while the flag was off froze `frameworkView` without `cis_v8` and needs a republish. Shared caches may still hold a pre-switch response for up to `max-age=300, stale-while-revalidate=600` on the payload route, and until the token expires on the attestation route. The origin cut-off is immediate.

**D5 — Localisation.** Item 2 is dropped (fixed). The only new web string is `orgRecord.trust.errors.templateChanged` (8 locales). The retry buttons reuse the existing `orgRecord.trust.retry`. The public portal page gains no copy.

**Quorum outcome:** see "Advisor quorum" at the end. Where codex disagreed, the resolution is recorded there.

## Open Decisions (for Todd; defaults are what the plan builds)

1. **Should the attestation also hard-cut CIS?** Default **yes**: it shares `loadServedPayload`, and its token-cache key gains the gate bit. The alternative leaves signed tokens as they were, which would mean the attestation no longer carries "exactly what the public page serves" (`trustPageAttestation.ts` comment).
2. **Should `expectedTemplateRevision` become required on `POST /publish`?** Default **no** (it stays optional): the web editor always sends it after PR-B, while API-key and MCP callers would break. Revisit when the public API gets a versioned publish.
3. **Do publish and unpublish become self-managed DB-context routes?** Default **yes**: it is the only way to commit before the awaited Redis write, and the precedent exists (`system-cleanup/run`). Cost: the handler owns its contexts, and the route joins `selfManagedDbContextRoutes.test.ts`.

## Review Focus

1. **A publish racing the worker's boot or hourly rebuild** on a fresh stack. Expected: the card serves the page once the publish response returns, every time. Pinned by A1's interleave tests and A2's integration test.
2. **Redis down, or erroring, during publish.** Expected: the publish still answers 200 (the DB committed). A failed apply drops the built marker, so the page resolves live (or the card answers 503 and self-heals); it is never hidden. A1 pins `'degraded'` with the marker dropped, and A2 pins the 200.
3. **A publish whose transaction rolls back** (for example a 409 race inside the transaction). Expected: no reconcile, no epoch increment, no cached payload. A2 pins this: a rejected publish leaves the epoch, the set and `trust:snapshot:*` untouched.
4. **The CIS flag turned off with a cached snapshot in Redis.** Expected: the payload route, the card's frameworks and the attestation all drop `cis_v8` on the next request, with no cache flush. A3 pins this with the cached path, not only the DB path.
5. **An M365 connection that is `degraded` with a transient error.** Expected: "MFA enforced" survives (no flapping on a throttle). C1 pins both sides: transient keeps, consent/revoked drops.

---

## PRs and file ownership

| PR | Branch | Items | Rigor | Owns (only these) |
|---|---|---|---|---|
| **PR-A** public serving path | `fix/9087-trust-serving-set` | 1, 4 | **high** (public surface, Redis ordering) | `apps/api/src/services/trustPage/servingSet.ts` (+ `.test.ts`), `services/trustPage/servedPayload.ts` (new, + `.test.ts`), `services/trustPage/publication.ts` **only** `publishTrustPage`'s tail + `unpublishTrustPage`, `services/trustPage/payloadBuilder.ts` (attribution rule extraction), `services/trustPage/attestation.ts` (cache key), `routes/trustPage.ts` (publish + unpublish handlers), `routes/trustPagePublic.ts`, `routes/trustPageAttestation.ts`, `routes/trustAccessPublic.ts` (+ their `.test.ts`), `middleware/selfManagedDbContextRoutes.ts` (+ `.test.ts`), `services/sentryEventCodes.ts` (one new code), `__tests__/integration/trustPageServingSet.integration.test.ts` (new), `__tests__/integration/trustPagePublication.integration.test.ts` |
| **PR-B** editor revision contract | `fix/9087-trust-revisions` | 3, 6 | medium | `services/trustPage/publication.ts` **only** `buildSnapshotForPage` + `SnapshotBuild` + the template check in `publishTrustPage`, `services/trustPage/publication.test.ts`, `__tests__/integration/trustPageTemplateInheritance.integration.test.ts`, `apps/web/src/components/trustCenter/{TrustCenterTab,TrustDocumentsSection,TrustPublishDialog,TrustStatusCard}.tsx` (+ `.test.tsx`), `apps/web/src/locales/*/organizations.json` |
| **PR-C** M365 gating | `fix/9087-trust-mfa-revoked` | 5 | high (a public claim) | `services/trustPage/trustOnlyEvidence.ts` (+ `.test.ts`), `__tests__/integration/trustOnlyEvidence.integration.test.ts` |
| **PR-D** robustness | `fix/9087-trust-robustness` | 7, 8 | medium | `services/trustPage/sections/history.ts` (+ `.test.ts`), `__tests__/integration/trustPageContent.integration.test.ts`, `apps/web/src/components/trustCenter/{TrustFaqSection,TrustSubprocessorsSection}.tsx` (+ `.test.tsx`), `services/trustPage/access/requests.ts` (+ `.test.ts`), `services/ticketService.ts` (the union only) |

**Ordering:** PR-A and PR-B both edit `publication.ts`, in different functions, but `publishTrustPage` is touched by both. **PR-B branches from `main` after PR-A merges** (not stacked: stacked PRs get no CI). PR-A also removes `addServing`/`removeServing` from `servingSet.ts`; grep shows no caller outside `publication.ts`, so no other PR depends on them. PR-C and PR-D are independent and run in parallel with PR-A. PR bodies: `Refs #9087`, `Refs #8768`. The last of the four to merge carries `Closes #9087`. Do not write any closing keyword in the others (a negated one still closes).

---

## PR-A — Public serving path (items 1, 4)

### Task A1: Epoch-checked reconcile for every serving-set writer

**Files:**
- Modify: `apps/api/src/services/trustPage/servingSet.ts`, `apps/api/src/services/sentryEventCodes.ts`
- Test: `apps/api/src/services/trustPage/servingSet.test.ts`, `apps/api/src/__tests__/integration/trustPageServingSet.integration.test.ts` (new)

**Interfaces:**
- Produces:
  - `export const TRUST_SERVING_EPOCH_KEY = 'trust:serving:epoch'`
  - `export type ServingApplyOutcome = 'applied' | 'fallback' | 'degraded' | 'no_redis'`. `applied` means the epoch check passed. `fallback` means a non-destructive apply after 3 conflicts. `degraded` means the apply failed and the built marker was dropped (best-effort). `no_redis` means `getRedis()` returned null.
  - `export async function readServingEpoch(): Promise<string | null>`: the raw `GET`. `null` means the key is absent.
  - `export async function applyServingSnapshot(args: { epoch: string | null; members: string[]; scope: { kind: 'all' } | { kind: 'partner'; slug: string } }): Promise<'applied' | 'conflict'>`: one `redis.eval(SNAPSHOT_APPLY_LUA, …)`. It applies only if `GET epoch` still equals `args.epoch` (a `null` matches an absent key), and on apply it always runs `INCR epoch`.
    - `all`: build a tmp set (`TRUST_SERVING_SENTINEL` + members), `RENAME` it over `TRUST_SERVING_SET_KEY`, then `SET TRUST_SERVING_BUILT_KEY 1`.
    - `partner`: `SREM` the members of that slug (`slug` and `slug/*`) that are not in `members`, then `SADD` `members`. Never touch the built marker.
    - If the epoch changed: write nothing and return `'conflict'`.
  - `rebuildServingSetFromDb(): Promise<number>` (signature unchanged) and `refreshServingForPartner(partnerId: string): Promise<ServingApplyOutcome>` (it returned `void` before). Both loop up to 3 times over: read the epoch, read the live rows (the existing `liveRowsQuery` + `membersFromRows`; the partner slug lookup stays as it is), then `applyServingSnapshot`. On the 3rd conflict they apply non-destructively. For `all` that is `SUNIONSTORE tmp tmp live`, then `RENAME`, then set the built marker. For `partner` that is `SADD` only. Then `console.warn` and `captureMessage('trust serving-set reconcile fell back to a non-destructive apply', { eventCode: 'trust_serving_reconcile_fallback' })`. `eventCode` is the `SentryEventCode` union, so register the code in `SENTRY_EVENT_CODES` (`apps/api/src/services/sentryEventCodes.ts`) with a one-line doc comment. An unregistered code fails `tsc` and is rewritten to `'unregistered_event_code'` at runtime. On a Redis error they best-effort `DEL TRUST_SERVING_BUILT_KEY`, `console.warn` and `captureException`, return `'degraded'`, and never throw a Redis error. DB errors still propagate as they do today.
  - `refreshServingForPartner` throws `Error('refreshServingForPartner must run outside a held DB context')` when `hasDbAccessContext()` is true. Its DB read would not see the caller's uncommitted write, and it would take a second pooled connection (#1105). `scheduleServingRefreshForPartner` already calls it after commit and outside any context.
  - **Deleted:** `addServing`, `removeServing`. Their only callers are `publishTrustPage` and `unpublishTrustPage`, which A2 replaces. `replaceServingSet` is folded into the `all` path of the Lua script; delete the export and update its unit tests.
- Consumes: none.

- [ ] **Step 1: Write the failing interleave unit tests** in `servingSet.test.ts`.
  - First extend `fakeRedis()`. `multi().exec()` must **apply** its ops to `_set`/`kv` (today it only records them). Add `incr`, `del` and `eval`. The fake `eval` dispatches on the exported `SNAPSHOT_APPLY_LUA` constant and emulates it in JS; the real Lua is proven by Step 2. Add `captureMessage` to the hoisted sentry mock.
  - `it('a rebuild cannot drop a member committed between its DB read and its write')`: `dbRows.rows = []`. The DB mock's `where` resolves, and *before* resolving it runs a nested `refreshServingForPartner('p1')` whose own read returns the member (use a call counter). Then `await rebuildServingSetFromDb()`. Expect `r()._set.has('nw/acme')` to be `true`. **Red today:** the rebuild's `RENAME` overwrites the member.
  - `it('an older rebuild cannot overwrite a newer partner refresh')`: codex hole 1. Same shape, but the nested writer is a partner refresh that adds a restored member. Red today.
  - `it('a delayed unpublish reconcile cannot remove a later publish')`: codex hole 2. Unpublish reconcile A reads rows `[]` and stalls. Publish reconcile B reads `['nw/acme']` and applies. A resumes. Expect A to conflict, re-read (now `['nw/acme']`) and keep the member, with `dbRead` called twice for A. Red today: there is no epoch, and the blind `SREM` drops the member.
  - `it('three consecutive conflicts fall back to a non-destructive apply and report once')`: `eval` always conflicts. Expect the member kept, `captureMessage` called exactly once, and 3 DB reads.
  - `it('a Redis error drops the built marker so isServing falls through')`: `eval` rejects. Expect the outcome `'degraded'`, the built key deleted, and `isServing('nw/acme')` resolving to `null`.
  - `it('refreshServingForPartner refuses to run inside a held DB context')`: mock `hasDbAccessContext` → `true` and expect the rejection message above.
- [ ] **Step 2: Write the integration test** `__tests__/integration/trustPageServingSet.integration.test.ts`. Use real PG + Redis and `import './setup'`, and assert `expect(getRedis()).not.toBeNull()` so the suite can never pass vacuously.
  - `it('a reconcile whose epoch read predates another apply conflicts and writes nothing')`: `const e = await readServingEpoch()`. Run `refreshServingForPartner(partnerId)` (it applies and bumps the epoch). Then `applyServingSnapshot({ epoch: e, members: [], scope: { kind: 'all' } })` resolves `'conflict'`, and the member is still present.
  - `it('real Lua: partner apply removes only that partner's stale members')`: seed members for partners `aa` and `bb`, apply partner `aa` with `[]`, and expect `aa/*` gone and `bb/*` kept.
  - It is red until A1 lands (missing exports). Step 1 is the behavioral red.
- [ ] **Step 3: Run them to verify they fail.** `cd apps/api && npx vitest run src/services/trustPage/servingSet.test.ts`: the three interleave tests FAIL (member missing). The integration file on the stack (Exit checklist command) FAILS on the missing exports.
- [ ] **Step 4: Implement** the interfaces above. The Lua lives in a module constant `SNAPSHOT_APPLY_LUA`. Pass it to `redis.eval` with the keys (epoch, set, built, tmp) and the args (expected epoch or `''` for absent, scope kind, slug, members…), following the pattern in `services/agentPresence.ts`. Redis is standalone (`services/redis.ts` `new Redis(url, …)`), so multi-key scripts are fine. `isServing` stays as it is. `scheduleServingSetRebuild` (the self-heal) and `scheduleServingRefreshForPartner` stay as they are, apart from calling the reconciling functions.
- [ ] **Step 5: Run them to verify they pass**: the whole unit file green, and the integration file green on the stack.
- [ ] **Step 6: Commit**: `fix(trust-center): epoch-checked reconcile for every serving-set writer (#9087)`.

### Task A2: Publish and unpublish commit, then reconcile (awaited)

**Files:**
- Modify: `apps/api/src/services/trustPage/publication.ts` (the `publishTrustPage` tail, `unpublishTrustPage`), `apps/api/src/routes/trustPage.ts` (publish L202, unpublish L215), `apps/api/src/middleware/selfManagedDbContextRoutes.ts`
- Test: `apps/api/src/__tests__/integration/trustPagePublication.integration.test.ts`, `apps/api/src/routes/trustPage.test.ts`, `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`, `apps/api/src/services/trustPage/publication.test.ts`, `publication.legacyConfig.test.ts`

**Interfaces:**
- Consumes: `refreshServingForPartner(partnerId): Promise<ServingApplyOutcome>` (A1), `cacheSnapshotPayload` (existing), `withAuthDbAccessContext` (`middleware/auth.ts` L615).
- Produces:
  - `publishTrustPage(args)` returns `{ page: TrustPageRow; snapshotId: string; cache: { snapshotId: string; payload: TrustPagePublicPayload } }` and does **no** Redis I/O. `page.partnerId` is the reconcile key.
  - `unpublishTrustPage(args)` returns `TrustPageRow` (unchanged type) and does no Redis I/O.
  - `export async function serveCommittedPublication(r: { partnerId: string; cache?: { snapshotId: string; payload: TrustPagePublicPayload } }): Promise<ServingApplyOutcome>` in `publication.ts`. It runs `cacheSnapshotPayload` when `cache` is set, then `refreshServingForPartner(r.partnerId)`. It must run outside any DB context and inherits A1's throw. When the outcome is not `applied`, the route still answers 200: the DB committed, and A1 already made a failed apply fall through rather than hide the page.

- [ ] **Step 1: Write the failing integration tests** in `trustPagePublication.integration.test.ts`.
  - `it('the serving member is not visible while the publishing transaction is still open')`: `await sys(async () => { await publishTrustPage({...}); expect(await isServingMember(member)).toBe(false); })`. **Red today:** `addServing` runs inside the transaction. After the context closes, `await serveCommittedPublication({ partnerId, cache })` and `expect(await isServingMember(member)).toBe(true)`.
  - `it('a full rebuild that read the DB while the publish was uncommitted does not hide the page after publish returns')`: run `sys(async () => { const r = await publishTrustPage(...); await runOutsideDbContext(() => rebuildServingSetFromDb()); return r; })`. The rebuild uses its own connection and cannot see the uncommitted row. Then call `serveCommittedPublication` and `expect(await isServingMember(member)).toBe(true)`. Red today: the rebuild's `RENAME` drops the member and nothing re-adds it.
  - `it('a publish that 409s inside its transaction writes nothing to Redis')` (Review Focus 3): stale `expectedRevision`. Expect the epoch unchanged, the member absent and no `trust:snapshot:*` key.
  - Update the existing tests that assert membership right after `publishFirst` / `unpublishTrustPage` (`'publishes with an attestation…'`, `'unpublish clears published_at…'`) to call `serveCommittedPublication(...)` after the `sys(...)`.
- [ ] **Step 2: Write the failing route tests.**
  - In `routes/trustPage.test.ts`:
    - `it('publish reconciles the serving set only after its DB context resolves')`: mock `withAuthDbAccessContext` to record `'ctx:start'`/`'ctx:end'` around `fn`, and mock `serveCommittedPublication` to record `'serve'`. Expect the order `['ctx:start', 'ctx:end', 'serve']`, with the response produced after `'serve'`.
    - `it('a publish that throws inside the context never serves')`: a `TrustPageError` 409 means no `serveCommittedPublication` call and a 409 `REVISION_MISMATCH` response.
    - `it('unpublish reconciles only after commit')`: same order shape.
    - `it('publish still answers 200 when the reconcile is degraded or Redis is absent')` (Review Focus 2).
  - In `selfManagedDbContextRoutes.test.ts`: `POST /api/v1/orgs/<uuid>/trust-page/publish` and `…/unpublish` are self-managed; `GET …/trust-page` and `PUT …/trust-page/documents` are not.
- [ ] **Step 3: Run them to verify they fail.** `cd apps/api && npx vitest run src/routes/trustPage.test.ts src/middleware/selfManagedDbContextRoutes.test.ts`: the new cases FAIL. On the stack, the new integration cases FAIL.
- [ ] **Step 4: Implement.**
  - Add two entries to `SELF_MANAGED_DB_CONTEXT_ROUTES`, each with a comment citing spec §7 ("live when the toast says so") and #9087: `{ method: 'POST', pattern: /^\/api\/v1\/orgs\/[^/]+\/trust-page\/publish\/?$/ }`, and the same for `unpublish`.
  - In both handlers, wrap `resolveAccessibleOrg` + `ensureTrustPage`/`publishTrustPage`/`unpublishTrustPage` + `audit(...)` in one `withAuthDbAccessContext(auth, async () => …)`. Then, outside it, `await serveCommittedPublication(...)` and return `c.json(...)`.
  - The middleware in this chain already works without an ambient context. `requireCapability` (`services/partnerTrust.ts` L405) reads through `partnerTrust.repo.ts`'s own system context, and `requirePermission`/`requireMfa` are context-free. The precedent is the self-managed `routes/toolSources.ts`.
  - In `publication.ts`, delete the `addServing`, `removeServing` and `cacheSnapshotPayload` calls. Return `cache`, add `serveCommittedPublication`, and rewrite `publishTrustPage`'s doc comment to state the caller's duty.
- [ ] **Step 5: Run them to verify they pass**: the unit files above plus `src/services/trustPage/publication.test.ts` and `publication.legacyConfig.test.ts` (move their mocks to the new return shape). On the stack, run the `trustPagePublication`, `trustPageServingSet` and `portalTrustPageEditing` integration suites.
- [ ] **Step 6: Commit**: `fix(trust-center): commit the publish before reconciling the serving set (#9087)`.

### Task A3: One served-payload reader with the CIS read gate

**Files:**
- Create: `apps/api/src/services/trustPage/servedPayload.ts`, `apps/api/src/services/trustPage/servedPayload.test.ts`
- Modify: `apps/api/src/services/trustPage/payloadBuilder.ts` (extract the attribution rule), `apps/api/src/routes/trustPagePublic.ts` (`payloadFor`), `apps/api/src/routes/trustPageAttestation.ts` (`payloadFor`), `apps/api/src/routes/trustAccessPublic.ts` (L68–72), `apps/api/src/services/trustPage/attestation.ts` (`cacheKey`, L82)
- Test: `routes/trustPagePublic.test.ts`, `routes/trustPageAttestation.test.ts`, `routes/trustAccessPublic.test.ts`, `services/trustPage/attestation.test.ts`, `services/trustPage/payloadBuilder.test.ts`

**Interfaces:**
- Produces:
  - `payloadBuilder.ts`: `export function frameworkAttributions(p: { controls: Array<{ frameworkRefs: Array<{ framework: TrustFramework }>; safeguards?: unknown[] }>; declaredControls: Array<{ frameworkRefs: Array<{ framework: TrustFramework }> }>; frameworks: TrustFramework[] }): TrustFramework[]`. This is today's `referenced` + `TRUST_FRAMEWORKS.filter(...)` (L90–94) applied to the projected payload. `buildTrustPagePayload` calls it, so the payload is byte-identical (the existing `payloadBuilder.test.ts` snapshot/hash tests must stay green unchanged).
  - `servedPayload.ts`: `export function gateCisFrameworkView(p: TrustPagePublicPayload, enabled: boolean): TrustPagePublicPayload`. It is pure: identity when `enabled`. Otherwise it returns a copy with `frameworks` without `'cis_v8'`, every `controls[i].safeguards` key removed, and `footer.frameworkAttributions = frameworkAttributions(<gated copy>)`. It never touches `controls[].frameworkRefs` (amendment 25).
  - `servedPayload.ts`: `export async function loadServedPayload(r: Pick<ResolvedTrustPage, 'snapshotId' | 'payload'>): Promise<TrustPagePublicPayload | null>`: the body of today's `payloadFor` (cache read; on a miss, cache the DB payload), then `normalizeTrustPagePayload`, then `gateCisFrameworkView(…, trustCisFrameworkViewEnabled())`.
  - `attestation.ts`: `cacheKey(kid, sub, snapshotId, lastEvaluatedAt)` appends `:cis${trustCisFrameworkViewEnabled() ? 1 : 0}`.
- Consumes: none from A1/A2.

- [ ] **Step 1: Write the failing tests.**
  - `servedPayload.test.ts`: `it('flag off: drops cis_v8 from frameworks, strips safeguards, keeps control CIS refs and their attribution')`, using a v2 payload fixture with `frameworks: ['cis_v8', 'nist_csf_2']`, one control with `frameworkRefs: [{ framework: 'cis_v8', ref: '6.5' }]` and `safeguards: [...]`, and `footer.frameworkAttributions: ['cis_v8', 'nist_csf_2']`. Expect `frameworks` = `['nist_csf_2']`, no `safeguards` key, the refs unchanged, and attributions still containing `'cis_v8'` (a card ref remains). `it('flag off: attribution loses cis_v8 when only the view or safeguards referenced it')`. `it('flag on: identity')` (`toBe` the same object). `it('gated output still parses with trustPagePublicPayloadSchema')`.
  - `routes/trustPagePublic.test.ts`: `it('a cached snapshot built while the CIS flag was on is served without cis_v8 once the flag is off')`. Stub `readCachedSnapshotPayload` to return the fixture, set `process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'false'`, then GET `/public/nw/acme` and expect `data.payload.frameworks` not to contain `'cis_v8'` (Review Focus 4). The same through the DB path (cache miss).
  - `routes/trustPageAttestation.test.ts`: `it('signs the gated payload')`: the signed claims' payload lacks `'cis_v8'` in `frameworks` when the flag is off.
  - `routes/trustAccessPublic.test.ts`: the access routes read through `loadServedPayload` (spy).
  - `attestation.test.ts`: `it('the token cache key changes when the CIS flag flips')`.
- [ ] **Step 2: Run them to verify they fail**: `cd apps/api && npx vitest run src/services/trustPage/servedPayload.test.ts src/routes/trustPagePublic.test.ts src/routes/trustPageAttestation.test.ts src/routes/trustAccessPublic.test.ts src/services/trustPage/attestation.test.ts`. They FAIL (the module is missing, then cis is present).
- [ ] **Step 3: Implement.** Extract `frameworkAttributions`, add `servedPayload.ts`, delete the three local `payloadFor`/inline copies and call `loadServedPayload`, and add the cache-key bit. The `card` route reads only `summary`, `locale`, `org`, `managedBy`, which are unaffected but go through the same reader.
- [ ] **Step 4: Run the tests to verify they pass**: the Step 2 files plus `payloadBuilder.test.ts` and `trustPagePublicPayload.contract.test.ts` unchanged and green.
- [ ] **Step 5: Commit**: `fix(trust-center): apply the CIS framework-view gate when serving stored snapshots (#9087)`.

## PR-B — Editor revision contract (items 3, 6). Branch from `main` after PR-A merges.

### Task B1: The build reports the template revision it used

**Files:**
- Modify: `apps/api/src/services/trustPage/publication.ts` (`SnapshotBuild`, `buildSnapshotForPage`, the template check in `publishTrustPage`)
- Test: `apps/api/src/services/trustPage/publication.test.ts`, `apps/api/src/__tests__/integration/trustPageTemplateInheritance.integration.test.ts`

**Interfaces:**
- Produces: `SnapshotBuild.templateRevision: number | null`. For a `'draft'` build it is `(await resolveTrustPageSettings(page)).template?.revision ?? null`, captured in the same call that produced `effective`. For a frozen-config build it is `null`. `publishTrustPage` keeps `expectedTemplateRevision?: number | null` (optional; `undefined` = not checked) and, **after** `buildSnapshotForPage`, throws `TrustPageError(TEMPLATE_CHANGED_MESSAGE, 409, 'TEMPLATE_CHANGED')` when `args.expectedTemplateRevision !== undefined && built.templateRevision !== args.expectedTemplateRevision`. The pre-build `loadPartnerTemplate` read (L288–295) is removed.

- [ ] **Step 1: Write the failing test** in `publication.test.ts`: `it('TEMPLATE_CHANGED compares against the revision the build used, not a separate pre-read')`. Mock `loadPartnerTemplate` to return revision 4 on the first call and 5 on the second. Call `publishTrustPage({ ..., expectedTemplateRevision: 4 })`. Today the pre-read sees 4, the build freezes 5 and the publish succeeds, so the test is **red**. After the fix it rejects `{ status: 409, code: 'TEMPLATE_CHANGED' }` and `loadPartnerTemplate` is called exactly once. Add `it('undefined expectedTemplateRevision publishes without a template check')` and `it('null matches a partner with no template')`.
- [ ] **Step 2: Run it to verify it fails**: `cd apps/api && npx vitest run src/services/trustPage/publication.test.ts`. The first case FAILS (resolves).
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to verify it passes**, plus the integration `trustPageTemplateInheritance` on the stack. Add a case there: `it('publish 409s TEMPLATE_CHANGED when the template is saved between editor load and publish')`, which loads the revision, writes the template (bumping its revision), then publishes with the old revision and expects 409.
- [ ] **Step 5: Commit**: `fix(trust-center): check the template revision the snapshot was built from (#9087)`.

### Task B2: The editor sends both revisions

**Files:**
- Modify: `apps/web/src/components/trustCenter/TrustCenterTab.tsx` (L99), `TrustDocumentsSection.tsx` (the 409 branch, ~L152), `TrustPublishDialog.tsx`, `TrustStatusCard.tsx` (L285 call site), `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/organizations.json`
- Test: `TrustCenterTab.test.tsx`, `TrustPublishDialog.test.tsx`, `TrustDocumentsSection.test.tsx`

**Interfaces:**
- Consumes: `TrustPageState.template: { revision: number } | null` (`apps/web/src/lib/api/trustPage.ts` L75) and `publishTrustPage(orgFetch, orgId, body)`, whose body already allows `expectedTemplateRevision?: number | null` (L133).
- Produces: `TrustPublishDialog` gains the required prop `templateRevision: number | null`, and `TrustStatusCard` passes `state.template?.revision ?? null`. The new locale key `orgRecord.trust.errors.templateChanged` (en: "Your partner's Trust Center template changed since you loaded this page. Reload and publish again." Other locales translated.)

- [ ] **Step 1: Write the failing tests.**
  - `TrustCenterTab.test.tsx`: `it('passes the page publication revision to the documents section')`. Render with `page.publicationRevision = 7`, save documents, and expect `updateTrustDocuments` called with `expectedRevision` `7`. Red today (called without it).
  - `TrustDocumentsSection.test.tsx`: `it('a 409 shows the inline error and reloads the page state')`. `updateTrustDocuments` rejects with an `ActionError` with code `REVISION_MISMATCH`. Expect the alert text and `onReload` called once. Red today (no reload). Also `it('a reload after 409 keeps unsaved links when the saved list did not change')`.
  - `TrustPublishDialog.test.tsx`: `it('sends expectedTemplateRevision from the loaded template')` (`templateRevision={3}`, expect the body to contain `expectedTemplateRevision: 3`); `it('sends null when the partner has no template')`; `it('TEMPLATE_CHANGED shows the friendly message, reloads and closes')`, mirroring the existing `REVISION_MISMATCH` test.
- [ ] **Step 2: Run them to verify they fail**: `cd apps/web && npx vitest run src/components/trustCenter/TrustCenterTab.test.tsx src/components/trustCenter/TrustDocumentsSection.test.tsx src/components/trustCenter/TrustPublishDialog.test.tsx`.
- [ ] **Step 3: Implement.** In `TrustDocumentsSection`'s `friendly` 409 branch, keep `setError(msg)`, then reload: `void onReload()` after the `runAction` rejects with `REVISION_MISMATCH`, in the catch next to `handleActionError`. Add the dialog prop. `TEMPLATE_CHANGED: tr('errors.templateChanged')` goes in `friendly`, and the stale-reload branch extends to `err.code === 'REVISION_MISMATCH' || err.code === 'TEMPLATE_CHANGED'`. Add the 8 locale entries.
- [ ] **Step 4: Run them to verify they pass**, plus `TrustDocumentsSection.test.tsx`, the i18n trio (Global Constraints) and `src/lib/__tests__/no-silent-mutations.test.ts`.
- [ ] **Step 5: Commit**: `fix(trust-center): editor sends the page and template revisions it loaded (#9087)`.

## PR-C — `mfa_enforced_m365` honours connection health (item 5)

### Task C1: Drop MFA evidence for revoked, suspended or unconsented connections

**Files:**
- Modify: `apps/api/src/services/trustPage/trustOnlyEvidence.ts`
- Test: `apps/api/src/services/trustPage/trustOnlyEvidence.test.ts`, `apps/api/src/__tests__/integration/trustOnlyEvidence.integration.test.ts`

**Interfaces:**
- Consumes: `m365ConnectionHealth(row: { status: string; lastErrorCode: string | null }): HealthVerdict` (`services/integrationStates.ts` L292), and `m365Connections` (`db/schema/m365.ts`; `status`, `lastErrorCode`).
- Produces: unchanged `loadTrustOnlyEvidence(orgId, asOf, policy)` signature. The sync query now selects `lastCompleteSnapshotAt`, `lastStatus`, `connectionStatus: m365Connections.status` and `connectionErrorCode: m365Connections.lastErrorCode`, joined on `(m365Connections.id, m365Connections.orgId) = (m365SyncState.connectionId, m365SyncState.orgId)` (the composite FK). Rule, applied before the freshness check: return `NO_DATA` when the verdict is retired or permanent, or when `lastStatus === 'needs_consent'`. `HealthVerdict` is `{ state: 'healthy' | 'unknown' | 'retired' } | { state: 'broken'; severity: 'permanent' | 'transient'; condition: string }`. Drop the evidence when `state === 'retired'` or when `state === 'broken' && severity === 'permanent'`. Transient verdicts and `unknown` (`pending-consent`, `verifying`) keep today's behavior. `M365_CONSENT_CODES` (L278) is not exported, so tests use a literal such as `'grant_missing'`.

- [ ] **Step 1: Write the failing tests** in `trustOnlyEvidence.test.ts` (extend the db mock to return the joined columns):
  - `it('a suspended connection reports no data even with a fresh CA snapshot')`: `connectionStatus: 'suspended'`, `lastCompleteSnapshotAt` 1 day old, and an MFA-for-all policy, so `eligible: 0, assessed: 0`. **Red today** (`passing: 1`).
  - `it('a degraded connection with a consent error code reports no data')` (`lastErrorCode: 'grant_missing'`); `it('ca_policies needs_consent reports no data')`; `it('needs_consent on another domain does not suppress the claim')`; `it('a revoked connection whose sync rows survived reports no data')` (defensive: a clean disconnect deletes the rows).
  - `it('a degraded connection with a transient error keeps the last snapshot')` and `it('throttled keeps the last snapshot')`, both `passing: 1` (Review Focus 5).
- [ ] **Step 2: Run them to verify they fail**: `cd apps/api && npx vitest run src/services/trustPage/trustOnlyEvidence.test.ts`.
- [ ] **Step 3: Implement** the join and the rule. Keep the file's amendment-30 header. Add one line: "Connection health gates the claim: a revoked/suspended/unconsented connection is not evidence (#9087)."
- [ ] **Step 4: Run them to verify they pass**, plus the integration `trustOnlyEvidence` on the stack. Add a case there: `it('a suspended connection drops mfa_enforced_m365 to no data')`. Seed a connection + `ca_policies` sync row + CA policy, check that `passing: 1`, then flip `m365_connections.status` to `'suspended'` and expect no data. Red today.
- [ ] **Step 5: Commit**: `fix(trust-center): mfa_enforced_m365 needs a live M365 connection (#9087)`.

## PR-D — Robustness (items 7, 8)

### Task D1: History parsing cannot throw, and skips are reported

**Files:**
- Modify: `apps/api/src/services/trustPage/sections/history.ts`
- Test: `apps/api/src/services/trustPage/sections/history.test.ts`, `apps/api/src/__tests__/integration/trustPageContent.integration.test.ts`

**Interfaces:**
- Produces: `historyColumns()` selects `generatedAt` and `summary: sql<unknown>\`${trustPageSnapshots.payload}->'summary'\`` (no SQL cast). A module-private `readPoint(summary: unknown): { met: number; shown: number } | null` accepts only non-negative safe integers (`Number.isSafeInteger(v) && v >= 0`). `buildHistory` counts the skipped rows, and when the count is greater than 0 it calls `console.warn('[trustPage] history skipped unreadable snapshots', { pageId, skipped })` once per build. The `buildHistory` signature is unchanged.

- [ ] **Step 1: Write the failing integration test** in `trustPageContent.integration.test.ts`: `it('one snapshot with a non-integer controlsMet does not break publish or refresh')`. Publish with `showHistory: true`, insert an older snapshot whose `payload.summary.controlsMet` is `3.5` (inserts are allowed; only updates are blocked by `trust_page_snapshots_immutable_trg`), then `refreshPublishedPage(pageId)` resolves. **Red today**: Postgres raises `invalid input syntax for type integer: "3.5"`. Then expect the rebuilt payload's `history` to exclude that point.
- [ ] **Step 2: Update the unit test** `history.test.ts` `'… skips unreadable rows'`: rows now carry `summary` objects (`{ controlsMet: 'x' }`, `{ controlsMet: 2.5 }`, `null`). Expect them skipped and `console.warn` called once with `skipped: 3`.
- [ ] **Step 3: Run them to verify they fail**: the integration case on the stack, and `cd apps/api && npx vitest run src/services/trustPage/sections/history.test.ts`.
- [ ] **Step 4: Implement** as specified. Keep the per-call `historyColumns()` comment (the partial-mock trap).
- [ ] **Step 5: Run them to verify they pass**, plus `src/routes/portal.test.ts` and `portal.compat.test.ts` (the partial `../db/schema` mocks that bit W02f).
- [ ] **Step 6: Commit**: `fix(trust-center): history tolerates unreadable snapshot summaries (#9087)`.

### Task D2: Retry on FAQ and subprocessor load errors

**Files:**
- Modify: `apps/web/src/components/trustCenter/TrustFaqSection.tsx`, `TrustSubprocessorsSection.tsx`
- Test: `TrustFaqSection.test.tsx`, `TrustSubprocessorsSection.test.tsx`

**Interfaces:** Each section moves its load effect into a `load` callback reused by the effect. When the load fails, a `<button data-testid="trust-faq-retry">` / `data-testid="trust-subprocessors-retry"` labelled `t('orgRecord.trust.retry')` (an existing key, so no locale change) appears next to the existing alert and calls `load()`. The `dirty` guard is kept, so a retry never overwrites unsaved rows. Pattern: `TrustCenterTab.tsx` L70–75.

- [ ] **Step 1: Write the failing tests**: `it('a failed load shows a retry that reloads')`. The first fetch rejects, so the alert and the retry button show. The second fetch resolves; click retry and expect the rows rendered and the alert gone. One per section. Red today (no button).
- [ ] **Step 2: Run them to verify they fail**: `cd apps/web && npx vitest run src/components/trustCenter/TrustFaqSection.test.tsx src/components/trustCenter/TrustSubprocessorsSection.test.tsx`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to verify they pass**, plus `src/lib/i18n/keyUsage.test.ts` (it must see the existing key used).
- [ ] **Step 5: Commit**: `feat(trust-center): retry button for FAQ and subprocessor load errors (#9087)`.

### Task D3: A Trust Center ticket actor source

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (L104, the union only), `apps/api/src/services/trustPage/access/requests.ts` (L45)
- Test: `apps/api/src/services/trustPage/access/requests.test.ts`

**Interfaces:** `TicketSystemSource` gains `'trust_center'`. `TRUST_ACCESS_TICKET_ACTOR = { kind: 'system', source: 'trust_center', name: 'Trust Center access request' }`. Drop the comment "the ticket service has no trust-center source".

- [ ] **Step 1: Write the failing test** in `requests.test.ts`: `it('files the access-request ticket as the trust_center system source')`. Spy on the ticket-create call and expect `actor` to equal `{ kind: 'system', source: 'trust_center', name: 'Trust Center access request' }`. Red today (`inbound_email`).
- [ ] **Step 2: Run it to verify it fails**: `cd apps/api && npx vitest run src/services/trustPage/access/requests.test.ts`.
- [ ] **Step 3: Implement.** Grep `TicketSystemSource` and `systemSource` repo-wide to confirm there are still no exhaustive consumers (plan time: `ticketService.ts` L205 only).
- [ ] **Step 4: Run it to verify it passes**, plus `src/services/ticketService.test.ts`.
- [ ] **Step 5: Commit**: `fix(trust-center): access-request tickets use a trust_center actor source (#9087)`.

---

## Exit checklist (per PR, before opening it)

- [ ] `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p apps/api` (PR-A, B, C, D) and `-p apps/web` (PR-B, D): **exit 0**, read from `$?`.
- [ ] Unit files named in the tasks: single-fork, small batches, all green, with counts quoted from real output in the PR body.
- [ ] **Per-worktree stack** for the integration suites and E2E (PR-A, B, C, D): `pnpm wt-stack up`, after copying the root `.env` with AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false` and a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` (see `docs/agents/local-stacks.md`, `worktree-stack` skill). Then:
  - `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/trustPage src/__tests__/integration/trustOnlyEvidence src/__tests__/integration/trustAccessRequests src/__tests__/integration/portalTrustPageEditing`. Check `docs/agents/testing.md` for the exact config name and the substring-filter trap before running.
  - **PR-A only:** run the two E2E specs **together, 4 times** on a fresh stack: `npx playwright test tests/trust-center.spec.ts tests/trust-center-gated.spec.ts --repeat-each=4` from `e2e-tests/`. All 8 runs green (the original flake was 1 in 4).
  - `pnpm wt-stack down` and say so in the PR body.
- [ ] PR-A: `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`, `routes/trustPagePublic.test.ts`, `services/trustPage/trustPagePublicPayload.contract.test.ts` green.
- [ ] PR-B: the i18n trio + `no-silent-mutations.test.ts` green, and the PR body carries the two machine-draft lines.
- [ ] No file outside the PR's ownership row changed (`git diff --name-only origin/main...`).
- [ ] One independent review round per PR, run on Sonnet. PR-A and PR-C get a security/tenancy reviewer.

## Follow-ups (not planned here)

- `POST /trust-page/partner-home` (`routes/trustPage.ts` L227) and the portal unpublish (`routes/portal/trustPage.ts` L148) keep calling `scheduleServingRefreshForPartner` after commit, fire-and-forget. They are now inside the reconcile protocol (A1), so they can no longer drop or resurrect a member. What remains is a sub-second delay: a new partner-root member can 404, or an unpublished member can linger as a safe false positive, for the round-trip after the response. If a report ever shows it, make them self-managed and awaited like publish.
- Per-partner serving sets (so a partner reconcile reads only its own members rather than doing `SMEMBERS` over the whole set) if the set grows past ~10k members.
- A `['cis_v8']`-only stored selection resolves to an empty view while the flag is off (#9061 review, deferred there; unchanged).
- #9062 and the custom domain (#3282) are out of scope.

## Advisor quorum

I formed my position first, then got an independent `codex exec` opinion (read-only, `model_reasoning_effort=xhigh`) on all five decisions. Codex read the code itself; its findings are inferred from the code, not reproduced.

| Decision | Codex | Resolution |
|---|---|---|
| D1 classification/grouping | AGREE. On item 8 it disagreed with deferring: the union is TypeScript only and has no switch. | Adopted: item 8 is fixed in PR-D (D3). |
| D2 root cause + self-managed, awaited write | AGREE | Kept |
| D2 epoch algorithm | **DISAGREE.** Epochs bumped only by point writes miss (a) an older rebuild overwriting a newer partner refresh with no epoch change, and (b) a delayed post-commit unpublish `SREM` landing after a later publish. It also noted that awaiting a write that swallows errors cannot back "live when toasted", and that snapshot caching was pre-commit. | **Adopted on the merits.** There are no blind point writes now: every writer is an epoch-checked reconcile that bumps the epoch on apply, and a failed apply drops the built marker so the page falls through rather than hides. The cache write moves after commit. Interleave tests for (a) and (b) are added to A1. |
| D3 revision contract | AGREE. It added that the documents 409 path only sets a message and never reloads. | Adopted (B2) |
| D4 M365 + CIS | AGREE, with two qualifications. First, a clean read-profile disconnect already deletes the sync and CA rows, so reproduce with suspended or consent-lost connections. Second, look only at the `ca_policies` domain. | Adopted (C1 red case = suspended; another domain's `needs_consent` does not suppress). |
| D5 localisation | AGREE | Kept |

Codex also noted that read-time CIS gating cannot recall responses that HTTP caches already hold. That is recorded in D4. No disagreement remains open, so nothing goes to Todd beyond the three Open Decisions (defaults built).
