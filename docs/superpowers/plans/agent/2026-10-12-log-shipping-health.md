---
tracking_issue: LanternOps/breeze#8607
---

# Log-Shipping Health in the Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent reports whether its own log shipping is failing in the heartbeat; the API derives a sustained-failure state; the device detail page shows one line only when shipping is failing.

**Architecture:** The shipper records attempt/success/error/queue facts with atomics at terminal chunk-outcome boundaries (once per shipped chunk, never on the per-log `Enqueue` path) and the heartbeat snapshots them into a bounded `logShipping` object. The API classifies each beat, persists only on state change into three nullable `devices` columns (same pattern as `helperInstallIssue`/`helperInstallIssueSince`, #6925), and derives "failing" at read time (episode ≥ 30 min, device online), so no timer or job is needed. Server and web land first and stay dormant until agents send the field.

**Tech Stack:** Go agent, Hono/Drizzle API, Postgres (hand-written migration), Astro/React web, Vitest, Go `testing -race`.

**Spec:** Issue #8406 (follow-up to #7067; design comment linked from the issue). No separate spec doc.

**Issue:** #8406. Refs only; this plan registers nothing. The orchestrator registers the feature and waves after approval.

## Global Constraints

- Log shipping health is **observational**. It never gates command dispatch, auth, or any security decision. Absence of the field means **unknown**, never healthy and never failing. Absence of logs is never evidence of anything.
- "Sustained failure" = **30 minutes** of continuous failing beats, measured on the **server receive clock**. Any non-failing beat resets the episode; an `invalid` beat is neither and changes nothing.
- No device-list pill. One line on device detail, only when `failing`.
- Hand-written migration only (never `drizzle-kit generate/push`); slot `2026-12-23-200000-device-log-shipping-health.sql` (re-check, see W1 Task 1). Idempotent, no inner `BEGIN/COMMIT`, nullable ADD COLUMN only, never edit a shipped migration.
- Every new en locale key goes into all 8 supported locales (`SUPPORTED_LOCALES`, `packages/shared/src/utils/locale.ts:5`; files `apps/web/src/locales/<locale>/devices.json`; `localeParity` in `src/lib/i18n`).
- Test commands: `cd apps/api && npx vitest run <files>` / `cd apps/web && npx vitest run <files>` (no `--` before flags); `cd agent && go test -race ./internal/<pkg>/...`.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` (same in `apps/web`); check the exit code, never pipe to `tail`.
- Waves are **sequential PRs off `main`**. Stacked PRs (base ≠ main) get no CI (`ci.yml` triggers only on PRs to main); if one is ever stacked, run `gh workflow run CI --ref <branch>`.
- Public repo: no customer names, hostnames, IPs, or session IDs in code, tests, commits, or PR text.

## Review Focus

1. **Offline device** shows nothing while not `online`. Known limit (see Open Decision 6): the WS handshake and other writers set `online` before the first beat, so no server-side status/`lastSeenAt` rule can reliably detect an outage gap; an episode that spans an outage is reported from the first failing beat observed. Mitigated by the agent-side expiry below, so a device that stops attempting during an outage reads quiet, not failing.
2. **Old agent after a new agent (downgrade)** stops sending `logShipping`; stored state returns to unknown instead of freezing at `failing`.
3. **Malformed `logShipping`** (wrong types, huge `lastError`, negative ints, unknown keys) must never reject the heartbeat: wire field is `z.unknown()`, strict-parsed separately; a bad value is `invalid` (no state change), never coerced to a healthy zero.
4. **Quiet agent** (warn+ only, no attempts) must read healthy/quiet, never failing and never "silent".
5. **Error text leaks**: `lastError` must not carry URLs, IPs, tokens, or file paths off the machine or into the export.
6. **Agent clock skew**: classification uses no agent timestamps (explicit `lastAttemptOk` outcome); the "since" shown is server time.
7. **Throttled `last_log_at`** (updates at most every 5 min, `routes/agents/logs.ts`) must not be used for the "Logs not arriving" check, or it false-alarms inside the throttle window.

---

## Verified facts on `origin/main` (2026-10-12)

| Claim | Where | Status |
|---|---|---|
| Agent sends only `DroppedLogs int64 json:"droppedLogs,omitempty"` | `agent/internal/heartbeat/heartbeat.go:118`, set at `:4932`, committed (zeroed) after a successful beat at `:5065` | confirmed. It is a **delta since last successful beat**, not cumulative |
| `droppedLogs` is not read anywhere in API or web | grep of `apps/api/src`, `apps/web/src` | confirmed. `heartbeatSchema` is a non-strict `z.object` so unknown keys are stripped today. There is **no existing contract to break** |
| Shipper drops counted in `droppedCount atomic.Int64`; ship path `shipBatch` → `shipChunk` (HTTP POST, 2 retries = 3 requests, `shipRetryCount = 2`) | `agent/internal/logging/shipper.go:97, 466, 516` | confirmed. `Enqueue` (`:272`) is the per-log hot path and stays untouched |
| Heartbeat already issues exactly one `UPDATE devices` per beat (`deviceUpdates`) | `routes/agents/heartbeat.ts:986, 1444` | confirmed. Adding keys to `deviceUpdates` adds **no statement** |
| State-change-only precedent with since-timestamp | `heartbeat.ts:1112-1119` (`helperInstallIssue`, `helperInstallIssueSince`) and migration `2026-11-02-100100-device-helper-install-issue.sql` | confirmed |
| Device detail "Agent" rows live in `DeviceInfoTab.tsx` (agentVersion `:1081`, helper issue `:1143`) | `apps/web/src/components/devices/DeviceInfoTab.tsx` | confirmed. The one line goes here, next to the helper-issue precedent |
| Agent-health summary precedent | `GET /devices/stats` returns `migrationRequiredCount` via `count(*) filter (...)` in `routes/devices/stats.ts:70-92` | confirmed |
| Filter catalog is mirrored: `services/filterEngine.ts` (server, supports `computed` SQL, e.g. `daysSinceLastSeen`) and `apps/web/src/components/filters/filterFields.ts` | | confirmed |
| Level raise is `handleSetLogLevel` in `agent/internal/heartbeat/handlers_logship.go` (stored command type `set_log_level`); API-side tool in `services/aiToolsAgentLogs.ts` | | confirmed. Raise outcome is in `device_commands.result` (`result.stdout` JSON: `appliedLevel`, `expiresAt`) |
| `devices.last_log_at` is throttled to ≥5 min drift | `routes/agents/logs.ts:58-64` | confirmed. Not usable for a 5-min check (Review Focus 7) |
| `agent_logs` has `agent_logs_device_created_at_idx (device_id, created_at desc, id desc)` | `db/schema/agentLogs.ts:27` | confirmed. Supports the exact on-demand check |
| Newest committed migration is `2026-12-23-100000-tier1-sweep-indexes.sql`; open PRs hold `...-110000` to `...-190000` | `git ls-tree origin/main apps/api/migrations/` | re-check at implementation time |
| `handlers_logship.go` and `heartbeat.go` `compiledSecurityCapabilities()` (`:8152`) exist; precedent tests `*_capability_test.go` | `agent/internal/heartbeat/` | confirmed |

## Design

### Wire shape (agent → API)

(`//` comments below are annotations, not valid JSON. `lastAttemptAt`/`lastSuccessAt` are diagnostics only: not used in classification; the API validates and drops them in W1, and W4+ may surface `lastSuccessAt` in the detail line if wanted.)

```json
"logShipping": {
  "schemaVersion": 1,
  "lastAttemptAt": "2026-10-12T10:00:00Z",   // display/diagnostics only; omitted if none
  "lastSuccessAt": "2026-10-12T09:59:00Z",   // omitted if none (display only)
  "lastAttemptOk": false,                     // outcome of the last COMPLETED attempt; omitted if none
  "lastError": "http 503",                    // sanitized, <=160 chars, omitted when last attempt succeeded
  "queueDepth": 412,
  "droppedLogs": 0                            // delta since last successful beat (same value as top-level droppedLogs)
}
```

Top-level `droppedLogs` keeps being emitted unchanged for one release (it is unread today, so this is purely rollback safety); the issue's "extend the existing `droppedLogs`" is satisfied by nesting the same delta. Follow-up cleanup removes the top-level key. The object is emitted whenever the shipper is initialized, **including when quiet** (all-zero), so "present and empty" means quiet/healthy and "absent" means unknown.

### Classification (API, per beat)

A beat is a **failing beat** if any of:
- `lastAttemptOk === false`: the most recent **completed** attempt failed. The outcome is an explicit boolean written when an attempt finishes, so an in-flight request is never a failure and sub-second success/failure ordering cannot be lost to equal timestamps (Codex review). Timestamps are display-only and never compared;
- `droppedLogs > 0` (a per-beat delta zeroed after each successful beat, so drops alone sustain an episode only if they recur on every beat for 30 min);
- `queueDepth >= QUEUE_FAILING_DEPTH` (constant `LOG_SHIPPING_QUEUE_FAILING_DEPTH = 400`, 80% of the 500-entry `defaultBufferSize` at `shipper.go:40`, applied to `len(buffer) + pendingBatch`; an absolute threshold needs no previous-beat state. Because the loop drains continuously, queue depth is a secondary signal; `lastAttemptOk` and `droppedLogs` carry the classification).

Else it is **quiet** when `lastAttemptOk` is absent, otherwise **ok**. Persisted `log_shipping_state` ∈ `ok | quiet | failing`; `NULL` = unknown.

### Derived read state (exact enum)

`unknown | healthy | quiet | failing`, computed on read, never stored:

| Stored state | Device status | Episode age | Derived |
|---|---|---|---|
| NULL | any | n/a | `unknown` |
| `ok` | any | n/a | `healthy` |
| `quiet` | any | n/a | `quiet` |
| `failing` | not `online` | any | `unknown` (never report shipping failure for an offline device) |
| `failing` | `online` | `< 30 min` | `healthy` (pending, not yet sustained) |
| `failing` | `online` | `>= 30 min` | `failing`, `failingSince = log_shipping_failure_started_at` |

Response shape on device detail and list rows: `logShipping: { state, failingSince: string|null, lastError: string|null }` (`lastError` only when `failing`).

### Persistence (decision: `devices` columns, not a new table)

Three nullable columns on `devices`: `log_shipping_state varchar(16)` (CHECK in `ok|quiet|failing`), `log_shipping_failure_started_at timestamptz` (episode start, server clock), `log_shipping_last_error varchar(200)`; plus partial index `devices_log_shipping_failing_idx ON devices (log_shipping_failure_started_at) WHERE log_shipping_failure_started_at IS NOT NULL`. A device-scoped table was rejected: it would add a join and a tenancy shape-5 table (RLS, composite FK, cascade, org-merge, export registration) for three scalars that describe the device row 1:1, and `devices` is already the home of every other heartbeat-derived health fact. No jsonb (jsonb would be forced `excludedOpen` in the export policy and cost TOAST churn).

### Write amplification

The beat's `UPDATE devices` already runs every beat. The new code adds keys to `deviceUpdates` **only on transition**, compared against the already-loaded `device` row:
- `NULL → state` (first report) and `state → NULL` (field absent: downgrade/disabled);
- `ok|quiet ↔ failing` (sets/clears `failure_started_at`);
- `lastError` change while failing.

Steady-state healthy/quiet/unknown beats add **zero keys and zero statements**. Steady-state failing beats add zero unless `lastError` changed (sanitizer collapses to a closed set of short messages so it rarely flaps). There is deliberately **no server-side offline-gap rule**: `devices.status` and `lastSeenAt` are also written by the WebSocket handshake, desktop/terminal WS and mTLS paths (`routes/agentWs.ts:1267,2828`, `desktopWs.ts:709`, `terminalWs.ts:572`, `agents/mtls.ts:1545`) before the first post-outage beat, so neither can prove a gap. Continuity instead comes from the agent: it reports `lastAttemptOk`/`lastError` only while its last completed attempt is younger than 10 minutes on its own monotonic clock; older → fields omitted → `quiet` → the episode clears. Without that expiry one failed send from a warn-only agent would stay `lastAttemptOk:false` forever (the shipper only sends when it has entries, `shipper.go:441-446`).

### Compat matrix

| Agent | API | Behaviour | Proven by |
|---|---|---|---|
| old (no `logShipping`) | new | state stays/returns NULL → `unknown`, UI silent | W1 route test: omit field; asserts no `deviceUpdates` log-shipping keys on a fresh device and `log_shipping_state` reset on a previously-reporting device |
| new | old (pre-W1) | key stripped by non-strict zod; extra bytes only (<400 B/beat) | W3 Go test marshals payload; W1 test posts a body with the key against the pre-change schema snapshot in `schemas.heartbeatTolerance.test.ts` asserting `.parse` succeeds and strips |
| new | new | classified, persisted on transition | W1 + W3 |
| new, malformed object | new | heartbeat accepted, field ignored | W1 test (Review Focus 3) |

### Feature detection (decision 3)

Presence of the `logShipping` object **is** the feature-detect. No `securityCapabilities` protocol version: capability versions exist to gate *dispatch* of commands/policies the agent must honour; this field is read-only telemetry, and a version int would only add a second place to disagree with the object (`compiledSecurityCapabilities()` stays untouched). The in-object `schemaVersion: 1` is the future-shape escape hatch.

---

## Wave map

| Wave | Ships | Leaves behind if the next never ships | Test jobs that matter |
|---|---|---|---|
| **W1** API schema, storage, derivation | migration, schema, zod, classifier, heartbeat persistence, `logShipping` on device GET/list, export-policy classification | Columns + derived field exist, always `unknown`. Harmless, dormant. | Test API, **Integration Tests** (export policy) |
| **W2** Web device-detail line | DeviceInfoTab line + 8 locales | Line never renders (no data). Harmless. | Test Web |
| **W3** Agent payload | shipper counters, `logShipping` in heartbeat | Fleet starts reporting; failing devices get the W2 line. **Feature is user-visible here.** Fully useful without W4+. | Test Agent (`-race`) |
| **W4** Fleet filter + count | `filterEngine` + web catalog field, `/devices/stats` count, saved view preset | Detail line only; no fleet view. | Test API, Test Web |
| **W5** "Logs not arriving" | read-time check after a level raise (canary line ships in W3) | Raise works as today; no warning. | Test API, Test Web |
| **W6** (optional) Alert condition | opt-in, off by default | Nothing alerts; operators use the filter. | Test API |

Cut changes vs the suggested split, with reason: (a) the fleet filter is its own wave (W4) because it edits the mirrored server/web filter catalogs with their parity tests, which deserve a separate review, and it is only meaningful once agents report (after W3); (b) "Logs not arriving" is split from the alert condition (W5/W6) because it needs no schema and no agent change, while W6 touches alert evaluation. W1 → W2 → W3 order is server-first dormant (agent-first would ship telemetry the API silently drops and cannot be observed).

---

## Wave 1: API schema, storage, derivation (dormant)

### Task 1: Migration, Drizzle schema, export-policy classification

**Files:**
- Create: `apps/api/migrations/2026-12-23-200000-device-log-shipping-health.sql`
- Modify: `apps/api/src/db/schema/devices.ts` (next to `helperInstallIssueSince`, `:341`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (the `devices` entry, line ~410)
- Test: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts` (reads the live DB columns, so it is the real red/green and runs only under **Integration Tests**) plus an explicit assertion added to a new `apps/api/src/services/tenantExportPolicyRegistry.logShipping.test.ts` (create it; follow the `tenantExportPolicyRegistry.<topic>.test.ts` naming of its siblings) asserting the three columns have the stated classifications; migration lint in `apps/api/src/db/migrationRlsScope.test.ts`

**Interfaces:**
- Produces: `devices.logShippingState: 'ok'|'quiet'|'failing'|null`, `devices.logShippingFailureStartedAt: Date|null`, `devices.logShippingLastError: string|null`.

- [ ] **Step 1: Re-check the slot.** `git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -5`. If anything ≥ `2026-12-23-200000` is committed, move up. Read `apps/api/migrations/README.md` (`-- @no-transaction` is required for `CREATE INDEX CONCURRENTLY`, `:68`). Decide and state in the PR whether the plain partial-index build on `devices` is acceptable at current table size; the partial index is empty at creation so the build is a single scan.
- [ ] **Step 2: Red first.** Write the classification assertions in the new unit test (`devices` policy: `log_shipping_state`/`log_shipping_failure_started_at` included, `log_shipping_last_error` excludedSensitive) and watch them FAIL. Then add the Drizzle columns (Step 3) and run `pnpm db:check-drift` BEFORE the SQL file exists: expected FAIL (schema declares columns no migration creates). The unclassified-column failure itself only appears in the integration suite (`pnpm test-stack up`).
  ```bash
  export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"; pnpm db:check-drift
  ```
- [ ] **Step 3: Schema.**
  ```ts
  logShippingState: varchar('log_shipping_state', { length: 16 }),
  logShippingFailureStartedAt: timestamp('log_shipping_failure_started_at', { withTimezone: true }),
  logShippingLastError: varchar('log_shipping_last_error', { length: 200 }),
  ```
  plus the partial index in the table's index callback (`devices_log_shipping_failing_idx`, `.where(sql\`log_shipping_failure_started_at IS NOT NULL\`)`).
- [ ] **Step 4: Migration.**
  ```sql
  -- #8406 W1: log-shipping health reported in the heartbeat. Nullable adds only (no table rewrite).
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS log_shipping_state varchar(16);
  -- NOT VALID: no table scan under ACCESS EXCLUSIVE (all existing rows are NULL anyway); the #6925 precedent kept the ALTER metadata-only.
  DO $$ BEGIN
    ALTER TABLE devices ADD CONSTRAINT devices_log_shipping_state_chk
      CHECK (log_shipping_state IN ('ok','quiet','failing')) NOT VALID;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS log_shipping_failure_started_at timestamptz;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS log_shipping_last_error varchar(200);
  CREATE INDEX IF NOT EXISTS devices_log_shipping_failing_idx
    ON devices (log_shipping_failure_started_at) WHERE log_shipping_failure_started_at IS NOT NULL;
  ```
  No row writes, so no `set_config('breeze.scope','system',true)` is required; add it anyway only if the README says a lint demands it for files touching `devices`. No inner `BEGIN/COMMIT`.
- [ ] **Step 5: Export classification** in the `devices` policy: `log_shipping_state` and `log_shipping_failure_started_at` → `included`; `log_shipping_last_error` → `excludedSensitive` (free text derived from network errors; even sanitized it can carry a remote endpoint's shape, and it is transient diagnostics with no restore value). None are jsonb, so none go in `excludedOpen`.
- [ ] **Step 6: Verify green.** `pnpm db:migrate && pnpm db:check-drift`; `cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.logShipping.test.ts src/db/migrationRlsScope.test.ts`, then the integration suite above; then the mechanical sweep below.
- [ ] **Step 7: Registration sweep (grep, do not judge).** This wave adds columns to an **already-registered** table and **no new `org_id` table**, so `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`), `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`), `orgMergeRegistry.ts`, and the shape-5 allowlist in `rls-coverage.integration.test.ts` need **no change**. Prove it: `grep -rn "log_shipping" apps/api/src | grep -v "devices.ts\|tenantExportPolicyRegistry"` returns nothing in those files. **Enforcement:** the export-policy suite fails only under the **Integration Tests** CI job, never Test API: run it locally via `pnpm test-stack up` then the integration shard that contains `tenantExportPolicy`/`org-cascade`, and `pnpm test-stack down` after.
- [ ] **Step 8: Commit.** `git commit -m "feat(api): device log-shipping health columns (#8406)"` + attribution line.

### Task 2: Wire schema + classifier (pure function)

**Files:**
- Create: `apps/api/src/services/logShippingHealth.ts`
- Create: `apps/api/src/services/logShippingHealth.test.ts`
- Modify: `apps/api/src/routes/agents/schemas.ts` (add `logShipping` to `heartbeatSchema`)
- Test: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts` (existing)

**Interfaces:**
- Produces:
  ```ts
  export const LOG_SHIPPING_SUSTAINED_MS = 30 * 60_000;
  export const LOG_SHIPPING_QUEUE_FAILING_DEPTH = 400;
  export type ParsedLogShipping = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'ok'; report: LogShippingReport };
  export function parseLogShipping(raw: unknown): ParsedLogShipping; // zod safeParse (object schema strips unknown keys); undefined -> absent, parse failure -> invalid
  export type LogShippingReport = { schemaVersion: 1; lastAttemptAt?: string; lastSuccessAt?: string; lastAttemptOk?: boolean; lastError?: string; queueDepth: number; droppedLogs: number };
  export type LogShippingStoredState = 'ok' | 'quiet' | 'failing';
  export function classifyLogShippingBeat(r: LogShippingReport): LogShippingStoredState;
  export function planLogShippingWrite(device: {logShippingState: string|null; logShippingFailureStartedAt: Date|null; logShippingLastError: string|null; status: string}, report: ParsedLogShipping, now: Date): Partial<{logShippingState: string|null; logShippingFailureStartedAt: Date|null; logShippingLastError: string|null}>; // {} when nothing changes
  export type DerivedLogShipping = { state: 'unknown'|'healthy'|'quiet'|'failing'; failingSince: string|null; lastError: string|null };
  export function deriveLogShipping(row: {status: string; logShippingState: string|null; logShippingFailureStartedAt: Date|null; logShippingLastError: string|null}, now: Date): DerivedLogShipping;
  ```

- [ ] **Step 1: Write failing tests** (`logShippingHealth.test.ts`), one `it` each:
  - classify: no completed attempt + zero queue → `quiet`; `lastAttemptOk:true` → `ok`; `lastAttemptOk:false` → `failing` (including `lastSuccessAt` absent, or equal to/after `lastAttemptAt`: timestamps are never compared); `droppedLogs: 3` with `lastAttemptOk:true` → `failing`; `queueDepth: 400` → `failing`, `399` → `ok`.
  - plan: first report on NULL device → sets state only; `ok→ok` → `{}`; `ok→failing` → sets state + `failureStartedAt = now` + `lastError`; `failing→failing` same error → `{}`; `failing→failing` new error → only `lastError`; `failing→ok` → clears started_at and error; `absent` on a reporting device → all three `null`; `absent` on a NULL device → `{}`; **`invalid` on a failing device → `{}` (no change; a malformed report neither clears nor extends an episode)**; success→failure inside one second (equal timestamps) still classifies `failing` via `lastAttemptOk:false`.
  - derive: the full table above, incl. offline-with-failing → `unknown`, 29m59s → `healthy`, 30m00s → `failing`, `lastError` returned only when `failing`.
  - `lastError` longer than 200 chars is truncated by `planLogShippingWrite` (defence in depth; zod also caps).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/logShippingHealth.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the four exports above (pure; no DB; `now` injected).
- [ ] **Step 4: Schema + tests.** The wire field is typed `logShipping: z.unknown().optional()` in `heartbeatSchema` (same pattern as `networkContextV1`, so a malformed object can never reject the beat), and `parseLogShipping` does the strict parse (`schemaVersion: z.literal(1)`, `lastAttemptAt`/`lastSuccessAt` ISO datetimes, `lastAttemptOk` boolean, `lastError` `max(160)`, `queueDepth` int 0..1e6, `droppedLogs` int 0..1e9, unknown keys stripped). Parse failure yields `invalid`, **not** coerced zeros, so a bad field can never turn into a healthy report (Review Focus 3). Tests: valid parses; `schemaVersion: 2` → `invalid`; `queueDepth: "x"` → `invalid`; 5 KB `lastError` → `invalid`; heartbeat with each still parses at the route level; unknown key stripped. Red first, then green.
- [ ] **Step 5:** `npx vitest run src/services/logShippingHealth.test.ts src/routes/agents/schemas` → PASS. Commit.

### Task 3: Heartbeat persistence + read exposure

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (insert after the `helperInstallIssue` block, `:1112-1119`)
- Modify: `apps/api/src/routes/devices/core.ts` (list select `:1245`/map `:1459` and the detail select), `apps/api/src/routes/devices/helpers.ts` (column list at `:31-44`)
- Test: `apps/api/src/routes/agents/heartbeat.logShipping.test.ts` (new; copy the harness from `heartbeat.test.ts`), `apps/api/src/routes/devices/core.list-response-shape.test.ts`

**Interfaces:**
- Consumes: `planLogShippingWrite`, `deriveLogShipping` (Task 2).
- Produces: `deviceUpdates` log-shipping keys on transition only; device detail and list rows gain `logShipping: DerivedLogShipping`.

- [ ] **Step 1: Failing route tests** (`heartbeat.logShipping.test.ts`):
  1. fresh device + no `logShipping` → the `.set()` payload contains **none** of the three keys (write-amplification assertion).
  2. `logShipping` quiet on fresh device → payload has `logShippingState: 'quiet'` only.
  3. device already `ok`, same report → none of the keys (zero extra columns).
  4. device `ok`, failing report → state, `failureStartedAt`, `lastError` set; **exactly one** `db.update(devices)` call for the beat (no second statement).
  5. device `failing`, field omitted → all three `null`.
  6. malformed `logShipping` (string) on a `failing` device → 200 and no keys (state and `failureStartedAt` untouched).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/agents/heartbeat.logShipping.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
  ```ts
  Object.assign(deviceUpdates, planLogShippingWrite(device, parseLogShipping(data.logShipping), new Date()));
  ```
  Verified: the beat re-reads the full `devices` row with an uncached `db.select().from(devices)` inside its own request context (`heartbeat.ts:695`), not the narrow auth-middleware select (`middleware/agentAuth.ts:626`), so the new columns are present on `device` with no select change and the compare is against current data. Add a test asserting the compare uses `device` as loaded (no extra read).
- [ ] **Step 4: Read exposure.** Add the three columns to the device detail/list selects and attach `logShipping: deriveLogShipping(row, new Date())`; do **not** add the raw `logShippingLastError`/`logShippingState` columns to `PUBLIC_DEVICE_FIELDS` in `helpers.ts:31-44` (raw error must only surface through the derived `logShipping` object, only while `failing`); add the new keys to whatever the helper's `satisfies` check requires and assert the raw keys are absent from the response. Update `core.list-response-shape.test.ts` expected keys (red first).
- [ ] **Step 5:** `npx vitest run src/routes/agents/heartbeat.logShipping.test.ts src/routes/devices/core.list-response-shape.test.ts src/services/logShippingHealth.test.ts`; typecheck (exit code). Commit.

**W1 gate before PR:** typecheck API; full `cd apps/api && npx vitest run` for touched dirs; `pnpm db:check-drift`; Integration Tests locally for `tenantExportPolicy` (see Task 1 Step 7); wave PR body carries `Closes #<wave sub-issue>` per feature-lifecycle (orchestrator provides the number); it never carries a closing keyword for parent #8406.

