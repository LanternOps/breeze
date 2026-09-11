---
name: worktree-stack
description: Use when an agent needs a running, seeded, Playwright-ready Breeze stack for the current git worktree. Brings up pg+redis+api+web+portal+caddy running the worktree's own code and emits a JSON descriptor.
---

# Worktree Test Stack

Loop for testing the current worktree end to end:

1. Bring up the stack (per-worktree isolated): `pnpm wt-stack up`
   - Add `--shared` for the singleton stack (ports are always ephemeral, read from `.breeze-stack.json`).
   - Add `--rebuild` after Dockerfile or dependency changes.
2. Read `.breeze-stack.json` at the worktree root for `baseUrl`, `apiUrl`,
   `portalUrl`, and admin creds (`admin@breeze.local` / `BreezeAdmin123!`).
3. Drive Playwright: `pnpm wt-stack test -- tests/<spec>.spec.ts`, or point the
   Playwright MCP browser at `baseUrl`.
4. Tear down: `pnpm wt-stack down` (removes volumes by default). Run it from
   the same worktree **and branch** that ran `up` — the project name is derived
   from the branch, so a renamed branch or deleted worktree orphans the stack
   (see "Tear down when done" below for how to reap those).

Notes:
- Requires Node v22.20.0 on PATH and a populated root `.env` (image refs).
- Caddy serves plain HTTP in dev; `baseUrl` is `http://localhost:<port>`.
- OrbStack is recommended for speed but not required — the CLI uses only the
  standard `docker compose` interface.
- `pnpm wt-stack ls` lists running stacks; `pnpm wt-stack info` prints the descriptor.

## Tear down when done (mandatory — nothing reaps a local stack for you)

Every stack you bring up stays up until something tears it down: OrbStack /
Docker never expire them, and each agent session tends to leave its own
behind. On 2026-09-01 the dev machine had **five** Breeze compose projects and
two bare containers running from earlier sessions. Tear down what you brought
up before you end, and say in your final summary what you left running and why.

**`pnpm wt-stack ls` is not the whole picture.** It lists only `breeze` and
`breeze-wt-*` projects. `pnpm test-stack ls` lists only `breeze-test-*`. Neither
shows a `docker-compose.test.yml` brought up without `-p` (project = directory
name, e.g. `worktree-quiet-field-f8d5`) or an ad-hoc `docker run` Postgres from a
plan task. Use the engine-wide listing below.

```bash
# 1. What is still up, across ALL worktrees and sessions?
docker compose ls -a --format json \
  | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}' \
  | grep -i breeze            # blank 3rd column = bare `docker run` container, no compose project

# 2. Tear down what YOU brought up, from the worktree that created it
pnpm wt-stack down                                    # this worktree's dev stack (drops volumes)
pnpm test-stack down                                  # this worktree's integration pg+redis
pnpm --filter @breeze/api test:docker:down            # the shared :5433 test stack (docker-compose.test.yml, no -p)
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev down -v --remove-orphans
                                                      # a compose-mode stack — pass the same -f files you used for `up`

# 3. Anything left over (worktree deleted, branch renamed, another session's stack)
docker compose -p <name> down -v --remove-orphans     # <name> = first column of step 1; no -f needed
docker rm -f <container>                              # bare containers, e.g. breeze-<issue>-drift

# 4. Verify — both must print nothing
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | .Name'
docker ps -a --format '{{.Names}}' | grep -i breeze
```

**Everything-Breeze reset.** Only when you own every stack on the machine — this
kills other sessions' stacks too, so never run it from a parallel agent:

```bash
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | .Name' \
  | xargs -r -I{} docker compose -p {} down -v --remove-orphans
docker ps -aq --filter name=breeze | xargs -r docker rm -f
docker network ls --format '{{.Name}}' | grep -i breeze | xargs -r docker network rm   # stray *-net networks
```

`--keep-volumes` on `wt-stack down` keeps the Postgres data for a re-`up`; the
default drops it, which is what you want at the end of a task.
