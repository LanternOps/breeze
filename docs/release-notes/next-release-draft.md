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
