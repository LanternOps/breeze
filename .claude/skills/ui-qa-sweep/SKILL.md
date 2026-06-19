---
name: ui-qa-sweep
description: >-
  Broad regression QA of the Breeze RMM web UI via Playwright — exercising
  everyday MSP workflows and setup tasks like a human QA tester, logging
  functional PASS/FAIL plus UI/UX observations, and filing GitHub issues from
  findings. Use this whenever the user asks to "QA the UI", do "extensive UI
  testing", a "regression sweep", "test everyday flows", "act as QA", verify
  recently/previously merged PRs end-to-end through the browser, or walk
  backward through PR history checking the UI. This is the whole-app sweep —
  for verifying ONE just-built feature use `feature-testing` instead.
---

# UI QA Sweep

## Purpose & scope

`feature-testing` verifies one freshly-implemented feature. **This skill is the
opposite**: a wide regression pass over the *whole* product as a skeptical human
QA tester would do it — log in, click everything an MSP touches day to day, try
the setup/onboarding tasks, and walk backward through merged PRs confirming each
shipped change still works in the browser. The deliverable is an evidence log
(functional results **and** UI/UX observations) plus GitHub issues for real
defects.

Bias toward **breadth and skepticism**. The most valuable findings here are not
"feature X exists" — they're silent failures, dead ends, confusing copy, console
errors, broken empty states, and things that *look* fine but give the user no
feedback. Treat "the API returned a clean error but the UI showed nothing" as a
bug, not a pass.

## Workflow

1. **Environment** — get a reachable local stack (this is the usual time sink).
2. **Baseline login + nav crawl** — confirm every nav destination renders.
3. **Everyday-workflow checklist** — run the recurring-task list below.
4. **Setup-task checklist** — run the onboarding/configuration list below.
5. **Backward-through-PRs pass** — `gh pr list --state merged`, newest→oldest,
   translate each UI-affecting PR into a concrete click-path, verify it.
6. **Log continuously** — append to `docs/testing/FEATURE_TEST_LOG.md` as you go
   (not just at the end), with a running UI/UX observations sub-log.
7. **File issues** — use the `github-issues` skill; one focused issue per defect,
   dedupe against open issues first, link to the log.

Use `TaskCreate` to track the checklist so progress survives context limits.
Prefer dispatching this sweep to a background agent (it is long-running and
context-heavy); a single agent must own the Playwright browser — never run two
browser-driving agents concurrently against the shared MCP browser.

## Phase 1 — Environment (read this first, it always bites)

The local stack is frequently misconfigured for browser access. See the
`local-playwright-env-setup` memory for the full rationale. Short version:

- Target **`http://localhost`** through Caddy `:80`. Do **not** use
  `https://2breeze.app` (public tunnel is typically down → CF 530; Chromium
  rejects Caddy's self-signed cert and the MCP browser has no
  `ignoreHTTPSErrors`).
- If login throws "Network error": check `PUBLIC_API_URL`. The web app preserves
  the URL *scheme*, so an `https://` value force-upgrades API calls and resets.
  Fix: `.env` `PUBLIC_API_URL=http://localhost`, add `http://localhost` to
  `CORS_ALLOWED_ORIGINS`, leave `BREEZE_DOMAIN` unset, then
  `docker compose up -d --force-recreate web caddy`. Dev web is `astro dev` and
  re-reads env on restart (no image rebuild). `.env` is gitignored — local only.
- After a `--build` rebuild, the API container gets a new IP; **restart caddy**
  or it 502s the API on a stale upstream.
- Confirm: `curl -s -o /dev/null -w '%{http_code}' http://localhost/health` → 200.
- Login: `admin@breeze.local` / **`BreezeAdmin123!`** (the `.env`
  `E2E_ADMIN_PASSWORD` is stale). Clear login rate limits if needed (see
  `feature-testing` Phase 2).

Load Playwright tools via `ToolSearch("select:mcp__plugin_playwright_playwright__browser_navigate,...")`.

## Phase 2 — Baseline login + nav crawl

