# Merge queue and production deploy

Moved verbatim from `CLAUDE.md` (2026-10-07). Read before merging a PR or deploying to the EU/US droplets.

## PR Merge Process — merge queue (since 2026-09-07)
- `main` uses GitHub's **merge queue**. Merge with `gh pr merge <N>` (no strategy flag, no `--admin`): the PR is enqueued, the queue rebuilds it on top of whatever is ahead of it, runs the full `CI Success` gate on that merge ref, and lands it serially. The queue owns the strategy (squash); passing `--squash` only prints a warning.
- **Never `--admin`.** Admin bypass skips the queue and lands the commit directly, which is exactly what produced the 09-06/09-07 pile-ups: concurrent sessions each admin-merging cancelled 59 of 80 main CI runs in 48h, so main's true state was never evaluated, and sibling PRs went CONFLICTING mid-sweep. Reserve `--admin` for a genuine emergency (main red and the fix itself cannot pass the queue), say so in the PR, and immediately run `gh workflow run CI --ref main` — `ci.yml` no longer runs on pushes to main (queue landings were already evaluated on their merge-group ref), so a bypass merge is untested until you dispatch it.
- No reviewer approval is required by the ruleset any more; the review round is the `/pr-review-toolkit:review-pr` pass recorded on the PR, not a GitHub approval. Required check is `CI Success` only. `ci.yml` runs on every PR; its `changes` job classifies the diff and a docs-only PR (`docs/**`, `apps/docs/**`, `*.md`, `*.mdx`) skips the code jobs, runs only the `docs-check` job (astro check + build, formerly `docs-ci.yml`), and still gets a passing `CI Success` so it can enter the queue (the queue then runs the full suite on the merge ref). Only `ci.yml` ever reports `CI Success` — never add a second workflow with that check name, two reporters race for the required-check slot.
- Queue semantics to know: a PR must be green on its own head to be enqueued; the queue then runs `ci.yml` under the `merge_group` event with the smoke jobs blocking (they are non-blocking on `pull_request` only). The `changes` classifier runs there too (since #5863): a queue entry is classified from a `git diff` of `merge_group.base_sha...head_sha` with the same rules as a PR, so a docs-only entry skips the code jobs — and anything unresolvable falls back to the full suite. If the queue run fails, the PR is dequeued with a comment — fix and re-enqueue, do not bypass.
- Any session may enqueue its own reviewed, green PR. Serialisation is the queue's job now, not a single-merger rule.

## CI Gate (pinned merge-queue gate, #10746)

`.github/workflows/ci-gate.yml`, job `CI Gate`. An org ruleset requires it and reads it from `main`, so a change cannot edit the gate that judges it. `CI Success` stays required and means what it did.

**It does nothing until the org ruleset exists.** Both triggers are filtered to the never-matching branch `ci-gate-ruleset-only`, so the ordinary trigger never fires, and `gh run list --workflow ci-gate.yml` stays empty. The ruleset ignores those filters. To see the current state: `gh api orgs/LanternOps/rulesets --jq '.[]|{id,name,enforcement}'` (needs `admin:org`). `gh api repos/LanternOps/breeze/rules/branches/main --jq '[.[]|select(.type=="workflows")]'` lists the rule only under Active, because GitHub leaves evaluate and disabled rulesets out of that endpoint. The rollout is Evaluate first (cannot block a merge), then Active; the owner does both. Evidence and steps are in `docs/superpowers/plans/ci/2026-11-05-ci-throughput-w02.md`.

**What it does:**
- `merge_group`: `ci-gate.mjs select` first publishes the entry's queue selection (below). Then `ci-gate.mjs verify` waits for the entry's `ci.yml` run, classifies the entry diff with the **base** revision's classifier, and runs the **base** revision's `ci-success` script against job results from the Actions API and that selection. Exit 0 only on `verdict=pass`.
- `pull_request`: `ci-gate.mjs anchor` passes at once and uploads a record of the merge commit tested, for W05. A green `CI Gate` on a PR says nothing about tests. `CI Success` still judges the PR.

**What it claims:** a PR cannot lower its own selection by editing the classifier, floor, reader map, the `changes` job, `ci-success.needs` or the `ci-success` script, or by skipping, removing or renaming a required job.

**What it does not claim:** it does not prove tests ran honestly. A PR can still replace a job's `run:` under the same id, and can edit `package.json` test scripts, vitest config or the tests themselves. Do not describe it as more than a selection check.

**Reading a run.** Each run logs exactly one `ci-gate: verdict=… reason=… event=… base=… head=… ci_run=… attempt=… policy_paths=… flags=… oracle=… thin=…` line. `thin=…` counts the jobs the published selection let this entry skip: 0 unless it said `mode=thin`, `none` on a PR. `ci-gate-identity:` has the workflow ref and sha. Reasons:

| Reason | Meaning |
|---|---|
| `required_jobs_passed` | pass |
| `required_jobs_failed:<jobs>` | the base script said no; these jobs are why |
| `required_jobs_failed` | the base script said no, and no single job explains it; read the `ci-gate-script:` lines |
| `thin_skip_unjustified:<jobs>` | the base script said no, and every job it blames is a thinnable job that was skipped though the published selection did not list it. A selection fault, not a test failure: the entry's CI skipped a job nothing allowed it to skip, either because the PR's own `ci.yml` skips it or because a thin queue consumer misread the list. If the PR does not explain it and the thin queue is on, turn the thin queue off |
| `not_pinned` | the workflow sha is not on `main`, so this is not the pinned copy, or the check could not run; `ci-gate-detail:` says which |
| `base_unreadable` | a queue sha, base or head, could not be fetched or read; `ci-gate-detail:` says which and why |
| `head_unreadable`, `head_unparseable`, `aggregator_unparseable`, `aggregator_exec`, `duplicate_job_name`, `continue_on_error_unsupported` | the verdict could not be computed; fails closed |
| `ci_run_missing` | no `ci.yml` run for this exact sha within 15 minutes |
| `ci_cancelled` | the entry's CI run was cancelled, usually a stale group |
| `deadline` | still not finished after 140 minutes |
| `api_error` | the Actions API failed for 15 consecutive minutes; infrastructure, not the PR |
| `wrong_event`, `invalid_repository`, `error` | a bug in the gate or its wiring |
| `anchor_written` | PR only: the anchor was recorded |
| `merge_head_mismatch`, `anchor_invalid_input`, `anchor_error` | PR only, and still `verdict=pass`: no anchor was written, because `github.sha` was not a merge of the head, an input was bad, or writing it failed |

`oracle=disagree:<n>` is a warning and never changes a verdict, but it means the gate's rollup differs from `needs.<job>.result`. Look into it. On a PR, no anchor is safe: W05 treats it as "run everything". So when counting verdicts, read `reason`, because a PR with no anchor also logs `verdict=pass`.

**The queue selection (W05, #10749).** Before CI fans out, a queue run's `select` step decides which jobs the entry may skip, writes `ci-gate-selection.json`, and the next step uploads it as `ci-gate-selection-attempt-<n>` (kept 7 days; the one soft step, since a failed upload only means CI finds no list and runs everything). `verify` then judges the entry against exactly that file: only `mode=thin` hands its `thin_skip` list to the base revision's `ci-success` as `THIN_SKIP`, and a base without the W05 block ignores it. A `mode=full` file lists nothing. A file that is missing, unreadable, or for another head, base, ref, run or attempt is judged as `mode=full` and logs `ci-gate-detail: selection unusable: …`. A thin list only ever removes jobs: `would_skip`, intersected with the 27 thinnable jobs (W04's build, unit, integration and reader classes) and with the base `ci-success`'s case labels. A re-run of the gate re-publishes attempt 1's file rather than choosing again, because CI may already have acted on it. With `CI_THIN_QUEUE` unset or `off`, every selection is `mode=full reason=thin_disabled`, so the selection changes nothing.

Each queue run logs one `ci-gate-selection: mode=… reason=… thin_queue=… thin_skip=… source_attempt=… would_reason=… would_thin_skip=… pr=… head=… B=… p=… …` line; the fields after `would_thin_skip` are the candidate-side `queue-selection:` line's. `would_reason` and `would_thin_skip` are what `enforce` would have published. They are logged only, so the shadow record (and the audit sample's list) survives the kill switch without any file carrying a list. `select` always exits 0: an exception is `reason=error`, and its children and sleeps stop after 3 minutes so it cannot eat the wait `verify` needs. Its evidence comes only from sources the candidate cannot write: anchors from pinned gate runs, and the latest attempt of the PR's newest `ci.yml` run, judged by the base's script and classifier. `provenance.json` is never read. A pinned run is one at `.github/workflows/ci-gate.yml` whose `workflow_id` is not listed by `actions/workflows`, with a `ci-gate-identity:` line naming `@refs/heads/main`. `record_stats` has the detail. Each of these means "run everything":

| Reason | Meaning |
|---|---|
| `thin_disabled` | `CI_THIN_QUEUE` is neither `enforce` nor `shadow`; `would_reason` says what enforce would have done |
| `not_pinned`, `base_unreadable` | as for the verdict: not the pinned gate, or a queue sha could not be fetched |
| `no_base_flags` | the base classifier's flags could not be computed, so no selection was |
| `no_anchor` | no usable anchor for this head: no gate run, nothing written, expired after 7 days, or rejected (`record_stats.rejected`) |
| `anchor_not_pinned` | anchors exist, but only from runs that are not the pinned gate (`record_stats.not_pinned`); a PR enabling its own copy of the gate looks like this |
| `anchor_policy_in_p` | an anchor's files include a policy path |
| `no_verified_pr_run` | the PR's run did not pass the base's script, or could not be checked (`record_stats.verification`) |
| `thin_unsupported_at_base` | the base revision's `ci-success` has no W05 block it can read exactly, so it could not excuse a skip |
| `nothing_to_skip` | nothing in `would_skip` is both thinnable and labelled at the base |
| `audit_sample` | under `enforce`, one thin-eligible entry in 5 (by head sha) runs full while logging the list it would have skipped |
| `attempt1_selection_missing` | a re-run found no usable attempt-1 selection in its own run; if CI already skipped jobs, the entry goes red, which is the safe direction |
| `error` | a bug or an unreadable input; `error` on the line has the cause |
| `selection_time_limit`, `selection_ancestry`, `base_io_refused` | text rather than a `reason=` value: usually in `error` under `reason=error`. Out of time, the check that a run's sha is on `main` could not run, or a read tried to run something other than the base classifier. Running out of time can also show as `delta_uncomputable` or `no_verified_pr_run`, and a child killed at the limit shows a timeout error |

Any other reason is a W4 fallback (`stale_base`, `entry_outside_p`, `entry_not_single_commit`, and so on). `mode=shadow` carries the real list but means "run everything" too.

**Changing the gate.** Any PR changing `ci-gate.mjs` or `ci-gate.yml` attaches a green replay run: `gh workflow run CI --ref <branch>`, then read the `ci-gate-replay:` line (`disagreements=0 controlFailures=0`). The dispatch cannot run `ci-gate.yml` itself. `pinned-ci-gate-invariants` in `check-workflow-security.mjs` fixes the workflow's shape.

**Removing a required job takes two PRs.** The queue judges a PR with its base's `ci-success`, so deleting a job in the PR that drops it reads as `missing` and goes red. First drop it from `ci-success`'s `needs` and script, keeping the job. Delete the job in a later PR, once the first has landed. Changing only a display name needs no staging: job ids are the identity.

### Thin queue kill switch

`CI_THIN_QUEUE` is a repository variable that the gate's `select` step reads (W05, #10749). Unset or `off`, the default: every queue selection is `mode=full`, so CI runs everything. `shadow`: the gate publishes its real list but CI still runs everything, as a dress rehearsal. `enforce`: CI may skip what the list allows, and the gate judges the entry against that list. Any other value counts as off.

- Turn it off with `gh variable set CI_THIN_QUEUE --body off -R LanternOps/breeze` and confirm with `gh variable get CI_THIN_QUEUE -R LanternOps/breeze`. Anyone working the queue may do this unprompted; tell the owner.
- A change applies from the next queue entry. Entries already running finish under the list their gate published, so a flip never ejects anything. If a thin entry may have let a failure through, also remove and re-add every in-flight entry whose gate published `mode=thin`, so each one rebuilds in full.
- Never set the ruleset to **Evaluate** while `CI_THIN_QUEUE` is `enforce`: in Evaluate the gate still runs and publishes, so CI would skip jobs while nothing enforces the verdict.

### CI Gate rollback

**Under Active, a broken gate blocks its own fix**, and a revert of itself. Enforcement goes off first, always, and only the owner can do it (`admin:org`).

0. Turn the thin queue off first: `gh variable set CI_THIN_QUEUE --body off -R LanternOps/breeze`, then confirm with `gh variable get CI_THIN_QUEUE -R LanternOps/breeze`. In Evaluate the gate still runs and publishes its selection, so CI would keep skipping jobs while nothing enforces the gate's verdict.
1. The owner sets the org ruleset to **Evaluate** or **Disabled**. In the UI: LanternOps → Settings → Repository → Rulesets → `Breeze pinned CI gate` → Enforcement status. By API: find the id with `gh api orgs/LanternOps/rulesets --jq '.[]|{id,name,enforcement}'`, then `gh api -X PUT orgs/LanternOps/rulesets/<id> -f enforcement=evaluate`.
2. Confirm with `gh api repos/LanternOps/breeze/rules/branches/main --jq '[.[]|select(.type=="workflows")]'`. An empty list means the rule is no longer enforced, because that endpoint returns only active rules. `gh api orgs/LanternOps/rulesets/<id> --jq .enforcement` shows which state it is in.
3. Only then touch the workflow or `ci-gate.mjs`.

Do not remove or rename `ci-gate.yml` while the rule is Active.

## Production Deploy (EU + US droplets)

Droplets pull from `/opt/breeze` and use mutable image tags driven by `BREEZE_VERSION` in `/opt/breeze/.env`. The flow is:

```bash
ssh root@<droplet> "cd /opt/breeze && \
  cp .env .env.bak-pre-<new-version> && \
  sed -i 's/^BREEZE_VERSION=.*/BREEZE_VERSION=<new-version>/' .env && \
  sed -i '/^BREEZE_API_IMAGE_TAG=/d' .env && \
  W=\$(grep -qE '^COMPOSE_PROFILES=.*worker-split' .env && echo worker || true) && \
  docker compose pull api web portal \$W && \
  docker compose up -d binaries-init api web portal \$W && \
  docker image prune -af --filter 'until=168h' && \
  docker builder prune -af"
```

Then `curl -sf https://<region>.2breeze.app/health` to verify (200 = healthy).

**Two droplet-local overrides the line above handles** (both added 2026-10-07):
- **Worker split.** A droplet running the optional `worker` container (`COMPOSE_PROFILES=worker-split` in `.env`, see `apps/docs/src/content/docs/deploy/worker-split.mdx`) must roll it with the API, or it keeps running the old image's job code against the new schema. `W` adds it to the pull/up only where the profile is on.
- **API hotfix pin.** `BREEZE_API_IMAGE_TAG` in `.env` pins the API (and worker) image to a hotfix tag independently of `BREEZE_VERSION`. A full release must drop it, or the API stays on the hotfix image while `/health` reports the new version (compose sets `APP_VERSION` from `BREEZE_VERSION`); only the parity check below shows it, as SKEW. The `sed` deletes it.

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
