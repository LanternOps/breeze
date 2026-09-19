---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (register after Gate B)
branch: feature/<parent>-ai-sweeps-act-mode/wave-<sub-issue>
---

# AI sweeps act mode — W03: `expiring_certs` evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the seventh sweep kind a real evidence source — promote the TLS certificate the Go agent already observes on every HTTPS `http_check` out of the unread `network_monitor_results.details` blob into five typed columns on `network_monitors`, and add `expiring_certs` to the sweep catalog as a **finding-only** kind.

**Architecture:** The Go `http_check` handler gains issuer, observed host and an explicit TLS state alongside the `sslExpiry` it already emits — `agentWs.ts` casts the whole agent result map into `details` (`:1242-1250`) so new keys arrive server-side with zero API change. `recordMonitorCheckResult` (`jobs/monitorWorker.ts:478-548`) is the single chokepoint: it already writes `lastStatus`/`lastResponseMs` back onto `network_monitors` in the same transaction as the results insert, and the five `tls_*` columns join that `updateSet`. `routes/monitors.ts`'s `PATCH /:id` (`:597-600`) invalidates the observation when `target` or `config` changes, so a result in flight under the old configuration can never be attributed to the new one. `loadExpiringCerts` in `sweepEvidence.ts` is then a plain org-pinned `SELECT` in the established `COUNT(*) OVER () … LIMIT MAX+1` shape.

**Tech Stack:** Go 1.x (`agent/internal/heartbeat`), Hono, Drizzle ORM, PostgreSQL 16, zod in `packages/shared`, React + i18next across 8 locales, Vitest, `go test -race`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-sweeps-act-mode-and-evidence-design.md` §4 (all of it), OD-6 A. Gate A approved.

**Tracking:** issue #4230. Hub: `docs/superpowers/plans/ai-mcp/2026-09-13-ai-sweeps-act-mode.md`. **Independent of W01, W02, W04 and W05** — it can be built and merged in parallel with any of them.

## Ordering assumptions (read first)

Monitors W04 (`docs/superpowers/plans/monitoring/2026-09-13-monitoring-automation-unification-04-coverage.md`, branch `origin/plan/5291-monitors-w04-coverage`, migration `2026-10-16-180900-monitor-coverage-kinds.sql`) **retenants `network_monitors` to `org_id` XOR `partner_id`**: it drops `org_id NOT NULL`, adds `partner_id` + `managed_by_monitor_id` + `network_monitors_one_owner_chk`, replaces `network_monitors_isolation` with a dual-axis policy, adds an additive `FOR SELECT` partner-wide branch, and converts `network_monitor_results` to RLS shape 1 with its own `org_id`/`device_id`.

**This wave is correct in either merge order, because it changes no ownership, no nullability and no policy** — it only adds five plain columns and reads them. Three consequences, all deliberate:

1. **The sweep loader pins `nm.org_id = $1` and nothing else.** After monitors W04 a partner-wide network monitor has `org_id IS NULL` and is invisible to that predicate. That is the correct v1 behaviour, not an oversight: spec §2 scopes certificate evidence to org-owned monitors in v1, and referencing `nm.partner_id` from a migration that may replay *before* monitors W04 would be a hard `42703`. Task 6 files the one-line follow-up.
2. Both waves edit the `network_monitors` entry in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts:370`). Whichever merges second rebases and re-runs **Integration Tests** — the export-policy suites do not run in `pnpm test`.
3. Slot `181510` sorts after monitors W04's `180900`, so on a fresh database our `ALTER TABLE … ADD COLUMN` runs against the already-retenanted table. `ADD COLUMN IF NOT EXISTS` on a nullable-`org_id` table is identical either way.

## Spec corrections that bind this wave (verified on `origin/main`)

