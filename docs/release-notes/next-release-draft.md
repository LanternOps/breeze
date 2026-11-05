# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.126.0** (2026-11-03).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

- **Next full release (v0.127.0): restore three compose passthroughs.** They were taken back out so v0.126.1 could ship server-only. Re-add `ALERT_WORKER_CONCURRENCY`, `ALERT_WORKER_STAGGER_WINDOW_MS` and `AGENT_CONNECTIONS_MAX_PER_DEVICE` as `${VAR:-}` to the `x-api-env` block of `docker-compose.yml` and `deploy/docker-compose.prod.yml`, and delete `SERVER_ONLY_0_126_1_UNMAPPED` from `apps/api/src/config/envReadComposeCoverage.baseline.ts`.

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Alert notifications that were silently skipped start sending (#10926, #10944).** Rule, monitor and sourced alerts (patch job, maintenance reboot, policy and config compliance, backup, EDR, warranty, network monitor, script exit code and others) often lost their in-app notification, channel sends and escalations, because the notification job read the alert before its row was committed. After this upgrade those deliveries happen: in-app, email, **SMS**, Slack, Teams, PagerDuty, Pushover, webhooks, and **escalations**. Review notification routing, monitor delivery settings and escalation policies before or right after upgrading — SMS costs money and on-call staff will start getting paged for alerts that were quiet before. A row read too early now logs `PROCESS_ALERT_ROW_NOT_FOUND` instead of returning silently. No migration and no new env vars.
- **Wake-on-LAN refuses online targets and records outcomes (#10839).** Waking a device that is already online now returns `TARGET_ONLINE` and sends nothing; a bulk wake reports how many devices it sent to and skipped. Each dispatched wake records an attempt, and a new one-minute `wake-attempt-sweep` job resolves it as `came_online`, `timed_out`, `send_failed` or `unknown` within about 12 minutes. A nightly job prunes closed attempts after 90 days (`WAKE_ATTEMPT_RETENTION_DAYS`, `WAKE_ATTEMPT_RETENTION_BATCH_SIZE`, `WAKE_ATTEMPT_RETENTION_MAX_BATCHES`; all optional).

## Features / API

## Migrations

- `2027-01-20-170000-device-wake-tracking` adds `device_wake_status` and `device_wake_attempts`. `2027-01-20-170100` and `170200` build `(org_id, lower(mac_address))` indexes on `device_network` and `device_ip_history` with `CREATE INDEX CONCURRENTLY`, outside a transaction.
