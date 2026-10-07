---
title: Portal advanced data visibility (per-family flags)
issue: LanternOps/breeze discussion #7450
status: draft (direction approved in discussion #7450)
depends_on: LanternOps/breeze#5861 (Customer Portal Network Visibility)
---

# Portal advanced data visibility: design

Status: draft, for review. Direction approved in discussion #7450; this is the spec PR requested there (spec only, no code).

## 1. Problem and goal

An MSP serves customers with very different IT maturity.

- **Low maturity:** no technical staff, the MSP does everything. The current portal, operational and simple, fits this profile.
- **Higher maturity:** an IT team, often a minimal one, that still relies on the MSP for the contracted service. It needs more depth than the portal offers today, for two reasons:
  1. **Fast decisions:** the customer's IT manager needs more robust data without opening a ticket or waiting for a report.
  2. **Inputs for their own work:** the team needs some data for strategic, or even operational, tasks outside the scope of the contracted service. Without it they ask the MSP for one-off information, which is unplanned work for the administrator.

Most of this data already exists in the technician console and does not reach the portal.

**Goal:** let the administrator expose specific, granular, read-only data families to a customer organization, one family at a time.

**Not a goal:** showing everything to everyone. Depth per person inside an organization is out of scope (section 12).

## 2. Principles

- **Read-only and additive.** Visibility only. No actions, remediation or configuration changes from the portal.
- **Off by default, fail closed.** A missing `portal_branding` row, `false` or `null` all mean "not visible".
- **No new collection.** Every field traces to a table or agent report that exists today.
- **Same auth and tenancy as the rest of the portal.** `portalAuthMiddleware`, organization scope, RLS. Portal clients never read the database directly.
- **Closed field lists.** Every read model selects explicit columns. None uses `select()` on a source table, several of which mix harmless columns with credentials or free text. Contract tests assert that excluded fields are absent (section 10).
- **Per organization.** Portal users have no roles today, so every gate is per organization.

## 3. Flag mechanics (existing pattern, no new mechanism)

Each family gets one boolean column on `portal_branding` (`notNull`, `default(false)`), like `enableDocuments`, `enableLifecycle` and `enableNetworkVisibility`. Checklist per family:

1. Migration (checked by `check:migrations`) and schema column in `db/schema/portal.ts`. Add each new column to the `portal_branding` entry in `services/tenantExportPolicyRegistry.ts`, which the export-policy contract tests check. The table already exists, so no new tenancy, RLS or cascade entry is needed.
2. Flag list in `services/portal/portalFlags.ts`: `PORTAL_VISIBILITY_FLAG_KEYS` for families inside "Enable all", `PORTAL_SENSITIVE_FLAG_KEYS` (new, see section 4) for families outside it.
3. Defaults and types in `routes/orgPortalSettings.ts`, and the key in `updatePortalSettingsSchema` (`packages/shared/src/validators/portal.ts`). The schema is `.strict()`, so a new key returns 400 until it is added there.
4. Entry in `STRICT_PORTAL_FEATURES` (`error`, `code`) and a `createPortalFeatureGateStrict('<flag>')` line in `routes/portal/index.ts`, mounted by prefix after `portalAuthMiddleware` on the same prefix, as the existing gated prefixes are.
5. Field in the `select` of the authenticated `GET /portal/branding`, since portal clients read flags from there, and the matching branding type in the portal app (`apps/portal/src/lib/api.ts`) plus page and navigation gating.
6. Toggle in `OrgPortalSettingsEditor.tsx` (including its `PortalSettings` type), labels in the `settings.json` locale files. For sensitive families the toggle description says plainly who will see the data (see section 4). A hand-written "Enable all" entry is added only for families inside "Enable all".
7. Read model, route and tests.

Disabled behavior: 403 with the family's `code`, as the other strict gates.

**Gate typing.** `StrictPortalVisibilityFlag` is `PortalVisibilityFlag` minus `enableNetworkVisibility`, because network visibility answers 200 with `dataStatus: 'not_enabled'` instead of 403. It is widened to also accept the sensitive flags that use the 403 gate (`enablePatchDetail`, `enableVulnerabilityDetail`). `enableNetworkAlerts` is in the sensitive list but has no 403 gate (it omits fields when off), so it is excluded from the strict type the same way `enableNetworkVisibility` is. `STRICT_PORTAL_FEATURES` is a `Record` over that type, so it needs entries for exactly the 403-gated flags. To be confirmed with the maintainer in the PR that introduces it (wave 5).

## 4. Sensitivity and "Enable all"

- **Inside "Enable all":** descriptive data about the asset that does not point at a security weakness.
- **Outside "Enable all":** data that points at weaknesses (patch gaps, vulnerabilities). Enabling these takes a deliberate toggle, as with `enableNetworkAlerts`.

Mechanics, matching the code today:
- "Enable all" is the hand-written `enableAllVisibility()` literal in `OrgPortalSettingsEditor.tsx`. It does not derive from `PORTAL_VISIBILITY_FLAG_KEYS`, and it also sets `enableDevices`. A flag stays out of "Enable all" simply by not being in that literal.
- Because that is a hand-written list, outside-ness is enforced two ways: a new `PORTAL_SENSITIVE_FLAG_KEYS` list in `portalFlags.ts` (starting with `enableNetworkAlerts` and gaining `enablePatchDetail` and `enableVulnerabilityDetail` with waves 5 and 6), and a test in `OrgPortalSettingsEditor.test.tsx` that clicks "Enable all" and asserts every flag in that list stays `false`. A future edit cannot silently move a sensitive flag into "Enable all".
- The sensitive list and its "Enable all" test land with wave 1, so the guard exists before the first sensitive family. The gate typing widens with wave 5, the first sensitive family gated by a 403.

**Who sees it.** Portal users have no roles. Turning on wave 5 or 6 shows a per-host missing-patch and CVE/KEV map to every portal login of that organization. The editor description for those toggles says this plainly.

## 5. Family catalog

Ordered by delivery wave, from least to most sensitive.

| Wave | Family | Flag (proposed) | "Enable all" | Primary sources |
|---|---|---|---|---|
| 1 | Hardware health | `enableHardwareHealth` | Yes | `deviceHardwareHealth`, `deviceHardwareComponents`, `deviceHardwareEvents`, `deviceDisks`, `devices.batteryStatus` |
| 2 | Hardware inventory | `enableHardwareInventory` | Yes | `deviceHardware`, `deviceMemoryModules`, `deviceNetwork`, `deviceConnections` |
| 3 | Performance | `enablePerformanceMetrics` | Yes | `metricRollups`, `deviceMetrics` |
| 4 | Software inventory | `enableSoftwareInventory` | Yes | `softwareInventory` |
| 5 | Patch detail | `enablePatchDetail` | No | `patches`, `devicePatches` |
| 6 | Vulnerability detail | `enableVulnerabilityDetail` | No | `vulnerabilities`, `deviceVulnerabilities`, `softwareInventory` |

On hold, not part of this plan's PR sequence:

| Item | Status |
|---|---|
| A: Network SNMP advanced option (`enableNetworkSnmp`) | On hold until a customer asks for it. Sketch in section 6. |
| B: Security posture detail | Not proposed as designed (it widened the default security overview). If pursued later, it gets its own flag and an explicit field allowlist, including for `topIssues`. |

Flag names are proposals.

## 6. Family detail

### Wave 1: Hardware health

**Include**
- Device-level: overall `health` (`ok`, `warning`, `critical`, `unknown`), counts per state computed from the returned components, and `lastCollectedAt`.
- Per component (`deviceHardwareComponents`, current rows only): type (`controller`, `virtual_disk`, `physical_disk`, `cache_battery`, `enclosure`), name, model, `health`, `state`, `sizeBytes`, `temperatureC`, `predictiveFailure`, `progressPercent` (rebuild).
- Events (`deviceHardwareEvents`): `eventType`, `fromHealth`, `toHealth`, `fromState`, `toState`, `occurredAt`.
- File systems (`deviceDisks`): `mountPoint`, `fsType`, `totalGb`, `usedGb`, `freeGb`, `usedPercent`, `health`.
- Notebook battery (`devices.batteryStatus`): `present`, `percent`, `chargingState`, `pluggedIn`, `timeRemainingMinutes`, `timeToFullMinutes`, `reportedAt`.

**Exclude**
- `bmc` components (remote-management interface), and the `collector` component type (collector mechanics, no value to the customer).
- `serial`, `firmware`, `attributes`, `source`, `alertExempt`, all `*Streak` counters, `sources`, `agentVersion`, event `detail`, `deviceDisks.device`, `deviceDisks.updatedAt`, component `lastSeenAt`, component `stateDetail` (raw vendor tool text), and `componentKey` / `parentKey` (agent keys such as `smart:<serial>` embed the disk serial and the collector source; a component whose name equals its key is returned with a null name).
- Components with `stale = true`.

**Notes**
- `cache_battery` is the RAID controller cache battery, not the notebook battery.
- `BatteryStatus` carries charge level and state only. There is no wear or cycle count, so the portal cannot say whether a battery is degraded.
- `device_hardware_health.summary` is not passed through. Its `counts` are keyed by component type and health and also count `bmc` and `collector` components, and `controllerNames` sits in an open jsonb. The portal computes its own counts from the filtered component rows.
- There is no health signal for memory or CPU. Memory capacity and slots are inventory (wave 2), usage is performance (wave 3).

### Wave 2: Hardware inventory

**Include:** `manufacturer`, `model`, `cpuModel`, `cpuCores`, `cpuThreads`, `ramTotalMb`, `diskTotalGb`, `gpuModel`, `biosVersion`. Memory per slot (`deviceMemoryModules`): `slotIndex`, `locator`, `populated`, `capacityMb`, `memoryType`, `formFactor`, `speedMts`, `configuredSpeedMts`.

Network adapters (`deviceNetwork`): `interfaceName`, `ipAddress`, `ipType`, `isPrimary`.

Connections (`deviceConnections`): aggregate counts by `protocol` and `state` only.

**Exclude:** `serialNumber` (device and modules), `partNumber`, module `manufacturer`, `mtlsCertSerialNumber`, IP history (`deviceIpHistory`), adapter `macAddress` and `publicIp`, and from connections `localAddr`, `localPort`, `remoteAddr`, `remotePort`, `pid` and `processName`.

**Notes:** Adapter IPs skip tunnel and overlay interfaces (WireGuard, Tailscale, ZeroTier and similar), or omit the address for them, so the portal does not show overlay topology. `osVersion` is already in `EnrichedPortalDevice` and is not repeated. Adapter IP is exposed and MAC is not, by the author's choice. `deviceNetwork.publicIp` is never written by the agent ingest, so it is always null and is left out.

### Wave 3: Performance

**Include** (per device and aggregated per organization):
- From `metricRollups`: `cpu_percent`, `ram_percent`, `ram_used_mb`, `disk_percent`, `disk_used_gb`, `disk_read_bps`, `disk_write_bps`, `bandwidth_in_bps`, `bandwidth_out_bps`. Average and maximum per bucket.
- From `deviceMetrics`: network volume (`networkInBytes`, `networkOutBytes`) summed per day.
- From `deviceMetrics.interfaceStats`, per interface: `name`, `speed`, `inBytesPerSec`, `outBytesPerSec`, `inErrors`, `outErrors`.
- Ranges: 24h, 7d, 30d.

**Exclude:** `customMetrics`, `processCount`, `deviceProcessSamples`, disk byte and op counters, and from `interfaceStats` the cumulative counters and packets (`inBytes`, `outBytes`, `inPackets`, `outPackets`). The tenant export policy lists `interface_stats` and `custom_metrics` as `excludedOpen` (open containers deliberately kept out of the export), so `interfaceStats` is exposed only through this closed field list and `customMetrics` stays out.

**Notes:** see section 8.

### Wave 4: Software inventory

**Include:** `name`, `version`, `vendor`, `installDate`, `lastSeen`, per device and aggregated per organization.

**Exclude:** `installLocation`, `uninstallString`, `fileHash`, `hashAlgorithm`, `observationId`, `isManaged`, `catalogId`.

**Notes:** the console route reads `softwareInventory`, which carries `org_id`. `deviceSoftware` has no `org_id` and is not used.

### Wave 5: Patch detail

**Include:** `patches.title`, effective `severity`, `version`, `kbArticleUrl`. `devicePatches.status` limited to `pending`, `installed`, `failed`, plus `installedAt`, `installedVersion`, `availableVersion`, `lastCheckedAt`.

**Exclude:** `missing` and `skipped` statuses, `lastError`, `failureCount`, `rollbackAvailable`, `scope`, and everything about policies, approvals, jobs and rollback.

**Notes:**
- Severity is the effective value, `EFFECTIVE_PATCH_SEVERITY_SQL` in `services/patchSeverityOverlay.ts`: the shared `patches.severity` when it is not `unknown`, otherwise the device's own `device_patches.reported_severity`. Using `patches.severity` alone would show `unknown` for patches only the agent classified.
- `missing` is a tombstone, not a pending patch (see the comment on `OUTSTANDING_DEVICE_PATCH_STATUSES`). The read model reuses that constant for "pending".
- `lastError` is free text from the agent and can carry internal paths or messages. `failed` already tells the customer what matters.

### Wave 6: Vulnerability detail

**Include:** `cveId`, `severity`, `cvssScore`, `knownExploited` (CISA KEV), `deviceVulnerabilities.status` (`open`, `patched`, `mitigated`, `accepted`), `riskScore`, `detectedAt`, `resolvedAt`, affected software name and version (via `softwareInventoryId`, which can be null).

**Exclude:** `mitigationNote`, `acceptedBy`, `acceptedUntil`, `ticketId`, `resolvedObservationId`, `matchConfidence`, `cvssVector`.

**Notes:**
- Showing `accepted` tells the customer the administrator chose to live with a finding. The status is shown, never the note or who accepted.
- The list returns all four statuses (`open`, `patched`, `mitigated`, `accepted`) and takes a `status` filter that defaults to `open`. The default population is every `open` row for the organization, the same one the existing overview counts in `openBySeverity` and `kevCount`, so the default totals match the overview. `matchConfidence` is not exposed and is not used as a filter. A null `matchConfidence` is the OS-vulnerability path (precise) and is kept.
- Affected software name and version come straight from `softwareInventory` and do not depend on `enableSoftwareInventory`.
- Overlaps with `enableSecurity`: `GET /portal/security/overview` already returns `vulnerabilities.openBySeverity`, `kevCount` and `lastDetectedAt`. This family adds per-finding detail only and does not repeat those aggregates. It reuses `vulnerabilitySeverityForFindings` where they meet.

### On hold: Network SNMP advanced option (suggestion A)

Not scheduled. It is picked up only if a customer asks for it, and would be a separate spec addendum before any code.

Sketch: an optional `snmp` block on the Network Visibility asset rows (polling state, uptime, interface state and traffic, printer supplies), behind its own flag outside "Enable all", requiring `enableNetworkVisibility`. Only `assetId`, `isActive`, `lastPolled` and `lastStatus` would be selected from `snmp_devices`, and `snmp_metrics` would be read through a closed OID allowlist (`sysUpTime`, `ifOperStatus` with `ifDescr`, `ifHCInOctets` and `ifHCOutOctets` with the 32-bit fallback, `prtMarkerSupplies*`, `prtMarkerLifeCount`). Credentials and free-text columns would never be selected.

### Not proposed: security posture in the default overview (suggestion B)

Dropped as designed, since it widened `GET /portal/security/overview` for every organization with `enableSecurity` on. If posture detail is pursued later it gets its own flag and an explicit allowlist (per-control scores, risk distribution, and `topIssues` with category, label and score only, since `topIssues` is open jsonb). `openPortsScore`, `factorDetails`, per-device `recommendations` and the raw security-status columns stay out.

## 7. API surface (proposed, names open)

All routes sit behind `portalAuthMiddleware` and use the existing pagination DTO. Every per-device route takes the organization from `portalAuth`, never from the request.

| Wave | Prefix | Gate | Sketch |
|---|---|---|---|
| 1 | `/portal/hardware-health/*` | strict 403 | overview, paged device list, device detail |
| 2 | `/portal/hardware-inventory/*` | strict 403 | paged device list, device detail |
| 3 | `/portal/performance/*` | strict 403 | overview, device series (`range=24h\|7d\|30d`) |
| 4 | `/portal/software/*` | strict 403 | organization summary, device list |
| 5 | `/portal/patches/*` | strict 403 | summary, device detail |
| 6 | `/portal/vulnerabilities/*` | strict 403 | summary, findings list |

## 8. Data notes

**Performance windows and retention.** 24h reads the 5-minute buckets, 7d and 30d read the hourly buckets. Rollup retention floors are 30, 365 and 730 days (5 minutes, hourly, daily) and the defaults are 90, 548 and 1095 days, both in `services/metricRollupRetention.ts` (lines 22-32), so a 30-day view holds under any configuration. Raw `device_metrics` retention defaults to 30 days, is set by `DEVICE_METRICS_RETENTION_DAYS` and clamped to 1 to 365.

**Network volume.** The agent reports `networkInBytes` as the delta since the previous sample (`agent/internal/collectors/metrics.go`), and the console sums it per bucket. The portal does the same. Bytes are not in `ROLLUP_METRIC_NAMES`, so the volume comes from the raw table. When raw retention is shorter than the requested range, the response says so instead of presenting a partial total as complete. Adding bytes to the rollups is out of scope. `interfaceStats` also lives only in the raw table, as jsonb with up to 100 interfaces per sample, so it follows the same retention and the same coverage notice.

**Hardware health.** Only current components are read (`stale = false`).

## 9. Overlap with the existing portal

- **Devices (`enableDevices`):** `EnrichedPortalDevice` already exposes hostname, display name, OS type and version, status, last seen, last patch, protection, encryption, last backup and warranty end. New families do not repeat these, and the per-device families (waves 1 to 4) do not require `enableDevices`: each has its own flag.
- **Security (`enableSecurity`):** `patchesAppliedTile` (monthly count), `vulnerabilitySeverityForFindings`, and the routes `/security/overview` and `/security/devices` exist (score, history, threat events, vulnerability counts, per-device protection). Waves 5 and 6 add per-item detail and reuse these helpers.
- **Lifecycle (`enableLifecycle`):** the replacement plan is distinct from hardware inventory and hardware health.
- **Network (`enableNetworkVisibility`, `enableNetworkAlerts`):** the overview already returns asset counts, `snmpDevicesPolling` and `monitorsDown`. Asset rows already return hostname, label, `ipAddress`, `macAddress`, type, manufacturer, model, site, online state and alert counts. The on-hold SNMP option would add metric values only.

## 10. Testing

Following the existing portal test conventions (`*.test.ts` next to each route):

- **Gate:** 403 with the family `code` for a missing row, `false` and `null`. 200 when on.
- **Tenancy:** a user from organization A cannot read organization B, per endpoint. Per-device routes forge another organization's device id and expect 404.
- **Vulnerability population (wave 6):** the detail count equals the overview's open count for the same organization.
- **Adapters and connections (wave 2):** no MAC in adapter rows, and no address, port or process in connection data.
- **`interfaceStats` (wave 3):** cumulative counters and packets are absent.
- **Contract:** the response keys equal the allowlist, and excluded fields are absent.
- **"Enable all":** turns on waves 1 to 4. A test in `OrgPortalSettingsEditor.test.tsx` clicks it and asserts every flag in `PORTAL_SENSITIVE_FLAG_KEYS` stays `false`.
- **Patch severity (wave 5):** a patch with shared severity `unknown` and a reported severity shows the reported one.
- **Migration:** every existing organization ends up `false` for every new flag.
- **Performance:** bucket selection per range, and the coverage notice when raw retention is short.
- **Editor and i18n:** toggles and labels present in every locale file.

## 11. Rollout

One family per PR, in wave order, after this spec merges. Wave 1 is the pilot for the mechanics (section 3), so pattern feedback lands on the lowest-risk data. Each wave is independently mergeable and reviewable. Each PR touching `OrgPortalSettingsEditor.tsx` states the setting's home, level, resolver and the number of places the concept is configured before and after, as the PR template requires. The feature lifecycle (parent issue and one wave issue per family) is set up by the maintainers after this spec merges, and each family PR body uses `Closes #<wave issue>`. Wave 1 also lands the sensitive-flag list and its test. Waves 5 and 6 are sequenced after the earlier waves are accepted, add their flags to that list, and wave 5 widens the gate typing. The on-hold items are not in the sequence.

## 12. Non-goals

- Portal roles and per-person depth.
- Any action, remediation or configuration change from the portal.
- New agent-side collection.
- BMC and IPMI data, event logs, process lists, diagnostic logs.
- `customMetrics`, SNMP credentials, mitigation and ticket notes.
- Network topology (physical links, impact views, "Explain this"), which is a technician feature. If a customer asks for it later, it needs its own spec and its own flag outside "Enable all".
- UI design (a separate spec per family, if needed).

## 13. Decisions and open points

Decided by the author, confirmed or corrected by the maintainer:

1. **Vulnerability population (wave 6).** No confidence filter, same population as the existing overview. Null confidence is kept. The confidence field stays hidden.
2. **Wave 6 and wave 4.** Independent. Software name and version come from `softwareInventory` directly.
3. **Suggestion A (network SNMP).** On hold until a customer asks.
4. **Suggestion B (security posture).** Not proposed as designed. Own flag and explicit allowlist if pursued.
5. **Software inventory (wave 4).** Inside "Enable all".
6. **Managed-device identifiers (wave 2).** Serial numbers and MAC stay out. IP appears only in adapter rows, skipping tunnel and overlay interfaces.
7. **`enableDevices`.** Not required by the per-device families.
8. **`collector` component.** Not exposed.
9. **Network adapters and connections (wave 2).** Included, adapters without MAC, connections as aggregate counts.
10. **`interfaceStats` (wave 3).** Included as per-interface name, speed, rates and errors.
11. **Performance flag name.** `enablePerformanceMetrics`.
12. **Patch severity (wave 5).** Effective severity through the existing overlay.
13. **Sensitive flags.** `PORTAL_SENSITIVE_FLAG_KEYS` plus the "Enable all" test, landing with wave 1. The list grows with waves 5 and 6.

Open for the maintainer:

- **Flag names.** All names in section 5 are proposals.
- **Gate typing.** Whether the strict gate type includes only the 403-gated sensitive flags (section 3).
- **Overall health (wave 1).** Resolved: the device-level `health` is the worst state among the components returned (`ok` < `unknown` < `warning` < `critical`; `unknown` when none is returned), not the stored value, which can be driven by a component the portal does not list (such as `bmc`).
- **Listening ports (wave 2).** Whether connections should also expose local listening ports, which point at exposed services. Currently out.
