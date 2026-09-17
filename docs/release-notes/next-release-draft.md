# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.113.0** (2026-09-13).

---

- **Behaviour change (intentional):** a site-restricted technician now loses a
  parent software deployment entirely — not just its out-of-ceiling child
  results — when any target device sits outside their site ceiling, including
  their own multi-site deployments they created. This closes an existence
  oracle / partial-view leak found in the September site-scope security
  review (#5545, follow-up #5777).
