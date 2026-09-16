---
tracking_issue: LanternOps/breeze#5988
---
# Network Device Page Truth — Plan Index

**Spec:** `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` (approved 2026-09-16).

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-network-device-page-truth/wave-<sub-issue#>` with `Closes #<sub-issue#>`
in the PR body. State lives on GitHub (feature-lifecycle); the wave issue is the source of truth
for status, never this index.

| Wave | Plan | Depends on |
|---|---|---|
| W01 (#5989) | [API truth: reachability service, probe, collection state, metrics history, ingestion, index + reaper](2026-09-16-network-device-page-truth-w01-api-truth.md) | — |
| W02 (#5990) | [Agent acquisition: oidSpecs, bounded walks, per-OID errors, classifier change, slow cadence](2026-09-16-network-device-page-truth-w02-agent-acquisition.md) | W01 |
| W03 (#5991) | [Templates and identity: sysObjectID prefixes, suggestion, Xerox template, identity resolution](2026-09-16-network-device-page-truth-w03-templates-identity.md) | W01 |
| W04 (#5992) | [Web settings surface: NetworkAssetSettingsModal, single writer, launchers, Discovery peek](2026-09-16-network-device-page-truth-w04-web-settings.md) | W01 (W03 optional, feature-detected) |
| W05 (#5993) | [Web page IA: header, stat strip, Health + Reachability cards, Identity, Monitoring tab, charts, banner](2026-09-16-network-device-page-truth-w05-web-page-ia.md) | W01, W04 |

W02, W03 and W04 run in parallel after W01 merges. W05 starts once W04 has merged. Stacked branches
get no `pull_request` CI run: dispatch `gh workflow run CI --ref <branch>` before enqueueing.

## Migration slots reserved

| File | Wave |
|---|---|
| `2026-10-17-110000-discovered-assets-status-provenance-and-probe.sql` | W01 |
| `2026-10-17-110100-snmp-metrics-instances-errors-index.sql` | W01 |
| `2026-10-17-110200-snmp-devices-poll-seq.sql` | W01 |
| `2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql` (DML: seeds; elects `breeze.scope=system` first) | W03 |

Every executor re-checks `ls apps/api/migrations | grep '\.sql$' | sort | tail -1` before committing
and renames upward if main has moved past these names (as of 2026-09-16 the newest committed is
`2026-10-16-193300-software-deployments-policy-origin.sql`; other unmerged plans have reserved names up
to `2026-10-17-095000-…`, which these sort after).

## Cross-wave names that must not drift

Defined in W01 and consumed verbatim by later waves:

- `apps/api/src/services/assetReachability.ts`: `deriveReachability(input: ReachabilityInput, now?: Date): Reachability`;
  types `ReachabilityState = 'responding' | 'not_responding' | 'unverified'`,
  `ReachabilitySource = 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp'`, `Reachability` (spec §4.2 shape),
  `ReachabilityInput = { asset, snmpDevice, networkMonitors, scanIntervalSeconds }`;
  `reachabilityToListStatus(r): 'online' | 'offline' | 'unknown'`.
- `apps/api/src/services/assetReachabilityLoader.ts`: `loadReachabilityInputs(assetIds: string[]): Promise<Map<string, ReachabilityInput>>` (batched; used by list and detail routes).
- `apps/api/src/services/networkExecutorSelection.ts`: `selectNetworkExecutor({ orgId, siteId }): Promise<{ agentId } | { error: 'no_agent_in_site' }>` (site-strict; extracted from `jobs/monitorWorker.ts` `selectExecutionAgentForMonitor`).
- `apps/api/src/services/snmpCollectionState.ts`: `deriveCollection(input: CollectionInput): Collection` (spec §6.2 shape); `CollectionOidState = 'collecting' | 'unsupported' | 'stale' | 'never_polled' | 'unknown'`.
- `apps/api/src/services/snmpOidSpecs.ts`: `buildOidSpecs(templateOids): OidSpec[]`, `OidSpec = { oid, name, mode: 'get' | 'walk', cadence: 'fast' | 'slow' }`, `POLL_LIMITS = { maxRowsPerOid: 512, maxRowsPerPoll: 4096, maxBytesPerPoll: 1048576, maxDurationMs: 20000 }`, `SLOW_CADENCE_EVERY = 12`.
- `apps/api/src/services/assetIdentity.ts`: `maskOidShapedModel(model: string | null): string | null`, `nicVendorFromMac(mac: string | null): string | null`; W03 adds `resolveAssetIdentity(...)` and `apps/api/src/services/ianaEnterprise.ts` (`IANA_ENTERPRISE_VENDORS: Record<number, string>`, `enterpriseNumberFromSysObjectId(oid): number | null`).
- `apps/api/src/services/snmpTemplateSuggest.ts` (W03): `suggestTemplate({ sysObjectId, assetType, orgId }): Promise<{ templateId, templateName, reason } | null>`.
- Columns: `discovered_assets.status_observed_at`, `status_source`, `last_probe_at`, `last_probe_status`, `last_probe_response_ms`, `last_probe_ref`; `snmp_devices.poll_seq`; `snmp_metrics.base_oid`, `instance`, `error`; `snmp_templates.sys_object_id_prefixes`. `snmp_devices.last_status` value `'no_template'`; `snmp_metrics.value_type` value `'error'`.
- Wire: command payload fields `oidSpecs`, `limits`; result field `protocol: 2`; metric fields `baseOid`, `instance`, `error` with codes `noSuchObject | noSuchInstance | endOfMib | timeout | truncated`.
- Routes: `POST /discovery/assets/:id/probe`, `GET /monitoring/assets/:id/metrics`, `GET /monitoring/templates/suggest`; response fields `reachability`, `nicVendor`, `probe`, `collection`, `templateSuggestion`.
- Web (W04, consumed by W05): `apps/web/src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.tsx` (`open`, `section`, `assetId`, `onClose`, `onSaved`), `settings/useNetworkAssetMutations.ts` (the only writer), `settings/settingsHash.ts` (`parseDetailHash(hash): { tab: Tab; settings: SettingsSection | null }`, `buildDetailHash(tab, section?)`, `SettingsSection = 'identity' | 'monitoring' | 'link' | 'danger'`), `apps/web/src/lib/__tests__/network-asset-single-writer.test.ts`.
- Web (W05): `networkDevice/health/` registry (`HealthCard`, `PrinterHealth`, `GenericHealth`, `EmptyHealth`), `networkDevice/ReachabilityCard.tsx`, `networkDevice/ApprovalBanner.tsx`, i18n keys under `devices.json` `networkDeviceDetailPage.*` in all 8 locales.
