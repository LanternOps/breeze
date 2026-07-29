# Sentry Triage: BREEZE-12/13, BREEZE-P, BREEZE-X — Implementation Plan

> **Status:** implemented 2026-07-28 — all three code changes landed on branch
> `ToddHebebrand/sentry-bugs`. Three checkboxes remain open on purpose; they are
> human/controller actions, not code.
>
> | PR | Commit | Result |
> |---|---|---|
> | A — BREEZE-12/13 | `d7a498e6a` | Reproduced the shipped 23503 and the reachable 22P02 against real Postgres with the fix reverted, then fixed. Sentry BREEZE-12/13 resolved-in-next-release 2026-07-29. |
> | B — BREEZE-P residuals (a)+(b) | `03112c5df` | AI-tool bypass closed, blank-string persist stopped. |
> | C — BREEZE-X | `2856b5a08` | `prior_status`/`cas_label` tags on both the WS and REST 0-row CAS paths. |
>
> Still open (deliberately): the Sentry release check + BREEZE-P resolution (:163);
> the prod backfill audit query (:184) — needs prod DB access, no migration was
> written; and "do not resolve BREEZE-X yet" (:279), which stays open until events
> carrying `prior_status` arrive.
>
> Two follow-ups the reviews say to file alongside the merge: the inert
> `mobileDeviceBlockedMiddleware` gap (see PR A's out-of-scope section), and the
> unauthenticated `huntress`/`automations` webhook id-cast 500s — same defect class
> as BREEZE-12/13, but reachable without auth.
> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans`. Steps use `- [ ]` checkboxes for tracking.

**Goal:** Close three Sentry issues on evidence, not assumption. PR A fixes a real
100%-reproduction outage in mobile approver registration. PR B closes the last
save-time hole in an already-shipped fix. PR C makes an "is this benign?" issue
answerable instead of arguable.

**Tech Stack:** Hono + Drizzle (API), Vitest (unit + integration), postgres.js.
Node pinned: prefix `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

**Adjacent plan:** `open/2026-06-15-authenticator-registration-redesign.md` touches the
same route. Not blocking — that plan never specified the `mobileDeviceId` resolution,
and its predecessor spec is where the bug came from (see PR A background).

---

## Triage summary

| Issue | Sentry's framing | What the code actually shows | Action |
|---|---|---|---|
| BREEZE-12/13 | intermittent stale-id 500 | **identifier-space mismatch — the route 500s 100% of the time from the iOS app.** Mobile approver registration has never worked in production. | **PR A — fix now** |
| BREEZE-P | unguarded config path | **already fixed on `main` in v0.99.0**, ~11h after the v0.98.1 tag Sentry reports. Prod is on v0.102.0. Three residual gaps remain. | **PR B — verify + resolve, small follow-up** |
| BREEZE-X | needs prior-row status attached | correct — and worse: Sentry's scrubber **discards `extra` entirely**, and the `label` was never emitted as a tag. Also the "exactly one benign cause" comment is wrong; there are at least three. | **PR C — observability** |

---

## PR A — BREEZE-12 / BREEZE-13: authenticator device registration 500s

### Background: this is not a stale-id edge case

`apps/api/src/routes/authenticator.ts:323` reads the `X-Breeze-Mobile-Device-Id` header
and inserts it at `:335` into `authenticator_devices.mobile_device_id`, which FKs
`mobile_devices.id` (`migrations/2026-06-14-a-authenticator-foundation.sql:36-45`,
`ON DELETE SET NULL`).

But the header does not carry `mobile_devices.id`. It carries a **per-install UUID
minted on the phone** (`apps/mobile/src/services/installationId.ts:20-59`, persisted in
SecureStore) — the same value every other consumer correctly matches against
`mobile_devices.device_id`, a `varchar` (`middleware/mobileDeviceBlocked.ts:54`,
`routes/lifecycle.ts:149,187`). `mobile_devices.id` is always server-side
`gen_random_uuid()` (`db/schema/mobile.ts:10`).

Consequences:

- The header is UUID-*shaped*, so it passes the cast and fails the FK → **23503, every
  single time**. `apps/mobile/src/services/approverDevice.ts:35,43` sends it on every
  call to this route, so approver-device registration fails 100% from the phone. The
  client swallows it (`approverDevice.ts:103-105` → `{status:'failed', reason:'http_500'}`)
  and **fails open to L1 approvals** — which is why nobody noticed.
- A forged non-UUID header (`X-Breeze-Mobile-Device-Id: hello`) passes
  `normalizeDeviceId` (`services/mobileDeviceBinding.ts:18-23` — only trims and caps at
  255 chars) and produces Postgres **22P02** instead — a second reachable failure shape
  from the same line. (Corrected 2026-07-29 after reading the actual events: this is NOT
  the BREEZE-12/13 split. Both issues are `pg_code 23503` on one single event, same trace
  id — BREEZE-12 is the raw `PostgresError`, BREEZE-13 the `DrizzleQueryError` wrapper.)
- The FK would only ever have proved existence anyway. Nothing checks ownership, and
  RLS won't: `mobile_devices`' SELECT policy
  (`migrations/2026-04-11-bucket-c-phase-6-user-scoped-rls.sql:142-182`) has an `OR EXISTS`
  branch letting any same-tenant partner/org token read a colleague's row. The
  ownership predicate **must be explicit in the query** — same reasoning as the SR-002
  guard at `routes/mobile.ts:397-414`.

Origin: commit `d4574d6eb` (#1369). The plan doc specified it wrong too —
`docs/superpowers/plans/security-auth/2026-06-14-breeze-authenticator-phase3-mobile-authenticator-pin.md:203`.

### Fix shape

Resolve, don't trust. Never let the header value reach the insert.

```ts
// authenticator.ts, replacing the raw `const mobileDeviceId = readMobileDeviceId(c)`
const mobileDeviceHeader = readMobileDeviceId(c);
let mobileDeviceId: string | null = null;
if (mobileDeviceHeader) {
  const [owned] = await db
    .select({ id: mobileDevices.id })
    .from(mobileDevices)
    .where(and(
      eq(mobileDevices.deviceId, mobileDeviceHeader),   // varchar external id, NOT the uuid PK
      eq(mobileDevices.userId, auth.user.id),           // ownership — RLS does not do this for us
    ))
    .limit(1);
  mobileDeviceId = owned?.id ?? null;                   // degrade to null, never 500
}
```

Three properties this buys, in order of importance:

1. **No unvalidated value reaches an FK column** — ever, for any header content. Both
   23503 and 22P02 become structurally impossible (the lookup targets a `varchar`, so a
   junk header is a miss, not a cast error).
2. **Ownership is checked**, not merely existence.
3. **Registration degrades instead of failing.** For current app builds there is never a
   match (see the follow-up below), so `null` is the normal path — which is fine:
   `authenticator_devices.mobile_device_id` is **never read back anywhere in the API**.
   Its only consumers are this insert and the audit detail at `:355`.

### Tasks

- [x] Read `apps/api/src/routes/authenticator.ts:291-361` and
      `apps/api/src/services/mobileDeviceBinding.ts` in full before editing.
- [x] **Write the failing tests first** (TDD — this is an auth path):
  - [x] Rewrite `apps/api/src/routes/authenticator.test.ts:476-500`. That test
        (`records the per-install mobileDeviceId from the header on registration`)
        **currently pins the bug** — it asserts the raw header lands in the insert. It
        must become: header that resolves to an owned row → inserts the row's `id`.
  - [x] New: header present, no matching `mobile_devices` row → **201** with
        `mobileDeviceId: null` (not 500).
  - [x] New: header matches a row owned by a *different* user → **201** with
        `mobileDeviceId: null`, and assert the *other* user's `mobile_devices.id` never
        appears in the insert values.
  - [x] New: non-UUID junk header (`'hello'`) → **201**, `mobileDeviceId: null`, no throw.
  - [x] New: header absent → 201, `mobileDeviceId: null` (regression guard).
  - [x] Assert the ownership predicate is actually in the `where` — the suite's Drizzle
        mock (`authenticator.test.ts:91-140`) returns string column stubs, so capture and
        assert on the recorded where-expression. A test that only checks the inserted
        value would still pass if `eq(mobileDevices.userId, ...)` were deleted.
- [x] Implement the resolution block. Import `mobileDevices` into `authenticator.ts`
      (check for the schema import cycle the comment at `db/schema/authenticatorDevices.ts:44`
      warns about — that comment is why the Drizzle-level `.references()` was omitted).
- [x] Audit detail (`:355`): record the **resolved** id. If the raw header is still
      wanted for forensics, log it under a distinct key
      (`mobileDeviceHeaderUnresolved`) so the two are never conflated again.
- [x] Add an **integration test** against real Postgres
      (`apps/api/src/__tests__/integration/`) that inserts a real `mobile_devices` row and
      registers an authenticator device. The unit suite fully mocks the DB, so the FK,
      the uuid cast, and RLS are all structurally invisible to it — that is exactly how
      this shipped. This test is the one that would have caught it.
- [x] Delete-the-line injection proof: revert the `eq(mobileDevices.userId, ...)` line
      and confirm a test goes red; revert the whole block and confirm several do.
- [x] Add a code comment stating plainly that the header is
      `mobile_devices.device_id` (varchar), **not** `mobile_devices.id` (uuid PK) — this
      confusion has now cost one shipped outage and one wrong plan doc.
- [x] Full API suite + `pnpm db:check-drift`.

### Out of scope — file as a separate issue

The app never calls `POST /mobile/devices`. Its only row-creating call is
`/notifications/register` (`apps/mobile/src/services/api.ts:536`), which derives a
`push-ios-<sha256>` device_id (`routes/mobile.ts:76-82`) — and re-pair can salt it to
`${deviceId}-${Date.now()}` (`mobile.ts:420`). So **no current iOS build ever has a
`mobile_devices` row whose `device_id` equals the header.**

That means `mobileDeviceBlockedMiddleware` (`middleware/mobileDeviceBlocked.ts:47-69`)
is **inert in production** — "block this phone" matches nothing. That is a live security
gap, larger in impact than the 500, but it is a mobile-client change and does not belong
in this PR. Recommend filing it before merging PR A so the linkage isn't lost.

---

## PR B — BREEZE-P: S3 endpoint. Already fixed; close the residuals

**The reported bug is fixed on `main`.** Commit `8a17ac804` (2026-07-20 09:37) added
`coerceS3EndpointUrl` (`packages/shared/src/utils/s3Endpoint.ts:45`) and routed all four
S3 client construction sites through it. `v0.98.1` — the release Sentry reports — was
tagged 2026-07-19 22:16, missing it by ~11 hours. `git tag --contains 8a17ac804` →
v0.99.0…v0.102.0, and prod (US+EU) is on v0.102.0 as of 2026-07-27. "Last seen 6 days
ago" (≈2026-07-22) predates that rollout. Existing coverage is good, including
`apps/api/src/routes/backup/configs.test.ts:544` (`describe('S3 endpoint validation (Sentry BREEZE-P)')`).

- [ ] Confirm in Sentry that no event carries release ≥ 0.99.0, then **resolve
      BREEZE-P in the next release**.

Three residual gaps justify a small follow-up PR:

- [x] **(a) The AI tool bypasses validation entirely — the one remaining save-time hole.**
      `manage_backup_configs` (`services/aiToolsPolicyPrereqs.ts:733`) writes
      `providerConfig` raw on both create (`:805-810`, `as any`) and update (`:841`), and
      its schema advertises `endpoint?` at `:743`. Route it through `validateS3Details`
      (`routes/backup/schemas.ts:26-72`) like the REST routes do. Runtime guards now
      catch the bad value, so this is a deferred failure at probe/backup time rather
      than a 500 — but it still ships a broken endpoint to every agent, and
      `agent/internal/backup/providers/s3.go:262-269` does no coercion of its own.
      Add a test.
- [x] **(b) Blank strings still persist.** `configs.ts:238` and `:374` guard with
      `if (endpoint) details.endpoint = endpoint;`. When input is `''` (the web form's
      initial state — `BackupDestinationSection.tsx:78`), `coerceS3EndpointUrl` returns
      `undefined`, the branch is skipped, and the **raw `''` from the payload survives in
      `details`** and is written. Harmless at runtime (API and Go agent both treat it as
      absent) but blank rows keep accumulating. Explicitly `delete details.endpoint`
      when coercion yields `undefined`.
- [ ] **(c) No backfill exists** — no migration touches `provider_config`. Run the
      read-only audit first and decide on the evidence; do **not** write a cleanup
      migration blind:
      ```sql
      SELECT id, org_id, provider_config->>'endpoint'
      FROM backup_configs
      WHERE provider = 's3' AND provider_config->>'endpoint' IS NOT NULL
        AND provider_config->>'endpoint' !~ '^https?://';
      ```
      If rows exist, the cleanup migration must report row counts per the CLAUDE.md
      cleanup-statement rule.

Note for whoever touches this: the repo deliberately keeps **three** endpoint parsers
with different failure modes, documented at `s3Endpoint.ts:26-37`
(`deriveS3RegionFromEndpoint` fails soft→null, `jobs/backupRetention.ts:529`
`normalizeS3Endpoint` fails soft→raw because it builds a storage *identity* key and must
never throw, `coerceS3EndpointUrl` fails loud). They share the default-to-https rule and
must stay in sync. Do not "consolidate" them.

---

## PR C — BREEZE-X: make the CAS 0-row event self-diagnosing

### The gap is bigger than "no prior status"

`agentWs.ts:1802-1828` wraps the terminal CAS in
`dbWriteExpectingRows('device_commands.ws_result_terminal_cas', …)`, which on 0 rows
calls `captureMessage(message, 'warning', { label, stack })`
(`db/dbWriteExpectingRows.ts:10-18`). But:

- `services/sentry.ts:250-266` contains a literal **`void extra;`** — extras are
  discarded at capture time. `scrubEvent` (`:142-162`, wired as `beforeSend` at `:193`)
  then deletes `extra`, `contexts`, `breadcrumbs`, **and `message`/`logentry`**, and
  rebuilds `tags` through `pickAllowedTags`.
- `dbWriteExpectingRows` passes **no tags at all**, so
  `device_commands.ws_result_terminal_cas` is not a Sentry tag — it survives only inside
  the message string, which the scrubber then deletes.

So adding fields to the `extra` object would change nothing observable. **Tags are the
only channel**, and the allowlist (`sentry.ts:25-34`:
`method, route_template, pg_code, rls_deny, user_id, scope, org_id, partner_id`) gates
both `setCallerTags` and `pickAllowedTags` — both must accept any new name.

### The "exactly one benign cause" comment is also wrong

`agentWs.ts:1794-1801` names only the REST twin. At least two more writers CAS the same
rows out of `('pending','sent')`:

- **`jobs/staleCommandReaper.ts:229-242`** — fleet-wide, on a schedule, sets
  `status:'failed'`, `result:{status:'timeout', timedOutBy:'server'}`. An agent replying
  just past the timeout boundary produces exactly this 0-row CAS. Unmentioned, and the
  most likely non-REST benign cause.
- Cancellation paths: `admin/abuse.ts:153-161`, `software.ts:1426`,
  `scripts.ts:1050,1065`, `cisHardening.ts:948`, `discovery.ts:1018`,
  `backup/restore.ts:431`, `maintenance.ts:659,669`, `playbookRetention.ts:77`,
  `backup/verificationScheduled.ts:182`.

Prior `status` + `result->>'timedOutBy'` discriminates all three cleanly: REST twin
(`completed`/`failed` with a real result), reaper (`failed` + `timedOutBy:'server'`),
cancellation (`cancelled`).

### Tasks

- [x] Add `prior_status` and `cas_label` to `ALLOWED_TAG_NAMES` (`sentry.ts:25-34`).
      Both are low-cardinality enum-ish strings, no PII. Update the pinning tests:
      `sentry.test.ts:75-88` (asserts non-allowlisted tags are dropped), `:90-111`, `:113-122`.
- [x] Plumb an optional `tags` argument through `dbWriteExpectingRows`
      (`db/dbWriteExpectingRows.ts`) to `captureMessage`, and emit the label as
      `cas_label` so the issue is groupable at all. Only two call sites —
      `agentWs.ts:1804` and `routes/auth/login.ts:583`. Update
      `dbWriteExpectingRows.test.ts` (4 tests pin the current signature).
- [x] On the **0-row branch only**, re-SELECT the row by PK inside the existing system
      context and tag `prior_status` (plus `timedOutBy` folded into the same tag value,
      e.g. `failed:server-timeout`, to avoid a second allowlist entry).
  - Keep it conditional. `agentWs.test.ts:2351-2430` (`device_commands access context on
    the WS result path (#1375)`) asserts the **exact op sequence** `['select','update']`
    — an unconditional read breaks it. A failure-branch read never fires there.
  - Cost is one PK lookup on a path that fired 14 times total. The hot agent path is
    untouched, which matters given the #1105 pool pressure both comments cite.
  - **Do not** use `UPDATE … RETURNING` — it returns the *new* image and returns nothing
    when 0 rows match, so it cannot yield the prior status. (`RETURNING OLD.*` is PG18-only.)
    A single-statement CTE works on postgres.js but would replace the Drizzle builder
    every mock in `agentWs.test.ts` is written against — not worth the blast radius.
- [x] **Make the REST twin report too.** `routes/agents/commands.ts:321-323` returns
      `{success:true}` silently on 0 rows and does not use `dbWriteExpectingRows` at all.
      Without a matching signal you cannot confirm the race from the WS side alone. Give
      it its own label (`device_commands.rest_result_terminal_cas`) and the same
      `prior_status` tag. Note it usually short-circuits earlier at `:261-266` on a
      terminal pre-read, so this branch should be rarer still — which is itself
      informative.
- [x] Correct the comment at `agentWs.ts:1794-1801` to name the reaper and the
      cancellation paths. As written it tells the next reader that a reaper race is a defect.
- [x] Tests: 0-row branch tags the prior status; the extra read does **not** occur on the
      happy path; `commands.test.ts` gains its first 0-row CAS test (currently none of
      its 8 tests touch that branch).
- [ ] **Do not resolve BREEZE-X yet.** Ship, wait for events carrying `prior_status`,
      then close on evidence. That is the entire point of the PR.

`device_commands` has **no `updated_at` and no version/sequence column**
(`db/schema/devices.ts:404-416`; `status` is a bare `varchar(20)` with no enum or CHECK,
carrying `pending|sent|completed|failed|timeout|cancelled|expired`). The status predicate
is the whole concurrency guard. Adding a real CAS token is a separate, larger change —
not proposed here.

---

## Sequencing

PR A, B, and C are fully independent — different files, no shared state. A is the only
one with user-visible impact and should go first. B is ~an hour. C should merge early
regardless, since its value is the wait time afterwards.
