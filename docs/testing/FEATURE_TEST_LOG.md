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
