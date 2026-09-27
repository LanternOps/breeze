# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.115.0** (2026-09-21).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

- [ ] Before deploying to hosted, run the platform-admin conversion page for each
  hosted partner. Record pending policies/rows before and after, converted and
  unconvertible counts, actor and run time in the release checklist. After the
  deploy, confirm the boot sweep logged no failed partners and no unretired rows.
- [ ] Hardware & RAID monitoring requires an agent release containing W02a, W02b and
  W05 (#6854). Follow `docs/superpowers/plans/monitoring/evidence/w06-release-request.md`
  (controlled rollout, `AGENT_AUTO_PROMOTE=false`, Windows + Linux canaries) and
  decide whether #6895 must land first.
- [ ] This is the legacy alerting retirement release (W05d, #6372). Conversion
  shipped in v0.117.0; the announcement must tell self-hosters to run **Convert
  everything** on v0.117.0 before upgrading.

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Invoice/quote seller identity now falls back to company details (#6228).** A
  partner whose Billing letterhead override (phone, website, or address) is blank
  now has NEW invoices and quotes fill that gap from their "Company details" tab
  (Settings → Company) instead of leaving it blank. Seller email is unaffected —
  it still comes only from the billing email, never the company contact email.
  Already-issued documents with a frozen (non-null) seller snapshot are
  unchanged. A legacy or draft document with no frozen snapshot may show a
  different address on its live/re-rendered header than before, since previously
  there was no fallback and the field simply rendered blank.
- **Billing profiles — the six legacy labour-pricing columns are dropped (#4628 W04b,
  #6335).** `ticket_categories` and `org_ticket_settings` each lose `default_billable`,
  `default_hourly_rate` and `rate_currency`. Nothing in Breeze has read or written them
  since the v0.115.0 cut-over, and v0.116.0 already rejects the three retired API fields
  (#6477). A report, BI query or integration that selects these columns directly from
  the database fails after the upgrade. Repoint it at the billing-profile tables
  (`billing_profiles`, `billing_profile_rules`, `org_billing_profile_assignments`) or at
  the values stamped on each time entry (`time_entries.hourly_rate`, `coverage`,
  `work_type_id`, `billable_minutes`).
  - **The old values are archived, not lost.** Before dropping the columns, the migration
    copies every row that still holds legacy pricing into the new table
    `legacy_labour_pricing_archive`. Its `skip_reason` column flags the values the v0.115.0
    conversion never carried into a billing profile: organizations in an off-list
    currency, organization rates entered in another currency, rates on non-billable
    organizations and categories, and category rates with no or an unsupported currency. Re-enter any of those
    you still need on **Settings → Billing → Rates**. The query is in
    `deploy/upgrades.mdx` (v0.117.0), and the API log counts every archived row.
  - **Rollback to v0.116 needs a database restore.** The v0.116 image's tenant-export
    policy still lists the dropped `org_ticket_settings` columns, so organization data
    export fails on a v0.116 image against an upgraded database. Back up before upgrading.
  - The migration refuses to run (the API does not start) if any partner was never
    converted to billing profiles, or if manual DDL left only some of a table's three
    legacy columns. A normal upgrade cannot produce either state.
- **Billables CSV gains two columns, appended at the end:** `work_type` and
  `included_minutes` (worked minutes of contract-included time; `0` on other time rows,
  empty on parts). Existing columns keep their position, so index-mapped imports keep
  working. A strict importer that rejects unknown trailing columns needs updating.
- **Mobile app and Outlook add-in get a work-type picker.** The mobile ticket timer and
  the add-in time widget (log and start) can now pick a work type. Leaving it on
  *Default* still applies the ticket category's default work type on the server, exactly
  as older builds do. The add-in gains `GET /office-addin/time/work-types`, which needs
  the `time-read` capability **and** `billing_profiles:read`, the same permission as the
  web picker. `POST /office-addin/time/log` and `/time/start` accept an optional
  `workTypeId` (UUID); a malformed value returns 400.
- **Hardware & RAID monitoring (#6854) — needs the agent update too.** The device
  Hardware tab shows RAID arrays, physical disks, controller cache batteries and
  collection status. Attach the four built-in hardware monitors to a configuration
  policy to receive per-component failure alerts; they are not attached by default.
  Collection is on by default (RAID every 10 minutes, disk health every 60 minutes),
  set per policy under **Hardware Monitoring**. Vendor tools must already be
  installed. A rebuilding array is a warning, and a critical array alert resolves
  after two below-critical polls. Known issue: on Windows Storage Spaces, a member
  that disconnects and returns can leave its physical-disk alert open (#6895).

## Network checks become monitors

- **Network check authoring moves to Monitors (W05e).** Author `network_check`
  definitions under **Alerts → Monitors**, with an asset picker. **Network** keeps
  **Assets**, **SNMP Templates** and **Results**, including links to owning monitors.
- **Conversion is interactive; the network runtime is retained.** Existing
  unmanaged checks keep polling and alerting. The Results banner previews and
  converts a single offline/consecutive-failure rule into a monitor in a dedicated,
  cumulative organization-level **Network checks — <org name>** policy. Probe
  history and open-alert status/provenance are preserved, including alerts on
  offline alert devices. Checks without active rules remain non-alerting; multiple
  rules (including mixed predicates or severities), unsupported thresholds,
  degraded/response-time predicates and site-only bindings are refused.
- **Prerequisites are retained, not new fixes:** #6352 already sends the HTTP
  `expectStatus` field to agents as `expectedStatus`; extended #6353 evaluates
  checks independently of alert-device online state. Missing runtime capability
  blocks the whole network preview with no per-check refusals. Partner interactive
  conversion can still process other source types. The boot sweep never converts
  or retires network checks. New HTTP checks retain #6510's redirect default for
  expected 3xx responses; conversion preserves the legacy effective setting.
- **Retirement keeps history.** Explicit retirement is recorded in the persistent
  conversion ledger and can be reversed while the network runtime remains.
  Conversion and retirement never resolve open alerts. Deleting an adopted monitor
  retires its probe and preserves results. Bound retained checks block asset deletion
  with `409 asset_has_retained_network_checks`.
- **Legacy writes return `410 Gone`.** Check create/update and alert-rule
  create/update/delete return `network_check_authoring_retired`; unmanaged check
  deletion also returns 410. Cleanup uses ledger retirement. Managed probe deletion
  directs callers to its monitor. Reads and operational check/test calls remain.
  AI tools likewise direct authoring to monitor definitions.
- **Device action is SNMP-only.** **Disable SNMP monitoring** uses SNMP PATCH.
  The old `DELETE /monitoring/assets/:id` returns `409 network_checks_active`
  before mutation when checks are active, with guidance to disable managed checks
  in Monitors or convert/retire unmanaged checks.
- **Migration `2026-10-31-120000-network-checks-as-monitors.sql`** adds retirement
  metadata, conversion snapshots and asset ownership constraints. It is idempotent
  and performs no data conversion or retirement.

## Legacy alerting retirement

- **Removed authoring paths.** The policy **Alerts** and **Service & Process
  Monitoring** tabs are removed, and the old `/alerts/rules` page redirects to
  **Alerts → Monitors**. Legacy rule and template write endpoints under
  `/alerts/rules*` and `/alert-templates*`, including rule tests and toggles, return
  `410 Gone`; reads remain for history. The retired configuration feature types
  `alert_rule` and `monitoring` also return `410 Gone`. Author and test monitors
  through `/monitor-definitions` and attach them using `featureType: "monitors"`.
- **Before upgrading:** run the previous release's **Convert everything** and
  review every refusal. Conversion must have been available for one full release
  before this upgrade. This avoids a gap in evaluation while the startup sweep
  runs after the API starts serving requests. Undo for removed legacy runtimes
  ends at this upgrade.
- **Unattended conversion on boot.** The API processes remaining legacy sources
  per partner, converts supported sources and retires unconvertible sources with
  reasons. **Alerts → Monitors** shows a dismissible review banner listing them.
  Recreate needed conditions as monitors before dismissing it. Open alerts from
  unconvertible retired sources stay open until a person resolves them; converted
  sources' open alerts move to the compiled monitor path. Network checks retain
  their runtime and are excluded from automatic retirement.
- **Startup verification.** After the sweep, every boot counts unretired
  `config_policy_alert_rules` and `config_policy_monitoring_watches`. Non-zero
  counts are logged at error level and reported to Sentry: those rows no longer
  have an evaluator. Review the banner and startup errors, including any failed
  partner conversions. `BREEZE_LEGACY_ALERTING_SWEEP=false` skips conversion but
  still runs the count check.
- **Maintenance windows suppress monitor alerts again.** On v0.117.0, a window
  with **Suppress alerts** did not stop alerts from monitors, including rules
  converted to monitors (CPU, disk, service, event log); only the legacy evaluator
  checked it. The monitor evaluator now checks the window: no new alerts open
  during it, and alerts already open can still recover. Expect fewer alerts during
  maintenance than on v0.117.0.
- **Delivery boundary.** Queued legacy alerts and unconverted standalone rules
  no longer use their old channel or escalation overrides. Delivery follows
  monitor settings, routing rows and the explicit **Everything else** row;
  without a matching destination, no notification is sent. Review routing before
  upgrading.
- **Migration `2026-10-31-110000-legacy-alerting-retirement-sweep.sql`** moves each
  policy's check interval to its `monitors` feature link and prints warning counts
  of remaining unretired sources. It is idempotent and deletes no data. The
  **Monitors** tab owns **Check interval**; legacy source rows remain for history.
