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
4. Tear down: `pnpm wt-stack down` (removes volumes by default).

Notes:
- Requires Node v22.20.0 on PATH and a populated root `.env` (image refs).
- Caddy serves plain HTTP in dev; `baseUrl` is `http://localhost:<port>`.
- OrbStack is recommended for speed but not required — the CLI uses only the
  standard `docker compose` interface.
- `pnpm wt-stack ls` lists running stacks; `pnpm wt-stack info` prints the descriptor.
