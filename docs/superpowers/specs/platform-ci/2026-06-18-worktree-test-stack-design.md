# Worktree Test Stack — Design

**Date:** 2026-06-18
**Status:** Approved design, ready for implementation plan
**Author:** Todd Hebebrand (with Claude)

## Problem

There is no clean path from "I have a git worktree" to "I have a migrated, seeded,
Playwright-ready stack running *this worktree's* code." The local stack is a
singleton:

- Hardcoded `container_name`s (`breeze-postgres`, `breeze-redis`, `breeze-api`,
  `breeze-web`, `breeze-portal`, `breeze-caddy`) in `docker-compose.yml`.
- Fixed host ports (5432, 6379, 3001, 4321, 4322, Caddy 80/443).
- `e2e-tests/global-setup.ts` seeds via literal `docker exec breeze-postgres` /
  `breeze-redis`, and `playwright.config.ts` defaults `baseURL` to
  `http://localhost:4321`.

Consequences (all observed in practice): multiple worktrees share one local DB so
migration PRs contaminate each other; `git checkout` does not propagate to
containers through the macOS `:cached` bind mount; fresh worktrees miss the
gitignored `.env.test` symlink and silently run RLS tests on a BYPASSRLS connection.

## Goal

A single tool that takes the current worktree and produces a running stack —
Postgres + Redis + API + Web + **Portal** + Caddy, all code-mounted so the
worktree's actual code runs — migrated, seeded, and Playwright-ready, with a
machine-readable descriptor an autonomous agent can consume.

Delivered in two phases:

- **Phase 1 — reliable one-command bring-up.** Keep a single shared stack, but make
  "worktree → seeded, running, Playwright-ready" one fast, deterministic command.
- **Phase 2 — per-worktree isolation.** Each worktree gets its own namespaced,
  parallel-safe stack on ephemeral ports with a disposable (tmpfs) database.

Optimization priority is **ease of automation and reliability of teardown**, not
maximum parallelism.

## Non-goals

- No simulated Go agent / enrolled device. Stack scope is web + API + infra +
  portal only. Device-dependent UI is out of scope for this tool.
- No high-fan-out cloud orchestration. Target is a few stacks on a dev Mac (and the
  existing Docker-based CI path, which must keep working).
- Not a replacement for the existing `docker-compose.override.yml.dev` workflow for
  humans; this is an automatable layer that reuses the same dev-mode building blocks.

## Approach (chosen: A — Compose-project-per-worktree)

One orchestration CLI plus an override file that makes the existing stack
namespaceable. A Compose **project name** derived from the worktree owns *all*
state for that stack, so teardown is a single command and parallelism is free.

Approaches considered and rejected:

- **B — shared infra, database-per-worktree.** Lighter on RAM, but state is split
  across a shared singleton plus per-worktree containers; the `breeze_app`
  role/RLS/extension setup must be replayed per DB; redis isolation is only a key
  prefix; teardown is multi-step. Harder to automate cleanly despite being lighter.
- **C — ephemeral throwaway (no Caddy), app via host `pnpm dev`.** Fastest, least
  Docker, but drops Caddy and therefore the routing / portal-base-path / cookie
  behavior that has repeatedly caused bugs (#1417 Caddy shadow, portal `/portal`
  base-path, cookie same-site). Unacceptable fidelity loss for a UI-testing tool.

## Components

| Component | Description |
|---|---|
| `scripts/dev/wt-stack` (tsx) | The CLI an agent or human calls. tsx (not bash) so it shares descriptor/types with `global-setup.ts` and emits JSON cleanly. |
| `docker-compose.override.yml.worktree` | Makes the stack namespaceable: drops `container_name`, ephemeral host ports, tmpfs Postgres, code-mounts api/web/portal. |
| `docker/Dockerfile.portal.dev` | New hot-reload portal image mirroring `Dockerfile.api.dev` / `Dockerfile.web.dev`, so the worktree's portal code runs from source. |
| `.breeze-stack.json` | Per-worktree descriptor the CLI emits (gitignored). The contract between "stack" and "tests." |
| Playwright wiring | `global-setup.ts` + `playwright.config.ts` read the descriptor instead of hardcoded container names / `localhost:4321`. |
| Agent skill | Thin skill documenting the loop: `wt-stack up` → read `.breeze-stack.json` → drive Playwright → `wt-stack down`. |

### CLI surface

