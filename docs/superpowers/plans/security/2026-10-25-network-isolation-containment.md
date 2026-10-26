---
status: draft — awaiting Gate B
tracking_issue: LanternOps/breeze#4618
spec: docs/superpowers/specs/security/2026-10-25-network-isolation-containment-spec.md
verified_at: origin/main 039a39007c (2026-10-25)
related: [4149, 3397, 9118, 8869, 6758, 6754, 10065]
---

# Network Isolation Containment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `execute_containment` with `actionType: network_isolation` cuts a Windows, Linux or macOS endpoint off the network except for the Breeze management plane. The cut is verified on the device, can always be released from the console, and releases itself at expiry even when the agent binary is broken.

**Architecture:**
- **Server.** The server holds the desired state per device in a new org-scoped episode table, `device_network_isolations`. Episodes carry monotonic generations, release tombstones and a journal-sequence high-water mark. The server builds the allowlist from its own environment and sends the desired state on every heartbeat.
- **Agent.** A new package, `agent/internal/isolation`, owns the mechanics:
  - a pure state machine;
  - a fenced, fsynced journal;
  - allowlist resolution;
  - apply → verify → commit, with a 90 s one-shot rollback;
  - HMAC break-glass;
  - re-verify.
- **Per-OS isolators.** Each OS plugs in one `Isolator`: WFP on Windows (W1), nftables with a cgroup split on Linux (W2), and a pf anchor on macOS (W3).
- **Recovery.** A small, separately installed `breeze-isolation-recovery` binary enforces expiry, provisional rollback and interrupted release without the agent.
- **W4.** W4 adds the partner-wide `containment` config-policy feature, the four-eyes AI release tool, the signed offline token and the opt-in dead-man.

**Tech Stack:** Go 1.26 agent (`golang.org/x/sys/windows` for `fwpuclnt.dll`; `exec` of `nft` and `pfctl`), Hono/TypeScript API, Drizzle (queries only) with hand-written SQL, BullMQ, Zod in `packages/shared`, Astro + React islands, `apps/viewer`, Vitest, Go `testing` with fuzz.

**Spec:** `docs/superpowers/specs/security/2026-10-25-network-isolation-containment-spec.md`. Gate A approved it on 2026-10-25, and each OD carries its decision.
- Read §3.2–§3.7 before any agent task, §4 before W1a, and §3.11 before W4a.
- The spec wins any disagreement with this plan, **except** the eight plan-stage refinements in Gate B decision 4. They tighten or correct the spec; none reverses an OD.
- If you find a further disagreement, raise it on #4618. Do not silently follow either document.

## Global Constraints

**Flag and gates**
- `NETWORK_ISOLATION_ENABLED` is an API env var and defaults to `false`.
- `NETWORK_ISOLATION_ENABLED_PARTNER_IDS` is optional: a comma-separated list of partner UUIDs. When it is set, start is allowed only for those partners. It is the lab → canary → fleet lever (Gate B decision 8).
- When either flag blocks, only **start** refuses (`feature_disabled`). Release, extend, acknowledge, the break-glass view, heartbeat reconciliation, the finalizer and recovery stay live.
- The agent has **no** isolation flag of its own.
- `NETWORK_ISOLATION_MIN_AGENT_VERSION` lives in `packages/shared/src/utils/networkIsolation.ts`. It is `'999.0.0'` (fail closed) until W1g pins the real release.
- Start requires agent version ≥ the gate **and** `securityCapabilities.networkIsolationVersion ≥ 1`. The gate never blocks release.
- While a device is isolated, the server refuses agent upgrades or downgrades to a version below the gate.

**Timing**
- TTL defaults to 72 h, maximum 720 h, and is extendable; each extend is a new generation. An "expires in 12 h" alert goes to the requester and the incident owner (OD5).
- Provisional apply: verify within 60 s; a one-shot OS rollback at **apply + 90 s**. Expiry: a one-shot task at `expiresAt`, plus a poll every 15 min and at boot. Re-verify every 5 min, on resume and on network change. The negative-probe local timeout is 3 s.
- **What these timings guarantee.** They assume the OS scheduler, the firewall engine (BFE/nft/pf) and storage are working. Time the device is powered off does not count. At boot and resume, overdue work runs immediately.

**Clock rule** (spec §3.6 item 2, plus refinement 4(ii)). An episode is expired when **any** of these holds:
- wall clock ≥ `expiresAt`;
- in the same boot, monotonic elapsed time ≥ TTL;
- after a reboot, wall clock < `highWaterWall − 5 min`. `highWaterWall` is the largest wall time journalled by the agent or recovery (written every tick) or taken from a server `Date` header.

**Fencing**
- Every mutation of rules or journal takes the machine-wide lock at `<dataDir>/isolation.lock`. That is `flock` on Unix and `LockFileEx` on Windows; the patterns are in `agent/internal/updater/filelock_{unix,windows}.go`.
- Each apply has an `attemptId`. A worker re-checks its `attemptId`, the deadline and the rule digest under the lock before it commits.
- The lock is never held across network probes.

**Ordering key**
- Every agent report and every command result carries `(isolationId, generation, journalSeq)`. The server ignores any message whose `journalSeq` ≤ the episode's `last_journal_seq`.
- Resolved terminal states take precedence: the only transition out of one is `acknowledge`, and only from an unresolved terminal state.
- A server-side timeout or delivery expiry never proves that the device's rules are gone.

**Break-glass code**
- `HMAC-SHA256(secret, "<isolationId lowercase>|<generation>|<hourBucket>")`, where `hourBucket = floor(unixSeconds/3600)` in decimal.
- Take the first 5 bytes and encode them as RFC 4648 base32 without padding, giving 8 characters.
- The agent accepts buckets −1, 0 and +1, and allows 5 attempts per hour. The console shows the current code and the next one.

**Closed sets**

| Set | Members |
|---|---|
| States | `requested, dispatched, applying, applied, verified, release_requested, released, expired, failed, released_locally, self_released, uninstalled` |
| Failure codes | `unsupported_platform, mechanism_unavailable, apply_error, control_plane_unreachable, enforcement_not_observed, not_delivered, agent_unsupported` |
| Release kinds | `console, ai, expired, dead_man, local_code, local_forced, uninstall, system` |
| Resolved terminal | `released, expired, failed, uninstalled` |
| Unresolved until acknowledged | `released_locally, self_released` |

Each device has at most one unresolved episode.

**Safety invariants**
- Isolation is never device `quarantined` status (§3.1 item 7).
- Drop, never reject. Rules are dual-stack: if either address family fails, both are rolled back.
- No hostnames, IPs or regions in code, tests or docs. Tests use `control.example.test`, `relay.example.test`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `2001:db8::/32`.
- Agent-shipped code is high blast radius. Write the test red first, run `go test -race`, and pass a lab leg on each OS before any promote. Never run a lab agent on a host that has the installed agent.

**Permissions**
- Human isolate and release require all of `requireInteractiveSession()`, `requireScope('organization','partner','system')`, `requirePermission(DEVICES_EXECUTE)` and `requireMfa()`, plus a site check.
- API keys cannot isolate or release in v1.

**Run commands.** In this plan, "Run it" or "Run them" means the following, scoped to the files the task names:

| Area | Command |
|---|---|
| API | `pnpm --filter @breeze/api exec vitest run <test file>` |
| Web | `pnpm --filter @breeze/web exec vitest run <test file>` |
| Shared | `pnpm --filter @breeze/shared exec vitest run <test file>` |
| Viewer | `pnpm --filter @breeze/viewer exec vitest run <test file>` |
| Go | `cd agent && go test -race ./<package dir>/...` |
| Integration-only suites | the test-stack recipe in `docs/agents/testing.md` |

- Never run `pnpm --filter <pkg> test -- --run <path>`.
- Vitest path filters are substring matches, so pass the exact file.

**Repo conventions**
- Every new API env var also gets an explicit pass-through in `docker-compose.yml` and `deploy/docker-compose.prod.yml`, using `${VAR:-}` (flags default to `false`). Precedent: `MCP_UNATTENDED_TIER3_PRINCIPALS` at `docker-compose.yml:630` and `deploy/docker-compose.prod.yml:599`. Without the pass-through, the flag is silently ignored in container deployments.
- New org tables: RLS shape 1, forced, with policies in the creating migration and every registration (W1a Task 1).
- Every new web string ships in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`), and `humanizedKeyBaseline.json` stays in sync.
- PR bodies carry `Closes #<wave sub-issue>` and `Refs #4618`. #4618 closes only through `close_feature`.

## Review Focus

1. **Release must survive every start-gate failure.** That covers: flag off, partner not on the list, agent below the gate, capability 0, partner trust-demoted, requester deactivated, device quarantined, incident closed, device offline. In each case "Release" stays visible and enabled, and the release reaches the device through both the queued command (claim-time exempt) and the heartbeat tombstone. Pinned by W1b Task 3 (`release.gates.test.ts`), W1b Task 2 (`commandClaimEligibility.release.test.ts`) and W1h Task 1.
2. **A late, duplicate or same-generation message must not move an episode backwards.** That covers: a `completed` after the reaper timed the command out, an older `journalSeq`, a replayed release result, and an old one-shot timer firing after an extend. Pinned by W1b Task 1 (`reconcile.matrix.test.ts`), W1b Task 2 (`finalizer.ordering.test.ts`) and W1d Task 2 (`manager_fence_test.go`).
3. **Crash or power loss at any apply, commit, release, extend or upgrade boundary.** The device must end either verified-isolated or with absence of rules confirmed. Pinned by W1d Task 2 (`manager_crash_test.go`) and W1g Task 1 (`recovery_crash_test.go`).
4. **No bypass can isolate or release outside the service.** That covers: generic and bulk command routes, AI caller `parameters`, an MCP unattended principal, MCP intents, API keys, a legacy pending command, and a crafted payload with no matching episode. Pinned by W1c Task 1 (`networkIsolation.bypass.test.ts`) and W1e Task 1 (`handlers_containment_test.go`).
5. **Linux children must not escape the permit.** Every agent spawn lands in `…/children` before exec. Pinned by W2 Task 2 (`spawn_contract_test.go`).

---

## Wave map

OD12 fixed the release order: W1 Windows → W2 Linux → W3 macOS → W4. Gate B decision 1 settles the sub-wave split. Each row below is one PR to `main` (no stacking) and one `feature-lifecycle` sub-issue.

Every row can merge on its own. Until W1g, every agent reports capability 0, the gate is `'999.0.0'` and the flag is off, so nothing can isolate a device. **Activation** means turning the flag on for the lab partner. It requires **all** of W1a–W1i merged, a released agent carrying W1g, and lab leg L1 passed. Merging alone never activates anything.

| Wave | Scope (owns) | Merge after | Promote / activation gate (Todd) |
|---|---|---|---|
| **W1a** server data + contracts | migration, schema, six registrations, shared constants/validators, break-glass, allowlist builder, pure state machine + store | — | none |
| **W1b** server orchestration | heartbeat block + reconcile, command registrations + claim exemption, ordered finalizer, service + routes + verify route | W1a | none |
| **W1c** server guards | generic/bulk/AI/MCP/intent bypass closure, legacy-command claim refusal, agent-update gate, lifecycle refusals, sweeper + alerts + events | W1b | none |
| **W1d** agent core | `agent/internal/isolation` types, journal + lock, state machine, resolver, probe driver, break-glass, Manager (fake isolator); capability 0 | W1a (vectors file) | none |
| **W1e** agent wiring | heartbeat request/response, handlers + strict payload validation, CLI, updater isolation gate, recovery-binary skeleton | W1d, W1b | none |
| **W1f** Windows WFP | WFP binding, WFP isolator, Windows recovery scheduler | W1e | none (capability still 0) |
| **W1g** Windows recovery + activation | recovery distribution, uninstall/upgrade/MSI, release pipeline, Windows capability 1 after readiness, pin the version gate | W1f **and** W1c, W1h, W1i. A capability-1 agent must never ship before the bypass closure, the release UI and relay-only RD are on `main` | **L1 Windows lab leg** |
| **W1h** console + docs | DeviceActions/dialog/badge/code/ack/incident/list filter, locales, docs + runbook | W1b | part of L1 |
| **W1i** relay-only remote desktop | API session offer `relayOnly`, Pion relay policy, viewer `iceTransportPolicy` + no STUN-only fallback while isolated | W1b | part of L1 |
| **W2** Linux | cgroup split, `procspawn` at-spawn placement, nft isolator, systemd units, recovery, scripts | W1g | **L2 Linux lab leg** |
| **W3** macOS | pf compatibility + attach-once + parent hook, pf isolator, LaunchDaemons, recovery, pkg | W1g (parallel to W2) | **L3 macOS lab leg** |
| **W4a** containment policy | config-policy feature `containment`, `resolveContainmentPolicy`, `scope:"any"` extras, Policy tab | W1c | none |
| **W4b** AI release | `release_containment` AI tool, four-eyes, effect digest, tier tables, docs parity, index budget | W1c, #6758 and #10065 merged | none |
| **W4c** signed offline token | Ed25519 release token, agent verify, console token + QR, `requireSignedReleaseToken` | W1g, W4a | **L4 token leg** |
| **W4d** dead-man opt-in | agent dead-man (capability v2), `self_released` flow, policy wiring | W1g, W4a | **L5 dead-man leg** |

- **Branches.** Each wave works on `feature/4618-network-isolation/wave-<sub-issue#>`.
- **Migration names.** A migration slots after the newest file shipped **at dispatch time**. At plan time the newest is `2027-01-05-100600-wisp-partner-settings.sql`; re-check rather than copying this name.

## Premise check (`039a39007c`)

