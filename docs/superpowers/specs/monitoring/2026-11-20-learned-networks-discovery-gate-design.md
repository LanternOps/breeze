# Learned networks: run discovery on the network you meant

Date: 2026-11-20
Status: Proposed. Awaiting owner approval. Codex (gpt-6.2-astra, xhigh) and a builder check read the
**first draft**; Codex returned "agree with changes" (section 15). Written after those reads and not
independently reviewed in full: the stored gated flag, interface binding, the attempt record and
per-site lock, and the two merge forms. Credential grants (8.3) had two narrow Codex reads; the outcome
of each is in section 15.
Related: #5905 (known-networks registry idea, slice 2), #7884 (site assignment vs observed location, shipped), #7969 (pinned scan agent, shipped).
Companion: [site location design](2026-10-03-topology-site-location-design.md) (SL).

## 1. Problem

A discovery profile targets an IP range. The scan runs from an agent chosen by its **site of record**,
ranked by "has an address inside the range" (`jobs/discoveryAgentSelection.ts`). A laptop assigned to the
office that is at home on the same range (192.168.1.0/24 at both) qualifies and even ranks first. The
agent scans whatever network it is on. The result:

- the scan, including the profile's SNMP settings, runs against an employee's home LAN;
- home devices are written into the office inventory (`discovered_assets` is unique on org + IP), and feed
  baseline change events and auto-linking;
- nobody can tell from a job or an asset which physical network was scanned.

An IP range does not identify a network. A gateway does.

Observed on a production org (2026-11-20, read-only): one site, three roaming laptops, one unpinned
scheduled profile for 192.168.1.0/24. The presence read model held **two different gateway MACs for
192.168.1.1 at the same time**, each reported by a single device. The gateway MAC does tell the two
networks apart, but with one observer each nothing in the product can say which one is the office.
An admin has to.

## 2. What the owner decided

| # | Decision | Date |
|---|---|---|
| O1 | Networks are learned and identified by the gateway IP + MAC combination, in their own table. | 2026-11-20 |
| O2 | A learned network is assigned to a site by an admin and then used for that site's discovery jobs. | 2026-11-20 |
| O3 | Enforcement is two-sided (approach A): the server only picks agents on the network, and the agent verifies the gateway itself immediately before scanning. | 2026-11-20 |
| O4 | Asset inventory is **not** re-keyed by network. Ranges only collide through roaming laptops, never between two sites of one customer. | 2026-11-20 |
| O5 | Track WAN addresses as part of this work. | 2026-11-20 |
| O6 | No automatic site reassignment of devices, ever (SL section 2). This design never moves a device. | 2026-10-03 |

Everything else in this document is a proposal by the author. The calls that change behavior are listed
in section 13 so they can be rejected individually. One decision is still the owner's (section 12).

## 3. Goals, non-goals, anti-goals

**Goals**

1. Learn every network an agent attaches to, for every org, with no dependency on the topology feature
   flags (network-context collection is off unless `materialization` is on, `services/topology/flags.ts`).
2. Let an admin see learned networks, tell the office from a home, and assign one to a site.
3. Once a site is gated, no discovery scan for that site runs behind a gateway that is not one of its
   assigned fingerprints. This covers profile runs, schedules, baseline scans and the AI
   `network_discovery` tool.
4. Fail closed with a reason a technician can act on.
5. Record which network each job scanned, and the WAN addresses seen per network over time.

**What the guarantee is.** The promise is a **fingerprint match proven fresh on the interface the scan
is bound to**. It is not proof of physical location: two unrelated routers can present the same address
and MAC (section 11). Copy never says "verified location".

**Non-goals**

