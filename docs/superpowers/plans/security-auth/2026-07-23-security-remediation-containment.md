# Security Remediation Stage 0 Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the immediately exploitable CI, signing, hosted-edge, tenant-export, report, managed-software, telemetry, certificate, and Unix-permission exposures while preserving evidence, a tested rollback for every reversible mutation, and a tested recovery path for irreversible certificate revocation.

**Architecture:** This is an operator runbook, not a product implementation PR. It first captures immutable state, then applies the smallest control at the existing trust boundary: disable the exposed workflow, darken signing without removing unsigned builds, use edge controls for hosted traffic, use existing RBAC for product exposure, and preserve all affected database rows. Every mutation has a named owner, a before/after artifact, and an acceptance check. Reversible mutations have a tested rollback command; irreversible certificate revocation has second-operator approval and a tested re-enrollment/reissuance recovery path.

**Tech Stack:** GitHub CLI and Actions, Cloudflare WAF/API Shield and origin firewall/tunnel controls, PostgreSQL 16, Breeze RBAC/admin APIs, Sentry/log storage, POSIX `find`/`stat`/`chmod`, SHA-256 evidence manifests.

## Global Constraints

- This document plans containment; creating or reviewing it does **not** authorize running any command below.
- A security incident owner and a second operator must approve each mutation in the change record. Certificate revocation, origin filtering, report-schedule changes, capability rotation, and agent filesystem changes need explicit approval immediately before execution.
- Store evidence only under the gitignored `internal/` tree or the approved incident system. Never commit run output, infrastructure identifiers, user lists, certificate identifiers, tokens, URLs containing capabilities, database exports, or screenshots.
- Use read-only discovery before each mutation. Stop when the observed state differs from the assumptions in this plan.
- Never print secret values. GitHub/Cloudflare/provider secret rotation must use an interactive prompt or the provider console.
- Do not delete report definitions or report runs. Do not revoke a certificate unless it is absent from the current device record and a second operator approves the exact certificate ID.
- Do not enable Cloudflare blocking until certificate-presentation telemetry meets the Wave 5 adoption gate. Stage 0 uses Log mode only.
- Tasks 3-5 apply only to the hosted deployment. Before running them, verify the secure production
  record has `IS_HOSTED=true` and set `BREEZE_CONTAINMENT_DEPLOYMENT_CLASS=hosted` for the operator
  session. If the deployment is self-hosted, record those tasks as not applicable and skip them;
  self-hosted mTLS remains `off`/`audit` until explicit Wave 5 operator opt-in.
- Unsigned arbitrary-branch developer builds remain available. Only signing and notarization are darkened.
- Public issues, pull requests, release notes, and commit messages describe restored invariants, not exploit mechanics.

---

### Task 1: Open an evidence-preserving containment record

**Files:**

- Read: `docs/superpowers/specs/security-auth/2026-07-23-full-security-review-remediation-design.md`
- Create at execution time, gitignored: `internal/security-containment/2026-07-23/`
- Do not modify tracked repository files

- [ ] Confirm the checkout and repository identity before collecting evidence.

```bash
git_common="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_root="$(cd "$git_common/.." && pwd -P)"
test "$(git -C "$repo_root" rev-parse --show-toplevel)" = "$repo_root"
cd "$repo_root"
test "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" = "LanternOps/breeze"
```

Expected: every command exits `0` in the canonical primary checkout. If any command fails, stop;
do not infer a target or run Stage 0 from a linked planning/implementation worktree.

- [ ] Create a private evidence directory and capture the starting revision and clock.

```bash
umask 077
export BREEZE_CONTAINMENT_EVIDENCE="$PWD/internal/security-containment/2026-07-23"
install -d -m 0700 "$BREEZE_CONTAINMENT_EVIDENCE"
{
  date -u +"started_at=%Y-%m-%dT%H:%M:%SZ"
  git rev-parse HEAD
  git status --short --branch
  gh auth status
} >"$BREEZE_CONTAINMENT_EVIDENCE/preflight.txt" 2>&1
```

Expected: the directory is mode `0700`; `preflight.txt` is mode `0600` because of `umask 077`.