Log in, then visit every sidebar destination once and record: does it render,
HTTP status of its primary data call, console errors/warnings. This is cheap and
catches the highest-impact regressions (a whole page 500ing). Known noise to
note but not chase: a non-platform-admin sees `403` on
`/admin/account-deletion-requests/pending-count` and the third-party catalog
(tracked — see issues; don't refile).

Nav surface (current): Dashboard, Devices, Alerts (Alerts/Rules/Channels),
Incidents, Remote Access, Scripts, Patches (Compliance/Patches/Update Rings),
Fleet, AI Workspace, Network Monitor, Security, Sensitive Data, Peripherals,
AI Risk, CIS Benchmarks, Compliance Baselines, Network Discovery, Software
Library, Software Policies, Config Policies, Backup, Cloud Backup, Disaster
Recovery, Integrations, Reports, Analytics, Audit Trail, Event Logs, Settings
(Partner, Organizations, AI Usage, Custom Fields, Saved Filters, Users, Roles,
Enrollment Keys).

## Phase 3 — Everyday-workflow checklist

These are the things an MSP tech does on a normal day. For each: perform the
action through the UI, verify the **result is visibly confirmed** (toast, state
change, list update — not just a 2xx in the network tab), and check no console
error. A backend success with no UI feedback is a **fail** (this is the #1
recurring defect class — see issue #720).

- **Devices**: search/filter by status & OS; change page size; open a device;
  switch device-detail tabs (Overview, Performance, Hardware, Software, Patches,
  Connections, Event Log); sort columns; bulk-select; tag a device.
- **Device actions**: Run Script, Reboot, Wake, Connect Desktop, Remote Tools —
  each must show success/failure feedback. (Offline fixtures: expect graceful
  "can't" messaging, not silence.)
- **Alerts**: view active alerts; acknowledge / resolve / suppress one; open an
  alert rule; create + edit + delete a notification channel; click **Test** on a
  channel and confirm a visible pass/fail result.
- **Scripts**: create a script; import from library; edit; run on a device
  (script picker shows system scripts); view run output.
- **Patches**: view compliance; run a scan; open a device's patch list;
  approve/reject a patch; filter by source incl. 3rd-party.
- **Remote**: open a remote session list; start a session (or graceful
  offline-device messaging).
- **Search**: Cmd+K global search for a device / script / setting; result
  navigates correctly.
- **Saved filters / tags / custom fields**: create one, apply it, delete it.
- **Reports / Analytics / Audit**: generate/open a report; audit trail
  paginates and filters; export buttons respond.
- **Theme / profile**: toggle theme; open profile menu; sign out + back in.

## Phase 4 — Setup-task checklist (onboarding / configuration)

These are the things done when setting up a tenant or a new feature. Watch
especially for: validation messages being readable (not `[object Object]`, not
silent, not over-generic), guided next-steps after creation, and sidebar/list
sync after create/delete.

- **Org/site structure**: create an organization → guided "add first site" →
  create a site; rename; delete (named confirm dialog). Verify list + org
  switcher stay in sync.
- **Users & roles**: invite a user; create/edit a role; assign it.
- **Enrollment**: create an enrollment key; view the install command;
  revoke a key.
- **Notification channels**: configure each type (Email, Slack, Teams,
  PagerDuty, Webhook, SMS, Pushover); set partner-level defaults; verify
  inheritance; create a routing rule.
- **Configuration policies**: create a policy; link a feature; assign to an
  org/site; preview effective config (use the `configuration-policy` skill for
  internals).
- **Partner settings**: every tab (Company, Regional, Security, Notifications,
  Defaults, Branding, AI Budgets, Remote-tool providers) — save with valid and
  invalid input; confirm scheme/URL validation rejects `javascript:`/`data:`.
- **Monitoring / Discovery**: configure a monitor; start a network discovery
  scan; view results.
- **Backup / DR**: configure a backup SLA; create a DR plan (forms render &
  validate).
- **Integrations**: open the integrations catalog; start a connect flow
  (OAuth/API-key form renders).

Fixture-limited items (single-org seed, offline devices, no platform admin) —
note as **BLOCKED** with the prerequisite, don't fake a pass. Re-test guidance
goes in the log.

## Phase 5 — Backward-through-PRs pass

```bash
gh pr list --repo LanternOps/breeze --state merged --limit 60 \
  --json number,title,mergedAt --jq 'sort_by(.mergedAt)|reverse|.[]|"\(.number) \(.title)"'
```

Walk newest→oldest. Skip pure chore/deps/CI/refactor/agent-only PRs (no web
surface). For each UI-affecting PR, translate the title into a concrete
click-path and verify the change is present and works. When the recent window is
covered, keep going further back — this is a *backward* sweep, there is no
natural stopping point except the user's call or running out of UI-affecting
PRs. Record the oldest PR number reached so a later run can resume.

## Logging format

Append to `docs/testing/FEATURE_TEST_LOG.md` under a dated
`## UI QA Sweep — YYYY-MM-DD` section. Write entries **as you go**, not at the
end (a long sweep will hit context limits; unflushed findings are lost).

Per area:

```markdown
### [Area / PR#] — PASS | PARTIAL | FAIL | BLOCKED
- ✅ what worked (with the concrete check)
- ❌ BUG: symptom → API actual (status + body) vs UI actual; why it's a bug
- ⚠️ UI/UX: friction, confusing copy, layout, console noise (the parallel log)
- prerequisite/re-test note if BLOCKED
```

Keep a running **UI/UX observations** list separate from pass/fail — small
papercuts (ambiguous labels, missing empty states, overlays that intercept
clicks, console errors, transient toasts) are the point, not a side note.

End with a summary table (area → result) and a "Top findings" section calling
out systemic patterns (e.g. "N features share a broken toast path").

## Filing issues from findings

Invoke the `github-issues` skill. Rules that matter here:

- One focused issue per defect; don't batch unrelated findings.
- `gh issue list --state open` and grep for keywords first — dedupe. If related
  but distinct (different symptom, same file), cross-link, don't refile.
- Title `[UI] symptom...`; body = Description (with exact API status+body vs UI
  behavior), suspected root cause, proposed fix, affected files, "Reported By:
  internal Playwright UI QA sweep <date>, evidence in FEATURE_TEST_LOG.md".
- Internal QA ⇒ no `@reporter`; still don't close issues yourself.

## Anti-patterns

- Declaring PASS on a 2xx without confirming the UI told the user. Silence is a
  fail.
- Full-page screenshots/snapshots every step — burns context. Prefer targeted
  `browser_snapshot target=...` + `browser_evaluate` DOM probes; screenshot only
  when a visual check is the point.
- Chasing already-tracked noise (the `/admin/*` 403s) — note once, move on.
- Faking coverage for fixture-blocked items — mark BLOCKED with the prereq.
- Doing the whole sweep in the main session — dispatch to a background agent and
  keep the main context for triage and issue-filing.
- **False silent-failure from selector choice.** Many modals/drawers are plain
  `fixed inset-0` divs with **no `role=dialog`**. Asserting "did a dialog open"
  by role/class will wrongly conclude an action silently failed (this bit a
  Reboot-button check). Assert on the modal's **title/body text** (or a
  `data-testid`) instead, and confirm the *outcome* (toast/state change), not
  the container.