---

## Wave 2: Web device-detail line

### Task 4: One line in the Agent section

**Files:**
- Modify: `apps/web/src/components/devices/DeviceInfoTab.tsx` (next to the helper-issue block, `:1143`; extend `DeviceInfo` type near `:85`)
- Modify: `apps/web/src/lib/i18n/**` all 8 locales (key `deviceInfoTab.logShippingFailing`)
- Test: `apps/web/src/components/devices/DeviceInfoTab.test.tsx`

**Interfaces:**
- Consumes: `info.logShipping?: { state; failingSince: string|null; lastError: string|null }` from W1.

- [ ] **Step 1: Failing tests:** renders `Log shipping failing since <date>: http 503` (via `data-testid="log-shipping-failing"`) when `state==='failing'`; renders nothing for `unknown|healthy|quiet`, for `logShipping` undefined (old API), and when `failingSince` is null; `lastError` null → line without the colon suffix; assert **no** log-shipping text in `DeviceList` row render (no pill).
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/devices/DeviceInfoTab.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the line (plain text row in the Agent section, no mutation so no `runAction`, no hash state). Add the key to all 8 locales (`apps/web/src/locales/<locale>/devices.json`; run `npx vitest run src/lib/i18n` for `localeParity`).
- [ ] **Step 4:** green + web typecheck (exit code). Commit.