- Re-keying `discovered_assets`, `network_baselines` or `network_change_events` by network (O4).
- Classifying networks as office, home or public; linking a network to a contact; network-scoped policies
  (#5905 slices 1 and 3).
- Auto-assigning networks to sites, including a bulk "accept all suggestions" action.
- IPv6. v1 identifies networks by IPv4 default gateway only (same limit as SL D10: IPv6 next hops are
  link-local and repeat on every LAN).
- A per-device WAN history. WAN history is per network.
- AI/MCP tools that list or assign learned networks.

**Anti-goals** (the feature has failed if any of these can happen)

- A scan for a gated site sends a probe out of an interface whose gateway is not an assigned fingerprint.
- A gated site returns to unrestricted scanning without an admin choosing that.
- Saved SNMP secrets are sent behind a gateway nobody entered them for.
- Assigning or learning a network changes any device's site.
- A fleet-wide agent or API upgrade stops existing scans at sites nobody has gated.

## 4. Approaches considered

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| A | Learned-networks table; server picks only agents on the network; agent proves the gateway fresh and binds the scan to that interface. | Needs an agent release. Older agents cannot scan for gated sites. The only option that holds when the server's view is stale. | **Chosen (O3).** |
| B | Same table, server-side check only. | No agent change. The server's view can be minutes old, so a laptop that just left can still scan a home LAN. | Rejected. |
| C | Reuse the presence read model (`topology_device_presence`), no new table. | No migration. Exists only where topology is on, and on a common range it needs three or more site agents to notice a different router (SL 6.4), so it misses the small-office case in section 1. | Rejected. |

## 5. How it works, end to end

1. **Report.** Every agent that supports it reports its current network attachments in the heartbeat:
   for each IPv4 default route on a real LAN interface, the gateway IP and the gateway's MAC.
2. **Learn.** The API turns each (gateway IP, gateway MAC) pair it has not seen in that org into a new
   learned network, unassigned. It records which devices were seen on which network and the WAN address
   those heartbeats came from.
3. **Assign.** On Discovery, a new Networks tab lists learned networks with the evidence needed to tell
   them apart. An admin assigns one to a site.
4. **Gate.** The first assignment marks the site *gated*: its scans are sent only to an agent currently
   on one of its networks, as a guarded command that names the gateways the agent must be behind.
5. **Prove and bind.** The agent gets a fresh answer from the gateway, binds every probe to that
   interface, and re-proves before using credentials and before reporting. A change cancels the scan.
6. **Record.** The job stores the network it ran on.

A site that has never been gated behaves exactly as today. The Profiles tab says so.

**Gated is a stored property of the site, not a count of its networks.** It turns on with the first
assignment and turns off only when an admin says so. A gated site that loses its last network, by any
path, stops scanning (`no_network_assigned`) instead of quietly returning to the old behavior.

## 6. Data model

Five new tables, all direct `org_id` (tenancy shape 1): RLS enabled and forced with the four standard
`breeze_has_org_access(org_id)` policies in the creating migration.

`org_id NOT NULL` justification (Partner-Wide First): these are observations made by one org's devices
plus an assignment to one of that org's sites. They are inventory, not policy, and there is nothing a
partner would define once and apply to many orgs.

**Every reference between these tables, and from `discovery_profiles`, `discovery_jobs` and
`discovered_assets` to them, is a composite FK that includes `org_id`**, `DEFERRABLE INITIALLY
IMMEDIATE`, so a row can never name another org's network. Where deletion clears a link, the action
names only the nullable column (`ON DELETE SET NULL (network_id)`), as the pinned-device migration does.

**`learned_networks`**: the named, assignable thing.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | Unique `(id, org_id)` for the composite FKs. |
| `org_id` | uuid NOT NULL | |
| `site_id` | uuid NULL | Assigned when set. Composite FK to `sites(id, org_id)`. Deleting a site returns its networks to unassigned; it does not delete them. |
| `name` | varchar(255) NULL | Admin label. Default display is "`<prefix>` via `<gateway>`". |
| `prefix` | cidr NULL | Last LAN prefix observed on this network. Display and suggestion only, never identity. |
| `ignored_at` | timestamptz NULL | Hidden from "Needs review". CHECK: not both assigned and ignored. |
| `assigned_by`, `assigned_at` | uuid NULL → users (SET NULL), timestamptz NULL | |
| `first_seen_at`, `last_seen_at`, `created_at`, `updated_at` | timestamptz | |

**`learned_network_gateways`**: the identity. One network has one or more fingerprints.

`id`; `org_id`; `network_id`; `gateway_address` inet NOT NULL; `gateway_mac` macaddr NOT NULL;
`first_seen_at`; `last_seen_at`. **Unique `(org_id, gateway_mac, gateway_address)`.**

**`learned_network_devices`**: which devices have been seen behind which fingerprint. Rows persist
after the device leaves, so the Networks tab can show "5 devices in the last 14 days" at midnight.

`id`; `org_id`; `device_id` (composite FK to `devices(id, org_id)`, cascade); `gateway_id` (composite FK
to `learned_network_gateways`, cascade); `interface_name`; `local_address` inet; `is_primary` boolean
(this interface carries the route to the Breeze server); `is_current` boolean; `first_seen_at`;
`last_seen_at`. **Unique `(device_id, gateway_id)`**: membership is per fingerprint, and the network is
read through the fingerprint, so a device attached behind two gateways of one network has two rows and
a network merge never collides. Written **only when membership changes**.

**`learned_network_wan_addresses`**: WAN history per network.

`id`; `org_id`; `network_id`; `address` inet NOT NULL; `first_seen_at`; `last_seen_at`.
Unique `(network_id, address)`.

**`discovery_profile_snmp_grants`**: the fingerprints a profile's saved SNMP secrets were entered for
(section 8.3). A fifth table, same tenancy shape and registrations.

`id`; `org_id`; `profile_id` (composite FK to `discovery_profiles`, cascade); `gateway_id` (composite FK
to `learned_network_gateways`, **cascade**: a retired fingerprint takes its grants with it);
`granted_by`; `granted_at`. Unique `(profile_id, gateway_id)`. A grant names a fingerprint, never a
network, so adding a gateway to a network grants nothing.

**New columns**

| Column | Purpose |
|---|---|
| `sites.discovery_network_required` boolean NOT NULL default false | The gated flag. Set in the same transaction as a site's first assignment. Cleared only by an explicit admin action, and only while the site has no assigned network. `(false, has networks)` cannot exist. |
| `devices.network_attachment_epoch`, `devices.network_attachment_sequence`, `devices.network_attachment_digest`, `devices.network_attachments_confirmed_at` | The last accepted report: its install epoch and sequence, a digest of its normalized content plus WAN address, and when the server last saw it confirmed. They live on the row every heartbeat already locks and updates (verified: `routes/agents/heartbeat.ts` reads its own row for update and writes `lastSeenAt` each beat). |
| `discovery_profiles.network_id` uuid NULL | Optional narrowing to one network. Its FK **blocks deletion** of the network; it is never set null, because clearing it would widen the profile. |
| `discovery_profiles.snmp_grant_mode` varchar NOT NULL default 'unrestricted', CHECK in (`unrestricted`, `bound`) | Whether this profile's saved SNMP secrets may be sent anywhere a site agent is (today's behavior) or only behind granted fingerprints (section 8.3). |
| `discovery_jobs.network_id` uuid NULL | The network the scan ran on. History: set null on delete. |
| `discovery_jobs.network_dispatch` jsonb NULL | The attempt record written before the command leaves (section 8.2). Secret-free and bounded, like `topology_dispatch`. |
| `discovered_assets.last_network_id` uuid NULL | The network of the last guarded scan that saw the asset. History: set null on delete. |

