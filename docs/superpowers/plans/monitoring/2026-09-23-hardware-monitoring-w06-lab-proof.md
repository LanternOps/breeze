# Hardware & RAID Monitoring — W06 Lab Proof + Release Note Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove live Windows and Linux hardware collection, per-component alerting and recovery, record vendor coverage honestly, and prepare the agent release and feature closure evidence.

**Architecture:** Exercise the W01–W05 implementation through real agents, policy APIs, read-only SQL and the Hardware tab. W06 adds evidence and release documentation; a failed product assertion returns to its owning wave with the captured reproduction before this gate can pass. Keep credentials and unredacted transcripts in a private temporary directory, and commit only reviewed lab evidence and sanitized captures.

**Tech Stack:** PowerShell Storage/Hyper-V modules, Go 1.26.6, GNU Make, Debian mdadm/smartmontools, optional OpenZFS, Bash, curl, jq, PostgreSQL psql, Playwright, GitHub CLI, feature-lifecycle MCP.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`.
**Index:** `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring.md`.
**Wave:** W06, branch `feature/<parent#>-hardware-monitoring/wave-<sub#>` (feature-lifecycle fills these literal placeholders).
**Depends on:** W01, W02a, W02b, W03, W04 and W05 merged and running together on the tested commit.

## Global Constraints

- Agent code ships to customer machines: `go test -race ./...`, fixture-driven parser tests, a
  native Windows run on VM `.55` for W02a/W02b/W05 (cross-compile has missed test bugs before).
- Web: `fetchWithAuth` from `apps/web/src/stores/auth.ts`; no react-query; inline pill idiom
  (`bg-success/15 text-success border-success/30` etc.); `data-testid` on everything e2e touches;
  mutation handlers via `runAction` (only the config tab mutates).
- Files stay under ~500 lines; new code goes in new files next to the pattern it copies.
- Run the contract suites before every PR that touches tenancy:
  `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, the integration
  config (`vitest.integration.config.ts`) for cascade / export / merge, with `pnpm test-stack up`.

## Review Focus

The index assigns review-focus items 1 and 5 to W02a, item 2 to W01, and items 3 and 4 to W03; none is owned by W06. Task 1 pins their merged prerequisites and Task 18 reruns the agent suites; W06 does not claim that a two-disk lab covers 64-drive parsing, concurrent ingest, flapping, automation ownership, or hung-tool cancellation.

W06's owned index §J acceptance is pinned as follows:

- Windows VM `.55`: two VHDX disks → Storage Spaces mirror → dev-push agent → attach the four
  built-ins to a policy on the lab partner → pull a VHDX → expect `virtual_disk degraded` (critical)
  and `physical_disk missing` (high) alerts within 2 polls → reattach → both resolve. Tasks 2–5.
- Linux
  (container with loop devices): `mdadm --create /dev/md0 --level=1 --raid-devices=2` → `--fail` →
  degraded alert → `--remove`/`--add` → rebuilding (warning, no critical alert) → optimal → resolved. Tasks 6–7.
- Evidence (screenshots + alert ids) goes on the W06 issue; docs mark each vendor source
  `fixture-only` until a real capture lands. Tasks 8–19.

## File Structure

- Create `docs/superpowers/plans/monitoring/evidence/w06-environment.json` — tested commit and prerequisite PR identities, without credentials or infrastructure addresses.
- Create `docs/superpowers/plans/monitoring/evidence/w06-policy.json` — four monitor identities and device-only attachment proof.
- Create `docs/superpowers/plans/monitoring/evidence/w06-windows-baseline.json`, `w06-windows-degraded.json`, `w06-windows-recovered.json`, `w06-policy-toggle.json` in that directory — Windows accepted observations and alert IDs.
- Create `docs/superpowers/plans/monitoring/evidence/w06-linux-baseline.json`, `w06-linux-degraded.json`, `w06-linux-rebuilding.json`, `w06-linux-recovered.json`, `w06-zfs.json` there — Linux observations and optional-ZFS outcome.
- Create `docs/superpowers/plans/monitoring/evidence/w06-windows-baseline.png`, `w06-windows-degraded.png`, `w06-windows-recovered.png`, `w06-policy-disabled.png`, `w06-linux-baseline.png`, `w06-linux-degraded.png`, `w06-linux-rebuilding.png`, `w06-linux-recovered.png` — cropped live Hardware sections.
- Create `docs/superpowers/plans/monitoring/evidence/w06-storcli.json`, `w06-perccli.json`, `w06-megacli.json`, `w06-ssacli.json`, `w06-arcconf.json`, `w06-omreport.json`, `w06-ipmi.json`, `w06-racadm.json`, `w06-hponcfg.json` — capture manifests or explicit fixture-only records.
- Create capture files under `agent/internal/collectors/hwhealth/testdata/{storcli,perccli,megacli,ssacli,arcconf,omreport,ipmi,racadm,hponcfg}/` only when a real sanitized capture exists; exact filenames appear in Tasks 9–17.
- Modify `apps/docs/src/content/docs/features/hardware-monitoring.mdx` — W04-created file, index §G; append the W06 verification table, never replace its supported-tools table. It does not exist in this checkout, so no pre-existing line anchor is claimed.
- Modify `docs/release-notes/next-release-draft.md:15,19` — agent release gate and user-visible upgrade note.
- Create `docs/superpowers/plans/monitoring/evidence/w06-release-request.md`, `w06-release-validation.json`, `w06-close-checklist.md` — release handoff, test result, and closure evidence index.
- Tests and operational scripts in this plan are created under `$LAB`, a private `mktemp` directory, and run against the live stack. They are not shipped product files. The `review_evidence` helper, transient SQL/PowerShell scripts and capture sanitizer are defined in full below. The evidence files are the task outputs; red means the claimed observation has not yet been demonstrated.

## Execution decisions and source anchors

This document is the only file written while planning. All commands below are future execution instructions.
Before every evidence commit, run `review_evidence` on its JSON files and visually open each PNG to confirm no credentials or internal addresses are present. The helper sanitizes before the first commit, never after sensitive history has been created. Keep UUIDs and subject keys unchanged; use neutral serials only when they are not part of keys.

Run Bash from the repo root; commands in a task share the shell and source `$LAB/env.sh` and then `$LAB/lib.sh` after a shell restart (retain the private `$LAB` directory path). Runtime inputs are read, validated and persisted privately; they are not guessed IDs or replacement tokens. No lab command targets an existing customer array.

Use the designated Server 2022 VM `.55` through its administrator SSH login supplied in the wave brief. Enter that SSH target at Task 1's prompt; keep the address in private runtime state rather than committing an internal mapping. Use a dedicated Debian VM with root SSH, Go 1.26.6 on PATH (`agent/go.mod:3`), loop devices, systemd, a registered lab agent, and a disposable SMART-capable disk passed through. A container is acceptable only if it has those capabilities and exclusive ownership of its loop devices; a bare loop image cannot prove SMART support.

A prepared worktree stack and two agents already enrolled to that stack are prerequisites. If absent, use `.claude/skills/worktree-stack/SKILL.md:10–24` (`pnpm wt-stack up`) and the existing installer; record ownership so Task 19 tears down only stacks this run created. Remote `server_url` must reach this stack through an existing lab gateway; localhost in `.breeze-stack.json` is only the operator-side URL. Do not re-enroll production devices or invent a public gateway in this plan.

Source audit: `agent/README.md` is absent. Dev-push documentation is `.claude/skills/agent-info/SKILL.md:202–231` and `docs/remote-desktop-performance/README.md:71–86`; the authoritative target is `agent/Makefile:242–294`. It builds and uploads; `DEVICE` is passed as multipart `agentId` at line 291. `apps/api/src/routes/devPush.ts:61–66` resolves by agent ID, and lines 172–205 construct the download URL from `PUBLIC_API_URL` and return `wsSent`, `version`, `agentId`, `deviceId`. Set explicit `PLATFORM` to bypass the Makefile's UUID-only device GET. Preserve `hwhealth_state.json` across dev-push; resetting the sequence can cause 409 for one hour (index §D).

The index's package, view, and built-ins are future prerequisites, not existing symbols in this checkout: `hwhealth/` is absent; `builtInMonitors.ts:38` is version 2. W06 creates none of those implementation symbols. It consumes index §C `PUT /api/v1/agents/:agentId/hardware-health`, §D `GET /api/v1/devices/:id/hardware-health`, §F `alerts.subject_key`, and §H `Collector.Run` indirectly through the real agent. A missing prerequisite blocks proof; do not seed fake health rows to pass.

Use 5-minute RAID and 15-minute disk intervals, both legal index §B values. Count two distinct accepted snapshots with `critical_streak >= 2`, not two executions of the minute sweep. The fault observer fails if no matching alert is visible before the third failing snapshot; its captured timeline must contain two distinct failing snapshot IDs. Bound each condition wait at 20 minutes (two 5-minute polls with jitter, a 4-minute collection budget and sweep lag); record actual elapsed times. Long waits are observed in 30-second increments so progress can be reported. Recovery under the critical built-in may occur during rebuilding after two below-critical observations; it need not remain active until optimal (§9.3).

## Task execution

### Task 1: Establish isolated lab identity and the evidence assertions

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-environment.json`. Read `scripts/dev/wt-stack/descriptor.ts:4–12`, `e2e-tests/README.md:3,136–150`, `apps/api/src/middleware/requestPathLogger.ts:13–31`. Test: `$LAB/test-environment.sh` (created here).

**Interfaces:** Consumes `.breeze-stack.json` fields `project`, `baseUrl`, `pgContainer`; W01–W05 merged PRs. Produces shell functions `review_evidence(paths...)`, `push_receipt(transcript, deviceId, agentId)`, `api(method, path, body?)`, `sql(query)`, `view(deviceId)`, `alerts_for(deviceId)`, `await_jq(deviceId, expression, output)`, `winps()` and `shot(deviceId, name)`; private variables used by later tasks.

- [ ] **Step 1: Write the failing lab assertion (3 minutes).**

```bash
export LAB="$(mktemp -d "${TMPDIR:-/tmp}/breeze-hw-w06.XXXXXX")"
chmod 700 "$LAB"
export EVIDENCE="$PWD/docs/superpowers/plans/monitoring/evidence"
mkdir -p "$EVIDENCE"
cat > "$LAB/test-environment.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
jq -e '(.commit|test("^[0-9a-f]{40}$")) and
  (.prerequisites|length == 6) and
  ([.prerequisites[].state]|all(. == "MERGED")) and
  (.devices|length == 2) and .sameLabPartner' "$EVIDENCE/w06-environment.json"
echo 'PASS lab identity and six merged prerequisites'
SH
bash "$LAB/test-environment.sh"
```

Expected red: `Could not open file ... w06-environment.json`; never overwrite evidence from an earlier run without retaining its issue link.

- [ ] **Step 2: Acquire validated runtime inputs and create the helpers (5 minutes).**

```bash
set -euo pipefail
export ROOT="$PWD"
export API_URL="$(jq -er .baseUrl .breeze-stack.json)"
export PG_CONTAINER="$(jq -er .pgContainer .breeze-stack.json)"
export PROJECT="$(jq -er .project .breeze-stack.json)"
export API_CONTAINER="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=api)"
read -r -p 'Windows administrator SSH target for assigned VM .55: ' WIN_SSH
read -r -p 'Dedicated Debian root SSH target: ' LINUX_SSH
read -r -p 'Windows device UUID in this stack: ' WIN_ID
read -r -p 'Linux device UUID in this stack: ' LINUX_ID
read -r -p 'Lab partner UUID: ' PARTNER_ID
read -r -s -p 'MFA-authenticated lab partner admin JWT: ' LAB_TOKEN
printf '\n'
read -r -p 'Parent feature issue number: ' FEATURE_ISSUE
read -r -p 'W06 issue number: ' WAVE_ISSUE
read -r -p 'Six merged PR numbers, W01 W02a W02b W03 W04 W05: ' -a PRS
read -r -p 'Existing Playwright lab login storage-state absolute path: ' STORAGE_STATE
read -r -p 'Did this run create the worktree stack? true/false: ' OWNS_STACK
read -r -p 'Private reviewed JSON map of infrastructure strings to neutral replacements: ' REDACTION_MAP
export REDACTION_MAP
export WIN_SSH LINUX_SSH WIN_ID LINUX_ID PARTNER_ID LAB_TOKEN FEATURE_ISSUE WAVE_ISSUE STORAGE_STATE OWNS_STACK
export STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - <<'PY'
import os, uuid
for key in ('WIN_ID','LINUX_ID','PARTNER_ID'): uuid.UUID(os.environ[key])
for key in ('FEATURE_ISSUE','WAVE_ISSUE'): assert int(os.environ[key]) > 0
assert os.environ['WIN_ID'] != os.environ['LINUX_ID']
assert os.environ['WIN_SSH'].startswith('administrator@')
assert os.path.isfile(os.environ['STORAGE_STATE'])
assert os.environ['OWNS_STACK'] in ('true','false')
PY
cat > "$LAB/lib.sh" <<'SH'
api() {
  local method="$1" path="$2"
  if [ "$#" -eq 3 ]; then
    curl --fail-with-body -sS -X "$method" "$API_URL/api/v1$path" \
      -H "Authorization: Bearer $LAB_TOKEN" -H 'Content-Type: application/json' --data "$3"
  else
    curl --fail-with-body -sS -X "$method" "$API_URL/api/v1$path" -H "Authorization: Bearer $LAB_TOKEN"
  fi
}
sql() {
  { printf '%s\n' 'BEGIN READ ONLY;' "SET LOCAL breeze.scope = 'system';"
    printf '%s\n' "$1" 'COMMIT;'
  } | docker exec -i "$PG_CONTAINER" psql -XqAt -v ON_ERROR_STOP=1 -U breeze -d breeze
}
view() { api GET "/devices/$1/hardware-health"; }
alerts_for() {
  sql "SELECT coalesce(json_agg(x),'[]'::json) FROM (
    SELECT a.id,a.subject_key,a.status,a.severity,a.triggered_at,a.resolved_at,m.builtin_key
    FROM alerts a JOIN monitor_definitions m ON m.id=a.monitor_id
    WHERE a.device_id='$1'::uuid AND a.triggered_at>='$STARTED_AT'::timestamptz
      AND m.partner_id='$PARTNER_ID'::uuid AND m.kind='hardware_health'
    ORDER BY a.triggered_at,a.subject_key) x;"
}
await_jq() {
  local device="$1" expression="$2" output="$3" deadline=$((SECONDS+1200))
  while (( SECONDS < deadline )); do
    view "$device" > "$output"
    if jq -e "$expression" "$output" >/dev/null; then return 0; fi
    printf 'Waiting for accepted hardware observation (%ss remain)\n' "$((deadline-SECONDS))"
    sleep 30
  done
  echo 'FAIL hardware observation deadline exceeded' >&2
  return 1
}
winps() {
  local encoded
  encoded="$(python3 -c 'import sys,base64; print(base64.b64encode(sys.stdin.read().encode("utf-16le")).decode())')"
  ssh "$WIN_SSH" "powershell.exe -NoProfile -NonInteractive -EncodedCommand $encoded"
}
shot() { (cd "$ROOT/e2e-tests" && node "$LAB/screenshot.cjs" "$1" "$2"); }
review_evidence() {
  python3 - "$@" <<'PYREVIEW'
import json,os,pathlib,sys,urllib.parse
mapping=json.load(open(os.environ['REDACTION_MAP']))
for arg in sys.argv[1:]:
    p=pathlib.Path(arg)
    if p.suffix!='.json': continue
    text=p.read_text()
    def identities(value):
        if isinstance(value,list): return [identities(v) for v in value]
        if not isinstance(value,dict): return None
        keep={'id','deviceId','agentId','componentKey','parentKey','subject_key','subjectKey'}
        return {k:(v if k in keep else identities(v)) for k,v in value.items()}
    before=identities(json.loads(text))
    for old,new in sorted(mapping.items(),key=lambda x:-len(x[0])):
        assert old and new and old!=new
        text=text.replace(old,new)
    forbidden=[os.environ['LAB_TOKEN']]
    for k in ('WIN_SSH','LINUX_SSH'): forbidden.append(os.environ[k].split('@')[-1])
    for k in ('API_URL','REMOTE_API_URL'):
        if os.environ.get(k): forbidden.append(urllib.parse.urlsplit(os.environ[k]).netloc)
    assert all(not value or value not in text for value in forbidden), 'Private identity still in '+arg
    assert not any(k in text for k in ('downloadToken','auth_token','secrets.yaml')), arg
    assert identities(json.loads(text))==before, 'Redaction changed evidence identities: '+arg
    p.write_text(text)
print('PASS structured evidence privacy guard; visually review every PNG before committing')
PYREVIEW
}
push_receipt() {
  python3 - "$1" "$2" "$3" <<'PYTEST'
import json,sys
text=open(sys.argv[1],encoding='utf-8-sig').read()
start=text.find('{'); assert start>=0, 'Missing dev-push JSON'
push,_=json.JSONDecoder().raw_decode(text[start:])
assert push['wsSent'] is True, 'dev_update was not delivered'
assert push['deviceId']==sys.argv[2] and push['agentId']==sys.argv[3]
assert push['version'].startswith('dev-')
print(json.dumps({k:push[k] for k in ('version','deviceId','agentId','wsSent','checksum')}))
PYTEST
}
SH
source "$LAB/lib.sh"
python3 - <<'PY'
import os, pathlib, shlex
names=('LAB','ROOT','EVIDENCE','API_URL','PG_CONTAINER','PROJECT','API_CONTAINER',
       'WIN_SSH','LINUX_SSH','WIN_ID','LINUX_ID','PARTNER_ID','LAB_TOKEN',
       'FEATURE_ISSUE','WAVE_ISSUE','STORAGE_STATE','STARTED_AT','OWNS_STACK','REDACTION_MAP')
p=pathlib.Path(os.environ['LAB'])/'env.sh'
p.write_text('\n'.join('export '+k+'='+shlex.quote(os.environ[k]) for k in names)+'\n')
p.chmod(0o600)
PY
```