| Claim | Evidence | Status |
|---|---|---|
| The agent stub returns a platform error for `network_isolation` | `agent/internal/remote/tools/incident_response.go:176,189`. The handler forwards the payload untouched (`agent/internal/heartbeat/handlers_incident_response.go:16`) | open. That stub is today's **only** execution barrier, so W1e replaces it with strict validation, not with a pass-through |
| No WFP, nft or pf code in the agent | no `fwpuclnt`, `inet.af/wf`, `nft` or `pfctl` anywhere. The only firewall code is BMR's `iptables-restore` (`agent/internal/backup/bmr/restore_linux.go:490-501`) | open |
| The AI tool sends caller `parameters` straight to the agent | `apps/api/src/services/aiToolsIncident.ts:294-299` | open. W1c re-routes it **before** any agent can act |
| Generic and bulk routes accept `execute_containment` | `apps/api/src/routes/devices/schemas.ts:309,352` | open |
| `release_containment` does not exist | grep finds it nowhere in `apps/`, `packages/` or `agent/` | open |
| `execute_containment` is in `LIFECYCLE_COMMAND_TYPES` | `apps/api/src/services/partnerTrust.ts:30,101` | holds. Trust demotion therefore does not stop delivery, so W1b gates start on trust explicitly |
| Claim-time cancels (deactivated requester, org drift, quarantined device) apply unless the type is teardown-exempt | `apps/api/src/services/commandClaimEligibility.ts:174,187,439` | holds. W1b adds `release_containment` to `TEARDOWN_CLAIM_EXEMPT_TYPES` |
| On Windows the agent updates by raw binary swap, not by MSI | `agent/internal/updater/updater.go:1024`, `restart_windows.go:240` | holds. The recovery binary cannot rely on the MSI alone (W1g Task 2) |
| The updater follows cross-origin artifact URLs taken from a signed manifest | `agent/internal/updater/updater.go:1515` | holds. W1e restricts this while isolated |
| The viewer retries STUN-only when the ICE config is rejected | `apps/viewer/src/lib/webrtc.ts:250-265` | holds. W1i disables that fallback while the device is isolated |
| There is no incident delete route | `apps/api/src/routes/incidents.ts` has no `.delete(` | holds. W1c adds a static test that fails if such a route appears without the episode check |
| The AI tool-index budget is 7 040 B; the authorised cap is 7 680 B | `apps/api/src/services/aiToolIndex.test.ts:184,219` | holds. Measure in W4b; raise by +128 B at most, once |

---

## Cross-wave interfaces (defined once)

**TypeScript, `packages/shared/src/utils/networkIsolation.ts`** (W1a Task 2)

- `NETWORK_ISOLATION_MIN_AGENT_VERSION: string`.
- `agentSupportsNetworkIsolation(agentVersion: string | null, capabilityVersion: number | null): boolean` fails closed; it follows the `forceReboot.ts` pattern.
- `NETWORK_ISOLATION_TTL = { defaultHours: 72, maxHours: 720, expiringSoonHours: 12 } as const`.
- Readonly tuples `ISOLATION_STATES`, `ISOLATION_FAILURE_CODES`, `ISOLATION_RELEASE_KINDS`, `RESOLVED_TERMINAL_STATES`, `UNRESOLVED_TERMINAL_STATES` and `ACTIVE_STATES`, plus the unions `IsolationState`, `IsolationFailureCode` and `IsolationReleaseKind`.
- `ECH_DOH_ENDPOINT_URLS: readonly string[]`. A TS test parses `agent/internal/ech/doh.go:25` (`DefaultEndpoints`) to keep the two in step.
- `NETWORK_ISOLATION_CAPABILITY = { base: 1, deadMan: 2 } as const`.

**Zod, `packages/shared/src/validators/networkIsolation.ts`** (W1a Task 2)

- `isolationAllowEntrySchema` is a discriminated union:
  - `{kind:'host', host, proto:'tcp'|'udp'|'udp+tcp', ports:number[], scope:'breeze'|'any'}`
  - `{kind:'cidr', cidr, proto, ports, scope}`
- `startNetworkIsolationSchema` is `{ incidentId?: uuid, createIncident?: { severity, title }, ttlHours?: 1..720, reason: 1..2000 chars, remoteRelay?: boolean }`. Exactly one of `incidentId` and `createIncident` must be present.
- `releaseNetworkIsolationSchema` is `{ reason }`; `extendNetworkIsolationSchema` is `{ ttlHours: 1..720 }`.
- `containmentDesiredBlockSchema` (heartbeat response) is `{ networkIsolation: { isolationId, generation, desired:'isolated'|'released', expiresAt, deadManSeconds, remoteRelay, allow, breakGlassSecret?: string } | null }`.
  - `breakGlassSecret` is base64 of the 32-byte secret. The server decrypts it from `break_glass_secret_enc` when it builds the block, and sends it over the agent's TLS channel only. That is the same trust model as the command path, where `decryptCommandForDelivery` decrypts just before sending.
  - It is present only until `break_glass_ack_seq` is set. It is never logged or audited.
- `networkIsolationReportSchema` (heartbeat request) is `{ isolationId, generation, journalSeq, state, phase, mechanism, appliedAt, lastVerifiedAt, ruleDigest, lastError, secretAckSeq?, recoveryVersion?, events?: JournalEvent[] }`. The report also carries `{ isolationId: null, phase: 'none' }`, meaning "nothing Breeze-owned is installed". The server uses that form to confirm a tombstone.

**Go wire, `agent/internal/isolation/types.go`** (W1d Task 1). The JSON tags match the Zod schemas exactly.

- `type Spec struct { IsolationID string; Generation int; ExpiresAt time.Time; DeadManSeconds int; RemoteRelay bool; Allow []AllowEntry; BreakGlassSecret []byte }`
- `type AllowEntry struct { Kind, Host, CIDR, Proto string; Ports []uint16; Scope string }`
- `type Report struct { … }` mirrors `networkIsolationReportSchema`.
- `type Isolator interface { Capability() Capability; Apply(ctx, ResolvedSpec) (Digest, error); Verify(ctx, ResolvedSpec) (Digest, error); Release(ctx) error; Owned(ctx) (bool, error); Mark(ctx) (Marker, error); DropObserved(ctx, since Marker) (bool, error) }`
- `type Capability struct { Version int; Mechanism, UnsupportedReason string; Ready bool }`
- `type RecoveryScheduler interface { ArmProvisional(attemptID string, deadline time.Time) error; DisarmProvisional(attemptID string) error; ArmExpiry(isolationID string, generation int, at time.Time) error; EnsurePoll() error; RemoveAll() error; Ready() (bool, string) }`
- Typed errors live in `agent/internal/wire/errorcodes.go` as `wire.ErrCodeIsolation*`: one per failure code, plus `isolation_episode_mismatch`, `isolation_stale_generation`, `isolation_invalid_spec` and `isolation_busy`.

**Go journal, `agent/internal/isolation/journal`** (W1d Task 1). The agent and the recovery binary both import this package, and it must import nothing from `heartbeat`, `config` or `updater`.

- `Load(path string) (*Journal, error)`.
- `Save(path string, j *Journal) error`: mode 0600 (SYSTEM-only ACL on Windows), fsync, then `atomicrename.Replace`.
- `Lock(dir string) (Unlock func(), error)`.
- `type Journal struct { SchemaVersion int; Episode *EpisodeRecord; Phase Phase; AttemptID string; ProvisionalDeadline time.Time; AppliedAtWall time.Time; AppliedAtMono int64; BootID string; HighWaterWall time.Time; Events []Event; NextSeq int64; BreakGlassAttempts []time.Time; SecretAckSeq int64; RecoveryPath string; PendingReport *TerminalReceipt }`
- `Phase` is one of `none, provisional, committed, releasing, released, rolled_back`.
- The file lives at `<dataDir>/isolation.json`.
- If `SchemaVersion` is unknown, or the file is corrupt or missing while `Isolator.Owned()` is true, the result is **delete every Breeze-owned rule** and journal a fresh `released` (kind `system`).

---

## W1a — Server data and contracts

**Owns:** the migration, `apps/api/src/db/schema/networkIsolation.ts`, `packages/shared/src/{utils,validators}/networkIsolation*.ts`, `apps/api/src/services/networkIsolation/{breakGlass,allowlist,stateMachine,episodeStore}.ts`, and `agent/internal/isolation/testdata/breakglass_vectors.json`.

### Task 1: Migration, schema and registrations

**Files:**
- Create `apps/api/migrations/<slot>-device-network-isolations.sql` and `apps/api/src/db/schema/networkIsolation.ts`.
- Modify `apps/api/src/db/schema/index.ts` to export the new table, and `apps/api/src/db/schema/incidentResponse.ts:51,110` to add `unique(id, org_id)` on `incidents` and on `incident_actions`.
- Register the table in:
  - `apps/api/src/services/tenantCascade.ts:257` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical, before `devices`, `incidents` and `incident_actions`);
  - `apps/api/src/services/orgMergeRegistry.ts` (`repoint`);
  - `apps/api/src/services/tenantExportPolicyRegistry.ts:51`;
  - `apps/api/src/routes/devices/core.ts` at `:315` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES`), `:465` (`CORE_DEVICE_ORG_MOVE_DELETE_TABLES`) and `:654` (`CORE_DEVICE_CASCADE_DELETE_TABLES`).
- Test: `apps/api/src/db/schema/networkIsolation.migration.test.ts`, which asserts on the SQL text (pattern: `aiRunWorkspaces.enums.test.ts`).

**Interfaces:** Produces `deviceNetworkIsolations`. It has the spec §4 columns plus four that refinement 4(iv) adds. All four are in the `included` export bucket.

| Column | Type | Purpose |
|---|---|---|
| `expiry_warned_at` | `timestamptz NULL` | the 12 h alert fires once |
| `break_glass_ack_seq` | `bigint NULL` | once set, the heartbeat stops carrying the secret |
| `last_journal_seq` | `bigint NOT NULL DEFAULT 0` | the ordering high-water mark |
| `release_confirmed_at` | `timestamptz NULL` | the agent has confirmed absence; until then the tombstone stays in the heartbeat |

- [ ] **Step 1: Write the failing test.** Assert that the SQL has all of:
  - `ENABLE` and `FORCE ROW LEVEL SECURITY`;
  - four `breeze_has_org_access(org_id)` policies;
  - `FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`;
  - `(incident_id, org_id) → incidents(id, org_id) ON DELETE SET NULL (incident_id) DEFERRABLE INITIALLY IMMEDIATE`, and the same shape for `incident_action_id`;
  - idempotent `UNIQUE (id, org_id)` on `incidents` and `incident_actions`;
  - partial unique `(device_id) WHERE state NOT IN ('released','expired','failed','uninstalled')`;
  - an index on `(org_id, state)`;
  - an index on `(expires_at) WHERE state IN (<ACTIVE_STATES>)`;
  - an index on `(device_id) WHERE desired_state = 'released' AND release_confirmed_at IS NULL`;
  - no `BEGIN;`.
- [ ] **Step 2: Run it.** `pnpm --filter @breeze/api exec vitest run src/db/schema/networkIsolation.migration.test.ts`. Expected: FAIL (missing file).
- [ ] **Step 3: Write the migration and the Drizzle table.**
  - Declare both composite FKs in Drizzle. `moveOrg.coverage.test.ts` reads them from there.
  - Export buckets follow spec §4: `break_glass_secret_enc` is `excludedSensitive`; `allow_snapshot` and `last_agent_report` are `excludedOpen`; everything else is `included`.
  - The org-move disposition is **delete**, the same as `topology_device_presence`. Read `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts:551` (the `devices` flip), `:955-958` (the restamp loop skips move-delete tables) and `:1048` (the delete loop).
  - W1c Task 2's move refusal ensures only resolved history is ever deleted.
- [ ] **Step 4: Run the checks.** Run the migration test, `pnpm db:check-drift`, `moveOrg.coverage.test.ts` and `cascadeDelete.test.ts`. Then run `rls-coverage`, `tenantCascade`, `orgMergeRegistry`, `tenant-export-policy`, `tenantExportErasureRoundtrip` and `orgLifecycleFoundations` against the test stack (`docs/agents/testing.md`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): device_network_isolations table + tenancy registrations (#4618)`.

### Task 2: Shared constants, validators, break-glass and allowlist builder

**Files:**
- Create the two shared files above and export them from the shared barrels. Keep `topologyZod` first in the barrel (zod 4.6 trap).
- Create `apps/api/src/services/networkIsolation/breakGlass.ts` and `allowlist.ts`.
- Create `agent/internal/isolation/testdata/breakglass_vectors.json`.
- Tests: `packages/shared/src/utils/networkIsolation.test.ts`, `packages/shared/src/validators/networkIsolation.test.ts`, and `breakGlass.test.ts` and `allowlist.test.ts` next to the services.

**Interfaces:**
- `generateEpisodeSecret(): Buffer` returns 32 bytes.
- `breakGlassCode(secret: Buffer, isolationId: string, generation: number, hourBucket: number): string`.
- `currentBreakGlassCodes(secret, isolationId, generation, now: Date): { current: string; next: string; currentValidUntil: Date }`.
- `buildIsolationAllowlist(ctx: { serverUrl: string; remoteRelay: boolean; policyExtras?: IsolationAllowEntry[] }): IsolationAllowEntry[]`.

- [ ] **Step 1: Write the failing tests.**
  - **Break-glass vectors.** Generate them once with a reference script and commit them. Cover a zero secret, generations 1 and 7, buckets 0 and 493 000, and an uppercase UUID (it must be lowercased first). Every code matches `/^[A-Z2-7]{8}$/`.
  - **Allowlist entries.**
    - The server URL host is always included, with its port.
    - `AGENT_BACKUP_SERVER_URL` is included when set.
    - `TURN_HOST` and `TURN_TLS_HOST` (udp+tcp, 3478/5349) are included **only** when `remoteRelay`.
    - The DoH hosts from `ECH_DOH_ENDPOINT_URLS` are included.
  - **Allowlist scope.** Every server-built entry has `scope:'breeze'`. A `scope:'any'` entry is accepted only from `policyExtras`.
  - **DoH parity.** The list matches the one parsed from the Go file.
  - **Version gate.** `'999.0.0'` refuses every real version, and capability 0 refuses.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use `node:crypto` `createHmac`, plus a local base32 encoder. Add no new dependency.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Pure episode state machine and store

**Files:**
- Create `apps/api/src/services/networkIsolation/stateMachine.ts` and `episodeStore.ts`.
- Tests: `stateMachine.test.ts`, and `episodeStore.integration.test.ts` (runs under Integration Tests).

