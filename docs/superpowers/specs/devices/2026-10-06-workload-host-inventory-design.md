---
title: Workload host inventory — Docker, Hyper-V and Proxmox workloads on a device, and container image currency
status: draft — awaiting owner review (advisor quorum Fable + Codex gpt-6-astra xhigh folded in, §16)
date: 2026-10-06
issues: "#3834 (workload host inventory — this spec, W01–W04), #3813 (Docker image currency — W05–W06, optional W07–W08)"
related: "#1387 (guest virtualization axis on devices); 2026-09-23 hardware & RAID monitoring (driver/Source pattern, inline config feature, subject monitor kind); 2026-09-28 time sync (inline settings table, heartbeat delivery); 2026-09-26 memory modules (device child replace-set table template)"
---

# Workload host inventory

## 1. Product intent

Three asks converge on an abstraction Breeze lacks: a device that **hosts** workloads, and an inventory
of what runs on it.

- #3813 asks for Docker container inventory and image staleness. Today a host running twenty
  containers looks like a host running `dockerd` and nothing else. The only Docker reference in the
  agent collectors skips `docker*` interfaces during network inventory
  (`agent/internal/collectors/inventory.go:118`).
- Hyper-V inventory exists, but only as backup plumbing. `hyperv_vms`
  (`apps/api/src/db/schema/hypervVms.ts:17`) has exactly one writer, the operator-triggered
  `POST /backup/hyperv/discover` (`apps/api/src/routes/backup/hyperv.ts:208-273`), which sends the
  `hyperv_discover` command to the backup helper and upserts the result. Nothing removes a VM that has
  disappeared. A device whose VMs are not backed up has no VM inventory.
- Proxmox has nothing. It appears only in OS-name rendering
  (`apps/web/src/components/devices/osDisplay.ts:39-41`) and a port label
  (`apps/web/src/components/discovery/portCatalog.ts:65`).

#1387 made virtualization a second targeting axis, not a role
(`agent/internal/collectors/classify.go:59-64`), persisted as `devices.is_virtual` /
`virtualization_platform` (`apps/api/src/db/schema/devices.ts:79-80`). That is the **guest** axis:
*am I running on a hypervisor*. This spec adds the **host** axis: *do I host workloads, of which
runtime, and what are they*.

Success looks like:

1. **A container host is visible as one.** A Linux box with Docker installed shows "Docker 27.x —
   12 containers (9 running)" on its device page, and appears in a fleet filter "Hosts workloads:
   Docker" even when it runs zero containers.
2. **Hyper-V and Proxmox hosts list their VMs** without anyone running a backup discovery, refreshed
   on a schedule, with VMs that were deleted disappearing from the list.