Renew an expired JWT through the existing lab login and re-export `LAB_TOKEN`; do not extend or forge credentials for the long lab run. The token must carry this lab partner, full org access, `devices.write`, `devices.execute`, `alerts.read` and MFA; feature-link routes require MFA (`featureLinks.ts:392–398`). The dev-push route must be available: non-production, or `DEV_PUSH_ENABLED=true` on this isolated lab API (`devPush.ts:48–55`). A 401 means renew the token; 403/428 is a failed prerequisite, never a reason to bypass middleware.

- [ ] **Step 3: Implement the identity evidence and screenshot command (5 minutes).**

```bash
[ "${#PRS[@]}" -eq 6 ]
[ "$(printf '%s\n' "${PRS[@]}" | sort -u | wc -l | tr -d ' ')" -eq 6 ]
for pr in "${PRS[@]}"; do
  gh pr view "$pr" --json number,state,mergeCommit >> "$LAB/prs.jsonl"
done
for id in "$WIN_ID" "$LINUX_ID"; do api GET "/devices/$id" >> "$LAB/devices.jsonl"; done
same="$(sql "SELECT count(*)=2 AND bool_and(o.partner_id='$PARTNER_ID'::uuid)
  FROM devices d JOIN organizations o ON o.id=d.org_id
  WHERE d.id IN ('$WIN_ID'::uuid,'$LINUX_ID'::uuid);")"
[ "$same" = t ]
jq -n --arg commit "$(git rev-parse HEAD)" --slurpfile prs "$LAB/prs.jsonl" \
  --slurpfile devices "$LAB/devices.jsonl" \
  '{commit:$commit,prerequisites:$prs,sameLabPartner:true,devices:[$devices[]|{id,osType,agentVersion}]}' \
  > "$EVIDENCE/w06-environment.json"
for commit in $(jq -r '.prerequisites[].mergeCommit.oid' "$EVIDENCE/w06-environment.json"); do
  git merge-base --is-ancestor "$commit" HEAD
done
cat > "$LAB/screenshot.cjs" <<'JS'
const { createRequire } = require('node:module');
const req = createRequire(process.env.ROOT + '/e2e-tests/package.json');
const { chromium, expect } = req('@playwright/test');
(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: process.env.STORAGE_STATE });
    const page = await context.newPage();
    await page.goto(`${process.env.API_URL}/devices/${process.argv[2]}#hardware`);
    const section = page.getByTestId('hardware-storage-section');
    await expect(section).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('hardware-sources-footer')).toBeVisible();
    await section.screenshot({ path: `${process.env.EVIDENCE}/${process.argv[3]}.png` });
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
JS
bash "$LAB/test-environment.sh"
```

Expected green: `PASS lab identity and six merged prerequisites`. Screenshot selectors come from index §G; tab hash from `DeviceDetails.tsx:238–243,558,912`. Do not run globalSetup against customer data: use an existing lab login or Playwright codegen's `--save-storage` on this lab's login page.

- [ ] **Step 4: Commit only the reviewed receipt (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-environment.json
git add docs/superpowers/plans/monitoring/evidence/w06-environment.json
git commit -m $'test(monitoring): pin hardware lab prerequisites\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 2: Attach the four built-ins to a lab-only policy

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-policy.json`. Read `builtInMonitors.ts:38–49,143`, `routes/configurationPolicies/crud.ts:60–126`, `featureLinks.ts:320–387`, `assignments.ts:68–178`, `db/schema/monitorDefinitions.ts:118–141`. Test: `$LAB/test-policy.sh`.

**Interfaces:** Consumes Task 1 `api`, `sql`, lab UUIDs; W03 built-in keys from index §F. Produces `POLICY_ID`, `HW_LINK_ID` and `config_policy_monitors` attachments; hardware settings use `{enabled,pollIntervalMinutes,diskHealthIntervalMinutes}`.

- [ ] **Step 1: Write and run the failing attachment assertion (3 minutes).**

```bash
cat > "$LAB/test-policy.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
jq -e '.monitorKeys == ["cache_battery_problem","hardware_collector_failing","physical_disk_failed","raid_array_degraded"] and
  .assignments == 2 and .deviceOnly and .partnerOwned and .collection.enabled and
  .collection.pollIntervalMinutes == 5 and .collection.diskHealthIntervalMinutes == 15' "$EVIDENCE/w06-policy.json"
echo 'PASS four built-ins attached only to the two lab devices'
SH
bash "$LAB/test-policy.sh"
```

Expected red: missing `w06-policy.json`.

- [ ] **Step 2: Discover existing built-ins and attach through the real API (5 minutes).**

```bash
api GET '/monitor-definitions?kind=hardware_health' > "$LAB/monitors.json"
python3 - <<'PYTEST'
import json,os
rows=json.load(open(os.environ['LAB']+'/monitors.json'))['data']
expected={
 'raid_array_degraded':(['virtual_disk','controller'],'critical',False,2,'critical',60),
 'physical_disk_failed':(['physical_disk'],'critical',True,2,'high',60),
 'cache_battery_problem':(['cache_battery'],'warning',False,3,'medium',240),
 'hardware_collector_failing':(['collector'],'warning',False,3,'low',1440)}
for key,(types,health,predictive,count,severity,cooldown) in expected.items():
    found=[m for m in rows if m['partnerId']==os.environ['PARTNER_ID'] and m['builtinKey']==key]
    assert len(found)==1, key
    m=found[0]; c=m['condition']
    assert m['enabled'] and m['autoResolve'] and m['orgId'] is None and m['kind']=='hardware_health', key
    assert (sorted(c['componentTypes']),c['minHealth'],c['includePredictiveFailure'],c['consecutiveSnapshots'])==(sorted(types),health,predictive,count), key
    assert (m['severity'],m['cooldownMinutes'])==(severity,cooldown), key
PYTEST
jq --arg partner "$PARTNER_ID" '{featureType:"monitors",inlineSettings:{inheritance:"cumulative",items:[
  .data[]|select(.partnerId==$partner and .orgId==null and
    (.builtinKey=="raid_array_degraded" or .builtinKey=="physical_disk_failed" or
     .builtinKey=="cache_battery_problem" or .builtinKey=="hardware_collector_failing"))|
  {monitorId:.id,enabled:true}]}}' "$LAB/monitors.json" > "$LAB/attach.json"
jq -e '(.inlineSettings.items|length)==4 and ([.inlineSettings.items[].monitorId]|unique|length)==4' "$LAB/attach.json"
api POST '/configuration-policies' \
  '{"name":"Hardware monitoring W06 lab proof","ownerScope":"partner","status":"active"}' > "$LAB/policy.json"
export POLICY_ID="$(jq -er .id "$LAB/policy.json")"
jq -e --arg p "$PARTNER_ID" '.partnerId==$p and .orgId==null' "$LAB/policy.json"
api POST "/configuration-policies/$POLICY_ID/features" "$(cat "$LAB/attach.json")" > "$LAB/monitor-link.json"
api POST "/configuration-policies/$POLICY_ID/features" \
  '{"featureType":"hardware_monitoring","inlineSettings":{"enabled":true,"pollIntervalMinutes":5,"diskHealthIntervalMinutes":15}}' > "$LAB/hardware-link.json"
export HW_LINK_ID="$(jq -er .id "$LAB/hardware-link.json")"
for id in "$WIN_ID" "$LINUX_ID"; do
  body="$(jq -nc --arg id "$id" '{level:"device",targetId:$id,priority:1000}')"
  api POST "/configuration-policies/$POLICY_ID/assignments" "$body" >> "$LAB/assignments.jsonl"
done
printf 'export POLICY_ID=%q\nexport HW_LINK_ID=%q\n' "$POLICY_ID" "$HW_LINK_ID" >> "$LAB/env.sh"
```

No monitor provisioning shortcut: `ensureBuiltInMonitorsForPartner(partnerId: string, opts: { createdBy?: string | null; exec?: Executor } = {}): Promise<EnsureBuiltInMonitorsResult>` exists at `builtInMonitors.ts:143`; boot calls it. If the four rows are absent, fix the W03 deployment, not the lab data.

- [ ] **Step 3: Verify normalized attachment and persist evidence (3 minutes).**

```bash
sql "SELECT json_build_object('policyId',p.id,'partnerOwned',p.partner_id='$PARTNER_ID'::uuid AND p.org_id IS NULL,
  'assignments',(SELECT count(*) FROM config_policy_assignments a WHERE a.config_policy_id=p.id),
  'deviceOnly',(SELECT bool_and(a.level='device' AND a.target_id IN ('$WIN_ID'::uuid,'$LINUX_ID'::uuid))
    FROM config_policy_assignments a WHERE a.config_policy_id=p.id),
  'monitorKeys',(SELECT json_agg(m.builtin_key ORDER BY m.builtin_key)
    FROM config_policy_feature_links f JOIN config_policy_monitors x ON x.feature_link_id=f.id
    JOIN monitor_definitions m ON m.id=x.monitor_id WHERE f.config_policy_id=p.id AND x.enabled),
  'collection',json_build_object('enabled',s.enabled,'pollIntervalMinutes',s.poll_interval_minutes,
    'diskHealthIntervalMinutes',s.disk_health_interval_minutes))
 FROM configuration_policies p JOIN config_policy_feature_links h ON h.config_policy_id=p.id
 JOIN config_policy_hardware_monitoring_settings s ON s.feature_link_id=h.id
 WHERE p.id='$POLICY_ID'::uuid AND h.feature_type='hardware_monitoring';" > "$EVIDENCE/w06-policy.json"
bash "$LAB/test-policy.sh"
```

Expected green: `PASS four built-ins attached only to the two lab devices`. Before faults, both live views must eventually show `policy.enabled=true` and intervals `5/15`; Tasks 3 and 6 assert delivery.