**Interfaces:**
- `EpisodeEvent` is a union of `dispatched`, `agent_ack`, `agent_applied`, `agent_verified`, `agent_failed{code}`, `release_requested{kind}`, `agent_released{kind}`, `agent_expired`, `agent_self_released`, `agent_released_locally{kind}`, `agent_absent`, `uninstalled`, `not_delivered`, `extend{expiresAt}` and `acknowledge`.
- Every event carries `{ generation, journalSeq? }`.
- `applyEpisodeEvent(row: EpisodeSnapshot, ev: EpisodeEvent): { next } | { ignored: 'stale_generation' | 'stale_seq' | 'invalid_transition' | 'already_terminal' }`.
- `episodeStore`:
  - `withEpisodeLock(tx, episodeId, fn)` locks the row with `SELECT … FOR UPDATE`.
  - `createEpisode(tx, values)` maps a 23505 to `isolation_already_active`.
  - `findUnresolvedEpisode(tx, deviceId)`.
  - `findUnconfirmedTombstone(tx, deviceId)`.
  - `listEpisodes(tx, deviceId, {limit})`.

- [ ] **Step 1: Write the failing table test.** It covers every arrow in spec §3.2, plus these cases:

  | Case | Expected |
  |---|---|
  | `extend` | increments the generation |
  | retransmission | keeps the generation |
  | release | sets `desired_state='released'` with generation = last + 1 |
  | lower generation | `stale_generation` |
  | `journalSeq` ≤ `last_journal_seq` | `stale_seq` |
  | any event after a resolved terminal state | `already_terminal`, including a same-generation `agent_verified` after `failed` |
  | `acknowledge` | valid only from an unresolved terminal state |
  | `release_requested` | valid from every active state |
  | `agent_absent` | sets `release_confirmed_at` |

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** `stateMachine.ts` must import nothing from the DB layer.
- [ ] **Step 4: Run both tests.** In the integration test, concurrent creates for the same device leave exactly one winner. Expected: PASS.
- [ ] **Step 5: Commit.**

**W1a CI traps:**
- The contract suites fail only under **Integration Tests**, so run them on the test stack before opening the PR.
- Local `tsc` for the API OOMs at 12 GB. CI runs `tsc --build tsconfig.tests.json` with a strict index, so check the exit code and never pipe it to `tail`.
- New service files need a `parkedFanout.contract.test.ts` classification.
- New paths must be covered by `.github/scripts/classify-pr-paths.sh` and `ci-area-gating.test.mjs`.

---

## W1b — Server orchestration

**Owns:** `apps/api/src/services/networkIsolation/{reconcile,finalizer,service,gates}.ts`, `apps/api/src/routes/devices/networkIsolation.ts` and `apps/api/src/routes/agents/isolationVerify.ts`, plus the edits listed per task.

### Task 1: Heartbeat containment block and reconcile matrix

**Files:**
- Create `services/networkIsolation/reconcile.ts`.
- Modify `apps/api/src/routes/agents/heartbeat.ts` (3 178 lines) to add only two calls. Put a top-level `containment` field next to `commands`. Do **not** put it in `configUpdate`: the agent persists `configUpdate` to `agent.yaml`.
- Modify `apps/api/src/routes/agents/schemas.ts:397` to add:
  - `securityCapabilities.networkIsolationVersion`, `networkIsolationMechanism`, `networkIsolationUnsupportedReason` and `networkIsolationReady`;
  - a top-level `containment.networkIsolation` that uses `networkIsolationReportSchema`.
- Tests: `services/networkIsolation/reconcile.matrix.test.ts` and `routes/agents/heartbeat.containment.test.ts`.

**Interfaces:**
- `buildContainmentHeartbeatBlock(tx, device): Promise<{ networkIsolation: DesiredBlock | null }>`. The `containment` key is always present in the response.
- `reconcileContainmentReport(tx, device, report | undefined, serverNow: Date): Promise<void>`.

- [ ] **Step 1: Write the failing matrix test.**
  - Axes:

    | Axis | Values |
    |---|---|
    | Desired state | `isolated`, `released` with an unconfirmed tombstone, none |
    | Reported | none, `{phase:'none'}`, `applied`, `verified`, `released`, `expired`, `released_locally`, `self_released`, `failed` |
    | Generation | same, older, newer |
    | `journalSeq` | newer, not newer |

  - Expected outcomes, one per clause of spec §3.3:
    - Desired isolated, reported released at the same generation → `released_locally` or `self_released`, plus an alert.
    - Desired released, reported applied → the tombstone is still sent.
    - Reported `{phase:'none'}` or `released` at the tombstone's generation → `release_confirmed_at` is set, and only then is the block `null`.
    - Digest change → a `drift_reapplied` event.
    - Stale generation or stale seq → journal only.
    - `breakGlassSecret` is present while `break_glass_ack_seq` is null, and absent afterwards. It is never written to logs, audit rows or `last_agent_report`.
    - The block never carries resolved addresses.
    - A tombstone for a **resolved** episode, such as `failed:not_delivered`, is still sent until it is confirmed.
- [ ] **Step 2: Write the failing route test.**
  - Every response has a `containment` key, including for a device that has never been isolated.
  - A malformed report is dropped and the rest of the heartbeat proceeds.
- [ ] **Step 3: Run both.** Expected: FAIL.
- [ ] **Step 4: Implement.** The secret is decrypted only while the block is being built, and is sent only in the heartbeat response body.
- [ ] **Step 5: Run both, plus `heartbeat.test.ts`, `heartbeat.ech.test.ts` and `agentRoleCoverage.test.ts`.** Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 2: Command registrations, claim exemption and the ordered finalizer

**Files:**
- Modify `apps/api/src/services/`:
  - `commandTypes.ts:235`: add `RELEASE_CONTAINMENT: 'release_containment'`.
  - `commandOfflinePolicy.ts:324`: queue both commands. Isolate gets `deliverBy = min(expiresAt, standard TTL)`.
  - `commandTimeouts.ts:121` and `commandQueue.ts:447`.
  - `commandClaimEligibility.ts:174`: add `release_containment` to `TEARDOWN_CLAIM_EXEMPT_TYPES`.
    - Effect: it is exempt from the requester-active, org-drift, erased-submitter-org, device-lifecycle (including `quarantined`) and trust cancels.
    - Update the set's doc comment: membership means the type only reduces capability. The operator's `reason` is audit text, not device-executed content.
    - Update the forbidden-membership test at `commandClaimEligibility.test.ts:676-684` to match.
    - The parked-device cancel, which still applies to teardown types, is accepted for release. A parked device is not delivering anything, and the heartbeat tombstone takes over when it un-parks.
  - `commandResultHandlers.ts:1271`: add `release_containment`.
  - `sensitiveCommandPayload.ts`: the module only handles **top-level** string fields (`SENSITIVE_PAYLOAD_FIELDS`, `encryptSensitivePayloadFields` `:219-250`, strip keys `:150,171`).
    - The isolate payload therefore carries the secret as the top-level field `breakGlassSecret`, not `parameters.breakGlass.secret` (Gate B decision 4 vii).
    - Register `execute_containment: ['breakGlassSecret']` in `SENSITIVE_PAYLOAD_FIELDS`.
    - Add `breakGlassSecret` to `TYPE_SCOPED_TERMINAL_STRIP_KEYS` for `execute_containment`. Only that key is stripped, so `process_kill` payloads and their forensics are untouched.
  - `partnerTrust.ts:30`: add `release_containment` to `LIFECYCLE_COMMAND_TYPES`.
  - `commandMinVersion.ts`: **no** `release_containment` entry. That map refuses or fails commands sent to older agents, and the version gate never blocks release. An agent too old to know `release_containment` fails it as an unknown type, which is harmless because such an agent can never have been isolated.
- Modify `apps/api/src/jobs/staleCommandReaper.ts:346-353` and `services/commandCancelPropagation.ts:299-303` so that a reaped or cancelled isolate command never changes the episode. The heartbeat desired state still delivers it.
- Modify `services/incidentContainmentResults.ts:239`: `handleExecuteContainmentResult` branches to `handleNetworkIsolationResult` when `payload.actionType === 'network_isolation'`. Every other action type is unchanged.
- Create `services/networkIsolation/finalizer.ts`.
- Tests: `finalizer.ordering.test.ts`, `sensitiveCommandPayload.networkIsolation.test.ts`, `commandClaimEligibility.release.test.ts`, and `commandMinVersion.release.test.ts`, which checks that a release is queued for an agent below the gate.

**Interfaces:**
- `handleNetworkIsolationResult(args): Promise<void>` and `handleReleaseContainmentResult(args): Promise<void>`.
- Both parse `stdout` as JSON `{ isolationId, generation, journalSeq, state, phase, mechanism, appliedAt, verifiedAt, rollback, errorCode }`.
- Classification is by `errorCode`, never by message text.

- [ ] **Step 1: Write the failing tests.**
  - A late `completed` after the reaper failed the command does not move the episode. Note that the generic path at `incidentContainmentResults.ts:108-113` *does* reopen; the isolation path must not. The `incident_actions` row follows the episode.
  - A same-generation `verified` with a stale `journalSeq` is ignored.
  - `verified` writes `containment_executed` and publishes `incident.contained` exactly once.
  - `failed` writes `containment_failed`.
  - A release writes `containment_released` and sets `incident_actions.reversed`.
  - `breakGlassSecret` is ciphertext in `device_commands.payload` after enqueue, and plaintext only in the delivered copy (`decryptCommandForDelivery`, `:351`).
  - It is absent after the result, reaper and cancel writers. A `process_kill` row's `parameters` are unchanged by any of them.
  - A `release_containment` row is delivered when the requester is deactivated, the org has drifted, the device is quarantined, or the partner is restricted.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, plus `incidentContainmentResults.test.ts`, the reaper tests and the cancel-propagation tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Service, human routes and the agent verify route

**Files:**
- Create `services/networkIsolation/service.ts` and `gates.ts`.
- Create `apps/api/src/routes/devices/networkIsolation.ts` and mount it next to `forceReboot.ts`.
- Create `apps/api/src/routes/agents/isolationVerify.ts`, which serves `POST /agents/isolation/:isolationId/verify` under agent auth. It stamps `verified_at` with server time and returns the server's `Date`.
- Modify `apps/api/src/config/validate.ts:1087` to add `NETWORK_ISOLATION_ENABLED: z.enum(['true','false']).default('false')` and `NETWORK_ISOLATION_ENABLED_PARTNER_IDS` (optional, comma-separated UUIDs).
- Add both variables, with no values, to `/.env.example` and `deploy/.env.example`.
- Add pass-throughs to `docker-compose.yml` and `deploy/docker-compose.prod.yml`, next to `AGENT_ECH_ENABLED` (`:157` and `:347`):
  - `NETWORK_ISOLATION_ENABLED: ${NETWORK_ISOLATION_ENABLED:-false}`
  - `NETWORK_ISOLATION_ENABLED_PARTNER_IDS: ${NETWORK_ISOLATION_ENABLED_PARTNER_IDS:-}`
- Tests: `service.start.test.ts`, `release.gates.test.ts`, `routes/devices/networkIsolation.test.ts`, `routes/agents/isolationVerify.test.ts`, and a compose-parity assertion. Extend the existing compose env test if there is one; otherwise create `apps/api/src/config/networkIsolationCompose.test.ts`, which greps both compose files for both keys.

**Interfaces:**
- `startNetworkIsolation(auth, deviceId, input, opts: { requestedByKind:'user'|'brain'|'system'; approvalRef?: string }): Promise<{ episode; commandId } | { error: IsolationStartRefusal }>`
- `releaseNetworkIsolation(auth, deviceId, isolationId, input, opts: { kind: IsolationReleaseKind; approvalBinding?: ApprovalBinding })`
- `extendNetworkIsolation(auth, deviceId, isolationId, ttlHours)`
- `acknowledgeNetworkIsolation(auth, deviceId, isolationId)`
- `getBreakGlassCodes(auth, deviceId, isolationId)`, which writes an audit row
- `listDeviceIsolations(auth, deviceId)`, which also returns `startEligibility` for the UI
- `IsolationStartRefusal` = `feature_disabled | agent_unsupported | unsupported_platform | trust_restricted | isolation_already_active | isolation_unacknowledged | incident_mismatch | site_forbidden`
- `ApprovalBinding = { orgId; deviceId; isolationId; generation }`

Routes (spec §3.3), with the full guard set:

| Route | Purpose |
|---|---|
| `POST /devices/:id/network-isolation` | start |
| `POST …/:isolationId/release` | release |
| `POST …/:isolationId/extend` | extend |
| `POST …/:isolationId/acknowledge` | acknowledge |
| `GET …/:isolationId/break-glass-code` | break-glass codes |
| `GET /devices/:id/network-isolation` | list episodes |

Audit through `writeRouteAudit` (`services/auditEvents.ts:225`): `device.isolation.request`, `.release`, `.extend` and `.break_glass_code_view`. Never audit resolved addresses.

- [ ] **Step 1: Write the failing tests.**
  - Start refuses once for each `IsolationStartRefusal`, including a partner that is missing from `NETWORK_ISOLATION_ENABLED_PARTNER_IDS`.
  - `createIncident` creates `classification:'manual_containment'`, `affectedDevices:[deviceId]`.
  - The action row (`actionType:'network_isolation'`, `reversible:true`) and the episode are written in one transaction before dispatch, following the `aiToolsIncident.ts:306` pattern.
  - TTL is 72 h by default, capped at 720 h.
  - An API key gets 403 even with `ENABLE_2FA=false`.
  - `release.gates.test.ts`: release succeeds under every start-gate failure listed in Review Focus 1.
  - The break-glass view is audited.
  - The verify route rejects another device's credential and any unknown or terminal id.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Start calls the trust gate at `partnerTrust.ts:252` explicitly, because of the premise above.
  - Approval bindings are re-checked under the episode lock.
  - Use `withDbAccessContext`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W1c — Server guards

**Owns:** `services/networkIsolation/{bypass,lifecycle}.ts`, `apps/api/src/jobs/networkIsolationSweeper.ts`, plus the edits listed per task.

### Task 1: Close the bypasses (generic/bulk, AI, MCP + intents, legacy commands, agent updates)

