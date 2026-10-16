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

## Native Windows traceroute lab run (2026-09-27)

This run closes the "Native Windows traceroute" item above for IPv4. IPv6 is partly covered: see the last list in this section.

**Host.** The two Server 2022 lab VMs (`lab-windows-server-vm`, `lab-windows-server-vm-2`) were offline on Tailscale, so the run used `lab-windows-11-host`. This is the physical Windows 11 Pro test workstation, build 10.0.26200.8653. It sits on Ethernet `<lab-windows-11-host-lan-ip>/24` behind gateway `<lab-lan-gateway-ip>`. It has Tailscale IPv6 (ULA `fd7a:115c:a1e0::/48`) but no global IPv6. Its installed Breeze agent was not touched, and no second agent ran. Only a `go test` binary ran, from the scratch directory `C:\tmp\trace-lab-20260927`, which was deleted afterwards.

**Method.** Test binaries were cross-compiled on the Mac (`GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c`, Go 1.26.6 per `agent/go.mod`) and copied to the host with `scp`. An ASCII `.cmd` file ran them. Shared vector JSON was staged at the relative path the tests read. The lab suite is `agent/internal/networkdiagnostic/traceroute_lab_windows_test.go`. It is gated by `//go:build windows` and `BREEZE_LAB_TRACE`, so CI skips it. Each case takes the production path: `networkcontext.NewReader` → `NativeIO` → sealed `trace_route` command → `Run` → `executeTrace` → `windowsICMPTraceTransport`. Rerun it with:

```
set BREEZE_LAB_TRACE=1
set BREEZE_LAB_TRACE_V6_TARGET=<reachable IPv6, optional>
set BREEZE_LAB_TRACE_UNREACHABLE=<unused on-link IPv4, optional>
networkdiagnostic.test.exe -test.v -test.count=1 -test.run TestLabWindows
```

**Raw reply buffers** (`TestLabWindowsICMPReplyLayout`, first 40 bytes):

| Probe | Decoded | Raw |
|---|---|---|
| IPv4 → 1.1.1.1, TTL 1 | responder `<lab-lan-gateway-ip>`, status 11013, RTT 0 ms | `c0a80a01 052b0000 00000000 00000000 …` |
| IPv4 → 1.1.1.1, TTL 64 | responder 1.1.1.1, status 0, RTT 13 ms | `01010101 00000000 0d000000 20000000 …` |
| IPv6 → `<lab-macos-host-tailscale-ipv6>`, hop limit 64 | responder = destination, status 0, RTT 4 ms | `0000 00000000 <lab-macos-host-tailscale-ipv6-bytes> 00000000 0000 00000000 04000000 …` |

IPv4: Address@0, Status@4 and RoundTripTime@8 match `ipexport.h`. IPv6: sin6_port@0, flowinfo@2, sin6_addr@6–22 and scope@22 are followed by 2 bytes of padding, then Status@28 and RoundTripTime@32. The 4 ms read at @32 matches `ping -6` (3–5 ms). Status@28 was only seen with a value of 0.

**Results** (final run, all 7 lab tests PASS, `LAB_EXIT=0`):

| Case | Result | Evidence |
|---|---|---|
| Capability: `TraceSupported()` and `NativeIO.TraceTransport()` | PASS | true and non-nil |
| (a) Default gateway `<lab-lan-gateway-ip>`, max 4 hops | PASS | `succeeded`: 1 hop, `<lab-lan-gateway-ip>`, 1.08 ms, `observed` |
| (b) 1.1.1.1, 30×2 | PASS | `succeeded` in 2.1 s. 21 hops: `<lab-lan-gateway-ip>` → `<isp-hop-2>` → `<isp-hop-3>` → `<isp-hop-4>` → `<isp-hop-5>` → `<isp-hop-6>` → `<isp-hop-7>` → `<isp-hop-8>` → TTL 9 **both probes `address:null, rttMs:null, outcome:timeout, unknown`** → `172.68.32.12` → `1.1.1.1` (destination confirmed at TTL 11, attempt 1, 22 ms) |
| (c) 192.0.2.1 blackhole, 8×1 | PASS | `failed_check / trace_destination_unreachable`. Hops 1–6 replied. TTL 7 `<isp-hop-7>` answered **destination unreachable**, and the trace stopped at that router. No hop claimed 192.0.2.1 |
| (d) IPv6 `<lab-macos-host-tailscale-ipv6>` (the Mac over Tailscale), 30×1 | PASS **after the fix below** | `succeeded`: 1 hop, destination, 3 ms, `observed`, source `<lab-windows-11-host-tailscale-ipv6>` |
| (e) Unused on-link address `<lab-lan-unused-ip>`, 2×1 (observational) | PASS | Run 1: both hops `null` + `timeout` (ARP had not failed within the 1 s hop budget). Run 2: TTL 1 `unreachable` from **the host's own address** `<lab-windows-11-host-lan-ip>`, 987 ms, then stop |

Across all runs, every answered hop had a valid responder in the destination's family, and every RTT was in (0, 1000] ms. No panics. The `nd` unit suite ran natively: every assertion passed. The 16–18 reds were all `TempDir RemoveAll cleanup: … journal.lock … being used by another process` (see the findings), plus the vector-path reds before the vector files were staged.

**Findings.**

1. **Bug, fixed in this commit.** `networkcontext.WindowsReader.LookupRoute` set `sin6_scope_id` = interface index on every IPv6 destination. `GetBestRoute2` rejects a scope id on a global or ULA destination with `ERROR_INVALID_PARAMETER` (87), measured on the host. As a result, every interface-pinned IPv6 diagnostic step (`Origin.InterfaceKey` set), including trace, icmp and tcp, returned `unsupported / unsupported_context` on Windows. The unpinned lookup worked, which hid the bug. Fix: `winSockaddr` now sets the scope only for link-local addresses. The new unit test `TestWindowsSockaddrScopesOnlyLinkLocalIPv6` failed on the host before the fix (`2001:db8::1: scope 31, want 0`) and passes after it. The pinned IPv6 lookup and case (d) then passed. This code shipped in M1 (#6115), so main has the same bug.
2. **Behaviour to decide on, unchanged.** When ARP fails for an on-link host, the Windows ICMP API reports `DEST_HOST_UNREACHABLE` with the **local source address** as the responder. The trace then records the agent's own IP as an `unreachable` hop at TTL 1 (case (e), run 2). The hop is what the OS reported, not an invented responder, but a renderer may show the device itself as a router. Whether to relabel it is a product decision.
3. **Test hygiene, unchanged.** The existing `networkdiagnostic` unit tests never `Close()` the journals they open. On Windows, `t.TempDir` cleanup then fails on the held `journal.lock`, and 16 otherwise-green tests fail. This package is not in CI's `test-agent-windows` list, so CI does not see it. The lab suite closes its journals.
4. Windows reports sub-millisecond RTTs as 0. The transport then falls back to wall-clock time (gateway 0.58–1.08 ms). That fallback is expected, not a defect.

**Still unverified.**

- A non-zero IPv6 status at @28 (hop limit exceeded or unreachable). The host had no multi-hop IPv6 path, so the `LAB-VERIFY` note for it stays in `traceroute_windows.go`.
- A link-local IPv6 trace destination (zone/scope path).
- Windows Server 2022 specifically. This run used Windows 11 26200.
- A trace delivered through a real enrolled agent and rendered from the server.
