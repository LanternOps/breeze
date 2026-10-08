# Workload Host Inventory & Container Image Currency — Plan Index

**Spec:** `docs/superpowers/specs/devices/2026-10-06-workload-host-inventory-design.md`
(draft 2026-10-06; Codex `gpt-6-astra` xhigh quorum folded in, spec §16; Open Decisions spec §17).

**Issues:** #3834 (W01–W04), #3813 (W05–W06; W07–W08 optional). Not yet registered as a feature —
the orchestrator registers it after owner approval, then adds `tracking_issue:` frontmatter here.

One plan document per PR. Each wave's PR goes on branch `feature/<parent#>-workload-inventory/wave-<sub-issue#>`
with `Closes #<sub-issue#>`. State lives on GitHub (feature-lifecycle); the wave issue is the
source of truth for status, never this index.

## Waves

| Wave | Plan | Depends on | Migrations | Ships | Blast radius → model tier |
|---|---|---|---|---|---|
| W01 | [API contract: tables, host axis, registrations, `workload_inventory` feature + delivery, ingest, GET route](2026-10-06-workload-host-inventory-w01-api-contract.md) | — | 2 | ingest live; nothing sends yet; feature settable through the policy API (web editor excludes it until W04) | **High** — new tenant tables + migrations + cascade lists → Opus implements; Sonnet + Codex `medium` review; full Integration Tests locally (`pnpm test-stack up`) |
| W02 | [Agent core + Docker/Podman drivers](2026-10-06-workload-host-inventory-w02-agent-docker.md) | W01 merged | 0 | **agent release** — container hosts report | **High** — agent-shipped, runs as root/SYSTEM → Opus/Sonnet implement; Sonnet review; lab L1 (Docker), L4 (Podman) |
| W03 | Hyper-V + Proxmox drivers — plan authored at wave start (scope below) | W02 | 0 | **agent release** — VM hosts report | **High** — agent-shipped → Sonnet implement; Sonnet review; lab L2 (Hyper-V), L3 (Proxmox) |
| W04 | Web Workloads tab + policy tab, fleet filters, AI tool, docs — plan authored at wave start | W01 (W02 for live data) | 0 | operators see and target workload hosts | Medium → Sonnet implement; Laguna + Codex `medium` review; browser check |
| W05 | Image currency: cache, worker, registry client, `upstream_*` columns — plan authored at wave start | W01; W02 for lab | 1 | "N images behind" visible per host | **High** — outbound HTTP worker, global system table → Opus implement; Sonnet review |
| W06 | Compliance term (all sites), monitor kind `container_image_currency`, retirement, built-in monitor, docs | W05 | 1 | stale images lower patch compliance; alertable | **High** — customer-visible compliance numbers + alerting → Opus implement; Sonnet review |
| W07 | Private registries (optional — spec OD-3) | W06 | TBD | — | High |
| W08 | Operator-triggered compose update (optional — spec OD-4) | W06 | 1 | — | **High** — remote execution → advisor quorum before its plan |

W04 runs in parallel with W02/W03 once W01 is merged. W03 and W05 can run in parallel after W02.
Plans for W03–W06 are written at wave start against `main` as it stands then (they depend on the
exact shapes W01/W02 land); the scope each must cover is fixed below.

## Migration slots reserved

Newest committed migration on 2026-10-05: `2026-12-13-110200-org-erasure-fk-child-actions.sql`.
Every executor re-checks `ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -1`
before committing and renames upward if `origin/main` has moved past these names (pre-push hook:
`scripts/check-migration-naming.sh --against-ref origin/main`). Never `2026-08-06-*`.

| File | Wave | Writes rows? |
|---|---|---|
| `2026-12-15-100000-device-workloads.sql` | W01 | no — `device_workloads`, `device_workload_runtimes`, composite FKs, RLS, indexes; `devices.hosts_workloads`, `devices.workload_runtimes`, `devices.workload_inventory_protocol_version` |
| `2026-12-15-100100-workload-inventory-config-feature.sql` | W01 | no — `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'workload_inventory'`; `config_policy_workload_inventory_settings` + parent-chain RLS + partner-wide SELECT branch |
| `2026-12-15-110000-container-image-currency.sql` | W05 | no — `device_workloads` `upstream_status`/`upstream_digest`/`upstream_checked_at`; `container_image_upstream_cache` (system-only) |
| `2026-12-15-120000-monitor-kind-container-image-currency.sql` | W06 | no — `ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'container_image_currency'`; `device_workloads.behind_since` |

Every file is idempotent, has no inner `BEGIN`/`COMMIT`, and writes no rows. If a task adds DML it
must elect system scope first (`SELECT set_config('breeze.scope','system',true);`,
`migrationRlsScope.test.ts`). An `ADD COLUMN` on `device_workloads` (W05, W06) must classify the
column in `CORE_TENANT_EXPORT_POLICY` in the same PR.

## Global constraints (every wave inherits these)

- **Tenancy.** `device_workloads` and `device_workload_runtimes` are shape 5 with a denormalized
  `org_id`, composite FK `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE
  CASCADE DEFERRABLE INITIALLY IMMEDIATE`, RLS enabled + forced, four `breeze_has_org_access(org_id)`
  policies. Registered wherever `device_memory_modules` is (spec §4.4). No `jsonb`/`bytea` columns.
