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

- [ ] Deploy prerequisites and W05c1 before enabling the conversion UI.
- [ ] Run the platform-admin conversion page for each hosted partner. Record
  pending policies/rows before and after, converted and unconvertible counts,
  actor and run time in the release checklist. Review every non-zero remainder.
- [ ] Hardware & RAID monitoring requires an agent release containing W02a, W02b and
  W05 (#6854). Follow `docs/superpowers/plans/monitoring/evidence/w06-release-request.md`
  (controlled rollout, `AGENT_AUTO_PROMOTE=false`, Windows + Linux canaries) and
  decide whether #6895 must land first.
- [ ] Announce the W05d retirement release at least one release after W05c.
  Self-hosters must review Needs conversion before upgrading to that release.

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
- **Alerting conversion (W05c):** Alerts now has Inbox, Monitors and Delivery.
  Open Alerts → Monitors → Needs conversion, then review each policy preview.
  Convert only after reviewing device equivalence and the proposed delivery.
  Unconvertible rows show reasons and require deliberate replacement or retirement.
  Source rows and alert history are retained. Conversion history provides persistent
  Undo until W05d removes the source runtime; unavailable entries disable Undo. Partner managers can Convert everything;
  review the returned unconvertible count afterward.
- **Deadline:** complete review before W05d, which will ship at least one release
  later. W05d performs the remaining sweep and lists unconvertible retirements.
  The legacy policy tabs still exist during W05c. Alert Templates settings URLs
  redirect to Monitors immediately; condition authoring belongs to Monitors.
- **Delivery defaults:** the explicit Everything else row controls fallback.
  New channels are not subscribed until added to a routing row or monitor override.
- **Device and automation views:** device Monitoring shows effective monitors,
  source policy, episodes and escalation. Reset escalation resumes responses but
  does not resolve an alert. Jobs → Alert workflows supports severity/kind filters.
  Fleet Designer applies monitor attachments; regenerate old rule-shaped proposals.
- **Hardware & RAID monitoring (#6854) — needs the agent update too.** The device
  Hardware tab shows RAID arrays, physical disks, controller cache batteries and
  collection status. Attach the four built-in hardware monitors to a configuration
  policy to receive per-component failure alerts; they are not attached by default.
  Collection is on by default (RAID every 10 minutes, disk health every 60 minutes),
  set per policy under **Hardware Monitoring**. Vendor tools must already be
  installed. A rebuilding array is a warning, and a critical array alert resolves
  after two below-critical polls. Known issue: on Windows Storage Spaces, a member
  that disconnects and returns can leave its physical-disk alert open (#6895).