**Files:**
- Modify `routes/devices/commands.ts` and the bulk handler that uses `bulkCommandSchema` (`schemas.ts:350`). Reject `execute_containment` where `payload.actionType === 'network_isolation'`, and any `release_containment`, with 400 `use_network_isolation_routes`.
- Modify `services/aiToolsIncident.ts:269`. The `network_isolation` branch calls `startNetworkIsolation(..., { requestedByKind:'brain', approvalRef })` and ignores `parameters`. `aiToolSchemas.ts:2364` gains `ttlHours?` and `reason?`.
- Modify `routes/mcpServer.ts`. Deny `execute_containment` + `network_isolation`, and `release_containment`, in two places:
  - **before** the unattended-principal lift (`isMcpApprovalRequired`, `:1533-1541`);
  - **before** MCP intent eligibility (`:2226`).
- Modify `services/commandClaimEligibility.ts` (per-type delivery revalidation). Refuse an `execute_containment`/`network_isolation` row unless `parameters.isolationId` names an unresolved episode on that device, at that generation, with `desired_state='isolated'`. This cancels any legacy pending command.
- Modify `routes/agents/agentUpdatePolicy.ts`. While a device has an unresolved episode, refuse targets below `NETWORK_ISOLATION_MIN_AGENT_VERSION`.
- Test: `services/networkIsolation/networkIsolation.bypass.test.ts`.

- [ ] **Step 1: Write the failing test.** Each of these paths must be closed:
  - generic route;
  - bulk route;
  - `release_containment` through either route;
  - `process_kill` stays unchanged;
  - AI `parameters.allow:[{scope:'any'}]` → the payload's `allow` equals `buildIsolationAllowlist(...)`;
  - an MCP unattended principal gets `MCP_APPROVAL_REQUIRED` for both tools while another tier-3 tool still lifts;
  - an MCP intent for either tool is refused;
  - a legacy row with no `isolationId`, a forged id or a stale generation is cancelled at claim;
  - downgrading an isolated device is refused.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update the line-keyed `SAFE_WRITE_SITES` (`aiTools.userOwnedRelease.contract.test.ts:145`) if lines move.
- [ ] **Step 4: Run it, plus `aiAgentSdkTools.registryParity.contract.test.ts`, `aiTools.userOwnedRelease.contract.test.ts`, `aiGuardrails*.test.ts` and the MCP tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: Lifecycle refusals

**Files:**
- Modify `services/deviceDecommission.ts:22`, `deviceDeletion.ts:113`, `agentTokenSuspension.ts`, `tenantCascade.ts:1927` (next to `hasActiveLegalHoldSnapshots`, `:1777`), `orgMerge.ts:348` (`collectMergeBlockers`), and the device org-move entry point that calls `moveDeviceOrgInTransaction`.
- Each one calls `assertNoUnresolvedIsolation(tx, scope, action)`, which raises `isolation_unresolved` with the message "Release network isolation first".
- A forced decommission queues a release and waits for the agent's report, just as graceful uninstall does.
- Test: `services/networkIsolation/lifecycleRefusals.test.ts`.

- [ ] **Step 1: Write the failing test.**
  - All six operations refuse while an episode is unresolved, and proceed once it has been released or acknowledged.
  - A static check fails if `routes/incidents.ts` gains a `.delete(` without the assert.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, plus `moveOrg.coverage.test.ts`, `cascadeDelete.test.ts` and the **full** unit suite for `orgMerge.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Sweeper, alerts and events

**Files:**
- Create `jobs/networkIsolationSweeper.ts`, following the `approvalExpiryReaper.ts` pattern.
- Register it in `services/workerRegistry.ts:1387` and `jobs/workerReadinessManifest.ts`, and classify it in `parkedFanout.contract.test.ts`.
- `services/eventBus.ts:63,634`: add `device.isolated`, `device.isolation_released`, `device.isolation_failed`, `device.isolation_self_released` and `device.isolation_expiring`.
- `services/alertService.ts:442`: add `'network_isolation'` to the `createSourcedAlert` source union if that union is closed.
- Test: `jobs/networkIsolationSweeper.test.ts`.

**Interfaces:** `sweepNetworkIsolations(now: Date): Promise<{ warned: number; notDelivered: number }>`.

- [ ] **Step 1: Write the failing test.**
  - **Expiring-soon warning.** Applies to `verified` episodes with ≤ 12 h left and `expiry_warned_at` null. The sweeper sends one event and one sourced alert to the requester and to the incident owner, then sets `expiry_warned_at`.
  - **Undelivered episodes.** An episode is marked `failed:not_delivered` only when all of these hold:
    - it never reached `applying`;
    - `last_journal_seq = 0`;
    - now > `expires_at + 30 min`.

    The release tombstone stays until it is confirmed.
  - **No inferred releases.** The sweeper never sets `released` or `expired` (§3.1 item 8).
  - **Alerts on transitions.** Each transition into `failed`, `self_released` or `released_locally:*` creates exactly one alert.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** with `withSystemDbAccessContext` and `createSourcedAlert({context:{source:'network_isolation'}})`.
- [ ] **Step 4: Run it, plus `workerEntrypointClosure.contract.test.ts` and `parkedFanout.contract.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W1d — Agent core (pure; fake isolator)

**Owns:** everything under `agent/internal/isolation/` except `wfp/`, `isolator_*.go` and `scheduler_*.go` (only the unsupported stub is in scope), plus `agent/internal/wire/errorcodes.go` and its pin test.

### Task 1: Types, journal and lock, and the state machine

**Files:**
- Create in `agent/internal/isolation/`: `types.go`, `statemachine.go`, `clock.go`, `journal/journal.go`, `journal/lock_{unix,windows}.go` and `journal/acl_{unix,windows}.go`.
- Modify `agent/internal/wire/errorcodes.go:22`, adding the codes **and** their `AllCommandErrorCodes` entries.
- In the same PR, modify `apps/api/src/routes/agents/schemas.ts:601` (`AGENT_COMMAND_ERROR_CODES`). The Go pin `TestCommandErrorCodesMatchServerSchema` (`agent/internal/wire/errorcodes_test.go:20-36`) regex-parses that list, and `schemas.commandResult.test.ts` checks the reverse direction, so both sides must change together.
- Tests: `statemachine_test.go`, `statemachine_fuzz_test.go` (pattern: `agent/internal/pamlifetime/state_machine_fuzz_test.go`), `clock_test.go`, `journal/journal_test.go` and `breakglass_vectors_test.go`.

**Interfaces:**
- `Step(cur LocalState, ev Event, c Clock) (LocalState, []Effect)`.
- `Effect` is one of `ArmProvisional`, `ApplyRules`, `RunProbes`, `Commit`, `Rollback`, `ReleaseRules`, `ConfirmAbsent`, `DisarmProvisional`, `ArmExpiry` and `Report`.
- `Expired(j *Journal, c Clock) (bool, reason string)` implements the Global Constraints clock rule.

- [ ] **Step 1: Write the failing tests.**
  - Every local transition is covered.
  - All three clock-rule clauses, including `highWaterWall` across a simulated reboot (new `BootID`).
  - A provisional apply past its deadline rolls back.
  - A stale generation returns `isolation_stale_generation`.
  - Journal round-trip, 0600 mode and the lock exclusion.
  - Corrupt journal: unknown schema or truncated → the manager deletes every owned rule.
  - Fuzz invariants, all of which must hold:
    - `committed` is never reached without `RunProbes` succeeding;
    - `ApplyRules` always leaves a pending `Rollback` or `Commit`;
    - `released` is never reported without `ConfirmAbsent` succeeding.
- [ ] **Step 2: Run it.** `cd agent && go test -race ./internal/isolation/... ./internal/wire/...`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `atomicrename.Replace`. Never touch `agent.state`.
- [ ] **Step 4: Run the tests, then `go test -fuzz=FuzzStep -fuzztime=60s ./internal/isolation/`.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: Resolver, probes, break-glass and the fenced Manager

**Files:**
- Create in `agent/internal/isolation/`: `resolve.go`, `probe.go`, `breakglass.go`, `manager.go`, and `isolator_unsupported.go` (build tag `!windows && !linux && !darwin` plus per-OS stubs that return capability 0 until W1f/W2/W3).
- Tests: `resolve_test.go`, `probe_test.go`, `breakglass_test.go`, `manager_test.go`, `manager_crash_test.go` and `manager_fence_test.go`.

**Interfaces:**
- `NewManager(deps ManagerDeps) *Manager`, where `ManagerDeps{ Isolator; Scheduler RecoveryScheduler; DataDir string; Resolver; VerifyRoundTrip func(ctx, isolationID string) (serverTime time.Time, err error); Clock; Dialer; Proxy func() (*url.URL, error) }`.
  - `Scheduler.Ready()` reports recovery readiness.
  - `Proxy` is the transport's effective proxy (`http.ProxyFromEnvironment`, as at `heartbeat.go:1131`).
- `Manager` methods:
  - `HandleIsolate(ctx, payload map[string]any) tools.CommandResult`
  - `HandleRelease(ctx, payload) tools.CommandResult`
  - `Reconcile(ctx, desired *DesiredBlock)`
  - `Report() *Report`
  - `Tick(ctx)`
  - `OnNetworkChange(ctx)`
  - `OnResume(ctx)`
  - `Active() bool`
  - `LocalRelease(ctx, code string, force bool) error`
  - `Startup(ctx)`
- `Resolver.Resolve(ctx, hosts) (map[string][]netip.Addr, error)` keeps up to 16 last-known-good addresses per host and never drops a working one on a failure.

**Apply order.** This is the order the quorum checked (§Advisor quorum, Q2):
1. Take the lock and assign a fresh `attemptId`.
2. Reject a stale, terminal or already-expired spec.
3. Preflight: capability ready, recovery ready (`self-test` passed, tasks registered and read back), journal writable, every allowlist entry resolves on **both** families where the host has both.
4. Journal `provisional{attemptId, deadline = now+90s, expiresAt, secret}` and fsync.
5. `ArmProvisional(attemptId, deadline)` and read it back, then `ArmExpiry(expiresAt)`.
6. Re-check the deadline.
7. `Apply`, release the lock, run both probes within 60 s.
8. Retake the lock and re-check `attemptId`, the deadline and `Verify` digest.
9. Journal `committed` and fsync, then `DisarmProvisional(attemptId)`, then report `verified`.

**Failure and release paths.**
- **Probe failure:** journal `releasing` → `Release` → `Owned()` is false (`ConfirmAbsent`) → journal `rolled_back` → disarm → report `failed:<code>`.
- **Cleanup failure:** recovery stays armed, and the episode stays unresolved.
- **Release:** lock → journal `releasing{generation}` → `Release` → `ConfirmAbsent` → journal `released` plus a `PendingReport` receipt → `RemoveAll` → report.
- A `releasing` journal is retried immediately by `Startup` and by recovery.

**Desired episode differs from the journal.** If the desired block names a different `isolationId` than the journal holds, release the journalled one (kind `system`) before applying the new one.

- [ ] **Step 1: Write the failing tests.** These use a fake isolator, scheduler and clock.
  - **Order.** The exact effect order above holds. If arming fails, `Apply` is never called and the result is `mechanism_unavailable`. If recovery is not ready, the result is `mechanism_unavailable`.
  - **Negative probe.** It passes only when `DropObserved(since)` is true and the connect timed out locally within 3 s. A connect, an RST, or a timeout without an observed drop all fail.
  - **Crash injection.** `manager_crash_test.go` restarts at every effect index of apply, release, extend and refresh. After `Startup`, `Tick` and the deadline, the end state is verified-isolated or confirmed-absent.
  - **Fencing.** In `manager_fence_test.go`, a worker whose attempt was rolled back by "recovery" (the test holds the lock) cannot commit. An old expiry arm for generation N does not release generation N+1.
  - **Break-glass.** Buckets −1, 0 and +1 are accepted. The 6th attempt in an hour is refused. `--force` records `released_locally:forced`.
  - **Generations.** `Reconcile` with a newer released generation releases. With an older generation it does nothing.
  - **Capability.** Capability 0 returns `unsupported_platform` before touching anything.
  - **Proxy** (spec §3.4 baseline row). When `Proxy()` returns a URL for the control-plane host, `ResolvedSpec` gains a `scope:"breeze"` entry for the proxy host and port, and the control-plane permit stays. A proxy that does not resolve fails preflight with `mechanism_unavailable`. Every isolator's golden test (W1f Task 2, W2 Task 3, W3 Task 2) includes a proxy fixture: Breeze-process scope on Windows and Linux, destination-only on macOS.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The positive probe uses a new `http.Transport` with `DisableKeepAlives`, so it is a fresh TLS session. The server time it returns updates `HighWaterWall`.
- [ ] **Step 4: Run them with `-race`.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W1e — Agent wiring

**Owns:** `agent/internal/heartbeat/{containment.go, handlers_containment.go}`, the `containment` CLI and `agent/cmd/breeze-isolation-recovery/`, plus the edits listed in Task 1.

### Task 1: Heartbeat wiring, strict handlers, CLI, updater gate and the recovery skeleton

**Files:**
- Modify `agent/internal/heartbeat/heartbeat.go`:
  - `:266` `SecurityCapabilities`: add `NetworkIsolationVersion`, `NetworkIsolationMechanism`, `NetworkIsolationUnsupportedReason` and `NetworkIsolationReady`.
  - `:201`: add the request field `Containment *ContainmentReport`.
  - `:349` `HeartbeatResponse`: add `Containment *ContainmentDesired \`json:"containment"\``.
