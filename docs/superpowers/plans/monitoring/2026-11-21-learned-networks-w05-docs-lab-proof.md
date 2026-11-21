# Learned Networks W05: Docs, release notes and the two-router lab proof

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Technicians and self-hosters can read how learned networks work, the next release says what
changes, and a lab run with two routers on one address range proves the discovery gate end to end.

**Architecture:** One new docs page, `features/learned-networks.mdx`, plus short pointers from the
discovery page and the environment reference. Release-note entries go in the draft. The lab proof runs
nine legs against a lab server stack and lab agents on Windows, macOS and Linux, and its evidence is
committed in a fixed format. No product code changes in this wave: a failed leg goes back to the wave
that owns the behavior.

**Tech stack:** Astro Starlight (MDX), Markdown, a worktree stack (`pnpm wt-stack`), psql (read only),
tcpdump (Linux, macOS), pktmon (Windows), GitHub CLI, feature-lifecycle MCP.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md`
(sections 10, 11, 14).

**Index:** `docs/superpowers/plans/monitoring/2026-11-21-learned-networks.md`. Its Global constraints,
Review focus and Cross-wave contract apply. This wave owns traceability row P10.

## Wave constraints

- Depends on W04 merged, and on an agent build at or above `GUARDED_DISCOVERY_MIN_AGENT_VERSION`
  (`apps/api/src/services/commandMinVersion.ts`, set by W03c). Read the value from that file; never
  write a version from memory. The lab Mac needs a signed release candidate, since a branch build cannot
  be signed.
- This is a public repository. The evidence file names hosts only as "the Windows lab VM", "the lab Mac",
  "a Linux lab VM", "router A", "router B", "router C" and "the lab server". Real MACs, WAN addresses,
  hostnames and server addresses never reach a committed file: Task 4 replaces them with the index's
  fixture values before the first commit. Raw captures and transcripts stay in a private `mktemp -d`
  directory, called `$LAB` below, and are deleted at the end.
- Lab agents run only on dedicated lab machines, never on a host that also runs an installed agent.
  Before re-enrolling a lab machine, copy its `agent.yaml` and `secrets.yaml` aside; a forced enrollment
  overwrites `secrets.yaml`.
- Docs copy follows the W04 copy rules: no "verified location" (the promise is that the agent proved it is
  behind an assigned gateway), no em dashes. Failure messages are quoted verbatim from W04's
  `discoveryJobList.failures` table.
- `docs/release-notes/next-release-draft.md` conflicts often in the merge queue. Rebase on `origin/main`
  just before enqueueing and re-read the file after the rebase.

## File structure

| File | Change |
|---|---|
| `apps/docs/src/content/docs/features/learned-networks.mdx` | Create. The feature page. |
| `apps/docs/astro.config.mjs` | Register the page after `features/discovery` (`:139`). |
| `apps/docs/src/content/docs/features/discovery.mdx` | Pointers: Key Concepts (after `### Network Topology`, `:62`), Scan Execution Flow step 2 (`:269`), Job Statuses `failed` row (`:311`), a "Learned Networks" API table after Discovered Assets (`:605-616`), one Troubleshooting entry (after `:688`). |
| `apps/docs/src/content/docs/deploy/environment.mdx` | One row in Feature Flags (`:912`). |
| `docs/release-notes/next-release-draft.md` | Release to-do gate (`:15`), Upgrade Notes (`:30`), Features / API (`:37`). |
| `docs/superpowers/plans/monitoring/evidence/2026-11-21-learned-networks-lab-proof.md` | Create. Lab evidence. |

**Docs decision: a new page.** `discovery.mdx` is 697 lines and covers scanning. Learned networks is
its own admin workflow (reviewing networks, assigning, merging, credentials, failures) that a technician
reads when a scan refuses to run, so it gets its own page, registered in the same sidebar group
(Monitoring & Alerting) right after Network Discovery.

---

### Task 1: The learned networks page and its pointers

**Files:** create `features/learned-networks.mdx`; modify `astro.config.mjs`, `discovery.mdx`,
`deploy/environment.mdx`.

Page outline (frontmatter `title: Learned Networks`, `description: Tell the office network from a home
network and make a site's discovery scans run only behind its own gateway.`). Each heading and what it
must say:

| Heading | Content |
|---|---|
| What a learned network is | Agents report the IPv4 default gateway they are behind (address and MAC). Each new gateway address and MAC pair in an organization becomes a network under Discovery, Networks. An address range alone does not identify a network: an office and a home can both use `192.168.1.0/24` behind `192.168.1.1`, with different routers. |
| Telling the office from a home | Read the row: the range and gateway, the router's MAC and maker, the WAN address the agents came from, "5 devices in the last 14 days", which sites those devices belong to, how many are on it now. "Likely Main Office" appears when the range matches one the site declares or two or more of the site's devices were on it in the last 14 days. It is a suggestion; nothing is assigned automatically. A laptop seen on a network says nothing about where the laptop belongs. |
| Assigning a network to a site | Assign to site, then read the confirmation: how many of the site's online agents are on this network now, how many need an agent update, and that saved SNMP credentials will be sent only on this network. Assigning never moves a device to another site. |
| What "requires a network" means | The first assignment makes the site require a network. From then on its discovery scans run only from an agent assigned to the site that has just proved, by asking the gateway itself, that it is behind one of the site's assigned gateways, and every probe leaves through that interface. The requirement stays when the last network is unassigned: scans stop until a network is assigned or an admin chooses Stop requiring a network, which lets scans run from any of the site's agents again. A site that has never had a network assigned behaves exactly as before, and the Profiles tab says so. |
| Limiting a profile to one network | The Network field on a profile (shown when the site requires a network), "Any of this site's networks" by default; choosing a network can fill the scan range from its prefix. |
| Saved SNMP credentials | Saved credentials are sent only behind the gateways they were entered for. Assigning a second network, merging in a gateway or replacing a router does not extend them: the profile shows "Saved SNMP credentials are not sent on `<network>` until they are re-entered." Re-entering every secret on the profile binds them to the site's current networks. After "Stop requiring a network", a profile whose saved credentials were limited to gateways does not run until its credentials are entered again. |
| When a scan does not run | A table of every failure sentence from W04 (`discoveryJobList.failures`, all 19 rows, verbatim) with the code in a second column. |
| A router replaced | The new router is a new network, flagged "Looks like a replacement for `<name>`". The site's scans fail until it is merged. Merge, choose Replaces a gateway and tick the old router's gateway; the old router then no longer counts as the office, and if it turns up elsewhere it is a new, unassigned network. Profiles with saved SNMP credentials need them re-entered. |
| Two routers on one network | Merge as Additional gateway for a high-availability pair. |
| Cleaning up devices recorded elsewhere | Assets, filter "Not seen on an assigned network": devices last recorded by a scan that was not on one of the site's assigned networks. Once the site requires a network, such devices stop being seen; baselines with "disappeared" alerts report them under their existing rules until acknowledged or removed. The Jobs tab shows when a scan updated devices that a scan on another network saw in the last 30 days. |
| Known limits | Spec section 11, each bullet in plain words: a tampered agent; a fingerprint match is not proof of place (shared virtual-router MACs, cloned router settings); no default route or a NAT virtual switch whose MAC changes on reboot cannot scan for a site that requires a network; a full-tunnel VPN records no WAN address; hotspots and guest networks appear and age out after 90 days; IPv4 only; at most 5,000 learned networks per organization. Plus the two from index plan call 16: on macOS, an address on a bridge interface is not reported as a network, so that Mac cannot scan for a site that requires a network; on Windows, a static (permanent) neighbour entry for the gateway may make the agent's gateway check fail, so remove the static entry on a machine meant to scan such a site (state what the W02b evidence file found). |
| Agent version | Scans for a site that requires a network need agent version `<GUARDED_DISCOVERY_MIN_AGENT_VERSION>` or later. Older agents keep scanning sites that do not require a network. |
| For self-hosters: turning learning off | `LEARNED_NETWORKS_INGEST_ENABLED=false` on the api service, then restart (map it in the service's `environment:` block if your compose file does not pass it). Networks stop being learned and agents' confirmations stop updating. It never lifts a site's requirement: sites that require a network stop scanning once confirmations age out, after about 10 minutes. |
| API reference | The routes of index F, one row each, with permission. |

Pointers in `discovery.mdx`: a `### Learned Networks` Key Concepts paragraph (two sentences and a link);
step 2 of Scan Execution Flow adds "For a site that requires a network, the worker sends a guarded scan
to an agent behind one of the site's gateways (see Learned Networks)"; the `failed` row adds "the site
requires a network and no agent could prove it is behind it"; the API table lists `GET
/discovery/networks` and the mutations; a Troubleshooting entry "A scan for a site with an assigned
network fails" links to the failures table. `environment.mdx` row: `LEARNED_NETWORKS_INGEST_ENABLED` |
`true` | the kill switch text above, one sentence each for what it stops and what it never does.

- [ ] **Step 1: Write the checks and see them fail.**

```bash
P=apps/docs/src/content/docs/features/learned-networks.mdx
test -f "$P" && grep -q "features/learned-networks" apps/docs/astro.config.mjs \
  && grep -q "learned-networks" apps/docs/src/content/docs/features/discovery.mdx \
  && grep -q "LEARNED_NETWORKS_INGEST_ENABLED" apps/docs/src/content/docs/deploy/environment.mdx \
  && echo PRESENT || echo MISSING
```

  Expected now: `MISSING`.
- [ ] **Step 2: Write the page and the pointers.**
- [ ] **Step 3: Run the checks.** The command above prints `PRESENT`; then
  `grep -niE "verified location|$(printf '\342\200\224')" apps/docs/src/content/docs/features/learned-networks.mdx`
  prints nothing; `pnpm --filter @breeze/docs build` exits 0 with no broken-link warning for the new page.
- [ ] **Step 4: Commit** `docs: learned networks page and discovery pointers`.

### Task 2: Release-note entries

**Files:** `docs/release-notes/next-release-draft.md`.

- **Release to-do** (under `:15`): `- [ ] **Learned networks two-router lab proof** (#<W05 sub-issue>).
  All nine legs in docs/superpowers/plans/monitoring/evidence/2026-11-21-learned-networks-lab-proof.md
  pass (leg 4 may instead read "shown by W02c native run" for its 4b half). Until this is ticked, the two
  learned-networks entries below do not ship in the release body.`
- **Self-Hosting / Upgrade Notes:** `**Learned networks and sites that require a network (new)**
  (#<parent>). Agents now report the gateway they are behind, and Discovery has a Networks tab. Nothing
  changes for a site until an admin assigns it a network. After that, the site's discovery scans run only
  from an agent at version <value of GUARDED_DISCOVERY_MIN_AGENT_VERSION> or later that has just proved
  it is behind one of the site's gateways; a site whose agents are all older shows "Agents here need
  updating" until they update. New env var LEARNED_NETWORKS_INGEST_ENABLED (default on) stops learning
  when set to false on the api service. It never lifts a site's requirement, so such sites stop scanning
  about 10 minutes after it is turned off.`
- **Features / API:** one entry naming the Networks tab, the profile Network field, the Jobs network
  column and failure sentences, the Assets filter, and the routes under `/discovery/networks`.
- **Migrations:** if `2027-01-29-100000-learned-networks.sql` (or its final name on `main`) is not in a
  tagged release yet and W01a's entry is missing, add one line: five tables and new nullable columns,
  DDL only, no rows written. Never add a second entry.

- [ ] **Step 1: Check and see it fail:**
  `grep -c "LEARNED_NETWORKS_INGEST_ENABLED\|Learned networks two-router lab proof" docs/release-notes/next-release-draft.md`
  prints `0`.
- [ ] **Step 2: Add the entries** with the real version and issue numbers.
- [ ] **Step 3: Check:** the same grep prints `2`; `grep -n "999.0.0" docs/release-notes/next-release-draft.md`
  prints nothing.
- [ ] **Step 4: Commit** `docs(release-notes): learned networks`. Rebase just before enqueueing.

### Task 3: The lab proof

**Rig.** Router A and router B each serve `192.168.1.0/24` with LAN gateway `192.168.1.1`, and their LAN
MACs differ. Router C (a third router set up the same way, or router A with its LAN MAC changed) is
used in leg 7. A canary host at `192.168.1.77` exists only behind router B; nothing answers at `.77`
behind router A. The lab server stack (`pnpm wt-stack up` at the W05 branch, `ENABLE_2FA` as the lab
needs) is reached through each router's WAN, so the server sees a public client address and can record
WAN history; if both routers share one upstream, both networks show the same WAN address, which is
expected. Agents: the Windows lab VM, the lab Mac and a Linux lab VM, all assigned to one site, `Lab
Office`. The Linux lab VM has two network interfaces for leg 5, given distinct reserved addresses (for example `192.168.1.60` behind router A and `192.168.1.61` behind router B) so both routers never hand it the same address. Profiles at `Lab Office`: `P-scan`
(ping, ARP, port scan, range `192.168.1.0/24`, no SNMP secrets, scheduled every 15 minutes), `P-snmp` (adds SNMP v2c with a saved
community), `P-long` (port scan of 20 ports over the /24, long enough to run more than two minutes).
"Pinned to X" below means the profile's scan agent is set to X for that run; otherwise every profile's
scan agent is Automatic, and a leg that pins a profile sets it back to Automatic when the leg ends.

**Packet capture.** On the agent host, on the interface that faces the router named in the leg:

| OS | Capture | Stop and read |
|---|---|---|
| Linux, macOS | `sudo tcpdump -i <iface> -nn -w $LAB/<leg>.pcap` (find `<iface>` with `ip route` or `route -n get default`) | Ctrl-C; `tcpdump -nn -r $LAB/<leg>.pcap "<filter>" \| wc -l` |
| Windows | `pktmon list` to find the NIC's component id; `pktmon start --capture --comp <id> --pkt-size 0 --file-name %LAB%\<leg>.etl` | `pktmon stop`; `pktmon etl2pcap %LAB%\<leg>.etl --out %LAB%\<leg>.pcapng`; read with tcpdump as above on any host |

Probe filter, with `<src>` the agent's address on that interface:
`src host <src> and ((icmp[icmptype] = icmp-echo) or (udp dst port 161) or (tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack = 0 and dst net 192.168.1.0/24) or (arp and arp[6:2] = 1 and not arp[24:4] = 0xc0a80101))`.
It counts echo requests, SNMP requests, TCP opens into the range and ARP requests for anything but the
gateway. Every leg that uses it also takes a 2-minute baseline with no scan running, through the same
filter.

**Read-only SQL** (psql on the lab stack) used below:

```sql
-- J: job outcome
SELECT status, network_id, errors, cross_network_asset_updates FROM discovery_jobs WHERE id = :'job';
-- W: anything the job wrote
SELECT count(*) FROM discovered_assets WHERE last_job_id = :'job';
-- C: whether a command was sent for the job. The worker records the attempt before every send
-- (index E9) and sends no device_commands row, so a null network_dispatch means nothing was sent.
SELECT agent_id, network_dispatch->>'mode' AS mode, network_dispatch->>'deviceId' AS sent_to_device
  FROM discovery_jobs WHERE id = :'job';
```

**Legs.** Each leg records what was done, what was observed, the ids and counts, and a verdict.

| Leg | Do | Must observe | Record |
|---|---|---|---|
| 1 Learn | Put agents behind router A and the Linux lab VM behind router B; wait two heartbeats. | Networks tab, Needs review: two rows, both `192.168.1.0/24 via 192.168.1.1`, different MACs, each with the devices seen on it and a WAN address (or the same one for both, see Rig). | Both network ids, device counts, WAN shown. |
| 2 Assign | Assign router A's network to `Lab Office`. | The confirmation says how many of the site's online agents are on this network; after confirming, the Profiles notice for `Lab Office` is gone; router B's row reads "Looks like a replacement for ..." (same address and range). | Effects shown, the site's `discovery_network_required`. |
| 3 Scan behind A | Run `P-scan` pinned to each agent in turn (Windows, Mac, Linux), all behind router A, capturing on the Linux lab VM's router A interface during its run. | Three jobs completed; Jobs shows router A's network on each; J has `network_id` = A; the Linux capture count is above its baseline (positive control for the filter). | Job ids per OS, J rows, capture counts. |
| 4 Same agent behind B | Stop the agents on the Windows lab VM and the lab Mac, so the Linux lab VM is the site's only online agent. Move it behind router B. **4a (the server refuses to dispatch):** after its next heartbeat, run `P-scan` pinned to it; then, with `P-scan` back on Automatic, let the next scheduled run fire. **4b (the agent refuses behind the wrong router; required, owner decision O3):** move it back to A and wait a heartbeat; move it to B and run `P-scan` pinned to it immediately, inside the heartbeat interval, before the server sees the move, capturing on its router B interface. Allow up to three attempts, each starting again from A. Start the other two agents again when the leg ends. | 4a: the pinned run failed with "The chosen scan agent is not on an assigned network right now..." and the scheduled run with "Agents at this site are online, but none is on an assigned network right now..."; C shows `network_dispatch` null for both; W = 0. 4b: job failed with the `network_mismatch` sentence ("The agent was not behind an assigned gateway when the scan started..."); J's error code is `network_mismatch`; C shows mode `guarded` sent to the Linux lab VM (the server did send, the agent refused); the capture on its router B interface shows no probe through the filter beyond baseline; W = 0. | Every job id, J, W, C, the time of each move and each Run now. If no 4b attempt of three ends in the agent's own `network_mismatch` refusal (for example the server already saw the move and failed the job as in 4a, or the agent had not reconnected through router B and the send failed), record each attempt's outcome and why, cite the W02c PR's native `BREEZE_GUARD_EXPECT=mismatch` run per OS as the evidence for the agent-side refusal, and set the leg's verdict to `shown by W02c native run`, not `pass`. |
| 5 Both at once | Connect the Linux lab VM to router A and router B at the same time (both default routes up). Capture on its router B interface during a 2-minute baseline, then during `P-scan` pinned to it. | Job completed on router A's network; scan-window count on B is no higher than baseline and both are 0 for packets to `192.168.1.77`; the canary is not in inventory. | Job id, both counts, `dst host 192.168.1.77` count, canary query. |
| 6 Move during a scan | Run `P-long` pinned to the Linux lab VM behind router A; once the job shows running, move the agent behind router B. | Job failed with "The agent could not confirm that it stayed behind an assigned gateway: its network changed or could not be checked. Nothing from this scan was saved..." (W04 `networkChanged`); J error code `network_changed`; W = 0. | Job id, J, W, time of the move. |
| 7 Router A replaced | Swap router A for router C; agents stay connected. | A new network flagged "Looks like a replacement for ..."; `P-scan` fails (`no_agent_on_network`); merge router C's network into A's as Replaces a gateway, ticking router A's gateway; `P-scan` then completes; `P-snmp` fails with the `credentials_need_reentry` sentence until the community is re-entered, then completes. Optional: reconnect router A somewhere an agent sees it; it appears as a new, unassigned network. | Network ids, merge request, job ids and outcomes. |
| 8 Outdated agent | Reinstall the Windows lab VM with the newest release below the guard version that still reports its network (it includes W02a; if no such release exists, build the agent from the W02a merge commit); keep it behind router C and stop the other two agents. Run `P-scan`. | The job fails with "Agents here need updating. Update the agents at this site to the current version, then run the scan again." | Agent version, job id, J. |
| 9 Unassign and stop requiring | Start the other agents again. Unassign the network, run `P-scan`; Stop requiring a network; run `P-scan` pinned to the outdated Windows lab VM; assign the network again. | Unassign confirmation says the site keeps requiring a network; the Profiles notice stays hidden; the job fails with the `no_network_assigned` sentence; the Networks tab shows the site's banner. After Stop requiring, the Profiles notice returns and the outdated agent's scan completes (a site that does not require a network is unchanged for old agents). The final assign confirmation shows how many online agents are on the network and "1 online agent at Lab Office needs an update before it can run these scans." (review focus 4). | Job ids, J rows, the site flag before and after, the confirmation text. |

- [ ] **Step 1: Create the evidence file with every heading and `**Verdict:** pending`.** Headings, exact:

```markdown
# Learned networks lab proof
## Build under test
## Rig
## Leg 1: Learn
## Leg 2: Assign router A's network
## Leg 3: Scan behind router A
## Leg 4: The same agent behind router B
## Leg 5: Both routers at once
## Leg 6: Move during a scan
## Leg 7: Router A replaced
## Leg 8: Agent older than the guard version
## Leg 9: Unassign and stop requiring
## Result
```

  Under each leg: `**Did:**`, `**Observed:**`, `**Recorded:**`, `**Verdict:**`. Build under test:
  commit SHA of the stack, agent version per OS, the guard version. Result: one table, leg and verdict.
  Each verdict is `pass` or `fail`; leg 4 alone may read `shown by W02c native run` (its 4b rule), and
  then names the W02c PR and the runs it cites.
- [ ] **Step 2: Run legs 1 to 9 in order**, writing raw notes and captures to `$LAB` only.
- [ ] **Step 3: Fill the evidence file** from the notes, already redacted (Task 4's map).

### Task 4: Redact, report and close

- [ ] **Step 1: Redact.** Map router A, B and C MACs to `a4:2b:b0:11:22:9c`, `3c:37:86:aa:bb:10`,
  `00:1a:8c:00:00:01`; WAN addresses to `203.0.113.20` and `198.51.100.7`; every hostname to its label;
  the server address to "the lab server". Lab addresses in `192.168.1.0/24` and UUIDs from the lab stack
  stay. No screenshots unless cropped and inspected by eye.
- [ ] **Step 2: Check the redaction.**

```bash
E=docs/superpowers/plans/monitoring/evidence/2026-11-21-learned-networks-lab-proof.md
grep -oE '([0-9a-f]{2}:){5}[0-9a-f]{2}' "$E" | sort -u      # only the three fixture MACs
grep -oE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$E" | sort -u \
  | grep -vE '^192\.168\.1\.|^203\.0\.113\.20$|^198\.51\.100\.7$'   # prints nothing
grep -c 'Verdict:\*\* pending' "$E"                         # 0
```

- [ ] **Step 3: Report on the wave issue.** One comment: build under test, the Result table (leg,
  verdict, one line of what was seen), a link to the evidence file on the branch.
- [ ] **Step 4a: All nine pass** (leg 4 may be `shown by W02c native run`, and the PR body says so).
  Tick the Release to-do line in the same PR, commit
  `docs(evidence): learned networks lab proof`, delete `$LAB`, tear down the stack
  (`pnpm wt-stack down`), rebase, enqueue. After merge, `complete_wave`.
- [ ] **Step 4b: Any leg fails.** Neither the release-note entries nor the docs page ship. Move Task 1
  and the Upgrade Notes and Features / API entries to a follow-up branch. What merges: the Release
  to-do line, unticked, naming the failed leg and its issue, plus the evidence file with its failing
  verdicts. That PR body says `Refs #<W05 sub-issue>` and carries no closing keyword in any form. File
  one issue per failure against the owning wave (agent guard W02c, gate and verification W03a,
  credentials W03b, routes W03c, web W04) with the redacted reproduction, and label the W05 issue
  blocked. W05 closes only when a re-run of the failed leg, and of every leg its fix touches, passes and
  the follow-up branch merges under 4a.

## Done when

- [ ] Task 1's check prints `PRESENT`; `pnpm --filter @breeze/docs build` exits 0.
- [ ] `grep -n "999.0.0" docs/release-notes/next-release-draft.md apps/docs/src/content/docs/features/learned-networks.mdx`
  prints nothing.
- [ ] The evidence file has all thirteen headings, every leg `**Verdict:** pass` (leg 4 may read
  `**Verdict:** shown by W02c native run` with its three attempts recorded), and Task 4's checks print
  only fixture values.
- [ ] `$LAB` deleted; `pnpm wt-stack down` run; `docker compose ls -a` lists no stack from this run; lab
  agents' `agent.yaml` and `secrets.yaml` restored where they were re-enrolled.
- [ ] The wave issue carries the result comment.
- [ ] PR body (4a only; 4b is above): `Closes #<W05 sub-issue>`; the docs page decision and where it is registered; the leg
  table with verdicts; that the evidence is redacted to fixture values; that the release-note file was
  rebased just before enqueueing; and, under Step 4b, which entries were held back and why.
