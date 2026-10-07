# Local Docker stacks — modes and teardown

Moved verbatim from `CLAUDE.md` (2026-10-07). Per-worktree stacks: `.claude/skills/worktree-stack/SKILL.md`.

## Docker Compose Modes

Three named override files exist — no auto-applied `docker-compose.override.yml` by default.

| File | Purpose |
|---|---|
| `docker-compose.override.yml.dev` | Code-mounted hot-reload (builds from `Dockerfile.api.dev` / `Dockerfile.web.dev`) |
| `docker-compose.override.yml.ghcr` | Pre-built GHCR images (linux/amd64) |
| `docker-compose.override.yml.local-build` | Native arm64 local build from production Dockerfiles |

```bash
# Dev mode (code-mounted, hot-reload)
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up --build -d

# GHCR mode (pre-built images)
docker compose -f docker-compose.yml -f docker-compose.override.yml.ghcr up -d

# Local build mode (native arm64)
docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build up --build -d

# Or symlink whichever mode you want as default:
ln -sf docker-compose.override.yml.dev docker-compose.override.yml
docker compose up --build -d
```

**Tear down when you're done — nothing reaps a local stack for you.** Every `up` (these modes, `pnpm wt-stack up`, `pnpm test-stack up`, an ad-hoc `docker run` Postgres) stays up until torn down, and each agent session tends to leave its own behind — five Breeze projects were found running on 2026-09-01. `pnpm wt-stack ls` and `pnpm test-stack ls` each see only their own prefix; the engine-wide truth is:

```bash
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'   # every Breeze project, all worktrees
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev down -v --remove-orphans   # this checkout (same -f files as up)
pnpm wt-stack down            # a wt-stack, from the worktree+branch that created it
pnpm test-stack down          # a per-worktree integration stack, from the same worktree (reads the project it recorded in .env.test)
docker compose -p <name> down -v --remove-orphans   # anything else the first command listed (no -f needed)
```

Before ending a session, tear down what you brought up and say what you left running. Full checklist (bare containers, orphaned projects, the everything-Breeze reset): `.claude/skills/worktree-stack/SKILL.md` → "Tear down when done".

**Deleting a config file? Sweep the Compose mounts in the same PR.** Docker creates a missing bind-mount source as an empty **directory** on the host, which then gets `COPY`d into dev images where Vite/PostCSS discovery dies on it (`EISDIR`) — `breeze-web` comes up permanently unhealthy on a fresh clone. `apps/api/src/config/composeBindMounts.test.ts` (required **Test API** job) parses every tracked compose file and fails when a file-shaped, repo-relative bind-mount source doesn't exist — or has already become a phantom directory. Extensionless sources (`./agent/bin`) are exempt as intended build outputs; out-of-repo sources (`../breeze-billing/…`) can't be asserted and are skipped. Shipped three times before the guard existed: #1999 (postcss), #2208 (partial tailwind), #2012 (the mounts #2208 missed).