Every one of these needs an export-policy classification (jsonb is `excludedOpen`).

**A device is currently behind a fingerprint** when it has an `is_current` row for it, its
`network_attachments_confirmed_at` is within the freshness window (default 10 minutes) and it is online.
It is currently on a network when that holds for any of the network's fingerprints.

**Nothing removes a network out from under a site or a profile without failing closed:**

- *Network merge* re-points profiles, jobs and assets from the source to the target before deleting it.
- *Retention* cannot delete a network a profile points at (the FK), and never deletes an assigned one.
- *Unassign* leaves a profile pointing at the now-unassigned network; it fails `network_not_assigned`
  until someone changes it.
- *Site deletion* returns the site's networks to unassigned.
- *Org merge* (below) can drop a site's assignment; the site stays gated and fails closed.

**Registrations** (mechanical; grep the precedent, `topology_site_fingerprints` and
`topology_device_presence`, in each file):

- All five tables: `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`.
- `learned_network_devices` also: `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`
  and `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` (disposition **Delete**: its rows name a source-org network and
  are rebuilt by the next report), plus `deviceInstallBoundary/classification.ts`. A device org move also
  clears the four `devices.network_attachment*` columns.
- Org merge: two orgs can hold the same fingerprint (most likely when one customer was created twice).
  The merge must not abort on the unique index. It folds **per fingerprint**: each colliding source
  fingerprint's device rows and grants move to the target org's row with the identical address and MAC,
  which is the only row it can collide with. A source network whose fingerprints all fold into **one**
  target network is merged into it, re-pointing profiles, jobs, assets and WAN rows; its assignment
  carries over when the target's network is unassigned, and when both are assigned (to what are now two
  sites of one org) the target's assignment wins. A source network whose fingerprints fold into
  **different** target networks is never guessed at: it is kept, unassigned and without those
  fingerprints, so profiles pointing at it fail `network_not_assigned`. In every case a source site keeps
  `discovery_network_required = true`, so it fails closed if it lost its last network. The registry
  mechanism is the builder's.

**Limits and retention**

- At most 8 attachments accepted per report, 32 WAN addresses kept per network (oldest dropped), 5,000
  learned networks per org (beyond it, new unassigned networks are not created and the tab says so).
- An unassigned, not-ignored network with no sighting for 90 days is deleted with its children.
  Assigned and ignored networks are never deleted automatically. `learned_network_devices` rows not seen
  for 90 days are deleted.

## 7. Agent

Agent-shipped code: full rigor (TDD, review). Reuse the OS readers in
`agent/internal/collectors/networkcontext` (routes, neighbours, `LookupRoute`); they do live reads on
Windows, macOS and Linux. Do **not** depend on the network-context manager being enabled, and do not
use its cached snapshot for the guard.

### 7.1 Attachment report

A new heartbeat field, always on, carried by the heartbeat the agent already sends (no second sender):

```json
"networkAttachmentsV1": {
  "epoch": "9f2c1e7ab4d04c11", "sequence": 418, "capturedAt": "2026-11-20T15:04:05Z", "complete": true,
  "attachments": [
    { "interfaceName": "Ethernet", "localAddress": "192.168.1.57", "prefixLength": 24,
      "gatewayAddress": "192.168.1.1", "gatewayMac": "a4:2b:b0:11:22:9c", "primary": true }
  ]
}
```

- One entry per IPv4 default route whose interface is up and is not a tunnel, loopback or
  virtual-switch kind (use the existing interface-kind classification).
- `gatewayMac` comes from the OS neighbour cache and is `null` when absent. The report never probes.
- `primary` marks the interface that carries the route to the Breeze server.
- `epoch` is a random id the agent creates and persists with `sequence`. It changes whenever that state
  is lost (reinstall, re-attach, wiped data directory). `sequence` is monotonic within an epoch and
  survives restarts. `complete` is false when a read failed or the list was truncated.
- An empty, complete list is a valid report and means "on no identifiable network".

### 7.2 Guarded scan