- **`tls_observed_host` and `tls_issuer` are not already collected.** `agent/internal/heartbeat/handlers_monitor.go:270-275` emits exactly `sslExpiry` and `sslDaysRemaining`; the handler's full key set is `monitorId, status, responseMs, statusCode, bodyMatch?, error?, sslExpiry?, sslDaysRemaining?` (`:234-275`). `resp.Request.URL` is never read and there is no `finalURL` anywhere in the file. So the agent change is ~10 lines, not ~2, and **the observed host cannot be recovered from historical `details` rows** — every pre-deploy row stays `tls_state = 'unknown'`.
- **`tls_state` must come from the agent.** A transport error returns at `:221` and an invalid-request error at `:210`, both emitting only `monitorId/status/responseMs/error` — the API cannot tell "the endpoint is plain HTTP" from "the handshake failed" from "the check never ran". Deriving it server-side would guess.
- **Redirects are followed by Go's default policy** (`:202-206` only *disables* them when `followRedirects: false`), so `resp` — and therefore the certificate — belongs to the **final** hop. This is exactly why `tls_observed_host` is mandatory: a monitor on `a.example` can legitimately report `b.example`'s certificate, and a finding that omits the host lies.
- **`tcp_port` does no TLS handshake at all** (`:133` is a bare `net.DialTimeout`), so a `tcp_port` monitor on 443 observes nothing. Widening it is an explicit opt-in flag in a later increment (spec §4.2, deferred) and is **out of scope here** — changing a TCP check's contract implicitly would alter every existing monitor's behaviour.
- `network_monitor_results.details` passes through `redactSecretsDeep` before the insert (`monitorWorker.ts:488-495`). The new TLS keys are hostnames, issuer DNs and timestamps — nothing that should trip a redactor, but Task 3 asserts a real issuer string survives it rather than assuming.

## Global Constraints

- Migration filename `apps/api/migrations/2026-10-16-181510-network-monitor-tls-observation.sql`, inside this cluster's reserved `1815xx` block. Re-check `ls apps/api/migrations | sort | tail -1` against `origin/main` before pushing; bump upward only; never rename for today's date.
- **Pure DDL, no DML.** `tls_state` is nullable with no default and no backfill: a NULL means "never observed under the current code", which is honest. Do not `SET DEFAULT 'unknown'` and do not backfill from `network_monitor_results.details` — the historical rows have no observed host and no state, and a synthesised `observed` would be a fabricated finding.
- **`expiring_certs` is finding-only.** `SweepProposedAction` is a closed two-member union (`packages/shared/src/types/aiAgentSchedules.ts`) and there is no safe automated certificate renewal, so this kind proposes nothing and is act-mode-irrelevant by construction. Do **not** register a probe for it in `sweepSubjectProbe.ts` (W02) — `isActEligibleSweepKind('expiring_certs')` must stay false.
- The seventh kind touches **five** places that are easy to miss, all in Task 4: `AI_SWEEP_KINDS`, the `ai_agent_schedules_kinds_chk` CHECK, the `.max(6)` in `packages/shared/src/validators/aiAgentSchedules.ts:168`, the `ai_agent_fix_watches_subject_kind_chk` CHECK **if W02 has merged**, and two separate locale blocks × 8 files.
- `LOADERS` in `sweepEvidence.ts:455` is `Record<AiSweepKind, …>` — exhaustive over the enum, so adding the kind is a **compile error until the loader is written**. That is the design; do not weaken the type to `Partial`.
- Registration lists: no new tables (`network_monitors` is already at `tenantCascade.ts:545`). Five new `included` columns in `CORE_TENANT_EXPORT_POLICY` (`:370`).
- Every task: red test first, then typecheck (`pnpm --filter @breeze/api exec tsc --noEmit`, `pnpm --filter @breeze/shared exec tsc --noEmit`, `cd agent && go build ./...`), targeted tests, one commit.

---

### Task 1: Agent — emit issuer, observed host and TLS state

**Files:**
- Modify: `agent/internal/heartbeat/handlers_monitor.go` (`handleNetworkHttpCheck`, the TLS block at `:270-275` and the two early-exit paths at `:210`, `:223`)
- Create: `agent/internal/heartbeat/handlers_monitor_tls_test.go`

**Interfaces produced:** three new result-map keys on `http_check` — `sslIssuer string`, `sslObservedHost string`, `sslState string` (`observed` | `handshake_failed` | `not_tls`). `sslExpiry` and `sslDaysRemaining` are unchanged.

- [ ] **Step 1 (RED): write the failing Go test.** Table-driven against `httptest` servers, per the repo's Go convention:

```go
func TestHandleNetworkHttpCheck_TLSObservation(t *testing.T) {
    // 1. httptest.NewTLSServer -> sslState "observed", sslIssuer non-empty,
    //    sslObservedHost == the server's host, sslExpiry parses as RFC3339.
    // 2. httptest.NewServer (plain HTTP) -> sslState "not_tls", no sslExpiry,
    //    no sslIssuer, and sslObservedHost still set to the requested host.
    // 3. an https:// URL whose handshake fails with verifySsl=true ->
    //    sslState "handshake_failed", status "offline", no cert fields.
    // 4. a redirect from server A (TLS) to server B (TLS) with followRedirects
    //    true -> sslObservedHost == B's host, NOT A's. This is the case the
    //    column exists for.
}
```

- [ ] **Step 2: run to verify it fails.** `cd agent && go test -race ./internal/heartbeat/ -run TestHandleNetworkHttpCheck_TLSObservation`.

- [ ] **Step 3: implement.** Replace the TLS block and add state to the two early exits:

```go
	// Certificate observation (#4230). The certificate belongs to the FINAL
	// response, which after a redirect is a different endpoint than the
	// monitor's target — so the host is recorded alongside the expiry, or the
	// finding would name the wrong endpoint. `sslState` is emitted explicitly
	// because a handshake failure returns before we ever get here, and the
	// server cannot distinguish "plain HTTP" from "handshake failed" from
	// "the check never ran" by the absence of a field.
	if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
		cert := resp.TLS.PeerCertificates[0]
		result["sslExpiry"] = cert.NotAfter.Format(time.RFC3339)
		result["sslDaysRemaining"] = int(time.Until(cert.NotAfter).Hours() / 24)
		result["sslIssuer"] = cert.Issuer.String()
		result["sslState"] = "observed"
	} else {
		result["sslState"] = "not_tls"
	}
	if resp.Request != nil && resp.Request.URL != nil {
		result["sslObservedHost"] = resp.Request.URL.Host
	}
```

On the `client.Do` error path (`:221-229`), add `"sslState": "handshake_failed"` **only when the request URL scheme is `https`** — a TCP-level failure against an `http://` target is not a handshake failure. Truncate `sslIssuer` and `sslObservedHost` to 255 bytes agent-side so the `varchar(255)` columns can never reject a writeback; a truncated issuer is a display string and a lossy one is better than a dropped observation.

- [ ] **Step 4: run + build, commit**

```bash
cd agent && go test -race ./internal/heartbeat/... && go build ./... && gofmt -l internal/heartbeat
git commit -m "feat(agent): emit TLS issuer, observed host and state from http_check (#4230)"
```

---

### Task 2: Migration — five typed TLS columns + export-policy registration

**Files:**
- Create: `apps/api/migrations/2026-10-16-181510-network-monitor-tls-observation.sql`
- Modify: `apps/api/src/db/schema/monitors.ts` (`networkMonitors`, `:9-31`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`network_monitors` entry at `:370`)
- Test: `apps/api/src/db/autoMigrate.test.ts`, `apps/api/src/db/migrationRlsScope.test.ts`, `apps/api/src/services/tenantExportPolicyRegistry.tls.test.ts` (create)

**Interfaces produced:** `network_monitors.tls_not_after timestamptz`, `.tls_observed_host varchar(255)`, `.tls_issuer varchar(255)`, `.tls_observed_at timestamptz`, `.tls_state varchar(16)`; CHECK `network_monitors_tls_state_chk`; index `network_monitors_tls_expiry_idx`.

- [ ] **Step 1: write the migration**