- `wt-stack up [--shared] [--rebuild]` — bring up the stack for the current
  worktree; run migrations; seed; write `.breeze-stack.json`. `--shared` selects
  Phase-1 singleton semantics (fixed project name + today's fixed ports). Idempotent:
  re-running `up` on a live stack reuses it.
- `wt-stack down [--keep-volumes]` — tear down this worktree's stack. Default removes
  volumes (`docker compose -p <proj> down -v`).
- `wt-stack info` — print the descriptor for the current worktree.
- `wt-stack test [-- <playwright args>]` — ensure up, then run Playwright against the
  descriptor (sets `E2E_STACK_FILE`/`E2E_BASE_URL` and admin creds).
- `wt-stack ls` — list running worktree stacks (Phase 2).

## Isolation & performance mechanics

- **Namespace by Compose project.** Project name derived from the worktree:
  `breeze-wt-<branch-slug>`, falling back to a short hash of the worktree absolute
  path when the branch name is missing/detached or not filename-safe. Phase 1
  `--shared` uses a fixed project name.
- **Drop `container_name`.** The worktree override unsets `container_name` on every
  service so Compose auto-names `<project>-<service>-1`; two stacks never collide on
  a name.
- **Ephemeral host ports.** Publish as `"0:<container-port>"` so Docker assigns free
  host ports; the CLI discovers them via `docker compose -p <proj> port <service>
  <port>` and records them in the descriptor. No offset math, no collisions.
- **Entry point = Caddy, TLS errors ignored.** `baseUrl` is the Caddy HTTPS port so
  portal `/portal` routing and `/api/*` are exercised faithfully. Caddy's
  self-signed cert (which Chromium rejects) is handled by Playwright
  `ignoreHTTPSErrors: true` — least-invasive, preserves full routing fidelity.
- **Disposable Postgres.** tmpfs `PGDATA` + `fsync=off` / `synchronous_commit=off`
  on worktree stacks → fast migrate/seed and instant teardown. (Phase 2; Phase 1
  shared stack may keep a normal volume.)
- **Native arm64** dev builds for api/web/portal (the existing `local-build`
  override already builds api/web native; portal gains the same via
  `Dockerfile.portal.dev`). The default base-compose `platform: linux/amd64` for the
  pinned portal image is bypassed in worktree mode.
- **Engine-agnostic, OrbStack recommended.** The CLI only uses the standard
  `docker` / `docker compose` interface, so it runs on Docker Desktop, OrbStack, or
  Colima. OrbStack is recommended for its VirtioFS file sharing (faster bind mounts,
  reliable file-change events into the container — likely resolves the
  "tsx-watch doesn't hot-reload over the bind mount → `docker restart`" issue) and
  lower per-container overhead. CI continues on Docker unchanged.

## Stack descriptor

`.breeze-stack.json`, written to the worktree root, gitignored:

```json
{
  "project": "breeze-wt-feat-quotes",
  "baseUrl": "https://localhost:53421",
  "apiUrl": "https://localhost:53421/api",
  "portalUrl": "https://localhost:53421/portal",
  "webPort": 53421,
  "apiDirectPort": 53431,
  "pgContainer": "breeze-wt-feat-quotes-postgres-1",
  "redisContainer": "breeze-wt-feat-quotes-redis-1",
  "admin": { "email": "admin@breeze.local", "password": "BreezeAdmin123!" }
}
```

The descriptor is the single source of truth consumed by Playwright and by any
agent. Its TypeScript type is defined once in the tsx CLI and imported by
`global-setup.ts`.

## Playwright wiring (existing-code surgery)

This is the only change to existing test code, and it is small:

- `playwright.config.ts`: read `baseURL` from the descriptor (via `E2E_STACK_FILE`,
  default `<worktree>/.breeze-stack.json`); set `use.ignoreHTTPSErrors: true`.
- `global-setup.ts`: replace literal `docker exec breeze-postgres` /
  `docker exec breeze-redis` with `docker compose -p <project> exec postgres …` /
  `… exec redis …`, reading `<project>` and container references from the
  descriptor. The seed SQL and redis rate-limit clear are otherwise unchanged.

`wt-stack test` sets `E2E_STACK_FILE`, `E2E_ADMIN_EMAIL`, and `E2E_ADMIN_PASSWORD`
from the descriptor before invoking Playwright.

## Bootstrap (fresh-worktree traps)

`up` is responsible for making a *fresh* worktree work end to end:

- If `node_modules` is missing, run `pnpm install` with the pinned Node
  (`v22.20.0`) on `PATH`.
- Generate a per-worktree `.env.stack` (gitignored) carrying the required secrets
  from dev defaults: `ENROLLMENT_KEY_PEPPER`, `MFA_RECOVERY_CODE_PEPPER`,
  `TURN_SECRET`, `IS_HOSTED`, and any other vars the API config validator requires
  to boot. This removes the missing-`.env.test`-symlink → vacuous-RLS class of
  failure: the stack always boots with a complete, explicit env.
- Migrations run inside the API container against that stack's own database after
  Postgres reports healthy.

## Phasing

- **Phase 1 — one-command bring-up (shared).** `up` / `down` / `info` / `test`
  with `--shared` semantics (fixed project name, today's fixed ports). Descriptor
  written and consumed by Playwright. Portal dev service + `Dockerfile.portal.dev`.
  Env bootstrap. One reliable stack, one command. Caddy entry + `ignoreHTTPSErrors`.
- **Phase 2 — per-worktree isolation.** Per-worktree project names, ephemeral
  ports, tmpfs Postgres. `global-setup.ts` made fully name-agnostic. `wt-stack ls`.
  Parallel-safe teardown. Test that two stacks come up on distinct ports without
  collision.

## Error handling

- **Health gating.** `up` waits on Compose healthchecks (api, web, portal, postgres)
  with a bounded timeout and a clear per-service failure message; it does not write a
  descriptor or report success until all are healthy.
- **Port discovery failure.** If `docker compose port` returns nothing for a service,
  fail loudly rather than emitting a half-populated descriptor.
- **Idempotent up / clean down.** Re-running `up` reuses a healthy stack; `down`
  always removes volumes by default so a stale tmpfs DB never leaks into the next run.
- **Engine detection.** The CLI reports the active Docker context on `up` so it is
  obvious whether OrbStack/Colima/Docker Desktop is in use.

## Testing the tool

- **Smoke (Phase 1):** `up` → assert `/health`, web, and portal each return 200 →
  run one trivial Playwright spec green → `down` → assert containers gone and volumes
  removed.
- **Isolation (Phase 2):** bring up two stacks from two worktrees → assert distinct
  host ports and distinct container names, both healthy → tear both down
  independently with no cross-impact.

## Files touched / added

- Add: `scripts/dev/wt-stack` (tsx), `docker-compose.override.yml.worktree`,
  `docker/Dockerfile.portal.dev`, agent skill, `.breeze-stack.json` +
  `.env.stack` entries in `.gitignore`.
- Modify: `e2e-tests/global-setup.ts`, `e2e-tests/playwright.config.ts`.