---

## Wave 3: Agent payload (high blast radius: ships to customer machines)

### Task 5: Shipper health counters (no hot-path cost)

**Files:**
- Modify: `agent/internal/logging/shipper.go` (fields near `:97`; record inside `shipChunk` at the attempt result sites; `Snapshot` accessor)
- Modify: `agent/internal/logging/logging.go` (package-level `LogShippingSnapshot()` next to `DroppedLogCount()` at `:227`)
- Create: `agent/internal/logging/shipper_health.go` (sanitizer + snapshot type) and `shipper_health_test.go`

**Interfaces:**
- Produces:
  ```go
  type HealthSnapshot struct {
      Initialized   bool
      LastAttemptAt time.Time // zero if none
      LastSuccessAt time.Time
      LastAttemptOk *bool     // nil if no completed attempt
      LastError     string    // sanitized, <=160 bytes, "" if last attempt succeeded
      QueueDepth    int
      Dropped       int64     // same value as DroppedLogCount()
  }
  func (s *Shipper) HealthSnapshot() HealthSnapshot
  func LogShippingSnapshot() HealthSnapshot // Initialized=false if no global shipper
  func sanitizeShipError(err error, status int) string
  ```

- [ ] **Step 1: Failing tests** (`shipper_health_test.go`, `-race`): (a) success against an `httptest` server sets `LastAttemptAt`/`LastSuccessAt`, `LastAttemptOk=true`, empty `LastError`; (a2) snapshot taken while a request is blocked in-flight still reports the prior outcome; (a3) success then failure inside one second ends `LastAttemptOk=false`; (a4) **expiry:** a failed attempt older than 10 min (fake clock) is reported with `LastAttemptOk=nil`, empty `LastError`; (b) 503 ×3 (the 1 + 2 retries) sets attempt, leaves success zero, `LastAttemptOk=false`, `LastError == "http 503"`; (c) network error with a URL, IP and path in the message → sanitized string contains none of them (`https://`, digits-dot patterns, `/`, `\`, `Bearer`) and is ≤160 bytes; (d) `HealthSnapshot` under 8 concurrent goroutines calling `Enqueue` plus `shipChunk` passes `go test -race`; (e) a benchmark `BenchmarkEnqueue` shows no regression vs `main` (record both numbers in the PR; no lock added to `Enqueue`); (f) `QueueDepth == len(buffer) + pendingBatch`, where `pendingBatch` is an `atomic.Int32` the ship loop sets to the in-hand batch size while `shipBatch` runs and zeroes after (the loop drains the channel into a local slice, so `len(buffer)` alone reads ~0 during an outage; Codex/comment review).
- [ ] **Step 2:** `cd agent && go test -race ./internal/logging/...` → FAIL.
- [ ] **Step 3: Implement.** `lastAttemptUnixNano`, `lastSuccessUnixNano atomic.Int64`; `lastErr atomic.Pointer[string]`. Update only in `shipChunk` (≤ once per HTTP attempt, never in `Enqueue`): record **one terminal outcome per chunk**, after retries are exhausted (never per retry, never before `Do`, so a transient 503 that succeeds on retry never reads as failed): success → `ok`; exhausted network/429/5xx, 401, chunk-local 4xx, `resolveServerURL` failure, and marshal/gzip/request-build failures (these drop entries without a request) → `failed` with the matching sanitizer message. State is held in a single `atomic.Pointer[attemptRecord]` (immutable struct: time, ok, lastSuccessAt, err) so a snapshot can never tear (ok=true with a stale error). Store on 2xx also store the success time and clear the error; on each terminal failure site store `sanitizeShipError`. Nothing is recorded for an in-flight request, so a heartbeat landing mid-request reports the previous completed outcome. Sanitizer maps to a closed vocabulary: `http <status>`, `timeout`, `dns`, `connection refused`, `tls`, `auth rejected` (401), `url unresolved`, `other`; **never** embeds the raw `err.Error()`. No new goroutine, no mutex.
- [ ] **Step 4:** `go test -race ./internal/logging/...` PASS; `go vet ./...`. Commit.

### Task 6: `logShipping` in the heartbeat payload

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (struct at `:118`, populate at `:4932`)
- Test: `agent/internal/heartbeat/logship_payload_test.go` (new)

**Interfaces:**
- Consumes: `logging.LogShippingSnapshot()`.
- Produces: `HeartbeatPayload.LogShipping *LogShippingPayload \`json:"logShipping,omitempty"\`` with the wire shape above.

- [ ] **Step 1: Failing tests:** (a) shipper not initialized → `logShipping` key **absent** in marshalled JSON (unknown, not healthy); (b) initialized, no attempts → object present with `queueDepth:0,droppedLogs:0`, no timestamps (quiet); (c) failing snapshot → fields RFC3339 UTC, `lastError` ≤160; (d) top-level `droppedLogs` still emitted and equal to `logShipping.droppedLogs`; (e) payload size delta ≤ 400 bytes; (f) **new** tests (none exist today): `CommitDroppedLogCount` runs after a successful beat and not after a failed POST, and the nested `droppedLogs` is the pre-commit value in both cases.
- [ ] **Step 2:** `cd agent && go test -race ./internal/heartbeat/... -run LogShip` → FAIL. **Step 3:** implement. **Step 4:** `go test -race ./internal/heartbeat/... ./internal/logging/...` PASS. Commit.
- [ ] **Step 5: Compat proof (both directions).** Old-API direction: marshalled payload fed to the W1 pre-change zod snapshot (stripped, accepted), done in W1's schema test. New-API/old-agent direction: W1 route test 1.
- [ ] **Step 6 (manual lab check, owed to the pre-release sweep):** run a lab agent against a stack, block the log endpoint, observe `log_shipping_state='failing'` after the next beat and the W2 line after 30 min (or fake the clock in the API derive test instead; the agent has no such knob). Never run a lab agent on a host with the installed agent.

- [ ] **Step 7: Canary line.** In `handlers_logship.go` `handleSetLogLevel`, after a successful apply, emit one `log.Info("log shipping level raised", ...)` on both the persisted and the `!st.Persisted` paths. At a `debug`/`info` raise it deterministically ships, which is what W5 keys on; its test lives in `handlers_logship_test.go` (`-race`).

Helper processes run their own shippers; only the main agent's shipper is reported (stated in the PR and the line's tooltip copy).

