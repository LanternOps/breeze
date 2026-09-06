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

Also runs `scripts/check-migration-naming.sh --staged` — blocks migration
filenames the runner would silently skip, additions to the closed reserved
date block, and a new migration that sorts before one already committed on
this branch. See that script's header for the three rules it enforces.

## pre-push

Runs `git fetch origin main --quiet` (skipping the check with a warning if
that fails, e.g. offline) and then
`scripts/check-migration-naming.sh --against-ref origin/main` — blocks a push
when `origin/main` has, since this branch was cut, gained a migration that
sorts *after* one this branch is adding. The commit-time guard above cannot
see this: it only compares against history already reachable from the
branch's own HEAD, so it stays green while CI's "Check Migrations" job (on the
merge commit) would go red. Bypass in a genuine emergency with `git push
--no-verify` — CI runs the same check again, so it cannot be smuggled past
that way.