- [ ] **Step 4: Commit the policy receipt (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-policy.json
git add docs/superpowers/plans/monitoring/evidence/w06-policy.json
git commit -m $'test(monitoring): record lab monitor attachment\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 3: Build on Windows, dev-push, and prove the mirror baseline

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-windows-baseline.json`, `w06-windows-baseline.png`. Read `agent/Makefile:250–294`, `agent/internal/config/config.go:190`, `apps/api/src/routes/devPush.ts:172–205`. Test: `$LAB/test-windows-baseline.sh`.

**Interfaces:** Consumes Task 1 helpers, Task 2 settings, index §A component types and §G test IDs. Produces native Windows test receipt, pool `BreezeW06Pool`, virtual disk `BreezeW06Mirror`, private VHD paths and baseline view.

- [ ] **Step 1: Write and run the failing baseline assertion (3 minutes).**

```bash
cat > "$LAB/test-windows-baseline.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
jq -e '.nativeTests and .putObserved and .push.wsSent and .push.version==.view.agentVersion and .view.policy.enabled and
  .view.pollIntervalMinutes==5 and .view.diskHealthIntervalMinutes==15 and
  ([.view.components[]|select(.source=="storage_spaces" and .componentType=="enclosure" and .name=="BreezeW06Pool")]|length)==1 and
  ([.view.components[]|select(.source=="storage_spaces" and .componentType=="virtual_disk" and .state=="optimal")]|length)>=1 and
  ([.view.components[]|select(.source=="storage_spaces" and .componentType=="physical_disk" and .state=="online")]|length)==2 and
  ([.view.components[]|select(.source=="windows_physical_disk")]|length)>0' "$EVIDENCE/w06-windows-baseline.json"
test -s "$EVIDENCE/w06-windows-baseline.png"
echo 'PASS Windows native build, PUT and pool/VD/two-member UI baseline'
SH
bash "$LAB/test-windows-baseline.sh"
```

Expected red: missing baseline receipt. This proof requires Windows `Get-PhysicalDisk` to expose the VHDs as poolable; inability to do so is a lab blocker, not permission to pool unrelated disks.

- [ ] **Step 2: Create exactly two disposable VHDX members (5 minutes).**

```bash
winps <<'PS'
$ErrorActionPreference='Stop'
if ((Get-CimInstance Win32_OperatingSystem).Caption -notmatch 'Server 2022') { throw 'Wrong Windows lab' }
Get-Command New-VHD,Mount-VHD,New-StoragePool,New-VirtualDisk | Out-Null
if (Test-Path C:\BreezeW06) { throw 'Existing W06 lab directory: inspect before rerun' }
New-Item C:\BreezeW06 -ItemType Directory | Out-Null
$paths=@('C:\BreezeW06\member-a.vhdx','C:\BreezeW06\member-b.vhdx')
foreach ($p in $paths) { New-VHD -Path $p -SizeBytes 8GB -Dynamic | Out-Null; Mount-VHD -Path $p }
$numbers=@($paths | ForEach-Object { (Get-VHD -Path $_ | Get-Disk).Number })
$pd=@(Get-PhysicalDisk -CanPool $true | Where-Object { [int]$_.DeviceId -in $numbers })
if ($pd.Count -ne 2) { throw 'The two new VHDX disks are not poolable; no other disk may be substituted' }
$sub=@(Get-StorageSubSystem | Where-Object FriendlyName -Like 'Windows Storage*')
if ($sub.Count -ne 1) { throw 'Ambiguous Storage Spaces subsystem' }
$pool=New-StoragePool -FriendlyName BreezeW06Pool -StorageSubsystemUniqueId $sub[0].UniqueId -PhysicalDisks $pd
$vd=$pool | New-VirtualDisk -FriendlyName BreezeW06Mirror -ResiliencySettingName Mirror -Size 4GB -ProvisioningType Fixed
$disk=$vd | Get-Disk
$disk | Initialize-Disk -PartitionStyle GPT -PassThru | New-Partition -UseMaximumSize -AssignDriveLetter |
  Format-Volume -FileSystem NTFS -NewFileSystemLabel BreezeW06 -Confirm:$false | Out-Null
Get-VirtualDisk -FriendlyName BreezeW06Mirror | Select-Object FriendlyName,HealthStatus,OperationalStatus | ConvertTo-Json
PS
```

Expected output contains `BreezeW06Mirror`, `Healthy`, `OK`; wait for initial allocation to finish before baseline. No `Reset-PhysicalDisk`, broad `Clear-Disk`, or wildcard formatting.

- [ ] **Step 3: Stage the exact commit and verify native test prerequisites (5 minutes).**

```bash
git archive HEAD agent > "$LAB/agent.tar"
scp "$LAB/agent.tar" "$WIN_SSH:C:/BreezeW06/agent.tar"
winps <<'PS' > "$LAB/windows-config.json"
$ErrorActionPreference='Stop'
Set-Location C:\BreezeW06
tar -xf agent.tar
if ($LASTEXITCODE -ne 0) { throw 'Source extraction failed' }
$cfg=Get-Content C:\ProgramData\Breeze\agent.yaml -Raw
$id=[regex]::Match($cfg,'(?m)^agent_id:\s*["'']?([a-fA-F0-9]{64})').Groups[1].Value
$url=[regex]::Match($cfg,'(?m)^server_url:\s*["'']?([^"''\s]+)').Groups[1].Value
if (!$id -or !$url) { throw 'Cannot read agent identity/server URL' }
if ($cfg -notmatch '(?m)^allow_dev_update:\s*true\s*$') { throw 'Set allow_dev_update: true in this lab agent config, then restart its service' }
@{agentId=$id;serverUrl=$url} | ConvertTo-Json -Compress
PS
export WIN_AGENT_ID="$(jq -er .agentId "$LAB/windows-config.json")"
[ "$(api GET "/devices/$WIN_ID" | jq -er .agentId)" = "$WIN_AGENT_ID" ]
export REMOTE_API_URL="$(docker exec "$API_CONTAINER" printenv PUBLIC_API_URL)"
python3 - <<'PY'
import json,os,urllib.parse
c=json.load(open(os.environ['LAB']+'/windows-config.json'))
a=urllib.parse.urlsplit(c['serverUrl']); b=urllib.parse.urlsplit(os.environ['REMOTE_API_URL'])
assert (a.scheme,a.netloc)==(b.scheme,b.netloc), 'PUBLIC_API_URL must match agent server_url origin'
PY
winps <<'PS' > "$LAB/windows-native.txt"
$ErrorActionPreference='Stop'
$env:PATH='C:\go-1.26.6\bin;C:\msys64\mingw64\bin;'+$env:PATH
Set-Location C:\BreezeW06\agent
& C:\go-1.26.6\bin\go.exe version
if ($LASTEXITCODE -ne 0) { throw 'Go unavailable' }
& C:\go-1.26.6\bin\go.exe test -race ./internal/collectors/hwhealth/...
if ($LASTEXITCODE -ne 0) { throw 'Native hwhealth tests failed' }
& C:\go-1.26.6\bin\go.exe test -race ./...
if ($LASTEXITCODE -ne 0) { throw 'Native agent suite failed' }
& C:\go-1.26.6\bin\go.exe vet ./...
if ($LASTEXITCODE -ne 0) { throw 'Native go vet failed' }
PS
```

Race tests require a native C compiler. If GNU Make, Git Bash, Python 3 or MinGW are missing, provision the lab toolchain before continuing; do not replace this with cross-compilation. The native commands can run asynchronously; inspect exit status, not the last log line.

- [ ] **Step 4: Deliver with the actual on-box Make target and collect the receipt (5 minutes plus polling).**

```bash
python3 - <<'PY'
import os,shlex,pathlib
p=pathlib.Path(os.environ['LAB'])/'push.env'
p.write_text('\n'.join('export '+k+'='+shlex.quote(v) for k,v in {
 'AGENT_ID':os.environ['WIN_AGENT_ID'],'AUTH_TOKEN':os.environ['LAB_TOKEN'],
 'API_URL':os.environ['REMOTE_API_URL']}.items())+'\n')
p.chmod(0o600)
PY
scp "$LAB/push.env" "$WIN_SSH:C:/BreezeW06/push.env"
winps <<'PS' > "$LAB/windows-push.txt"
$ErrorActionPreference='Stop'
& 'C:\Program Files\Git\bin\bash.exe' -lc 'set -euo pipefail; export PATH=/c/go-1.26.6/bin:/c/msys64/mingw64/bin:/c/msys64/usr/bin:$PATH; source /c/BreezeW06/push.env; cd /c/BreezeW06/agent; make dev-push DEVICE="$AGENT_ID" PLATFORM=windows/amd64 API_URL="$API_URL" AUTH_TOKEN="$AUTH_TOKEN"'
$code=$LASTEXITCODE
Remove-Item C:\BreezeW06\push.env
if ($code -ne 0) { throw 'dev-push failed' }
PS
push_receipt "$LAB/windows-push.txt" "$WIN_ID" "$WIN_AGENT_ID" > "$LAB/windows-push-receipt.json"
WIN_PUSH_VERSION="$(jq -er .version "$LAB/windows-push-receipt.json")"
await_jq "$WIN_ID" ".agentVersion==\"$WIN_PUSH_VERSION\"" "$LAB/windows-installed.json"
await_jq "$WIN_ID" '.policy.enabled and .pollIntervalMinutes==5 and .diskHealthIntervalMinutes==15 and
  ([.components[]|select(.source=="storage_spaces" and .componentType=="virtual_disk" and .state=="optimal")]|length)>0' "$LAB/windows-view.json"
docker logs --since "$STARTED_AT" "$API_CONTAINER" > "$LAB/api.log" 2>&1
rg -- '--> PUT route=/api/v1/agents/:agentId/hardware-health status=200' "$LAB/api.log"
shot "$WIN_ID" w06-windows-baseline
jq -n --slurpfile view "$LAB/windows-view.json" --slurpfile push "$LAB/windows-push-receipt.json" '{nativeTests:true,putObserved:true,push:$push[0],view:$view[0]}' > "$EVIDENCE/w06-windows-baseline.json"
bash "$LAB/test-windows-baseline.sh"
```

Expected green: baseline PASS and `ok .../hwhealth` in the native transcript. The executable receipt asserts `wsSent`, both device identities and installed version; a Make pipeline's success message alone is not installation proof. The route-template log proves transport availability; the matching installed version and per-device view prove this Windows device was ingested. Do not claim the redacted log alone identifies the agent. Keep the download token/private path out of evidence. Inspect the PNG: pool, virtual disk and two physical rows must be visible; inspect JSON for pool/VD member identity agreement.

- [ ] **Step 5: Commit baseline proof (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-windows-baseline.json
git add docs/superpowers/plans/monitoring/evidence/w06-windows-baseline.json docs/superpowers/plans/monitoring/evidence/w06-windows-baseline.png
git commit -m $'test(monitoring): prove native Windows mirror collection\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 4: Pull and restore a Windows member, proving subject alerts

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-windows-degraded.json`, `w06-windows-recovered.json`, `w06-windows-degraded.png`, `w06-windows-recovered.png`. Test: `$LAB/test-windows-fault.sh`, `$LAB/test-windows-recovery.sh`. Read `db/schema/alerts.ts:115–150`; `subject_key` is supplied by W03 index §F.

**Interfaces:** Consumes Task 3 mirror and `view`; produces `await_alerts(deviceId, expression, output)` and two durable alert IDs whose `subject_key` equals the physical/virtual component key.

- [ ] **Step 1: Write and run the live fault assertion before pulling a disk (3 minutes).**

```bash
cat > "$LAB/test-windows-fault.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
view "$WIN_ID" > "$LAB/windows-fault-view.json"
alerts_for "$WIN_ID" > "$LAB/windows-fault-alerts.json"
jq -e '[.components[]|select(.source=="storage_spaces" and .componentType=="virtual_disk" and
  .state=="degraded" and .health=="critical" and .criticalStreak>=2)]|length==1' "$LAB/windows-fault-view.json"
jq -e '[.components[]|select(.source=="storage_spaces" and .componentType=="physical_disk" and
  .state=="missing" and .health=="critical" and .criticalStreak>=2 and .stale==false)]|length==1' "$LAB/windows-fault-view.json"
jq -e '[.[]|select(.status=="active" and
  ((.builtin_key=="raid_array_degraded" and .severity=="critical") or
   (.builtin_key=="physical_disk_failed" and .severity=="high")))] as $a |
  ($a|length)==2 and ([$a[].subject_key]|unique|length)==2' "$LAB/windows-fault-alerts.json"
jq -en --slurpfile v "$LAB/windows-fault-view.json" --slurpfile a "$LAB/windows-fault-alerts.json" \
  '[$a[0][]|select(.status=="active")|.subject_key] - [$v[0].components[].componentKey] | length==0'
echo 'PASS Windows two per-subject alerts from two accepted failing observations'
SH
bash "$LAB/test-windows-fault.sh"
```

Expected red: first jq emits `false`, exit 1; this is the healthy baseline, not a missing file failure.

- [ ] **Step 2: Remove only member B and observe two accepted failures (3 minutes plus polling).**

```bash
cat >> "$LAB/lib.sh" <<'SH'
await_alerts() {
  local device="$1" expression="$2" output="$3" deadline=$((SECONDS+1200))
  while (( SECONDS < deadline )); do
    alerts_for "$device" > "$output"
    if jq -e "$expression" "$output" >/dev/null; then return 0; fi
    sleep 30
  done
  echo 'FAIL alert sweep deadline exceeded' >&2; return 1
}
observe_fault() {
  local device="$1" source="$2" prefix="$3" deadline=$((SECONDS+1200))
  : > "$LAB/$prefix-timeline.jsonl"
  while (( SECONDS < deadline )); do
    view "$device" > "$LAB/$prefix-view.json"
    alerts_for "$device" > "$LAB/$prefix-alerts.json"
    jq --arg source "$source" '[.components[]|select(.source==$source and
      (.componentType=="virtual_disk" or ($source=="storage_spaces" and .componentType=="physical_disk" and .state=="missing")))|
      {componentKey,health,criticalStreak}]' "$LAB/$prefix-view.json" > "$LAB/fault-subjects.json"
    sql "SELECT json_build_object('sequence',last_agent_sequence,'snapshotId',last_snapshot_id,'receivedAt',last_received_at)
      FROM device_hardware_health WHERE device_id='$device'::uuid;" > "$LAB/fault-snapshot.json"
    jq -nc --slurpfile s "$LAB/fault-snapshot.json" --slurpfile c "$LAB/fault-subjects.json"       --slurpfile a "$LAB/$prefix-alerts.json" '{snapshot:$s[0],subjects:$c[0],alerts:$a[0]}' >> "$LAB/$prefix-timeline.jsonl"
    # A sweep must create alerts after accepted failure #2, before failure #3.
    if jq -e 'any(.criticalStreak>2)' "$LAB/fault-subjects.json" >/dev/null; then
      echo 'FAIL alert missed two-poll deadline' >&2; return 1
    fi
    if jq -en --arg source "$source" --slurpfile c "$LAB/fault-subjects.json" --slurpfile a "$LAB/$prefix-alerts.json" '
      ($c[0]|length)==(if $source=="storage_spaces" then 2 else 1 end) and
      ($c[0]|all(.health=="critical" and .criticalStreak==2)) and
      ([$c[0][].componentKey] - [$a[0][]|select(.status=="active")|.subject_key]|length)==0' >/dev/null; then
      jq -se '[.[]|select(any(.subjects[]; .health=="critical"))|.snapshot.snapshotId]|unique|length>=2' "$LAB/$prefix-timeline.jsonl" >/dev/null
      return 0
    fi
    sleep 30
  done
  echo 'FAIL fault observation deadline exceeded' >&2; return 1
}
SH
source "$LAB/lib.sh"
winps <<'PS'
$ErrorActionPreference='Stop'
Dismount-VHD -Path C:\BreezeW06\member-b.vhdx
Get-VirtualDisk -FriendlyName BreezeW06Mirror | Select-Object HealthStatus,OperationalStatus | ConvertTo-Json
PS
observe_fault "$WIN_ID" storage_spaces windows-fault
bash "$LAB/test-windows-fault.sh"
shot "$WIN_ID" w06-windows-degraded
jq -n --slurpfile v "$LAB/windows-fault-view.json" --slurpfile a "$LAB/windows-fault-alerts.json" \
  --slurpfile timeline "$LAB/windows-fault-timeline.jsonl" '{view:$v[0],alerts:$a[0],timeline:$timeline}' > "$EVIDENCE/w06-windows-degraded.json"
```

Expected green: two distinct subject keys, severities critical/high. Capture the Storage Spaces raw `Get-PhysicalDisk` output privately if a missing member disappears instead of reporting `missing`; mark the test failed and return that reproduction to W02a. Stale absence must not be relabelled a passing missing-member alert (§7.3).

- [ ] **Step 3: Write and run the recovery assertion before restoring the disk (3 minutes).**

```bash
cat > "$LAB/test-windows-recovery.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
view "$WIN_ID" > "$LAB/windows-recovery-view.json"
alerts_for "$WIN_ID" > "$LAB/windows-recovery-alerts.json"
jq -e '[.components[]|select(.source=="storage_spaces" and .componentType=="virtual_disk" and
  .state=="optimal" and .healthyStreak>=2)]|length==1' "$LAB/windows-recovery-view.json"
jq -en --slurpfile before "$EVIDENCE/w06-windows-degraded.json" --slurpfile after "$LAB/windows-recovery-alerts.json" \
  '[$before[0].alerts[]|select(.status=="active")|.id] as $ids |
   [$after[0][]|select(.id as $id|$ids|index($id))] as $r |
   ($r|length)==2 and ($r|all(.status=="resolved" and .resolved_at!=null))'
echo 'PASS both original Windows alert IDs resolved automatically'
SH
bash "$LAB/test-windows-recovery.sh"
```

Expected red: jq `false`, exit 1 while disk B is absent.

- [ ] **Step 4: Reattach, allow repair, and verify recovery (3 minutes plus polling).**

```bash
winps <<'PS'
$ErrorActionPreference='Stop'
Mount-VHD -Path C:\BreezeW06\member-b.vhdx
Update-StorageProviderCache
Repair-VirtualDisk -FriendlyName BreezeW06Mirror
Get-StorageJob | Select-Object Name,JobState,PercentComplete | ConvertTo-Json
PS
await_jq "$WIN_ID" '[.components[]|select(.source=="storage_spaces" and .componentType=="virtual_disk" and .state=="optimal" and .healthyStreak>=2)]|length==1' "$LAB/windows-recovery-view.json"
await_alerts "$WIN_ID" '[.[]|select(.builtin_key=="raid_array_degraded" or .builtin_key=="physical_disk_failed")]|length>=2 and all(.status=="resolved")' "$LAB/windows-recovery-alerts.json"
bash "$LAB/test-windows-recovery.sh"
shot "$WIN_ID" w06-windows-recovered
jq -n --slurpfile v "$LAB/windows-recovery-view.json" --slurpfile a "$LAB/windows-recovery-alerts.json" \
  '{view:$v[0],alerts:$a[0]}' > "$EVIDENCE/w06-windows-recovered.json"
```

Expected green: the same two IDs resolve without manual alert mutations. Record elapsed time from the evidence timestamps, and retain degraded/recovered view timestamps to establish the two-poll cadence.

- [ ] **Step 5: Commit Windows fault/recovery proof (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-windows-degraded.json docs/superpowers/plans/monitoring/evidence/w06-windows-recovered.json
git add docs/superpowers/plans/monitoring/evidence/w06-windows-degraded.json docs/superpowers/plans/monitoring/evidence/w06-windows-recovered.json docs/superpowers/plans/monitoring/evidence/w06-windows-degraded.png docs/superpowers/plans/monitoring/evidence/w06-windows-recovered.png
git commit -m $'test(monitoring): prove Windows subject alert recovery\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 5: Prove policy disablement stops and resumes collection

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-policy-toggle.json`, `w06-policy-disabled.png`. Read `featureLinks.ts:391–398,617`; W01 implements index §E settings resolver, Redis TTL and heartbeat delivery. Test: `$LAB/test-disabled.sh`.

**Interfaces:** Consumes `POLICY_ID`, `HW_LINK_ID`, `api`, `view`; produces a disabled observation followed by a stable observation window and resumed collection. Never edits alert state or component streaks directly.

- [ ] **Step 1: Write and run the disabled-state assertion (2 minutes).**

```bash
cat > "$LAB/test-disabled.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
view "$WIN_ID" > "$LAB/disabled-first.json"
jq -e '.policy.enabled==false and .tiersRun==["disabled"] and
  ([.sources[]|select(.status=="disabled")]|length)>0' "$LAB/disabled-first.json"
echo 'PASS disabled snapshot received'
SH
bash "$LAB/test-disabled.sh"
```

Expected red: jq `false` while collection is enabled.

- [ ] **Step 2: Disable through the policy API and wait for propagation (2 minutes plus polling).**

```bash
api PATCH "/configuration-policies/$POLICY_ID/features/$HW_LINK_ID" \
  '{"inlineSettings":{"enabled":false,"pollIntervalMinutes":5,"diskHealthIntervalMinutes":15}}' > "$LAB/disable-response.json"
await_jq "$WIN_ID" '.policy.enabled==false and .tiersRun==["disabled"]' "$LAB/disabled-first.json"
bash "$LAB/test-disabled.sh"
shot "$WIN_ID" w06-policy-disabled
```

Expected green: disabled snapshot. Allow the 120-second cache TTL, heartbeat and tick gate before starting the quiet-window timer; an in-flight collection may finish before this marker (§6.3, §10).

- [ ] **Step 3: Assert a quiet window and resumed collection (5 minutes of active work).**

```bash
# Observe 12 minutes (two 5-minute polls with +10% jitter); report progress every 30 seconds.
for i in $(seq 1 24); do
  sleep 30
  view "$WIN_ID" > "$LAB/disabled-current.json"
  jq -en --slurpfile a "$LAB/disabled-first.json" --slurpfile b "$LAB/disabled-current.json" \
    '$a[0].lastReceivedAt==$b[0].lastReceivedAt and
     ([$a[0].components[]|select(.componentType!="collector")|{componentKey,state,stale,lastSeenAt,healthyStreak,criticalStreak}]|sort_by(.componentKey)) ==
     ([$b[0].components[]|select(.componentType!="collector")|{componentKey,state,stale,lastSeenAt,healthyStreak,criticalStreak}]|sort_by(.componentKey))'
  printf 'Disabled quiet window: %s/24 observations\n' "$i"
done
api PATCH "/configuration-policies/$POLICY_ID/features/$HW_LINK_ID" \
  '{"inlineSettings":{"enabled":true,"pollIntervalMinutes":5,"diskHealthIntervalMinutes":15}}' > "$LAB/enable-response.json"
old="$(jq -r .lastReceivedAt "$LAB/disabled-first.json")"
await_jq "$WIN_ID" ".policy.enabled and .lastReceivedAt != \"$old\" and (.tiersRun|index(\"raid\")!=null)" "$LAB/enabled-again.json"
jq -n --slurpfile a "$LAB/disabled-first.json" --slurpfile b "$LAB/disabled-current.json" \
  --slurpfile c "$LAB/enabled-again.json" \
  '{disabled:$a[0],quietEnd:$b[0],resumed:$c[0],quietWindowSeconds:720}' > "$EVIDENCE/w06-policy-toggle.json"
jq -e '.quietWindowSeconds==720 and .disabled.lastReceivedAt==.quietEnd.lastReceivedAt and
 .resumed.policy.enabled and .resumed.lastReceivedAt!=.disabled.lastReceivedAt' "$EVIDENCE/w06-policy-toggle.json"
```

Expected green: final `true`, no accepted periodic snapshots while disabled, unchanged hardware streaks, and a later accepted RAID snapshot after enablement. This tests stopping reporting and preserves component data; it does not assert that disabled hardware is healthy. No tooling-process observation is inferred solely from the UI: use the native agent log privately if snapshots continue or vendor commands still execute.

- [ ] **Step 4: Commit toggle proof (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-policy-toggle.json
git add docs/superpowers/plans/monitoring/evidence/w06-policy-toggle.json docs/superpowers/plans/monitoring/evidence/w06-policy-disabled.png
git commit -m $'test(monitoring): prove hardware policy pause and resume\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 6: Build the Debian md mirror and prove standalone SMART rows

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-linux-baseline.json`, `w06-linux-baseline.png`. Read `agent/Makefile:242–294`, index §H `mdadm_linux.go`, `smartctl.go` (created by W02a). Test: `$LAB/test-linux-baseline.sh`.

**Interfaces:** Consumes Task 1 root SSH, registered Linux device, Task 2 settings. Produces `/dev/md0`, two exclusively owned loop devices, native Linux test results and a real `smartctl` standalone row. No hardware state is inserted via SQL.

- [ ] **Step 1: Write and run the baseline assertion (3 minutes).**

```bash
cat > "$LAB/test-linux-baseline.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
view "$LINUX_ID" > "$LAB/linux-baseline-view.json"
jq -e '.policy.enabled and .pollIntervalMinutes==5 and .diskHealthIntervalMinutes==15 and
  ([.components[]|select(.source=="mdadm" and .componentKey=="mdadm:md0" and .state=="optimal")]|length)==1 and
  ([.components[]|select(.source=="mdadm" and .componentType=="physical_disk")]|length)==2 and
  ([.components[]|select(.source=="smartctl" and .componentType=="physical_disk" and .stale==false)]|length)>0' "$LAB/linux-baseline-view.json"
echo 'PASS Linux mirror and real standalone SMART row'
SH
bash "$LAB/test-linux-baseline.sh"
```

Expected red: jq false or GET `404 {error:"no_hardware_health"}` before deployment.

- [ ] **Step 2: Create the disposable loop-backed mirror (5 minutes).**

```bash
ssh "$LINUX_SSH" 'bash -se' <<'SH'
set -euo pipefail
[ "$(id -u)" -eq 0 ]
. /etc/os-release
[ "$ID" = debian ]
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y mdadm smartmontools make gcc jq python3
[ ! -e /var/tmp/breeze-w06 ]
[ ! -b /dev/md0 ]
mkdir -m 700 /var/tmp/breeze-w06
truncate -s 4G /var/tmp/breeze-w06/member-a.img
truncate -s 4G /var/tmp/breeze-w06/member-b.img
a=$(losetup --find --show /var/tmp/breeze-w06/member-a.img)
b=$(losetup --find --show /var/tmp/breeze-w06/member-b.img)
printf 'LOOP_A=%q\nLOOP_B=%q\n' "$a" "$b" > /var/tmp/breeze-w06/loops.env
mdadm --create /dev/md0 --level=1 --raid-devices=2 --metadata=1.2 --name=breeze-w06 --run "$a" "$b"
mdadm --wait /dev/md0
mdadm --detail /dev/md0
smartctl --scan-open -j > /var/tmp/breeze-w06/smart-scan.json
jq -e '.devices|length>0' /var/tmp/breeze-w06/smart-scan.json
SH
```

Expected `State : clean`, two active devices, SMART scan `true`. If SMART scan is empty, pass through the dedicated test disk to this VM and repeat the scan; smartctl being installed is not SMART evidence. Loop devices must be identified by their persistent md membership identity per index §B/§H; unstable `/dev/loopN` component keys are a W02a failure.

- [ ] **Step 3: Test and dev-push the exact source on Linux (5 minutes plus test runtime).**

```bash
scp "$LAB/agent.tar" "$LINUX_SSH:/var/tmp/breeze-w06/agent.tar"
ssh "$LINUX_SSH" 'bash -se' <<'SH' > "$LAB/linux-native.txt"
set -euo pipefail
cd /var/tmp/breeze-w06
tar -xf agent.tar
cd agent
go version
go test -race ./internal/collectors/hwhealth/...
go test -race ./...
go vet ./...
SH
export LINUX_AGENT_ID="$(api GET "/devices/$LINUX_ID" | jq -er .agentId)"
python3 - <<'PY'
import os,pathlib,shlex
p=pathlib.Path(os.environ['LAB'])/'linux-push.env'
p.write_text('\n'.join('export '+k+'='+shlex.quote(v) for k,v in {
 'AGENT_ID':os.environ['LINUX_AGENT_ID'],'AUTH_TOKEN':os.environ['LAB_TOKEN'],
 'API_URL':os.environ['REMOTE_API_URL']}.items())+'\n')
p.chmod(0o600)
PY
scp "$LAB/linux-push.env" "$LINUX_SSH:/var/tmp/breeze-w06/push.env"
ssh "$LINUX_SSH" 'bash -se' <<'SH' > "$LAB/linux-push.txt"
set -euo pipefail
source /var/tmp/breeze-w06/push.env
trap 'rm -f /var/tmp/breeze-w06/push.env' EXIT
python3 - "$API_URL" "$AGENT_ID" <<'PY'
import re,sys,urllib.parse,pathlib
text=pathlib.Path('/etc/breeze/agent.yaml').read_text()
get=lambda k: re.search(r'^'+k+r':\s*[\"\x27]?([^\"\x27\s]+)',text,re.M).group(1)
assert get('allow_dev_update')=='true'
assert get('agent_id')==sys.argv[2]
a=urllib.parse.urlsplit(get('server_url')); b=urllib.parse.urlsplit(sys.argv[1])
assert (a.scheme,a.netloc)==(b.scheme,b.netloc)
PY
cd /var/tmp/breeze-w06/agent
make dev-push DEVICE="$AGENT_ID" PLATFORM="linux/$(go env GOARCH)" API_URL="$API_URL" AUTH_TOKEN="$AUTH_TOKEN"
SH
```

The VM's Go toolchain must satisfy `agent/go.mod`; inspect `go version` and exit codes. If `allow_dev_update` is false, enable it on this lab agent and restart before the push. Do not print the config or auth token. Verify `wsSent` and installed version as on Windows.

- [ ] **Step 4: Capture accepted baseline and screenshot (3 minutes plus polling).**

```bash
push_receipt "$LAB/linux-push.txt" "$LINUX_ID" "$LINUX_AGENT_ID" > "$LAB/linux-push-receipt.json"
LINUX_PUSH_VERSION="$(jq -er .version "$LAB/linux-push-receipt.json")"
await_jq "$LINUX_ID" ".agentVersion==\"$LINUX_PUSH_VERSION\"" "$LAB/linux-installed.json"
await_jq "$LINUX_ID" '[.components[]|select(.source=="smartctl" and .componentType=="physical_disk")]|length>0' "$LAB/linux-baseline-view.json"
bash "$LAB/test-linux-baseline.sh"
shot "$LINUX_ID" w06-linux-baseline
jq -n --slurpfile v "$LAB/linux-baseline-view.json" '{nativeTests:true,view:$v[0]}' > "$EVIDENCE/w06-linux-baseline.json"
jq -e '.nativeTests and (.view.components|length>0)' "$EVIDENCE/w06-linux-baseline.json"
```

Expected green: baseline PASS; Hardware tab shows md0, two members and a separate OS-visible SMART row. Do not claim SMART for the loop-backed md members.

- [ ] **Step 5: Commit Linux baseline (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-linux-baseline.json
git add docs/superpowers/plans/monitoring/evidence/w06-linux-baseline.json docs/superpowers/plans/monitoring/evidence/w06-linux-baseline.png
git commit -m $'test(monitoring): prove Linux md and standalone SMART collection\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 7: Fail, rebuild and recover md0 without a rebuild critical alert

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-linux-{degraded,rebuilding,recovered}.json` and corresponding `.png` files. Test: `$LAB/test-md-fault.sh`, `$LAB/test-md-rebuild.sh`. Consumed product files are index §H `mdadm_linux.go` and §F handler; W06 does not change their state mapping.

**Interfaces:** Consumes `/dev/md0`, loop mapping, `await_alerts`; produces degraded, rebuilding-warning and optimal evidence, with original alert IDs and per-rank streak counters.

- [ ] **Step 1: Write and run the live degraded assertion (3 minutes).**

```bash
cat > "$LAB/test-md-fault.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
view "$LINUX_ID" > "$LAB/md-fault-view.json"
alerts_for "$LINUX_ID" > "$LAB/md-fault-alerts.json"
jq -e '[.components[]|select(.componentKey=="mdadm:md0" and .state=="degraded" and
  .health=="critical" and .criticalStreak>=2)]|length==1' "$LAB/md-fault-view.json"
jq -e '[.[]|select(.subject_key=="mdadm:md0" and .builtin_key=="raid_array_degraded" and
  .status=="active" and .severity=="critical")]|length==1' "$LAB/md-fault-alerts.json"