---

## Wave 4: Fleet filter and count

### Task 7: "Log shipping failing" filter + summary count

**Files:**
- Modify: `apps/api/src/services/filterEngine.ts` (new computed field `logShippingFailing`, boolean-like enum `yes`/`no`; SQL: `status = 'online' AND log_shipping_failure_started_at IS NOT NULL AND log_shipping_failure_started_at <= NOW() - interval '30 minutes' AND log_shipping_state = 'failing'`)
- Modify: `apps/web/src/components/filters/filterFields.ts` (mirror entry) and locale keys (8)
- Modify: `apps/api/src/routes/devices/stats.ts` (`logShippingFailingCount` with `count(*) filter (...)`, same predicate)
- Modify: `apps/web/src/components/devices/DevicesPage.tsx` / saved-view preset list (search `SavedViewsMenu.tsx` for how presets are declared)
- Test: `apps/api/src/services/filterEngine.test.ts`, `apps/api/src/routes/devices/stats.test.ts`, `apps/web/src/components/devices/DevicesPage.test.tsx`

- [ ] **Step 1: Failing tests:** filter engine emits the predicate and uses the partial index (assert the SQL string contains `log_shipping_failure_started_at IS NOT NULL`); a new parity test that the server and web catalogs both list the field (none exists today; only the customFields tests touch the catalogs); stats returns `logShippingFailingCount` and excludes offline and sustained-`<30m` devices; web preset applies the filter via URL/hash state (hash, not query params, for transient UI state; follow `filterUrl.ts` for the persisted filter).
- [ ] **Step 2–4:** red, implement, green; `EXPLAIN` the predicate once on a populated stack and paste the plan into the PR (index must be used). Commit.
- Classify `logShippingFailing` in `filterEngine.ts` next to `SERVER_CONTROLLED_FILTER_FIELDS` / `EXECUTION_REFUSED_AGENT_FIELDS` (`:221`, `:238`): it derives from agent-reported data, so it must be refused as a script/automation targeting field (red test: targeting by it is rejected). Computed boolean-like enum support in `getColumnForField` (`:399`, today numeric-only) is part of the task; add the test for the `yes`/`no` operators first.
- **Note:** the SQL predicate duplicates `deriveLogShipping`; both import `LOG_SHIPPING_SUSTAINED_MS` and the filter test asserts they agree on a table of rows (Task 2's derive table reused).

---

## Wave 5: "Logs not arriving" after a level raise

### Task 8: Read-time check

**Files:**
- Create: `apps/api/src/services/logsNotArriving.ts` (+ `.test.ts`)
- Modify: the device detail route in `routes/devices/core.ts` to attach `logsNotArriving: { since: string } | null`; `DeviceInfoTab.tsx` renders a second conditional line; 8 locales
- Test: service test, route test, `DeviceInfoTab.test.tsx`

**Interfaces:**
- Produces: `async function logsNotArriving(deviceId: string, now: Date): Promise<{ raisedAt: string } | null>`.

- [ ] **Step 1: Failing tests:** (extra negatives: raise to `warn`/`error` → null; agent never reported `logShipping` → null; pre-#7416 result without `expiresAt` → null) returns non-null when the latest completed `device_commands` row for the device has `type = 'set_log_level'` (the stored type; `set_agent_log_level` is only the AI-tool name, `services/aiToolsAgentLogs.ts:355`), its `result.stdout` JSON (parse inline with `JSON.parse(result.stdout || '{}')` exactly as `aiToolsAgentLogs.ts:53-73` does; `storedCommandResult.ts` only builds results) has `appliedLevel` ∈ {`debug`,`info`} and `expiresAt > now`, `completedAt <= now - 5 min`, the device's stored `log_shipping_state` is non-NULL (agent has the W3 canary; old agents never warn), and **no `agent_logs` row with `created_at >= command.created_at`** (the command's creation/claim time, not `completedAt`: the canary ships before the API records completion, so comparing against `completedAt` would miss it and false-alarm; the 5-min wait still runs from `completedAt`) for the device; null when any such row exists, when the override expired, when the command failed, or when no command exists. Includes the throttle regression (Review Focus 7): `devices.last_log_at` older than `completedAt` but a fresh `agent_logs` row exists → null.
- [ ] **Step 2–4:** red, implement (one `LIMIT 1` query on `device_commands` by device + type + completion, one `EXISTS` on `agent_logs` using `agent_logs_device_created_at_idx`; executed only on device-detail load and only when an override is active, so no cost on list or heartbeat), green, typecheck. No schema change; relies on the W3 canary line, so it is silent for older agents rather than guessing. Commit.

---

## Wave 6 (optional, can be deferred): opt-in alert condition

### Task 9: Alert condition `log_shipping_failing`

**Files:**
- Create: `apps/api/src/services/alertConditions/handlers/logShippingFailing.ts` (+ test); register next to `handlers/offline.ts`
- Modify: the alert-rule condition schema/UI wherever `offline` is enumerated (grep `handlers/offline` consumers)

- [ ] Off by default: no seeded rule, no default policy change. The condition lives inside the existing config-policy alert rule shape, which is already dual-owned (org XOR partner); **no new config table**, so the epic #2135 partner-wide-first playbook is satisfied by reuse and the PR states it. If the implementer finds the condition needs a new table, stop and apply the playbook in `docs/agents/tenancy-rls.md` instead.
- [ ] Red tests: handler fires only for `failing` derived state on online devices, dedupes per episode (`failure_started_at` as the episode key), resolves on recovery, never fires for `unknown`. Run `cd apps/api && npx vitest run src/services/alertConditions`. Commit.

---

## Self-review

- **Spec coverage:** (1) Tasks 5–6; (2) Tasks 1–3; (3) Task 4; (4) Task 7; (5) Task 9; (6) Task 8. "Unknown shows nothing / never infer from absence of logs": Tasks 2, 4. No pill: Task 4 test.
- **Placeholders:** the two spots that depend on code not yet read are flagged as explicit verification steps (where `offline` is enumerated in Task 9; the queue threshold (400, from `defaultBufferSize = 500`)), each with a stated fallback.
- **Type consistency:** `LogShippingReport`, `LogShippingStoredState`, `DerivedLogShipping`, `HealthSnapshot` are defined once and reused by name.

## Open Decisions

1. **Devices columns vs device-scoped table.** Options: (a) three nullable columns on `devices` + partial index; (b) new device-scoped table (shape 5). **Recommend (a)**: 1:1 scalar facts, matches `helperInstallIssue`, avoids a new tenancy/cascade/merge/export registration surface; revisit only if history is wanted.
2. **Heartbeat write-amplification strategy.** Options: (a) write on transition only, compared to the loaded `device` row; (b) coarse interval refresh; (c) every beat. **Recommend (a)**: the beat already does one UPDATE, so (a) adds zero statements and zero keys in the steady state; the compared row is the beat's own uncached full-row read (`heartbeat.ts:695`).
3. **Feature-detect via payload presence vs `securityCapabilities` version.** **Recommend presence** (+ in-object `schemaVersion`): read-only telemetry gates nothing, so a version int is a second source of truth.
4. **What counts as failing.** Options: (a) last attempt unsuccessful OR `droppedLogs>0` (per-beat delta) OR `queueDepth >= 400` absolute; (b) also queue-growth across beats. **Recommend (a)**: stateless per beat; growth needs previous-beat memory the API deliberately does not keep. Threshold 400 (80% of the 500-entry buffer) and the 30-min window are tunable constants. Dropped-log *delta* (not cumulative) is used because the agent zeroes it after each successful beat.
5. **`lastError` storage, scrubbing, export.** **Recommend**: agent maps to a closed vocabulary (never raw `err.Error()`), ≤160 chars; API caps at 200; stored as `varchar(200)`; export policy `excludedSensitive` (transient diagnostics, no restore value, can reveal endpoint shape). Alternative: `included`. Unresolved risk accepted: a closed vocabulary loses detail an operator may want; revisit after dogfood.
6. **Offline devices.** Options: (a) derive `unknown` when status ≠ online, no server-side gap rule, agent expires stale failure after 10 min; (b) show last known state; (c) agent reports its own episode age. **Recommend (a)**: status/`lastSeenAt` cannot prove a gap (WS writers set `online` first); the agent-side expiry is the only reliable continuity signal. Known limit: an episode spanning an outage is reported from the first failing beat; (c) fixes that at the cost of a wider wire shape.
7. **Does the fleet filter ship with the detail line?** Options: (a) same wave; (b) separate wave after the agent ships. **Recommend (b)**: it edits mirrored server/web filter catalogs and stats (own review surface) and has no data to show until W3.
8. **Opt-in alert condition now vs deferred.** **Recommend deferred (W6 optional)**: observe real failing rates from the filter first; alert-on-telemetry before tuning risks noisy, always-on alerts.
9. **Wave cut and ordering.** Options: (a) server-first dormant (W1 → W2 → W3); (b) agent-first. **Recommend (a)** per the issue: the API can be verified with synthetic beats, and shipping the agent first emits telemetry nothing stores. Cost: W1/W2 merge with no visible effect.
10. **Top-level `droppedLogs` after nesting.** Options: keep both for one release vs remove now. **Recommend keep both**, remove in a follow-up: it is unread today so removal is safe, but keeping it makes rollback of the agent or API painless and costs ~20 bytes/beat.
11. **"Logs not arriving" signal.** Options: (a) `agent_logs` EXISTS since command completion; (b) `devices.last_log_at`. **Recommend (a)** plus the W3 canary line (otherwise a quiet agent at a raised level may legitimately ship nothing): `last_log_at` is throttled to 5-min drift and false-alarms inside the window.
12. **Helper-process shippers.** Only the main agent's shipper is reported. Recommend leaving helpers out for now (they do not own device-level shipping health); revisit if helper log loss shows up in support.
13. **Unresolved after Codex quorum: canary line vs silent W5.** Codex flagged that a quiet agent at a raised level may legitimately ship nothing. This plan adds a one-line `Info` canary to `handleSetLogLevel` (W3 Step 7) and restricts the check to debug/info raises on agents that report `logShipping`. Alternative: drop the 5-minute check entirely. **Recommend the canary**; Todd to confirm an extra info line per raise is acceptable.
