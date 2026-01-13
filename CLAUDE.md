# Breeze RMM - Claude Context

## Project Overview

Breeze is a fast, modern Remote Monitoring and Management (RMM) platform for MSPs and internal IT teams. Target: 10,000+ agents with enterprise features.

## Tech Stack

- **Frontend**: Astro + React Islands
- **API**: Hono (TypeScript)
- **Database**: PostgreSQL + Drizzle ORM
- **Queue**: BullMQ + Redis
- **Agent**: Go (cross-platform)
- **Real-time**: HTTP polling + WebSocket
- **Remote Access**: WebRTC

## Key Patterns

### Multi-Tenant Hierarchy
```
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
```

### Database Schema Location
- `apps/api/src/db/schema/` - All Drizzle schema definitions
- Key tables: devices, users, organizations, sites, alerts, scripts, automations

### API Routes
- `apps/api/src/routes/` - Hono route handlers
- Pattern: Export `xxxRoutes` from each file, mount in `index.ts`

### Shared Code
- `packages/shared/src/types/` - TypeScript interfaces
- `packages/shared/src/validators/` - Zod schemas
- `packages/shared/src/utils/` - Utility functions

---

## Codex Delegation

This project uses OpenAI Codex CLI for task delegation. Claude orchestrates complex work while Codex handles isolated tasks.

### Quick Commands

```bash
# Standard task
codex exec "<task>" --full-auto -C "/Users/toddhebebrand/breeze"

# With reasoning level (low/medium/high/xhigh)
codex exec "<task>" --full-auto -c 'model_reasoning_effort="xhigh"'

# Resume previous session
codex exec resume --last "<follow-up>"
```

### Delegation Guidelines

#### Delegate to Codex
| Task | Reasoning | Example |
|------|-----------|---------|
| File operations | low | "Find all files importing X" |
| Utility functions | medium | "Create a slugify utility" |
| CRUD endpoints | medium | "Add DELETE /api/devices/:id" |
| Test generation | medium | "Write tests for formatBytes" |
| Lint/type fixes | medium | "Fix TypeScript errors in auth.ts" |
| Code analysis | high | "Review this for security issues" |
| Architecture | xhigh | "Design the caching strategy" |

#### Keep with Claude
- Multi-tenant data isolation
- Authentication/authorization logic
- Cross-module refactoring
- Business logic implementation
- Coordinating multiple Codex tasks
- Final code review and integration

### Reasoning Effort Findings

| Level | Behavior | Use When |
|-------|----------|----------|
| `low` | Verbose, more tokens | Simple mechanical tasks |
| `medium` | Balanced (default) | Standard code generation |
| `high` | Thoughtful analysis | Code review, debugging |
| `xhigh` | Strategic, concise, fewer tokens | Architecture decisions |

### Token Costs (Tested)

| Task Type | Approximate Tokens |
|-----------|-------------------|
| File search | ~1.3k |
| Code comprehension | ~2.9k |
| Utility generation | ~3.5k |
| Security analysis | ~2.4-4.7k |
| Architecture design | ~1.6-4.7k |

### Codex Strengths (Observed)

- Uses `rg` efficiently for searches
- Proactively creates directories and updates exports
- Follows existing project conventions
- Good at isolated, well-scoped tasks
- Excellent security analysis capabilities

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Start development servers
pnpm dev

# Database operations
pnpm db:push      # Push schema changes
pnpm db:studio    # Open Drizzle Studio

# Agent development
cd agent && make run
```

## Current Status

See `docs/PROJECT_STATUS.md` for implementation status and next steps.

### Priority: Authentication System
- Login/logout with JWT
- MFA (TOTP)
- Password reset flow
- SSO integration
- Rate limiting (Redis-backed sliding window)