A gated scan is a **distinct command type** (name is the builder's), not a new field on
`network_discovery`. An agent that predates it answers `unknown command type` (verified:
`agent/internal/heartbeat/heartbeat.go`, the handler-registry miss), so a downgraded or stale agent
cannot run a gated scan by ignoring a field. `network_discovery` itself is unchanged and remains the
command for sites that are not gated.

The guarded command carries the discovery payload plus:

```json
"expectedNetwork": { "gateways": [ { "networkId": "<uuid>", "gatewayId": "<uuid>", "address": "192.168.1.1", "mac": "a4:2b:b0:11:22:9c" } ] }
```

The agent must:

1. **Select.** Find a current default-route attachment whose gateway address is an expected address.
   None: fail `network_mismatch` with the gateways it observed (at most 8).
2. **Prove fresh.** Obtain a layer-2 answer from that gateway on that interface *during verification*
   and require its MAC to equal the expected MAC. A neighbour entry that was merely cached before
   verification started does not count. Mismatch: fail `network_mismatch`.
3. **Bind.** Every probe of the run (ARP sweep, ping, TCP and port checks, SNMP, neighbour lookups) is
   bound to the proven interface and its source address. Nothing is sent from another interface, even
   one on the same range. Routed ranges beyond the local prefix remain scannable through that interface.
4. **Watch.** For the whole run, watch for a change to that interface's link, address or default route.
   On any change: stop, discard everything, return `network_changed`.
5. **Re-prove before credentials.** After the host scan, repeat step 2. Only then run the credentialed
   pass: the SNMP sessions that use the profile's credentials and the LLDP/CDP/FDB collection.
6. **Re-prove before reporting.** Repeat step 2 again. Adjacency (v2) reports are posted only after it
   passes, and each carries `verifiedNetwork`. On a failure here, post nothing and return
   `network_changed`.
7. Return `verifiedNetwork: { networkId, gatewayId, gatewayAddress, gatewayMac, interfaceName }`.

The order is: prove, bind, scan, prove, credentialed pass, prove, post, return.

`network_mismatch` and `network_changed` are added to `wire.CommandErrorCode` and the API's accepted
enum. The guard is written as a reusable function, not inlined in the discovery handler (section 12).

## 8. API

### 8.1 Learning (heartbeat ingest)

- Both API heartbeat parsers hand `networkAttachmentsV1` to one service.
- Ignored entirely for ephemeral (Quick Support) devices and parked devices: a stranger's PC must not
  teach an org its home network.
- **Ordering.** A report with the stored `epoch` is applied only when its `sequence` is greater than the
  stored one. A report with a different `epoch` replaces the stored state. Either way `capturedAt` must
  be within a bounded age, and only a `complete` report may clear a membership.
- **Zero extra writes in steady state.** The service computes a digest of the normalized attachments
  plus the request's WAN address and compares it with `devices.network_attachment_digest`, on the device
  row the heartbeat already reads and updates. Equal: it only folds the confirmation time into that same
  device update. Different: it writes the membership change (fingerprint find-or-create, a new unassigned
  network for a new fingerprint, `is_current` flips, a WAN row) and the new digest.
- **Shared rows are not touched per heartbeat.** `last_seen_at` on networks, fingerprints and WAN rows
  is refreshed by a periodic batch from the device rows, not by each device's heartbeat, so an office of
  200 agents does not contend on one row.
- **Isolated.** The learner runs in its own savepoint (`withDbTransaction`, catch outside). A learner
  failure is logged and must never fail or roll back a heartbeat.
- WAN: taken from the trusted client IP (`getTrustedClientIp`) when the attachment is `primary` and the
  address is public. Where a transport has no trustworthy client IP, no WAN address is recorded.
- Kill switch: an env var that turns ingest into a no-op. Confirmations then age out and gated sites
  **fail closed**; the switch never re-opens unrestricted scanning for a gated site.
- A retention worker applies section 6's limits.

### 8.2 The gate

One function decides, for a site and an optional profile, whether a scan may be sent and to whom. Every
producer of a discovery scan command goes through it: `loadDispatchScanInputs` in
`jobs/discoveryWorker.ts` (run-now, schedules, the lost-dispatch sweep, baseline scans) and the AI/MCP
`network_discovery` tool in `services/aiToolsNetwork.ts`, which the SDK tool delegates to. A contract
test fails if either command type is built outside the shared builder.

Evaluated in this order. **The order is normative**: the first row that applies decides, and decides
the failure code.

| # | Situation | Result |
|---|---|---|
| 1 | The job's org or site differs from the live profile's | Fail `profile_moved`. Checked before any credential is decrypted. |
| 2 | `profile.network_id` is set but the network is unassigned or assigned to another site | Fail `network_not_assigned`, on a gated site and on one that is not. |
| 3 | The profile has saved SNMP secrets and `snmp_grant_mode = 'bound'` | **Always guarded**, whether or not the site is gated (section 8.3). Allowed fingerprints = its granted fingerprints that belong to a network assigned to this site (and to `profile.network_id` when set). None: fail `credentials_need_reentry`. |
| 3a | The profile has saved SNMP secrets, is `unrestricted`, and the site is gated | Cannot arise (8.3 rule 2). If it does, fail `credentials_need_reentry`; never treat it as row 6. |
| 4 | Site is not gated | Unrestricted: today's selection and the unchanged `network_discovery` command. |
| 5 | Site is gated and has no assigned network | Fail `no_network_assigned`. |
| 6 | Site is gated | Allowed networks = `profile.network_id` when set, otherwise every network assigned to the site. Allowed fingerprints = their fingerprints. |

For a guarded dispatch, **eligible agents** are devices assigned to the site, online, not ephemeral, not
parked, currently behind an **allowed fingerprint** (matched on `learned_network_devices.gateway_id`,
not merely on the network), and at or above the guard's minimum agent version
(`COMMAND_MIN_AGENT_VERSION`, which fails closed on unknown versions). The same rule, including the
ephemeral and parked exclusions, applies to an explicitly requested agent, a pinned agent and the AI
tool's target device. Attachment and version are filtered in the query, before the candidate cap.

- Requested or pinned agent not eligible: fail naming the device and why. No fallback, as today.
- No eligible agent: fail `no_agent_on_network`. The message distinguishes "agents are online but none
  is on this network" from "agents here need updating".
- Otherwise: rank eligible agents with the existing subnet-match ranking and send the guarded command.

Scanners stay restricted to devices **assigned to the site**. A visiting device from another site is not
conscripted even when it is physically on the network.

**The attempt is recorded before the command leaves.** `discovery_jobs.network_dispatch` stores the
mode (unrestricted or guarded), the chosen agent, and the allowed network and fingerprint ids. A result
or an adjacency report is accepted only against that record, and a refusal that arrives immediately
after the send is recorded with its code rather than dropped. The AI tool has no job row: its attempt
record is the persisted command it already creates, whose payload the server wrote. The verifier reads
the allowed fingerprints from that stored payload, never from the upload. (The builder confirms the AI
path always persists the command before sending; if it does not, a gated AI scan gets a job row.) Failures are stored on
`discovery_jobs.errors` as `{ code, message }`. The AI tool returns the same codes as a refusal.

**When an assignment change takes effect.** Assignment mutations and the gate's attempt write take the
same per-site lock, so a dispatch sees either the old or the new state, never a mix. A change applies to
every dispatch that starts after it commits. A scan already running is not recalled, but:

- gating a site cancels its scheduled and running jobs (best effort), and
- results are checked against the **current** state at ingest (section 8.4), so a scan admitted under
  the old state cannot write anything the new state does not allow.

The assign route and the gate ship in the same release, and assignment must not be reachable until
every API and worker process enforces the gate (the deploy's version-parity assertion covers this).

### 8.3 Saved credentials follow the fingerprints they were entered for

The existing origin-binding rule (`credentialOriginBinding.ts`, applied on profile update) says saved
SNMP secrets do not carry forward onto a destination the profile has not probed before. This design
extends that rule to networks:

A profile with saved secrets is in one of two modes (`snmp_grant_mode`), and holds zero or more grants
(`discovery_profile_snmp_grants`), each naming one fingerprint.

- **`unrestricted`**: today's behavior. Valid only while the profile's site is not gated.
- **`bound`**: the secrets go only behind granted fingerprints. Zero grants means the profile cannot
  run. "No grants" and "unrestricted" are different states and are never inferred from each other.

**What changes the mode or the grants. Nothing else does.**

1. **A full re-entry of the secrets.** "Full" means every secret the profile will hold after the save
   arrived as fresh plaintext in that request, across both the community and the SNMPv3 fields. It is
   its own predicate, decided from the secrets alone; it is not the return value of the existing
   retention helper, which answers a different question and returns early on some saves. On a full
   re-entry the grants are **replaced** by a fresh set computed from the profile as saved, independent
   of what it held before: if the site is gated, the fingerprints of the networks **assigned to the
   site**, restricted to `network_id` when set, and the mode is `bound`; if the site is not gated, no
   grants and the mode is `unrestricted`. Creating a profile with secrets is a full re-entry.
2. **Every transition of a site into gated.** Each time `discovery_network_required` goes from false to
   true, every profile of that site with saved secrets in `unrestricted` mode becomes `bound` to the
   fingerprints of the network being assigned, restricted to the profile's `network_id` when set (a
   profile pointed at some other network becomes `bound` with no grants). This narrows where the
   secrets go, so it needs no re-entry. It runs under the site lock.
3. **A fingerprint is deleted.** Its grants go with it (the FK cascade).
4. **A save that supplies some secrets but not all** (a rotation that keeps another secret masked)
   adds nothing and **shrinks** the grants to those effective for the profile as saved. A secret
   supplied while the profile was narrowed to one network is therefore never eligible on another.

`profile.network_id` may be **set** only to a network assigned to the profile's site at save time. A
save that would leave it pointing anywhere else is rejected. The existing rule that rejects a site move
or a widened range while secrets are retained stays exactly as it is; this section adds to it.

Consequences, each of which is intended:

- `bound` never returns to `unrestricted` except through rule 1 on a site that is not gated. Un-gating a
  site, or un-gating and assigning a different network, leaves a bound profile bound to what it had.
- Assigning a second network to the site, pointing the profile at another network, or merging in an
  additional gateway grants nothing. The profile keeps running where it has grants and shows
  "credentials not sent on `<network>` until re-entered". With no usable grant it fails
  `credentials_need_reentry`.
- A profile created with secrets on a gated site that has no assigned network is `bound` with no grants.

**Locking and atomicity.** Every writer takes locks in one order: the affected site rows in ascending
id (both sites on a move), then the profile row (or its insert). Assignment mutations, profile saves and
profile creation all follow it. A save reads retained secrets only after it holds the profile lock, and
commits the destination (site, `network_id`, ranges), the secrets, the mode and the grants in one
transaction, so one save's secrets can never be paired with another's grants. Dispatch reads a profile's
secrets and its grants in the same snapshot.

**Known limit.** The guarded command carries the secrets, so they reach the chosen agent before it
proves the network. The agent's guard prevents their use, not their receipt. The server narrows this by
choosing only agents behind an allowed fingerprint (8.2).

Profiles without saved secrets are unaffected by all of this.

### 8.4 Result verification

One function verifies a discovery result before any host is stored **or returned**, on every path:
the direct job result, both persisted-command result paths, the adjacency route
(`routes/agents/topologyAdjacency.ts`, which admits reports while the job is still running) and the AI
tool's response.

- Guarded attempt: the result must carry a `verifiedNetwork` whose fingerprint is in the attempt record
  **and** is still authorized for the job's site and profile now. Otherwise discard and fail
  `network_unverified`.
- Unrestricted attempt: accepted only if the site is still not gated. Otherwise discard.
- On success set `discovery_jobs.network_id` and stamp `discovered_assets.last_network_id`.
- The job also records how many assets it updated that a guarded scan last saw on a **different**
  network within 30 days. The Jobs tab shows the count. It is the signal that O4's premise does not hold
  for a customer; v1 warns and does not withhold the update.

### 8.5 Routes

Under the discovery router, org-scoped like the rest of it:

| Action | Permission |
|---|---|
| List learned networks, with fingerprints, WAN history, device counts and suggestions | `devices:read` |
| Assign to a site, unassign, rename, ignore or restore, merge, stop requiring a network | `devices:write` + MFA, and site access to every site involved |
| Set or clear `networkId` on a profile | existing profile write (`devices:write` + MFA), under the rule in 8.3 |

- **Site-restricted users** (RLS is org-level, so this is app-layer, as in SL D5): they see networks
  assigned to sites they can access, and unassigned networks on which a device they can access has been
  seen. They can assign only to sites they can access.
- **Merge** has two forms. *Additional gateway* (an HA peer) moves the source's fingerprints into the
  target. *Replaces a gateway* does the same and deletes the fingerprints of the target that the admin
  **names in the request** as retired; it never guesses which. A retired router that turns up somewhere
  else is then learned as a new, unassigned network instead of still counting as the office. Both forms
  re-point profiles, jobs and assets and delete the source network. Neither creates a grant.
- **Unassign or move** a network that profiles point at, or that is a site's last network, is allowed
  after a confirmation that lists the effect: pointed profiles fail closed until changed, and a site left
  with no network stops scanning.
- **Stop requiring a network** is a separate action on a gated site with no assigned network. It clears
  `sites.discovery_network_required` after a confirmation that says scans may again run from any of the
  site's agents, wherever they are.
- **Assigning a fingerprint with a shared virtual-router MAC** (VRRP `00:00:5e:00:01:xx`, HSRP
  `00:00:0c:07:ac:xx`) shows a warning that another network using the same group and address would look
  identical. It is allowed.
- Every mutation writes an audit row.
- **Suggestions** are computed on read and never applied: a network is "likely `<site>`" when its prefix
  equals a range that site declares (`siteNetworkDeclarations.ts`, exact equality) or when two or more
  devices assigned to that site were seen on it in the last 14 days.

## 9. Web

A seventh tab on Discovery, `#networks`, independent of the topology flags.

```
Discovery ▸ Networks

Needs review (2)
  192.168.1.0/24 via 192.168.1.1    a4:2b:b0:11:22:9c  TP-Link     WAN 203.0.113.20
  5 devices in the last 14 days · 4 assigned to Main Office · 3 on it now
  Likely Main Office                                        [Assign to site ▾]  [Ignore]

  192.168.1.0/24 via 192.168.1.1    3c:37:86:aa:bb:10  Netgear     WAN 198.51.100.7
  1 device in the last 14 days (LAPTOP-JS) · not on it now
                                                            [Assign to site ▾]  [Ignore]

Assigned (1)
  Main Office    10.1.2.0/24 via 10.1.2.100   00:1a:8c:…   WAN 203.0.113.20 (+2 earlier)
  7 devices on it now · used by 2 profiles                  [Rename] [Merge…] [Unassign]

Ignored (4)  ▸
```

- **Profile form:** when the chosen site is gated, a "Network" select appears with "Any of this site's
  networks" (default) and each assigned network. Picking one offers to fill the range from its prefix.
  The scan-agent picker marks agents that are not on an allowed network. A profile with saved secrets
  shows which networks they are bound to.
- **Profiles tab:** a site that is not gated shows a notice: "`<Site>` has no assigned network. Scans can
  run from any of its agents, wherever they are." with a link to Networks.
- **Jobs tab:** shows the network scanned, and maps each failure code to a sentence with the next step.
- **Assets tab:** a filter "Not seen on an assigned network", to find devices recorded by scans that ran
  somewhere else before the site was gated.
- New locale keys go in all eight locales. Mutations use `runAction`. Tab state stays in the hash.

## 10. Behavior changes to expect

- Nothing changes for a site until someone assigns it a network.
- After assignment, that site's scans need an agent at or above the guard version that is on the network.
  A site whose agents are all older fails with "agents here need updating" until they update.
- Scheduled scans for a gated site fail when no eligible agent is in the office, exactly as they fail
  today when no agent is online.
- Devices that earlier scans recorded from a home network stop being seen. Baselines with "disappeared"
  alerts enabled will report them under their existing rules, which can repeat daily until the device is
  acknowledged or removed from the baseline. The Assets filter in section 9 is the cleanup path.
- A replaced router is a new, unassigned network. The site's scans fail closed with `no_agent_on_network`
  until an admin merges it as a replacement, and profiles with saved secrets then need them re-entered
  (8.3). The Networks tab flags a new network whose gateway address and prefix equal an assigned
  network's as "looks like a replacement for `<name>`".

## 11. Known limits

- An agent that has been tampered with can report false attachments and skip the guard. Agents are
  already trusted to run scans; this design does not change that trust.
- A fingerprint match is not proof of location. Shared virtual-router MACs and cloned router
  configurations can make two networks look the same (warning in 8.5).
- A host with no default route, or behind a virtual NAT switch whose MAC changes on reboot, cannot be a
  scan agent for a gated site.
- A full-tunnel VPN makes the tunnel the primary route, so no WAN address is recorded while it is up.
- Phone hotspots and guest networks appear as unassigned networks and are removed by retention.
- **The fresh-proof step is unproven on every OS and is the first thing to build.** The existing ARP
  sender is cgo-only (`discovery/arp.go`, pcap) and Windows agents are built with cgo off, so it cannot
  be the mechanism there. Candidates, none verified: on Windows, delete the gateway's neighbour entry and
  resolve it again through `iphlpapi` (`ResolveIpNetEntry2` or `SendARP`), which needs no cgo; on Linux,
  an ARP request over a raw `AF_PACKET` socket; on macOS, BPF. The agent wave starts with a spike that
  proves a fresh answer on all three. If one platform cannot do it, the plan stops and comes back to the
  owner; step 2 is not weakened and that platform is not quietly dropped.

## 12. Open: owner decision

**Should gating also cover the other work that makes a site's agents probe its LAN?** Discovery is not
the only producer. SNMP polling and network monitors also pick a site agent by site of record
(`jobs/snmpWorker.ts`, `jobs/monitorWorker.ts`), as does the asset "Check now" probe. From a roaming
laptop they poll and check home addresses, and a monitor reports an office device as down.

- **Include (recommended):** a final wave applies the same eligibility rule to those three producers on
  gated sites, with the guard on the ones that carry credentials. "Gated" then means what it says for the
  whole site. Adds roughly one wave.
- **Defer:** ship discovery only and file the rest as a follow-up. Smaller, but a gated site still polls
  and checks from wherever its laptops are.

The agent guard is built as a reusable function either way, so including this later is not a rewrite.

## 13. Calls made by the author (reject any individually)

1. **Assigning a network gates the whole site.** One action protects every profile, schedule, baseline
   scan and AI scan for that site. Pointing a profile at a specific network is an optional narrowing,
   not a per-profile migration.
2. **Gated is stored on the site**, so losing the last network by any path stops scans instead of
   re-opening them. Returning to unrestricted scanning is an explicit action.
3. **Two-table identity** (`learned_networks` plus fingerprints), so an HA pair or a replaced router can
   be merged without re-pointing profiles.
4. **A replaced router's old fingerprint is removed on merge**, so the old router cannot stand in for
   the office later.
5. **Saved SNMP secrets are granted per fingerprint** (8.3, a fifth table). The cost: after a router
   replacement, or to use a profile's credentials on a second network, someone re-enters them. This
   follows the existing re-entry rule for site moves and widened ranges. It is the most intricate part
   of the design; the alternative is to drop it and let network assignment decide where saved secrets
   go, which is simpler and lets anyone with `devices:write` re-point them.
6. **The scan is bound to the proven interface and cancelled on a network change**, not only checked
   before and after.
7. **Scanners must be assigned to the site** even when a device from another site is on the network.
8. **Unassigned networks are kept 90 days** after their last sighting, with their device and WAN rows,
   then deleted. This is a history of where laptops have been; the same public address already appears
   in `devices.last_seen_ip` and the `agent.source.ip.changed` audit event.
9. **WAN history is per network**, capped at 32 addresses, and is evidence only, never identity.
10. **`discovered_assets.last_network_id`, the "Not seen on an assigned network" filter and the
    cross-network update count** are included to make wrong-network data findable. Cuttable without
    affecting the gate.
11. **Suggestions only**, no auto-assign and no bulk accept.
12. **Presence is not changed here.** After this ships, "which networks belong to a site" is expressed in
    two places: ranges on profiles and baselines (read by presence, SL 6.2) and learned-network
    assignment (read by the gate). The removal plan is a follow-up in which presence takes assigned
    networks as its anchors, which also closes SL open question Q1. It is sequenced after this feature.

## 14. Left to the builder

- Wave split. Suggested: (1) migration, registrations, ingest, retention, kill switch, with no behavior
  change; (2) agent report and guarded scan; (3) routes, gate, shared command builder, attempt record,
  result verification, credential binding; (4) web; (5) docs, release notes and the lab proof below;
  (6) the other producers, if section 12 is "include". Wave 1 deploys before agents that send the new
  field are promoted.
- The org-merge mechanism, the exact FK actions, the batch cadence for shared timestamps, the freshness
  window and capture-age bound, the guarded command's name and minimum agent version, and how each OS
  obtains the fresh layer-2 answer.
- Migration naming: sort after the newest committed migration (`2027-01-28-200000-…` today); read
  `apps/api/migrations/README.md` first.
- Test design, within the repo's rules. Required proofs:
  - real Postgres: a gated site with no eligible agent sends **no** command; a refusal arriving
    immediately after the send is recorded with its code;
  - real Postgres: an assignment change racing a dispatch never lets a result through that the new
    state does not allow;
  - each action sequence in section 15's credential rows, as a test that the secrets are not sent;
  - an old or unknown-version agent at a site that is **not** gated still scans, through both producers;
  - a cross-tenant forge against each new table as `breeze_app`, and a cross-org network reference
    through each composite FK;
  - the cascade, merge and export-policy contract suites (Integration Tests);
  - a load test of heartbeat ingest showing no added write for an unchanged report;
  - Go tests for select, prove, bind, watch and re-prove on each OS's fixtures;
  - a lab run with two networks on the same range behind different routers: refusal on the wrong one,
    both connected at once (nothing leaves the wrong interface), and a move mid-scan that cancels and
    discards.

## 15. Review record

Codex (gpt-6.2-astra, xhigh, read-only) returned "agree with changes". It supported the four tables, the
direct `org_id` shape and gating the whole site. Its findings and the builder check's, and where each
landed:

| Finding | Resolution |
|---|---|
| Before and after checks can both pass while probes leave another interface or the device leaves and returns | Bind to the proven interface, watch for changes, cancel (7.2 steps 3 and 4). |
| A cached neighbour entry can be stale; the key cannot prove location | Fresh layer-2 proof on the selected interface (7.2 step 2); the guarantee is restated as a fingerprint match (section 3); virtual-router MAC warning (8.5). |
| No definition of when an assignment takes effect | Per-site lock, cancel on gating, result check against current state (8.2, 8.4). |
| A refusal returned immediately after the send could be dropped | Attempt recorded before the send (8.2). |
| Adjacency reports and the credentialed pass run before the result returns | Re-prove before credentials and before posting; adjacency route verified (7.2 steps 5 and 6, 8.4). |
| An older agent would ignore a new payload field | Distinct guarded command type (7.2). |
| Dispatch preconditions and their order | The evaluation order in 8.2. |
| Deleting a network could clear a profile's narrowing | Blocking FK, re-pointing merge, precedence of an invalid `network_id` (section 6, 8.2). |
| A retired router's fingerprint stays authorized after a merge | Two merge forms (8.5). |
| Result paths beyond the job path | One verifier on every path, including the AI response (8.4). |
| Plain uuid links allow cross-org references | Composite, deferrable FKs throughout (section 6). |
| Heartbeat write load | Digest on the device row, membership-only writes, batched shared timestamps, isolated learner (8.1). |
| Report ordering and completeness | `sequence`, `complete`, bounded capture age (7.1, 8.1). |
| One eligibility rule for every selection path, filtered before the candidate cap | 8.2. |
| Report sequence needs a reset rule (author's own review) | Install `epoch` (7.1, 8.1). |

A second, narrow Codex read of the first version of 8.3 returned "does not hold" with nine action
sequences. 8.3 was rewritten around an explicit mode and per-fingerprint grants. Each sequence is a
required test (section 14):

| Sequence | Closed by |
|---|---|
| Un-gate, then assign a different network | `bound` never returns to `unrestricted` without a full re-entry; rule 2 runs on every transition into gated. |
| Create a credentialed profile on a gated site with no network, then un-gate | It is `bound` with no grants; "no grants" is not "unrestricted". |
| Supply one new secret while keeping another masked | Only a full re-entry grants. |
| Two concurrent saves, one masked and one moving the profile | Row lock before reading retained secrets; one transaction. |
| Re-enter secrets on a profile pointed at a new network | Grants are computed from the profile as saved, not from the old grants. |
| An agent behind a newly merged gateway of the same network | Eligibility matches the fingerprint, not the network. |
| A replacement merge after an additional-gateway merge | The request names the fingerprints retired. |
| Org merge with the same fingerprint under two ids | A grant re-points only to the identical address and MAC. |
| Conflicting failure codes when the last network is unassigned | The evaluation order in 8.2 is normative. |

The second narrow read confirmed all nine are closed and raised eight further cases. They are folded in
and **have not been re-read**: a partial rotation while narrowed (8.3 rule 4), a profile pointed at a
network that is not its site's (the `network_id` rule, rule 2's restriction), "full re-entry" as its own
predicate (rule 1), one lock order (8.3), a gated site holding an unrestricted credentialed profile
(8.2 row 3a), an org merge that splits one network across two (section 6), and a device behind two
gateways of one network (membership per fingerprint, section 6). Each is also a required test. Review
stops here; the plan carries these as tests rather than as further design passes.
| O4's premise is not enforced | Cross-network update count on the job, warn only (8.4). |
| Baseline "disappeared" wording | Corrected (section 10). |
| Saved credentials and newly authorized networks | Fingerprint binding (8.3). |
| Other producers that probe a site's LAN | Owner decision (section 12). |