- [ ] Create `change-record.md` in the approved incident system with these mandatory fields: security incident owner, second operator, start time, scope, before-state artifact, mutation, validation, rollback command, rollback owner, and completion time.

- [ ] Record an explicit stop rule: any command that would reveal a secret, enumerate customer content, disconnect an agent, or invalidate a customer link requires a new operator decision and must not be improvised from this plan.

### Task 2: Contain PR-secret execution and developer signing

**Files and interfaces:**

- Inspect: `.github/workflows/doc-verify.yml`
- Inspect: `.github/workflows/docs-review.yml`
- Inspect: `.github/workflows/dev-build-agent.yml`
- GitHub Actions workflow: `doc-verify.yml`
- GitHub Actions repository variable: `ENABLE_MACOS_SIGNING`
- GitHub Actions secret: `ANTHROPIC_API_KEY`

- [ ] Capture the workflow definitions and the last 100 pull-request runs before mutation.

```bash
gh workflow view doc-verify.yml --yaml \
  >"$BREEZE_CONTAINMENT_EVIDENCE/doc-verify.before.yml"
gh workflow view dev-build-agent.yml --yaml \
  >"$BREEZE_CONTAINMENT_EVIDENCE/dev-build-agent.before.yml"
gh run list --workflow doc-verify.yml --event pull_request --limit 100 \
  --json databaseId,headBranch,headSha,event,status,conclusion,createdAt,updatedAt,url \
  >"$BREEZE_CONTAINMENT_EVIDENCE/doc-verify-pr-runs.json"
```

Expected: the YAML artifacts show the definitions that were active at containment time; the run list contains no secret values.

- [ ] Record the current signing-variable state without treating an absent variable as `true`.

```bash
if gh variable get ENABLE_MACOS_SIGNING \
  >"$BREEZE_CONTAINMENT_EVIDENCE/enable-macos-signing.before.txt" 2>&1; then
  printf 'present=true\n' \
    >>"$BREEZE_CONTAINMENT_EVIDENCE/enable-macos-signing.before.txt"
else
  printf 'present=false\n' \
    >"$BREEZE_CONTAINMENT_EVIDENCE/enable-macos-signing.before.txt"
fi
```

- [ ] After two-operator approval, disable the exposed PR workflow and darken signing.

```bash
gh workflow disable doc-verify.yml
gh variable set ENABLE_MACOS_SIGNING --body false
```

- [ ] Verify containment.

```bash
gh workflow view doc-verify.yml --json state --jq .state
gh variable get ENABLE_MACOS_SIGNING
```

Expected: workflow state is `disabled_manually`; the variable is exactly `false`. A manual `dev-build-agent.yml` run still produces unsigned artifacts because its build and upload steps do not depend on `ENABLE_MACOS_SIGNING`.

- [ ] Review every same-repository PR run in `doc-verify-pr-runs.json`. For each run, inspect job/step names, start time, actor, head SHA, artifact names, unexpected outbound behavior, and whether the run predates containment. Record the reviewer and disposition for all 100 rows; escalate anomalous runs instead of deleting them.

- [ ] Rotate `ANTHROPIC_API_KEY` only after `doc-verify.yml` is disabled.

```bash
gh secret set ANTHROPIC_API_KEY --repo LanternOps/breeze
gh api repos/LanternOps/breeze/actions/secrets/ANTHROPIC_API_KEY \
  --jq '{name,created_at,updated_at}' \
  >"$BREEZE_CONTAINMENT_EVIDENCE/anthropic-secret.after.json"
```

Expected: `gh secret set` reads the new value interactively; the evidence contains metadata only. Revoke the old credential in the Anthropic provider console and record its provider audit event ID.

- [ ] Record rollback without executing it:

```bash
# Only after Wave 1 has merged and the replacement PR workflow is proven secret-free:
gh workflow enable doc-verify.yml

# Only after the macos-signing environment has required reviewers and the
# split build/sign workflow is deployed:
gh variable set ENABLE_MACOS_SIGNING --body true
```

If the before artifact says the variable was absent, the rollback is `gh variable delete ENABLE_MACOS_SIGNING`, not setting it to `true`.

### Task 3: Put command-WebSocket mTLS enforcement in Log mode

**Files and interfaces:**

