# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.124.0** (2026-10-19).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

_(empty — add the next tag's one-off gates here)_

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Agent: reconnect and Retry-After pacing (W09, #8148).** After a stable connection drops, agents now redial after a random 1–30 s (was 1–5 s); the first dial after process start waits 0–10 s. A device can show offline up to ~30 s longer after an API restart. Agents honour a `drain` frame (`{"type":"drain","reconnectWithinMs":N}`, spread over max(N, 5 s)); dormant until the API sends it (W5c). A `503`/`429` with `Retry-After` on a periodic upload (inventory incl. event logs, recovery keys and the daily patch scan, monitoring results, process samples, peripherals, boot/reliability, message events, logs, UniFi) now defers that route until the delay passes (max 300 s) instead of retrying next cycle; heartbeats and command results are never deferred. Startup inventory/hardware/patch uploads each wait 0–120 s; the first monitoring pass waits up to min(interval, 60 s). Command results produced while the socket is down go straight to the durable outbox. New `agent.yaml` keys: `ws_first_reconnect_window_seconds` (default 30, 0–300; 0–5 restores the 1–5 s spread) and `loop_retry_after` (default true). New agent log lines: `initial connect delayed`, `drain hint received`, `route deferred by server Retry-After`, `command result held for reconnect; persisting to the outbox`, `startup task delayed`, `monitoring first run delayed`; `disconnected` gains `drainWithin` when a hint applied. Docs: deploy/upgrades → Agent reconnect settings.

## Features / API

## Migrations