```sql
-- Certificate observation for the expiring_certs sweep kind (#4230) — spec §4.2.
-- Promotes the value the Go agent already collects out of the untyped
-- network_monitor_results.details blob (which nothing in the repo reads) into
-- typed columns written beside the existing lastStatus/lastResponseMs
-- writeback in recordMonitorCheckResult.
--
-- NO DML and no DEFAULT on tls_state: historical rows have no observed host
-- and no state, and synthesising `observed` for them would fabricate findings.
-- NULL means "never observed under the current agent", which is honest.
--
-- Deliberately NOT dependent on monitors W04 (2026-10-16-180900): this file
-- adds plain columns only and changes no ownership, nullability or policy, so
-- it is correct whether or not network_monitors has been retenanted yet.

ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_not_after     timestamptz;
-- THE endpoint the certificate actually belongs to. Redirects are followed by
-- default, so a monitor on a.example can report b.example's certificate; a
-- finding that omits this lies about which endpoint is expiring.
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_observed_host varchar(255);
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_issuer        varchar(255);
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_observed_at   timestamptz;
-- A TLS failure returns BEFORE certificate extraction, so a null tls_not_after
-- must never read as "fine". Three states, emitted by the agent, never derived.
ALTER TABLE network_monitors ADD COLUMN IF NOT EXISTS tls_state         varchar(16);

ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_tls_state_chk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_tls_state_chk
  CHECK (tls_state IS NULL OR tls_state IN ('observed', 'handshake_failed', 'not_tls'));

-- An observation is only meaningful with a time and a host attached.
ALTER TABLE network_monitors DROP CONSTRAINT IF EXISTS network_monitors_tls_observed_shape_chk;
ALTER TABLE network_monitors ADD CONSTRAINT network_monitors_tls_observed_shape_chk
  CHECK (tls_state IS DISTINCT FROM 'observed'
         OR (tls_not_after IS NOT NULL AND tls_observed_at IS NOT NULL AND tls_observed_host IS NOT NULL));

-- Serves loadExpiringCerts' ORDER BY tls_not_after ASC under its own predicate.
CREATE INDEX IF NOT EXISTS network_monitors_tls_expiry_idx
  ON network_monitors (org_id, tls_not_after)
  WHERE tls_state = 'observed' AND is_active = true;
```

- [ ] **Step 2 (RED): the export-policy unit guard.** Same pattern as W01 Task 3 — a `tenantExportPolicyRegistry.tls.test.ts` asserting all five columns are `included` on `network_monitors`, so the miss reds in **Test API** rather than only in Integration Tests. Run it, watch it fail with five undefined classifications.

- [ ] **Step 3: implement.** Add the five Drizzle columns to `networkMonitors` with the docstrings above, and append `"tls_not_after"`, `"tls_observed_host"`, `"tls_issuer"`, `"tls_observed_at"`, `"tls_state"` to the `included` array at `tenantExportPolicyRegistry.ts:370`. All five are scalars; `config` stays `excludedOpen`.

- [ ] **Step 4: apply and verify**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
cd apps/api && npx vitest run src/services/tenantExportPolicyRegistry.tls.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
git commit -m "feat(db): typed TLS observation columns on network_monitors (#4230)"
```

---

### Task 3: Writeback + lifecycle invalidation

**Files:**
- Modify: `apps/api/src/jobs/monitorWorker.ts` (`MonitorCheckResult` at `:54-62`, `recordMonitorCheckResult`'s `updateSet` at `:514-533`)
- Modify: `apps/api/src/routes/monitors.ts` (`PATCH /:id` write at `:597-600`)
- Test: `apps/api/src/jobs/monitorWorker.tls.test.ts` (create), `apps/api/src/routes/monitors.test.ts` (existing)

**Interfaces:**
- Produces: `export function readTlsObservation(details: Record<string, unknown> | undefined): TlsObservation | null` in `monitorWorker.ts` (or a small `services/monitors/tlsObservation.ts` if the worker is already long) — the pure, tested parser from the agent's untyped map to the five typed values.

- [ ] **Step 1 (RED): failing tests**

```ts
// monitorWorker.tls.test.ts
it('writes tls_not_after/host/issuer/state/observed_at back onto network_monitors from an observed result', …);
it('writes tls_state handshake_failed with NULL cert fields, so a null expiry never reads as fine', …);
it('leaves the previous observation untouched when a result carries no ssl* keys at all (an icmp/dns monitor)', …);
it('ignores an unparseable sslExpiry rather than writing an invalid date', …);
it('survives redactSecretsDeep — a real issuer DN reaches the column intact', async () => {
  // The redactor runs on `details` before the insert (monitorWorker.ts:488-495);
  // assert on the value that actually lands, not on the input.
});

