# Merge queue and production deploy

Moved verbatim from `CLAUDE.md` (2026-10-07). Read before merging a PR or deploying to the EU/US droplets.

## PR Merge Process — merge queue (since 2026-09-07)
- `main` uses GitHub's **merge queue**. Merge with `gh pr merge <N>` (no strategy flag, no `--admin`): the PR is enqueued, the queue rebuilds it on top of whatever is ahead of it, runs the full `CI Success` gate on that merge ref, and lands it serially. The queue owns the strategy (squash); passing `--squash` only prints a warning.
- **Never `--admin`.** Admin bypass skips the queue and lands the commit directly, which is exactly what produced the 09-06/09-07 pile-ups: concurrent sessions each admin-merging cancelled 59 of 80 main CI runs in 48h, so main's true state was never evaluated, and sibling PRs went CONFLICTING mid-sweep. Reserve `--admin` for a genuine emergency (main red and the fix itself cannot pass the queue), say so in the PR, and immediately run `gh workflow run CI --ref main` — `ci.yml` no longer runs on pushes to main (queue landings were already evaluated on their merge-group ref), so a bypass merge is untested until you dispatch it.
- No reviewer approval is required by the ruleset any more; the review round is the `/pr-review-toolkit:review-pr` pass recorded on the PR, not a GitHub approval. Required check is `CI Success` only. `ci.yml` runs on every PR; its `changes` job classifies the diff and a docs-only PR (`docs/**`, `apps/docs/**`, `*.md`, `*.mdx`) skips the code jobs, runs only the `docs-check` job (astro check + build, formerly `docs-ci.yml`), and still gets a passing `CI Success` so it can enter the queue (the queue then runs the full suite on the merge ref). Only `ci.yml` ever reports `CI Success` — never add a second workflow with that check name, two reporters race for the required-check slot.
- Queue semantics to know: a PR must be green on its own head to be enqueued; the queue then runs `ci.yml` under the `merge_group` event with the smoke jobs blocking (they are non-blocking on `pull_request` only). The `changes` classifier runs there too (since #5863): a queue entry is classified from a `git diff` of `merge_group.base_sha...head_sha` with the same rules as a PR, so a docs-only entry skips the code jobs — and anything unresolvable falls back to the full suite. If the queue run fails, the PR is dequeued with a comment — fix and re-enqueue, do not bypass.
- Any session may enqueue its own reviewed, green PR. Serialisation is the queue's job now, not a single-merger rule.

## Production Deploy (EU + US droplets)

Droplets pull from `/opt/breeze` and use mutable image tags driven by `BREEZE_VERSION` in `/opt/breeze/.env`. The flow is:

```bash
ssh root@<droplet> "cd /opt/breeze && \
  cp .env .env.bak-pre-<new-version> && \
  sed -i 's/^BREEZE_VERSION=.*/BREEZE_VERSION=<new-version>/' .env && \
  docker compose pull api web portal && \
  docker compose up -d binaries-init api web portal && \
  docker image prune -af --filter 'until=168h' && \
  docker builder prune -af"
```

Then `curl -sf https://<region>.2breeze.app/health` to verify (200 = healthy).

**The two prune lines are part of the deploy, not optional cleanup.** Every release pulls a fresh set of images and nothing removes the previous ones. On 2026-09-22 stale images held 18 GB on US and 20 GB on EU (about 75% of all image storage), and the US root disk had already hit 100% twice (09-04, 09-06). `prune -a` only removes images no container references, running or stopped, so the locally built `breeze-billing:local` survives. The `until=168h` filter keeps last week's images so a rollback to the previous `BREEZE_VERSION` needs no re-pull.

**The service list is hand-maintained and WILL go stale — always assert version parity after deploying.** The line names services explicitly (not a bare `docker compose pull && up -d`) because `billing` builds from a local `breeze-billing:local` image with no registry to pull from, and a bare `up -d` would needlessly bounce `caddy`/`redis`/`tunnel`. The cost is that adding a new first-party service silently breaks the rollout: `portal` was added in v0.94.0, never made it into the deploy line, and sat on `0.94.0` through five releases while `/health` reported `0.98.1` — a portal fix from v0.97.0 was invisible in production for 11 days (2026-07-20). Watchtower is not a backstop: it runs `WATCHTOWER_LABEL_ENABLE=true` and no service carries the label, so it updates nothing.

`/health` is served by the API and cannot detect this, so enumerate what is actually running instead of trusting the list:

```bash
ssh root@<droplet> "cd /opt/breeze && set -a && . ./.env && set +a && \
  docker ps -a --format '{{.Names}}\t{{.Image}}' | grep 'ghcr.io/lanternops/breeze/' | \
  while IFS=\$'\t' read -r n i; do t=\${i##*:}; \
    [ \"\$t\" = \"\$BREEZE_VERSION\" ] && echo \"OK    \$n \$t\" || echo \"SKEW  \$n \$t (expected \$BREEZE_VERSION)\"; done"
# every line must be OK; any SKEW means that service was never rolled.
```

**Required env vars added by v0.65+ — droplets without these refuse to start:**

- `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` — base64 SPKI of the Ed25519 release manifest signing key. Source: `internal/release-keys/release-manifest.ed25519.pub` (the base64 between `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`, single line). The API config validator refuses to boot in production without it when `BINARY_SOURCE=github`.
- `IS_HOSTED` — must be explicitly set to `true` (hosted SaaS) or `false` (self-hosted) in production. Without this, a misconfigured deploy (e.g. `.env` value not mapped through compose) silently drops new partners straight to `status='active'`, bypassing the email-verification gate in `/auth/register-partner` (issue #570).

When introducing a new required env var: add it to `/opt/breeze/.env` AND map it explicitly in the `api`/`web` service `environment:` block of `/opt/breeze/docker-compose.yml`. Compose interpolation only happens for vars listed there — having a value in `.env` is necessary but not sufficient.

**Watchtower policy (#603):** repo-tracked compose files never include Watchtower (enforced by `check-supply-chain-hardening.sh`). On droplets, Watchtower is acceptable for sidecars (caddy, redis, postgres-exporter, cloudflared) but **must not** auto-update `breeze-api` or `breeze-web`. Concretely, the `com.centurylinklabs.watchtower.enable: "true"` label is forbidden on those two services. The hardening check additionally rejects that label string in any tracked compose file as defense-in-depth.

**Known drift:** the deployed `/opt/breeze/docker-compose.yml` uses Watchtower + mutable tags, while `deploy/docker-compose.prod.yml` in the repo uses digest-pinning + no Watchtower. The `check-supply-chain-hardening.sh` rule scans repo files only, so the droplet drift isn't fully enforced. Reconciling this is tracked separately.
