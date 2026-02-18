# AI-Driven Documentation Verification E2E Tests

**Date**: 2026-02-18
**Status**: Approved
**Scope**: Getting Started + Agents docs (initial); expandable to all 56 doc pages

## Problem

Documentation claims drift from reality. Features change, APIs evolve, UI moves — but docs stay static. We need automated verification that what we document actually works.

## Solution

A hybrid AI-driven test system that:
1. **Extracts** testable assertions from MDX documentation using Claude API
2. **Caches** assertions in a manifest file (re-extracts only when docs change)
3. **Verifies** assertions against a local Docker stack using the right tool for each claim type

## Architecture

```
docs/*.mdx → [Claude Extractor] → assertions.json → [Runner] → Results
                                                        │
                                    ┌───────────────────┼──────────────────┐
                                    ▼                   ▼                  ▼
                              API executor        SQL executor       UI executor
                              (HTTP requests)     (DB queries)       (Claude + Playwright)
                                    │                   │                  │
                                    └───────────────────┼──────────────────┘
                                                        ▼
                                              Docker test stack
                                         (API + Web + Postgres + Redis)
```

## Assertion Types

| Type | What it verifies | How it runs | Speed |
|------|-----------------|-------------|-------|
| `api` | HTTP endpoint behavior (status, response shape) | Direct HTTP request | Fast (~50ms) |
| `sql` | Data-layer claims (token hashing, permissions) | DB query via test connection | Fast (~20ms) |
| `ui` | Visual/behavioral UI claims | Claude + Playwright MCP | Slow (~5-15s) |

## Assertion Manifest Format

```json
{
  "version": 1,
  "generatedAt": "2026-02-18T...",
  "pages": [
    {
      "source": "agents/enrollment.mdx",
      "contentHash": "sha256:...",
      "assertions": [
        {
          "id": "enrollment-001",
          "type": "api",
          "claim": "POST /api/v1/agents/enroll returns 201 with agentToken",
          "test": {
            "method": "POST",
            "path": "/api/v1/agents/enroll",
            "body": { "hostname": "test-host", "os": "linux", "arch": "amd64" },
            "headers": { "x-enrollment-secret": "{{ENROLLMENT_SECRET}}" },
            "expect": { "status": 201, "bodyContains": ["agentToken", "deviceId"] }
          }
        },
        {
          "id": "enrollment-002",
          "type": "ui",
          "claim": "Device appears in the dashboard after enrollment",
          "test": {
            "navigate": "/devices",
            "verify": "A device with hostname 'test-host' appears in the device list"
          }
        }
      ]
    }
  ]
}
```

Variables like `{{ENROLLMENT_SECRET}}` are resolved from environment at runtime.

## File Structure

```
e2e-tests/doc-verify/
  ├── cli.ts              # CLI entry: extract | run | report
  ├── extractor.ts        # Reads MDX → Claude API → assertions.json
  ├── runner.ts           # Orchestrates assertion execution
  ├── executors/
  │   ├── api.ts          # HTTP request executor
  │   ├── sql.ts          # DB query executor
  │   └── ui.ts           # Claude + Playwright MCP executor
  ├── report.ts           # HTML/JSON report generator
  ├── assertions.json     # Cached manifest (gitignored)
  └── fixtures/
      └── seed.ts         # Seeds test DB with org, site, enrollment key, admin user
```

## Docker Setup

New `docker-compose.doc-verify.yml` extending the existing test stack:

- **postgres-test**: Ephemeral PostgreSQL (tmpfs) on port 5433
- **redis-test**: Ephemeral Redis on port 6380
- **api**: Built from `apps/api/`, connected to test DB/Redis
- **web**: Built from `apps/web/`, connected to API

All services use health checks. Stack is fully ephemeral — `down -v` cleans everything.

## CLI Usage

```bash
# Extract assertions from docs (calls Claude API)
pnpm doc-verify extract

# Run all assertions against local Docker stack
pnpm doc-verify run

# Run assertions for a specific doc page
pnpm doc-verify run --page agents/enrollment.mdx

# Extract + run in one shot
pnpm doc-verify

# Only re-extract pages whose content changed
pnpm doc-verify extract --incremental
```

## CI Integration

GitHub Actions workflow triggers on PRs that modify `apps/docs/`:

1. Start Docker test stack
2. Extract assertions (incremental — only changed docs)
3. Run assertions
4. Post results as PR comment
5. Tear down stack

## UI Verification Flow

For UI assertions, the runner:
1. Navigates to the specified page via Playwright
2. Takes a DOM snapshot
3. Sends snapshot + claim to Claude Sonnet for verification
4. Claude responds with `{ pass: boolean, reason: string }`

Uses Sonnet (fast, cheap) for verification. No hardcoded selectors — the AI interprets the DOM semantically.

## Initial Scope

**Phase 1** (this implementation):
- `getting-started/quickstart.mdx` — health endpoint, container list
- `agents/installation.mdx` — download endpoint, enrollment flow, config file format
- `agents/enrollment.mdx` — enrollment API, token hashing, enrollment keys
- `agents/commands.mdx` — command result format (API-level only)

**Phase 2** (future):
- Feature docs (25 pages)
- Reference docs (6 pages)
- Monitoring docs

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Claude API for extraction + UI verification | Required |
| `DOC_VERIFY_BASE_URL` | Web app URL | `http://localhost:4321` |
| `DOC_VERIFY_API_URL` | API URL | `http://localhost:3001` |
| `DOC_VERIFY_DB_URL` | Test DB connection | `postgres://breeze_test:breeze_test@localhost:5433/breeze_test` |
| `AGENT_ENROLLMENT_SECRET` | Enrollment secret for test | `test-enrollment-secret` |

## Cost Estimate

- **Extraction**: ~$0.02 per doc page (Sonnet, one-time per change)
- **UI verification**: ~$0.01 per assertion (Sonnet, DOM snapshot + verification)
- **Full run** (8 initial pages, ~30 assertions): ~$0.50
- **Incremental** (1 changed page, ~5 assertions): ~$0.07

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| AI non-determinism in UI tests | Retry with stricter prompt; assertions include `claim` for context |
| Docker build time | Cache Docker layers in CI; use pre-built images |
| Claude API cost at scale | Assertion caching; incremental extraction; Sonnet for verification |
| Flaky UI tests | DOM snapshots (not screenshots) for determinism; retry logic |