// monitors.test.ts
it('PATCH /monitors/:id clears every tls_* column when `target` changes', …);
it('PATCH /monitors/:id clears every tls_* column when `config` changes', …);
it('PATCH /monitors/:id leaves the observation alone when only `name` changes', …);
```

- [ ] **Step 2: run to verify they fail.**

- [ ] **Step 3: implement the writeback.** `recordMonitorCheckResult` already opens one transaction that inserts the result row and updates the monitor (`:503-533`) — join that same `updateSet`, never a second statement:

```ts
  const tls = readTlsObservation(result.details);
  if (tls) {
    updateSet.tlsState = tls.state;
    updateSet.tlsObservedAt = now;
    updateSet.tlsObservedHost = tls.observedHost ?? null;
    updateSet.tlsNotAfter = tls.state === 'observed' ? tls.notAfter : null;
    updateSet.tlsIssuer   = tls.state === 'observed' ? tls.issuer   : null;
  }
```

`readTlsObservation` returns `null` when the map has no `sslState` key at all, so an `icmp_ping`/`dns_check`/`tcp_port` result never clobbers a good observation from a sibling HTTP monitor. A `handshake_failed` result **does** write — it clears `tls_not_after` and records the state, which is the entire point of the `tls_state` column.

- [ ] **Step 4: implement the invalidation.** `PATCH /:id` currently blind-spreads `...payload` (`:597-600`). Read the existing row first (the handler already needs it for the per-type config validation at `:580-596`) and null the five columns when the identity of the thing being observed changes:

```ts
  // #4230: a result already in flight was produced under the OLD target/config.
  // The worker overwrites monitor state unconditionally, so without this an
  // arriving result would be attributed to the new configuration.
  const targetChanged = payload.target !== undefined && payload.target !== existing.target;
  const configChanged = payload.config !== undefined
    && JSON.stringify(payload.config) !== JSON.stringify(existing.config);
  const tlsReset = (targetChanged || configChanged)
    ? { tlsState: null, tlsNotAfter: null, tlsIssuer: null, tlsObservedHost: null, tlsObservedAt: null }
    : {};
  const [updated] = await db.update(networkMonitors)
    .set({ ...payload, ...tlsReset, updatedAt: new Date() })
    .where(eq(networkMonitors.id, monitorId)).returning();
```

Also exclude inactive monitors at read time rather than clearing on `isActive: false` — the loader's `is_active = true` predicate (Task 5) covers that, and clearing would lose the last known expiry from the UI.

- [ ] **Step 5: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/jobs/monitorWorker src/routes/monitors
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(monitors): persist TLS observations and invalidate them on target/config change (#4230)"
```

---

### Task 4: The seventh sweep kind — enum, CHECK, `.max(7)`, locales

**Files:**
- Modify: `packages/shared/src/types/aiAgentSchedules.ts` (`AI_SWEEP_KINDS`, `:20-27`)
- Modify: `packages/shared/src/validators/aiAgentSchedules.ts` (`:168`, `.max(6)` → `.max(7)`)
- Modify: `apps/api/migrations/2026-10-16-181510-network-monitor-tls-observation.sql` (append the CHECK replacement — same file, do **not** create a second migration)
- Modify: `apps/api/src/services/aiAgents/sweepSubjectProbe.ts` **only if W02 has merged** — no probe entry, just confirm `isActEligibleSweepKind('expiring_certs') === false`
- Modify: `apps/web/src/locales/{en,pt-BR,es-419,fr-FR,fr-CA,de-DE,it-IT,tr-TR}/settings.json` (two blocks: `aiAgentsPage.schedules.kindLabels`, en `:1534-1541`; and `aiAgentsPage.runs.sweep.kinds`, en `:1854-1861`)
- Test: `packages/shared/src/validators/aiAgentSchedules.test.ts` (existing), `apps/web/src/lib/i18n/localeParity.test.ts` + `translationCoverage.test.ts` (existing)

- [ ] **Step 1 (RED): failing validator test**

