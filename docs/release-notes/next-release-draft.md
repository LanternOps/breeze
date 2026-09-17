# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.113.0** (2026-09-13).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

- [x] Sweep PR **#6104** merged 2026-09-17 (template suggestion, identity-report empty paths / closes #6100, row-menu clipping + the 2026-09-17 sweep doc). Also on main: #6031 (prior sweep), #6084 (rustls, Cargo Audit green).
- [x] Live-agent rows run on the lab rigs 2026-09-17 (WIN-IMDR2GAIDMV + KIT `lab-ubuntu-src`, agent `0.114.0-rc.sweep` built from main): PASS #6017, #6066, #6040, #5977, #5900, #5907, #5922, #5959 (emission), Linux install/upgrade path. PARTIAL #5901 (hosted half needs a hosted-edition build — check it in the hosted signing lane before the droplet flip), #5973 (race not stageable). #5931 desired-state install PASS end-to-end (real 7-Zip MSI install + honest failure on a bad URL; real walk is Pending → Completed, there is no `Installing` state on this path).
- [x] #6108 blocker fixed — **#6109** merged 2026-09-17: one over-long SNMP instance (any IPv6 route table, 98-110 chars) no longer aborts the poll's single INSERT and discards every metric; `snmp_metrics.instance` widened to `VARCHAR(200)`.
- [x] **#6077** merged 2026-09-17: an `snmp_version='v1'` device is now polled as v1 (GETNEXT walks), not SNMPv2c GetRequest + GetBulk.
- [ ] Flags: nothing new to enable. `TOOL_SOURCES_ENABLED` stays dark; `REMOTE_DESKTOP_FENCE_REQUIRED` stays **off** this release (flip one release after the fence ships, per SEC-038).
- [x] #6107 fixed — **#6121** merged 2026-09-17: the desktop revocation lease now evaluates MFA through the login policy (kill switch, enrolment grace, settings `requireMfa`), so an MFA-less Partner Admin's session is no longer revoked ~80 ms after start when `MFA_FORCE_FOR_PARTNER_ADMIN=false`. No "enrol a factor" upgrade note needed. Fold into the release body under Fixed: v0.113.0 operators saw "Launching viewer…" silently revert.
- [ ] Sweep issues open at cut time, none blocking: #6097, #6098, #6099, #6101, #6102, #6103 (fix PRs #6124, #6128, #6125, #6122, #6127 are open — hold them until after the tag so nothing ships unswept).
- [x] In-app What's New entry for 0.114.0 — **#6131** merged 2026-09-17, so the tag build carries it.
- [x] `network_monitor_results` sized in prod 2026-09-17 (read-only): US ~58k rows / 24 MB, EU ~218k rows / 138 MB. The unbatched `org_id` backfill in `2026-10-16-181300-monitor-coverage-kinds.sql` is a few seconds per region — no window needed. Both regions sit on the same newest migration (769 applied).
- [x] #5901 hosted half PASS 2026-09-17 on KIT `lab-ubuntu-src`: a locally built `hosted-strict` agent staged the watchdog from the prod control plane, SHA-256 identical to the advertised checksum; a mismatched sibling binary was refused. Both regions serve a hosted-edition manifest signed by the official release key; the Windows asset reads `windows-authenticode-required`. **Not run:** the Windows hosted first install (Authenticode check of the staged `.exe`) — spot-check it on the hosted signing lane's build before the droplet flip if time allows. Details in the 2026-09-17 sweep doc.

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Migrations:** 50+ since v0.113.0, all additive except `2026-10-17-130000-drop-catalog-items-unit-price.sql`, which **drops `catalog_items.unit_price`** (#6095). Prices live in `catalog_item_prices`; anything reading the old column directly (custom SQL, BI exports) breaks.
- **New optional env vars, all defaulted** (#6056): `DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS`, `DB_WEDGED_BACKEND_SCAN_DISABLED`, `DB_WEDGED_BACKEND_SCAN_INTERVAL_MS`, `DB_WEDGED_BACKEND_MIN_AGE_MS`, `DB_WEDGED_BACKEND_RECLAIM_DISABLED`, `DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS`, `DB_WEDGED_BACKEND_RECLAIM_MAX_PER_PASS`, `DB_WEDGED_BACKEND_RECLAIM_TIMEOUT_MS`, `DB_WEDGED_BACKEND_CONFIRM_DELAY_MS`. New log lines: `[db-wedged-backend] Detector started …` at boot, and a reclaim line when a backend stuck in `ClientRead` is terminated.
- **Compose mappings added** (#6031): `TOOL_SOURCES_ENABLED`, `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_NAME`, `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED`. Self-hosters with a hand-edited `docker-compose.yml` must copy these into the `api` `environment:` block — a value in `.env` alone does not reach the container. Passkeys on a non-default host need `WEBAUTHN_RP_ID`.
- **Behaviour changes operators will notice:** portal Devices page is now a per-org visibility toggle, **default off** (#6065) — re-enable under Org settings → Portal; the org AI budget editor moved to Org settings → AI (#6014); Variables "All organizations" now lists partner-wide variables only (#6064); four new evidence report types (identity & access, vulnerability management, endpoint management, threat detection).
- **Agent:** SNMP polling moves to per-OID outcomes with bounded table walks and v1-safe walks (#6017); failed polls now persist and show on the network device page (#6066). Hosted first install stages the watchdog from the control plane (#5901); the Windows one-liner downloads into a temp dir instead of the shell cwd (#5900).