- **Not partner-export material** (spec D12): no material statement triggers on either table.
- **Read-only collection.** No agent code path in W02–W06 issues a mutating Docker API call, Hyper-V
  cmdlet or Proxmox write. Enforced by the GET-only transport and the source-grep test (W02).
- **Field allowlist** (spec §5.4). Never env, command, args, mounts, ports, networks, non-compose labels.
- **Opt-in.** `workload_inventory.enabled` defaults false; detection always runs; disabling deletes
  that runtime's workload rows.
- **Reconciliation.** Delete-by-absence only for `collection = ok && complete`; ordering guard on
  `collectedAt` per runtime; caps 1000 reported / 1500 retained, 24 h age-out for truncated runtimes.
- **No scheduled image updates, ever.** W08 is operator-triggered only and optional.
- **Image currency.** Only verified-public results are cached globally; the cache is system-only;
  tenants read results from their own rows. Unknown-class statuses never count as current.
- **Wording.** PR bodies and commit messages neutral; public repo — no gap tables.

## Scope fixed for plans written at wave start

### W03 — Hyper-V + Proxmox drivers

- `hyperv` driver (`drivers_windows.go`): detect `vmms` service; collect with a new minimal
  `Get-VM | Select-Object Name,Id,State,ProcessorCount,MemoryAssigned,MemoryStartup,Uptime |
  ConvertTo-Json -Compress` through the bounded runner; handle the single-object-vs-array JSON quirk
  (as `agent/internal/backup/hyperv/discovery.go:59-65`); state mapping incl. numeric fallback.
  Do not import `backup/hyperv.DiscoverVMs`.
- `proxmox` driver (`drivers_linux.go`): detect `/usr/bin/pvesh` + `/etc/pve`; resolve local node;
  `pvesh get /nodes/<node>/qemu --output-format json` and `/lxc`; skip templates; `onboot` →
  `restart_policy`; `maxmem` bytes → `memory_mb`.
- Fixtures for both; source-grep test extended (`Start-VM`, `Stop-VM`, `pvesh create|set|delete`,
  `qm `, `pct `); lab gates L2, L3 (spec §13); OD-8 resolved before the wave starts.

### W04 — Web, filters, AI, docs

- `CoreTab` `workloads` in `apps/web/src/components/devices/DeviceDetails.tsx` (union `:98`,
  `VALID_TABS :194-197`, `tabs :464`, render near `:939`), hash `#workloads`; plain-language runtime
  status lines (spec §8); `capability = 0` → "agent too old".
- Policy tab for `workload_inventory` (time-sync tab pattern; page Save).
- `hostsWorkloads`, `workloadRuntimes` in `apps/api/src/services/filterEngine.ts:75-135`, provenance
  table `:175-210`, `EXECUTION_REFUSED_AGENT_FIELDS :237`; web mirror `filterFields.ts`.
- `query_device_workloads` tier-1 tool in `services/aiToolsDevice.ts` and every registration surface
  (`aiAgentSdkTools.ts`, `aiGuardrails.ts`, route-binding contract test).
- `apps/docs/src/content/docs/features/workload-inventory.mdx` (+ links from `devices.mdx`,
  `configuration-policies.mdx`).

### W05 — Image currency

- Migration slot above; columns classified `included` in the export policy.
- Registry client (spec §9.2): HEAD with all four manifest media types, bounded index GET on mismatch
  only, anonymous token flow, allowlisted registry/realm/redirect hosts, DNS-pinned fetch via
  `apps/api/src/services/urlSafety.ts`, timeouts, size caps, per-registry concurrency, 429 backoff.
- `container_image_upstream_cache` (system-only, `INTENTIONAL_UNSCOPED` entry), verified-public rows
  only, TTL 6 h.
- `imageCurrencyWorker` (BullMQ, 30 min), per-org writes of `upstream_*`; ingest resets to `pending`
  on digest/reference change and preserves otherwise.
- Status badge column in the W04 Workloads table.
- W02 handoff: the agent canonicalizes `index.docker.io`, `registry-1.docker.io`,
  `registry.hub.docker.com` to `docker.io` and lowercases registry hosts — the worker maps
  `docker.io` back to `registry-1.docker.io` for requests. A null `image_digest` from an incomplete
  snapshot (`/images/json` failed) is digest-unknown, not `local`: ingest preserves the stored digest
  for rows of an incomplete runtime when the report carries null.

### W06 — Compliance + alerting

- `containerImageComplianceTerms` helper; integrate per OD-2 at all five sites (spec §10.1),
  posture excluded; unknowns shown as coverage.
- Monitor kind, `SUBJECT_MONITOR_KINDS`, `monitorDefinitions.ts`, handler, `behind_since`,
  last-reference retirement via the retire/outbox pattern, built-in monitor not attached.
- Docs: compliance + monitor sections.

## Lab gates (spec §13)

L1 Linux Docker (W02) · L4 Podman (W02) · L2 Windows Hyper-V (W03) · L3 Proxmox VE (W03) ·
W05 registry check against a real multi-arch public image and a private GHCR image (expect `private`).

## Stacked branches

A PR based on a sibling branch gets no CI from `pull_request`; dispatch it:
`gh workflow run CI --ref <branch>`.