- Read: `agent/internal/websocket/client.go` (`buildWSURL`, path `/api/v1/agent-ws/:id/ws`)
- Read: `apps/api/src/routes/agentWs.ts` (`createAgentWsRoutes`)
- Read: `docs/operations/cloudflare-mtls-setup.md`
- Cloudflare WAF custom-rule expression:
  `(http.request.uri.path matches "^/api/v1/agent-ws/[^/]+/ws$" and not cf.tls_client_auth.cert_verified)`

- [ ] Confirm this is the hosted deployment before touching Cloudflare:

```bash
test "${BREEZE_CONTAINMENT_DEPLOYMENT_CLASS:-}" = hosted
```

Expected: exit `0`, backed by a production record showing `IS_HOSTED=true`. Otherwise skip Tasks
3-5; do not translate these controls into self-hosted proxy or firewall changes.

- [ ] Export the existing Cloudflare custom-rule configuration from the provider console/API into the private evidence directory. Record rule ID, version, expression, action, enabled state, and order; omit API tokens and hostnames from the change record.

- [ ] Create or update exactly one rule with the expression above and action `Log`. Do not use `Block`, `Managed Challenge`, or a zone-wide mTLS rule in Stage 0.

- [ ] Observe at least one full agent reconnect interval plus 24 hours of command-socket traffic. Produce an aggregate containing only counts by `cert_verified`, agent release ring, and hour. Do not retain raw socket URLs or certificate material.

- [ ] Acceptance gate: all actively supported release rings have successful `cert_verified=true` command-socket connections, and every `cert_verified=false` connection has a documented device/release owner. Any unexplained false result blocks Wave 5 enforcement.

- [ ] Record rollback: restore the exported rule version or disable only this rule by its recorded rule ID. Because Stage 0 is Log-only, rollback must not change traffic reachability.

### Task 4: Restrict direct origin reachability without changing the public edge

**Interfaces:**

- Production API origin firewall/security group or Cloudflare Tunnel ingress
- Public edge health route: `/health`
- Agent command socket: `/api/v1/agent-ws/:id/ws`

- [ ] Resolve the deployed origin mechanism from the production change record: Cloudflare Tunnel, reverse-proxy allowlist, or host firewall. Stop if more than one path exists and ownership is unclear.

- [ ] Capture from an approved administration network:
  1. public-edge `/health` result;
  2. direct-origin `/health` result using the origin address from the secure inventory;
  3. current inbound rules; and
  4. active tunnel/proxy identifiers.
  Store only sanitized results in the evidence directory.

- [ ] Prepare a change that allows the configured trusted proxy/tunnel and the documented break-glass administration path, then denies other direct API-origin traffic. The source ranges/connector IDs must come from the secure production inventory; do not copy values into this repository.

- [ ] Before applying, record the provider-specific inverse command that restores the exported inbound-rule version. A second operator must verify that command targets only the API origin.

- [ ] Apply the rule, then verify:
  - public-edge `GET /health` is `200`;
  - a canary agent reconnects to `/api/v1/agent-ws/:id/ws`;
  - a direct-origin request from outside the allowlist fails before Hono; and
  - no API/web/portal image-version skew was introduced.

- [ ] Roll back immediately if edge health, canary heartbeat, or command dispatch fails. Origin rollback restores the prior inbound-rule version; it must not disable the public proxy.

### Task 5: Inventory stale Cloudflare client certificates

**Files and interfaces:**

- Read: `apps/api/src/services/cloudflareMtls.ts`
- Database fields: `devices.mtls_cert_cf_id`, `devices.mtls_cert_serial_number`, `devices.mtls_cert_expires_at`
- Cloudflare endpoint: `GET /zones/{zone_id}/client_certificates`

- [ ] Export the current device certificate references from PostgreSQL using a read-only account.

```bash
psql "$BREEZE_READONLY_DATABASE_URL" --csv -c \
  "SELECT id, agent_id, mtls_cert_cf_id, mtls_cert_serial_number, mtls_cert_expires_at
   FROM devices
   WHERE mtls_cert_cf_id IS NOT NULL
   ORDER BY mtls_cert_cf_id" \
  >"$BREEZE_CONTAINMENT_EVIDENCE/device-current-certs.csv"
```

