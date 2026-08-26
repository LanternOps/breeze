# Main-orphan + user-helper flag-default postmortem

Date: 2026-05-02
Affected: `main` branch of `github.com/LanternOps/breeze`, all Windows agents on 0.63.x and 0.64.1
Status: resolved (history is parallel and accepted as-is; user-helper bug fixed in 0.64.2)

## 1. Summary

On 2026-04-25 a force-push to `main` replaced the v0.62.x history with a parallel
chain rooted at `dd42c83c`, leaving 891 commits (back to repo init) unreachable
from any main-tracked ref. While investigating the topology we found an
unrelated, pre-existing bug: the cobra `--role` flag default for the
`user-helper` subcommand was `"system"` instead of `"user"`, which crash-looped
every Windows customer agent on 0.63.x and 0.64.1. The orphan history is being
left as-is (the resulting tree is largely what was wanted); the user-helper bug
ships fixed in 0.64.2; branch protection and a drift-detector workflow are being
added to catch a recurrence.

## 2. Timeline

- 2026-04-24 — Local OAuth + MCP work; 22 commits authored locally including
  PR #507 "feat(oauth): MCP OAuth 2.1 + DCR + PKCE behind MCP_OAUTH_ENABLED
  flag". Direction is then changed locally — OAuth strategy redone (eventual
  #509/#510 + Postgres OAuth migrations).
- 2026-04-24 evening — Local reset, new chain built on top of `dd42c83c`
  ("fix(oauth): grant-wide revocation invalidates sibling access tokens").