- Create `heartbeat/containment.go`. It builds the Manager, calls `Reconcile` on the response, attaches `Report` to the request, and drives `Tick`, resume and network change.
- Modify `agent/internal/heartbeat/handlers_incident_response.go:16`. For `network_isolation`, call `h.isolation.HandleIsolate`. Every other action keeps `tools.ExecuteContainment`.
- Change `incident_response.go:189`. The `network_isolation` case there returns `isolation_invalid_spec` ("dispatched outside the isolation manager"), so the tools path can never isolate.
- Create `handlers_containment.go` (`release_containment`). Modify `remote/tools/types.go:277` to add `CmdReleaseContainment`, and `handlers_test.go:142`.
- Modify `agent/internal/privilege/check.go:7`: add `execute_containment` and `release_containment` to `elevatedCommandTypes`. Neither is there today.
- Modify `agent/internal/agentapp/main.go`. Add a `containment` cobra group with the subcommands `status`, `release --code <c> | --force`, `boot-apply` and `expire-check`.
- Modify `agent/internal/updater/updater.go:1515` and `pkg_source.go:~34`. While `isolation.Active()`, refuse any artifact URL, or any redirect hop, whose host is not the control-plane host, with `ErrUpdateBlockedByIsolation`. Never start a self-update that has not been staged and verified.
- Create `agent/cmd/breeze-isolation-recovery/main.go` with these subcommands:
  - `self-test`
  - `expire-check --data-dir`
  - `rollback-if-uncommitted --data-dir --attempt <id>`
  - `release-all --data-dir --reason`
  - `boot-apply --data-dir`
  - `--version`
- Tests: `heartbeat/containment_test.go`, `heartbeat/handlers_containment_test.go`, `privilege/check_test.go`, `agentapp/containment_cmd_test.go`, `updater/isolation_gate_test.go` and `cmd/breeze-isolation-recovery/deps_test.go`. The last asserts that `go list -deps` contains none of `internal/heartbeat`, `internal/config` or `internal/updater`.

**Strict payload validation.** `HandleIsolate` refuses with `isolation_invalid_spec` unless all of these hold:
- `isolationId` is a UUID;
- `generation ≥ 1`;
- `now < expiresAt ≤ now + 720 h`;
- `allow` is non-empty and contains a `scope:"breeze"` entry for the agent's own server host;
- the top-level `breakGlassSecret` base64-decodes to 32 bytes;
- no entry has `scope:"any"` unless the payload also carries `policyRevision` (W4a).

