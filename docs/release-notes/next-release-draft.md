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

- [ ] Merge sweep PR **#6104** (template suggestion, identity-report empty paths / closes #6100, row-menu clipping + the 2026-09-17 sweep doc). Already on main: #6031 (prior sweep), #6084 (rustls, Cargo Audit green).
- [ ] Live-agent rows on the lab rigs before tagging — results go in `docs/testing/release-sweeps/2026-09-17-3ef2275-to-main.md`: #6017 (SNMP oidSpecs / bounded walks / per-OID outcomes), #5907 (repeat network-proxy Connect), #5901 (hosted first install stages the watchdog), #5900 (Windows one-liner temp dir), and the five carried from 2026-09-16: #5922, #5959, #5977, #5931, #5973.
- [ ] Flags: nothing new to enable. `TOOL_SOURCES_ENABLED` stays dark; `REMOTE_DESKTOP_FENCE_REQUIRED` stays **off** this release (flip one release after the fence ships, per SEC-038).
- [ ] **Decide before the cut: #6107** — since v0.113.0 every desktop session of a Partner Admin with no MFA factor is revoked ~80 ms after start (`mfa_required`, silent in the UI) because the revocation lease ignores `MFA_FORCE_FOR_PARTNER_ADMIN=false`. Live in prod today; auth surface, so it needs a deliberate fix, and if it is not fixed in this release the upgrade notes must tell operators to enrol a factor.
- [ ] Sweep issues open at cut time, none blocking: #6097, #6098, #6099, #6101, #6102, #6103.

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Migrations:** 50+ since v0.113.0, all additive except `2026-10-17-130000-drop-catalog-items-unit-price.sql`, which **drops `catalog_items.unit_price`** (#6095). Prices live in `catalog_item_prices`; anything reading the old column directly (custom SQL, BI exports) breaks.
- **New optional env vars, all defaulted** (#6056): `DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS`, `DB_WEDGED_BACKEND_SCAN_DISABLED`, `DB_WEDGED_BACKEND_SCAN_INTERVAL_MS`, `DB_WEDGED_BACKEND_MIN_AGE_MS`, `DB_WEDGED_BACKEND_RECLAIM_DISABLED`, `DB_WEDGED_BACKEND_RECLAIM_MIN_INTERVAL_MS`, `DB_WEDGED_BACKEND_RECLAIM_MAX_PER_PASS`, `DB_WEDGED_BACKEND_RECLAIM_TIMEOUT_MS`, `DB_WEDGED_BACKEND_CONFIRM_DELAY_MS`. New log lines: `[db-wedged-backend] Detector started …` at boot, and a reclaim line when a backend stuck in `ClientRead` is terminated.
- **Compose mappings added** (#6031): `TOOL_SOURCES_ENABLED`, `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_NAME`, `BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED`. Self-hosters with a hand-edited `docker-compose.yml` must copy these into the `api` `environment:` block — a value in `.env` alone does not reach the container. Passkeys on a non-default host need `WEBAUTHN_RP_ID`.
- **Behaviour changes operators will notice:** portal Devices page is now a per-org visibility toggle, **default off** (#6065) — re-enable under Org settings → Portal; the org AI budget editor moved to Org settings → AI (#6014); Variables "All organizations" now lists partner-wide variables only (#6064); four new evidence report types (identity & access, vulnerability management, endpoint management, threat detection).
- **Agent:** SNMP polling moves to per-OID outcomes with bounded table walks and v1-safe walks (#6017); failed polls now persist and show on the network device page (#6066). Hosted first install stages the watchdog from the control plane (#5901); the Windows one-liner downloads into a temp dir instead of the shell cwd (#5900).

