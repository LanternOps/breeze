# Git hooks

Versioned hooks for the repo. Activated automatically by the root
`package.json` `prepare` script, which runs `git config core.hooksPath .githooks`
on `pnpm install`. No manual step needed for contributors.

To activate manually (e.g. after a fresh clone before installing deps):

```bash
git config core.hooksPath .githooks
```

## pre-commit

Runs `scripts/security/scan-confidential.sh --staged` — blocks confidential
infrastructure identifiers / secrets (prod IPs, DB cluster ids, `PGPASSWORD=<value>`,
and any value in the gitignored `internal/security/denylist.txt`) from being
committed. See that script's header for details and the `confidential-ok`
escape hatch. The same scan runs in CI (`.github/workflows/secret-scan.yml`) as
a non-bypassable backstop.
