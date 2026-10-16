# Agent ECH (#8869) lab verification recipe

Manual checks for a build of the agent that includes ECH. Use `<region>.example` style placeholders; real hostnames live in `internal/`. Log lines come from `agent/internal/ech/dialer.go`; the agent logs under the `ech` component. Log levels: the filter warning and mode changes are INFO/WARN, dial attempts are DEBUG, so enable debug logging for the dial lines.

Strings to grep:

- WARN `control plane answered the TLS handshake with plaintext HTTP; a network security filter is likely intercepting this host`
- INFO `ech mode changed` (fields `from`, `to`: plain, ech, cooldown)
- DEBUG `ech dial attempt` (fields `attempt`: plain / ech / plain-fallback, `result` or `error`)
- DEBUG `ech config fetch failed`, `ech one-shot config fetch failed`

Health strings (`control_plane` component). Agent log shows status `degraded`; the v1 device health observation / API maps that to `state: "warning"`:

- healthy: `reachable via encrypted client hello`
- degraded / `warning`: `control plane blocked by a network security filter (plaintext HTTP answered on the TLS port)`
- degraded / `warning`: `encrypted client hello unavailable; retrying later`
- degraded / `warning`: `encrypted client hello disabled by control plane; the next reconnect dials plain` (kill switch off while the live connection is still ECH)
- degraded / `warning`: `encrypted client hello disabled by configuration; the next reconnect dials plain` (`ech: false` while the live connection is still ECH; rare, since the agent reads `ech` at startup and a restart dials plain)

`echActive` in the heartbeat is wire truth: true only while the most recent successful TLS dial to the control plane was ECH-accepted. It is not the dialer's mode, and it stays true after ECH is switched off until a plain dial succeeds.

## 1. Local filter simulation (no ECH expected)

Preconditions: a lab host with a built agent, enrolled against a lab server. A listener you control for the lab server name.

1. Run a listener that answers every connection on 443 with a plaintext redirect, for example:
   `socat TCP-LISTEN:443,reuseaddr,fork SYSTEM:'printf "HTTP/1.1 302 Found\r\nLocation: http://blocked.example/\r\nContent-Length: 0\r\n\r\n"'`
   (or a Caddy `:443` http-only site; the point is that plaintext HTTP answers a TLS ClientHello).
2. Point `server_url` in `agent.yaml` at `https://<lab-edge>.example` resolving to the listener, restart the agent.

Expected:

- The WARN filter line fires on the first filter signature (once per streak). The INFO `ech mode changed ... to ech` line comes with the second signature, at least 30 s later and within 10 min.
- `control_plane`: agent log status `degraded`; device health observation / API `state: "warning"`, with the filter reason.
- A DoH lookup finds no `ech=` record for this name, so `ech-cache.json` in the agent data dir never appears, and each failure is one fetch only; after 3 failures `ech mode changed ... to cooldown`, health reason becomes the cooldown string once the 10 min signature window passes. No DoH spin between dials.

Rollback: restore `server_url`, stop the listener, restart the agent (mode is in memory; restart is plain).

## 2. Hosted, blocked customer PC (real ECH)

Preconditions: a PC on a gateway whose filter blocks the hosted domain (supervised test), a fresh MSI built from this branch, an enrollment key. The hosted edge publishes an `ech=` HTTPS record.

1. Install the new MSI with the enrollment properties; do not pre-stage the old agent.
2. Watch the log: the agent log file in the data dir, filtered for `ech`.

Expected:

- Enrollment succeeds on the first run (one-shot retry with ECH on the first signature).
- `ech mode changed ... to ech`, `ech dial attempt ... attempt=ech result=accepted`, `ech-cache.json` present in the data dir.
- Within two heartbeats the device health shows `control_plane` healthy `reachable via encrypted client hello`, and the heartbeat carries `echActive: true`. API metric `breeze_agent_heartbeat_ech_total{active="true"}` increments.
- `echActive` reflects the last successful dial, not the mode: right after `ech mode changed ... to ech` a heartbeat can still show `echActive` absent (false) until the first `attempt=ech result=accepted`.
- Once in ECH mode the host stays there even after the filter is gone (ECH keeps succeeding, so no plain dial runs to notice), until an agent restart or a cooldown. Moving the device back behind a filter changes nothing visible until its sockets drop: existing connections stay up and it re-dials only after they close.

Rollback: set `ech: false` in `agent.yaml` and restart (device goes offline on this network, which is the pre-ECH behaviour), or uninstall the agent.

## 3. Kill switch

**Run this ONLY before promote, against a lab or staging API, while the lab PC is the only device using ECH.** Never run it on a production region: turning the switch off strands every ECH-dependent customer device on that region (each dials plain on its next reconnect, goes offline behind its filter, and turning the switch back on cannot reach it until it is on an unfiltered network).

Preconditions: scenario 2 passing, device online over ECH. Access to the lab/staging API compose env.

0. Precheck: `breeze_agent_heartbeat_ech_total{active="true"}` must be 0 apart from the lab device. The counter has no device label, so compare its increase over the last 15 minutes with the lab PC's own heartbeat count for the same window (`rate(breeze_agent_heartbeat_ech_total{active="true"}[15m])` times 900 should match the lab PC's beats). Any surplus means another device depends on ECH: stop and do not run this scenario.
1. Set `AGENT_ECH_ENABLED=false` on the api service and recreate it.
2. Wait for a heartbeat (the agent persists `ech_server_enabled: false`). The live WebSocket must stay up. The next heartbeat still carries `echActive: true` (the wire is still ECH) and `control_plane` shows `warning` with `encrypted client hello disabled by control plane; the next reconnect dials plain`.
3. Force the sockets to drop: disconnect the PC's network briefly and reconnect it (or restart the agent). Restarting the API is not enough behind Cloudflare: it drops only the WebSocket, while the heartbeat's HTTP/2 connection terminates at the edge and survives, so heartbeats keep flowing over ECH.

Expected:

- The device stays connected until the socket drops, then the next dial is plain (`attempt=plain`) and the filter blocks it: the device goes offline. This proves the switch.
- No `attempt=ech` lines after the switch.

Rollback: set `AGENT_ECH_ENABLED=true` (or remove it) and recreate the api service. The agent persists `ech_server_enabled: false` across restarts, so the PC only re-enables ECH after a heartbeat that reaches the API delivers `ech_enabled: true`; move the PC to an unfiltered network (or tether) for one heartbeat, then return it.

## 4. Self-hosted edge with no `ech=` record

Preconditions: a self-hosted lab edge whose name has no HTTPS record with `ech=`, behind a filtering gateway (or the scenario 1 listener).

Expected:

- `control_plane` goes `degraded` in the agent log (`state: "warning"` in the device health observation / API) with the filter reason once the signature is seen twice.
- `ech-cache.json` never appears.
- No DoH spin: one fetch per failure; three consecutive failures (including fetch failures) move the host to cooldown for 1 h, plain only, with `ech mode changed ... to cooldown`.

Rollback: none needed; restart the agent to leave cooldown early.
