# Pre-release sweep — <from-tag> → <to-ref> (<YYYY-MM-DD>)

| | |
|---|---|
| Range | `<from-tag>` (`<sha>`, <date>) → `origin/main` `<sha>` |
| Gate | PRs waited on: #… ; merged: #… ; known-noise checks dismissed: … |
| Stack | `pnpm wt-stack up` on `qa/sweep-post-<from-tag>` @ `<sha>`, baseUrl `http://localhost:<port>` |
| Flags enabled | `BREEZE_…=true`, … |
| Driver | skill `pre-release-sweep`; sweep agents: … |

## Change inventory

Status ∈ `TODO | PASS | PARTIAL | FAIL | BLOCKED | N/A`. Every row must leave `TODO`.

| PR | Merged | Surface | Title | Route / click-path | Expected visible outcome | Prereq | Status |
|---|---|---|---|---|---|---|---|

## Sweep log (append as you go)

### [Group — area] — agent, timestamp

#### [#PR / area] — PASS | PARTIAL | FAIL | BLOCKED
- ✅ what was checked, concretely
- ❌ BUG: symptom → API actual (status + body) vs UI actual
- ⚠️ UI/UX: paper cut (also copy to the list below)
- BLOCKED: prerequisite

## UI/UX paper cuts

| # | Where | Observation | Severity | Disposition (fixed <sha> / issue # / noted) |
|---|---|---|---|---|

## Fixes applied

| Commit | PR/area | What | Test |
|---|---|---|---|

## Issues filed

| Issue | Title | From row |
|---|---|---|

## Summary

| Group | PASS | PARTIAL | FAIL | BLOCKED | N/A |
|---|---|---|---|---|---|

**Top findings:**

**Oldest PR reached:** #…

**Before the release cut:** flags to enable, BLOCKED rows needing a live agent, open issues.