echo 'PASS md0 degraded alert'
SH
bash "$LAB/test-md-fault.sh"
```

Expected red: `false`, exit 1 on clean md0.

- [ ] **Step 2: Fail member B and capture the two-poll result (3 minutes plus polling).**

```bash
ssh "$LINUX_SSH" 'bash -se' <<'SH'
set -euo pipefail
source /var/tmp/breeze-w06/loops.env
mdadm /dev/md0 --fail "$LOOP_B"
mdadm --detail /dev/md0
SH
observe_fault "$LINUX_ID" mdadm md-fault
bash "$LAB/test-md-fault.sh"
shot "$LINUX_ID" w06-linux-degraded
jq -n --slurpfile v "$LAB/md-fault-view.json" --slurpfile a "$LAB/md-fault-alerts.json" \
  --slurpfile timeline "$LAB/md-fault-timeline.jsonl" '{view:$v[0],alerts:$a[0],timeline:$timeline}' > "$EVIDENCE/w06-linux-degraded.json"
```

Expected green: one critical array alert for `mdadm:md0`; member alerts may also exist and are retained. No duplicate open `(rule_id,device_id,subject_key)` is allowed.

- [ ] **Step 3: Write the rebuilding assertion and run it while degraded (3 minutes).**

```bash
cat > "$LAB/test-md-rebuild.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
view "$LINUX_ID" > "$LAB/md-rebuild-view.json"
alerts_for "$LINUX_ID" > "$LAB/md-rebuild-alerts.json"
jq -e '[.components[]|select(.componentKey=="mdadm:md0" and .state=="rebuilding" and
 .health=="warning" and .belowCriticalStreak>=2 and .criticalStreak==0 and
 .progressPercent>=0 and .progressPercent<=100)]|length==1' "$LAB/md-rebuild-view.json"
