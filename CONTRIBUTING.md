# Contributing to Breeze

Thanks for your interest in contributing to Breeze! This guide will help you get started.

> **Want to write code?** Breeze uses a plan-driven workflow: work is captured as
> plan documents, and an approved plan is your green light to build. Read
> [Coding with Claude Code](https://docs.breezermm.com/contributing/coding-with-claude-code/)
> for how to pick up work, propose your own, and hand it back ready to merge.
> The rest of this file covers bug reports, dev setup, and the mechanical PR gate.

## Reporting Bugs

Found a bug? [Open an issue](https://github.com/lanternops/breeze/issues) with:
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, browser, agent version)

## Suggesting Features

Have an idea? [Start a discussion](https://github.com/lanternops/breeze/discussions) and describe your use case.

## Development Setup

```bash
# Clone and install
git clone https://github.com/lanternops/breeze.git
cd breeze
pnpm install

# Configure environment
cp .env.example .env
# REQUIRED: generate real values for these:
#   JWT_SECRET: openssl rand -base64 64
#   AGENT_ENROLLMENT_SECRET: openssl rand -hex 32
#   APP_ENCRYPTION_KEY: openssl rand -hex 32
# THEN change the three values in "Local .env values" below:
# .env.example is the production template.

# Start infrastructure (Postgres and Redis)
# The base compose file requires digest-pinned BREEZE_*_IMAGE_REF values and
# .env.example ships placeholders for them, so local dev layers the dev override on
# top. Same invocation as docs/guides/DEVELOPER_GUIDE.md.
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d postgres redis

# Set up the database
pnpm db:migrate
pnpm db:seed

# Start dev servers (api + web + portal)
pnpm dev:app

# `pnpm dev` runs every package's dev task, including the Office add-ins. Those need the
# Windows or macOS certificate store (office-addin-dev-certs), so on Linux/WSL they skip
# themselves with a message rather than failing the run.

# When you're done: stop the infrastructure (nothing stops it for you).
# Add -v to also drop the database volumes.
docker compose down
docker compose ls -a   # shows any stack still running, from any checkout
```

- **Frontend**: http://localhost:4321
- **API**: http://localhost:3001
- **Default login**: `admin@breeze.local` / `BreezeAdmin123!` (change after first login)

### Local `.env` values

`.env.example` is the template for a production install, so a few of its defaults are wrong for
local development. After copying it, change these three:

| Variable | `.env.example` | Local dev | Why |
|---|---|---|---|
| `NODE_ENV` | `production` | `development` | In production mode `pnpm db:migrate` refuses to create the default `admin@breeze.local` account and fails with *Production bootstrap requires BREEZE_BOOTSTRAP_ADMIN_EMAIL and BREEZE_BOOTSTRAP_ADMIN_PASSWORD*. |
| `FORCE_HTTPS` | `true` | `false` | With it on, the API refuses to start unless `PUBLIC_API_URL` is an `https://` URL; local dev is plain HTTP. |
| `REDIS_URL` | `redis://:${REDIS_PASSWORD}@localhost:6379` | `redis://:<your REDIS_PASSWORD>@localhost:6379` | Docker Compose expands `${REDIS_PASSWORD}`, but the API reads `.env` with dotenv, which does not, so Redis rejects the login (`WRONGPASS`). Write the password into the URL, percent-encoding any `@`, `:`, `/`, `#` or `?` in it (a password from `openssl rand -hex 32` needs none). |

Two more look like they need changing but do not:

- `PUBLIC_API_URL`: leave it empty. The web dev server proxies `/api` to the API on port 3001, so
  the browser calls its own origin and needs no CORS setup.
- `BREEZE_*_IMAGE_REF`: the placeholders are fine, because the `docker-compose.override.yml.dev`
  layer above replaces those images with local dev builds.

### Agent Development

```bash
cd agent
make run       # Dev mode with hot-reload
make build     # Build for current platform
make build-all # Cross-platform builds
```

## Code Style

- **TypeScript**: ESLint with project config. Run `pnpm lint` to check.
- **Go**: Standard `gofmt` formatting. Run `gofmt -w .` in the `agent/` directory.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes, **with tests**. New functionality ships with automated
   tests that cover it, in the same PR. A bug fix adds a test that fails
   without the fix. Tests sit alongside the source they cover (Vitest for
   TypeScript, Go `testing` for the agent); see `docs/agents/testing.md`.
4. Mirror the CI gate locally before pushing.

   **Security gates** (`.github/workflows/security.yml` + the `security-audit`
   job in `.github/workflows/ci.yml`) can be run as a single wrapper:

   ```bash
   bash scripts/security/preflight.sh           # all 5 CI security jobs
   bash scripts/security/preflight.sh --fast    # skip the Trivy image scan (~5-10 min)
   ```

   First-time setup: `go install golang.org/x/vuln/cmd/govulncheck@latest`,
   `cargo install cargo-audit --locked`, and either install `trivy`
   (`brew install trivy`) or have Docker/OrbStack running (the script falls
   back to the `aquasec/trivy` image when the native binary is absent).

   **Functional gates** — each line maps 1:1 to a job in `.github/workflows/ci.yml`:

   ```bash
   pnpm install --frozen-lockfile
   pnpm lint                                                 # CI: Lint
   # tsc on apps/api exceeds Node's default heap; CI's Type Check job sets the same value.
   NODE_OPTIONS=--max-old-space-size=12288 \
     pnpm exec tsc --build apps/api/tsconfig.tests.json      # CI: Type Check
   pnpm --filter=@breeze/web exec astro check                # CI: Type Check
   pnpm test --filter=@breeze/api                            # CI: Test API
   pnpm test --filter=@breeze/web                            # CI: Test Web
   pnpm build --filter=@breeze/api                           # CI: Build API
   pnpm build --filter=@breeze/web                           # CI: Build Web
   (cd agent && CGO_ENABLED=0 go test ./...)                 # CI: Test Agent
   pnpm db:check-drift                                       # CI: Lint (drift, non-blocking)
   pnpm --filter @breeze/api run check:migrations            # CI: Check Migrations (needs local Postgres)
   pnpm audit --audit-level=critical                         # CI: Security Audit (npm advisories)
   bash scripts/security/check-supply-chain-hardening.sh     # CI: Security Audit (hardening guard)
   bash scripts/security/check-relay-edge-hardening.sh       # CI: Security Audit (relay/edge guard)
   ```

   The `check:migrations` step needs a running Postgres and `DATABASE_URL`
   set; `docker compose up -d postgres` from the Development Setup section
   above is enough.

   On dev hosts with ≤ 8 GiB RAM, prefix the API build with
   `NODE_OPTIONS=--max-old-space-size=4096` to avoid an OOM in the tsup
   DTS-generation step.

   The supply-chain and relay/edge guards catch regressions like base-image
   pinning drift, mutable tag defaults, and unauthorized auto-update
   labels — issues that otherwise only surface on PR CI (the Security
   Audit job runs on `pull_request` events).
5. Submit a PR against `main`

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `chore:` — Maintenance, dependencies
- `docs:` — Documentation only
- `refactor:` — Code change that neither fixes a bug nor adds a feature

## Code of Conduct

Be respectful, inclusive, and constructive. We're building something together.

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE) license.
