# Feature Test Log

Tracking file for post-implementation feature verification results. Entries are logged most-recent-first.

Use the `feature-testing` skill to run structured verification and record results here.

<!-- TEMPLATE — copy below this line for new entries

## [Feature Name] — YYYY-MM-DD

**Branch:** `branch-name`
**Commit:** `abc1234`
**Tested by:** Claude / Human
**Result:** PASS / PARTIAL / FAIL

### What was tested
- [ ] UI: description of UI verification
- [ ] API: description of API verification
- [ ] Agent: description of agent verification

### Evidence
- Screenshot: (path or description)
- API response: (summary)
- Agent logs: (relevant excerpt)

### Issues Found
- (none, or describe issues)

### Notes
- (any additional context)

-->

## Data Discovery / Sensitive Data (Kit/Windows) — 2026-02-28

**Branch:** `fix/integration-testing-502s`
**Commit:** `6703cc2` (pre-fix) + uncommitted changes
**Tested by:** Claude
**Result:** PASS (with 3 bugs found & fixed)

### What was tested
- [x] UI: Data Discovery page loads at `/sensitive-data` with 4 tabs (Dashboard, Findings, Scans, Policies)
- [x] UI: Dashboard summary cards render (Total Findings, Critical Open, Remediated 24h, Open Findings)
- [x] UI: Dashboard charts (Findings by Data Type, Risk Distribution) render with "No data yet" placeholder
- [x] UI: Scans tab lists all scans with correct status, device name, timestamps, and durations
- [x] UI: Scans tab Refresh button fetches latest data from API
- [x] UI: New Scan modal creates scan targeting Kit device successfully
- [x] UI: Policies tab renders
- [x] API: `POST /sensitive-data/scan` — 202, creates and queues scan
- [x] API: `GET /sensitive-data/scans` — 200, returns all scans (NEW endpoint added during testing)
- [x] API: `GET /sensitive-data/scans/:id` — 200, returns scan detail with findings summary
- [x] API: `GET /sensitive-data/dashboard` — 200, returns aggregate counts
- [x] API: `GET /sensitive-data/report` — 200, returns paginated findings
- [x] Agent (Kit/Windows `dev-1772316104`): Received `sensitive_data_scan` command, executed scan, returned results
- [x] Agent: Scan completed with 0 findings (default scan paths on Kit have no sensitive files)
- [x] BullMQ: Scan job dispatched and completed through queue

### Bugs Found & Fixed

**Bug 1: Scans stuck in "running" forever**
- **Symptom**: `POST /sensitive-data/scan` queued scan, agent executed and returned results, but scan record stayed `status: running`
- **Root cause**: `processCommandResult()` in `agentWs.ts` (WebSocket handler) did NOT call `handleSensitiveDataCommandResult` — that handler only existed in the HTTP POST route (`commands.ts`), but agents send results via WebSocket
- **Fix**: Added sensitive data and CIS post-processing blocks to `processCommandResult()` in `agentWs.ts`

**Bug 2: No list-scans API endpoint**
- **Symptom**: Scans tab showed stale data from in-memory React state — Refresh button fetched `/dashboard` instead of actual scans list
- **Root cause**: Comment in ScansTab.tsx: "There is no list-scans endpoint yet"
- **Fix**: Added `GET /sensitive-data/scans` endpoint to `sensitiveData.ts` returning recent scans ordered by creation date. Updated `ScansTab.tsx` to fetch from the new endpoint.

**Bug 3: UI never updated scan statuses**
- **Symptom**: Even after scans completed in DB, UI continued showing "running" with "Running..." duration
- **Root cause**: Frontend `ScansTab` stored scans in an in-memory `detailCache` populated only at creation time. Refresh just re-rendered the same stale cache.
- **Fix**: Replaced cache-based approach with direct API fetch from new `/scans` endpoint on every load and refresh.

