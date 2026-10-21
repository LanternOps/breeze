# Next release — draft notes

Running scratch list for the next tag. **`/release` Step 1 reads this file** and
folds each entry into the GitHub Release body (mostly Self-Hosting / Upgrade
Notes), then clears it in the same PR that publishes the release.

Add an entry the moment you introduce something an operator or self-hoster would
notice — a new env var, a new log line, a new metric, a changed default, a
behaviour change. A commit subject weeks later will not carry it.

Last release: **v0.124.0** (2026-10-19).

---

## Release to-do (pre-cut gates — see `/release` Step 0.2)

_(empty — add the next tag's one-off gates here)_

## Self-Hosting / Upgrade Notes (fold into the release body)

- **Building the agent from source now needs Go 1.26.10.** The agent module, the YARA pack tool and the release builds move from Go 1.26.9 to 1.26.10 for GO-2026-6809 (`crypto/x509`: distrust compromised intermediate certificates), reachable from the agent's HTTPS network diagnostic. With the default `GOTOOLCHAIN=auto`, an older local Go fetches 1.26.10 on its own, but a newer local Go is used as is, so builders on Go 1.27 need 1.27.3 or later (1.27.0 to 1.27.2 lack the fix). With `GOTOOLCHAIN=local`, install Go 1.26.10 or 1.27.3+ first. Pre-built agent binaries need no action.

## Features / API

## Migrations
