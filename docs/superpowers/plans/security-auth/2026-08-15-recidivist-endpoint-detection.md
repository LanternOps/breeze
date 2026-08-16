# Recidivist-endpoint detection — implementation plan

**Spec (binding authority):** `docs/superpowers/specs/security-auth/2026-08-14-recidivist-endpoint-detection-design.md`
**Branch:** `ToddHebebrand/recidivist-endpoint` (off main `835f7eb3d`)

## Global Constraints

- **Signal key:** `rmm.recidivist_endpoint`. New table: `abuse_endpoint_fingerprints`. New enum: `abuse_endpoint_fingerprint_kind` with values `'remote_tool_guid' | 'hostname' | 'egress_ip'`.
- **Config keys and defaults** (added to `SIGNAL_DEFAULTS` in `apps/api/src/services/abuseSignals/config.ts`):
  - `'rmm.recidivist_endpoint.fingerprint_score': 100`
  - `'rmm.recidivist_endpoint.hostname_ip_score': 90`
  - `'rmm.recidivist_endpoint.hostname_score': 60`
  - `'rmm.recidivist_endpoint.ip_score': 40`
- **Score = max of matched axes, never sum.** A partner matching fingerprint + hostname + ip scores 100, not 190.
- **No age decay.** Follow the `computeScriptSignals` precedent: the scorer takes no partner age and no clock. Add a comment stating why (a re-established aged account is more suspicious, not less).
- **Direction rule:** a signal fires ONLY on a partner whose status is `'active'` or `'pending'`, matched against corpus rows from a DIFFERENT partner whose status is NOT `'active'` (suspended/churned/etc.). Suspended↔suspended pairs produce no signal. Same-partner matches never fire.
- **Extraction is ScreenConnect-only in v1:** pattern `/ScreenConnect Client \((\p{Hex_Digit}{16})\)/` — concretely `/ScreenConnect Client \(([0-9a-f]{16})\)/` against `software_inventory.name`. Do NOT ship the LogMeIn pattern (spec: unbacktested patterns don't ship at score 100).
- **Hostname deny-list** (never recorded in the corpus as `hostname` rows): empty/blank, `localhost`, and any hostname starting `WIN-` shorter than 12 characters total.
- **`egress_ip` corpus rows are recorded** (from `devices.last_seen_ip`, falling back to `devices.enrollment_ip`) but NEVER produce a signal alone — the `ip` axis only exists to upgrade `hostname` (60) to `hostname_ip` (90). An ip-only match produces no ComputedSignal in v1 (the 40 default is reserved; do not emit at it).
- **Retention: indefinite, deliberately** — record that decision in the migration header comment.
- **RLS: forced, system-only policy**, byte-for-byte pattern of `2026-07-25-abuse-script-hosts.sql` (`current_setting('breeze.scope', true) = 'system'`, `pg_policies` existence guard). All access via the sweep's existing system DB context.
- **Migration filename must sort AFTER `2026-08-22-device-script-secret-env-capability.sql`** — use `2026-08-23-abuse-endpoint-fingerprints.sql`. Idempotent throughout (`IF NOT EXISTS` / `DO $$ ... duplicate_object`), no inner `BEGIN;`/`COMMIT;`.
- **Registration ruling (supersedes spec checklist item 4):** the table registers in `DEVICE_DETACH_DEVICE_ID_TABLES` (`apps/api/src/routes/devices/core.ts`), NOT `CORE_DEVICE_CASCADE_DELETE_TABLES`. The FK is `device_id ... ON DELETE SET NULL` and the spec's storage rationale requires corpus rows to survive device deletion; cascade-deleting them would destroy exactly the history the detector depends on. Follow whatever handling the device hard-delete route applies to the existing detach tables (`support_sessions`, `tickets`) so `cascadeDelete.test.ts` passes.
- **rls-coverage registration:** add `abuse_endpoint_fingerprints` to BOTH allowlists in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` where `abuse_script_hosts` appears (~lines 57–58 and ~91–92), with a comment in the same style (system-only, operator corpus, partners must never read it).
- No `org_id` column → no org-cascade or export-policy registration required.
- Tests live alongside sources. Match existing file idioms exactly (`heuristics.test.ts`, `scriptContent.ts` loader style with raw `db.execute` SQL, `sweep.test.ts` mock style).
- Run `pnpm --filter @breeze/api test` for unit suites. Integration suites need a real DB and are validated by CI; write them to the existing patterns in `apps/api/src/__tests__/integration/`.

## Task 1 — Migration, Drizzle schema, tenancy registrations

Files:
- NEW `apps/api/migrations/2026-08-23-abuse-endpoint-fingerprints.sql`
- `apps/api/src/db/schema/abuseSignals.ts` (add `abuseEndpointFingerprints` table + `abuseEndpointFingerprintKind` enum, modeled on `abuseScriptHosts`)
- `apps/api/src/routes/devices/core.ts` (`DEVICE_DETACH_DEVICE_ID_TABLES` — see Global Constraints ruling; mirror whatever per-table handling the delete route needs)
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (both allowlists)

Migration content (model: `2026-07-25-abuse-script-hosts.sql`):

```sql
DO $$ BEGIN
  CREATE TYPE abuse_endpoint_fingerprint_kind AS ENUM ('remote_tool_guid', 'hostname', 'egress_ip');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS abuse_endpoint_fingerprints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  kind          abuse_endpoint_fingerprint_kind NOT NULL,
  value         varchar(255) NOT NULL,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
```
Plus: unique index on `(partner_id, kind, value)`, index on `(kind, value)`, forced RLS + system-only policy (existence-guarded), header comment covering: why the corpus outlives devices, the GDPR boundary (partner hard-delete still cascades), and the deliberate indefinite retention.

Verify: `pnpm --filter @breeze/api test -- autoMigrate` (naming/ordering test), `cascadeDelete.test.ts` (device coverage contract — this is the one that fails if the detach registration is wrong), typecheck via the api test run.

## Task 2 — Corpus extraction + correlation loader (`recidivistEndpoint.ts`)

NEW file `apps/api/src/services/abuseSignals/recidivistEndpoint.ts` + NEW `recidivistEndpoint.test.ts`, following the `scriptContent.ts` loader idiom (raw SQL via `db.execute`, exported pure helpers for tests).

Two exported functions:

1. `syncEndpointFingerprints(now: Date): Promise<void>` — refresh the corpus:
   - `remote_tool_guid`: scan `software_inventory.name` joined through devices→organizations for the ScreenConnect pattern; upsert one row per (partner, guid) with `device_id` of the observing device; bump `last_seen_at` on conflict (`ON CONFLICT (partner_id, kind, value) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at, device_id = COALESCE(abuse_endpoint_fingerprints.device_id, EXCLUDED.device_id)`).
   - `hostname`: from `devices.hostname` (lowercased for value stability), applying the deny-list from Global Constraints.
   - `egress_ip`: from `devices.last_seen_ip` (fallback `enrollment_ip`), skipping NULL/empty.
   - Full-scan each sweep is acceptable at current fleet size (~hundreds of devices); no high-water mark in v1. Say so in a comment.
2. `loadRecidivistMatches(): Promise<RecidivistMatch[]>` — the correlation join, entirely in SQL: for each corpus value+kind held by an `active`/`pending` partner where the SAME value+kind is held by a DIFFERENT partner whose status != 'active', return `{ partnerId, kind, value, otherPartnerId, otherPartnerName, otherPartnerStatus }`. Exclude self-pairs. Also return `scannedPartnerIds`: every active/pending partner that holds ANY corpus row (needed for stale-resolution).

Extraction regex + deny-list live as exported pure helpers (`extractScreenConnectGuids(name: string)`, `isDeniedHostname(h: string)`) with direct unit tests. Loader SQL paths are tested with the mocked-`db` style used by `sweep.test.ts`/`digest.test.ts` (mock `db.execute`, assert row-shaping), not against live PG — the live behavior is Task 4's job.

## Task 3 — Scorer + config + sweep wiring

Files: NEW scorer in `recidivistEndpoint.ts` (same file as Task 2), `config.ts`, `index.ts` (`runAbuseSweep`), `sweep.test.ts`, `config.test.ts` if it asserts key inventory.

- `computeRecidivistSignals(matches: RecidivistMatch[], cfg: SignalConfig): ComputedSignal[]` — pure, no clock, no age. Group matches by partnerId; per partner determine matched axes:
  - any `remote_tool_guid` match → `fingerprint` axis (score `fingerprint_score`)
  - a `hostname` match AND an `egress_ip` match **against the same other-partner** → `hostname_ip` axis
  - `hostname` match alone → `hostname` axis
  - `egress_ip` alone → NO signal (v1)
  - score = max of matched axis scores; severity via `scoreToSeverity(score, cfg)`.
  - evidence: `{ axes: [...], matches: [{kind, value, otherPartnerName, otherPartnerStatus}...] }` capped to the first 10 matches.
- `config.ts`: add the four defaults under a comment block explaining the axis scores and citing the 10/10-US + 1/1-EU zero-FP backtest; note `ip_score` is reserved/unemitted in v1.
- `index.ts`: inside the existing `runSystemDbCompute` block call `syncEndpointFingerprints(now)` then `loadRecidivistMatches()`; spread `...computeRecidivistSignals(recidivist.matches, cfg)` into `computed` with a no-decay comment matching the script/billing ones; add `recidivist.scannedPartnerIds` to `evaluatedPartnerIds` so open rows stale-resolve when the evidence disappears.
- `sweep.test.ts`: mock the new module like `scriptContent` is mocked (empty defaults in `beforeEach`); one test that a computed recidivist signal flows through to `persistSignals`; one that its scannedPartnerIds join the evaluated set.
- Scorer unit tests (in `recidivistEndpoint.test.ts`): each axis; max-not-sum on a partner matching all three; hostname+ip across *different* other-partners stays at `hostname` 60 (the 90 axis requires the same counterpart); ip-only emits nothing; severity mapping at defaults (100→alert, 90→alert, 60→watch); override respected via `loadSignalConfig` config injection.

Note: the direction rule (active-side only, non-active counterpart) is enforced in Task 2's SQL — the scorer trusts its input. One scorer test documents this contract by asserting the scorer emits whatever matches it is given (no status re-checking).

## Task 4 — Integration test against real Postgres

NEW `apps/api/src/__tests__/integration/recidivistEndpoint.integration.test.ts`, modeled on the existing abuse integration suites (find the one exercising `partner_abuse_signals` persistence / `abuse_script_hosts` and copy its setup idiom, incl. migration replay and `withSystemDbAccessContext`).

Scenarios (spec §Verification):
1. Seed partner A (suspended) and partner B (active), each with an org+device; insert `software_inventory` rows on both devices carrying `ScreenConnect Client (aabbccdd11223344)`. Run `syncEndpointFingerprints` + `loadRecidivistMatches` + `computeRecidivistSignals` (or `runAbuseSweep` with ops-alerting unconfigured): assert **exactly one** signal row, on B, key `rmm.recidivist_endpoint`, score 100, severity alert.
2. Same seed but both partners `active`: assert **zero** signals (backtest-replay assertion).
3. Suspended↔suspended: zero signals.
4. Hostname-only reuse (shared hostname `DESKTOP-ZZ9XY7Q`, distinct IPs, no GUID): score 60 watch on the active partner; then add matching `egress_ip` rows (same counterpart) and assert 90.
5. RLS: as `breeze_app` without system scope, `SELECT` on `abuse_endpoint_fingerprints` returns zero rows / insert is rejected (match the `partner_abuse_signals` RLS lockout test idiom).

## Explicitly out of scope

Cross-region correlation; LogMeIn/other extraction patterns; any UI; retention job; backfill of historical suspended-partner fingerprints beyond what the first sweep's full scan captures (it scans current `software_inventory`, which still holds the suspended partners' rows — sufficient per the backtest).
