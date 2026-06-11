# Contributing to Breeze

Thanks for your interest in contributing to Breeze! This guide will help you get started.

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

# Start infrastructure (Postgres, Redis, MinIO)
docker compose up -d

# Set up the database
pnpm db:push
pnpm db:seed

# Start dev servers
pnpm dev
```

- **Frontend**: http://localhost:4321
- **API**: http://localhost:3001
- **Default login**: `admin@breeze.local` / `BreezeAdmin123!` (change after first login)

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
3. Make your changes
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
   pnpm exec tsc --noEmit --project apps/api/tsconfig.json   # CI: Type Check
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
