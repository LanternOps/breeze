---
tracking_issue: LanternOps/breeze#5995
wave: W04 (#5999) M3
task: 11
date: 2026-09-26
---

# M3 verification record (Task 11 and the post-rebase gate)

Only what was actually executed on 2026-09-26 in worktree `w5999`
(branch `feature/5995-topology/wave-5999`, rebased onto
`origin/feature/5995-topology/wave-5998` @ `194ee231f`) is recorded here.
Anything not listed was not run.

## Step 0: rebase reconciliation gate

No reconciliation change was needed: every suite below was green on the rebased
branch before Task 11 work began. One real defect surfaced while building the UI
and was fixed separately (`ed6f3c5ae`): `GET/POST/PATCH …/policies` spread the
whole stored row, and since Task 8 every row carries a bigint
`alert_state_revision`, so `c.json` threw `Do not know how to serialize a BigInt`
for any listed or upserted policy. The spread also echoed the frozen arming actor,
routing contexts and alert streak state. It now returns an explicit allowlist.

| Command | Result |
|---|---|
| `apps/api: npx tsc --noEmit -p .` (12 GB heap) | exit 0 |
| `apps/web: npx tsc --noEmit -p .` | exit 0 |
| `packages/shared: npx tsc --noEmit -p .` | exit 0 |
| `apps/api: npx vitest run src/services/topology src/routes/topology src/routes/agents src/services/unifi src/routes/alerts src/jobs src/__tests__/mcp-coverage.test.ts src/services/aiTools src/services/aiAgentSdkTools src/services/aiGuardrails src/services/aiAgents/agentToolCatalog` | 661 files passed, 1 skipped; 9731 tests passed, 1 skipped |
| Integration, `vitest.integration.config.ts`: every `*.integration.test.ts` matching topolog/unifi/alert, plus tenant-export-policy, tenantExportErasureRoundtrip, tenantCascade, orgCascadeFkOnDelete, orgMergeRegistry and orgLifecycleFoundations (102 files, real Postgres on :32956) | 102 files, 645 tests passed |
| `DB_CONTEXTLESS_WRITE_STRICT=true npx vitest run --config vitest.config.rls-coverage.ts` | 1 file, 103 tests passed |
| `agent: go test -race -count=1 ./internal/snmppoll/... ./internal/unifi/... ./internal/heartbeat/... ./internal/networkdiagnostic/... ./internal/discovery/...` | all 5 packages ok |
| `apps/api: npx eslint src` | exit 0 |
| `agent: golangci-lint run --new-from-rev=origin/feature/5995-topology/wave-5998` (same packages) | 0 issues |

## Task 11 deliverables (`fa69fcef0`)

Web (`apps/web/src/components/topology`):
- `LinkHealthPanel`: each endpoint port's own measurement, freshness, "Port not identified", and "Not measured" for unknown values.
- `InterfaceHistoryPanel`: one series per generation × source × producer epoch, gaps, units, direction note and a data table.
- `MonitoringPolicyPanel` and `TopologyArmStepUp`: status, preview, and human-only arm/disarm behind a server-driven `topology_arm` step-up.
- `InterfaceTelemetrySettings`: port measurement arm and revoke.
- `TraceResultPanel`, plus a `trace_route` option in `TopologyDiagnosticsPanel` with bounded hops and probes.
- `ImpactPanel` and `RecentChangesPanel`.
- Hash keys `iface/<uuid>` and `ops/1`.
- All strings are present in all 8 `topology.json` locales. Only subpath `@breeze/shared` imports are used; the added `./validators/topologyMonitoring` export supports this.

Server changes the real stack needed. Without them, these UI paths could never be reached:
- `readTopologySiteSettings` now reports `interfaceHealth` and `diagnostics` from flag exposure, like physical D9. Before this change, both used a hardcoded agent capability of `false`, so neither was ever available.
- The explorer takes `canDiagnose` and `canConfigureMonitoring` from site settings. The graph projection hardcodes both to `false`, so on a real server Diagnose was always disabled.

| Command | Result |
|---|---|
| Red first: new tests failed before implementation (component imports; `topologyHash` round-trip; siteSettings interfaceHealth and diagnostics capability; explorer authority from settings; policy 409 `no_eligible_collector` treated as a conflict). One mutation check was also run: chart gap bridging made `InterfaceHistoryPanel.test` fail | observed red, then green |
| `apps/web: npx vitest run src/components/topology src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n` | 44 files, 516 tests passed |
| `apps/api: npx vitest run src/services/topology src/routes/topology` | 85 files, 942 tests passed |
| Integration re-run after the settings change: `topologyInterfaceHistoryScope`, `topologySiteConfiguration`, `topologyMonitoringAuthority`, `topology-settings-readiness`, `topology-rollout` | 16 + 10 tests passed |
| web + api `tsc --noEmit` after all changes | exit 0 / exit 0 |
| `eslint` on every changed web/api source file | clean |

### E2E on a worktree stack (`pnpm wt-stack up`, torn down after)

The stack used a gitignored root `.env` copied from w5998 with
`BREEZE_DOCKER_SUBNET=172.31.97.0/24`, `BREEZE_CADDY_IP=172.31.97.10` and
**`ENABLE_2FA=false`**, because the seeded admin has no enrolled factor. The
`topology_arm` step-up prompt was therefore **not** exercised end to end. It is
covered by `MonitoringPolicyPanel.test.tsx`, which tests grant minting bound to
{siteId, action, subjectId} and the retry carrying `stepUpGrantId`.

The seed (`apps/api/src/__tests__/helpers/topologyOperationsSeed.cli.ts`, run in
the api container) layers the following on top of the M2 physical fixture:
- flags `interfaceHealth` and `diagnostics`;
- an SNMP `if_metrics` source with 17 raw samples on one LLDP port, including a 4-minute gap and a repeated reading (a zero rate);
- 3 samples of a previous interface generation;
- an SNMP community on the fixture's discovery profile;
- a `gateway_basic` policy with activation intent, written through `upsertTopologyMonitoringPolicy`.

| Command | Result |
|---|---|
| `pnpm wt-stack test -- tests/topology-operations.spec.ts` | 4 passed |
| `pnpm wt-stack test -- tests/topology-physical.spec.ts` (M2 regression) | 3 passed |
| `apps/web: astro build` then `e2e-tests: npx playwright test -c playwright.topology-worker.config.ts` (M1 production bundle / CSP gate) | 14 passed |

What `topology-operations.spec.ts` asserts:

1. **Passive reads.** Link health, port history, impact, monitoring status and changes are read-only:
   - no non-GET API request is made;
   - no row changes in commands, diagnostic runs, telemetry arms, armed policies, samples or discovery jobs;
   - both epochs are drawn, and the gap and the `0 bps` value appear in the table;
   - reload restores the open history and the operations section from the hash.
2. **Policy arm refused.** Preview is passive. Enable issues exactly one `POST …/arm`. The fixture's agent has no eligible routing context, so the server answers `409 no_eligible_collector`. The UI shows the server reason as an error, not as a revision conflict, and the policy stays "Enable requested, not active" (stored `enabled=false`). A successful policy arm has **not** been demonstrated end to end.
3. **Telemetry arm and revoke.** Explicit port, collector and credential selection with a volume preview (1440 samples/day). Arming returns `201` with state `armed` and stores the arm. Revoke is a `DELETE` with no step-up, and the stored arm becomes `revoked`. Exactly those two mutations are sent.
4. **Trace option.** `trace_route` shows the hop and probe bounds (max 30 and 2) and sends nothing until started. **Start was not clicked**, so no real trace run was created or rendered in E2E. Routed-path rendering is covered by `TraceResultPanel.test.tsx`: a silent TTL shows as "Unknown (no reply)".

## Not run / not delivered

- Native Windows traceroute (or any real agent trace execution).
- Any real switch, SNMP agent or UniFi controller. All device data is simulated at the transport boundary by the seed.
- Soak, load and performance runs, and the index's pilot/rollback thresholds.
- The `topology_arm` step-up in a browser with a real enrolled factor (ENABLE_2FA was off on the stack).
- A successful policy arm on a real stack. Only the refusal path ran.
- A completed trace run rendered from the server in E2E.
- `apps/api/src/services/topology/metrics.ts` (Prometheus domain metrics listed in the original Task 11 file list). **Not implemented** in this task.
- Manual browser checks: long labels, contrast, reduced motion.
- The full `pnpm lint` (turbo) and full unit suites for all packages. Only the suites listed above were run.