### Evidence
- Screenshot: `e2e-tests/snapshots/sensitive-data-scans-completed.png` — 3 scans all showing "Completed" with durations
- API: `GET /sensitive-data/scans` returns 3 scans, all `status: completed`, Kit device
- API: Scan summary shows `filesScanned: 0, findingsCount: 0` (expected — Kit default paths empty)
- Agent: Command completed via WebSocket with `sensitive_data_scan` type processed correctly

### Notes
- Kit's default scan paths have no sensitive files, so 0 findings is expected
- macOS agent (v0.5.0) does NOT have `sensitive_data_scan` handler — needs rebuild
- The `agentWs.ts` fix also added CIS post-processing (same pattern — was missing from WS handler)

---

## CIS Benchmarking (Kit/Windows) — 2026-02-28

**Branch:** `fix/integration-testing-502s`
**Commit:** `f99127c`
**Tested by:** Claude
**Result:** PASS (with 1 bug fix applied)

### What was tested
- [x] UI: CIS Hardening page loads at `/cis-hardening` with 3 tabs (Compliance, Baselines, Remediations)
- [x] UI: Summary cards render correctly — updated to Average Score 44%, Failing Devices 1, Active Baselines 10
- [x] UI: Baselines tab lists all baselines with Edit/Trigger Scan actions
- [x] UI: New Baseline form creates baseline successfully (count 9→10)
- [x] UI: Remediations tab renders with status filter dropdown
- [x] UI: Compliance tab shows Kit scan result with expandable failed findings row
- [x] UI: Expanded row shows check 2.3.7 severity badge, check ID, title, and evidence
- [x] API: `GET /cis/baselines` — 200, returns all baselines
- [x] API: `POST /cis/baselines` — 201, creates new baseline
- [x] API: `GET /cis/compliance` — 200, returns summary + results (after bug fix)
- [x] API: `GET /cis/remediations` — 200, returns paginated remediations
- [x] API: `POST /cis/scan` — 202, queues scan job
- [x] API: `GET /cis/devices/:id/report` — 200, returns Kit report with findings
- [x] Agent (Kit/Windows `dev-1772316104`): Received `cis_benchmark` command, executed checks, returned results
- [x] Agent: Score 44% — 4 passed, 1 failed (check 2.3.7), 4 not_applicable out of 9 total checks
- [x] BullMQ: Job completed with `devicesTargeted: 1, commandsQueued: 1`

### Bug Found & Fixed
**`GET /cis/compliance` returned 500**: `row.resultCreatedAt.toISOString is not a function`
- **Root cause**: `resultCreatedAt` and `baselineCreatedAt` are defined via `sql<Date>` aliases in a Drizzle subquery. Drizzle returns raw SQL expression results as strings (not Date objects) when used in subqueries. Calling `.toISOString()` on a string crashes.
- **Fix**: Added `toISO()` helper in `cisHardening.ts` that handles both Date and string types:
  ```typescript
  const toISO = (v: unknown): string => v instanceof Date ? v.toISOString() : String(v ?? '');
  ```
- **Affected lines**: 465, 472, 484, 485 in `cisHardening.ts`

### Evidence
- Screenshot: `cis-compliance-tab.png` — Empty compliance tab before scan
- Screenshot: `cis-baselines-tab.png` — Baselines tab showing 9 baselines
- Screenshot: `cis-kit-compliance-result.png` — Kit compliance result: 44%, 1 failed check expanded inline
- API: Kit device report shows: Score 44, Passed 4/9, Failed 1 (check 2.3.7: Interactive logon last user name)
- Agent logs: `[info] heartbeat: processing command` → `[info] heartbeat: command completed`

### Notes
- macOS agent (v0.5.0) does NOT have CIS handlers — needs rebuild/redeploy
- Windows agent (Kit, `dev-1772316104`) has CIS handlers and works end-to-end
- Duplicate baselines from prior E2E runs — no dedup guard on baseline creation