- [ ] Export every page of Cloudflare certificate metadata with a read-only token. Store only ID,
serial, status, issue time, and expiry; do not store certificate bodies or private keys. Keep the
token out of process arguments and disable shell tracing before reading it.

```bash
set +x
umask 077
read -r -s -p "Cloudflare read-only API token: " BREEZE_CF_READ_TOKEN
printf '\n'
[[ "$BREEZE_CF_READ_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]]
BREEZE_CF_CURL_CONFIG="$(mktemp)"
BREEZE_CF_PAGE_FILE="$(mktemp)"
trap 'rm -f "$BREEZE_CF_CURL_CONFIG" "$BREEZE_CF_PAGE_FILE"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$BREEZE_CF_READ_TOKEN" \
  >"$BREEZE_CF_CURL_CONFIG"
unset BREEZE_CF_READ_TOKEN

BREEZE_CF_CERT_ROWS="$BREEZE_CONTAINMENT_EVIDENCE/cloudflare-certs.ndjson"
: >"$BREEZE_CF_CERT_ROWS"
BREEZE_CF_PAGE=1
BREEZE_CF_TOTAL_COUNT=
while :; do
  curl --fail --silent --show-error \
    --config "$BREEZE_CF_CURL_CONFIG" \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/client_certificates?per_page=100&page=$BREEZE_CF_PAGE" \
    >"$BREEZE_CF_PAGE_FILE"
  jq -e --argjson expected_page "$BREEZE_CF_PAGE" \
    '.success == true and (.result | type == "array")
    and (.result_info.page == $expected_page)
    and (.result_info.total_pages >= .result_info.page)' \
    "$BREEZE_CF_PAGE_FILE" >/dev/null
  jq -c '.result[] | {id,serial_number,status,issued_on,expires_on}' \
    "$BREEZE_CF_PAGE_FILE" >>"$BREEZE_CF_CERT_ROWS"
  BREEZE_CF_TOTAL_PAGES="$(jq -r '.result_info.total_pages' "$BREEZE_CF_PAGE_FILE")"
  BREEZE_CF_TOTAL_COUNT="$(jq -r '.result_info.total_count' "$BREEZE_CF_PAGE_FILE")"
  [ "$BREEZE_CF_PAGE" -ge "$BREEZE_CF_TOTAL_PAGES" ] && break
  BREEZE_CF_PAGE=$((BREEZE_CF_PAGE + 1))
done
test "$(wc -l <"$BREEZE_CF_CERT_ROWS" | tr -d ' ')" -eq "$BREEZE_CF_TOTAL_COUNT"
test "$(jq -s 'map(.id) | unique | length' "$BREEZE_CF_CERT_ROWS")" \
  -eq "$BREEZE_CF_TOTAL_COUNT"
jq -s 'sort_by(.id)' "$BREEZE_CF_CERT_ROWS" \
  >"$BREEZE_CONTAINMENT_EVIDENCE/cloudflare-certs.json"
rm -f "$BREEZE_CF_CURL_CONFIG" "$BREEZE_CF_PAGE_FILE"
trap - EXIT
```

- [ ] Produce a candidate list containing Cloudflare IDs not present in `device-current-certs.csv`. A second operator must reconcile each candidate against recently deleted devices, pending renewal, rollback windows, and provider audit history.

- [ ] Revoke one approved certificate at a time through the Cloudflare console/API and immediately verify that its associated current-device count is still zero. Record provider audit event IDs, not secret material.

- [ ] Certificate revocation has no rollback. Its recovery is re-enrollment/reissuance for the identified device, so any unresolved device association is a hard stop.

### Task 6: Contain scheduled-report and historical-run exposure

**Files and interfaces:**

- Read: `apps/api/src/db/schema/reports.ts`
- Read: `apps/api/src/jobs/reportScheduleWorker.ts` (`findDueReports`, `processRunScheduledReport`)
- Read: `apps/api/src/routes/reports/core.ts`
- Read: `apps/api/src/routes/reports/runs.ts`
- Permissions: `reports:read`, `reports:write`, `reports:export`
- Site restriction source: `organization_users.site_ids IS NOT NULL`