jq -en --slurpfile before "$EVIDENCE/w06-linux-degraded.json" --slurpfile after "$LAB/md-rebuild-alerts.json" \
 '[$before[0].alerts[]|select(.subject_key=="mdadm:md0")|.id] as $ids |
  [$after[0][]|select(.subject_key=="mdadm:md0")] as $rows |
  ($rows|length)==1 and ($rows|all(.status=="resolved" and (.id as $id|$ids|index($id))!=null))'
echo 'PASS rebuilding warning resolves original critical alert without a new critical'
SH
bash "$LAB/test-md-rebuild.sh"
```

Expected red: state remains `degraded`. Do not assert instant resolution on the first rebuilding poll: the critical built-in requires two below-critical observations (§9.3).

- [ ] **Step 4: Force a long enough real rebuild and capture warning (5 minutes plus polling).**

```bash
ssh "$LINUX_SSH" 'bash -se' <<'SH'
set -euo pipefail
source /var/tmp/breeze-w06/loops.env
mdadm /dev/md0 --remove "$LOOP_B"
# Array-local throttle, not the host-wide raid speed sysctls; KB/s makes 4 GiB observable.
cat /sys/block/md0/md/sync_speed_min > /var/tmp/breeze-w06/sync-speed-min
cat /sys/block/md0/md/sync_speed_max > /var/tmp/breeze-w06/sync-speed-max
printf '512\n' > /sys/block/md0/md/sync_speed_min
printf '1024\n' > /sys/block/md0/md/sync_speed_max
# Remove only this owned member's metadata so --add cannot complete as a tiny bitmap replay.
mdadm --zero-superblock "$LOOP_B"
mdadm /dev/md0 --add "$LOOP_B"
cat /proc/mdstat
SH
await_jq "$LINUX_ID" '[.components[]|select(.componentKey=="mdadm:md0" and .state=="rebuilding" and .belowCriticalStreak>=2)]|length==1' "$LAB/md-rebuild-view.json"
await_alerts "$LINUX_ID" '[.[]|select(.subject_key=="mdadm:md0")]|length==1 and all(.status=="resolved")' "$LAB/md-rebuild-alerts.json"
bash "$LAB/test-md-rebuild.sh"
shot "$LINUX_ID" w06-linux-rebuilding
jq -n --slurpfile v "$LAB/md-rebuild-view.json" --slurpfile a "$LAB/md-rebuild-alerts.json" \
  '{view:$v[0],alerts:$a[0]}' > "$EVIDENCE/w06-linux-rebuilding.json"
```

Expected green: `rebuilding`, warning, numeric progress and the original critical array alert resolved. The zero-superblock command is limited to the loop path in this run's ownership manifest, never a system disk.

- [ ] **Step 5: Restore array-local speed, finish recovery and verify (3 minutes plus polling).**

```bash
ssh "$LINUX_SSH" 'bash -se' <<'SH'
set -euo pipefail
printf 'system\n' > /sys/block/md0/md/sync_speed_min
printf 'system\n' > /sys/block/md0/md/sync_speed_max
mdadm --wait /dev/md0
mdadm --detail /dev/md0
SH
await_jq "$LINUX_ID" '[.components[]|select(.componentKey=="mdadm:md0" and .state=="optimal" and .healthyStreak>=2)]|length==1' "$LAB/md-optimal-view.json"
await_alerts "$LINUX_ID" '[.[]|select(.subject_key|startswith("mdadm:"))]|length>0 and all(.status=="resolved")' "$LAB/md-optimal-alerts.json"
shot "$LINUX_ID" w06-linux-recovered
jq -n --slurpfile v "$LAB/md-optimal-view.json" --slurpfile a "$LAB/md-optimal-alerts.json" \
  '{view:$v[0],alerts:$a[0]}' > "$EVIDENCE/w06-linux-recovered.json"
jq -e '[.alerts[]|select(.subject_key|startswith("mdadm:"))]|all(.status=="resolved" and .resolved_at!=null)' "$EVIDENCE/w06-linux-recovered.json"
```

Expected `true`; capture any unresolved missing member as a stable-identity defect, not a manual-close chore.

- [ ] **Step 6: Commit md fault, rebuild and recovery proof (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-linux-degraded.json docs/superpowers/plans/monitoring/evidence/w06-linux-rebuilding.json docs/superpowers/plans/monitoring/evidence/w06-linux-recovered.json
git add docs/superpowers/plans/monitoring/evidence/w06-linux-degraded.json docs/superpowers/plans/monitoring/evidence/w06-linux-rebuilding.json docs/superpowers/plans/monitoring/evidence/w06-linux-recovered.json docs/superpowers/plans/monitoring/evidence/w06-linux-degraded.png docs/superpowers/plans/monitoring/evidence/w06-linux-rebuilding.png docs/superpowers/plans/monitoring/evidence/w06-linux-recovered.png
git commit -m $'test(monitoring): prove md degraded rebuild and recovery semantics\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 8: Record an optional real ZFS mirror run or an explicit skip

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-zfs.json`. Test: `$LAB/test-zfs.sh`. W02b owns `agent/internal/collectors/hwhealth/zfs_linux.go` (index §H).

**Interfaces:** Consumes Debian SSH, `view`, `await_jq`; produces either `status:"lab-proof"` with real pool evidence or `status:"skipped"` with a package/kernel reason. ZFS skip never waives Windows, mdadm or SMART proof.

- [ ] **Step 1: Write and run the failing outcome assertion (2 minutes).**

```bash
cat > "$LAB/test-zfs.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
jq -e '(.status=="skipped" and (.reason|length>0)) or
  (.status=="lab-proof" and .degraded and .resolved and .view.health!=null)' "$EVIDENCE/w06-zfs.json"
echo 'PASS optional ZFS outcome recorded without a fabricated success'
SH
bash "$LAB/test-zfs.sh"
```

Expected red: missing `w06-zfs.json`.

- [ ] **Step 2: Attempt installation without modifying apt repositories (3 minutes).**

```bash
if ssh "$LINUX_SSH" 'bash -se' > "$LAB/zfs-install.txt" 2>&1 <<'SH'
set -euo pipefail
DEBIAN_FRONTEND=noninteractive apt-get install -y zfsutils-linux
modprobe zfs
zpool version
SH
then
  export ZFS_AVAILABLE=true
else
  export ZFS_AVAILABLE=false
  jq -n '{status:"skipped",reason:"zfsutils-linux install or kernel module unavailable on the dedicated Debian lab; private installation transcript retained"}' > "$EVIDENCE/w06-zfs.json"
fi
```

Expected exit 0 with ZFS version, or explicit skip. Do not turn a pool creation/parser/alert failure into an installation skip.

- [ ] **Step 3: If available, execute and verify an actual mirror fault cycle (5 minutes plus polling).**

```bash
if [ "$ZFS_AVAILABLE" = true ]; then
  ssh "$LINUX_SSH" 'bash -se' <<'SH'
set -euo pipefail
! zpool list breeze-w06 >/dev/null 2>&1
truncate -s 2G /var/tmp/breeze-w06/zfs-a.img
truncate -s 2G /var/tmp/breeze-w06/zfs-b.img
zpool create -m none breeze-w06 mirror /var/tmp/breeze-w06/zfs-a.img /var/tmp/breeze-w06/zfs-b.img
zpool offline breeze-w06 /var/tmp/breeze-w06/zfs-b.img
zpool status -pP breeze-w06
SH
  await_jq "$LINUX_ID" '[.components[]|select(.componentKey=="zfs:pool:breeze-w06" and .health=="critical" and .criticalStreak>=2)]|length==1' "$LAB/zfs-degraded.json"
  await_alerts "$LINUX_ID" '[.[]|select(.subject_key=="zfs:pool:breeze-w06" and .status=="active")]|length==1' "$LAB/zfs-alerts.json"
  ssh "$LINUX_SSH" 'zpool online breeze-w06 /var/tmp/breeze-w06/zfs-b.img'
  await_jq "$LINUX_ID" '[.components[]|select(.componentKey=="zfs:pool:breeze-w06" and .state=="optimal" and .healthyStreak>=2)]|length==1' "$LAB/zfs-optimal.json"
  await_alerts "$LINUX_ID" '[.[]|select(.subject_key=="zfs:pool:breeze-w06")]|length==1 and all(.status=="resolved")' "$LAB/zfs-resolved.json"
  jq -n --slurpfile d "$LAB/zfs-degraded.json" --slurpfile v "$LAB/zfs-optimal.json" --slurpfile a "$LAB/zfs-resolved.json" \
    '{status:"lab-proof",degraded:true,resolved:true,degradedView:$d[0],view:$v[0],alerts:$a[0]}' > "$EVIDENCE/w06-zfs.json"
fi
bash "$LAB/test-zfs.sh"
```

Expected green: outcome PASS. File-backed vdevs are dedicated lab devices, not a claim about hardware ZFS fault coverage.

