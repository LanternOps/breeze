---
status: approved  # Gate A 2026-10-25, all 15 Open Decisions as recommended
issue: LanternOps/breeze#4618
related: [4149, 3397, 9118, 8869, 6758, 6754]
builds_on:
  - docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
  - docs/superpowers/specs/security/2026-10-12-security-agents-policy-spec.md
---

# Network isolation containment: cut a device off the network, keep the Breeze management plane

Stage-2 spec for #4618 (roadmap `status:ready`, p1, effort L; Todd's roadmap "Go" comment 2026-09-22). Drafted against `origin/main` at `e93705f861`; file:line references re-verified at `dd2556224f`. Paths are relative to the repo root. Anything not confirmed in code is marked **(assumption)**. No real hostnames, addresses or region names appear here; placeholders are `<control-plane host>`, `<relay host>` and RFC 5737 ranges.

## 1. Problem

"Isolate this device from the network, keeping only Breeze traffic" is the containment action every EDR offers and the one an MSP reaches for first when an endpoint is compromised. Breeze has the whole request, approval and audit pipeline for it and no implementation underneath:

- `agent/internal/remote/tools/incident_response.go` — `ExecuteContainment` handles `process_kill` and returns `network_isolation requires platform-specific implementation (current: <GOOS>)` for the rest. There is no `_windows.go` / `_darwin.go` / `_linux.go` variant and no host-isolation firewall code under `agent/` (`agent/internal/security/status*.go` is read-only posture; `agent/internal/netpolicy` governs the agent's *own* outbound downloads, not the host; the only firewall mutation is Linux bare-metal restore replaying a saved ruleset with `iptables-restore`, `agent/internal/backup/bmr/restore_linux.go:499`).
- The AI tool `execute_containment` (`apps/api/src/services/aiToolsIncident.ts`, tier 3, `TIER3_SUPERVISED_TOOLS` in `aiGuardrails.ts:754`, rate-limited 5/600 in `aiToolRateLimits.ts:181`) records an `incident_actions` row, queues the command, and since #9662 follows the device's real result through `incidentContainmentResults.ts`. For `network_isolation` that result is always `failed`.
- `POST /incidents/:id/contain` (`apps/api/src/routes/incidentActions.ts`) is record-keeping: it inserts an action row and flips the incident to `contained`; it never reaches a device. `HIGH_RISK_CONTAINMENT_ACTIONS` (`incidents.validation.ts:90`) requires an `approvalRef` for the four action types.
- No console surface exposes the action. The "Isolate" button in `DeviceEdrPanel.tsx` is SentinelOne's isolation, performed by the S1 agent through `routes/sentinelOne.ts:799`.
- The docs are honest about it (`apps/docs/src/content/docs/features/incident-response.mdx:136, 253`) but `docs/security/SECURITY_PRACTICES.md:463` and `docs/guides/ADMIN_GUIDE.md:1421` present "containment governance" for an action that cannot run.

Todd's roadmap note (2026-09-22): an audited containment action that silently no-ops on every OS is a trust gap, not a missing feature.

Three facts shape the design more than anything else:

1. **The agent must keep talking while the host is cut off.** The management plane is one `<control-plane host>` (Cloudflare-fronted in hosted mode, anything in self-host), reached over HTTPS and WebSocket, plus the backup server URL (`AGENT_BACKUP_SERVER_URL`), the TURN relay (`TURN_HOST` / `TURN_TLS_HOST`, `routes/remote/helpers.ts:getIceServers`) and, since #8869, the DoH endpoints the ECH dialer uses to fetch the ECH config (`agent/internal/ech/doh.go:24`). Several of these are shared anycast addresses, so a pure destination allowlist is porous by construction (§3.4).
2. **An isolation that cannot be released from the console is unacceptable.** The ECH kill switch (#8869, `AGENT_ECH_ENABLED`) showed how a server-side switch strands devices when the restore path depends on the very thing that was switched off. Every fail-safe in §3.6 exists because of that precedent.
3. **Agent code runs on customer machines.** `CLAUDE.md` ("Efficient coding & review"): *"full ceremony for tenancy/RLS, auth, migrations, billing, agent-shipped code"*. This is agent-shipped, privileged (root / LocalSystem), firewall-mutating code. Highest rigor: red-first everywhere, per-OS lab legs before any promote, flag off by default, agent-version gate.

## 2. Users & scope

**Who it is for.** MSP technicians and security staff responding to an incident on a managed Windows, macOS or Linux endpoint; the AI assistant acting for them under approval; org-scoped admins (a customer's own IT) for devices in their org.

**Tenancy axis.** Isolation is **device state inside an org**, not configuration. The episode table is org-scoped with a device column (RLS shape 1 + device cascade lists, §4). `org_id NOT NULL` is justified: an episode is a fact about one device, never a partner-wide template. The *policy* that tunes isolation (extra allowlist entries, default TTL, dead-man window) is config and therefore **partner-wide first** (`CLAUDE.md` "Partner-Wide First": *"New config-ish tables … default to `org_id` XOR `partner_id`; `org_id NOT NULL` needs a stated justification in the PR"*). It ships in a later wave as a config-policy feature (§3.11, OD10).

**Who may isolate.** Human: an interactive user session (`requireInteractiveSession()`, the guard the maintenance-mode route uses at `routes/devices/commands.ts:663`), `devices:execute`, `requireMfa()` (the session's MFA claim — not a fresh step-up, and void under `ENABLE_2FA=false`, see below), scope `organization | partner | system`, site-restricted users only for devices in their sites — the SentinelOne isolate route's guard set (`routes/sentinelOne.ts:799-803`) plus the interactive-session requirement. AI: `execute_containment` tier 3 **supervised** (unchanged; W04 #6758 row 1 confirms). Partner trust: isolate is a `device_execute`-gated command, so probation/restricted partners cannot isolate (`services/partnerTrust.ts`).

**Who may release.** Human: the same guards, one person (OD7). AI: a new `release_containment` tool, tier 3 **four-eyes** — the AI docs already promise this (`apps/docs/src/content/docs/features/ai.mdx:143`: *"Releasing security containment — un-isolating a device … four-eyes. Isolating or quarantining stays supervised"*), including the sole-operator WebAuthn fallback documented at `ai.mdx:183`. Partner trust: `release_containment` joins `LIFECYCLE_COMMAND_TYPES` so a trust demotion mid-incident can never strand a device.

**API keys and MCP.** `requireMfa()` alone is not an API-key exclusion: `ENABLE_2FA=false` disables every `requireMfa()` gate (`hasSatisfiedMfa`, `middleware/auth.ts:1118`; the `requireInteractiveSession` doc comment at `auth.ts:94-103` states exactly this), which self-hosters do set. The exclusion therefore comes from `requireInteractiveSession()`, which rejects non-user principals regardless of the 2FA setting. API keys can neither isolate nor release in v1. Over MCP, tier-3 tools fail closed (`MCP_APPROVAL_REQUIRED`, `routes/mcpServer.ts:~1444`) **except** for principals an operator lists in `MCP_UNATTENDED_TIER3_PRINCIPALS`, which may call core-registry tier-3 tools without approval. **(quorum)** That exception must not reach isolation: `execute_containment` with `actionType: network_isolation` and `release_containment` are added to the unattended-principal deny set (the way Tier 4 is excluded), with a contract test (OD15).

**Generic command routes are closed to this action.** `POST /devices/:id/commands` and the bulk command route accept `type: 'execute_containment'` with a caller-built payload today (`routes/devices/schemas.ts:309, 352`). **(quorum)** Left alone, that is a bypass of the episode table, the server-built allowlist, the incident linkage and the "no bulk isolation" rule. Both routes reject `execute_containment` with `actionType: network_isolation` and any `release_containment` (`use_network_isolation_routes`); only `services/networkIsolation/*` may enqueue them. **(quorum)** On a 2FA-disabled self-host install a human with `devices:execute` isolates with password-only assurance; the spec accepts that and says so in the docs rather than inventing a second factor.

**Hosted and self-host.** Both. The allowlist is built server-side from the deployment's own configuration (server URL, backup URL, TURN, DoH), so a self-hoster's agents keep reaching *their* server. Self-hosters without a TURN relay lose remote desktop while a device is isolated (direct ICE candidates are blocked by design); terminal, file browser and tunnels ride the agent WebSocket and keep working.

**Platforms.** Windows 10 1809+/Server 2016+ (WFP), macOS 13+ (pf), Linux with nftables (`nft` binary present, kernel ≥ 5.x). Anything else reports `unsupported_platform` *before* touching the host and the console disables the action with the reason.

**In scope:** the agent mechanism per OS, the allowlist model, the episode state machine and table, server routes, heartbeat desired-state reconciliation, fail-safes and break-glass, console UI (device actions, device header badge, incident detail), AI tool wiring behind the flag, docs. **Out of scope:** §5.

## 3. Proposed design

### 3.1 Principles

1. **Server-authoritative desired state, agent-authoritative mechanics.** The server decides *whether* a device is isolated and *what* must stay reachable; the agent decides *how* on its OS and reports what it did. Desired state rides every heartbeat response for an isolated device (like `ech_enabled`, `routes/agents/heartbeat.ts:~2235`), so a rebooted, re-enrolled-credential or offline-then-back device reconciles without a command.
2. **Apply → verify → commit, or roll back.** No rule set is left in place until the agent has proven the management plane still works through it.
3. **Never strand.** Every episode has an expiry the agent enforces offline; there is a dead-man release, a console-displayed offline break-glass, and uninstall always tears isolation down.
4. **One mechanism per OS, the strongest the OS offers without a kernel extension.** No shelling out to `netsh` where a BFE API exists; no kernel/system extensions in v1.
5. **Nothing half-applied.** Dual-stack from day one; a failure on either address family rolls back both.
6. **No infrastructure details in code or docs.** Hostnames come from the deployment's environment at run time (`CLAUDE.md` "No Internal Infrastructure Details in Public Code": *"Never commit IPs, hostnames, regions, droplet addresses, or internal domain mappings"*).
7. **Isolation is never device `quarantined` status.** Quarantine blocks agent authentication (`middleware/agentAuth.ts:761`), which would remove the console release path. Isolation lives only in the episode table. **(quorum)**
8. **Recovery is observed, not assumed.** An episode is `released` only when the agent reports the rules gone (or the expiry/uninstall path journals it); a server-side timeout never proves a rollback.

### 3.2 Episode state machine

One **episode** per isolate request; one active episode per device (partial unique index, §4).

```
requested ──dispatch──► dispatched ──agent ack──► applying ──rules in place──► applied
    │                        │                        │                            │
    │ agent_unsupported      │ delivery expired        │ apply error (rolled back)  │ both probes ok within 60 s
    ▼                        ▼                        ▼                            ▼
 failed:<code>          failed:not_delivered     failed:<code>                  verified ◄── (steady state; re-verified every 5 min, on resume, on network change)
                                                                                   │
            ┌────────────────────┬──────────────────────┬──────────────────────────┼─────────────────────┐
            ▼                    ▼                      ▼                          ▼                     ▼
   release_requested      expired (TTL)        released_locally          self_released            uninstalled
            │              (agent, offline-safe)   (code | forced)         (opt-in dead-man, OD4)
            ▼                                                                      │
        released                                                      human re-isolates = NEW episode (no automatic re-assert)
```

Three things are kept apart in the model, because conflating them is how a late or duplicate message flips state the wrong way: the **desired** state the server holds (`isolated` / `released` + `generation`), the **observed** firewall state the agent reports (what is actually in the kernel, with a rule digest), and **command delivery** (the `device_commands` rows). An episode's `generation` is monotonic and changes only when **intent** changes: isolate = 1, every extend increments it; a release writes a **tombstone** (`released`, `generation` = last + 1). A retransmission of the same intent keeps its generation (otherwise a resend would invalidate an approval bound to it, §3.8). **(quorum)** Any agent result or heartbeat report carrying an older generation than the row is recorded in the journal and otherwise ignored — in particular a late `completed` arriving after the server timed the command out **does not** re-open the episode, unlike the generic finalizer, which deliberately lets a real agent answer overwrite a server-side timeout (`incidentContainmentResults.ts:108-113`). The isolation finalizer gates on generation first.

- `failed:<code>` codes (closed set, like `netpolicy.PolicyError` reasons): `unsupported_platform`, `mechanism_unavailable` (no `nft`, BFE engine refused, pf disabled by MDM profile), `apply_error`, `control_plane_unreachable` (positive probe failed → rolled back), `enforcement_not_observed` (negative probe failed → rolled back), `not_delivered`, `agent_unsupported` (version/capability gate, never dispatched).
- `self_released` is reachable only when the (default-off) dead-man is enabled by policy (OD4). It raises an alert and **blocks a new episode until acknowledged**: a human re-isolates deliberately; the server never re-asserts on its own.
- Terminal, resolved: `released`, `expired`, `failed:*`, `uninstalled`. Terminal, **unresolved** until acknowledged in the console: `released_locally`, `self_released`. Everything else is active. The uniqueness rule covers every unresolved episode, not just the active ones.

### 3.3 Wire contracts

**Isolate** — the existing `execute_containment` command with `actionType: "network_isolation"`; the server fills `parameters` (the AI/operator never supplies the allowlist):

```jsonc
{
  "incidentId": "…", "actionId": "…", "actionType": "network_isolation",
  "parameters": {
    "isolationId": "<episode uuid>", "generation": 1,
    "expiresAt": "2026-11-01T12:00:00Z",          // mandatory
    "deadManSeconds": 0,                           // 0 = disabled (default; OD4)
    "remoteRelay": true,                            // permit the TURN relay
    "breakGlass": { "secret": "<32 random bytes, base64>" },   // sensitive field: encrypted at enqueue, erased at terminal (§3.6 item 3)
    "allow": [
      { "kind": "host", "host": "<control-plane host>", "proto": "tcp", "ports": [443], "scope": "breeze" },
      { "kind": "host", "host": "<backup server host>", "proto": "tcp", "ports": [443], "scope": "breeze" },
      { "kind": "host", "host": "<relay host>", "proto": "udp+tcp", "ports": [3478, 5349], "scope": "breeze" },
      { "kind": "host", "host": "<doh endpoint host>", "proto": "tcp", "ports": [443], "scope": "breeze" },
      { "kind": "cidr", "cidr": "203.0.113.0/24", "proto": "tcp", "ports": [443], "scope": "any" }   // policy extra (W4)
    ]
  }
}
```

`scope: "breeze"` = permitted only for Breeze processes where the OS can match a process (Windows per-app, Linux per-cgroup); on macOS it degrades to a destination permit. `scope: "any"` = any process (an MSP's EDR cloud, a VPN concentrator). The server never emits `scope: "any"` entries except from policy (W4), so neither the AI nor an operator can poke an ad-hoc hole.

`execute_containment` joins the sensitive-payload list in `services/sensitiveCommandPayload.ts` for the `breakGlass.secret` field: `device_commands.payload` is plaintext, system-scoped JSONB, and encryption there is **not automatic** — the service calls `encryptSensitivePayloadFields` before enqueue and every terminal writer erases the key (`sensitiveCommandPayload.ts:15-24`). **(quorum)**

**Release** — a new command type `release_containment` `{ "isolationId", "generation", "reason" }`. Registered in `commandTypes.ts`, `commandOfflinePolicy.ts` (queue, not reject: a release must land when the device next appears), `commandTimeouts.ts`, `privilege/check.go` `elevatedCommandTypes`, and `LIFECYCLE_COMMAND_TYPES`.

**Heartbeat response** — a `containment` block, **always sent** (absent-means-no-change is the one-way-switch trap the `ech_enabled` comment in `heartbeat.ts` documents). After a release the block carries the `desired: "released"` tombstone **until the agent reports `released` at that generation**, and only then becomes `null`; a bare `null` never stands in for a release. **(quorum)** While the agent has not acknowledged receipt of the break-glass secret (`journalSeq` of its `secret_received` entry), the block also carries the encrypted `breakGlass` field, so an isolation first applied from the heartbeat (queued command reaped) still gets a working offline code; once acknowledged it is never sent again:

```jsonc
"containment": { "networkIsolation": { "isolationId", "generation", "desired": "isolated" | "released", "expiresAt", "deadManSeconds", "remoteRelay", "allow": [...] } | null }
```

**Heartbeat request** — the agent reports, every beat, `containment.networkIsolation: { isolationId, generation, state, mechanism, appliedAt, lastVerifiedAt, ruleDigest, lastError, journalSeq }` and a capability `securityCapabilities.networkIsolationVersion: 1 | 0` with `mechanism` and an `unsupportedReason` (the `outboundNetworkPolicyVersion` handshake pattern, `heartbeat.go:267`). The server reconciles on `(isolationId, generation)`: desired `isolated` + reported `released` at the same generation = a local or dead-man release → record it, alert, wait for a human; desired `released` + reported `applied` = the release command was lost → re-send the tombstone; a reported `ruleDigest` that differs from the last one = the agent re-applied after drift → log; an older generation = stale → journal only.

**Agent result** — `CommandResult.Result` carries `{ isolationId, generation, state, mechanism, appliedAt, verifiedAt, rollback: bool, errorCode }`; `ErrorCode` uses typed `wire.CommandErrorCode`s so the finalizer classifies on the code, never on prose (#4026).

**Routes** — `POST /devices/:id/network-isolation` (start), `POST /devices/:id/network-isolation/:isolationId/release`, `POST …/extend`, `POST …/acknowledge`, `GET …/break-glass-code` (audited), `GET /devices/:id/network-isolation` (current + history). `POST /incidents/:id/contain` stays exactly what it is — manual record-keeping — and its docs say so; it never becomes evidence of endpoint state. Human routes and the AI handlers call one service (`services/networkIsolation/*`), so there is one place that builds the allowlist, writes the episode and queues the command.

### 3.4 Allowlist model

**Server builds it, agent resolves it.** On every isolate and every heartbeat for an isolated device the server assembles the list from its own environment: the device's server URL host, `AGENT_BACKUP_SERVER_URL`, `TURN_HOST`/`TURN_TLS_HOST` when `remoteRelay` is set, the ECH DoH endpoints (exported from one place so `agent/internal/ech/doh.go` and the server agree), plus policy extras (W4). The agent resolves hostnames through its own resolver path (the same path its control-plane dials use), **installs the numeric permits before it dials anything**, re-resolves every 5 minutes and on every network-change / resume event, and swaps the rule set atomically. A resolution failure never removes a working permit: the agent keeps a bounded last-known-good address set per hostname (`netcache` today only falls back on DNS failure, not on firewall-induced connect failure — `netcache.go:86`; the isolation package keeps its own set). The effective proxy, when the transport honours one, is added as a destination.

**Existing flows are cut, not grandfathered.** Applying isolation must end an attacker's already-open connections: on Windows the ALE layers re-authorise existing flows when the filters change (and the apply additionally resets non-permitted TCP flows); on macOS the agent flushes pf states that no permit matches (`pfctl -k`); on Linux the "established" permit is granted only to flows whose *original* direction matched a permit — new permitted flows get a `ct mark`, the `established` rule requires that mark, and conntrack entries without it are flushed at apply. "Allow established" is never a blanket rule.

**Baseline, always permitted, any process:**

| Traffic | Why | Direction |
|---|---|---|
| Loopback (v4/v6) | agent ↔ helper IPC, local resolvers (systemd-resolved stub) | both |
| DHCPv4 67/68, DHCPv6 546/547 | lease renewal; losing the lease strands the agent | both |
| DNS 53 udp/tcp to the host's **currently configured** resolvers only | Windows (`Dnscache` in svchost), macOS (`mDNSResponder`) and Linux (`systemd-resolved`) resolve on behalf of the agent, so DNS cannot be process-scoped | out |
| ICMPv6 NDP/RA/MLD (types 130–137), ICMPv6 Packet Too Big (type 2), ICMPv4 fragmentation-needed (type 3 code 4), echo replies | address configuration, neighbour discovery and path-MTU discovery; v6 networks and VPN/tunnel paths die without them | both |
| Return traffic **of permitted flows only** (`ct mark` / state tied to a permit) | stateful return traffic; never a blanket "established" permit | in |
| Environment `HTTPS_PROXY` host:port, if the agent's transport honours one (`heartbeat.go:1131` keeps `ProxyFromEnvironment`) — **Breeze processes only** where the OS can match a process (a proxy is a general egress; an any-process permit would undo isolation) **(quorum)** | the agent only ever talks to the proxy | out |

**Everything else is dropped, both directions,** including new inbound (RDP, SMB, SSH, VNC), outbound web, SMB/lateral movement, vendor clouds not in policy, Windows Update, package mirrors, NTP, VPN clients. Drop, not reject, on every OS: a silent drop keeps the negative probe (§3.7) unambiguous and gives malware no RST to key off. **Forwarded traffic** is dropped too: the Linux table has a `forward` base chain (containers, libvirt bridges). A forward chain cannot see flows **already** offloaded to an nft flowtable; the apply's conntrack flush of non-permitted flows is expected to tear those down **(assumption — Linux lab leg proves it)**, and hardware-offloaded flows are a documented limitation **(quorum)**; and the macOS/Windows rows in §3.5 state what host-level filtering cannot see (Internet Sharing, Hyper-V external vSwitch / WSL2 NAT) — the docs call it out as a limitation rather than pretending.

**Updates under isolation** come from the control plane only: the updater's GitHub fallback (`updater/pkg_source.go:34`) follows redirects to destinations outside the allowlist, so the isolation package tells the updater to skip it while an episode is active.

**Remote desktop under isolation** uses relay-only ICE (agent: pion `ICETransportPolicyRelay`; API marks the session `relayOnly` so the viewer sets `iceTransportPolicy: 'relay'`). STUN is not permitted (direct candidates can never complete anyway). Terminal, file browser, scripts' *control* path and tunnels ride the agent WebSocket and keep working; a script's child process has no network (per-process scope) — a remediation script that needs to download a tool fails under isolation, by design.

**Residual risk, stated plainly:**

- **Shared anycast addresses.** In hosted mode the control-plane permit resolves to CDN edge ranges shared by millions of unrelated sites; the public DoH endpoints and any policy extra behind a CDN have the same property. On Windows and Linux the `scope: "breeze"` permit is **application AND destination/port** — there is no parallel destination-only permit for the control plane — so only Breeze binaries can use those addresses, and only on those ports. On macOS pf cannot match a process, so any destination behind the same edge stays reachable at L3 from any process. This is the main reason OD2 recommends process scoping wherever the OS supports it, and why the macOS row in §3.5 is honest about its ceiling (Network Extension content filter = future work, §5).
- **DNS tunnelling** through the permitted resolvers (and DoH to the permitted DoH endpoints). Accepted: the alternative (no DNS) strands the agent on the first address rotation.
- **Captive portals and 802.1X.** EAPOL is L2 and unaffected. A captive portal cannot be completed while isolated; the device simply never reaches the control plane there → dead-man path (§3.6).
- **Domain-joined Windows.** Kerberos/LDAP/SMB to the DC are blocked; cached logons keep working; Group Policy pauses. Isolating a **server** (DC, file server) is an outage by design; the confirm dialog says so when the device reports a server OS.

### 3.5 Per-OS mechanism

| | Windows | macOS | Linux |
|---|---|---|---|
| Engine | Windows Filtering Platform via BFE (`fwpuclnt.dll`: `FwpmEngineOpen0`, `FwpmTransactionBegin0`, `FwpmProviderAdd0`, `FwpmSubLayerAdd0`, `FwpmFilterAdd0`), dedicated Breeze provider + sublayer (both persistent), weight above the Windows Firewall sublayer, all objects added in one BFE transaction | `pf`: anchor `com.breeze/isolation` | nftables: table `inet breeze_isolation`, base chains `input`/`output`/`forward` at priority `filter - 10`, applied as one atomic `nft -f` batch after a capability preflight |
| Why not the obvious alternative | `netsh advfirewall` / `New-NetFirewallRule` rules do persist and can be per-program, but they live in the Windows Firewall sublayer: inert when `MpsSvc` is stopped/disabled (common on servers), subject to the firewall's block-beats-allow precedence against rules we do not own, and commonly superseded when a third-party firewall registers with Security Center (not universally — corrected after the second-round quorum) | Application Firewall (`socketfilterfw`) is inbound-only; Network Extension content filter needs a separately signed system extension, an entitlement and user/MDM approval | iptables-legacy is absent on current distros and cannot coexist cleanly with firewalld/ufw's nft tables; a drop verdict in our own nft table is final regardless of what ufw/firewalld tables accept (an *accept* of ours can still be dropped elsewhere — the positive probe is what proves reachability) |
| Layers | `ALE_AUTH_CONNECT_V4/V6` (outbound) **and** `ALE_AUTH_RECV_ACCEPT_V4/V6` (inbound); existing flows are re-authorised on filter change | `in`/`out` on all interfaces except `lo0`; states flushed for non-permitted flows | `input`, `output`, `forward` hooks |
| Process scoping | `FWPM_CONDITION_ALE_APP_ID` permits for the installed Breeze binaries (agent, watchdog, helper, user helper) **combined with** destination/port conditions in the same filter; script and terminal children (`powershell.exe`, `cmd.exe`) are different executables and get nothing | none (destination permits only) | the agent's **own** processes live in a dedicated sub-cgroup (`…/breeze-agent.service/agent`, created by the agent under `Delegate=yes`); executor children (terminal, scripts — today in the same cgroup on purpose, `agent/service/systemd/breeze-agent.service` "INTENTIONALLY UNSANDBOXED") are placed in `…/children` **at spawn, before exec** (every executor and helper path, not only the terminal — `agent/internal/executor/` is the inventory; a child that briefly runs in `…/agent` is a hole) and get nothing; the permit path and level are **derived from `/proc/self/cgroup` at apply**, not hard-coded; the permit is `socket cgroupv2 level <n> "…/agent"` AND destination/port; watchdog unit likewise |
| Persistence across reboot | persistent provider/sublayer/filters load when BFE starts, before any user-mode service; the pre-BFE gap is covered by **boot-time** (`FWPM_FILTER_FLAG_BOOTTIME`) block-all filters with the destination baseline (boot-time filters cannot carry per-app conditions) | LaunchDaemon `com.breeze.isolation` (`RunAtLoad`) running `breeze-agent containment boot-apply`, which re-loads the anchor and takes a `pfctl -E` reference only if the journal's `expiresAt` is in the future. `RunAtLoad` gives **no** ordering guarantee against the network coming up; the exposure window (seconds) is documented, not hidden | systemd oneshot `breeze-isolation.service`, `Before=network-pre.target` **and** `Wants=network-pre.target` (the target is passive; without `Wants=` the ordering is vacuous), running the same `boot-apply`, same expiry check |
| Coexistence | own provider/sublayer; never touches other providers' filters; Defender/S1 isolation filters stack (most restrictive wins); a higher-weight third-party sublayer or callout that vetoes our permit is caught by the positive probe → rollback | **attach once, then anchor-only — and only onto a compatible ruleset.** The anchor must be referenced from the main ruleset, and the only way to add that reference is a main-ruleset load, which drops anchors that system services insert dynamically (Internet Sharing etc. — `/etc/pf.conf` says so in its header). So: first apply validates the current main ruleset (refuses on `set skip` covering the egress interface, a `quick pass` rule ahead of our anchor, **or service-inserted anchors that the load would destroy** → `mechanism_unavailable`), loads it **once** with our anchor appended, verifies, and from then on only ever touches `com.breeze/isolation` (`pfctl -a … -f`). Every re-verify also checks the **parent hook** still references our anchor (a main-ruleset reload by anything else silently detaches it) and re-attaches or alerts. Never `pfctl -d`; only our own `-E` reference is released with `-X`. OD13 | own table only; firewalld/ufw reloads do not flush foreign tables; a `nft flush ruleset` by an admin is caught by the 5-minute re-verify and re-applied (drift logged); cgroup recreation after a daemon-reload is reconciled |
| Sleep/resume | persistent filters survive hibernate/Fast Startup; `powerevent` resume triggers an immediate re-verify | re-verify on wake | re-verify on resume |
| Release | delete the provider's filters, sublayer, provider in one transaction; remove nothing else | `pfctl -a com.breeze/isolation -F all`, `pfctl -X <token>` (our reference only), unload the LaunchDaemon; the anchor reference in the main ruleset stays (empty anchor, harmless) | `nft delete table inet breeze_isolation`, disable + remove the oneshot unit |
| Go binding | pure-Go WFP binding (Tailscale's `wf` package is the reference; vendoring/licence decision in the plan — OD1) | `pfctl` via `exec` with a generated rules file (no library needed) | `nft -f -` via `exec` with a generated ruleset; `nft list table` for verification |

Shared agent package `agent/internal/isolation`: `Isolator` interface (`Apply(spec) (digest, error)`, `Verify(spec) (Report, error)`, `Release() error`, `Capability() Capability`), one implementation per build tag, a pure state-machine core with fuzz tests like `pamlifetime`, a **dedicated journal** `<dataDir>/isolation.json` (0600 / SYSTEM-only ACL, fsynced, `atomicrename`; episode id, generation, spec, applied digest, `expiresAt`, break-glass secret, append-only local event log with sequence numbers that the heartbeat reports) — deliberately **not** `agent.state`, which is lifecycle state the watchdog polls (`state.go:34`) — and the `containment` CLI subcommands (`boot-apply`, `expire-check`, `release --code`, `status`). The stub in `incident_response.go` dispatches to it; `account_disable` and `usb_block` keep their stubs (§5). Crash/power-loss injection at every apply/commit/release boundary is part of the unit suite (§7).

### 3.6 Fail-safes

The stack, in the order it protects: provisional apply → mandatory expiry enforced independently of the agent → offline break-glass → uninstall cleanup → (opt-in) dead-man. Each one works when the ones before it did not.

1. **Apply → verify → commit.** After writing rules the agent has 60 s to complete a **fresh** authenticated round trip (a new connection, not a pre-existing socket: a dedicated `POST /agents/isolation/:id/verify` over a new TLS session) **through the new rules** and to pass the negative probe (§3.7). Either failure → automatic rollback to the pre-apply state → `failed:control_plane_unreachable` / `failed:enforcement_not_observed`. The device is never left isolated and unreachable by the first mistake. The rollback is armed **before** the first filter is written: a journal entry plus a **one-shot** OS timer at apply + 90 s (Task Scheduler one-time trigger / `launchd` one-shot job / `systemd-run --on-active=90s`), so a crash between apply and verify still rolls back on time — the 15-minute expiry timer in item 2 cannot honour a 60-second promise on its own. **(quorum)**
2. **Mandatory expiry, enforced without the agent.** `expiresAt` is set on every episode: default 72 hours (OD5, decided), maximum 30 days, extend from the console (a new generation). The agent enforces it with no server contact, **and** so does an OS-level timer that does not depend on the agent process: a Task Scheduler task (Windows), the LaunchDaemon with `StartInterval` (macOS) and a systemd timer (Linux) run `breeze-agent containment expire-check` every 15 minutes and at boot; it releases when `expiresAt` has passed or when a provisional apply was never committed. Expiry is evaluated against the wall clock, plus — within one boot — the monotonic clock recorded at apply; a monotonic reading does not survive a reboot, so after a reboot a wall clock earlier than `appliedAt` (clock set backwards) is itself treated as expired. A clock jump therefore cannot extend isolation (OD5). **Who runs the timer matters (quorum):** if the timer invokes the same `breeze-agent` binary, a corrupted or half-upgraded binary cannot recover itself. The timer therefore runs a small, separately installed `breeze-isolation-recovery` artifact that the agent updater never replaces in place and that only knows how to read the journal and delete Breeze-owned rules (OD3). A device whose agent broke itself (failed upgrade, crash loop) is then never isolated past expiry and never stuck in a provisional apply.
3. **Offline break-glass.** `breeze-agent containment release --code <code>`, run as root/Administrator. At isolate time the server generates a random 256-bit per-episode secret, sends it inside the isolate command (encrypted sensitive payload field, §3.3) and in the heartbeat block until the agent acknowledges receipt — then never again — and stores it encrypted at rest (`APP_ENCRYPTION_KEY`, `excludedSensitive` export bucket). The code is `HMAC-SHA256(secret, isolationId ‖ generation ‖ hourBucket)` truncated to 8 base32 characters; the console shows the current and next hour's codes to anyone with release permission (viewing is audited); a technician reads it to the person at the keyboard. Verifiable with zero connectivity; the agent rate-limits attempts (5/hour); recorded as `released_locally:code` on reconnect with the local timestamp. **(quorum)** The first draft derived the key from the device credential; the server only holds credential *hashes* (`db/schema/devices.ts:20` `agent_token_hash`), so it could never mint that code — hence the per-episode secret. A server-signed offline token (Ed25519, pinned public key) is the stronger alternative but is not phone-readable; OD6. `--force` (no code) also exists — a local admin can stop the service anyway, and denying the command would only push people to delete rules by hand, which the re-verify loop would undo — but it is recorded as `released_locally:forced` and alerts (OD6).
4. **Uninstall and upgrade.** `self_uninstall` (`heartbeat/handlers_uninstall.go`), the MSI uninstall custom action, the macOS uninstall script and the Linux package `prerm` all release isolation and remove the boot hook and timer **first**. An upgrade keeps the rules: the new binary reads the journal, re-verifies, and reports. If the binary path changed (per-app permits), the upgrade re-applies before it exits the old process. Updates download from the control-plane host only while isolated (§3.4).
5. **Dead-man self-release — opt-in, default off (OD4).** When a policy enables it (`deadManSeconds > 0`), an agent that completes no authenticated control-plane contact for that long releases, journals `dead_man`, and reports `self_released` on reconnect. **The server never re-asserts on its own**: the episode is unresolved until a human acknowledges it or deliberately starts a new one. **(quorum)** The first draft had a 30-minute dead-man on by default with one automatic re-assert. The review's objection stands on two points the ECH precedent does not outweigh: an outage-triggered release is **attacker-triggerable** (cut the uplink, wait, reconnect) and **correlated** (a control-plane outage releases every isolated device in the fleet at the same minute). With items 1–4 in place the stranding risk the dead-man was meant to cover is already bounded: a bad allowlist rolls back at apply, a later break is bounded by expiry and the offline code. The dead-man stays available for MSPs that prefer availability over containment, as policy, with the trade-off spelled out in the UI.
6. **Trust and lifecycle.** `release_containment` is a lifecycle command; decommission, device delete, org-move, **device credential suspension** and **org erasure / merge** refuse while an episode is unresolved ("release isolation first") — a forced decommission queues a release and waits for it like the graceful-uninstall path. A suspended credential would cut the very channel the release travels on; if an operator forces it anyway, the device is bounded only by expiry and the offline code, and the console says so. Closing or deleting the incident never removes the release control: release routes are device-scoped, and incident delete refuses while one of its episodes is unresolved. **(quorum)** **Turning the feature flag off never strands anyone**: it blocks *new* isolations; release, extend, acknowledge and heartbeat reconciliation stay live for existing episodes.
7. **Offline isolate is queued, not rejected.** A compromised laptop that is off when the operator clicks Isolate is isolated the moment it reconnects (`commandOfflinePolicy` `queue`, `deliverBy = min(expiresAt, standard TTL)`), and the heartbeat desired state covers the case where the queued command is reaped first.

### 3.7 Verification probe

- **Positive:** an authenticated round trip to the control plane over the new rules (`verified_at` is stamped by the server from that request, not by the agent's clock).
- **Negative:** a TCP SYN to `<control-plane IP>:<a port that is not permitted>` (80 when the permit is 443; otherwise the permitted port ± 1) must fail locally within 3 s, **and the drop must be attributed to a Breeze-owned rule**: the WFP net-event / classify-drop for our filter id, the pf anchor rule counter (`pfctl -a … -vsr`), or the `counter` on our nft drop rule must increment. **(quorum)** A bare timeout is not proof — an upstream blackhole times out too. A connect, an RST, or a timeout without our counter moving means the engine is not the thing dropping (third-party sublayer with higher weight, pf disabled by policy, wrong rule set) and the apply rolls back with `enforcement_not_observed`. Same destination, no third-party canary, nothing infra-specific.
- **Steady state:** every 5 minutes, on resume and on network change the agent re-reads its rules (`FwpmFilterEnum0` / `pfctl -a … -sr` / `nft list table`), compares the digest, re-applies on drift (`drift_reapplied` journal entry), re-runs the negative probe, and gets the positive probe for free through the heartbeat. Verification that prohibited traffic actually stops is a first-class signal, reported alongside "control plane reachable", not inferred from it.

### 3.8 Audit, incident linkage, events

- **Every episode belongs to an incident.** From the incident page the incident is given; from the device page the operator picks an open incident for that device or the console creates one (`classification: 'manual_containment'`, severity chosen in the dialog, `affectedDevices: [deviceId]`) — one audit spine, the existing `incident_actions` row (`actionType: network_isolation`, `reversible: true`, `reversed` set on release), the existing timeline entries (`containment_executed` on `verified`, `containment_failed` on failure — `incidentContainmentResults.ts:63-64` — new `containment_released` on release), and `incident.contained` published when `verified` lands, exactly where `incidentContainmentResults.ts` publishes it today (OD8).
- **Audit rows** (`writeRouteAudit`): `device.isolation.request`, `device.isolation.release`, `device.isolation.extend`, `device.isolation.break_glass_code_view` (viewing a code is itself audited), with the episode id, TTL, reason and approval ref; never the resolved addresses.
- **Events:** `device.isolated`, `device.isolation_released`, `device.isolation_failed`, `device.isolation_self_released` on the event bus for webhooks/notifications; an alert rule fires on `failed`, `self_released` and `released_locally:*`.
- **Approval binding.** The `approvalRef` on the action and any four-eyes approval for `release_containment` are bound to `(org_id, device_id, isolationId, generation)` in the effect digest, re-checked under a row lock at execution; an approval minted for one generation cannot release a later one, and one minted before an org move cannot act after it.

### 3.9 Console surfaces

- **Device actions menu** (`apps/web/src/components/devices/DeviceActions.tsx`): "Isolate from network…" under the existing `can("devices","execute")` gating, disabled with a tooltip when the agent reports `networkIsolationVersion: 0` (reason shown), the OS is unsupported, the agent version is below the gate, the partner is trust-gated, or an episode is already active (then the item reads "Release isolation…"). **Release eligibility is computed separately from start eligibility** **(quorum)**: device offline, unknown/zero capability, an agent below the version gate, trust demotion, the flag off, or a closed incident never hide or disable "Release isolation…" — offline only changes the label to "Release (queued until the device reconnects)". Confirm dialog: incident picker/creator, TTL (default from policy, max 30 d), reason, remote-relay toggle, a server warning when the device is a server OS. Mutations go through `runAction` (`apps/web/src/lib/runAction.ts`).
- **Device header badge** "Isolated · expires in 6d" with the break-glass code behind a click (audited), and the state while applying/verifying, plus an "Acknowledge" action for `released_locally` / `self_released`.
- **Incident detail** (`IncidentDetailPage.tsx`): containment actions list shows the episode state live; release button there too.
- **Device list** filter "Isolated" (EXISTS on the partial index; no new `devices` column in v1).
- **Approvals / AI risk**: `tierConfig.ts` row for `release_containment` (four-eyes); `execute_containment` unchanged.
- All strings in the 8 locales (`web_new_locale_key_needs_all_locales`).

### 3.10 AI and MCP tiering

| Tool | Action | Tier / class | Notes |
|---|---|---|---|
| `execute_containment` | `network_isolation` | 3 / **supervised** (unchanged) | W04 (#6758) wires it to chat/agents; this spec only changes what happens after dispatch. The handler calls the same `networkIsolationService.start()` as the route. The AI supplies `ttlHours?` and `reason` only; never allowlist entries. |
| `release_containment` (new) | — | 3 / **four-eyes** | Per `ai.mdx:143`. Needs an `EFFECT_DIGEST_RESOLVERS` entry (effect digest = episode id + device). Rate limit 5/600 like isolate. Landed in a wave **after** W04 to avoid the shared-file conflict (`aiGuardrails.ts`, `aiToolSchemas.ts`, index budget). |
| MCP | both | fail closed (`MCP_APPROVAL_REQUIRED`); **also denied to `MCP_UNATTENDED_TIER3_PRINCIPALS`** (new) | the unattended-tier-3 opt-in otherwise lifts both tools; OD15 |

### 3.11 Interactions and gates

- **Agent version gate.** `NETWORK_ISOLATION_MIN_AGENT_VERSION` in `@breeze/shared` (pattern: `FORCE_REBOOT_MIN_AGENT_VERSION`, `packages/shared/src/utils/forceReboot.ts`), enforced in the route, the AI handler and `COMMAND_MIN_AGENT_VERSION`; fail closed (`agent_unsupported`), and the web dialog reads the same constant for its capability column.
- **Feature flag.** `NETWORK_ISOLATION_ENABLED` (API env, default `false`). Off: the start route and the AI `network_isolation` branch refuse (`feature_disabled`), **but** release/extend/acknowledge routes, the heartbeat `containment` block and the finalizer stay live so existing episodes can always be released. The agent code is inert until the server asserts state. The agent has **no** flag of its own — a device-side switch that could be flipped off while isolated is the ECH trap again. The version gate works the same way: it blocks new isolations on old agents, never the release path.
- **Maintenance lease** (`devices.maintenance_until`): independent; an isolated device may also be in maintenance.
- **Existing EDR isolation** (`edr_device_mappings.isolation_state`, S1 `/isolate`, #9118 Emsisoft): untouched. The device header shows both states side by side; a later wave may offer "isolate via vendor" vs "isolate via Breeze" in one control (§5).
- **Policy (W4, OD10).** Config-policy feature type `containment` with inline settings `{ version: 1, extraAllow: [{ host | cidr, proto, ports, label }], defaultTtlHours, deadManMinutes, remoteRelay }`, dual-axis through the existing config-policy partner-wide machinery (`configuration-policy` skill; precedent: `security_agents` in the 2026-10-12 spec). **Settings Rule 9:** home = Configuration Policies → Containment tab (not `pages/settings/**`); level = partner default → org override via policy assignment; resolver = `resolveContainmentPolicy(deviceId)` used by the route, the AI handler and the heartbeat builder; places the concept is configured before = 0, after = 1.

## 4. Tenancy & data model impact

Binding contracts (`CLAUDE.md`, `docs/agents/tenancy-rls.md`):

> *"Every tenant-scoped table has RLS enabled + forced + policies **in the same migration that creates it**. No app-layer-only fallback."*
> *"A new `org_id` table is not done until it is registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, and `CORE_TENANT_EXPORT_POLICY` — plus the device/ticket lists when it has those columns. RLS coverage does not imply cascade coverage."*
> *"Adding a column to an org-cascade table needs an export-policy classification; any `json`/`jsonb`/`bytea` column is `excludedOpen`."*
> Settings Rule 9: *"a PR that adds a setting states its home, level, resolver, and the count of places the concept is configured before and after."* (v1 adds no setting; W4's is stated in §3.11.)

**New table `device_network_isolations`** — RLS shape 1 (`breeze_has_org_access(org_id)`), policies in the same migration, `FORCE ROW LEVEL SECURITY`, idempotent, named to sort after the newest committed migration (currently `2027-01-05-100400-…`; shipped names run ahead of real time — check, don't assume), `SELECT set_config('breeze.scope','system',true)` first if it writes rows.

| Column | Type | Export bucket | Notes |
|---|---|---|---|
| `id` | uuid pk | included | |
| `org_id` | uuid NOT NULL → organizations | included | justification: device state, never a template |
| `device_id` | uuid NOT NULL | included | composite FK `(device_id, org_id) → devices(id, org_id)` `ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` — the `topology_device_presence_device_fk` shape (`migrations/2026-12-25-140000-topology-presence-read-model.sql:81`), no `ON UPDATE CASCADE` (`CLAUDE.md`: *"Every composite FK referencing an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`"*) |
| `incident_id` | uuid NULL | included | required at create; composite FK `(incident_id, org_id) → incidents(id, org_id)` `ON DELETE SET NULL (incident_id) DEFERRABLE INITIALLY IMMEDIATE` — the column-list form, because a plain `SET NULL` on a composite FK would null `org_id` too. Needs a new `UNIQUE (id, org_id)` on `incidents`, which has none today (`db/schema/incidentResponse.ts:51-89`). RLS alone does not keep the two org stamps consistent **(quorum)** |
| `incident_action_id` | uuid NULL | included | composite FK `(incident_action_id, org_id) → incident_actions(id, org_id)` (same column-list `SET NULL`, new `UNIQUE (id, org_id)` on `incident_actions`) so an episode can never point at another org's action **(quorum)** |
| `desired_state` | varchar(16) NOT NULL | included | `isolated` / `released` — the server's intent, persisted separately from the observed `state` (§3.2) **(quorum)** |
| `state` | varchar(32) | included | §3.2 states; `failure_code` separate |
| `generation` | int | included | monotonic; bumps on extend / re-send; tombstone on release |
| `acknowledged_at`, `acknowledged_by` | timestamptz / uuid NULL | included | resolves `released_locally` / `self_released` |
| `break_glass_secret_enc` | text NOT NULL | **excludedSensitive** | per-episode secret, encrypted under `APP_ENCRYPTION_KEY`; zeroed when the episode resolves |
| `requested_by_kind` | enum user/brain/system | included | |
| `requested_by_user_id` | uuid NULL → users `ON DELETE SET NULL` | included | |
| `reason` | text | included | operator text, capped 2 000 |
| `expires_at` | timestamptz NOT NULL | included | |
| `dead_man_seconds` | int NOT NULL | included | |
| `remote_relay` | boolean | included | |
| `mechanism` | varchar(16) NULL | included | wfp / pf / nft |
| `allow_snapshot` | jsonb | **excludedOpen** | what was sent; hostnames only, resolved addresses never stored |
| `last_agent_report` | jsonb | **excludedOpen** | last heartbeat block |
| `failure_code` | varchar(48) NULL | included | closed set |
| `release_kind` | varchar(24) NULL | included | console / ai / expired / dead_man / local_code / local_forced / uninstall / system |
| `command_id`, `release_command_id` | uuid NULL (no FK; `device_commands` is system-scoped and reaped) | included | |
| `requested_at`, `dispatched_at`, `applied_at`, `verified_at`, `release_requested_at`, `released_at`, `created_at`, `updated_at` | timestamptz | included | |

Indexes: `UNIQUE (device_id) WHERE state NOT IN (<resolved terminal set>)` (covers active **and** unacknowledged episodes); `(org_id, state)`; `(expires_at) WHERE state IN (<active set>)` for the expiry sweeper.

**Registration (grep, don't judge — `docs/agents/tenancy-rls.md`):** `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical; before `devices`, `incidents`, `incident_actions` since it references them), `orgMergeRegistry.ts` (`repoint`), `CORE_TENANT_EXPORT_POLICY` (buckets above), `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` **and** `CORE_DEVICE_ORG_MOVE_DELETE_TABLES`. Org-move disposition = **delete**: the rows name a source-org incident through the composite `(incident_id, org_id)` FK, so a restamp would fail with 23503 (exactly the `topology_device_presence` case in the tenancy doc); an unresolved episode **blocks the move** (§3.6 item 6), so only history is ever deleted, and `audit_logs` keep the record. **Ordering (quorum correction):** the first draft assumed delete-before-restamp; it is the other way round — `moveDeviceOrgInTransaction.ts` restamps `devices` at `:~551` and runs the move-delete loop at `:~954`. With the FK shape above, the `devices` update is checked against still-present history rows, so the plan must either delete this table's rows **before** the `devices` restamp or follow exactly what the move transaction does for `topology_device_presence_device_fk`; `moveOrg.coverage.test.ts` is the arbiter, not this paragraph. Contract suites that must go green under **Integration Tests** (not Test API): `rls-coverage`, `tenantCascade`, `orgMergeRegistry`, `tenant-export-policy`, `tenantExportErasureRoundtrip`; `moveOrg.coverage.test.ts` and `cascadeDelete.test.ts` under Test API. A stacked PR runs no CI: `gh workflow run CI --ref <branch>`.

**No new column on `devices`** in v1 (derive from the episode table). **No new config table** in v1; W4's policy is a config-policy feature (inline settings on `config_feature_links`), which inherits the existing dual-axis shape and needs no new tenancy work beyond the feature-type enum value and `PARTNER_LINKABLE_FEATURE_TYPES`.

**Device commands:** one new entry in `commandTypes.ts` (`RELEASE_CONTAINMENT`; `EXECUTE_CONTAINMENT` exists at `:235`), the generic/bulk command-route refusal (§2), `sensitiveCommandPayload.ts` registration for `breakGlass.secret`, `commandOfflinePolicy.ts`, `commandTimeouts.ts`, `commandResultHandlers.ts` (`release_containment` → the episode finalizer), `parkedFanout.contract.test.ts` classification for the new service file (`parked_fanout_and_area_gating_contract_traps`), area-gating contract for new paths.

## 5. Out of scope

- `account_disable` and `usb_block` (same stub; separate issues to file when this lands — they share nothing but the switch statement).
- A macOS Network Extension content filter (per-process control on macOS). Future work once the process-scoping gap in §3.4 proves to matter in the field.
- Bulk isolate (many devices in one request) and automated isolation from alert/EDR rules. One device per request in v1; an automation that isolates a site is a self-inflicted outage until the fail-safes have field time.
- Vendor-isolation unification (one button choosing Breeze vs S1/Defender/Emsisoft isolation, #9118).
- "Isolate but allow Windows Update / package mirrors" presets. Policy extras (W4) can express them; curated presets later.
- Per-user or per-session isolation; isolating a VM host's guests.
- Agent-side configuration of isolation (there is deliberately none).

## 6. Open Decisions

**Gate A (2026-10-25): Todd approved every recommendation as written; each item below carries its decision.** Each item: options, then **Recommend**. Items marked **[quorum]** are where the independent codex read-only review (GPT-6, xhigh; record in Appendix A) disagreed or added a constraint; nothing was silently resolved.

**OD1 — Windows engine.** (a) WFP via BFE with persistent filters and per-app permits (needs a pure-Go binding; Tailscale `wf` as reference/vendor candidate, licence check in the plan). (b) `netsh advfirewall` rules. (c) WFP for enforcement, `netsh` only for the Windows Firewall *profile* display. **Recommend (a):** (b) is silently inert on hosts with the firewall service off or a third-party firewall registered, which is exactly the compromised-server case this feature exists for.

> **Decided 2026-10-25 (Gate A, Todd):** (a) WFP via BFE, persistent filters, per-app permits; the Go binding/licence choice is made in plan W1f Task 1 (Gate B decision 2).

**OD2 — Process scoping as the only control-plane permit (Windows, Linux).** (a) `scope: "breeze"` entries are per-app/per-cgroup only; no destination permit to the control plane for other processes. (b) Destination permits for everyone (simpler, porous through shared anycast edges). **Recommend (a)** on Windows and Linux, (b) necessarily on macOS, documented. The DNS/DHCP baseline stays destination-based on all three because the OS resolver/DHCP client, not the agent, sends those packets.

> **Decided 2026-10-25 (Gate A, Todd):** (a) on Windows and Linux (app/cgroup AND destination/port, no destination-only control-plane permit); (b) on macOS, documented.

**OD3 — Boot hooks and the independent timer.** (a) OS-native boot enforcement (WFP persistent + boot-time filters; LaunchDaemon; systemd oneshot `Before=`/`Wants=network-pre.target`) plus an agent-independent expiry timer, each honouring `expiresAt`. (b) Agent re-applies at start only (a window of seconds to a minute where the device is online and un-isolated; longer if the agent fails to start). **Recommend (a):** the window is exactly when a rebooted compromised host beacons out, and an installed artifact that the uninstaller removes is cheap. **[quorum: agree on (a); ADD on who runs it.]** Second-round review (2026-10-24): a timer that invokes the same `breeze-agent` binary cannot recover from that binary's own corruption or a half-applied upgrade, and a 15-minute poll cannot honour the 60-second provisional rollback. Sub-decision **OD3b:** (i) timers run a separate, minimal `breeze-isolation-recovery` artifact the updater never replaces in place, plus a one-shot provisional-rollback timer at apply + 90 s; (ii) timers run `breeze-agent` itself (one artifact, simpler signing/packaging, no recovery from a broken binary). **Recommend (i)** — it is one more signed file per OS, and it is the only path that still releases when the agent cannot start. macOS `RunAtLoad` orders nothing relative to the network, so the macOS boot window is documented rather than claimed away.

> **Decided 2026-10-25 (Gate A, Todd):** (a), with OD3b (i): a separate `breeze-isolation-recovery` artifact runs the expiry timer, plus a one-shot provisional-rollback timer at apply + 90 s.

**OD4 — Dead-man self-release. [quorum: disagreed with the first draft; recommendation changed.]** (a) **Off by default; opt-in per policy; when it trips, no automatic re-assert — a human acknowledges and re-isolates.** (b) First draft: 30-minute dead-man on by default, one automatic server re-assert, then `degraded`. (c) TTL only, no dead-man at all. **Recommend (a).** The review's two objections to (b) hold: a release triggered by loss of contact is attacker-triggerable (cut the uplink, wait, reconnect) and correlated across the fleet (a control-plane outage would un-isolate every contained device at once). The stranding risk (b) was meant to cover — the ECH precedent — is already bounded by the provisional apply, the agent-independent expiry timer and the offline code. (c) removes a knob some MSPs will want for availability; keeping it as explicit policy costs little. **Todd's call:** whether the knob exists at all, and the default. My position before the quorum was (b); I now hold (a).

> **Decided 2026-10-25 (Gate A, Todd):** (a) dead-man off by default, opt-in per policy (W4), no automatic re-assert; a human acknowledges and re-isolates.

**OD5 — Expiry defaults. [quorum: disagreed; unresolved.]** (a) default 7 d, max 30 d, extendable (first draft). (b) **default 72 h, max 30 d, extendable, with an "expires in 12 h" alert to the requester and the incident owner.** (c) a short lease in hours (e.g. 8–24 h) with deliberate renewal (codex's position: the TTL is the release bound when the console path is broken, so it should be short). (d) no maximum. **Recommend (b):** 72 h covers a weekend without anyone renewing, the alert catches the forgotten-device case, and console release / offline code cover the stranded case far sooner than any TTL; an hours-scale lease (c) risks a compromised host silently un-isolating overnight when nobody renews. Codex holds (c); Todd's call.

> **Decided 2026-10-25 (Gate A, Todd):** (b) default 72 h, max 30 d, extendable, "expires in 12 h" alert to the requester and the incident owner. §3.6 item 2 is updated to match.

**OD6 — Break-glass shape. [quorum: key-source correction accepted; shape still open.]** (a) per-episode secret shared with the agent at isolate time; 8-character hourly HMAC codes shown in the console; plus `--force` (forced release alerts). (b) same codes, **no** `--force`. (c) server-signed offline release token (Ed25519, public key pinned at apply) — unforgeable even if the database leaks, but ~100 characters: paste/QR, not phone-readable. (d) no local release at all. **Recommend (a):** the first draft's "derive from the device credential" was wrong — the server stores token hashes (`devices.ts:20`) and could not compute the code — so the secret is minted per episode and stored encrypted. (c) is the stronger primitive and worth keeping as a W4 addition for high-assurance tenants; (d) hides the release from the audit trail because a local admin can stop the service regardless. If Todd wants (b), the fallback becomes "stop the service", which the watchdog fights. **Second-round quorum (2026-10-24) still prefers (c) now, not in W4**, and found a real hole in (a) as first written: the secret went out "once" in the isolate command, but an isolation first applied from the heartbeat desired state (queued command reaped) never received it. Fixed in §3.3 (secret rides the heartbeat block until the agent acknowledges it; encrypted as a sensitive payload field; erased at terminal). With that fix I keep **(a)** for v1 because an 8-character code is readable over the phone to a user at a dead laptop, which is the case break-glass exists for; (c)'s database-leak resistance is real and is the W4 upgrade. Disagreement stands.

> **Decided 2026-10-25 (Gate A, Todd):** (a) per-episode secret, 8-character hourly HMAC codes in the console, plus `--force` (alerts) in v1; the server-signed Ed25519 offline token (c) lands in W4.

**OD7 — Human release gate.** (a) one person with `devices:execute` + MFA (S1 precedent). (b) four-eyes for humans too (a different user than the requester). **Recommend (a):** the person watching a stranded device must be able to release it at 03:00; the AI path stays four-eyes.

> **Decided 2026-10-25 (Gate A, Todd):** (a) one person with `devices:execute` + MFA + an interactive session; the AI release stays four-eyes.

**OD8 — Incident linkage.** (a) every episode belongs to an incident; device-page isolate auto-creates one. (b) standalone device action, incident optional. **Recommend (a):** one audit spine, the existing `contained` transition and `incident.contained` event, and the AI tool already requires an incident.

> **Decided 2026-10-25 (Gate A, Todd):** (a) every episode belongs to an incident; the device-page isolate auto-creates one.

**OD9 — Remote desktop while isolated.** (a) relay-only ICE allowed, TURN permitted. (b) blocked. **Recommend (a):** the investigating technician needs the screen; every EDR keeps its own remote shell during isolation; self-hosters without TURN simply lose it.

> **Decided 2026-10-25 (Gate A, Todd):** (a) relay-only ICE, TURN permitted.

**OD10 — Where the isolation policy lives and when.** (a) W4 config-policy feature `containment` (dual-axis, partner-wide first), v1 ships fixed defaults and no extra allowlist. (b) v1 ships the policy too. (c) fields on an org-settings row (org-first, violates Partner-Wide First). **Recommend (a):** the mechanism needs field time before MSPs can safely widen the hole; the per-request `scope:"any"` door stays shut until then.

> **Decided 2026-10-25 (Gate A, Todd):** (a) W4 config-policy feature `containment`, partner-wide first; v1 ships fixed defaults and no extra allowlist.

**OD11 — Linux without nftables.** (a) `unsupported_platform` (fail closed, device untouched). (b) iptables-legacy fallback. **Recommend (a):** current distros ship nft; a second code path on the OS with the fewest managed endpoints is cost without a customer.

> **Decided 2026-10-25 (Gate A, Todd):** (a) `unsupported_platform`, device untouched; no iptables fallback.

**OD12 — Wave order.** (a) W1 server + contracts + framework + **Windows**; W2 Linux; W3 macOS; W4 policy + AI release tool + docs. (b) Linux first (cheapest lab). **Recommend (a):** MSP fleets are Windows-heavy and the Windows lab VM exists; Linux follows in the same framework at low cost. Second-round quorum ADD, adopted: W1 is not shippable without the console release path, the recovery artifact, uninstall cleanup and the break-glass runbook doc — those are W1 scope, not W4.

> **Decided 2026-10-25 (Gate A, Todd):** (a) W1 server + contracts + framework + Windows (including console release, recovery artifact, uninstall cleanup and the break-glass runbook); W2 Linux; W3 macOS; W4 policy + AI release + signed offline token + dead-man opt-in.

**OD13 — macOS anchor attachment. [quorum: disagreed with the first draft; recommendation changed.]** (a) **Attach once, then anchor-only:** the first apply validates the live main ruleset, loads it once with `anchor "com.breeze/isolation"` appended, verifies, and thereafter only reloads the Breeze anchor; the one-time load drops anchors that system services inserted dynamically (Internet Sharing, documented in `/etc/pf.conf`'s header) — accepted and logged. (b) First draft: load a wrapper ruleset (`include /etc/pf.conf` + our anchor) on **every** apply and reload `/etc/pf.conf` alone on release — repeats that loss on every apply/release and races any other pf user. (c) Squat Apple's `com.apple/*` wildcard anchor so no main-ruleset load is needed — works today, unsupported, and Apple may flush it. (a′) **Attach once, but only onto a compatible ruleset:** as (a), except that when the live ruleset holds service-inserted anchors the one-time load would destroy, the apply refuses (`mechanism_unavailable`, reason shown) instead of destroying them; every re-verify checks the parent hook still references our anchor. **Recommend (a′).** The second-round quorum (2026-10-24) **disagreed with (a)**: silently breaking Internet Sharing or another product's pf anchors on a customer machine is not acceptable collateral, and an unverified parent hook can be detached by any later main-ruleset reload. Refusing costs coverage on Macs with Internet Sharing or a third-party pf user active; that is the honest trade. Also adopted: never `pfctl -d`, only release our own `-E` reference; refuse to apply when `set skip` covers the egress interface or a `quick pass` precedes our anchor (the negative probe would catch it, but refusing early is cheaper than a rollback).

> **Decided 2026-10-25 (Gate A, Todd):** (a′) attach once, only onto a compatible ruleset; refuse (`mechanism_unavailable`) when the load would destroy service-inserted anchors; re-verify the parent hook every cycle; never `pfctl -d`.

**OD14 — Linux: where the agent's children live. [quorum raised it; design requirement, confirm.]** Scripts and terminals run in the agent's cgroup today on purpose (`agent/service/systemd/breeze-agent.service`, "INTENTIONALLY UNSANDBOXED"). A cgroup permit at the unit level would hand every remediation script the control-plane destinations — in hosted mode, shared CDN edges. (a) **The agent moves itself into `…/agent` and its executor children into `…/children` under `Delegate=yes`; the permit matches `…/agent` only.** (b) Permit the whole unit and accept that scripts can reach the control-plane addresses. **Recommend (a).** The 2026-06-09 systemd-sandbox design's constraints (no sandboxing inherited by children) are untouched: cgroup placement is not a sandbox directive. Second-round quorum: **agree**, with the requirement (now in §3.5) that placement happens at spawn, before exec, on every executor path.

> **Decided 2026-10-25 (Gate A, Todd):** (a) agent in `…/agent`, executor children in `…/children` under `Delegate=yes`, placed at spawn before exec on every executor path; the permit matches `…/agent` only.

**OD15 — Unattended MCP principals. [quorum raised it.]** `MCP_UNATTENDED_TIER3_PRINCIPALS` lets an operator-listed MCP principal call core-registry tier-3 tools with no approval (`routes/mcpServer.ts:~1444`). (a) **Deny `execute_containment:network_isolation` and `release_containment` to unattended principals too**, with a contract test. (b) Let the opt-in cover them (an MSP's own SOAR could isolate unattended). **Recommend (a):** an unattended release is exactly the attacker-with-a-key path the four-eyes rule exists to stop, and unattended isolation is the bulk/automated isolation §5 defers; revisit with the automation wave.

> **Decided 2026-10-25 (Gate A, Todd):** (a) `execute_containment:network_isolation` and `release_containment` are denied to `MCP_UNATTENDED_TIER3_PRINCIPALS`, with a contract test.

## 7. Test & rollout notes

**Red first everywhere** (agent-shipped, privileged). Unit: the pure state machine (fuzz, like `pamlifetime/state_machine_fuzz_test.go`), allowlist resolution/merging, rule generation per OS against golden files, expiry/dead-man clocks with fake time, HMAC break-glass vectors, the `CommandResult` contract. Server: route guards (scope, permission, MFA, trust), episode transitions, heartbeat reconcile matrix (desired × reported × revision), result finalizer, reaper, flag-off behaviour, version gate, RLS/cascade/export contract suites (Integration Tests). Web: `DeviceActions` permission/disable matrix, dialog, badge, `runAction` allowlist test, locale parity, `tierConfig`.

**Per-OS lab legs Todd owes before any promote** (disposable VMs only — never a second agent on a host that runs the installed agent, `feedback_no_lab_agent_on_host_with_installed_agent`):

| Leg | Checks |
|---|---|
| **Windows** 11 + Server 2022 nested VM | isolate → heartbeat + WS continue on a **fresh** connection, an already-open outbound session (e.g. a running `curl` download) is cut, browsing/RDP/SMB blocked, remote desktop via relay works, scripts' children have no network; reboot → still isolated before the service starts (boot-time + persistent filters); `MpsSvc` disabled → still isolated; a third-party firewall present (optional); break-glass code; `--force` alerts; dead-man only with the policy on (block the control plane at the hypervisor, wait, observe release → reconnect → `self_released`, no re-assert); TTL expiry while offline **with the agent service stopped** (timer path); clock jump forward/back; MSI upgrade keeps rules, MSI uninstall removes them; hibernate/resume and Fast Startup; a Hyper-V/WSL2 guest's traffic (document what is and is not covered) |
| **macOS** Sequoia tart VM | first-apply attaches the anchor once, second apply touches only the anchor; coexists with Apple anchors; LaunchDaemon re-applies on reboot (measure the window); `pfctl -d` by an admin → re-verify re-applies; pf states of an open connection are flushed; break-glass; pkg uninstall removes anchor + daemon + timer; MDM push still blocked (documented) |
| **Linux** Ubuntu 24.04 (+ufw) and Rocky 9 (+firewalld) VMs | nft table + `…/agent` sub-cgroup permit, a remote-terminal `curl` to the control-plane host **fails**; `ufw reload` / `firewall-cmd --reload` and `systemctl daemon-reload` leave isolation in place; reboot ordering (`network-pre.target`, `Wants=`); no-`nft` box → `unsupported_platform`; package remove cleans the unit + timer; systemd-resolved stub path; a Docker container on the host cannot reach out (forward chain); IPv6-only / DNS64 network |
| **All** | ECH/DoH path still fetches config while isolated (optional, needs the #8869 filter rig); offline isolate queued then delivered; the negative probe rejects a deliberately broken rule set; DHCP renewal and a DHCP address change while isolated; 802.1X re-authentication; a VPN client's outer tunnel is blocked and the device still reaches the control plane directly; `HTTPS_PROXY` set for the service; device credential rotation while isolated (`heartbeatCredentialMaintenance.ts`) does not break the episode; crash injection (kill -9 between apply and verify → rollback **within the 90 s one-shot timer**; between verify and commit → re-verify on restart); a late `completed` result after the server timed the command out is ignored; **corrupt / half-upgraded `breeze-agent` binary → the recovery artifact still releases at expiry**; isolation first applied from the heartbeat (queued command reaped) → offline code still works; release after the requesting user is disabled, the partner is trust-demoted, and the flag is turned off |

Server-side tests added by the second-round quorum: generic `POST /devices/:id/commands` and the bulk route reject `execute_containment:network_isolation` and `release_containment`; an `MCP_UNATTENDED_TIER3_PRINCIPALS` principal is denied both; `breakGlass.secret` is encrypted in `device_commands.payload` and erased at terminal; heartbeat keeps the release tombstone until the agent reports `released`; release stays visible and enabled under every start-gate failure (offline, version, trust, flag, closed incident); credential suspension / org erasure / incident delete refuse while an episode is unresolved. macOS leg adds: **Internet Sharing on → apply refuses (`mechanism_unavailable`), nothing destroyed**; a main-ruleset reload by an admin detaches the parent hook → re-verify detects it.

| Leg (cont.) | Checks |
|---|---|
| **Negative-probe attribution** (all OSes) | an upstream blackhole on the probe port (hypervisor-level drop) with our engine disabled → apply **rolls back** (timeout without our counter moving); with our engine on → counter increments, apply commits |

**Gates and promote plan.**
1. `NETWORK_ISOLATION_ENABLED=false` default; agent code ships inert; `NETWORK_ISOLATION_MIN_AGENT_VERSION` pinned to the first agent release carrying W1.
2. Enable on the lab org only (region env var), run the Windows leg against release binaries, then the other legs as their waves land.
3. Canary partner (own fleet), one week, watch `device.isolation_failed`/`degraded` rates and the dead-man journal.
4. Fleet enable; agent promote per the release skill (clear canary pins at promote — `canary_pins_must_be_cleared_at_promote`).
5. Docs in the same waves: `incident-response.mdx` (replace the "comes back as a platform-specific-implementation error" sentences), `ai.mdx` tool tables, `SECURITY_PRACTICES.md` §containment, `ADMIN_GUIDE.md` 10.3, a new "Network isolation" page with the break-glass runbook and the residual-risk statement; `aiGuardrailsAiDocs.parity.test.ts` pins the ai.mdx rows.

**CI traps for the plan:** stacked waves on a sibling base run no CI; the AI-tool contract suites red only in the Test API shards; `SAFE_WRITE_SITES` is line-keyed; `KNOWN_MISSING_TOOL_TIERS` is shrink-only (the `release_containment` tool must be registered and classified in the same PR, spec D2 of the AI full-control design); `humanizedKeyBaseline.json` and locale parity for every new key.

## Appendix A — Advisor quorum record

Independent read-only review: `codex exec`, gpt-6-astra, `model_reasoning_effort="xhigh"`, `-s read-only`, run against this worktree on 2026-10-25 with my first-draft position (the eight numbered items below) as the prompt. Every claim it made about the code was re-checked by hand before being adopted; file:line references in the table are mine.

| # | My first-draft position | Codex verdict | Resolution |
|---|---|---|---|
| 1 | Windows: WFP via BFE, persistent filters, per-app permits | **Agree**, with qualifications: persist provider+sublayer too; filter both `ALE_AUTH_CONNECT` and `ALE_AUTH_RECV_ACCEPT`; persistent ≠ boot-time (pre-BFE gap needs boot-time filters); high weight does not beat a vetoing callout | Adopted in §3.5 (transaction, both layers, boot-time filters, probe covers vetoes) |
| 2 | macOS: wrapper ruleset `include /etc/pf.conf` + anchor on every apply; reload `/etc/pf.conf` on release | **Disagree**: a main-ruleset load drops service-inserted anchors (`/etc/pf.conf` header confirms); `RunAtLoad` orders nothing; never `pfctl -d` | Position changed → **OD13** (attach once, anchor-only, own `-E` reference, documented boot window) |
| 3 | Linux: nftables, cgroup permit for `breeze-agent.service`, no iptables fallback | **Disagree on the permit**: scripts/terminals run in the same cgroup by design (`breeze-agent.service` comment) so the permit would include them; agree on nft and no fallback; preflight + one atomic batch | Position changed → **OD14** (sub-cgroups `…/agent` vs `…/children`), §3.5 |
| 4 | Allowlist: destination permits + blanket established, 5-min re-resolve | **Disagree**: existing attacker flows must be cut (re-auth / state flush / `ct mark`); resolve before dialing; refresh on network change; bounded last-known-good (`netcache` only covers DNS failure); include proxy; shared-IP caveat also applies to extras and DoH | Adopted in §3.4 |
| 5 | Fail-safe: 30-min dead-man on by default + one auto re-assert; HMAC code keyed from the device credential; state in `agent.state` | **Disagree**: dead-man is attacker-triggerable and fleet-correlated — TTL + agent-independent recovery by default, dead-man only as explicit policy, human re-authorisation after a self-release; server holds only credential hashes (`devices.ts:20`) so it cannot mint that HMAC — use a server-minted/signed offline token; keep a separate fsynced journal; arm rollback/expiry before filtering | Position changed → **OD4** (opt-in, no re-assert), **OD6** (per-episode secret; signed token as the stronger alternative), §3.5 journal, §3.6 items 1–2 |
| 6 | Episode table, RLS shape 1, heartbeat reconciliation, lifecycle release | **Agree** with mandatory refinements: separate desired / observed / delivery; monotonic generations + release tombstones + stale-result rejection (the generic finalizer re-opens on a late agent success, `incidentContainmentResults.ts:108-113`); uniqueness over every unresolved episode; composite device/org **and** incident/org FKs; flag/version gates must never block release | Adopted in §3.2, §3.3, §3.11, §4 |
| 7 | Human isolate/release = `devices:execute` + MFA; AI release four-eyes; API keys excluded by `requireMfa` | **Agree** on the human/AI split; **correction**: `requireMfa()` is not an API-key exclusion and is void under `ENABLE_2FA=false` — require an interactive human session explicitly; bind approvals to episode/generation; keep the sole-operator WebAuthn fallback (`ai.mdx:183`); shared orchestration for human and AI paths; `/contain` stays record-keeping | Adopted in §2 (`requireInteractiveSession()`), §3.3 routes, §3.8 approval binding |
| 8(i)–(iv) | Open questions | TTL + independent recovery by default; app **and** destination/port with no destination-only control-plane permit; boot hooks yes (`Wants=network-pre.target`; macOS window documented); test renewals/reconnects, captive portals, VPN outer transport, proxy auth, 802.1X re-auth, DHCP change, DNS64/NAT64, ICMPv6 PTB, sleep/hibernate, clock jumps, credential rotation, firewall reloads, partial upgrades; DCs/DNS/DHCP/gateways acknowledged as outage-by-design, do not broadly permit Kerberos | Adopted in §3.4 (PMTUD ICMP, forward chain), §3.6, §7 lab table |
| missed | — | Forwarded/container/VM traffic and flowtable offload; verify prohibited traffic stops, not only that the control plane works; crash/power-loss injection at every boundary; isolation-aware update downloads (GitHub redirects) | Adopted in §3.4, §3.5, §3.7, §7 |

Where the review and I still differ after checking the code, the OD says so and gives both positions (OD4 default, OD6 shape). Nothing was resolved silently.

**Provenance note.** No codex session log for this first round could be found on the host when the spec was resumed (the drafting session ended on an account spend limit). Treat Appendix A as the first author's record, not independently re-verified; the second round below was run and its claims were checked against code by hand.

## Appendix B — Second-round quorum (2026-10-24)

`codex exec`, gpt-6-astra, `model_reasoning_effort="xhigh"`, `-s read-only`, prompt via stdin. The reviewer was asked to form its own position on (A) per-OS mechanism, (B) allowlist + fail-safes, (C) AI/MCP tier **before** reading the draft, then grade every OD and section and list wrong citations. Headline verdict: *"Do not approve as written. The design is promising, but recovery, dispatch bypasses, reconciliation, and schema details need correction."* Each item below was checked against code at `dd2556224f` before being adopted.

| Finding | Checked | Resolution |
|---|---|---|
| Generic single/bulk command routes accept `execute_containment` with caller payloads — bypasses the service, allowlist and "no bulk" (`routes/devices/schemas.ts:309, 352`) | confirmed | Adopted: §2 refusal, §4, §7 test |
| `MCP_UNATTENDED_TIER3_PRINCIPALS` lifts tier 3 over MCP; "MCP denied" was wrong (`routes/mcpServer.ts:~1444`) | confirmed | Adopted: §2, §3.10, **OD15** |
| Break-glass secret would sit in plaintext system-scoped `device_commands.payload` (`sensitiveCommandPayload.ts:15-24`) | confirmed | Adopted: §3.3 |
| Once-only secret delivery fails when the isolation is first applied from the heartbeat | confirmed by reading §3.3/§3.6 together | Adopted: deliver until acknowledged (§3.3); OD6 shape still disputed |
| Move-org ordering reversed: `devices` restamp precedes the move-delete loop (`moveDeviceOrgInTransaction.ts:~551` vs `:~954`) | confirmed | Adopted: §4 FK shape + ordering note |
| `incidents` has no `UNIQUE (id, org_id)`; composite `SET NULL` would null `org_id` | confirmed (`incidentResponse.ts:51-89`) | Adopted: §4 |
| Failure timeline event is `containment_failed`, not `containment_attempted`; only one command type is new | confirmed (`incidentContainmentResults.ts:64`, `commandTypes.ts:235`) | Fixed |
| "No firewall code under agent/" — Linux BMR runs `iptables-restore` | confirmed (`bmr/restore_linux.go:499`) | Fixed §1 |
| Never model isolation as `quarantined` — blocks agent auth and therefore console release | confirmed (`agentAuth.ts:761`) | Adopted: §3.1 item 7 |
| Negative probe: an upstream blackhole also times out | reasoning | Adopted: counter attribution, §3.7, §7 |
| 15-min timer cannot honour 60 s rollback; same binary cannot recover its own corruption; monotonic clock does not survive reboot | reasoning | Adopted: one-shot timer, recovery artifact (**OD3b**), clock rule (§3.6) |
| Heartbeat `null` loses release ordering; resends should not bump generation; persist desired state | reasoning | Adopted: §3.2, §3.3, §4 `desired_state` |
| Proxy permit must be Breeze-scoped | reasoning | Adopted: §3.4 |
| Flowtable-offloaded flows bypass a forward chain | kernel docs (not re-read here) | Adopted as assumption + lab check, §3.4 |
| Release eligibility must be separate from start gates; credential suspension / org erasure / incident delete must not strand | reasoning | Adopted: §3.6 item 6, §3.9 |
| Linux child cgroup placement must be atomic at spawn on every executor path | reasoning | Adopted: §3.5, OD14 |
| OD5: 7 d default too long — hours with renewal | **disagree** | Draft moved to 72 h + alert; codex still prefers hours → OD5 |
| OD6: signed offline token now | **disagree** | Kept per-episode HMAC code for v1 (phone-readable), token in W4 → OD6 |
| OD13: accepting destruction of service anchors is unsafe | agree with codex | Recommendation changed to (a′) refuse-on-incompatible |
| Line numbers `aiGuardrails.ts:759`, `ai.mdx:76/116` "wrong" | **not wrong** — correct at the draft's base `e93705f861`; `ai.mdx` moved with #9767. Spec now cites `dd2556224f` lines (`:754`, `:143`, `:183`) | Noted |