3. **One partner-wide policy turns it on** for every org, per runtime.
4. **Stale images count.** (#3813) A host whose containers run an image whose tag has moved upstream
   reports "N images behind", that count lowers its patch compliance, and an alert can fire on it. The
   host no longer reads 100% patched while running a year-old image.
5. **Nothing the operator did not ask for changes on the host.** Collection is read-only. Any update
   action is a later, explicit, operator-triggered command against one named compose project.

### Out of scope

- **Scheduled or automatic image updates.** The repo already refuses image auto-updaters for its own
  production containers (`scripts/security/check-supply-chain-hardening.sh:668-673`); Breeze will not
  ship customers something it will not run itself. W08 (optional) is operator-triggered only.
- **Vulnerabilities inside image contents** (SBOM extraction, CVE matching of image layers). Image
  currency (digest comparison) already yields an actionable finding; layer CVEs need their own model.
- **Kubernetes control-plane management.** Nodes are detected (`containerd` on the host axis);
  enumerating pods via CRI is deferred (OD-5). Updating a k8s workload belongs to GitOps tooling.
- **VM lifecycle actions** (start/stop/checkpoint) from the inventory. Hyper-V actions keep living in
  the backup UI (`apps/web/src/components/backup/HypervVMActions.tsx`).
- **Folding `hyperv_vms` into `device_workloads`.** They coexist (D9).
- **Publishing workloads through the partner API.** Deferred (OD-6).
- **Alerting on VM state** ("VM stopped unexpectedly"). The data supports it later; not in this spec.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | New device child table `device_workloads`, one row per workload, unique `(device_id, runtime, workload_id)`. Typed columns only, no `jsonb` | Owner decision 2026-09-22 (name). Every `jsonb`/`bytea` column is forced into `excludedOpen` by the export registry, so a `details jsonb` catch-all would silently take runtime detail out of tenant export. |
| D2 | New device child table `device_workload_runtimes`, one row per `(device_id, runtime)`: detection result, collection status, version, counts, timestamps | Separates "Docker is installed" (detection) from "we enumerated it" (collection), so the UI can say "Docker 27.1 — collection disabled" or "permission denied", and so ingest can reconcile per runtime. |
| D3 | Host axis on `devices`: `hosts_workloads boolean NOT NULL DEFAULT false`, `workload_runtimes varchar(30)[] NOT NULL DEFAULT '{}'`, written by ingest from **detection**, never derived from workload rows | An empty Docker host is still a container host and must be targetable. A column filter beats an `EXISTS` at 10k+ devices. Array because a host can run Docker and Hyper-V. |
| D4 | Detection always runs; enumeration is opt-in per runtime through an inline config-policy feature `workload_inventory` (default off) | Detection (does the socket / service / CLI exist, plus the runtime version) is cheap and reveals nothing about the workloads. Enumeration lists customer workload names and images; the MSP turns it on. See OD-1. |
| D5 | Agent: one collector, one driver per runtime behind a `Driver` interface mirroring `hwhealth.Source` (`agent/internal/collectors/hwhealth/source.go:20-25`), own schedule loop | Same shape as hardware monitoring: build-tagged per-OS drivers, per-driver completeness, one send path. #3813 becomes the first driver, not a one-off. |
| D6 | Drivers in scope: `docker` (Docker Engine and Podman's Docker-compatible API), `hyperv`, `proxmox` (agent-on-host). `containerd` is detect-only | Owner decision 2026-09-22: Proxmox via agent-on-host, not API-polled. CRI enumeration needs a gRPC client or `crictl` (OD-5). |
| D7 | Read-only by construction: Docker driver uses a GET-only HTTP transport over the local socket; Hyper-V uses `Get-VM`; Proxmox uses `pvesh get` | The agent runs as root/SYSTEM and the Docker socket is root-equivalent. A transport that refuses non-GET makes "collection cannot change anything" a tested property, not a convention. |
| D8 | Field allowlist (§5.4): never env, command, args, entrypoint, mounts, volumes, networks, or labels other than the compose project/service/working-dir labels | Environment and arguments routinely carry secrets. Minimization is enforced in the driver and in the API's zod schema (unknown keys rejected). |
| D9 | `hyperv_vms` coexists; Hyper-V driver writes `device_workloads` only | Folding means a data migration plus rewrites of the backup route, partner API projection (`apps/api/src/routes/partnerApi/inventory.ts:355-368`) and AI tool (`services/aiToolsHyperv.ts`). Revisit after W03 (OD-7). |
| D10 | Disappearance: rows of a runtime whose snapshot is **ok and complete** are reconciled (missing → hard delete). Failed, unavailable, truncated or disabled snapshots never delete by absence | Containers are ephemeral; history is not the goal (memory-modules precedent, `services/inventoryChildSync.ts:291-353`). A failing driver must not wipe inventory. |
| D11 | Disabling a runtime (policy) deletes that runtime's workload rows; detection row stays | Turning collection off should remove what was collected. |
| D12 | Not a partner-export material table in v1 (no material statement triggers) | Nothing publishes it through the partner API yet (OD-6). Tenant export (GDPR) classification still applies in full. |
| D13 | Image currency (#3813) is checked **server-side** by a worker, with a system-only global cache of verified-public results, and per-row results copied onto `device_workloads` | Fleet-wide dedup (one registry request per unique public `repo:tag`); no registry credentials on devices; tenants read results only from their own rows (§9.3). |
| D14 | Compliance: image currency becomes a separate term in patch compliance through one shared helper, not synthetic `patches`/`device_patches` rows | Synthetic patch rows would be picked up by patch jobs and deployment flows. See OD-2 for exactly how it folds in. |
| D15 | Alerts: new subject monitor kind `container_image_currency`, subject = normalized image reference, with transactional retirement | Follows `hardware_health` / `time_sync` (`services/monitors/subjectMonitorKinds.ts`). Removing the last container using an image must resolve its alert (`services/hardwareHealth/retire.ts:17`). |
| D16 | `workload_inventory` trust tier = `protective` | It enables read-only collection; nothing executes, installs or receives a secret (`packages/shared/src/constants/configFeatureTypes.ts` `CONFIG_POLICY_FEATURE_TRUST_TIER`). |
| D17 | Fleet filter fields `hostsWorkloads` / `workloadRuntimes` are **execution-refused** | They come from the device's own report. Same class as `software.installed` (`apps/api/src/services/filterEngine.ts:237-250`). Browsing and protective targeting still work. |

## 3. Architecture and data flow

```
agent (root / SYSTEM)                                 API                                          web
──────────────────────                                ───                                          ───
heartbeat response ─ configUpdate.workload_inventory_settings ◄── resolver (inline feature, 120 s cache)
        │
workloads.Collector (own loop, default 60 min)
  for each driver: Detect() ── always
                   Collect() ── only if enabled for that runtime
  canonical hash ── unchanged & < 6 h since last send → skip
        │
PUT /api/v1/agents/:id/workloads ──────────────────► zod (strict) → advisory lock per device
                                                      → ordering guard (collectedAt per runtime)
                                                      → upsert device_workload_runtimes
                                                      → per-runtime reconcile device_workloads
                                                      → devices.hosts_workloads / workload_runtimes
                                                                        │
                                                      GET /devices/:id/workloads ─────────────────► Workloads section
                                                      filterEngine hostsWorkloads/workloadRuntimes ► fleet filter
                                                      AI tool query_device_workloads
(W05) imageCurrencyWorker ── distinct refs per org ── global cache (system-only) ── registry HEAD
                         └─ writes upstream_* onto device_workloads rows
(W06) compliance helper, monitor kind container_image_currency
```

## 4. Data model

### 4.1 `device_workloads` (tenancy shape 5, denormalized `org_id`)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | stable across unchanged reports |
| `device_id` | uuid NOT NULL → `devices(id)` | |
| `org_id` | uuid NOT NULL → `organizations(id)` | denormalized |
| `runtime` | varchar(20) NOT NULL | CHECK in (`docker`, `podman`, `hyperv`, `proxmox`) — `containerd` reserved, not enumerated in v1 |
| `kind` | varchar(20) NOT NULL | CHECK in (`container`, `vm`, `lxc`) |
| `workload_id` | varchar(128) NOT NULL | container id (64 hex) / VM GUID / Proxmox VMID as text |
| `name` | varchar(255) NOT NULL | container name without leading `/`; VM name |
| `state` | varchar(20) NOT NULL | normalized: `running`, `stopped`, `paused`, `restarting`, `other` |
| `raw_state` | varchar(40) | runtime's own state string, display only |
| `image_ref` | varchar(512) | containers: reference as the container was created (`nginx:1.27`, `ghcr.io/o/r:tag`, `repo@sha256:…`) |
| `image_repository` | varchar(400) | normalized `registry/repository` (`docker.io/library/nginx`) |
| `image_tag` | varchar(128) | null when digest-pinned or untagged |
| `image_digest` | varchar(80) | local repo digest for `image_repository` (`sha256:…`); null for local builds |
| `image_id` | varchar(80) | local image id (config digest) |
| `guest_os` | varchar(128) | VMs/LXC when the runtime reports it; never guessed |
| `compose_project` | varchar(128) | from `com.docker.compose.project` |
| `compose_service` | varchar(128) | from `com.docker.compose.service` |
| `compose_working_dir` | varchar(512) | from `com.docker.compose.project.working_dir` (W08 discovery hint only) |
| `restart_policy` | varchar(30) | containers; Proxmox `onboot` maps to `always`/`no` |
| `cpu_count` | integer | VMs/LXC |
| `memory_mb` | integer | VMs/LXC assigned memory |
| `started_at` | timestamp | null when not running or unknown |
| `runtime_created_at` | timestamp | container/VM creation time when reported |
| `first_seen_at` | timestamp NOT NULL | set on insert |
| `last_seen_at` | timestamp NOT NULL | every ingest that carried the row |
| `updated_at` | timestamp NOT NULL | |

W05 adds `upstream_status varchar(20) NOT NULL DEFAULT 'pending'`, `upstream_digest varchar(80)`,
`upstream_checked_at timestamp` (§9).

Constraints and indexes:

- Composite FK `device_workloads_device_org_fk (device_id, org_id) → devices(id, org_id) ON UPDATE
  CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` (template:
  `apps/api/migrations/2026-11-01-110000-device-memory-modules.sql:56-70`).
- Unique `(device_id, runtime, workload_id)`; index `(org_id)`; partial index
  `(org_id, image_repository, image_tag) WHERE kind = 'container'` for the W05 worker.
- RLS enabled + forced; four `breeze_org_isolation_*` policies on `breeze_has_org_access(org_id)`.

### 4.2 `device_workload_runtimes` (shape 5)

| Column | Type | Notes |
|---|---|---|
| `id`, `device_id`, `org_id` | as above | composite FK identical |
| `runtime` | varchar(20) NOT NULL | adds `containerd` to the CHECK |
| `detection` | varchar(20) NOT NULL | `present`, `absent`, `unknown` |
| `collection` | varchar(24) NOT NULL | `ok`, `disabled`, `unavailable` (detected but not running/reachable), `permission_denied`, `error`, `unsupported` |
| `complete` | boolean NOT NULL | false when truncated or any sub-query failed |
| `runtime_version` | varchar(64) | `27.1.1`, `pve-manager/8.2.4`, Hyper-V host build |
| `observed_count` | integer | workloads the driver saw (before the cap) |
| `reported_count` | integer | workloads in the payload |
| `last_error` | varchar(500) | sanitized, agent-side truncated |
| `collected_at` | timestamp NOT NULL | the agent's snapshot time (ordering guard, §6.3) |
| `last_attempt_at` | timestamp NOT NULL | server receive time of the latest accepted report |
| `last_success_at` | timestamp | latest report with `collection = ok` |
| `updated_at` | timestamp NOT NULL | |

Unique `(device_id, runtime)`. A runtime reported `detection = absent` keeps its row (with
`detection = absent`, workloads deleted) so the ordering guard still holds: deleting the row would let
a replayed older `present` report resurrect the runtime. The host axis excludes absent rows.

### 4.3 `devices` host axis

`hosts_workloads boolean NOT NULL DEFAULT false`, `workload_runtimes varchar(30)[] NOT NULL DEFAULT
'{}'`, plus the capability column `workload_inventory_protocol_version integer` written non-sticky
from the heartbeat (precedent: `consent_prompt_protocol_version`). Ingest sets `workload_runtimes` = sorted runtimes with `detection = present`, and
`hosts_workloads = cardinality(workload_runtimes) > 0`, in the same transaction. A runtime with
`detection = unknown` keeps its previous membership. Both columns are added to
`PUBLIC_DEVICE_FIELDS` (`apps/api/src/routes/devices/helpers.ts:15-27`) and, with the capability
column, to the `devices` entry of the export registry (`included`).

### 4.4 Registrations (the step that gets missed — grep, do not judge)

Both `device_workloads` and `device_workload_runtimes` go wherever `device_memory_modules` appears:

| List | File | Enforced by |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, `organizations` last) | `apps/api/src/services/tenantCascade.ts` (list declared ~243; insert alphabetically near `device_warranty` ~565) | `tenantCascade.integration.test.ts` (Integration Tests) |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `apps/api/src/routes/devices/core.ts` (~541) | `cascadeDelete.test.ts` (Test API) |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `apps/api/src/routes/devices/core.ts` (~298) | `moveOrg.coverage.test.ts` (Test API) |
| merge policy `repoint` | `apps/api/src/services/orgMergeRegistry.ts` (~886) | `orgMerge.test.ts` (full unit suite only) + `orgMergeRegistry.integration.test.ts` |
| `CORE_TENANT_EXPORT_POLICY` — all columns `included` (no jsonb/bytea, no secret-like names) | `apps/api/src/services/tenantExportPolicyRegistry.ts` (~369) | `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` |
| `devices` export entry gains the two new columns (`included`) | `tenantExportPolicyRegistry.ts` (~394) | same |

RLS coverage: both tables carry `org_id` and are auto-discovered — do **not** add them to
`DEVICE_ID_JOIN_POLICY_TABLES`. The settings table (§7.1) is a parent-FK child of
`config_policy_feature_links`, registered exactly as `config_policy_time_sync_settings` is. The W05
global cache is registered in `INTENTIONAL_UNSCOPED` with a comment
(`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:88-110`).

Neither table is append-only, neither has a `ticket_id`; no other list applies.

## 5. Agent collector

### 5.1 Package and interface

`agent/internal/collectors/workloads/`:

```go
type Runtime string // "docker" | "podman" | "hyperv" | "proxmox" | "containerd"

type Detection struct {
    State   string // "present" | "absent" | "unknown"
    Version string
    Reason  string // when unknown, sanitized
}

type Result struct {
    Collection    string // ok | unavailable | permission_denied | error | unsupported
    Complete      bool
    Workloads     []Workload
    ObservedCount int
    Error         string
}

type Driver interface {
    Runtime() Runtime
    Detect(ctx context.Context) Detection
    Collect(ctx context.Context, d Detection) Result
}
```

Drivers register per OS with build tags (`drivers_linux.go`, `drivers_windows.go`,
`drivers_other.go`), as `hwhealth` does (`sources_linux.go`, `sources_other.go`).

| Driver | OS | Detect | Collect |
|---|---|---|---|
| `docker` | Linux, Windows | socket `/var/run/docker.sock` (Linux) or pipe `//./pipe/docker_engine` (Windows, `go-winio` already in `agent/go.mod:11`) exists → `present`. The agent connects (`GET /_ping` + `GET /version`) **only when the daemon is already running** (Linux: live pid in `/var/run/docker.pid`; Windows: `docker` service running). A stopped daemon behind systemd socket activation would otherwise be started by the connect; that case reports `collection = unavailable` without connecting | `GET /containers/json?all=1`, `GET /images/json` (for repo digests) |
| `podman` | Linux | `/run/podman/podman.sock` exists → `present`; connect only when a `podman system service` process is already running (scan `/proc/*/cmdline`), because `podman.socket` is socket-activated by default | same Docker-compatible endpoints; otherwise `collection = unavailable` |
| `hyperv` | Windows | `vmms` service exists (Hyper-V role), else `absent` | `Get-VM | Select-Object Name,Id,State,ProcessorCount,MemoryAssigned,MemoryStartup,Uptime,Generation | ConvertTo-Json -Compress` via a timeout-bounded runner. A new, minimal function — **not** `backup/hyperv.DiscoverVMs` wholesale, which also reads Notes, disks and checkpoints (`agent/internal/backup/hyperv/discovery.go:42-148`) |
| `proxmox` | Linux | `/usr/bin/pvesh` exists and `/etc/pve` is mounted | `pvesh get /nodes/<local node>/qemu --output-format json` and `/lxc`; local node from `hostname` matched against `pvesh get /nodes` |
| `containerd` | Linux | `/run/containerd/containerd.sock` exists and no `docker` present on the same host | none in v1 (`unsupported`) — OD-5 |

All external commands run through a copy of the `hwhealth` runner pattern
(`agent/internal/collectors/hwhealth/runner.go:40`: context timeout, capped stdout/stderr, `WaitDelay`),
30 s per driver. Docker on a host with both Docker and Podman reports both runtimes.

### 5.2 GET-only Docker transport

The Docker client is plain `net/http` over a unix socket / named pipe with a `RoundTripper` that
returns an error for any method other than `GET` or `HEAD` and any path outside an allowlist
(`/_ping`, `/version`, `/containers/json`, `/images/json`). No Docker SDK dependency (none in
`agent/go.mod` today). Unit tests assert a `POST`/`DELETE` is refused before a byte is written.

### 5.3 Scheduling and send

- Own loop in `agent/internal/heartbeat/workloads.go`, modelled on `heartbeat/hardware_health.go`
  (first-run delay, ±10% jitter derived from agent id).
- Interval from settings (default 60 min, 15–1440). Detection runs on the same tick even when
  enumeration is disabled.
- Canonical hash: the full payload with workloads sorted by `(runtime, workload_id)`, excluding only
  `collectedAt` (millisecond precision on the wire). Send when the hash
  changed, any runtime's `collection`/`complete`/`detection` changed, or 6 h since the last accepted
  send (freshness keepalive). The hash advances only after a 2xx.
- Send path: `sendInventoryData("workloads", payload, "workloads")`
  (`agent/internal/heartbeat/heartbeat.go:2403`).
- If settings change while a collection is in flight, the result is discarded and the loop re-runs.
- Capability: `SecurityCapabilities.WorkloadInventoryProtocolVersion = 1`
  (`heartbeat.go:234-262`, `compiledSecurityCapabilities` ~7990); stored non-sticky by the API like
  the others (`apps/api/src/routes/agents/heartbeat.ts:947-980`). The UI uses it to say "agent too old"
  instead of "no data".

### 5.4 Field allowlist

Collected for containers, from `GET /containers/json?all=1` only (no `inspect` call): id, first
name, `State`, `Status`, `Image` (as created), `ImageID`, `Created`, and the three compose labels.
The list response carries only a relative `Status` ("Up 3 hours"), so `started_at` is null for
containers in v1 (VMs report it). Restart policy is
not in the list response, so `restart_policy` is null for containers in v1 (§15). For images:
`RepoDigests` and `RepoTags` of images referenced by listed containers only.

Never collected: environment, command, entrypoint, args, mounts, volumes, ports, networks, other
labels, image history, logs, `inspect` output.

Hyper-V VMs: name, id, state, CPU count, assigned (else startup) memory, uptime → `started_at`.
Proxmox: vmid, name, status, cpus, maxmem, uptime, `onboot`, and the `template` flag (templates are
skipped, not reported).

Byte budget: the whole payload stays under 1.75 MB (the route limit is 2 MB). When the encoded payload
would exceed it, the collector drops the lowest-priority workloads (same order as below) from the
largest runtime and marks that runtime `complete = false`; a payload that would always be rejected
with 413 is never sent.

Cap: 1000 workloads per runtime per device. Above it the driver sends the first 1000 by
`(state = running) desc, runtime_created_at desc, workload_id` and sets `Complete = false`,
`ObservedCount` = true count.

### 5.5 Privilege model

| | Linux | Windows | macOS |
|---|---|---|---|
| Agent identity | root (systemd unit has no `User=`, `agent/internal/agentapp/systemd_unit.go:42-45`) | LocalSystem (`agent/internal/winsvcinstall/scm_windows.go:45`) | root LaunchDaemon |
| Docker socket | readable as root | pipe ACL allows SYSTEM | Docker Desktop's per-user socket — **unsupported in v1**: no drivers are registered on macOS, so Macs send no runtimes and show no Workloads section |
| Hyper-V | — | SYSTEM may call `Get-VM` | — |
| Proxmox | `pvesh` as root uses local IPC, no API token | — | — |

The collector lives in the main service, never the user helper. Read-only is enforced by the
transport (§5.2), by running only `Get-VM` / `pvesh get`, and by tests that grep the driver package
for mutating verbs (`docker` POST paths, `Start-VM`, `Stop-VM`, `pvesh create|set|delete`, `qm `,
`pct `).

## 6. Ingest contract

### 6.1 Route

`PUT /api/v1/agents/:id/workloads`, agent-authenticated (`requireAgentRole`, as
`apps/api/src/routes/agents/inventory.ts:15`), body limit 2 MB, mounted next to `hardwareHealthRoutes`
(`apps/api/src/routes/agents/index.ts:87`).

```ts
// packages/shared/src/validators/workloads.ts
workloadsReportSchema = z.object({
  protocolVersion: z.literal(1),
  collectedAt: z.string().datetime(),
  runtimes: z.array(z.object({
    runtime: z.enum(['docker', 'podman', 'hyperv', 'proxmox', 'containerd']),
    detection: z.enum(['present', 'absent', 'unknown']),
    collection: z.enum(['ok', 'disabled', 'unavailable', 'permission_denied', 'error', 'unsupported']),
    complete: z.boolean(),
    runtimeVersion: z.string().max(64).nullable(),
    observedCount: z.number().int().min(0).max(1_000_000),
    error: z.string().max(500).nullable(),
    workloads: z.array(workloadSchema).max(1000),
  }).strict()).max(5),
}).strict();
```

`workloadSchema` is `.strict()` with exactly the agent-supplied subset of the §4.1 columns
(camelCase; not `id`, `device_id`, `org_id`, `first_seen_at`, `last_seen_at`, `updated_at`), every
string bounded; datetimes accept an offset. Duplicate `runtime` entries or duplicate `workloadId`
within a runtime → 400. Any workload under `containerd` → 400 (detect-only in v1).
`observedCount > workloads.length` is treated as truncated even when `complete = true`.

### 6.2 Algorithm (one transaction)

1. Advisory xact lock on the device (generalize `lockDeviceInventory`,
   `apps/api/src/services/inventoryChildSync.ts:84`, by exporting it — it is private today).
2. Load existing runtime rows. For each reported runtime:
   - **Ordering guard:** effective time = `min(collectedAt, receivedAt)` (a fast agent clock cannot
     park the device in the future); if it is `<= existing.collected_at`, skip that runtime entirely
     (replayed or reordered report).
   - Resolve effective settings for the device (§7.2, cached). If the runtime is disabled by policy,
     treat the report as `collection = disabled` regardless of what the agent sent and ignore its
     workloads.
   - `detection = absent` → upsert runtime row as absent; delete all its workloads.
   - `collection = disabled` → upsert runtime row; delete all its workloads (D11).
   - `collection = ok && complete` → replace-set: upsert reported workloads (stable ids,
     `first_seen_at` preserved), delete the runtime's rows not in the report.
   - `collection = ok && !complete` → upsert reported workloads only; then delete the runtime's rows
     whose `last_seen_at` is older than 24 h; then, if more than 1500 rows remain for the runtime,
     delete oldest-`last_seen_at` rows down to 1500.
   - any other `collection` → upsert runtime row only; workloads untouched.
3. Runtimes not mentioned in the report: untouched (an older agent build may not know a runtime).
4. Recompute `devices.workload_runtimes` / `hosts_workloads` (§4.3); write only if changed.
5. Return `{ accepted: true, runtimes: [{ runtime, applied: boolean }] }`.

Planning is a pure function (`planWorkloadSync`) reusing `planChildRowSync`
(`inventoryChildSync.ts:44`), unit-tested without a DB.

### 6.3 Read route

`GET /api/v1/devices/:id/workloads` (device read permission, org-scoped by the normal device access
check) → `{ capability: 0|1, runtimes: [...], workloads: [...] }`, workloads sorted by runtime, then
state as plain text, then name, then `workloadId` (the UI may re-sort, e.g. running first).
Heartbeat settings keys are snake_case (`docker_enabled`, `interval_minutes`, …) like the other
settings blocks; the agent accepts camelCase too. Fleet listing beyond the filter fields is not in v1.

## 7. Configuration policy feature `workload_inventory`

### 7.1 Settings (inline, Pattern B)

`config_policy_workload_inventory_settings` (template:
`apps/api/migrations/2026-11-10-120000-time-sync-config-feature.sql`): `feature_link_id` unique FK
`ON DELETE CASCADE`, `enabled boolean NOT NULL DEFAULT false`, `docker_enabled`, `podman_enabled`,
`hyperv_enabled`, `proxmox_enabled` (`boolean NOT NULL DEFAULT true`), `interval_minutes integer NOT
NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 15 AND 1440)`. Parent-chain RLS plus the additive
SELECT-only partner-wide branch, exactly as `config_policy_time_sync_settings`.

Ownership is inherited from the configuration policy, which is already org-XOR-partner — a
partner-wide policy turns it on for every org (CLAUDE.md "Partner-Wide First"). Inline features are
not added to `PARTNER_LINKABLE_FEATURE_TYPES`; add to the inline branch of
`validateFeaturePolicyExists` (`apps/api/src/services/configurationPolicy.ts:3131-3140`),
decompose/assemble (`:886-895`, `:1169-1172`, `:1220-1223`, `:1391-1406`), route zod
(`routes/configurationPolicies/featureLinks.ts:369-380`, PATCH `:644-654`),
`services/policyBaselineDefaults.ts`, `services/aiToolsConfigPolicy.ts:247`, shared
`configFeatureTypes.ts` (`CONFIG_POLICY_FEATURE_TRUST_TIER.workload_inventory = 'protective'`), and
`configFeatureTypeEnum` (`apps/api/src/db/schema/configurationPolicies.ts:33-62`, appended last).

### 7.2 Delivery

Heartbeat `configUpdate.workload_inventory_settings` built by `buildWorkloadInventoryConfigUpdate`
next to `buildTimeSyncConfigUpdate` (`apps/api/src/routes/agents/helpers.ts:2243`) and merged at
`heartbeat.ts:2367-2372`. Semantics (as hardware monitoring / time sync):

- No assigned policy → explicit defaults `{ enabled: false, ... }` (so removing a policy turns
  collection off).
- Resolver error → key omitted; the agent keeps its previous settings.
- Redis cache 120 s keyed by device, the same resolver used by ingest (§6.2).

Agent `applyWorkloadInventoryConfig`: requires `enabled` bool; invalid payload ignored; initial
in-memory default `Enabled: false` (unlike hwhealth, `heartbeat.go:1056`). Must be placed above the
policy-probe early return in `applyConfigUpdate` (`heartbeat.go:3284-3290` comment).

## 8. Web, filters, AI, docs (W04)

- **Device page:** a "Workloads" section, shown when `hosts_workloads` or a runtime row exists. Per
  runtime: version, collection status in plain language ("Collection is off — enable Workload
  inventory in a configuration policy", "Permission denied", "Agent too old"), counts, then a table
  (name, state, image/guest OS, compose project, started). Placement: a new `CoreTab` `workloads` in
  `apps/web/src/components/devices/DeviceDetails.tsx` (`:98`, `:194-197`, `:464`, render near `:939`),
  hash-routed (`#workloads`).
- **Policy tab:** inline settings form for `workload_inventory` with the same save pattern as the time
  sync tab (Settings rule 7).
- **Fleet filter:** `hostsWorkloads` (boolean) and `workloadRuntimes` (array contains) in
  `apps/api/src/services/filterEngine.ts:75-135` and the web mirror
  `apps/web/src/components/filters/filterFields.ts`; both added to the agent-reported provenance table
  (`filterEngine.ts:175-210`) and to `EXECUTION_REFUSED_AGENT_FIELDS` (`:237`).
- **AI tool:** `query_device_workloads` (tier 1, read-only) in `services/aiToolsDevice.ts`, registered
  on every surface the existing device tools are (`aiAgentSdkTools.ts`, `aiGuardrails.ts`, route-binding
  contract test). Output includes counts and per-runtime status, workloads capped at 200.
- **Docs:** `apps/docs/src/content/docs/features/workload-inventory.mdx` (template:
  `hardware-monitoring.mdx`), linked from `devices.mdx` and `configuration-policies.mdx`.

## 9. Image currency (#3813, W05)

### 9.1 What "behind" means

For a container row with `image_repository`, `image_tag` and `image_digest`, the image is **behind**
when the registry's current digest for `repository:tag` differs from the local digest **and** the
local digest is not one of the platform manifests listed in the registry's current index for that tag.
Every other case is explicit:

| `upstream_status` | When |
|---|---|
| `pending` | not checked yet (new row, or local digest changed) |
| `current` | registry digest equals local digest, or local digest is a platform manifest inside the current index |
| `behind` | as above |
| `pinned` | reference is digest-pinned (`repo@sha256:…`) — nothing to compare |
| `local` | no repo digest (locally built or loaded image) |
| `private` | registry requires credentials (401/403 after the anonymous token flow) |
| `unsupported_registry` | registry host not on the allowlist |
| `not_found` | tag no longer exists upstream |
| `error` | transient failure; retried with backoff |

Unknown-class statuses (`pending`, `private`, `unsupported_registry`, `error`) never count as
current (§10).

### 9.2 Registry check

- `HEAD /v2/<repo>/manifests/<tag>` with `Accept` listing OCI index, Docker manifest list, OCI
  manifest and Docker v2 manifest media types; read `Docker-Content-Digest` and `Content-Type`.
- On mismatch, one bounded `GET` of the same manifest **only when** it is an index/list (≤ 256 KB,
  manifest JSON only, never layers) to test platform-manifest membership. This removes the false
  "behind" when the local digest is a platform manifest digest.
- Anonymous bearer token flow from the `WWW-Authenticate` challenge. Token realm hosts must be on the
  allowlist too; redirects are followed only to allowlisted hosts.
- Allowlist v1: `registry-1.docker.io` (+ `auth.docker.io`), `ghcr.io`, `quay.io`,
  `mcr.microsoft.com`, `registry.k8s.io`, `gcr.io`, `public.ecr.aws`. All outbound requests go through
  the existing DNS-pinned URL safety helper (`apps/api/src/services/urlSafety.ts` ~898), with
  timeouts, response size caps, per-registry concurrency limits and exponential backoff on 429.
- Docker Hub `HEAD` requests on manifests do not count against pull rate limits; `GET` of an index
  does — the GET is used only on mismatch.

### 9.3 Tenancy of results

- Global cache `container_image_upstream_cache` (no tenant column): key `(registry, repository, tag)`,
  `digest`, `media_type`, `platform_digests varchar(80)[]`, `checked_at`, `expires_at`. Rows are
  written **only** when the anonymous check succeeded (the repository is verifiably public). Forced
  RLS with a system-only policy — **no** permissive SELECT (unlike `winget_package_index`, this table
  is derived from what tenants run). Registered in `INTENTIONAL_UNSCOPED`.
- Results of failed / private checks are never stored globally; they land only on the tenant's own
  `device_workloads` rows (`upstream_status = private`).
- Worker `imageCurrencyWorker` (BullMQ, every 30 min): per org (system context, then a scoped write
  per org), collect distinct `(image_repository, image_tag)` with `upstream_status` due (pending, or
  `upstream_checked_at` older than 6 h); resolve from cache (TTL 6 h) or registry; write
  `upstream_status`, `upstream_digest`, `upstream_checked_at` onto that org's matching rows.
- Ingest resets `upstream_status = 'pending'` when a row's `image_digest` or reference changes, and
  preserves the three columns otherwise.

## 10. Compliance and alerting (W06)

### 10.1 Compliance term

One shared helper `containerImageComplianceTerms(orgIds | deviceIds)` returns per device:
`stale` = distinct `(image_repository, image_tag)` with `behind`, `current` = distinct with
`current`, `unknown` = distinct with an unknown-class status. Replicas of one image on one host count
once. Integration is per OD-2; the recommended option touches every compute site:

- `apps/api/src/routes/devices/patches.ts:561` (device %)
- `apps/api/src/routes/patches/compliance.ts:276-282` (org %) **and** `:381` (compliant-device count)
- `apps/api/src/jobs/patchComplianceReportWorker.ts:93` (report)
- `apps/web/src/components/devices/DevicePatchStatusTab.tsx:1008-1036` (web fallback)
- `apps/api/src/services/securityPosture.ts:174,624` — **excluded**: posture weights critical/important
  patches only and staleness carries no severity.

Severity- or source-filtered views exclude the term (it has neither). Unknowns never enter the
denominator and are shown as "N images not checked" so coverage is visible; unknown image coverage
never suppresses a known OS-patch breach (`services/alertConditions/handlers/patchCompliance.ts:57`).

### 10.2 Monitor kind `container_image_currency`

- `ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'container_image_currency'`; add to
  `SUBJECT_MONITOR_KINDS` (`services/monitors/subjectMonitorKinds.ts:14`) and `monitorDefinitions.ts`.
- Handler modelled on `services/alertConditions/handlers/hardwareHealth.ts`: one subject per
  `image_repository:image_tag` on the device; `breaching` when `behind` for at least the configured
  age (default 7 days since `upstream_checked_at` first saw it behind — needs a `behind_since` column,
  added in W06), `recovered` when `current`, `unknown` otherwise.
- Retirement: when ingest deletes the last row referencing an image subject, resolve its open alert
  in the same transaction via the retire/outbox pattern (`services/hardwareHealth/retire.ts:17`).
  Failed or truncated snapshots never retire or recover.
- Built-in monitor provisioned partner-wide and **not attached** to any policy (standing owner
  decision 2026-09-13).

## 11. Optional W07 — private registries

Deferred until a customer needs it (OD-3). Recommended shape if built: agent-side check, because
private registries are usually on the customer LAN and unreachable from Breeze. Credentials are
tenant variables (`apps/api/src/db/schema/tenantVariables.ts`, partner-wide or org,
`is_secret`) delivered through the existing secret envelope, never read from the host's
`~/.docker/config.json`.

## 12. Optional W08 — operator-triggered compose update

Deferred (OD-4). If built, all of these hold:

- Command `workload_compose_update { runtime, composeProject }`, issued only from the device page by a
  user with device execute permission, MFA step-up, audited; registered in `GATED_COMMAND_TYPES`
  (`apps/api/src/services/partnerTrust.ts:57`) and `agent/internal/privilege/check.go`.
- Server rejects automation, scheduled, AI-tool and bulk origins. Policy setting
  `allow_compose_update boolean DEFAULT false` (new column, trust tier for the feature re-assessed to
  `execution_gated` if it ships) is re-validated at command claim
  (`apps/api/src/services/commandClaimEligibility.ts:229`).
- Agent treats the stored compose labels as hints only: it re-lists containers, re-resolves the
  project's working dir and config files from the live labels, verifies the files exist and are
  owned by root, and runs a bounded argv (`docker compose -p <project> --project-directory <dir> pull`
  then `up -d`), never a shell string. Bare `docker run` containers are reported "manual update".

## 13. Testing and lab proof

- **API unit:** zod strictness (unknown keys, oversize strings, duplicate ids); `planWorkloadSync`
  table tests for every §6.2 branch; ordering guard (older `collectedAt` ignored); disabled-by-policy
  deletes rows; host-axis recompute incl. `unknown` keeps membership; registration contract tests.
- **Integration (real Postgres):** RLS forge as `breeze_app` (42501), device move carries `org_id`,
  org merge repoint, org erasure, export roundtrip, cascade order.
- **Agent:** driver tests with fixture JSON (Docker list/images incl. multi-arch repo digests,
  Podman, `Get-VM` single-object vs array quirk, `pvesh` qemu/lxc incl. templates); GET-only
  transport refuses mutation; field allowlist (fixture with env/cmd/mounts → absent from payload);
  hash stability; failed send does not advance hash; settings change mid-collection discards result;
  `go test -race`.
- **W05:** registry fake server: index vs manifest digests, platform membership, 401 → private,
  realm off-allowlist refused, redirect off-allowlist refused, 429 backoff, size cap.
- **W06:** distinct-image counting, replicas once, unknown excluded, compliant-device count,
  alert retirement on last-reference removal, truncated snapshot does not retire.
- **Lab gates:** L1 Linux Docker host (compose + bare containers, multi-arch image, local build);
  L2 Windows Server with Hyper-V role; L3 Proxmox VE node (qemu + lxc + template); L4 Podman host.
  Each gate: enable policy → rows appear within one interval → stop/remove a workload → reflected
  next interval → disable runtime → rows deleted, host axis stays.

## 14. Waves

| Wave | Issue part | Ships | Depends on | Migrations | Blast radius → tier |
|---|---|---|---|---|---|
| W01 | #3834 | API contract: tables, host axis, registrations, `workload_inventory` feature + delivery, ingest, GET route, shared validators | — | 2 (tables+columns; feature enum+settings) | **High** (new tenant tables, migrations, cascades) → Opus implement, Sonnet + Codex review |
| W02 | #3834 | Agent core + Docker/Podman drivers, settings apply, capability, send | W01 merged | 0 | **High** (agent-shipped, root) → Opus/Sonnet implement, Sonnet review; lab L1, L4 |
| W03 | #3834 | Hyper-V + Proxmox drivers | W02 | 0 | **High** (agent-shipped) → Sonnet implement, Sonnet review; lab L2, L3 |
| W04 | #3834 | Web Workloads tab + policy tab, fleet filters, AI tool, docs | W01 (W02 for live data) | 0 | Medium → Sonnet implement, Laguna + Codex medium review |
| W05 | #3813 | Image currency: cache table, worker, registry client, upstream columns, ingest reset, UI badge | W01, W02 | 1 | **High** (outbound HTTP worker, global table) → Opus implement, Sonnet review |
| W06 | #3813 | Compliance term (all sites), monitor kind + handler + retirement, built-in monitor, docs | W05 | 1 (enum + `behind_since`) | **High** (compliance numbers customers see, alerting) → Opus implement, Sonnet review |
| W07 | #3813 | Private registries (optional, OD-3) | W06 | TBD at wave start | High |
| W08 | #3813 | Operator-triggered compose update (optional, OD-4) | W06 | 1 (setting column) | **High** (remote execution) → Opus + Codex quorum before plan |

W04 runs in parallel with W02/W03 once W01 is merged. W05 needs real container rows (W02) only for
its lab proof; its code depends on W01.

## 15. Risks and open items

- **Restart policy** is not in the Docker list response; v1 leaves `restart_policy` null for
  containers rather than calling `inspect` (which returns env). If wanted later: an inspect call whose
  decoder struct contains only `HostConfig.RestartPolicy.Name`, so other fields are never decoded.
- **Docker Desktop on macOS/Windows workstations** uses a per-user socket; unsupported in v1.
- **"Never start a stopped daemon" has false negatives, never false starts.** Docker on Linux is
  gated on a live `dockerd` pid in the default `/var/run/docker.pid` (a custom `--pidfile` or snap
  install reads `unavailable`); on Windows on the `docker` service state (Docker Desktop's service
  reads `absent`). Stock Podman's socket-activated service exits when idle, so most Podman hosts read
  `unavailable` unless the operator keeps `podman system service --time=0` running — the docs page
  (W04) says so.
- **Churny hosts** (CI runners creating hundreds of short-lived containers) are bounded by the 1000
  cap, change-only send and the 15-minute interval floor. The change-only hash will still send often
  on such hosts; acceptable at the 60-minute default.
- **Registry rate limits** for the `GET` fallback (Docker Hub anonymous pulls) — bounded by the 6 h
  cache TTL and fleet-wide dedup of public images.
- **Lab hardware:** W03 needs a Proxmox VE node and a Windows host with the Hyper-V role (OD-8).

## 16. Advisor quorum record

Fable/Opus position (D1–D17 draft) reviewed by Codex `gpt-6-astra` at `xhigh`, read-only, against
current `main` on 2026-10-05.

- **Agreed:** typed tables + composite FK; hard delete only after complete snapshots; driver
  interface + change-only send; default-off enumeration with always-on detection; no partner-export
  publication in v1; separate compliance term over synthetic patch rows; subject monitor kind.
- **Changed after review:**
  - Added `detection` vs `collection` split, `last_attempt_at` / `last_success_at`, ordering guard on
    `collectedAt`, and explicit truncated-snapshot semantics (age-out + retained cap).
  - Hash advances only after a 2xx; settings change mid-scan discards the result; Hyper-V uses a new
    minimal query, not the backup discovery function (which reads Notes/disks/checkpoints).
  - Global image cache was originally planned with permissive SELECT and keyed for any allowlisted
    host. Changed: a public registry host does not imply a public repository (GHCR, Quay host
    private repos), so the cache stores only verified-public results, is system-only, and tenants
    read results from their own rows.
  - Digest comparison now handles index vs platform-manifest digests and digest-pinned references
    explicitly instead of a bare equality test.
  - Compliance integration lists all five compute sites (Codex found the report worker and the
    compliant-device count the draft missed) and excludes posture.
  - Alert retirement on last-reference removal added.
  - W08 gates strengthened (origin rejection, claim-time revalidation, labels as untrusted hints,
    bounded argv) — `GATED_COMMAND_TYPES` alone is a partner-trust gate, not an operator-only gate.
  - Fleet filter fields classified execution-refused.

## 17. Open Decisions

Each has a recommendation; none blocks W01.

- **OD-1 — Enumeration default.** (a) Off until a policy enables it, detection always on; (b) on by
  default like hardware monitoring. **Recommend (a)** — enumeration lists customer workload names and
  images; MSPs opt in once with one partner-wide policy.
- **OD-2 — How image currency folds into patch compliance.** (a) Separate "image currency" metric
  shown next to patch %, not folded; (b) folded into the device/org patch % as a severity-less term
  (stale distinct image = pending item, current = installed item), excluded from severity/source
  filters and posture, unknowns excluded and shown as coverage; (c) only a device-level
  "fully current" flag. **Recommend (b)** — it is what the owner described on #3813 ("counts against
  patch compliance … instead of the host reporting 100% patched"), and the shared helper keeps the
  five sites consistent.
- **OD-3 — Private registries.** (a) Server-side with tenant-variable credentials (cannot reach LAN
  registries); (b) agent-side check with credentials via secret envelope; (c) leave `private` as
  unchecked. **Recommend (c) now, (b) when a customer asks.**
- **OD-4 — Build W08 (compose update) at all.** **Recommend defer** until W06 has been in production
  and a customer asks; if built, the §12 gates are mandatory.
- **OD-5 — containerd / Kubernetes nodes.** (a) Detect-only; (b) enumerate via `crictl` when present;
  (c) gRPC CRI client. **Recommend (a)**; (b) as a later driver if demand appears.
- **OD-6 — Partner API publication of workloads.** **Recommend defer**; when added, make
  `device_workloads` a partner-export material table with `last_seen_at`, `started_at`, `state`,
  `raw_state`, `updated_at` and the `upstream_*` columns in the excluded-column map.
- **OD-7 — Fold `hyperv_vms` into `device_workloads`.** **Recommend revisit after W03**, when the
  Hyper-V driver gives two consumers to compare; not before.
- **OD-8 — Lab hardware for W03.** Needs a Proxmox VE node and a Windows host with the Hyper-V role
  (the lab VM `.55` is Server 2022 — confirm whether nested Hyper-V is available).
  **Recommend** a small Proxmox VM (nested) on existing lab hardware.
- **OD-9 — Podman.** Include in v1 via the Docker-compatible socket. **Recommend include** — near-zero
  cost, same parser — accepting that stock installs report `unavailable` until a persistent API
  service is enabled (§15), because the agent will not socket-activate it.