- [ ] Snapshot counts and schedule state without exporting report result content.

```bash
psql "$BREEZE_READONLY_DATABASE_URL" --csv -c \
  "SELECT id AS report_id, schedule AS prior_schedule
   FROM reports
   WHERE schedule <> 'one_time'
   ORDER BY id" \
  >"$BREEZE_CONTAINMENT_EVIDENCE/scheduled-reports.before.csv"

psql "$BREEZE_READONLY_DATABASE_URL" --csv -c \
  "SELECT ou.user_id, ou.org_id, ou.role_id, cardinality(ou.site_ids) AS allowed_site_count
   FROM organization_users ou
   WHERE ou.site_ids IS NOT NULL
   ORDER BY ou.org_id, ou.user_id" \
  >"$BREEZE_CONTAINMENT_EVIDENCE/site-restricted-users.csv"
```

Expected: neither artifact contains report names, configuration, run results, or site IDs.

- [ ] Use the Roles UI/API to clone each affected role that is also assigned to an unrestricted user. Remove `reports:read`, `reports:write`, and `reports:export` from the containment clone, then assign only site-restricted memberships to the clone. For roles used solely by site-restricted users, remove those three permissions in place. Export role/membership IDs before and after; do not use direct SQL for RBAC changes.

Expected: site-restricted users cannot create reports, invoke `POST /reports/:id/generate`, list runs, fetch run detail, or download snapshots. Unrestricted administrators retain their original roles.

- [ ] Because `findDueReports` runs under system context and current rows lack immutable scope provenance, obtain product-owner approval to pause **all** non-one-time schedules. Apply in one transaction and report the affected row count.

```sql
BEGIN;
UPDATE reports
SET schedule = 'one_time', updated_at = now()
WHERE schedule <> 'one_time';
COMMIT;
```

Expected: the update count equals the number of rows in `scheduled-reports.before.csv` excluding the header. No report or report-run row is deleted.

- [ ] Verify:

```sql
SELECT count(*) AS still_scheduled
FROM reports
WHERE schedule <> 'one_time';
```

Expected: `still_scheduled = 0`. Verify as one site-restricted test user that report create/generate/list/download are denied, and as one unrestricted administrator that historical runs remain intact.

- [ ] Record rollback, but do not run it until Wave 2 has persisted scope provenance and the owner explicitly reauthorizes every row in the captured CSV. Import into a temporary table so containment does not create an untracked production table:

```bash
psql "$BREEZE_DATABASE_URL" \
  -v schedule_file="$BREEZE_CONTAINMENT_EVIDENCE/scheduled-reports.before.csv" <<'SQL'
BEGIN;
CREATE TEMP TABLE containment_report_schedules (
  report_id uuid PRIMARY KEY,
  prior_schedule report_schedule NOT NULL
) ON COMMIT DROP;
\copy containment_report_schedules FROM :'schedule_file' CSV HEADER
UPDATE reports r
SET schedule = s.prior_schedule, updated_at = now()
FROM containment_report_schedules s
WHERE r.id = s.report_id
  AND r.schedule = 'one_time';
COMMIT;
SQL
```

Expected: the update count equals the separately approved reauthorization list. If only some schedules are reauthorized, filter the private CSV to those reviewed IDs before importing. Role rollback restores captured role IDs/permission sets through the Roles UI/API.

### Task 7: Restrict tenant export and managed-software execution

**Files and interfaces:**

- Read: `apps/api/src/routes/admin/tenantExport.ts`
- Read: `apps/api/src/services/tenantExport.ts`
- Tenant-export audit action: `tenant.export`
- Tenant-export route: `GET /api/v1/admin/tenant-export/:orgId`
- Managed-software permission: `devices:execute`

- [ ] Query platform administrators and the last 90 days of `tenant.export` audit metadata. Store IDs, actor email, timestamp, result, resource ID, file count, and total row count; do not export archived tenant data or audit `details` outside the named fields.

- [ ] Export the current platform-admin IDs/emails, then create a private `platform-admin-allowlist.csv` with header `email` and at least two incident-approved break-glass-capable administrators. Reduce `BREEZE_PLATFORM_ADMINS` in the production secret store to that same set. Update both the host `.env` and the explicit API `environment:` mapping.

