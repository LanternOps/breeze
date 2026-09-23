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

- [ ] (nothing yet)

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Billing profiles — the six legacy labour-pricing columns are unused and will be
  dropped in v0.117.** (#4628 W04a, #6335) Nothing in Breeze reads or writes them since
  the v0.115.0 cut-over, and v0.116.0 rejects the three retired API fields (#6477; see
  the v0.116.0 note in `deploy/upgrades.mdx`). The columns themselves are still in the
  database in v0.116.0, so v0.116 can still be rolled back to v0.115. **v0.117 drops
  them.** If a report, BI query or integration reads `ticket_categories.default_billable`,
  `ticket_categories.default_hourly_rate`, `ticket_categories.rate_currency`, or the
  same three columns on `org_ticket_settings`, directly from the database, repoint it
  before upgrading to v0.117. Use the billing-profile tables (`billing_profiles`,
  `billing_profile_rules`, `org_billing_profile_assignments`) for pricing, or the values
  stamped on each time entry (`time_entries.hourly_rate`, `coverage`, `work_type_id`,
  `billable_minutes`). Those columns hold only the pre-conversion values: editing a rate
  on **Settings → Billing → Rates** has never changed them.
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
