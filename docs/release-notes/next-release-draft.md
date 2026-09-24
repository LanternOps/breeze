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