```ts
it('accepts all seven sweep kinds on a partner baseline', () => {
  expect(createAiAgentScheduleSchema.safeParse({ …, sweepKinds: [...AI_SWEEP_KINDS] }).success).toBe(true);
});
it('the sweepKinds cap equals AI_SWEEP_KINDS.length — a hardcoded number that drifts is the bug', () => {
  const tooMany = [...AI_SWEEP_KINDS, AI_SWEEP_KINDS[0]];
  expect(createAiAgentScheduleSchema.safeParse({ …, sweepKinds: tooMany }).success).toBe(false);
});
```

- [ ] **Step 2: run to verify it fails.** `cd packages/shared && npx vitest run src/validators/aiAgentSchedules.test.ts` — the first case fails on `.max(6)`.

- [ ] **Step 3: implement the enum + cap + CHECK.**

Add `'expiring_certs'` to `AI_SWEEP_KINDS` with a docstring replacing the current *"`expiring_certs` was considered and deferred"* note: it now has a data path (`network_monitors.tls_*`), and it is **finding-only** — `SweepProposedAction` is a closed union and there is no safe automated renewal.

Change `.max(6)` to `.max(7)` at `validators/aiAgentSchedules.ts:168` and update the comment. Consider `.max(AI_SWEEP_KINDS.length)` instead so the next kind cannot forget — do it if the enum is already imported in that file; a literal that must be hand-bumped is precisely what this step exists to catch.

Append to the W03 migration:

```sql
-- 2. expiring_certs joins the sweep catalog now that it has an evidence source.
--    Mirrors AI_SWEEP_KINDS; aiAgentSchedulesPartnerRls.integration.test.ts
--    asserts the two value sets are equal in BOTH directions.
ALTER TABLE ai_agent_schedules DROP CONSTRAINT IF EXISTS ai_agent_schedules_kinds_chk;
ALTER TABLE ai_agent_schedules ADD CONSTRAINT ai_agent_schedules_kinds_chk CHECK (
  sweep_kinds <@ ARRAY['disk_pressure','stale_agents','pending_reboots',
                       'failed_backups','service_down','unpatched_critical',
                       'expiring_certs']::text[]
);
```

**If W02 has already merged**, also replace `ai_agent_fix_watches_subject_kind_chk` here with the same seven values — W02 Task 6's parser test asserts that set equals `AI_SWEEP_KINDS` and will red otherwise. If W02 has not merged, W02's own migration must be written with seven values instead; note the dependency in the PR body either way.

- [ ] **Step 4: 8 locales × 2 blocks.** Add `expiring_certs` to `aiAgentsPage.schedules.kindLabels` and `aiAgentsPage.runs.sweep.kinds` in all eight `settings.json` files. Real translations, not English copies — `translationCoverage.test.ts` caps exact-English duplicates per namespace. Suggested en value: `"Expiring certificates"`.

- [ ] **Step 5: run everything, commit**

```bash
cd packages/shared && npx vitest run src/validators/aiAgentSchedules.test.ts && cd -
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts && cd -
pnpm --filter @breeze/shared exec tsc --noEmit
git commit -m "feat(ai): expiring_certs joins AI_SWEEP_KINDS (enum, CHECK, cap, 8 locales) (#4230)"
```

Expect `apps/api` to **fail typecheck** at this point: `LOADERS` in `sweepEvidence.ts:455` is exhaustive over the enum. That is the design. Task 5 fixes it.

---

### Task 5: `loadExpiringCerts`

**Files:**
- Modify: `apps/api/src/services/aiAgents/sweepEvidence.ts` (a new loader + its `LOADERS` entry at `:455`)
- Test: `apps/api/src/services/aiAgents/sweepEvidence.test.ts` (existing)

**Interfaces:** `async function loadExpiringCerts(orgId: string): Promise<LoadedKind>` — same shape as the six siblings; rows carry `fields: { monitorName, target, observedHost, notAfter, daysRemaining, issuer, observedAt }` and `deviceId: null`.

- [ ] **Step 1 (RED): failing tests**

```ts
it('emits one row per expiring monitor, soonest first, with the OBSERVED host not the target', …);
it('excludes inactive monitors', …);
it('excludes observations older than the staleness bound (7 days)', …);
it('excludes tls_state handshake_failed and not_tls — a null expiry is not "fine"', …);
it('reports the real COUNT(*) OVER () total, not rows.length, when the org exceeds the cap', …);
it('sets deviceId null — a public endpoint certificate belongs to no device', …);
```