- 2026-04-25T00:59:50Z — Force-push to `origin/main`. Pre-push tip:
  `ed9fd075` ("ops(oauth): wire OAuth env vars + Caddy routes for the
  dev/prod stack"). Post-push tip: `9225a53d` ("fix(oauth): patch body-drain
  bugs across DCR/token/revocation + UX polish"). GitHub activity API
  recorded `type=push` (not `type=force_push`); the topology proves the
  rewrite.
- 2026-04-25 onward — v0.63.x and v0.64.x release tags are cut on the new
  orphan main. v0.62.x tags continue to exist as parallel-history artifacts.
- 2026-05-02 — Investigation into broken PR-link tooling surfaces the
  orphan. Side discovery: Windows agents on 0.63.5 and 0.64.1 are
  crash-looping with `auth_rejected` from sessionbroker (root cause is
  unrelated to the orphan). Fix prepared for 0.64.2; safeguards drafted.

## 3. Mechanism — how the orphan was created

A force-push (`git push --force` or `--force-with-lease`) replaces the
remote ref atomically. Git accepts the new ref if the actor has push
permissions and the branch protection allows it; the old commits stay in
the repo's object database for the GC grace window but are no longer
reachable from any ref unless something else references them.

In this case the new tip's chain shares no recent ancestor with the old
tip's chain, despite both nominally living on `main`:

```
# Pre-push tip (legitimate v0.62.x lineage)
ed9fd075  ops(oauth): wire OAuth env vars + Caddy routes for the dev/prod stack

# Post-push tip (new orphan chain)
9225a53d  fix(oauth): patch body-drain bugs across DCR/token/revocation + UX polish
   |
   ...  (new commits)
   |
dd42c83c  fix(oauth): grant-wide revocation invalidates sibling access tokens
   |
398d57bd  fix(oauth): lazy-load Redis in oauth routes to unblock unit tests
            ^ parent of dd42c83c; not reachable from any main-reachable ref
```

Topological proof:

```bash
# Returns nothing (ed9fd075 is not an ancestor of 9225a53d)
git merge-base --is-ancestor ed9fd075 9225a53d ; echo $?
# -> 1

# Returns nothing (no common ancestor between current main and the last
# v0.62 release tag)
git merge-base origin/main v0.62.26-rc.5 ; echo $?
# -> 1

# Confirms the new orphan root is dd42c83c
git rev-list --max-parents=0 origin/main
# -> dd42c83c6b4a6ad258cc7962de372ae7e23a0ad2
```

The two chains diverge somewhere in the history of the common parent
`cb979022`. From `main`'s perspective, all 891 commits between init
(`93bad0ec`) and `398d57bd` are unreachable.

## 4. What was actually lost vs feared lost

The fear: 891 commits' worth of work, including most v0.62.x feature
PRs, are gone.

The reality:

- **File-level: very little.** The tree at `9225a53d` and subsequent
  main commits already contains the cumulative state the team wanted —
  most "missing" v0.62 PRs had their effects already incorporated into
  `dd42c83c`'s tree, then refined.
- **Commit-level: 191 PRs (#7 - #503) are no longer reachable from
  main.** PR-link tooling that walks the commit graph to map PRs back
  to merges is broken for those PR numbers. v0.62.x release tags exist
  as parallel-history artifacts, not as ancestors of current main.
- **Practical impact on shipped code: minimal.** Everything currently
  building, passing CI, and shipping in 0.63.x / 0.64.x is on the
  reachable chain.
- **One genuine feature divergence** identified during reconciliation:
  `apps/api/src/middleware/apiKeyAuth.ts`. v0.62 carried a
  `scopeState: 'readonly' | 'full'` field on API keys. Main went a
  different direction (nullable `orgId` / `partnerId` for partner-scoped
  MCP keys). If readonly mode is wanted on main, port it forward from
  the v0.62 lineage as a new commit.

In short, the loss is mainly cosmetic and process-hygiene. The codebase
is fine.

## 5. Live bug found during investigation (independent of the orphan)

While reconciling the two histories we noticed Windows customer agents
were crash-looping. The bug was pre-existing on **both** branches — the
orphan event neither caused it nor exposed it.

Symptom (from agent logs):

```json
{"code": "auth_rejected", "reason": "system role requires SYSTEM identity"}
```

Cause: in `agent/cmd/breeze-agent/main.go:219`, the cobra `--role` flag
default for the `user-helper` subcommand was set to `"system"`. The
Windows AgentUserHelper Scheduled Task (`agent/service/windows/breeze-agent-user-task.xml`)
invokes `breeze-agent user-helper` with no flags. As a result, the
user-helper process — which runs as `BUILTIN\Users`, not as
`S-1-5-18` — claimed `HelperRoleSystem` over IPC. The sessionbroker
correctly rejected it (the rejection itself is the right behavior;
the caller was lying about its role), and the helper crashed and
restarted in a tight loop.

Fix (shipping in 0.64.2,
`fix(agent): user-helper defaults to --role user (not system)`):

1. Cobra default `"system"` -> `"user"` in `main.go:219`.
2. Add `<Argument>--role user</Argument>` to
   `breeze-agent-user-task.xml` as defense-in-depth so Scheduled Tasks
   created by the legacy installer also pass the correct role
   regardless of which agent binary they end up running.

## 6. Safeguards added

- **Branch protection on `main`:** force-push is restricted and branch
  deletion is restricted. Other existing protections (status checks,
  review requirements, etc.) are preserved unchanged.
- **Drift detector CI workflow:** a daily job runs
  `git merge-base --is-ancestor <latest-tag> origin/main` against the
  most recent release tag. If `main` ever loses ancestry to its own
  latest release, the job alerts.

## 7. How to detect this recurring

- The drift detector job will catch tag-vs-main ancestry loss within 24
  hours.
- Manual spot check: `git rev-list --max-parents=0 origin/main` should
  always return the same root SHA. As of 2026-05-02 that root is
  `dd42c83c6b4a6ad258cc7962de372ae7e23a0ad2` (the orphan). A future
  force-push that truncates history further would change this value.
  An expected pre-orphan root would be `93bad0ec` ("feat: initialize
  Breeze RMM project structure"), but that is no longer reachable.
- If `git fetch origin` ever prints `forced update` for `main`, treat
  it as a P0 signal and follow the recovery procedure below before
  doing any other work on the branch.

## 8. Recovery procedure

If a force-push severs `main` history again — or if you suspect it
has — do not do anything destructive (`git gc`, `git reflog expire`,
`git fetch --prune` on suspicious refs) until recovery is decided.

1. **Capture local reflog before doing anything else.** Dangling
   commits are kept alive by the reflog for ~90 days by default.

   ```bash
   git reflog show main --date=iso > /tmp/main-reflog-$(date +%s).txt
   git reflog show origin/main --date=iso >> /tmp/main-reflog-$(date +%s).txt
   ```

2. **If working in a shallow clone, deepen it.** A shallow clone may
   not have the dangling history at all.

   ```bash
   git fetch --unshallow origin
   ```

3. **Identify the lost tip.** The pre-push SHA is usually visible in:
   - the local reflog of any developer who fetched before the push
   - the GitHub web UI (the prior tip remains addressable by SHA for a
     while even after force-push)
   - a release tag that pointed into the lost chain

4. **Pin recovery refs immediately.** This keeps the dangling commits
   reachable across `git gc` runs.

   ```bash
   git update-ref refs/heads/recovery/<descriptive-name> <sha>
   git push origin refs/heads/recovery/<descriptive-name>
   ```

5. **Decide direction with the team before merging anything.** Options
   are: re-base the rescued chain on top of the current main, cherry-pick
   targeted commits, or merge with `--allow-unrelated-histories` to graft
   the chains together. Each has trade-offs; do not pick under pressure.

6. **Do not run `git gc`, `git prune`, or `git reflog expire` until
   recovery is fully complete and pinned refs have been pushed.**

## 9. References

- Pre-push tip: `ed9fd075` ops(oauth): wire OAuth env vars + Caddy routes for the dev/prod stack
- Post-push tip: `9225a53d` fix(oauth): patch body-drain bugs across DCR/token/revocation + UX polish
- New orphan root: `dd42c83c` fix(oauth): grant-wide revocation invalidates sibling access tokens
- Unreachable parent of orphan root: `398d57bd` fix(oauth): lazy-load Redis in oauth routes to unblock unit tests
- Repo init (no longer reachable from main): `93bad0ec` feat: initialize Breeze RMM project structure
- Force-push timestamp: 2026-04-25T00:59:50Z UTC
- Affected files for the user-helper bug: `agent/cmd/breeze-agent/main.go:219`, `agent/service/windows/breeze-agent-user-task.xml`
- Fix shipping in: 0.64.2 (`fix(agent): user-helper defaults to --role user (not system)`)