- [ ] The startup bootstrap only promotes listed emails; it does not demote removed emails. Apply the reduction explicitly with a temporary allowlist table:

```bash
psql "$BREEZE_DATABASE_URL" \
  -v admin_file="$BREEZE_CONTAINMENT_EVIDENCE/platform-admin-allowlist.csv" <<'SQL'
BEGIN;
CREATE TEMP TABLE containment_platform_admins (
  email text PRIMARY KEY
) ON COMMIT DROP;
\copy containment_platform_admins FROM :'admin_file' CSV HEADER
DO $$
DECLARE
  allowlist_rows integer;
  normalized_rows integer;
  eligible_rows integer;
BEGIN
  SELECT count(*), count(DISTINCT lower(btrim(email)))
  INTO allowlist_rows, normalized_rows
  FROM containment_platform_admins;

  SELECT count(*)
  INTO eligible_rows
  FROM containment_platform_admins a
  JOIN users u ON lower(u.email) = lower(btrim(a.email))
  WHERE u.status = 'active'
    AND u.mfa_enabled = true
    AND u.is_platform_admin = true;

  IF allowlist_rows < 2
     OR normalized_rows <> allowlist_rows
     OR eligible_rows <> allowlist_rows THEN
    RAISE EXCEPTION
      'containment requires at least two unique existing active MFA-enabled platform admins';
  END IF;
END
$$;
UPDATE users u
SET is_platform_admin = false, updated_at = now()
WHERE u.is_platform_admin = true
  AND NOT EXISTS (
    SELECT 1
    FROM containment_platform_admins a
    WHERE lower(btrim(a.email)) = lower(u.email)
  );
DO $$
BEGIN
  IF EXISTS (
    (SELECT lower(email) FROM users WHERE is_platform_admin = true
     EXCEPT
     SELECT lower(btrim(email)) FROM containment_platform_admins)
    UNION ALL
    (SELECT lower(btrim(email)) FROM containment_platform_admins
     EXCEPT
     SELECT lower(email) FROM users WHERE is_platform_admin = true)
  ) THEN
    RAISE EXCEPTION 'post-update platform-admin set differs from approved allowlist';
  END IF;
END
$$;
COMMIT;
SQL
```

Expected: the transaction aborts before demotion on a typo, case-normalized duplicate, inactive
user, missing MFA, non-admin allowlist entry, or post-set mismatch. Otherwise the update reports
only removed administrators. Restart only the API and verify the database platform-admin set
exactly matches the private allowlist. Do not assume the environment variable performed the
demotion.

- [ ] Review each recent export with the actor and ticket owner. Escalate an export without a matching approved request. Do not delete audit rows.

- [ ] Identify roles with `devices:execute`. Through the Roles UI/API, remove that permission from routine roles and retain it only for the approved managed-software operator role with MFA. If a role also authorizes unrelated command execution, clone it first and reassign only approved operators.

- [ ] Review configured managed-software download sources without downloading packages. Record normalized scheme, hostname classification, ownership, and approval status; do not record credentials, query strings, signed URLs, or package contents.

- [ ] Verify a routine user receives `403` for managed-software execution and an approved MFA operator can perform a no-op/canary action against a test device. Stop if the route does not enforce `devices:execute`; do not compensate with a UI-only restriction.

- [ ] Rollback re-promotes only a captured administrator who is separately reapproved, then restores that email to `BREEZE_PLATFORM_ADMINS`; it does not bulk-restore the before list. Role rollback restores the captured assignment through the Roles UI/API. Rollback never restores access for an account or source that the incident review marked unauthorized.

### Task 8: Review capability-bearing telemetry before rotating live links

**Files and interfaces:**

- Read: `apps/api/src/middleware/requestPathLogger.ts`
- Read: `apps/api/src/services/sentry.ts`
- Affected route classes from the approved design: quote, invite, provisioning, installer, and remote-access capability paths
- Telemetry systems: API/reverse-proxy logs, Sentry, Cloudflare logs, retained exports/backups

- [ ] Ask each telemetry owner to run a provider-side search for the affected route classes. Search results must return counts and retention ranges, not raw event bodies or token-bearing URLs.