- [ ] **Step 4: Commit the optional-ZFS outcome (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-zfs.json
git add docs/superpowers/plans/monitoring/evidence/w06-zfs.json
git commit -m $'test(monitoring): record optional ZFS lab outcome\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Capture storcli and establish the vendor evidence convention

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-storcli.json`; conditional Create `agent/internal/collectors/hwhealth/testdata/storcli/real-{controllers,virtual-disks,physical-disks,cachevault,bbu}.json`. Modify W04's `apps/docs/src/content/docs/features/hardware-monitoring.mdx` in Task 18. Test: `$LAB/test-storcli.sh`.

**Interfaces:** Consumes spec §5.1 exact CLI commands and existing W02a parser suite. Produces `capture_manifest(source, directory)` and `vendor_test(source)` helpers for Tasks 10–17. `real capture` means a sanitized real command transcript exists; it does not imply real hardware fault injection or that a previously synthetic parser test automatically discovered the new file.

- [ ] **Step 1: Write and run the failing vendor record assertion (3 minutes).**

```bash
cat >> "$LAB/lib.sh" <<'SH'
vendor_test() {
  jq -e --arg source "$1" '.source==$source and
    (.status=="fixture-only" or (.status=="real capture" and (.files|length)>0)) and
    .parserSuite=="passed"' "$EVIDENCE/w06-$1.json"
}
capture_manifest() {
  local source="$1" directory="$2"
  python3 - "$source" "$directory" <<'PY'
import hashlib,json,os,pathlib,sys
source=sys.argv[1]; directory=pathlib.Path(sys.argv[2])
files=[p for p in sorted(directory.glob('real-*')) if p.is_file()]
for p in files:
    assert p.stat().st_size>0, p
    if p.suffix=='.json': json.loads(p.read_text())
record={'source':source,'status':'real capture' if files else 'fixture-only',
        'parserSuite':'passed','files':[{'path':str(p.relative_to(os.environ['ROOT'])),
        'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
(pathlib.Path(os.environ['EVIDENCE'])/f'w06-{source}.json').write_text(json.dumps(record,indent=2)+'\n')
PY
}
SH
source "$LAB/lib.sh"
cat > "$LAB/test-storcli.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test storcli
echo 'PASS storcli capture status and parser rerun'
SH
bash "$LAB/test-storcli.sh"
```

Expected red: missing `w06-storcli.json`. The following convention applies to each vendor's own checklist: ask for an already-authorized capture target or leave it empty. Do not install vendor tools, download EULA binaries, or contact a customer. Todd supplies approved capture access; absence remains `fixture-only` per §13/§15.

- [ ] **Step 2: Capture the real commands, when access exists (3 minutes).**

```bash
read -r -p 'Authorized storcli Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/storcli"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'storcli64 /call show all J' > "$LAB/captures/storcli/real-controllers.json"
  ssh "$CAPTURE_SSH" 'storcli64 /call/vall show all J' > "$LAB/captures/storcli/real-virtual-disks.json"
  ssh "$CAPTURE_SSH" 'storcli64 /call/eall/sall show all J' > "$LAB/captures/storcli/real-physical-disks.json"
  ssh "$CAPTURE_SSH" 'storcli64 /call/cv show all J' > "$LAB/captures/storcli/real-cachevault.json"
  ssh "$CAPTURE_SSH" 'storcli64 /call/bbu show all J' > "$LAB/captures/storcli/real-bbu.json"
fi
```

A CLI error is evidence, not an empty replacement file. Keep exit codes and stderr privately; an unsupported cache device can produce valid JSON error output useful to the parser. The 64-drive fixture remains W02a's independently tested review-focus item 1.

- [ ] **Step 3: Sanitize with an explicit replacement map and rerun parsers (5 minutes).**

```bash
cat > "$LAB/publish-capture.py" <<'PY'
import json,pathlib,sys
source,raw,target,mapping=sys.argv[1:]
raw=pathlib.Path(raw); target=pathlib.Path(target)
replacements=json.loads(pathlib.Path(mapping).read_text())
assert isinstance(replacements,dict)
assert all(isinstance(k,str) and k and isinstance(v,str) for k,v in replacements.items())
target.mkdir(parents=True,exist_ok=True)
for p in sorted(raw.glob('real-*')):
    text=p.read_text(encoding='utf-8-sig')
    for old,new in sorted(replacements.items(),key=lambda x:-len(x[0])): text=text.replace(old,new)
    assert text.strip(), p
    if p.suffix=='.json': json.loads(text)
    (target/p.name).write_text(text)
print('Published sanitized '+source+' capture files')
PY
python3 "$LAB/publish-capture.py" storcli "$LAB/captures/storcli" "$ROOT/agent/internal/collectors/hwhealth/testdata/storcli" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest storcli "$ROOT/agent/internal/collectors/hwhealth/testdata/storcli"
bash "$LAB/test-storcli.sh"
```

Expected green: `ok` from Go and `PASS storcli capture status and parser rerun`.

The replacement map uses stable neutral strings for hostnames, IPs, asset tags, serials and WWNs, preserving cross-command identity equality, topology, field names and state strings. Review the resulting diff before commit. Compare controller/VD/PD counts and states against the real device's CLI output. Capture files do not become regression coverage merely by placement: existing fixture-suite rerun is recorded separately; a capture that exposes a parser disagreement is a red W02a/W02b bug requiring a dedicated fixture test in that owning source before this task passes. No unknown parser function names are invented here.

- [ ] **Step 4: Commit the status and only captures that exist (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-storcli.json
git add docs/superpowers/plans/monitoring/evidence/w06-storcli.json
git add agent/internal/collectors/hwhealth/testdata/storcli
git commit -m $'test(monitoring): record storcli capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Capture perccli provenance and rerun its parser suite

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-perccli.json`; conditional Create `real-controllers.json`, `real-virtual-disks.json`, `real-physical-disks.json`, `real-cachevault.json`, `real-bbu.json` under `agent/internal/collectors/hwhealth/testdata/perccli/`. Test: `$LAB/test-perccli.sh`. Parser implementation belongs to W02a, index §H.

**Interfaces:** Consumes Task 9 `vendor_test(source)`, `capture_manifest(source, directory)`, `$LAB/publish-capture.py`, `REDACTION_MAP`; produces `perccli` coverage status for Task 18's docs table.

- [ ] **Step 1: Write and run the failing vendor assertion (2 minutes).**

```bash
cat > "$LAB/test-perccli.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test perccli
echo 'PASS perccli capture status and parser rerun'
SH
bash "$LAB/test-perccli.sh"
```

Expected red: missing `w06-perccli.json`; absent real hardware is represented by an explicit fixture-only result after the checklist, not a forged transcript.

- [ ] **Step 2: Capture the source's exact commands on an authorized target (3 minutes).**

```bash
read -r -p 'Authorized perccli Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/perccli"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'perccli64 /call show all J' > "$LAB/captures/perccli/real-controllers.json"
  ssh "$CAPTURE_SSH" 'perccli64 /call/vall show all J' > "$LAB/captures/perccli/real-virtual-disks.json"
  ssh "$CAPTURE_SSH" 'perccli64 /call/eall/sall show all J' > "$LAB/captures/perccli/real-physical-disks.json"
  ssh "$CAPTURE_SSH" 'perccli64 /call/cv show all J' > "$LAB/captures/perccli/real-cachevault.json"
  ssh "$CAPTURE_SSH" 'perccli64 /call/bbu show all J' > "$LAB/captures/perccli/real-bbu.json"
fi
```

The same Broadcom parser must retain source `perccli`. A real perccli transcript does not establish storcli coverage, and precedence is still tested by W02b.

- [ ] **Step 3: Publish reviewed captures and verify parser regression status (3 minutes plus tests).**

```bash
python3 "$LAB/publish-capture.py" perccli "$LAB/captures/perccli" "$ROOT/agent/internal/collectors/hwhealth/testdata/perccli" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest perccli "$ROOT/agent/internal/collectors/hwhealth/testdata/perccli"
bash "$LAB/test-perccli.sh"
```

Expected green: `ok` from Go and `PASS perccli capture status and parser rerun`. Review the sanitized files against the private originals: commands, component counts, state strings and membership must survive replacement. A source remains `fixture-only` if no real file exists; Task 18 derives the exact `real capture` marker from this manifest. Any new parser regression blocks this task and returns to W02a with the real failing capture.

- [ ] **Step 4: Commit the source-specific evidence (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-perccli.json
git add docs/superpowers/plans/monitoring/evidence/w06-perccli.json
git add agent/internal/collectors/hwhealth/testdata/perccli
git commit -m $'test(monitoring): record perccli capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 11: Capture megacli provenance and rerun its parser suite

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-megacli.json`; conditional Create `real-controllers.txt`, `real-virtual-disks.txt`, `real-physical-disks.txt`, `real-bbu.txt`, `real-membership.txt` under `agent/internal/collectors/hwhealth/testdata/megacli/`. Test: `$LAB/test-megacli.sh`. Parser implementation belongs to W02b, index §H.

**Interfaces:** Consumes Task 9 `vendor_test(source)`, `capture_manifest(source, directory)`, `$LAB/publish-capture.py`, `REDACTION_MAP`; produces `megacli` coverage status for Task 18's docs table.

- [ ] **Step 1: Write and run the failing vendor assertion (2 minutes).**

```bash
cat > "$LAB/test-megacli.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test megacli
echo 'PASS megacli capture status and parser rerun'
SH
bash "$LAB/test-megacli.sh"
```

Expected red: missing `w06-megacli.json`; absent real hardware is represented by an explicit fixture-only result after the checklist, not a forged transcript.

- [ ] **Step 2: Capture the source's exact commands on an authorized target (3 minutes).**

```bash
read -r -p 'Authorized megacli Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/megacli"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'timeout 40s MegaCli64 -AdpAllInfo -aALL' > "$LAB/captures/megacli/real-controllers.txt"
  ssh "$CAPTURE_SSH" 'timeout 40s MegaCli64 -LDInfo -Lall -aALL' > "$LAB/captures/megacli/real-virtual-disks.txt"
  ssh "$CAPTURE_SSH" 'timeout 40s MegaCli64 -PDList -aALL' > "$LAB/captures/megacli/real-physical-disks.txt"
  ssh "$CAPTURE_SSH" 'timeout 40s MegaCli64 -AdpBbuCmd -GetBbuStatus -aALL' > "$LAB/captures/megacli/real-bbu.txt"
  ssh "$CAPTURE_SSH" 'timeout 40s MegaCli64 -LDPDInfo -aALL' > "$LAB/captures/megacli/real-membership.txt"
fi
```

Run the read-only CLI under an external 40-second capture timeout; timeout is a failed capture, never proof of healthy hardware. W02a owns cycle-budget and breaker cancellation tests.

- [ ] **Step 3: Publish reviewed captures and verify parser regression status (3 minutes plus tests).**

```bash
python3 "$LAB/publish-capture.py" megacli "$LAB/captures/megacli" "$ROOT/agent/internal/collectors/hwhealth/testdata/megacli" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest megacli "$ROOT/agent/internal/collectors/hwhealth/testdata/megacli"
bash "$LAB/test-megacli.sh"
```

Expected green: `ok` from Go and `PASS megacli capture status and parser rerun`. Review the sanitized files against the private originals: commands, component counts, state strings and membership must survive replacement. A source remains `fixture-only` if no real file exists; Task 18 derives the exact `real capture` marker from this manifest. Any new parser regression blocks this task and returns to W02b with the real failing capture.

- [ ] **Step 4: Commit the source-specific evidence (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-megacli.json
git add docs/superpowers/plans/monitoring/evidence/w06-megacli.json
git add agent/internal/collectors/hwhealth/testdata/megacli
git commit -m $'test(monitoring): record megacli capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 12: Capture ssacli provenance and rerun its parser suite

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-ssacli.json`; conditional Create `real-status.txt`, `real-config.txt` under `agent/internal/collectors/hwhealth/testdata/ssacli/`. Test: `$LAB/test-ssacli.sh`. Parser implementation belongs to W02b, index §H.

**Interfaces:** Consumes Task 9 `vendor_test(source)`, `capture_manifest(source, directory)`, `$LAB/publish-capture.py`, `REDACTION_MAP`; produces `ssacli` coverage status for Task 18's docs table.

- [ ] **Step 1: Write and run the failing vendor assertion (2 minutes).**

```bash
cat > "$LAB/test-ssacli.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test ssacli
echo 'PASS ssacli capture status and parser rerun'
SH
bash "$LAB/test-ssacli.sh"
```

Expected red: missing `w06-ssacli.json`; absent real hardware is represented by an explicit fixture-only result after the checklist, not a forged transcript.

- [ ] **Step 2: Capture the source's exact commands on an authorized target (3 minutes).**

```bash
read -r -p 'Authorized ssacli Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/ssacli"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'ssacli ctrl all show status' > "$LAB/captures/ssacli/real-status.txt"
  ssh "$CAPTURE_SSH" 'ssacli ctrl all show config detail' > "$LAB/captures/ssacli/real-config.txt"
fi
```

Retain cache/battery, array, logical-drive and physical-drive sections, including temperatures and predictive-failure text. The collector allows 60 seconds for this source.

- [ ] **Step 3: Publish reviewed captures and verify parser regression status (3 minutes plus tests).**

```bash
python3 "$LAB/publish-capture.py" ssacli "$LAB/captures/ssacli" "$ROOT/agent/internal/collectors/hwhealth/testdata/ssacli" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest ssacli "$ROOT/agent/internal/collectors/hwhealth/testdata/ssacli"
bash "$LAB/test-ssacli.sh"
```

Expected green: `ok` from Go and `PASS ssacli capture status and parser rerun`. Review the sanitized files against the private originals: commands, component counts, state strings and membership must survive replacement. A source remains `fixture-only` if no real file exists; Task 18 derives the exact `real capture` marker from this manifest. Any new parser regression blocks this task and returns to W02b with the real failing capture.

- [ ] **Step 4: Commit the source-specific evidence (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-ssacli.json
git add docs/superpowers/plans/monitoring/evidence/w06-ssacli.json
git add agent/internal/collectors/hwhealth/testdata/ssacli
git commit -m $'test(monitoring): record ssacli capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 13: Capture arcconf provenance and rerun its parser suite

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-arcconf.json`; conditional Create `real-version.txt` and `real-controller-${controller}.txt` where the command loop sets `controller` to each discovered numeric ID under `agent/internal/collectors/hwhealth/testdata/arcconf/`. Test: `$LAB/test-arcconf.sh`. Parser implementation belongs to W02b, index §H.

**Interfaces:** Consumes Task 9 `vendor_test(source)`, `capture_manifest(source, directory)`, `$LAB/publish-capture.py`, `REDACTION_MAP`; produces `arcconf` coverage status for Task 18's docs table.

- [ ] **Step 1: Write and run the failing vendor assertion (2 minutes).**

```bash
cat > "$LAB/test-arcconf.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test arcconf
echo 'PASS arcconf capture status and parser rerun'
SH
bash "$LAB/test-arcconf.sh"
```

Expected red: missing `w06-arcconf.json`; absent real hardware is represented by an explicit fixture-only result after the checklist, not a forged transcript.

- [ ] **Step 2: Capture the source's exact commands on an authorized target (3 minutes).**

```bash
read -r -p 'Authorized arcconf Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/arcconf"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'arcconf GETVERSION' > "$LAB/captures/arcconf/real-version.txt"
  read -r -p 'Controller IDs shown by the captured listing, space-separated: ' -a CONTROLLER_IDS
  [ "${#CONTROLLER_IDS[@]}" -gt 0 ]
  for controller in "${CONTROLLER_IDS[@]}"; do
    [[ "$controller" =~ ^[0-9]+$ ]]
    [ "$controller" -gt 0 ]
    ssh "$CAPTURE_SSH" "arcconf GETCONFIG $controller AL" > "$LAB/captures/arcconf/real-controller-$controller.txt"
  done
fi
```

GETVERSION discovers controller IDs; capture every listed controller, not just controller 1. The additional loop below asks for the actual positive integer IDs and records each separately.

- [ ] **Step 3: Publish reviewed captures and verify parser regression status (3 minutes plus tests).**

```bash
python3 "$LAB/publish-capture.py" arcconf "$LAB/captures/arcconf" "$ROOT/agent/internal/collectors/hwhealth/testdata/arcconf" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest arcconf "$ROOT/agent/internal/collectors/hwhealth/testdata/arcconf"
bash "$LAB/test-arcconf.sh"
```

Expected green: `ok` from Go and `PASS arcconf capture status and parser rerun`. Review the sanitized files against the private originals: commands, component counts, state strings and membership must survive replacement. A source remains `fixture-only` if no real file exists; Task 18 derives the exact `real capture` marker from this manifest. Any new parser regression blocks this task and returns to W02b with the real failing capture.

- [ ] **Step 4: Commit the source-specific evidence (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-arcconf.json
git add docs/superpowers/plans/monitoring/evidence/w06-arcconf.json
git add agent/internal/collectors/hwhealth/testdata/arcconf
git commit -m $'test(monitoring): record arcconf capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 14: Capture omreport provenance and rerun its parser suite

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-omreport.json`; conditional Create `real-controllers.txt`, `real-virtual-disks.txt`, `real-battery.txt` and `real-physical-disks-${controller}.txt` where the command loop sets `controller` to each discovered numeric ID under `agent/internal/collectors/hwhealth/testdata/omreport/`. Test: `$LAB/test-omreport.sh`. Parser implementation belongs to W02b, index §H.

**Interfaces:** Consumes Task 9 `vendor_test(source)`, `capture_manifest(source, directory)`, `$LAB/publish-capture.py`, `REDACTION_MAP`; produces `omreport` coverage status for Task 18's docs table.

- [ ] **Step 1: Write and run the failing vendor assertion (2 minutes).**

```bash
cat > "$LAB/test-omreport.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test omreport
echo 'PASS omreport capture status and parser rerun'
SH
bash "$LAB/test-omreport.sh"
```

Expected red: missing `w06-omreport.json`; absent real hardware is represented by an explicit fixture-only result after the checklist, not a forged transcript.

- [ ] **Step 2: Capture the source's exact commands on an authorized target (3 minutes).**

```bash
read -r -p 'Authorized omreport Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/omreport"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'omreport storage controller -fmt ssv' > "$LAB/captures/omreport/real-controllers.txt"
  ssh "$CAPTURE_SSH" 'omreport storage vdisk -fmt ssv' > "$LAB/captures/omreport/real-virtual-disks.txt"
  ssh "$CAPTURE_SSH" 'omreport storage battery -fmt ssv' > "$LAB/captures/omreport/real-battery.txt"
  read -r -p 'Controller IDs shown by the captured listing, space-separated: ' -a CONTROLLER_IDS
  [ "${#CONTROLLER_IDS[@]}" -gt 0 ]
  for controller in "${CONTROLLER_IDS[@]}"; do
    [[ "$controller" =~ ^[0-9]+$ ]]
    ssh "$CAPTURE_SSH" "omreport storage pdisk controller=$controller -fmt ssv" > "$LAB/captures/omreport/real-physical-disks-$controller.txt"
  done
fi
```

Retain semicolon separators and Failure Predicted fields. Capture PDs for each listed controller. This records OMSA storage evidence; W02b still owns suppression when a Broadcom-family tool is available.

- [ ] **Step 3: Publish reviewed captures and verify parser regression status (3 minutes plus tests).**

```bash
python3 "$LAB/publish-capture.py" omreport "$LAB/captures/omreport" "$ROOT/agent/internal/collectors/hwhealth/testdata/omreport" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest omreport "$ROOT/agent/internal/collectors/hwhealth/testdata/omreport"
bash "$LAB/test-omreport.sh"
```

Expected green: `ok` from Go and `PASS omreport capture status and parser rerun`. Review the sanitized files against the private originals: commands, component counts, state strings and membership must survive replacement. A source remains `fixture-only` if no real file exists; Task 18 derives the exact `real capture` marker from this manifest. Any new parser regression blocks this task and returns to W02b with the real failing capture.

- [ ] **Step 4: Commit the source-specific evidence (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-omreport.json
git add docs/superpowers/plans/monitoring/evidence/w06-omreport.json
git add agent/internal/collectors/hwhealth/testdata/omreport
git commit -m $'test(monitoring): record omreport capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 15: Record ipmi in-band capture coverage

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-ipmi.json`; conditional Create `agent/internal/collectors/hwhealth/testdata/ipmi/real-lan.txt`, `agent/internal/collectors/hwhealth/testdata/ipmi/real-controller.txt`. Test: `$LAB/test-ipmi.sh`. W05 creates `bmc.go` under index §H; index §I source value is `ipmi`, never `bmc`.

**Interfaces:** Consumes Task 9 capture helpers; produces the `ipmi` docs marker. This captures informational in-band BMC facts only; no out-of-band credentials, sensor polling or topology-link proof is claimed.

- [ ] **Step 1: Write and run the failing source assertion (2 minutes).**

```bash
cat > "$LAB/test-ipmi.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test ipmi
echo 'PASS ipmi capture provenance'
SH
bash "$LAB/test-ipmi.sh"
```

Expected red: missing `w06-ipmi.json`.

- [ ] **Step 2: Capture, sanitize and verify (5 minutes plus tests).**

```bash
read -r -p 'Authorized ipmi Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/ipmi"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'ipmitool lan print 1' > "$LAB/captures/ipmi/real-lan.txt"
  ssh "$CAPTURE_SSH" 'ipmitool mc info' > "$LAB/captures/ipmi/real-controller.txt"
fi
python3 "$LAB/publish-capture.py" ipmi "$LAB/captures/ipmi" "$ROOT/agent/internal/collectors/hwhealth/testdata/ipmi" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest ipmi "$ROOT/agent/internal/collectors/hwhealth/testdata/ipmi"
bash "$LAB/test-ipmi.sh"
```

Expected green: parser suite exits 0 and provenance PASS. Before copying, extend the private replacement map for every BMC IP/MAC, host identifier, username, community string or password in the export; preserve the XML/text structure and identity equality. `hponcfg -w` exports configuration; `-g` is insufficient for network facts (§12). No real capture leaves the source `fixture-only`.

- [ ] **Step 3: Commit only the sanitized source and receipt (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-ipmi.json
git add docs/superpowers/plans/monitoring/evidence/w06-ipmi.json
git add agent/internal/collectors/hwhealth/testdata/ipmi
git commit -m $'test(monitoring): record ipmi in-band capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 16: Record racadm in-band capture coverage

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-racadm.json`; conditional Create `agent/internal/collectors/hwhealth/testdata/racadm/real-nic.txt`, `agent/internal/collectors/hwhealth/testdata/racadm/real-version.txt`. Test: `$LAB/test-racadm.sh`. W05 creates `bmc.go` under index §H; index §I source value is `racadm`, never `bmc`.

**Interfaces:** Consumes Task 9 capture helpers; produces the `racadm` docs marker. This captures informational in-band BMC facts only; no out-of-band credentials, sensor polling or topology-link proof is claimed.

- [ ] **Step 1: Write and run the failing source assertion (2 minutes).**

```bash
cat > "$LAB/test-racadm.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test racadm
echo 'PASS racadm capture provenance'
SH
bash "$LAB/test-racadm.sh"
```

Expected red: missing `w06-racadm.json`.

- [ ] **Step 2: Capture, sanitize and verify (5 minutes plus tests).**

```bash
read -r -p 'Authorized racadm Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/racadm"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'racadm getniccfg' > "$LAB/captures/racadm/real-nic.txt"
  ssh "$CAPTURE_SSH" 'racadm getversion' > "$LAB/captures/racadm/real-version.txt"
fi
python3 "$LAB/publish-capture.py" racadm "$LAB/captures/racadm" "$ROOT/agent/internal/collectors/hwhealth/testdata/racadm" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest racadm "$ROOT/agent/internal/collectors/hwhealth/testdata/racadm"
bash "$LAB/test-racadm.sh"
```

Expected green: parser suite exits 0 and provenance PASS. Before copying, extend the private replacement map for every BMC IP/MAC, host identifier, username, community string or password in the export; preserve the XML/text structure and identity equality. `hponcfg -w` exports configuration; `-g` is insufficient for network facts (§12). No real capture leaves the source `fixture-only`.

- [ ] **Step 3: Commit only the sanitized source and receipt (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-racadm.json
git add docs/superpowers/plans/monitoring/evidence/w06-racadm.json
git add agent/internal/collectors/hwhealth/testdata/racadm
git commit -m $'test(monitoring): record racadm in-band capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 17: Record hponcfg in-band capture coverage

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-hponcfg.json`; conditional Create `agent/internal/collectors/hwhealth/testdata/hponcfg/real-config.txt`. Test: `$LAB/test-hponcfg.sh`. W05 creates `bmc.go` under index §H; index §I source value is `hponcfg`, never `bmc`.

**Interfaces:** Consumes Task 9 capture helpers; produces the `hponcfg` docs marker. This captures informational in-band BMC facts only; no out-of-band credentials, sensor polling or topology-link proof is claimed.

- [ ] **Step 1: Write and run the failing source assertion (2 minutes).**

```bash
cat > "$LAB/test-hponcfg.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
source "$LAB/lib.sh"
vendor_test hponcfg
echo 'PASS hponcfg capture provenance'
SH
bash "$LAB/test-hponcfg.sh"
```

Expected red: missing `w06-hponcfg.json`.

- [ ] **Step 2: Capture, sanitize and verify (5 minutes plus tests).**

```bash
read -r -p 'Authorized hponcfg Linux SSH capture target; empty means fixture-only: ' CAPTURE_SSH
mkdir -p "$LAB/captures/hponcfg"
if [ -n "$CAPTURE_SSH" ]; then
  ssh "$CAPTURE_SSH" 'f=$(mktemp); trap '"'"'rm -f "$f"'"'"' EXIT; hponcfg -w "$f" >/dev/null; cat "$f"' > "$LAB/captures/hponcfg/real-config.txt"
fi
python3 "$LAB/publish-capture.py" hponcfg "$LAB/captures/hponcfg" "$ROOT/agent/internal/collectors/hwhealth/testdata/hponcfg" "$REDACTION_MAP"
(cd agent && go test -race ./internal/collectors/hwhealth/...)
capture_manifest hponcfg "$ROOT/agent/internal/collectors/hwhealth/testdata/hponcfg"
bash "$LAB/test-hponcfg.sh"
```

Expected green: parser suite exits 0 and provenance PASS. Before copying, extend the private replacement map for every BMC IP/MAC, host identifier, username, community string or password in the export; preserve the XML/text structure and identity equality. `hponcfg -w` exports configuration; `-g` is insufficient for network facts (§12). No real capture leaves the source `fixture-only`.

- [ ] **Step 3: Commit only the sanitized source and receipt (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-hponcfg.json
git add docs/superpowers/plans/monitoring/evidence/w06-hponcfg.json
git add agent/internal/collectors/hwhealth/testdata/hponcfg
git commit -m $'test(monitoring): record hponcfg in-band capture provenance\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 18: Sweep customer docs and prepare the agent release request

**Files:** Modify `apps/docs/src/content/docs/features/hardware-monitoring.mdx` (created by W04, index §G; append W06 verification section), `docs/release-notes/next-release-draft.md:15–21`. Create `docs/superpowers/plans/monitoring/evidence/w06-release-request.md`, `w06-release-validation.json`. Test: `$LAB/test-release.sh`.

**Interfaces:** Consumes Tasks 1–17 evidence and merged PR provenance. Produces release-request checklist and unreleased copy; consumes tag-derived version from `.github/workflows/release.yml:170–188`, not the local `agent/Makefile:3` fallback. Publication and fleet promotion are release-operator actions, not W06 lab commands.

- [ ] **Step 1: Write and run the failing docs/release assertion (3 minutes).**

```bash
cat > "$LAB/test-release.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json,os,pathlib
root=pathlib.Path(os.environ['ROOT']); e=pathlib.Path(os.environ['EVIDENCE'])
doc=(root/'apps/docs/src/content/docs/features/hardware-monitoring.mdx').read_text()
for source in ('storcli','perccli','megacli','ssacli','arcconf','omreport','ipmi','racadm','hponcfg'):
    m=json.loads((e/f'w06-{source}.json').read_text())
    assert f'| {source} | {m["status"]} |' in doc, source
notes=(root/'docs/release-notes/next-release-draft.md').read_text()
assert 'Hardware & RAID monitoring requires an agent release' in notes
assert 'Attach the four built-in hardware monitors' in notes
request=(e/'w06-release-request.md').read_text()
for term in ('AGENT_AUTO_PROMOTE=false','canary','v0.5.0','first week','fixture-only','W02a','W02b','W05'):
    assert term in request, term
print('PASS docs coverage markers and agent release handoff')
PY
SH
bash "$LAB/test-release.sh"
```

Expected red: assertion for the absent W06 coverage table or release request. Do not weaken the assertion by changing a real-capture marker without the matching manifest.

- [ ] **Step 2: Generate the honest docs table and append upgrade copy (4 minutes).**

```bash
for pr in $(jq -r '.prerequisites[].number' "$EVIDENCE/w06-environment.json"); do
  gh pr view "$pr" --json number,state,title,body,mergeCommit > "$LAB/release-pr-$pr.json"
  jq -e '.state=="MERGED"' "$LAB/release-pr-$pr.json"
  jq -r '.title,.body' "$LAB/release-pr-$pr.json"
done
python3 - <<'PY'
import json,os,pathlib
root=pathlib.Path(os.environ['ROOT']); e=pathlib.Path(os.environ['EVIDENCE'])
p=root/'apps/docs/src/content/docs/features/hardware-monitoring.mdx'
text=p.read_text(); assert '## Verification coverage' not in text
rows=['','## Verification coverage','','| Source | Evidence |','| --- | --- |']
for source in ('storcli','perccli','megacli','ssacli','arcconf','omreport','ipmi','racadm','hponcfg'):
    m=json.loads((e/f'w06-{source}.json').read_text())
    rows.append(f'| {source} | {m["status"]} |')
rows += ['| storage_spaces | live mirror fault and recovery |',
         '| windows_physical_disk | live disk inventory |',
         '| mdadm | live mirror fault, rebuild and recovery |',
         '| smartctl | live standalone disk inventory |']
z=json.loads((e/'w06-zfs.json').read_text())
rows.append('| zfs | '+('live mirror fault and recovery' if z['status']=='lab-proof' else 'fixture-only; optional lab unavailable')+' |')
rows += ['', '“Fixture-only” means parser coverage uses samples. “Real capture” means sanitized output from an installed vendor CLI has been retained; it does not claim a live hardware fault test.',
         '', 'Storage Spaces and Linux md mirrors were tested through disk failure and recovery. Rebuilding is a warning; the critical array monitor resolves after two below-critical observations. Vendor tools must already be installed, and hardware monitors must be attached to a configuration policy.','']
p.write_text(text+'\n'.join(rows))
p=root/'docs/release-notes/next-release-draft.md'; text=p.read_text()
assert 'Hardware & RAID monitoring requires an agent release' not in text
text=text.replace('## Release to-do (pre-cut gates — see `/release` Step 0.2)',
 '## Release to-do (pre-cut gates — see `/release` Step 0.2)\n\n- [ ] Hardware & RAID monitoring requires an agent release containing W02a, W02b and W05; use the W06 release request and lab evidence before rollout.')
text += '\n- See RAID arrays, physical disks, controller cache batteries and collection status in the device Hardware tab. Attach the four built-in hardware monitors to a configuration policy to receive per-component failure alerts; they are not attached by default. Collection is enabled by default, with a 10-minute RAID interval and a 60-minute disk-health interval. Vendor tools must already be installed. Rebuilding is a warning, and critical array alerts resolve after two below-critical observations. Upgrade the agent as well as the server.\n'
p.write_text(text)
PY
```

`apps/docs` is technical documentation, not the marketing changelog. The `update-breeze-release-notes` convention (`~/.claude/skills/update-breeze-release-notes/SKILL.md:10–19,85–124`) requires merged PRs/tag ranges and user-facing language. Its `src/content/releases/YYYY-MM-DD-vX-Y-Z.md` belongs to the marketing repository; this task stages copy in the actual monorepo scratchpad, which `/release` consumes (`next-release-draft.md:3–9`). Do not publish planned code as shipped, edit abandoned `CHANGELOG.md`, or add a marketing content collection to `apps/docs`.

- [ ] **Step 3: Write the concrete release request (3 minutes).**

```bash
cat > "$EVIDENCE/w06-release-request.md" <<'MD'
# Hardware & RAID monitoring — agent release request

The W06 evidence directory records the tested commit, six prerequisite PRs, Windows and Linux fault/recovery observations, alert IDs, screenshots and vendor capture provenance.

- [ ] Select the next release tag using the release workflow and verify it contains W01, W02a, W02b, W03, W04 and W05. W02a, W02b and W05 ship agent code.
- [ ] Version bump location: the release tag. `.github/workflows/release.yml` strips its leading `v` and passes the result to `agent/scripts/build-edition.sh`. Do not change the Makefile or main.go v0.5.0 development fallback.
- [ ] Build signed/edition-correct release artifacts through the established release process; dev-push binaries are lab evidence only.
- [ ] Follow `docs/superpowers/specs/agent/2026-06-23-controlled-agent-fleet-rollout.md`. Confirm `AGENT_AUTO_PROMOTE=false` in both configuration and the running API environment before registration; registration must not change the current fleet target.
- [ ] Verify the release agent on Windows and Linux canary devices, including two accepted hardware polls, source durations, no unexpected collector failures, and native agent health.
- [ ] Record operator approval and rollout target before promotion. Platform-admin `POST /api/v1/agent-versions/promote` accepts `{version: string, component?: 'agent'|'helper'|'viewer'|'user-helper'|'watchdog'|'backup'}` (`apps/api/src/routes/agentVersions.ts:69–76,126–129`); omission selects every component. Resolve the current edition/slot-aware operator procedure before promotion; W06 does not promote a fleet.
- [ ] Monitor agent CPU, source command durations, failed/backing_off rates and alert volume during the first week. Collector contention or a hanging CLI is a reason to pause the rollout and use the hardware policy toggle on affected canaries.
- [ ] Keep the prior promoted target and rollback procedure in the release operator's private runbook. Confirm the effective policy returns to enabled with normal intervals after testing.
- [ ] Populate the in-app What's New entry during the release (`apps/web/src/lib/whatsNew.ts`), using the selected tag/date. Publish marketing notes only from the merged PRs and tag range via update-breeze-release-notes.
- [ ] Keep fixture-only vendor rows explicitly marked until real captures exist; real capture is not a real failure-injection claim. SMART prediction, chassis sensors, out-of-band BMC monitoring and remediation are outside this release.

Proposed customer copy: “See RAID array and disk problems in the Hardware tab, with separate alerts for each affected component. Attach the built-in hardware monitors to your configuration policies to receive alerts, and use the hardware collection controls to set polling intervals or pause collection. Requires an updated agent and any applicable vendor tools already installed.”
MD
bash "$LAB/test-release.sh"
```

Expected green: docs/release PASS. This request is complete without choosing an invented future semver or creating a release; the release owner assigns the tag when the gate is consumed.

- [ ] **Step 4: Run the final verification sweep with real exit codes (5 minutes of active work).**

```bash
(cd agent && go test -race ./internal/collectors/hwhealth/...)
(cd agent && go test -race ./...)
(cd agent && go vet ./...)
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit
# W04's seeded UI regression is separate from the live screenshots captured above.
pnpm wt-stack test -- tests/device-hardware-health.spec.ts
jq -n --arg commit "$(git rev-parse HEAD)" \
 '{commit:$commit,goRace:true,goVet:true,docsCheck:true,docsBuild:true,apiTypecheck:true,hardwareE2e:true}' > "$EVIDENCE/w06-release-validation.json"
bash "$LAB/test-release.sh"
```

Expected exit 0 for each command, docs build completed, Playwright passed; `set -e` must still be active. Do not pipe typecheck to `tail`. If a lab regression requires a small product fix, first add its real failing test in the owning file, capture red, implement the fix and rerun its wave's suites plus the affected live task. No speculative patch is prewritten here. Tenancy changes additionally require the following exact commands; absence of such changes makes them conditional, not false W06 evidence. These existing suites live under `apps/api/src/__tests__/integration/` (paths verified in this checkout).

```bash
pnpm test-stack up
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
pnpm test-stack down
```

Expected all integration tests pass with the real test database; this does not use the enrolled agents' live lab database.

- [ ] **Step 5: Commit docs and release handoff (2 minutes).**

```bash
review_evidence docs/superpowers/plans/monitoring/evidence/w06-release-validation.json
git add apps/docs/src/content/docs/features/hardware-monitoring.mdx docs/release-notes/next-release-draft.md docs/superpowers/plans/monitoring/evidence/w06-release-request.md docs/superpowers/plans/monitoring/evidence/w06-release-validation.json
git commit -m $'docs(monitoring): record hardware coverage and agent release gate\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 19: Publish reviewed evidence, restore the lab and close through feature-lifecycle

**Files:** Create `docs/superpowers/plans/monitoring/evidence/w06-close-checklist.md`. Read `.claude/skills/worktree-stack/SKILL.md:32–68`. Test: `$LAB/test-close.sh`. Feature-lifecycle tool schemas were read from `~/Hive/mcp-servers/feature-lifecycle-mcp/src/tools/waves.ts:81–120` and `src/tools/features.ts:229–263`; these are MCP tools, not shell subcommands.

**Interfaces:** Consumes all receipts and the W06 PR. Produces W06 issue evidence links, `complete_wave({feature_ref:string,wave_ref:string,pr?:number,commit?:string,notes?:string})` and `close_feature({feature_ref:string,notes?:string})` results. `complete_wave` needs `pr` or `commit`; `close_feature` only warns about open waves, so this task enforces the stronger prerequisite itself.

- [ ] **Step 1: Write and run the final evidence assertion (3 minutes).**

```bash
cat > "$LAB/test-close.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
import json,os,pathlib
p=pathlib.Path(os.environ['EVIDENCE'])
for name in ('environment','policy','windows-baseline','windows-degraded','windows-recovered',
             'policy-toggle','linux-baseline','linux-degraded','linux-rebuilding','linux-recovered',
             'zfs','storcli','perccli','megacli','ssacli','arcconf','omreport','ipmi','racadm','hponcfg','release-validation'):
    assert json.loads((p/f'w06-{name}.json').read_text()), name
for name in ('windows-baseline','windows-degraded','windows-recovered','policy-disabled',
             'linux-baseline','linux-degraded','linux-rebuilding','linux-recovered'):
    assert (p/f'w06-{name}.png').read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), name
assert 'Lab resources restored' in (p/'w06-close-checklist.md').read_text()
print('PASS complete W06 evidence and cleanup checklist')
PY
SH
bash "$LAB/test-close.sh"
```

Expected red: missing `w06-close-checklist.md`. Review every screenshot and JSON before publication; raw API bodies can contain source paths, BMC addresses and vendor attributes. Apply the same private replacement map to JSON evidence, keep alert IDs/component-key equality intact, and retake/crop any screenshot showing infrastructure or customer data. Never commit `$LAB`, login state, push response/download token, or agent config.

- [ ] **Step 2: Restore only this run's disposable storage and policy (4 minutes).**

```bash
api PATCH "/configuration-policies/$POLICY_ID/features/$HW_LINK_ID" \
 '{"inlineSettings":{"enabled":true,"pollIntervalMinutes":10,"diskHealthIntervalMinutes":60}}' > "$LAB/restored-policy.json"
winps <<'PS'
$ErrorActionPreference='Stop'
Get-VirtualDisk -FriendlyName BreezeW06Mirror | Remove-VirtualDisk -Confirm:$false
Get-StoragePool -FriendlyName BreezeW06Pool | Remove-StoragePool -Confirm:$false
foreach ($p in @('C:\BreezeW06\member-a.vhdx','C:\BreezeW06\member-b.vhdx')) {
  if ((Get-VHD -Path $p).Attached) { Dismount-VHD -Path $p }
  Remove-Item -LiteralPath $p
}
if (Get-StoragePool -FriendlyName BreezeW06Pool -ErrorAction SilentlyContinue) { throw 'Pool cleanup failed' }
PS
ssh "$LINUX_SSH" 'bash -se' <<'SH'
set -euo pipefail
if command -v zpool >/dev/null && zpool list breeze-w06 >/dev/null 2>&1; then zpool destroy breeze-w06; fi
source /var/tmp/breeze-w06/loops.env
mdadm --stop /dev/md0
for member in "$LOOP_A" "$LOOP_B"; do
  backing=$(losetup -n -O BACK-FILE "$member")
  case "$backing" in /var/tmp/breeze-w06/member-*.img) losetup -d "$member";; *) exit 1;; esac
done
rm -f /var/tmp/breeze-w06/member-a.img /var/tmp/breeze-w06/member-b.img
rm -f /var/tmp/breeze-w06/zfs-a.img /var/tmp/breeze-w06/zfs-b.img
[ ! -b /dev/md0 ] || ! mdadm --detail /dev/md0 >/dev/null 2>&1
SH
api DELETE "/configuration-policies/$POLICY_ID" > "$LAB/deleted-policy.json"
[ "$(sql "SELECT count(*) FROM configuration_policies WHERE id='$POLICY_ID'::uuid;")" = 0 ]
```

Expected no W06 pool, no assembled md0, detached owned loops, no lab policy. Retain source/test logs privately until evidence review completes. Dev-push disables agent auto-update; leave these dedicated lab agents pinned deliberately and document that fact rather than silently enabling a production update path. The SMART test disk remains with its original owner and was never formatted.

- [ ] **Step 3: Write and commit the reviewable evidence index (3 minutes).**

```bash
python3 - <<'PY'
import os,pathlib
p=pathlib.Path(os.environ['EVIDENCE'])
rows=['# W06 completion checklist','',
 '- [x] Lab resources restored: only this run’s VHDX, md0, loops, optional ZFS pool and configuration policy removed.',
 '- [x] Windows and Linux dedicated lab agents remain pinned to their tested dev builds; auto-update remains disabled intentionally.',
 '- [x] Agent release request recorded; this lab completion does not claim fleet release or promotion.',
 '- [x] Vendor coverage distinguishes fixture-only, real capture and live lab fault proof.',
 '- [x] Screenshots and structured evidence reviewed for credentials and internal infrastructure before publication.',
 '', '## Evidence','']
for f in sorted(p.glob('w06-*')):
    if f.name!='w06-close-checklist.md': rows.append(f'- [{f.name}]({f.name})')
(p/'w06-close-checklist.md').write_text('\n'.join(rows)+'\n')
PY
bash "$LAB/test-close.sh"
git diff --check
git add docs/superpowers/plans/monitoring/evidence/w06-close-checklist.md
git commit -m $'docs(monitoring): index hardware lab exit evidence\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

Expected evidence PASS and clean diff. Checkboxes attest completed work; do not run this writer until each statement has been checked. If existing wave prerequisites have red checks, leave the issue open.

- [ ] **Step 4: Put evidence on the W06 and parent issues, and verify the merged PR (5 minutes of active work).**

```bash
branch="$(git branch --show-current)"
git push -u origin "$branch"
printf 'Proves the required Windows and Linux hardware monitoring lab paths and records vendor coverage.\n\nCloses #%s\n\nAgent release required: W02a, W02b and W05. Release request and evidence are in docs/superpowers/plans/monitoring/evidence/.\n' "$WAVE_ISSUE" > "$LAB/pr-body.md"
gh pr create --title "test(monitoring): hardware lab proof (#$WAVE_ISSUE)" --body-file "$LAB/pr-body.md"
export WAVE_PR="$(gh pr view --json number --jq .number)"
gh pr checks "$WAVE_PR" --watch
# Run only after the required PR review is complete and checks above are green.
gh pr merge "$WAVE_PR" --squash --admin
gh pr view "$WAVE_PR" --json state,mergeCommit > "$LAB/merged-pr.json"
jq -e '.state=="MERGED" and .mergeCommit.oid!=null' "$LAB/merged-pr.json"
export EVIDENCE_COMMIT="$(jq -er .mergeCommit.oid "$LAB/merged-pr.json")"
export REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
python3 - <<'PY'
import os,pathlib
base=f'https://github.com/{os.environ["REPO"]}/blob/{os.environ["EVIDENCE_COMMIT"]}/docs/superpowers/plans/monitoring/evidence/'
p=pathlib.Path(os.environ['LAB'])/'issue-evidence.md'
rows=['W06 lab proof and agent release request.','',
      f'PR #{os.environ["WAVE_PR"]}; evidence commit `{os.environ["EVIDENCE_COMMIT"]}`.','']
for f in sorted(pathlib.Path(os.environ['EVIDENCE']).glob('w06-*')):
    rows.append(f'- [{f.name}]({base}{f.name})')
unverified=[]
for source in ('storcli','perccli','megacli','ssacli','arcconf','omreport','ipmi','racadm','hponcfg'):
    import json
    m=json.loads((pathlib.Path(os.environ['EVIDENCE'])/f'w06-{source}.json').read_text())
    if m['status']=='fixture-only': unverified.append(source)
rows.append('Fixture-only sources (no real capture): '+(', '.join(unverified) or 'none')+'.')
z=json.loads((pathlib.Path(os.environ['EVIDENCE'])/'w06-zfs.json').read_text())
rows.append('Optional ZFS: '+z['status']+'.')
rows += ['', 'Screenshots and alert IDs are in the linked evidence. Agent release is required; the release request records the canary and controlled-promotion gates.']
p.write_text('\n'.join(rows)+'\n')
PY
gh issue comment "$WAVE_ISSUE" --body-file "$LAB/issue-evidence.md"
gh issue comment "$FEATURE_ISSUE" --body-file "$LAB/issue-evidence.md"
```

Expected all required PR checks pass, merged-state jq `true`, and two comment URLs. If the PR is still open, stop at this gate; do not mark the feature complete using an unmerged implementation. `gh issue comment` has no arbitrary binary attachment flag: immutable blob links make committed screenshots and alert-ID receipts available on the issue.

- [ ] **Step 5: Invoke the actual lifecycle tools and assert GitHub closure (4 minutes).**

```bash
# Read the installed server location; this is an MCP stdio server, not a lifecycle CLI.
read -r -p 'Installed feature-lifecycle MCP package directory: ' LIFECYCLE_ROOT
export LIFECYCLE_ROOT
[ -f "$LIFECYCLE_ROOT/dist/index.js" ]
export GITHUB_TOKEN="$(gh auth token)"
[ -n "$GITHUB_TOKEN" ]
cat > "$LAB/lifecycle.cjs" <<'JS'
const fs = require('node:fs');
const { createRequire } = require('node:module');
const req = createRequire(process.env.LIFECYCLE_ROOT + '/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');
(async () => {
  const client = new Client({ name: 'breeze-w06-proof', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [process.env.LIFECYCLE_ROOT + '/dist/index.js'], env: process.env }));
    const result = await client.callTool({ name: process.argv[2],
      arguments: JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) });
    if (result.isError) throw new Error(JSON.stringify(result));
    const payload = JSON.parse(result.content.find(x => x.type === 'text').text);
    if (payload.status !== 'ok' || payload.warning) throw new Error(JSON.stringify(payload));
    console.log(JSON.stringify(payload));
  } finally { await client.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
JS
jq -n --arg ref "$REPO#$FEATURE_ISSUE" --argjson pr "$WAVE_PR" \
  --arg notes "Lab evidence and agent release request: PR #$WAVE_PR, commit $EVIDENCE_COMMIT" \
  '{feature_ref:$ref,wave_ref:"W06",pr:$pr,notes:$notes}' > "$LAB/complete-wave.json"
node "$LAB/lifecycle.cjs" complete_wave "$LAB/complete-wave.json" > "$LAB/complete-wave-result.json"
gh api --paginate "repos/$REPO/issues/$FEATURE_ISSUE/sub_issues" --jq '.[]|{number,state,body}' > "$LAB/subissues.jsonl"
jq -se 'length>=7 and all(.state=="closed")' "$LAB/subissues.jsonl"
jq -n --arg ref "$REPO#$FEATURE_ISSUE" --rawfile notes "$LAB/issue-evidence.md" \
  '{feature_ref:$ref,notes:$notes}' > "$LAB/close-feature.json"
node "$LAB/lifecycle.cjs" close_feature "$LAB/close-feature.json" > "$LAB/close-feature-result.json"
gh issue view "$WAVE_ISSUE" --json state --jq .state
gh issue view "$FEATURE_ISSUE" --json state --jq .state
```

Expected both MCP results `status:"ok"`, no warning, and both issues `CLOSED`. Seven waves exist because W02 is split into W02a/W02b. Use the installed server's existing GitHub credentials; credential failure leaves closure unperformed, never replaced with a fabricated status. Preflight every sub-issue before `close_feature` because the tool itself does not enforce completion.

- [ ] **Step 6: Tear down only stacks owned by this execution (2 minutes).**

```bash
if [ "$OWNS_STACK" = true ]; then pnpm wt-stack down; fi
# If a small tenancy fix required a test stack this run, also execute pnpm test-stack down.
docker compose ls -a --format json | jq -r '.[]|[.Name,.Status]|@tsv'
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}'
if [ "$OWNS_STACK" = true ]; then
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]
fi
```

Expected no containers belonging to the owned worktree project; do not remove another session's projects. Report any pre-existing stack or pinned lab agent intentionally left running. Closure receipts live on GitHub; no post-merge commit is needed to amend the evidence with issue status.

## Self-review

- Spec §13/§14 W06: Windows Storage Spaces and Linux md fault/recovery, screenshots, subject alert IDs and native agent suites are covered by Tasks 1–7 and 18–19.
- Spec §13: Task 8 records optional ZFS explicitly; Task 6 requires a real SMART-capable device rather than pretending loop devices support SMART.
- Spec §5.1/§13/§15: Tasks 9–17 capture every vendor command family; unavailable vendor access remains fixture-only and never blocks the explicitly permitted fallback.
- Spec §6.3/§10: Task 5 starts its silence window after the disabled snapshot and restores collection; it does not equate disabled collection with recovery.
- Spec §9.3 and index §J: critical array alerts may resolve during rebuilding after two below-critical snapshots; Tasks 4 and 7 still require final optimal-state evidence.
- W01 owns schema, ingest ordering, tenancy, retention and settings; W03 owns subject dedupe, notifications, response ownership and streak-handler correctness. W06 consumes their merged implementation and does not reimplement them.
- W02a/W02b own parsers, bounded runner and scheduler; W05 owns BMC linking and side-effect gates; W04 owns UI implementation and seeded e2e. W06 records coverage without claiming vendor hardware fault proof.
- Index §C/§E take precedence over the spec's older key spellings: agent route is `:agentId`, heartbeat key is `hardware_monitoring_settings`, and operator inline settings are camelCase.
- Index §J leaves evidence naming and runtime timing to this plan: stable `w06-` filenames, private runtime identities, 5/15-minute lab intervals and observed snapshot streaks are chosen here.
- Release request satisfies §13's agent-release note; publishing tags, marketing notes and fleet promotion follow the release workflow, while feature closure requires the merged lab evidence and all seven wave issues closed.
