# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.105.0** (2026-08-11).

---
## Email-to-ticket: the "Enable email-to-ticket" toggle now actually takes effect

**Changed behaviour — #3597 / #3606.**

`settings.ticketing.inbound.enabled` (Settings → Ticketing → Inbound email) was
persisted and rendered but never read by the ingestion pipeline. Mail was
ticketed whether the toggle was on or off, and autoresponders fired for partners
who believed the feature was disabled. It is now enforced on both delivery paths
(the native inbound address and a connected Microsoft 365 shared mailbox).

What operators should know:

- **Nobody loses ingestion on upgrade.** An absent flag reads as *on*, and the
  `2026-08-24-inbound-enabled-backfill.sql` migration repairs a stored `false`
  to `true` for any partner with observed inbound mail. The settings card used to
  write `enabled: false` for partners who only changed an unrelated inbound
  setting, so a stored `false` was not evidence of intent; observed mail is
  evidence of reliance. The migration `RAISE WARNING`s the number of partners it
  repaired — expect one line in the Postgres log on upgrade.
- **A partner who deliberately switched it off and kept getting tickets will now
  find it genuinely stops.** That is the fix, but it is a visible change for
  anyone who had worked around the bug.
- **Off discards, it does not pause.** Mail arriving while the switch is off is
  recorded in the inbound log as `ignored` and dropped — no ticket, no review
  queue entry, no autoresponse. The M365 poller still marks messages read and
  advances its delta cursor, so that mail is not replayed when the feature is
  switched back on.
- **The switch governs new ingestion only.** Rows already in the review queue
  stay manually convertible after switching off.

No new env vars. The migration is data-only (no schema change).