- [ ] **Step 1: Write the failing tests.**
  - The heartbeat sends `networkIsolationVersion: 0` and `ready: false` on every OS in W1e.
  - A response with no `containment` key changes nothing (old API).
  - `{networkIsolation:null}` with no journal is a no-op, and the agent reports `{phase:'none'}`.
  - Every validation-rule violation is refused.
  - The tools path refuses `network_isolation`.
  - `release_containment` with a mismatched id returns `isolation_episode_mismatch`.
  - `elevatedCommandTypes` contains both commands.
  - The updater refuses off-host URLs and off-host redirects while active.
  - `deps_test.go` passes.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/... ./internal/isolation/... ./internal/updater/... ./internal/agentapp/... ./internal/privilege/... ./cmd/breeze-isolation-recovery/...`, then `GOOS=windows go vet ./...` and `GOOS=darwin go vet ./...`. Expected: PASS.
- [ ] **Step 5: Commit.**

**W1e CI traps:**
- `agent/tools/agentsim/sim/payloads.go:60` uses `CompiledSecurityCapabilities()`, so keep it compiling.
- Run Go lint for `GOOS=windows`.
- The wire error codes and the server list change together in W1d Task 1. Never split them across PRs.

---

## W1f — Windows WFP

**Owns:** `agent/internal/isolation/wfp/**`, `isolator_windows.go`, `rules_windows.go` and `scheduler_windows.go`.

### Task 1: Minimal WFP binding (Gate B decision 2)

**Files:**
- Create in `agent/internal/isolation/wfp/`: `api_windows.go`, `types_windows.go`, `guids.go` (no build tag) and `session_windows.go`.
- Tests: `wfp/marshal_windows_test.go`, and `wfp/api_windows_test.go`, which is elevated and opt-in (`BREEZE_WFP_TEST=1`).

**Interfaces:**
- `guids.go`:
  - `ProviderKey`
  - `SublayerKey`
  - `FilterKey(ruleID string) windows.GUID`, built with `uuid.NewSHA1` over a fixed namespace
  - `ProviderName = "Breeze Network Isolation"`
- `OpenSession() (*Session, error)` opens a non-dynamic session.
- `(*Session).Tx(func(*Tx) error) error`.
- `(*Tx).AddProvider(persistent bool)`. The provider sets **no** `serviceName`: BFE disables provider-associated filters at startup when the associated service is not auto-start.
- `(*Tx).AddSublayer(weight uint16, persistent bool)`.
- `(*Tx).AddFilter(Filter) (uint64, error)`.
- `(*Tx).DeleteOwned() error` deletes every filter in our sublayer, then the sublayer and the provider. Boot-time filters are deleted by key.
- `(*Session).EnumOwned() ([]FilterInfo, error)`.
- `SubscribeClassifyDrops(filterIDs []uint64) (<-chan DropEvent, func(), error)`.
- `AppIDFromPath(path string) ([]byte, error)`.

- [ ] **Step 1: Write the failing tests.**
  - Marshalling golden tests for `FWPM_FILTER0` with the `ALE_APP_ID`, `IP_REMOTE_ADDRESS`, `IP_REMOTE_PORT` and `IP_PROTOCOL` conditions.
  - The provider struct has an empty `serviceName`.
  - Persistent and boot-time flags never appear on the same filter.
  - Elevated test: `DeleteOwned` touches only our objects.
- [ ] **Step 2: Run them on the Windows runner.** Expected: FAIL.
- [ ] **Step 3: Implement** on `golang.org/x/sys/windows` `NewLazySystemDLL("fwpuclnt.dll")`.
  - `inet.af/wf` (BSD-3-Clause) is a reference only.
  - Any adapted code keeps its licence header and goes into the third-party notices.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: WFP isolator

**Files:**
- Create `isolator_windows.go` (replaces the stub) and `rules_windows.go`.
- Tests: `rules_windows_test.go` (golden) and `isolator_windows_integration_test.go` (elevated, opt-in).

**Interfaces:**
- `newWindowsIsolator(bins func() []string) Isolator`. The binaries are `breeze-agent.exe`, `breeze-watchdog.exe`, `breeze-desktop-helper.exe`, `breeze-user-helper.exe` and `breeze-backup.exe`, taken from `agent/internal/serviceinstall/paths.go`.
- `buildWindowsRules(rs ResolvedSpec, bins []string, prevBins []string, baseline Baseline) []wfp.Filter` is pure. `prevBins` is non-empty only during an upgrade handoff (W1g Task 3).

- [ ] **Step 1: Write the failing golden test.** The expected rule set:

  | Rule set | Content |
  |---|---|
  | Persistent permits | on `ALE_AUTH_CONNECT_V4/V6` and `ALE_AUTH_RECV_ACCEPT_V4/V6`, one per binary × address × port, each with app id **and** destination/port conditions |
  | Baseline | the spec §3.4 table: loopback, DHCP, DNS to the currently configured resolvers only, ICMPv6 types 2 and 130–137, ICMPv4 type 3 code 4 |
  | Block-all | persistent, at a lower weight |
  | Boot-time | a separate set of boot-time filters: block-all plus the destination baseline, with no app conditions |
  | `scope:"breeze"` | never produces a destination-only permit |
  | `scope:"any"` | destination-only, and empty until W4a |
  | Sublayer | weight above the Windows Firewall sublayer |

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `Apply` is one transaction. Afterwards, IPv4 TCP flows that are not permitted are torn down with `SetTcpEntry(MIB_TCP_STATE_DELETE_TCB)`; IPv6 relies on ALE re-authorisation.
  - `Verify` is the `EnumOwned` digest.
  - `Release` is `DeleteOwned`.
  - `Owned` is `len(EnumOwned) > 0`.
  - `Mark`/`DropObserved` subscribe to classify-drop events on the block filter id. If net-event collection is off, enable `FWPM_ENGINE_COLLECT_NET_EVENTS` for the probe window, then restore it. If the subscription fails, the probe fails as `enforcement_not_observed`.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Windows recovery scheduler

**Files:** `scheduler_windows.go`, with the test `scheduler_windows_test.go` (golden XML).

**Interfaces:**
- The tasks live under the `\Breeze\` folder and all run as SYSTEM.
- `IsolationRollback-<attemptId>` is one-shot: a `TimeTrigger` at the deadline that runs `rollback-if-uncommitted --attempt`.
- `IsolationExpireAt` is a one-shot trigger at `expiresAt`. It is re-armed on every extend, and an expiry check is a no-op when the journal's `expiresAt` is later.
- `IsolationPoll` repeats every 15 min, has a `BootTrigger`, and runs `expire-check`.
- Each task's action is the journal's `RecoveryPath`.
- Tasks are registered with `schtasks /Create /XML … /F` and read back with `/Query /XML`.
- `Ready()` confirms that the poll task exists and points at an existing, signed recovery exe.

- [ ] **Step 1: Write the failing golden test.**
  - SYSTEM principal, `HighestAvailable`, `StartWhenAvailable`, `DisallowStartIfOnBatteries=false`, `StopIfGoingOnBatteries=false` and a 2-minute `ExecutionTimeLimit`.
  - The tests assume `StartWhenAvailable` may run a missed task up to 10 minutes late, which is why the one-shot `ExpireAt` trigger is the primary path and the 15-minute poll is the backstop.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W1g — Windows recovery and activation

**Owns:** `agent/internal/isolation/recoveryinstall/**`, `agent/installer/breeze.wxs` and `build-msi.ps1` edits, the `.github/workflows/release.yml` edits, the Windows branch of `handlers_uninstall.go`, and the Windows capability switch.

### Task 1: Recovery binary behaviour on Windows

**Files:** `agent/cmd/breeze-isolation-recovery/main_windows.go`, with tests `recovery_crash_test.go` and `recovery_test.go`.

- [ ] **Step 1: Write the failing tests.**
  - `expire-check` releases when `Expired()` is true or the phase is `releasing`, and it advances `HighWaterWall`.
  - `rollback-if-uncommitted --attempt X` acts only when `phase=provisional` and `AttemptID=X` under the lock. It is a no-op once the phase is committed or the attempt has moved on.
  - `boot-apply` cleans an unfinished provisional apply, `releasing`, expiry or a clock-invalid state. It never promotes a provisional apply to committed because filters exist.
  - Owned rules with a missing, corrupt or unknown-schema journal → `release-all` with kind `system`, and the receipt is kept for the next report.
  - Any cleanup failure leaves the tasks armed and exits non-zero.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: Recovery distribution (Gate B decision 3)

**Files:**
- Modify `agent/internal/updater/updater.go:~623`: add the component case `"isolation-recovery"` with the asset `breeze-isolation-recovery-<os>-<arch>[.exe]`.
- Create `agent/internal/isolation/recoveryinstall/{install.go, install_windows.go}`.
- Modify `agent/Makefile` (`build-isolation-recovery[-windows]`), `.github/workflows/release.yml` (build, Authenticode-sign, add to the signed manifest) and `agent/installer/build-msi.ps1` and `breeze.wxs` (bundle into `[INSTALLDIR]isolation-recovery\<version>\`).
- Test: `recoveryinstall/install_test.go`.

**Interfaces:**
- `EnsureRecovery(ctx, wantVersion string) (path string, err error)`. It runs at agent start and before every apply, and goes through these steps:
  1. Download through the updater component path, whose signed-manifest verification applies; skip this step if the version is already present.
  2. Install side by side into `…\isolation-recovery\<version>\`. Never overwrite an existing file, and never use the overwrite-in-place companion swap (`restart_windows.go:240`).
  3. Verify the Authenticode signature.
  4. Run `self-test`, which must exit 0 within 10 s.
  5. Only then repoint the tasks.
- **While an episode is unresolved**, the task actions stay pinned to the journal's `RecoveryPath`. A new version is staged and adopted only when the episode is idle. Tasks are repointed one at a time, and both versions must be compatible with the current journal schema.
- Remove an old version only when no task and no process references it.

- [ ] **Step 1: Write the failing tests.**
  - When a download fails its signature or `self-test`, nothing changes.
  - No task is repointed while an episode is active.
  - Every task always points at an existing file.
  - An agent that was updated by raw swap with no MSI still gets a recovery binary.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Uninstall, MSI and upgrade handoff

**Files:**
- Modify `agent/internal/heartbeat/handlers_uninstall.go:76`. The release runs **before** `prepareSelfUninstallFn`. If confirming that the rules are gone fails, the uninstall is refused and teardown does not start.
- In the same file, modify `:415,449` so the Windows script runs `release-all --reason uninstall` first.
- Modify `breeze.wxs`:
  - Add a deferred custom action `IsolationReleaseOnUninstall`, scheduled `Before="RemoveFiles"` with condition `REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE`, mirroring `:848`. An MSI upgrade must never un-isolate.
  - If the action fails, the uninstall fails.
- Modify `isolation/manager.go` `Startup` and the updater pre-swap hook:
  - When the binary set changes, apply the permits for **both** the old and the new paths (`prevBins`) before the swap.
  - The new agent re-reads the journal and re-verifies, then drops the old paths.
  - Refuse an upgrade whose journal schema is incompatible while the device is isolated.
- Tests: `handlers_uninstall_windows_test.go`, `breeze_wxs_test.go` (XML assertions) and `manager_upgrade_test.go`.

- [ ] **Step 1: Write the failing tests.**
  - Release runs before `prepareSelfUninstallFn`, and a failed release aborts the uninstall.
  - The custom-action condition and sequence are as specified.
  - Dual-path permits are present across a simulated swap.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: Windows capability on, and the version gate pinned

**Files:**
- `isolator_windows.go`: report `Capability{Version:1, Mechanism:"wfp", Ready}`. `Ready` is true only when `FwpmEngineOpen0` succeeds **and** `EnsureRecovery` has succeeded **and** `Scheduler.Ready()`. Report `Version:0` with an `UnsupportedReason` otherwise.
- `packages/shared/src/utils/networkIsolation.ts`: pin `NETWORK_ISOLATION_MIN_AGENT_VERSION` to the agent release carrying this PR. If that number is unknown at merge, keep `'999.0.0'`, pin it in the release PR, and say which you did in the PR body.
- The server's start eligibility also requires `networkIsolationReady === true`.
- Tests: `isolator_windows_capability_test.go`, `packages/shared/src/utils/networkIsolation.pin.test.ts`, and `service.start.test.ts` (extended).

- [ ] **Step 1: Write the failing tests.**
  - With fakes, the capability is `{Version:0, Ready:false}` with a named `UnsupportedReason` in each of three cases:
    - `FwpmEngineOpen0` returns an error (`bfe_unavailable`);
    - `EnsureRecovery` fails (`recovery_unavailable`);
    - `Scheduler.Ready()` is false (`scheduler_unavailable`).
  - It is `{Version:1, Mechanism:"wfp", Ready:true}` only when all three succeed.
  - The pin test checks that the gate is a valid semver and is either `'999.0.0'` or below it.
  - The server refuses start with `agent_unsupported` when `networkIsolationReady` is false, even if version ≥ 1.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/isolation/...` (Windows runner) and the shared and API tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `go test -race ./...` on Windows CI (`test-agent`), plus the shared tests.** Expected: PASS.
- [ ] **Step 5: Commit.**

**W1f/W1g CI traps:**
- Windows CI skips `internal/userhelper`.
- The WFP and integration tests are opt-in. **Never** run them on a host that has the installed agent.
- PR CI cannot exercise the release-workflow and signing changes. Add "recovery asset present, signed, in the manifest" to the release checklist.
- `scripts/security/check-supply-chain-hardening.sh` covers new release assets.

**L1 Windows lab leg (Todd gate, before activation).**
- Where: disposable Windows 11 and Server 2022 VMs, release binaries, the lab partner only (`NETWORK_ISOLATION_ENABLED=true` and `NETWORK_ISOLATION_ENABLED_PARTNER_IDS=<lab partner>`).
- What: the spec §7 Windows row, every Windows-applicable item in the All row, and the negative-probe attribution row.
- Plus these items:
  - remote desktop under isolation, relay-only (W1i);
  - the console release path, including while the device is offline (queued);
  - an agent updated by raw swap gets a recovery binary;
  - an MSI upgrade does not un-isolate;
  - the one-shot `ExpireAt` task fires while the agent service is stopped;
  - a clock rollback across a reboot is treated as expired.
- The full checklist is copied into the W1g PR body.

---

## W1h — Console and docs

**Owns:** `apps/web/src/components/devices/networkIsolation/**`, the docs page and locale files.

### Task 1: Device actions, dialogs and the eligibility split

**Files:**
- Modify `apps/web/src/components/devices/DeviceActions.tsx` (1 389 lines) to add the menu items only.
- Create `apps/web/src/components/devices/networkIsolation/{isolationEligibility.ts, IsolateDialog.tsx, ReleaseDialog.tsx}`.
- Tests: `isolationEligibility.test.ts` and `DeviceActions.isolation.test.tsx`.

**Interfaces:**
- `startEligibility(listResponse): { enabled; reason?: StartBlockReason }` is driven by the server's `startEligibility`.
- `releaseEligibility(episode): { visible; label: 'release'|'release_queued' }`. It takes **no** flag, version, capability, trust or incident input.

- [ ] **Step 1: Write the failing tests.**
  - Start is disabled, with a reason, for each refusal.
  - Release is visible and enabled in every one of those cases. When the device is offline, the label is "Release (queued until the device reconnects)".
  - The dialog shows a server-OS warning.
  - TTL is 72 h by default, capped at 720 h.
  - Submit goes through `runAction`.
- [ ] **Step 2: Run** `pnpm --filter @breeze/web exec vitest run src/components/devices/networkIsolation`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, plus `no-silent-mutations.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: Badge, code view, acknowledge, incident detail and list filter

**Files:**
- Create `networkIsolation/{IsolationBadge.tsx, BreakGlassCodePopover.tsx}`.
- Modify `DeviceDetails.tsx` (the header), `components/incidents/IncidentDetailPage.tsx` and `components/devices/filterFields.ts`.
- Add an API list filter, "Isolated", implemented as EXISTS on the partial index, in the device list route.
- Tests: `IsolationBadge.test.tsx`, `BreakGlassCodePopover.test.tsx`, `IncidentDetailPage.isolation.test.tsx` and the list filter route test.

- [ ] **Step 1: Write the failing tests.**
  - The badge shows "Isolated · expires in …" and the applying and verifying states.
  - The code appears only after a click, and the click calls the audited GET.
  - Acknowledge appears only for `released_locally` and `self_released`.
  - The incident page shows the live state and a release button.
  - The filter returns only devices that have an unresolved episode.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: Locales and docs

**Files:**
- Locales: all 8 locale files and `humanizedKeyBaseline.json`.
- `incident-response.mdx:136,253`: replace the platform-error sentences, and say that `/contain` is record-keeping only.
- `ai.mdx`: the `execute_containment` row now isolates. `release_containment` is marked "later release" until W4b.
- Also update `docs/security/SECURITY_PRACTICES.md:463` and `docs/guides/ADMIN_GUIDE.md:1421`.
- Create `apps/docs/src/content/docs/features/network-isolation.mdx`, and add it to the sidebar in `apps/docs/astro.config.mjs:97`. The page covers:
  - what stays reachable;
  - the mechanism on each OS;
  - the residual risks (spec §3.4);
  - the break-glass runbook: read the code to the user, run `breeze-agent containment release --code`, and note that `--force` raises an alert;
  - that a 2FA-disabled self-host gets password-only assurance;
  - that a self-host without TURN loses remote desktop while isolated;
  - that isolation is Windows-only until W2 and W3 ship;
  - the emergency fleet un-isolate procedure: a scripted per-episode console release, never a flag.
- Tests: `localeParity.test.ts`, `humanizedKeyRegression.test.ts` and `aiGuardrailsAiDocs.parity.test.ts`.

- [ ] **Step 1: Add the en keys only, then run parity.** Expected: FAIL.
- [ ] **Step 2: Add the other 7 locales and the docs.**
- [ ] **Step 3: Run the tests.** Expected: PASS.
- [ ] **Step 4: Commit.**

---

## W1i — Relay-only remote desktop while isolated (OD9)

**Owns:** the edits below.

### Task 1: Signal `relayOnly` end to end

**Files:**
- `apps/api/src/routes/desktopWs.ts:1852,2070`: when the device has an active (`applied` or `verified`) episode, the session offer carries `relayOnly: true` and leaves out the STUN entries from `getIceServers` (`routes/remote/helpers.ts:68`).
- `agent/internal/ipc/message.go:453`: add the `RelayOnly` field.
- `agent/internal/userhelper/desktop.go:49-96`: pass `RelayOnly` through.
- `agent/internal/remote/desktop/session_webrtc.go:75`: set `ICETransportPolicy: webrtc.ICETransportPolicyRelay` when `relayOnly`.
- `apps/viewer/src/lib/webrtc.ts:202`: set `iceTransportPolicy: relayOnly ? 'relay' : 'all'`. At `:250-265`, **no** STUN-only retry when `relayOnly`; show the message "Remote desktop needs the TURN relay while this device is isolated".
- Tests: `desktopWs.relayOnly.test.ts`, `session_webrtc_test.go`, a `userhelper` passthrough test and `apps/viewer/src/lib/webrtc.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - The offer carries `relayOnly` and no STUN entries.
  - Pion's policy is relay.
  - The viewer uses relay and never retries STUN-only while isolated.
  - A non-isolated session is unchanged.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W2 — Linux (nftables + cgroup split, OD11/OD14)

**Owns:** `isolator_linux.go`, `rules_linux.go`, `scheduler_linux.go`, `agent/internal/isolation/cgroup/**`, `agent/internal/procspawn/**`, `agent/service/systemd/*`, `agent/scripts/install/{install-linux.sh,uninstall.sh}`, `apps/web/public/scripts/uninstall.sh`, and the Linux branch of `handlers_uninstall.go`.

### Task 1: Cgroup split

**Files:**
- Create `cgroup/{cgroup_linux.go, cgroup_other.go}`.
- Add `Delegate=yes` to `agent/service/systemd/breeze-agent.service`, and keep the "INTENTIONALLY UNSANDBOXED" comment.
- Test: `cgroup_linux_test.go`, against a fake tree.

**Interfaces:**
- `SetupSelf() (Layout, error)`:
  - read `/proc/self/cgroup`;
  - create `<unit>/agent` and `<unit>/children`;
  - move every agent thread into `agent`.
- It returns `Layout{AgentPath, ChildrenPath string; Level int; ChildrenFD int}`.

- [ ] **Step 1: Write the failing tests.**
  - Path and level are derived from `/proc/self/cgroup`.
  - cgroup v1 or hybrid → `mechanism_unavailable`.
  - Missing `Delegate` (EACCES) → `mechanism_unavailable` with "agent unit lacks Delegate=yes (reinstall the agent)".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: Every child spawns into `…/children` before exec

**Files:**
- Create `agent/internal/procspawn/{procspawn.go, procspawn_linux.go, procspawn_other.go}`.
- Convert every non-test spawn site. List them at dispatch with `rg -n 'exec\.Command(Context)?\(|os\.StartProcess\(|pty\.Start' agent/internal agent/cmd`. At plan time the sites were in: executor, terminal pty, helper manager, sessionbroker, pamactuator, remote/tools, collectors, patching, monitoring, security, syscleanup, peripheral, mgmtdetect and backup.
- Test: `procspawn/spawn_contract_test.go` (a `go/ast` scan).

**Interfaces:**
- `procspawn.Command(ctx, name, args...) *exec.Cmd` and `procspawn.Prepare(cmd) *exec.Cmd`.
- On Linux these set `SysProcAttr.UseCgroupFD=true` and `CgroupFD=Layout.ChildrenFD`. That uses clone3 `CLONE_INTO_CGROUP`, so the child is placed before exec.
- On other platforms they are a no-op.
- The agent's own re-exec (restart, updater) carries `//procspawn:exempt <reason>`.

- [ ] **Step 1: Write the failing contract test.** Every spawn call is either a `procspawn.*` call or carries the exempt marker. On Linux, a spawned child's `/proc/<pid>/cgroup` is under `children`.
- [ ] **Step 2: Run it.** Expected: FAIL, listing every site.
- [ ] **Step 3: Convert the sites in per-subsystem batches.** The edits are mechanical, so a Sonnet subagent can do each batch from an exact file list. One commit per batch.
- [ ] **Step 4: Run the test, then `go test -race ./...` on Linux, then `GOOS=windows` and `GOOS=darwin` `go vet`.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: nft isolator

**Files:**
- Create `isolator_linux.go` and `rules_linux.go`.
- Tests: `rules_linux_test.go` (golden `nft -f`) and `isolator_linux_test.go` (fake runner).

**Interfaces:** `buildNftRuleset(rs ResolvedSpec, layout cgroup.Layout, baseline Baseline) string`, a pure function.

- [ ] **Step 1: Write the failing golden test.**
  - **Table and chains.** `table inet breeze_isolation` with `input`, `output` and `forward` chains at `priority filter - 10`, each `policy drop`.
  - **Breeze permits.** `socket cgroupv2 level <n> "<AgentPath>"` combined with the destination and port for `scope:"breeze"`.
  - **Connection tracking.** `ct mark set 0x42424242` on new permitted flows, and `ct state established,related ct mark 0x42424242 accept`. There is no blanket rule that accepts every established flow.
  - **Baseline and drop counter.** The baseline from spec §3.4, and a named counter `breeze_drop`.
  - **Preflight.** If `nft` is missing, return `mechanism_unavailable` and leave the host untouched.
  - **Apply.** One `nft -f -` batch, then `conntrack -D` for unmarked flows. If `conntrack` is missing, journal `conntrack_unavailable`; the lab confirms the effect on flowtable-offloaded flows.
  - **Verify, release and drop observation.**
    - `Verify` is the digest of `nft -j list table`.
    - `DropObserved` is the delta of the `breeze_drop` counter.
    - `Release` is `nft delete table inet breeze_isolation`.
    - `Owned` reports whether the table exists.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: Scheduler, boot hook, recovery and scripts

**Files:**
- `scheduler_linux.go`.
- `agent/service/systemd/breeze-isolation.service`: a oneshot with `Before=network-pre.target` and `Wants=network-pre.target`, whose `ExecStart` runs `<recovery> boot-apply`.
- `breeze-isolation-poll.{service,timer}`: `OnBootSec=1min`, `OnUnitActiveSec=15min`.
- The two one-shots are `systemd-run --unit=breeze-isolation-rollback-<attempt> --on-active=90s …` and `systemd-run --unit=breeze-isolation-expire --on-calendar=<expiresAt> …`.
- `recoveryinstall/install_linux.go`, the updater asset for Linux, and `install-linux.sh`, which installs the recovery binary side by side.
- `uninstall.sh`, `apps/web/public/scripts/uninstall.sh` and `handlers_uninstall.go:295,314`: each releases first.
- Tests: `scheduler_linux_test.go` (unit-file golden), `handlers_uninstall_linux_test.go`, `recoveryinstall/install_linux_test.go`, and shellcheck in Lint.

- [ ] **Step 1: Write the failing tests.**
  - The unit files match golden files exactly:
    - the oneshot has both `Before=network-pre.target` and `Wants=network-pre.target`;
    - the timer has `OnBootSec=1min` and `OnUnitActiveSec=15min`.
  - The `ArmProvisional` argv is `systemd-run --unit=breeze-isolation-rollback-<attempt> --on-active=90s <recovery> rollback-if-uncommitted --data-dir <d> --attempt <attempt>`.
  - `ArmExpiry` uses `--on-calendar` with `expiresAt` in UTC.
  - `RemoveAll` stops and removes all of them.
  - `buildLinuxUninstallScript` runs `release-all --reason uninstall` before any `systemctl disable` or `rm`, and aborts if release-all exits non-zero.
  - `uninstall.sh` (both copies) does the same.
  - `install-linux.sh` installs the recovery binary into a versioned directory and never overwrites an existing one.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/isolation/... ./internal/heartbeat/...` on Linux, plus Lint. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 5: Linux capability on

**Files:** `isolator_linux.go` (`Capability`) and the docs page's platform table. Test: `isolator_linux_capability_test.go`.

- [ ] **Step 1: Write the failing test.** Each failing condition yields `{Version:0, Ready:false}` with its named reason:
  - `nft` missing → `nft_missing`;
  - cgroup v1 → `cgroup_v1`;
  - no `Delegate` → `cgroup_not_delegated`;
  - recovery missing → `recovery_unavailable`;
  - scheduler not ready → `scheduler_unavailable`.

  Only when all five hold is the result `{Version:1, Mechanism:"nft", Ready:true}`. Do not add a per-OS version gate: the capability already carries the per-OS truth.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it, and update the docs table.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

**L2 Linux lab leg (Todd gate).**
- Covers the spec §7 Linux row and the Linux items in the All row.
- Runs on Ubuntu 24.04 with ufw and on Rocky 9 with firewalld.
- Also check remote desktop under isolation, and record where the Linux WebRTC peer runs. `breeze-agent-user.service` has `PrivateNetwork=true`, so the peer is expected in the agent cgroup.

---

## W3 — macOS (pf anchor, OD13 a′)

**Owns:**
- `isolator_darwin.go`, `rules_darwin.go`, `pfconf.go`, `pfconf_darwin.go` and `scheduler_darwin.go`
- `agent/service/launchd/com.breeze.isolation*.plist`
- `agent/installer/macos/*` and `agent/internal/macosuninstall/*`
- the Darwin branch of `handlers_uninstall.go`

### Task 1: Compatibility check and attach-once

**Files:**
- `pfconf.go` (pure) and `pfconf_darwin.go`.
- Test: `pfconf_test.go`, with fixtures `testdata/pf/{stock-sequoia.conf, internet-sharing.txt, set-skip-en0.txt, quick-pass-before.txt, already-attached.txt}`.

**Interfaces:**
- `CheckCompatible(mainRules string, anchors []string, egressIfs []string) error` returns `ErrIncompatible{Reason}` for any of:
  - a `set skip` on an egress interface;
  - a `quick pass` rule before our anchor;
  - a service-inserted anchor that a main-ruleset load would destroy. That means `com.apple.internet-sharing`, or any anchor that is not in `/etc/pf.conf` and is not `com.apple/*`.
- `AttachOnce(runner) error`.
- `ParentHookPresent(runner) (bool, error)`.

- [ ] **Step 1: Write the failing tests.**
  - Each fixture produces the expected decision.
  - The second apply never loads the main ruleset.
  - A grep test finds no `pfctl -d` anywhere in the package.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: pf isolator

**Files:**
- `isolator_darwin.go` and `rules_darwin.go`.
- Tests: golden ruleset and fake-runner tests.

- [ ] **Step 1: Write the failing tests.**
  - **Rules.** The anchor allows only destination permits. `scope:"breeze"` degrades to a destination permit (OD2 b). The baseline comes next, then `block drop` with the label `breeze_drop`.
  - **Apply.** `Apply` runs `pfctl -a com.breeze/isolation -f -`, then `pfctl -E` (the token goes in the journal), then `pfctl -k` for any states that no permit matches.
  - **Verify.** `Verify` takes the digest of `pfctl -a … -sr` and calls `ParentHookPresent`. If the parent hook is missing, it re-attaches when the main ruleset is compatible; otherwise it alerts and reports drift.
  - **Drop counter.** `DropObserved` is the delta of the label counter from `pfctl -a … -vsr`.
  - **Release.** `Release` runs `pfctl -a … -F all`, then `pfctl -X <token>`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 3: LaunchDaemons, recovery and pkg uninstall

**Files:**
- `com.breeze.isolation.plist`: `RunAtLoad`, `StartInterval 900`; it runs recovery `boot-apply`, then `expire-check`.
- `com.breeze.isolation.rollback.plist`: loaded at apply with `StartInterval 15`, unloaded at commit. Its job is `rollback-if-uncommitted --attempt`.
- An `ExpireAt` job using `StartCalendarInterval`, rewritten on extend.
- `scheduler_darwin.go`.
- `installer/macos/{postinstall, build-pkg.sh}`.
- `macosuninstall/{script.go, functions.sh}`: release first.
- `handlers_uninstall.go:185,226`.
- `recoveryinstall/install_darwin.go`, and notarisation of the recovery binary in `release.yml`.
- Tests: `scheduler_darwin_test.go` (plist golden), `macosuninstall/script_test.go`, `handlers_uninstall_darwin_test.go` and `recoveryinstall/install_darwin_test.go`.

- [ ] **Step 1: Write the failing tests.**
  - The plists match golden files:
    - root ownership and `RunAtLoad`;
    - `StartInterval 900` on the main plist and `15` on the rollback plist;
    - `ProgramArguments` naming the versioned recovery path;
    - `ExpireAt` uses `StartCalendarInterval` from `expiresAt`, converted to local time with a test for the DST edge.
  - The uninstall script runs `release-all` before `launchctl bootout` of any Breeze daemon, and aborts on a non-zero exit.
  - The pkg `postinstall` never overwrites an existing recovery version directory.
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/isolation/... ./internal/macosuninstall/... ./internal/heartbeat/...` on the macOS runner. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 4: macOS capability on

**Files:** `isolator_darwin.go` (`Capability`) and the docs page. Test: `isolator_darwin_capability_test.go`.

- [ ] **Step 1: Write the failing test.** Each failing condition yields `{Version:0, Ready:false}` with its named reason:
  - `pfctl` missing → `pfctl_missing`;
  - recovery missing → `recovery_unavailable`;
  - scheduler not ready → `scheduler_unavailable`.

  Otherwise the result is `{Version:1, Mechanism:"pf", Ready:true}`. `CheckCompatible` is **not** consulted here: it runs at apply time, so a refused apply shows `mechanism_unavailable` with its reason in the console.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement it.** Document the macOS limits: there is no per-process scope, and the boot window is measured in L3.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**

**L3 macOS lab leg (Todd gate).**
- Covers the spec §7 macOS row and the macOS items in the All row.
- Includes: Internet Sharing on → the apply refuses and nothing is destroyed; an admin reloads the main ruleset → re-verify detects it.
- Runs on a Sequoia tart VM.

---

## W4a — Partner-wide `containment` config-policy feature

Read the "Partner-Wide First" 7-step playbook in `docs/agents/tenancy-rls.md` and the `configuration-policy` skill before starting. The precedent is `security_agents`.

**Settings Rule 9 (goes in the PR body):**
- Home: Configuration Policies → Containment tab.
- Level: partner default, then org override via policy assignment.
- Resolver: `resolveContainmentPolicy(deviceId)`, called by the service, the AI handler and the heartbeat builder.
- Places configured: 0 before, 1 after.

### Task 1: Feature type and inline settings

**Files:**
- New migration `<slot>-config-feature-containment.sql`: `ALTER TYPE … ADD VALUE IF NOT EXISTS 'containment'`, in the same form as the `security_agents` migration (check the README's rule for enum values).
- Modify `db/schema/configurationPolicies.ts:67` (append the value) and `services/configurationPolicy.ts:3116` (`PARTNER_LINKABLE_FEATURE_TYPES`).
- Modify `services/featureConfigResolver.ts`, next to the `security_agents` block at `~:1367-1427`.
- Add `packages/shared/src/validators/containmentPolicy.ts`.
- Tests: `containmentPolicy.test.ts` and `featureConfigResolver.containment.test.ts`.

**Interfaces:**
- `containmentInlineSettingsSchema`:

  | Field | Type and range | Default |
  |---|---|---|
  | `version` | `1` | — |
  | `extraAllow` | array of `{ host?, cidr?, proto, ports, label }` | — |
  | `defaultTtlHours` | 1..720 | 72 |
  | `deadManMinutes` | 0, or 15..1440 | 0 |
  | `remoteRelay` | boolean | true |
  | `requireSignedReleaseToken` | boolean | false |

- `extraAllow` rejects: `0.0.0.0/0`, `::/0`, IPv4 prefixes shorter than /8, IPv6 prefixes shorter than /32, loopback, and wildcard hostnames.
- `resolveContainmentPolicy(deviceId): Promise<ContainmentPolicy & { revision: string }>`.

- [ ] **Step 1: Write the failing tests.**
  - An org override takes precedence over the partner default.
  - Each item on the reject list is refused.
  - The defaults equal the W1 fixed values.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 2: Wire the policy in, gate writes, and add the UI

**Files:**
- In `service.ts`, `allowlist.ts` and `reconcile.ts`: policy extras become `scope:"any"`, and the policy is their only source. The payload carries `policyRevision`, which the W1e agent rule requires.
- Partner-level links require `canManagePartnerWidePolicies`.
- `featureTabs/ContainmentTab.tsx`, wired in at `ConfigPolicyDetailPage.tsx:137,491`.
- 8 locales.
- Tests: `service.policy.test.ts`, `ContainmentTab.test.tsx` and `settingsPageRegistry.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - A policy extra appears as `scope:"any"`, and only from the policy.
  - A policy change reaches the device on its next heartbeat as a new generation.
  - An org admin cannot edit a partner-level link.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests, then the repo-wide `configFeatureLinks.orgId` sweep (playbook step 7).** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W4b — AI `release_containment` (four-eyes)

**Starts only after W04 #6758 and W19 #10065 have merged.** Both touch the same `aiGuardrails.ts`, `aiToolSchemas.ts` and index budget.

### Task 1: Register the tool and its tier

**Files:**
- `aiToolsIncident.ts`: register the tool.
  - Tier 3, `deviceArgs:['deviceId']`.
  - Input: `{ deviceId, isolationId, reason }`.
  - Handler: `releaseNetworkIsolation(..., { kind:'ai', approvalBinding })`.
- Tier, rate-limit and digest tables:
  - `aiGuardrails.ts:601` (`TIER3_FOUR_EYES_TOOLS`)
  - `aiToolRateLimits.ts:184` (5 per 600 s, the same as `execute_containment`)
  - `actionIntents/effectDigest.ts:167` (`{orgId, deviceId, isolationId, generation}`)
- Tool catalogs:
  - `aiToolSchemas.ts`
  - `aiAgents/agentToolCatalog.ts:203` (`security_response`)
  - `mcpCoverage.ts:529`
- Mirrors and docs:
  - `apps/web/src/components/ai-risk/tierConfig.ts`
  - `ai.mdx:143,183`
- Tests:
  - the `aiGuardrails*` tests
  - `aiGuardrailsTierConfig.parity.test.ts`
  - `aiGuardrailsAiDocs.parity.test.ts`
  - `aiAgentSdkTools.registryParity.contract.test.ts`. Do not add the tool to `KNOWN_MISSING_TOOL_TIERS`; that list may only shrink.
  - `aiToolIndex.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - The tool is four-eyes.
  - An approval bound to generation N cannot release generation N+1.
  - An approval issued before an org move fails after it.
  - The sole-operator WebAuthn fallback works.
  - MCP stays denied, both unattended and through intents (W1c).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Measure the index with `aiToolIndex.test.ts`.
  - If it exceeds 7 040 B, raise `INDEX_BUDGET_BYTES` **once**, to 7 168 B (+128 B, the per-wave allowance), with a comment.
  - If it still exceeds 7 168 B, do not raise the budget again. Shorten the new tool's index entry or use the lazy index from #10065.
  - Whatever happens, the cap of 7 680 B is never exceeded.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W4c — Signed offline release token (OD6 c)

### Task 1: Server signing, agent verification, console and policy

**Files:**
- `services/networkIsolation/releaseToken.ts`: Ed25519, signed with `NETWORK_ISOLATION_TOKEN_SIGNING_KEY` (Gate B decision 5).
  - Register the key in `validate.ts` and both `.env.example` files.
  - Pass it through `docker-compose.yml` and `deploy/docker-compose.prod.yml` as `${NETWORK_ISOLATION_TOKEN_SIGNING_KEY:-}`.
  - Extend the compose-parity test from W1b Task 3.
- `Spec.ReleaseTokenPublicKey`, pinned in the journal at apply.
- `agent/internal/isolation/releasetoken.go`.
- The CLI gets `containment release --token`.
- `BreakGlassCodePopover.tsx` gets a token tab with copy and QR.
- When `requireSignedReleaseToken` is on, the agent refuses `--code`. Tokens are always accepted.
- Tests: `releaseToken.test.ts`, `releasetoken_test.go` and the shared vectors at `agent/internal/isolation/testdata/release_token_vectors.json`.

**Interfaces:**
- Token format: `base64url(payload) "." base64url(sig)`.
- Payload: `{"v":1,"iid","gen","dev","nbf","exp"}`.
- Constraint: `exp − nbf ≤ 24 h`.

- [ ] **Step 1: Write the failing tests.**
  - The agent refuses a token for the wrong device, the wrong generation, one that has expired, one signed with the wrong key, and one whose payload was tampered with.
  - The pinned key survives an upgrade.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## W4d — Dead-man opt-in (OD4)

### Task 1: Agent mechanics behind capability v2

**Files:**
- `isolation/manager.go`: track the last authenticated control-plane contact on the monotonic clock. When `deadManSeconds > 0` and that window is exceeded, release with the journal reason `dead_man` and report `self_released`. Capability `Version: 2`.
- `services/networkIsolation/service.ts`: send `deadManSeconds > 0` only to agents that report version ≥ 2. For older agents, the dialog shows "dead-man not supported on this agent version" and isolation proceeds with 0.
- `reconcile.ts`: the episode stays unresolved, an alert fires, and nothing is re-asserted.
- The UI copy states the trade-off: the dead-man is attacker-triggerable, and it fires across the fleet together during a control-plane outage.
- Tests: `manager_deadman_test.go`, `reconcile.deadman.test.ts` and `service.deadmanCapability.test.ts`.

- [ ] **Step 1: Write the failing tests.**
  - With 0, the device never self-releases.
  - Past the window, the agent releases exactly once.
  - On reconnect the episode shows `self_released`.
  - A new episode is blocked until the old one is acknowledged.
  - `desired:isolated` is never re-sent.
  - A v1 agent never receives a non-zero dead-man.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.**

---

## Rollout (every wave)

1. **Merge.** Merge with `NETWORK_ISOLATION_ENABLED=false` everywhere. Agent code ships inert.
2. **Lab partner.** Turn on `NETWORK_ISOLATION_ENABLED=true` plus `NETWORK_ISOLATION_ENABLED_PARTNER_IDS=<lab partner>` in one region. Run the lab leg for this wave against **release** binaries, on disposable VMs, never on a host that has the installed agent.
3. **Canary partner.** Add Todd's own fleet's partner to the list and run it for one week. Watch:
   - `device.isolation_failed`, grouped by `failure_code`;
   - `released_locally:*`;
   - `self_released`;
   - `drift_reapplied` counts;
   - recovery `release-all --reason system` receipts.
4. **Fleet.** Clear the partner list. Promote the agent following the `release` skill, and **clear the canary org pins at the promote**.
5. **Kill switch.** Turning the flag off, or narrowing the partner list, only blocks new isolations. It never strands an isolated device.
   - There is no agent-side switch. That is deliberate (ECH lesson).
   - An emergency fleet un-isolate is a scripted per-episode console release; the W1h docs page has the procedure.

## Lab legs Todd owes (spec §7)

| Gate | Before | Checks |
|---|---|---|
| **L1 Windows** | W1 activation (lab partner) | the W1g list above |
| **L2 Linux** | W2 promote | spec §7 Linux row + All-row Linux items + negative-probe attribution + Linux remote desktop |
| **L3 macOS** | W3 promote | spec §7 macOS row (Internet Sharing refusal, parent-hook detection) + All-row macOS items + attribution |
| **L4 token** | W4c promote | the token releases on each shipped OS; `requireSignedReleaseToken` refuses `--code` |
| **L5 dead-man** | W4d promote | policy on: block the control plane at the hypervisor → release → reconnect → `self_released`, with no re-assert. Policy off: stays isolated past the window. A v1 agent ignores the policy safely |

---

## Advisor quorum (plan stage, 2026-10-25)

`codex exec`, gpt-6-astra, `model_reasoning_effort="xhigh"`, `-s read-only`, prompt via stdin. The reviewer formed its own position on (Q1) the wave split and (Q2) W1 Windows fail-safe ordering before grading mine. I checked every code claim at `039a39007c` before adopting it. The spec-stage rounds are spec Appendices A and B.

**Headline verdict:** *"The release order is right. The four-PR split and Windows recovery protocol need changes before approval."*

| # | My draft position | Codex verdict | Checked | Resolution |
|---|---|---|---|---|
| 1 | Keep OD12's four waves; split W1 into four PRs (server, agent framework, Windows, console) | **Agree on the order; disagree on the split.** W1a and W1c are several review units each. Split along the lines data/contracts · orchestration · guards · agent core · agent wiring · WFP · recovery/packaging · console | reasoning | **Adopted:** W1 becomes W1a–W1i (Gate B decision 1) |
| 2 | Flag off + capability 0 make every merge safe | **Insufficient.** The agent handler forwards the payload untouched, and the stub's error is the only barrier. Reject legacy and unbound commands | confirmed (`handlers_incident_response.go:16`, `incident_response.go:189`) | **Adopted:** W1e strict validation + the tools path refuses; W1c claim-time refusal of any isolate row without a live matching episode |
| 3 | Relay-only remote desktop in W4 | **Disagree.** It is approved in §3.4/OD9, and the viewer has a STUN-only fallback that drops TURN | confirmed (`apps/viewer/src/lib/webrtc.ts:250-265`, `session_webrtc.go:75`) | **Adopted:** new wave **W1i** |
| 4 | `LIFECYCLE_COMMAND_TYPES` protects release | **Add** `TEARDOWN_CLAIM_EXEMPT_TYPES`. Claim-time cancels (deactivated requester, quarantined device, org drift) otherwise drop it | confirmed (`commandClaimEligibility.ts:174,187`) | **Adopted:** W1b Task 2 |
| 5 | MCP deny on the unattended lift | **Broaden it** to cover MCP intent creation too | confirmed (`mcpServer.ts:1533-1541`, `:2226`) | **Adopted:** W1c Task 1 |
| 6 | The updater skips its GitHub fallback while isolated | **Insufficient.** That fallback is macOS pkg only. The general updater follows cross-origin manifest URLs | confirmed (`pkg_source.go:13`, `updater.go:1515`) | **Adopted:** W1e restricts every artifact URL and redirect to the control-plane host while active, and W1c refuses downgrades below the gate |
| 7 | MSI-bundled recovery + side-by-side updater component | **Add:** the Windows fleet updates by raw swap, not MSI. Never use the overwrite-in-place companion mechanism. Pin the active episode to its recovery version. Repointing several tasks is not atomic | confirmed (`updater.go:1024`, `restart_windows.go:240`) | **Adopted:** W1g Task 2 (`EnsureRecovery` at start + preflight, pinned while unresolved, repoint task by task) |
| 8 | Capability 1 once WFP works | **Add:** report it only after recovery and tasks are installed and usable | reasoning | **Adopted:** `Capability.Ready`, and the server requires it (W1g Task 4) |
| 9 | Apply order (preflight → journal → arm → apply → probe → commit → disarm) | **Add** fencing (machine lock + `attemptId`), a deadline re-check before and after apply, verified absence on rollback, and recovery stays armed if cleanup fails. Don't hold the lock across probes | reasoning | **Adopted:** W1d Task 2 order + `manager_fence_test.go` |
| 10 | Release order | **Add:** recovery retries `releasing` at once; a durable terminal receipt; a failed cleanup is never `released` | reasoning | **Adopted:** `PendingReport`, W1g Task 1 |
| 11 | Boot: recovery `expire-check` at startup | **Add:** orphan rules with a missing, corrupt or unknown journal get deleted; never promote a provisional apply because filters exist; local terminal state wins over stale commands | reasoning | **Adopted:** journal contract + W1g Task 1 |
| 12 | Upgrade: re-apply if paths change | **Add:** permit old **and** new paths across the swap; refuse incompatible upgrades or downgrades while isolated | reasoning | **Adopted:** W1g Task 3, W1c Task 1 |
| 13 | Uninstall: release first | **Add:** release before `prepareSelfUninstallFn`; abort if absence can't be shown; the MSI custom action carries `NOT UPGRADINGPRODUCTCODE` | confirmed (`handlers_uninstall.go:76`, `breeze.wxs:848`) | **Adopted:** W1g Task 3 |
| 14 | — (missed) | Provider-associated WFP filters are disabled at BFE start when the associated service is not auto-start. Persistent and boot-time flags are mutually exclusive | Microsoft `FWPM_FILTER0` docs (not re-read here) | **Adopted:** the provider has no `serviceName`, separate filter sets, and tests for both (W1f Task 1) |
| 15 | Clock: wall < `appliedAt` after reboot | **Insufficient** for an arbitrary rollback across a reboot | reasoning | **Adopted:** the `highWaterWall` rule (Gate B decision 4 ii) |
| 16 | 15-min poll bounds expiry | `StartWhenAvailable` can delay a missed task by up to 10 min; the spec's apply + 90 s is the deadline itself | Microsoft Task Scheduler docs (not re-read here) | **Adopted:** a one-shot `ExpireAt` task plus the poll; the deadline is apply + 90 s (Gate B decision 4 iii) |
| 17 | Sweeper marks undelivered past expiry | **Never mark an episode safely terminal just because delivery expired** | reasoning | **Adopted:** `not_delivered` only with no agent contact for the episode; the tombstone persists until `release_confirmed_at` (decision 4 iv) |
| 18 | Dead-man mechanics in W4 | **Agree conditionally:** W1 must enforce 0; W4 needs a capability gate so older agents can't silently ignore the opt-in | reasoning | **Adopted:** capability v2 (W4d, decision 4 v) |
| 19 | Index budget +128 B in W4b | Budgets are per release wave, not per sub-PR; measure, don't spend automatically; the ceiling is 7 040 B | confirmed (`aiToolIndex.test.ts:184,219`) | **Adopted:** W4b Task 1 |
| 20 | W2/W3 contents | **Agree** | — | unchanged |

No disagreement remains open. Every codex position is either adopted or recorded as agreement. The adopted points that go beyond the spec's literal text are listed for Todd in Gate B decision 4.

## Gate B decisions (for Todd)

1. **How to split W1.**
   - (a) Nine sub-waves, W1a–W1i: one PR and one sub-issue each, all based on `main`. Activation needs all nine plus L1.
   - (b) The four coarse W1 sub-waves of the first draft.
   - (c) One W1 wave with nine PRs and no sub-issues.

   **Recommend (a).** The quorum showed the coarse slices were too big to review, and `feature-lifecycle` maps one wave to one PR and one branch.
2. **WFP binding.**
   - (a) Our own minimal binding on `golang.org/x/sys/windows`, with `inet.af/wf` (BSD-3) as a reference only.
   - (b) Depend on the `inet.af/wf` module.

   **Recommend (a).** It adds no new module to the agent's supply chain and touches about ten `fwpuclnt` procs. If any code is adapted, its licence header stays.
3. **How the recovery binary is distributed.**
   - (a) A new updater component `isolation-recovery` (signed manifest), installed side by side into versioned directories and pinned while an episode is unresolved. The MSI, pkg and install scripts also bundle it for fresh installs.
   - (b) Embed it in the agent (`go:embed`) and write it out.
   - (c) MSI/pkg only.

   **Recommend (a).** (c) misses every raw-swap-updated agent, and (b) ties recovery to the agent binary that recovery exists to survive.
4. **Eight plan-stage refinements.** Each one tightens or corrects the spec; none reverses an OD. (vi)–(viii) came from the PR review.
   - (i) Relay-only remote desktop moves from "W4 if not earlier" into W1, as W1i.
   - (ii) A clock high-water-mark rule: after a reboot, a wall clock below the largest journalled or server time minus 5 min counts as expired.
   - (iii) A one-shot expiry task at `expiresAt`, in addition to the 15-min poll.
   - (iv) Four extra columns (`expiry_warned_at`, `break_glass_ack_seq`, `last_journal_seq`, `release_confirmed_at`), and the tombstone persists until confirmed, even for `failed:not_delivered`.
   - (v) Dead-man requires agent capability v2.
   - (vi) W4a's policy adds a `requireSignedReleaseToken` setting, which is not in spec §3.11. The policy stores `deadManMinutes`; the wire carries `deadManSeconds = deadManMinutes × 60`.
   - (vii) The break-glass secret moves on the wire. It becomes the top-level payload field `breakGlassSecret`, not `parameters.breakGlass.secret` (spec §3.3), because `sensitiveCommandPayload.ts` encrypts and strips only top-level keys. In the heartbeat block it is plaintext over the agent's TLS channel, the same trust model as command delivery. It is not ciphertext the agent cannot open.
   - (viii) A spec §2 correction. "Isolate is a `device_execute`-gated command, so probation/restricted partners cannot isolate" is not true of the code: `execute_containment` is in `LIFECYCLE_COMMAND_TYPES` (`partnerTrust.ts:101`). The plan gates start on trust explicitly (W1b Task 3) to deliver the spec's intent.

   **Recommend: confirm all eight as plan-level refinements.** Fold them into the spec as a dated "Plan refinements (Gate B)" note in the same docs PR once you approve.
5. **Signing key for the W4c release token.**
   - (a) A dedicated `NETWORK_ISOLATION_TOKEN_SIGNING_KEY` (Ed25519).
   - (b) Reuse the agent release-manifest signing key.

   **Recommend (a).** Keeping the purposes separate means a compromised manifest key cannot release isolated devices, and the reverse. The key can rotate per episode because the public key is pinned at apply.
6. **Version-gate sentinel.** `NETWORK_ISOLATION_MIN_AGENT_VERSION = '999.0.0'` until the release that carries W1g pins it. **Recommend yes.** Start fails closed even if the flag is flipped early.
7. **Self-updates while isolated.** Agent and recovery downloads are restricted to the control-plane origin. On hosted `BINARY_SOURCE=github`, an isolated device therefore cannot self-update until it is released.
   - (a) Accept this and document it.
   - (b) Proxy artifact downloads through the control plane during isolation.

   **Recommend (a) for v1.** Episodes are capped at 30 d and default to 72 h. (b) is new server surface that no customer has asked for.
8. **Staging lever.** `NETWORK_ISOLATION_ENABLED` is region-wide, but the spec's rollout says "lab org only".
   - (a) Add `NETWORK_ISOLATION_ENABLED_PARTNER_IDS` (start allowed only for the listed partners; release never gated).
   - (b) Use a separate lab region.
   - (c) Accept region-wide enablement at the lab step.

   **Recommend (a).** It is a 10-line gate in W1b, and it gives the lab → canary → fleet sequence in spec §7 a real control.
9. **Execution method.** Subagent-driven, one wave per dispatch, with an Opus implementer on W1d–W1g (agent-shipped, privileged) and Sonnet allowed on the mechanical batches (W2 Task 2 call-site conversion, locales). **Recommend subagent-driven.** The waves are interface-coupled through the cross-wave types, and a shipped mistake strands customer machines.

## Self-review

- **Spec coverage.** Every §3.1–§3.11 requirement, every §4 registration, §5 (nothing out of scope is built) and every §7 lab row is mapped to a task or a lab gate above.
  - "Incident delete refuses" has no endpoint to attach to at `039a39007c`: there is no incident delete route. It is pinned by a static test that fails the moment such a route appears without the guard (W1c Task 2).
  - "Device credential rotation while isolated" needs no code change, because the episode does not depend on the credential. It is an L1 lab check.
  - "Every 5 min re-resolve" lives in `Manager.Tick`.
  - "Expiring-soon alert" is W1c Task 3.
  - "Isolated" filter is W1h Task 2.
  - "Server-OS confirm warning" is W1h Task 1.
  - "No bulk isolate" is enforced by W1c Task 1.
- **Type consistency.** Names are defined once in Cross-wave interfaces: `startNetworkIsolation`, `releaseNetworkIsolation`, `buildIsolationAllowlist`, `buildContainmentHeartbeatBlock`, `reconcileContainmentReport`, `assertNoUnresolvedIsolation`, `Manager.HandleIsolate/HandleRelease/Reconcile/Report/Tick/Startup`, `RecoveryScheduler.ArmProvisional/DisarmProvisional/ArmExpiry/EnsurePoll/RemoveAll/Ready` and `EnsureRecovery`. Later waves reuse these names unchanged.
- **Review Focus.** Each of the five lines is assigned to a named test in its owning task.
- **Proportion.** The plan carries signatures, rule tables and assertions, not function bodies. The only algorithm it spells out is the apply/release/boot ordering, which no signature determines.
