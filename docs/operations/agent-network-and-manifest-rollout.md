# Agent Network Policy and Manifest Rollout (Wave 6 Security Remediation)

This runbook is for the operator rolling out Wave 6's agent-updater and
managed-software network hardening. It covers the two compatibility
controls this task owns (`AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID`,
`MANAGED_SOFTWARE_POLICY_MODE`), the canary-ring promotion procedure, the
three ways an agent can silently strand itself that earlier tasks in this
wave surfaced, and the frozen manifest-key-rotation procedure.

**This document plans the rollout. It does not execute it.** No `activate`
step, no `enforce` flip, and no ring promotion beyond internal test devices
should be treated as already decided by writing this file — each ring below
requires its own explicit go/no-go decision.

Related reading:
- `docs/deploy/agent-update-trust-bootstrap.md` — how per-deployment manifest
  trust is established on self-host and what TOFU/rejection semantics mean
  day to day. **Note:** that page still says key delegation "is not in this
  release" — Wave 6 Task 7 has since shipped `manifest-key-rotation.ts`
  (frozen behind the gates in [§5](#5-manifest-key-rotation-frozen) below).
  Treat this runbook as authoritative on delegation status until that page
  is updated.
- `docs/operations/cloudflare-mtls-setup.md` — same phased-rollout shape,
  useful as a template for how these sections read.

---

## 1. What you're turning on

| Variable | Values | Default | Effect |
|---|---|---|---|
| `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID` | `true` / `false` | `false` | The API pushes `configUpdate.require_manifest_signing_key_id=<true or false>` on **every** heartbeat response, mirroring the current env var value — not just when it's `true`. This makes the switch reversible: flipping the env var back to `false` reverts a capable agent on its next heartbeat. |
| `MANAGED_SOFTWARE_POLICY_MODE` | `compat` / `enforce` | `compat` | Gates every managed-software (`software_install`) command dispatch. `compat` still fails closed on a private destination for a capability-0 device; `enforce` additionally requires capability ≥ 1 for apparently-public destinations. |

Both boot-refuse on any value other than the two listed (a typo is a hard
config error, not a silent fallback to the safe default) — see
`apps/api/src/config/validate.ts` and its test suite. Both are mapped with a
default-bearing form (`${VAR:-default}`) in `docker-compose.yml` and
`deploy/docker-compose.prod.yml`, so a missing `.env` value never prevents
the stack from starting.

**Important asymmetry — read before flipping `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID`:**
this is **not** a no-op switch, and it is **not** fleet-wide. The agent build
shipped in this wave now reads `configUpdate.require_manifest_signing_key_id`
(both `snake_case` and `camelCase` accepted) in `applyConfigUpdate`
(`agent/internal/heartbeat/heartbeat.go`), sets
`h.config.RequireManifestSigningKeyID`, and persists it to `agent.yaml` via
`config.SetAndPersist` — a pushed value survives a restart. The API sends
`require_manifest_signing_key_id` (as `true` or `false`, tracking the env
var) on **every** heartbeat response, and **any agent running this build or
newer acts on it** — including reverting a previously-persisted `true` back
to `false` when the env var is flipped back, so the switch is reversible
without touching individual devices. **Any agent build older than this
one still ignores the pushed value entirely** and keeps accepting
ID-less manifests regardless of what the API sends — those agents are
unaffected by this env var and are covered by the missing-ID warning count
in [§4](#4-require-exact-manifest-signing-key-id) instead.

Timing on a capable agent: the config write takes effect immediately for the
in-memory setting, but the updater client itself is only constructed at
update-check time and at helper-manager startup, so the observable effect
differs by call site:

- **Update checks driven by the agent process** (main, helper, and the
  agent's own watchdog-binary download) read the flag through
  `h.requireManifestSigningKeyID()` fresh at updater-construction time on
  every check, so a pushed change takes effect on the **next update check** —
  no agent restart required.
- **The standalone `breeze-watchdog` process** loads its config once at
  `agent/cmd/breeze-watchdog/main.go:328` and threads that same
  `*config.Config` into its own `doUpdateAgent` and `doUpdateWatchdog` paths.
  Its later `config.Load("")` calls refresh only the failover server URL,
  never this field. So the watchdog-driven agent-binary download — the path
  that runs precisely when the agent is down — keeps the old value until the
  **watchdog service** restarts. This is now the ONLY startup-capture case.
- **The helper manager follows a pushed change too.**
  `helper.WithRequireManifestSigningKeyID` and `helper.WithManifestKeys` take
  **providers** (`func() bool` / `func() []string`) wired to
  `h.requireManifestSigningKeyID` and `h.pinnedManifestPubKeys`, so the
  verified helper downloader resolves both on every download rather than at
  `helper.New(...)`. Passing them by value was a real defect: once a delegated
  manifest signing key is **activated**, the server signs helper manifests with
  the new key ID, and a Manager holding a process-start snapshot of the pinned
  set would fail Breeze Assist install/update closed — with no server-side
  signal — until the agent process restarted.

**The API is authoritative for any fleet running this build or newer —
hand-editing `agent.yaml` does not stick.** This is the intended design: a
capable agent persists whatever `require_manifest_signing_key_id` value the
API sent on its most recent heartbeat, so with the API default
(`AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID` unset, i.e. `false`) the server
pushes `false` on every heartbeat and the agent writes that back to
`agent.yaml` on its next check-in — silently reverting an operator's
hand-set `true`. This is fail-open from the server's perspective (the agent
falls back to accepting ID-less manifests), and the only signal is an
agent-side `Info` log, not an error. A hand-edit only sticks in two cases:
the device is offline (never receives a heartbeat to be overwritten by), or
the API is *also* set to `true` — in which case the hand-edit was redundant.
For per-fleet enforcement independent of this rollout gate, set the API env
var; do not rely on `agent.yaml` alone.

`MANAGED_SOFTWARE_POLICY_MODE` has no such gap: `getManagedSoftwarePolicyMode()`
in `apps/api/src/services/managedSoftwareDispatchPolicy.ts` reads it directly
and the gate is live on every managed-software dispatch as soon as the API
boots with the new build, regardless of agent version.

---

## 2. Pre-flight fleet checks (run before flipping ANY switch)

Task 6 (exact manifest-signing-key-ID verification) closed the "any trusted
key can sign for any agent" hole by making the agent's local key trust set
frozen and exact-match. That fix has three ways to silently and permanently
strand an already-enrolled agent's auto-update. None of them are caused by
anything in *this* task — they are pre-existing exposure from Task 6 that a
rollout must screen for first, because none of the switches below make them
better or worse; they can already be true in your fleet today.

All three end the same way: **the agent stops updating, permanently, with no
server-side error surfaced to you** unless you go looking. Re-enrollment is
the only remediation for all three (there is no in-place repair for a
stranded agent).

### (a) Malformed on-disk pinned manifest key entry → fails closed entirely

A garbled `pinned_manifest_pub_keys` entry in `agent.yaml` (however it got
there — hand edit, disk corruption, a pre-Task-6 write path) used to be
silently skipped, falling back to the embedded vendor root. It is now a hard
failure: the whole local trust set becomes unusable and the agent accepts
**no** update, ever, until fixed.

**Detection.** The agent emits one bounded line per distinct cause when this
happens, and (assuming the log shipper is running — the default) it reaches
`agent_logs`:

```sql
SELECT device_id, org_id, timestamp, message, fields
FROM agent_logs
WHERE level = 'error'
  AND message LIKE 'SECURITY: manifest trust set is unusable%'
ORDER BY timestamp DESC;
```

This is retrospective (it only fires once the agent has already tried and
failed an update check), so it will not surface an agent that has been
offline or on a long heartbeat interval. Treat a non-empty result as a
minimum, not an exhaustive count.

**Remediation.** Re-enroll the affected device (re-enrollment re-bootstraps
`pinned_manifest_pub_keys`) — see the enrollment procedure in
`docs/guides/AGENT_INSTALLATION.md#enrollment` and the flow reference in
`apps/docs/src/content/docs/agents/enrollment.mdx`. There is no way to
hand-repair the file in place that is safer than re-enrollment —
hand-editing risks pinning the wrong bytes.

### (b) Agent pinned to a `keyId` that is not the server's current active `keyId`

If your deployment ever rotated its manifest signing key using the *old*
"insert a new `manifest_signing_keys` row with a different `key_id`, retire
the old one" recipe (the recipe `docs/deploy/agent-update-trust-bootstrap.md`
documented before Task 6 — it has since been removed from that page because
it is now the attack Task 6 closes), you may have agents pinned to
`deploy-A` while the server signs and names `deploy-B`. This is **the
highest-risk item in this checklist** and is not hypothetical for any
self-host that ever rotated the key before this wave.

Two independent failures result for those agents:
- the heartbeat's attempt to deliver `deploy-B` as a trust-set update is
  rejected as key expansion, and
- the download response's `signingKeyId: deploy-B` is unknown to the agent,
  so every update check fails signature verification.

Auto-update is dead for those agents until re-enrollment.

**Detection — do this BEFORE flipping any switch, not after.** This is a
pre-flight check, not a retrospective log query, because the condition is
silent until an update is attempted. Compare each agent's on-disk pinned key
ID against the deployment's current active signing key.

Server side — find the currently active key ID:

```sql
SELECT key_id, status, created_at
FROM manifest_signing_keys
WHERE status = 'active';
```

Fleet side — for each device, read the pinned key ID(s) out of
`agent.yaml`'s `pinned_manifest_pub_keys` (format `<keyId>:<base64>`) via
whatever fleet/config-management access you have (SSH sweep, Breeze script
dispatch to a read-only diagnostic command, MDM inventory, etc. — there is
no server-side field carrying this value; it is never uploaded). Flag any
device whose pinned key ID does not match the active `key_id` from the query
above.

Corroborating (retrospective, catches agents that have already tried and
logged the rejection):

```sql
SELECT device_id, org_id, timestamp, message, fields
FROM agent_logs
WHERE level = 'error'
  AND message LIKE 'SECURITY: manifest trust key expansion rejected%'
ORDER BY timestamp DESC;
```

**Remediation.** Re-enroll every flagged device. There is no server-side fix
— the API cannot make an agent trust a key it has not accepted via TOFU or a
signed delegation (see §5).

### (c) Legacy multi-key pins are frozen, not pruned

Before Task 6, a second key delivered over the wire was silently appended to
`pinned_manifest_pub_keys` (this was itself the vulnerability being closed —
including the scenario where that second key was attacker-appended). Task 6
does not remove any existing extra key: `ParsePinnedManifestKeys` only
rejects malformed entries, and the pin file is never rewritten to prune a
non-empty set. An agent that accumulated a second trusted key under the old
behavior keeps trusting it indefinitely. Exact-ID verification limits the
blast radius (an attacker must now also get the API to name their key ID),
but the key remains trusted.

**Detection.** There is no active rejection to log for this case — it is
dormant risk, not an error — so it is **file-inspection only**, same
mechanism as (b): read `pinned_manifest_pub_keys` from `agent.yaml` across
the fleet and flag any device with more than one entry.

**Remediation.** Re-enroll flagged devices. Pruning a trusted key in place is
deliberately out of scope for Task 6 — removing a key is a trust *change*,
which is what Task 7's signed delegation protocol (§5) exists to authorize
under controlled conditions, not something a rollout script should do
unilaterally.

### Pre-flight checklist summary

Before touching `MANAGED_SOFTWARE_POLICY_MODE`, `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID`,
or any manifest-key-rotation step:

1. Run the (b) comparison (active key vs. every pinned key ID) across the
   whole fleet, not a sample — this is the one that silently kills
   auto-update permanently with zero server-side signal.
2. Run the (c) multi-key-entry sweep.
3. Run the (a) `agent_logs` query as a retrospective sanity check.
4. Re-enroll everything flagged before proceeding to §3.

---

## 3. Canary rings

Promote through these rings in order, one explicit go/no-go decision per
ring. Do not compress rings; each exists to bound the blast radius of a
still-unknown failure mode. Self-hosted operators are not part of the hosted
percentage rings — they opt in on their own schedule, after reading this
runbook and running the §2 pre-flight checks against their own fleet.

| Ring | Scope |
|---|---|
| 0 | Internal test devices |
| 1 | Staging |
| 2 | 1% of hosted fleet |
| 3 | 10% of hosted fleet |
| 4 | 50% of hosted fleet |
| 5 | 100% of hosted fleet |
| — | Self-hosted operators, opt-in on their own schedule |

### At every ring, verify

- **Updater success** — agents in the ring successfully check for, download,
  verify, and apply an update.
- **Public CDN redirects** — a public update source (GitHub Releases CDN or
  your configured `BINARY_SOURCE=local` origin) redirect chain completes;
  the shared transport (Task 2/3) revalidates every hop and this should be
  unaffected, but a redirect-heavy CDN is exactly where a regression would
  surface.
- **Configured private control plane** — if `server_url` / `backup_server_url`
  is a private address (self-hosted, common), heartbeats and downloads
  against it keep working. The configured control-plane origin is an
  explicit exception to the private-address block, by exact origin only —
  confirm it is not being accidentally denied.
- **Approved private software source** — a capability-1 device with an
  org/site `approvedPrivateOrigins` entry can still download from it.
- **Unapproved private denial** — a private destination NOT on the allowlist
  is still denied for both capability-0 and capability-1 devices.
- **System/stderr logging** — Task 8's Unix log hardening: file logging can
  fail (unsupported filesystem, permission issue) without losing
  system/stderr output. Confirm you still see agent activity in
  `journalctl`/Windows Event Log/stderr even if you deliberately break file
  logging in a test device.
- **File modes** — log files `0600` under a `0700` directory; a symlinked
  log path or directory component is rejected and file logging disables
  itself rather than following the link.

Record the go/no-go decision (who decided, what was checked, timestamp) for
each ring before promoting to the next. This runbook does not prescribe
where you record it — use whatever change-log/incident-tracking process this
deployment already uses.

### Stop conditions (halt promotion immediately on any of these)

- Any unexplained updater failure.
- A private-control-plane denial (the configured `server_url`/
  `backup_server_url` origin gets rejected).
- A software-download denial that isn't explained by the compat/enforce
  matrix in §4.2 (i.e., a *legitimate* destination denied).
- Any signature or key-ID failure outside the three known stranding modes in
  §2 (those are pre-existing and pre-flight-checked; a *new* one appearing
  mid-rollout is a stop condition).
- Log-output loss — file logging disabling itself is expected/safe under
  Task 8's design; system/stderr output going silent is not.
- Any race or crash regression (`go test -race` failures reproduced against
  a canary device's behavior, or a crash-loop signal from ops alerting).

**On any stop condition:** halt promotion at the current ring. Recovery is a
higher-SemVer forward fix, or the explicit operator recovery path (see
§6) — **never** an assumed automatic downgrade. `versionpolicy.Decide` has
no highest-ever-version watermark by design (this was a deliberate choice —
see the plan's Global Constraints), so nothing in the agent structurally
blocks you from *trying* to point the fleet at an older version, but doing
so is an explicit operator action outside the automatic-update path, not
something this rollout invokes as a step.

---

## 4. `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID` rollout

Recall from §1: this build's agent *does* consume `configUpdate.require_manifest_signing_key_id`
(a capable agent applies it on its next update check), but any agent build
older than this one still ignores it. Because a mixed-version fleet is the
normal case during a rollout, flipping the env var to `true` before you've
confirmed the fleet is actually ready still only benefits agents new enough
to read it — every older agent keeps its current (compatible) behavior
either way. The rollout gate below describes the state you need to reach
before requiring exact key IDs matters — most of the actual work here is
observational, not a switch you flip blind.

1. **Exact-ID preference ships by default already.** As of Task 6, any
   update response that *does* carry a `signingKeyId` is verified against
   that key alone — this is unconditional, not gated by this env var. Ship
   this (already true on this branch) before doing anything else in this
   section.
2. **Observe the missing-ID count.** Every update response your API serves
   should carry `signingKeyId` (stamped from `agent_versions.signing_key_id`
   at sync time). An agent that receives a response *without* one falls
   back to whole-key-set verification and logs one bounded warning per
   process:

   ```sql
   SELECT device_id, org_id, timestamp, message, agent_version
   FROM agent_logs
   WHERE level = 'warn'
     AND message LIKE 'update manifest response omitted signingKeyId%'
   ORDER BY timestamp DESC;
   ```

   Also confirm server-side that every *active* server version stamps a
   `signingKeyId`:

   ```sql
   SELECT version, signing_key_id
   FROM agent_versions
   WHERE is_latest = true AND signing_key_id IS NULL;
   ```

   `is_latest = true` only flags the single current head of each
   component's release line — an older version that is not `is_latest` but
   is still being served to devices that haven't reached the target version
   yet (a normal state mid-rollout) is excluded by this filter and can still
   omit `signing_key_id` without being caught here. Add a clause covering
   any version still actively served, not just the latest:

   ```sql
   SELECT version, signing_key_id
   FROM agent_versions
   WHERE signing_key_id IS NULL
     AND (is_latest = true OR version IN (
       SELECT DISTINCT agent_version FROM devices
     ));
   ```

   This should return zero rows before proceeding.
3. **Require ID only after the missing-ID count stays at zero for 7
   consecutive days AND every active server version supplies
   `signingKeyId`.** For any agent running this build or newer, that means
   setting `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=true` on the API — the
   config now reaches those agents on their next update check. Any agent
   older than this build still doesn't read the pushed config; for those,
   "requiring" it fleet-wide still means hand-setting
   `require_manifest_signing_key_id: true` in `agent.yaml` via your
   config-management tooling.
4. Setting `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=true` on the API is a new
   behavior change for every capable agent in the fleet simultaneously (it
   is a single API-wide env var, not a per-device rollout knob) — re-run the
   §3 canary rings against a representative capable-agent population before
   flipping it in production, and treat any unexpected
   `manifest signing key ID required` rejection as a stop condition.

   **Rollback lever:** because the API always sends
   `require_manifest_signing_key_id` (see §1), this is reversible — set
   `AGENT_REQUIRE_MANIFEST_SIGNING_KEY_ID=false` and every capable agent
   reverts on its next heartbeat, no per-device action needed. This only
   covers agents on this build or newer; for anything older, "requiring"
   or rolling back is still the hand-edited `agent.yaml` path described in
   step 3.

---

## 5. Manifest key rotation (frozen)

Rotation uses `apps/api/scripts/manifest-key-rotation.ts`, a two-phase
`prepare` / `activate` CLI. **Do not run `activate` as part of this rollout.**
This runbook documents the procedure; it does not execute it.

```
pnpm --filter @breeze/api exec tsx scripts/manifest-key-rotation.ts prepare
pnpm --filter @breeze/api exec tsx scripts/manifest-key-rotation.ts prepare --valid-days 45
pnpm --filter @breeze/api exec tsx scripts/manifest-key-rotation.ts activate --epoch 3 --confirm-adoption
```

- `prepare` creates a new key (stored `retired`) plus a delegation record
  signed by the currently active key. It changes nothing about which key
  signs manifests. Agents begin adopting the new key (via TOFU-safe signed
  delegation, not the frozen additive path) on their next check-in.
- `activate` retires the old key, activates the new one, and stamps the
  delegation as activated, atomically. It refuses to run unless `--epoch`
  matches the prepared epoch and `--confirm-adoption` is present.

**`--confirm-adoption` is an unverifiable operator assertion — there is
currently no fleet-adoption telemetry.** The agent's adopted delegation
epoch (`ManifestDelegationEpoch`) is persisted locally in `agent.yaml` and
is never reported back to the API. Nothing in this wave gives you a query
against `devices` or `agent_logs` that tells you which epoch a given device
has adopted. Do not treat `--confirm-adoption` as a checked precondition —
the CLI will not stop you from running it against an unadopted fleet. You
must confirm adoption by means outside this tooling before using the flag:
for example, an out-of-band agent-side diagnostic you build separately, a
staged rollout where you have direct evidence (support tickets, manual
spot-checks) that the fleet population has cycled through at least one
heartbeat since `prepare`, or simply waiting substantially longer than your
fleet's slowest heartbeat/check-in interval and treating that as
circumstantial (not proof) of adoption.

Given that gap, the plan's own gate is conservative on purpose — treat it as
a floor, not a target:

> Do not run `activate` until every non-retired device that checked in
> during the preceding 30 days reports the prepared delegation epoch,
> dormant devices are explicitly retired or assigned administrator
> recovery, and missing-ID compatibility (§4) has been disabled.

Since "reports the prepared delegation epoch" cannot currently be verified
by any query this wave provides, treat that clause as unsatisfiable today —
which is exactly why rotation stays frozen. Closing this gap (agent-reported
adoption epoch surfaced to the API) is a prerequisite for ever safely
running `activate` in production, not an optional nice-to-have. Track it as
a follow-up before this section of the runbook is actionable.

After `activate` (once the above is genuinely resolved, in some future
rollout): prove manifests signed by the new exact key ID succeed for a
canary device before considering rotation complete.

---

## 6. Recovery path

- **Preferred: higher-SemVer forward fix.** Ship a new version that reverts
  or corrects the problematic change and let normal automatic update carry
  it. `versionpolicy.Decide` has no downgrade path by design (Global
  Constraint: "Normal automatic downgrade remains blocked"), so a forward
  fix is the only thing the automatic-update path itself can deliver.
- **Explicit operator recovery path.** For a device already stranded (any of
  the §2 modes, or any other total loss of auto-update capability):
  re-enrollment is the standing remediation named throughout this wave —
  it re-bootstraps `pinned_manifest_pub_keys` and restores a working trust
  set. Where re-enrollment itself is impractical at scale (e.g., a fleet
  that cannot re-run enrollment unattended), fall back to your existing
  out-of-band installer/reinstall path (MSI/pkg/deb push) — this is a
  manual, per-fleet operator action outside the scope of any tooling this
  wave ships, and is intentionally not automated: an automatic path that
  can push an older or alternately-trusted binary to a fleet is the same
  shape of risk this wave closes.
- **Never** attempt to make the automatic-update mechanism serve an older
  version as a recovery step. Nothing in this wave adds a version watermark
  to prevent it structurally in every code path, but doing so silently
  reintroduces the exact "control plane can direct an unexpected version
  change" risk this wave is designed to close.

---

## 7. General operational notes

- **Environment proxies are ignored.** The updater and managed-software HTTP
  clients never consult `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or
  `NO_PROXY`. A host-level proxy requirement for other traffic does not
  extend to these two clients; there is no override.
- **Private control planes are allowed only by exact configured origin.**
  `server_url` / `backup_server_url` may be a private address, but the
  allowance is scoped to that literal configured origin — it is not a
  general "trust all private addresses" exception, and other private
  destinations (managed-software downloads, redirect targets) are evaluated
  independently against their own policy.
- **Private software sources require both policy and agent capability 1.**
  An org/site `approvedPrivateOrigins` entry is necessary but not
  sufficient — the dispatching device must also report
  `outboundNetworkPolicyVersion = 1` (i.e., have upgraded past the agent
  version that ships dial-time network policy). Query current fleet
  capability split:

  ```sql
  SELECT
    count(*) FILTER (WHERE outbound_network_policy_version >= 1) AS capability_1_plus,
    count(*) FILTER (WHERE outbound_network_policy_version = 0) AS capability_0,
    count(*) AS total
  FROM devices;
  ```

  Do not flip `MANAGED_SOFTWARE_POLICY_MODE=enforce` while a meaningful
  fraction of the fleet is still capability-0 — every managed-software
  command to those devices will be denied, `deployment_results.status =
  'failed'`, `error_message = 'agent_network_policy_upgrade_required'`.
- **Self-hosted object storage on a LAN address is now private-classified.**
  If your presigned software-download URLs point at a LAN address (e.g. a
  MinIO instance at `https://192.168.x.x:9000/...`), that destination is
  private under the new classifier. Capability-0 devices are denied even in
  `compat`; capability-1 devices need that origin added to the org/site
  `approvedPrivateOrigins` allowlist (`PUT /api/v1/software/download-policy`
  for org-wide, `PUT /api/v1/software/download-policy/sites/:siteId` for a
  single site; `GET /api/v1/software/download-policy` reads the effective
  org ∪ site union). Add this to your pre-flight checklist if you run
  self-hosted object storage for software packages.
- **An approved private HOST also blocks its public spelling for
  capability-0 devices in `compat`.** The gate classifies by host, not
  origin, deliberately (closing a trailing-dot / port / scheme bypass). A
  practical consequence: if you approve `files.corp.internal` as a private
  origin and split-horizon DNS also resolves that same hostname publicly,
  a capability-0 device is denied on that hostname regardless of which
  answer it would actually get — the classifier doesn't know DNS resolves
  differently for different networks, and treats the operator's declaration
  of "this host is private" as authoritative for the hostname, not the
  network path. This is intentionally the more conservative failure mode
  (denies a capability-0 device rather than risk the private answer), but
  it is a real, operator-visible behavior change worth knowing about before
  you file it as a bug.
- **`compat` vs. `enforce`, restated:**
  - `compat` (default): a private destination requires capability ≥ 1 and
    fails closed for capability-0 — this is the actual security fix, live
    from the first deploy of this wave. An apparently-public destination
    stays permitted to a capability-0 device, so deploy day does not fail
    every in-flight software push to a not-yet-upgraded fleet.
  - `enforce`: every managed-software command requires capability ≥ 1,
    public destinations included. This is the end state, closing the
    residual capability-0 exposure (DNS rebinding, public-to-private
    redirect) that `compat` still leaves to the agent's own dial-time
    policy as the sole defense. Flipping to `enforce` before the fleet has
    reached capability 1 denies **every** managed-software command to every
    remaining capability-0 device, public or private.

### Canary-ring row for the `compat → enforce` flip

Treat this as its own row alongside §3's rings, not a step folded into an
existing one — it has a different blast radius (every managed-software
command, not just updater traffic) and its own go/no-go gate.

| Step | Gate before flipping |
|---|---|
| Pre-check | Run the §7 fleet-capability query above; confirm the capability-0 count for the ring you're about to flip is zero or an explicitly accepted/communicated exception. |
| Ring 0 (internal test devices) | Set `MANAGED_SOFTWARE_POLICY_MODE=enforce` for the internal test API instance only. Verify an approved private source still deploys and an apparently-public source still deploys, both on capability-1 devices; verify denial on capability-0. |
| Ring 1 (staging) | Same checks against staging's device population. |
| Rings 2-5 (1% / 10% / 50% / 100% hosted) | Since this is a single API-wide env var (not a per-device rollout knob), "ring" here means: don't flip production `MANAGED_SOFTWARE_POLICY_MODE` until the fleet capability-0 count is at the acceptable floor you set at the pre-check, and stage the flip as its own change with its own rollback plan (revert the env var; no code deploy needed to roll back). |
| Self-hosted | Self-hosted operators flip this independently, after confirming their own fleet's capability split and re-checking the split-horizon-DNS note above if they run internal DNS. |

Stop condition specific to this flip: any *unexpected* software-download
denial (i.e., not explained by "device is capability-0 and destination
matters under the mode you just set") halts the flip — revert
`MANAGED_SOFTWARE_POLICY_MODE` to `compat` immediately; it is a single env
var, so rollback is a config change, not a deploy.