- [ ] **Step 2: run to verify it fails.** `cd apps/api && npx vitest run src/services/aiAgents/sweepEvidence.test.ts`.

- [ ] **Step 3: implement**, in the established shape (`COUNT(*) OVER ()`, `LIMIT FETCH_LIMIT` = MAX+1, most-important-first so the tail trim drops the least important row):

```sql
SELECT nm.id AS monitor_id, nm.name AS monitor_name, nm.target,
       nm.tls_observed_host, nm.tls_not_after, nm.tls_issuer, nm.tls_observed_at,
       COUNT(*) OVER () AS total_count
FROM network_monitors nm
WHERE nm.org_id = $1
  AND nm.is_active = true
  AND nm.tls_state = 'observed'
  AND nm.tls_observed_at > now() - interval '7 days'
  AND nm.tls_not_after <= now() + interval '45 days'
ORDER BY nm.tls_not_after ASC
LIMIT $2
```

Three things the module's own header already demands and this loader must honour: **display scalars only** (never `nm.config`, which is jsonb and `excludedOpen`), **org pinned on every side** (`network_monitors` has no join here, so the single predicate is the whole isolation boundary), and `deviceId: null` — the finding is about an endpoint, and `sweepFindings.ts`'s gate 1 (`device_not_in_evidence`) then refuses any proposal naming a device, which is exactly the fail-closed behaviour a finding-only kind wants.

Add a note in the loader's comment: partner-wide `network_monitors` rows (`org_id IS NULL`, after monitors W04) are **not** reached by this predicate in v1 — see Task 6.

- [ ] **Step 4: run + tsc, commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/sweepEvidence
pnpm --filter @breeze/api exec tsc --noEmit
git commit -m "feat(ai): expiring_certs sweep evidence loader over observed TLS columns (#4230)"
```

---

### Task 6: Live-DB suites, the follow-up issue, PR

- [ ] **Step 1: add the kinds-equality case to the partner-RLS suite.** `apps/api/src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts:455-478` already parses `ai_agent_schedules_kinds_chk` out of `pg_constraint` and asserts set equality with `AI_SWEEP_KINDS` in both directions — it will fail on the seventh kind until the migration lands, which is the contract working. Add one explicit acceptance case beside it: a partner baseline whose `sweep_kinds` includes `'expiring_certs'` inserts cleanly; the same array plus a bogus value raises 23514.

- [ ] **Step 2: run every live-DB suite this wave can redden**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenant-export-policy.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/rls-coverage.integration.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts
pnpm --filter @breeze/api test --run
pnpm --filter @breeze/shared test --run
pnpm --filter @breeze/web test --run
cd agent && go test -race ./... && cd -
pnpm test-stack down
```

- [ ] **Step 3: file the two deferred follow-ups** (`gh issue create`, label `category:ai`):
  1. *"`expiring_certs`: reach partner-wide `network_monitors` rows"* — after monitors W04 lands, widen `loadExpiringCerts`' predicate to `nm.org_id = $1 OR (nm.org_id IS NULL AND nm.partner_id = <the org's partner>)`. One line plus a test; deliberately not done here so this migration never references a column monitors W04 may not have added yet.
  2. *"TLS handshake on `tcp_port` monitors behind an explicit opt-in"* — spec §4.2 deferred increment. Note that `handleNetworkTcpCheck` (`handlers_monitor.go:118-170`) does a bare `net.DialTimeout` today and changing that implicitly would alter existing monitors' behaviour.

- [ ] **Step 4: open the PR.** Body must state: the agent emits three new keys and therefore historical rows can never be backfilled (no observed host exists for them); `tls_state` comes from the agent, not derived; `expiring_certs` is finding-only and has no probe; the five easy-to-miss registration points from the Global Constraints; the `network_monitors` export-policy overlap with monitors W04; and the two follow-up issue numbers. `Closes #4230` and `Closes #<wave sub-issue>`. If stacked, `gh workflow run CI --ref <branch>`.