- [ ] Restrict access to matching telemetry collections to the incident team and suspend downstream exports that copy raw request URLs. Record access-policy versions and retention dates.

- [ ] Purge matching raw URL/path fields only under the provider's documented deletion workflow. Preserve aggregate counts, incident timestamps, and deletion audit receipts. Do not download raw events into the repository.

- [ ] Only after retained copies are purged or access-restricted, rotate still-live customer-facing capabilities using their product-specific revocation path. Notify affected owners and preserve a support rollback for access, but never restore a capability known to be exposed.

- [ ] Acceptance: a provider-side exact-token probe using a newly issued test capability returns zero retained raw values outside the intentionally generated test event; incident evidence contains no token bytes.

### Task 9: Repair Unix agent-log symlinks and modes

**Files and interfaces:**

- Read: `agent/scripts/install/install-linux.sh` (`/var/log/breeze`)
- Read: `agent/scripts/install/install-darwin.sh` (`/Library/Logs/Breeze`)
- Required directory mode: `0700`
- Required regular-file mode: `0600`

- [ ] Canary on one Linux and one macOS device before fleet rollout. Capture owner, group, type, mode, and symlink target without reading file content.

```bash
sudo find /var/log/breeze -xdev -printf '%y %m %u %g %p -> %l\n'
sudo find -x /Library/Logs/Breeze -exec stat -f '%HT %Lp %Su %Sg %N' {} \;
```

Run only the command for the host OS. Expected: the log root exists and is owned by root; any symlink is an exception requiring review.

- [ ] Stop the Breeze agent service on the canary. For each symlink, determine whether its resolved target is an approved root-owned regular file inside the same log root. Remove an unapproved symlink only after recording the exact path and target; never follow it with `chmod`.

- [ ] Repair without following symlinks:

```bash
sudo find /var/log/breeze -xdev -type d -exec chmod 0700 {} +
sudo find /var/log/breeze -xdev -type f -exec chmod 0600 {} +
sudo find -x /Library/Logs/Breeze -type d -exec chmod 0700 {} +
sudo find -x /Library/Logs/Breeze -type f -exec chmod 0600 {} +
```

Run only the two commands for the host OS. Restart the agent and verify heartbeat, log creation, and command execution.

- [ ] Roll out by release ring with stop criteria: any failure to restart, heartbeat, write logs, or execute a canary command stops the ring. Modes may be restored from the captured manifest, but removed malicious/unapproved symlinks are never recreated.

### Task 10: Close Stage 0 and hand off to implementation waves

- [ ] Hash every evidence artifact and make the manifest read-only.

```bash
find "$BREEZE_CONTAINMENT_EVIDENCE" -type f ! -name SHA256SUMS -print0 |
  sort -z |
  xargs -0 shasum -a 256 \
  >"$BREEZE_CONTAINMENT_EVIDENCE/SHA256SUMS"
chmod -R go-rwx "$BREEZE_CONTAINMENT_EVIDENCE"
chmod a-w "$BREEZE_CONTAINMENT_EVIDENCE/SHA256SUMS"
shasum -a 256 -c "$BREEZE_CONTAINMENT_EVIDENCE/SHA256SUMS"
```

Expected: every hash verifies `OK`; no tracked file appears in `git status --short`.

- [ ] The incident owner and second operator sign the change record only when:
  - PR Anthropic execution is disabled and its key rotated;
  - signing is dark while unsigned builds remain available;
  - command-WebSocket mTLS is logging, not blocking;
  - the origin is not directly reachable outside approved paths;
  - certificate candidates are reconciled individually;
  - site-restricted report access is removed and schedules are paused without deletion;
  - tenant export and managed-software execution are restricted;
  - telemetry retention response is recorded; and
  - Unix canaries pass before ring rollout.

- [ ] Link the signed record to Wave 1, Wave 2, Wave 5, Wave 6, and Wave 7 implementation change tickets. Do not place incident artifacts or infrastructure details in those public changes.

- [ ] Keep each rollback available until its owning remediation wave is enforced. A rollback may restore availability, but must fail closed rather than restore an exposure or known-compromised credential.
