# Breeze RMM - Project Status

## Overview

Breeze is a fast, modern Remote Monitoring and Management (RMM) platform targeting MSPs and internal IT teams. Built to handle 10,000+ agents with enterprise features.

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Web Frontend** | Astro + React Islands |
| **API Server** | Hono |
| **Database ORM** | Drizzle |
| **Database** | PostgreSQL |
| **Job Queue** | BullMQ + Redis |
| **Agent** | Go (cross-platform) |
| **Real-time** | HTTP polling + on-demand WebSocket |
| **Remote Access** | WebRTC (built-in) |

## Project Structure

```
breeze/
├── apps/
│   ├── web/                    # Astro + React frontend
│   │   ├── src/
│   │   │   ├── components/     # React components (ui/, devices/, etc.)
│   │   │   ├── layouts/        # Page layouts
│   │   │   ├── pages/          # Astro pages
│   │   │   └── styles/         # Global CSS + Tailwind
│   │   └── package.json
│   │
│   └── api/                    # Hono API server
│       ├── src/
│       │   ├── routes/         # API route handlers
│       │   ├── db/schema/      # Drizzle database schema
│       │   ├── middleware/     # Auth, logging, rate limiting
│       │   ├── services/       # Business logic
│       │   └── jobs/           # BullMQ job processors
│       └── package.json
│
├── packages/
│   └── shared/                 # Shared types, validators, constants
│       ├── src/types/          # TypeScript interfaces
│       ├── src/validators/     # Zod schemas
│       └── src/constants/      # Shared constants
│
├── agent/                      # Go agent
│   ├── cmd/breeze-agent/       # CLI entry point
│   ├── internal/
│   │   ├── config/             # Configuration management
│   │   ├── heartbeat/          # Polling & check-in
│   │   ├── collectors/         # System info collectors
│   │   └── scripts/            # Script execution
│   └── pkg/api/                # Server API client
│
├── docker/                     # Docker configurations
│   ├── docker-compose.yml      # Local development
│   └── docker-compose.prod.yml # Production
│
├── docs/                       # Documentation
│   ├── architecture.md         # Full architecture plan
│   └── PROJECT_STATUS.md       # This file
│
└── scripts/
    └── setup.sh                # Development setup script
```

## Key Features

### Multi-Level Multi-Tenancy
```
Partner (MSP)
└── Organization (Customer)
    └── Site (Location)
        └── Device Group
            └── Device
```

### Core Capabilities
- **Device Monitoring**: Hardware inventory, software inventory, real-time metrics
- **Scripting**: Multi-language support (PowerShell, Bash, Python, CMD)
- **Alerting**: Threshold-based alerts, notification channels, escalation policies
- **Remote Access**: WebRTC terminal, desktop sharing, file transfer
- **Automation**: Scheduled tasks, event triggers, policy enforcement
- **RBAC**: Role-based access with resource scoping at partner/org/site levels

## Database Schema (Drizzle)

| Table | Description |
|-------|-------------|
| `partners` | MSP organizations |
| `organizations` | Customer organizations under partners |
| `sites` | Physical locations within organizations |
| `users` | User accounts |
| `partner_users` | Partner-level user memberships |
| `organization_users` | Organization-level user memberships |
| `roles` | Permission roles |
| `devices` | Managed endpoints |
| `device_hardware` | Hardware inventory |
| `device_network` | Network interfaces |
| `device_metrics` | Time-series metrics (partitioned) |
| `device_software` | Installed software |
| `device_groups` | Static/dynamic groupings |
| `scripts` | Script library |
| `script_executions` | Execution history |
| `automations` | Workflow definitions |
| `automation_runs` | Workflow execution history |
| `policies` | Desired state policies |
| `policy_compliance` | Compliance status |
| `alert_rules` | Alert definitions |
| `alerts` | Alert instances |
| `notification_channels` | Email, Slack, webhook configs |
| `remote_sessions` | Remote access sessions |
| `audit_logs` | Compliance audit trail |

## API Endpoints

### Authentication
- `POST /api/v1/auth/login` - Email/password login
- `POST /api/v1/auth/mfa/verify` - MFA verification
- `GET /api/v1/auth/sso/{provider}` - SSO initiation

### Devices
- `GET /api/v1/devices` - List devices (paginated)
- `GET /api/v1/devices/:id` - Device details
- `GET /api/v1/devices/:id/metrics` - Metrics history
- `POST /api/v1/devices/:id/commands` - Queue command

### Agents (Server ↔ Agent)
- `POST /api/v1/agents/enroll` - Agent enrollment
- `POST /api/v1/agents/:id/heartbeat` - Heartbeat + metrics
- `POST /api/v1/agents/:id/commands/:cmdId/result` - Command result

### Scripts & Automation
- `GET/POST /api/v1/scripts` - Script library
- `POST /api/v1/scripts/:id/execute` - Execute on devices
- `GET/POST /api/v1/automations` - Workflow management
- `GET/POST /api/v1/policies` - Policy management

### Alerts
- `GET/POST /api/v1/alert-rules` - Alert rule management
- `GET /api/v1/alerts` - Active alerts
- `POST /api/v1/alerts/:id/acknowledge` - Acknowledge alert

### Remote Access
- `POST /api/v1/remote/sessions` - Start remote session
- `WS /ws/remote/:sessionId` - WebRTC signaling

## Agent Communication Flow

```
1. ENROLLMENT
   Agent → POST /api/v1/agents/enroll
   ← { agent_id, auth_token, config }

2. HEARTBEAT (every 60s)
   Agent → POST /api/v1/agents/{id}/heartbeat
   Body: { metrics, status, agent_version }
   ← { commands: [...], config_update, upgrade_to }

3. COMMAND EXECUTION
   Agent executes queued commands
   Agent → POST /api/v1/agents/{id}/commands/{cmd_id}/result
   Body: { status, exit_code, stdout, stderr }

4. REAL-TIME (on-demand WebSocket)
   Server initiates via heartbeat command
   Agent → WS /ws/agents/{id}
   Bidirectional: terminal I/O, desktop frames
```

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm 9+
- Docker & Docker Compose
- Go 1.21+ (for agent development)

### Setup
```bash
# Run the setup script
./scripts/setup.sh

# Or manually:
pnpm install                              # Install dependencies
cp .env.example .env                      # Create env file
docker-compose -f docker/docker-compose.yml up -d  # Start services
pnpm db:push                              # Push database schema
```

### Development
```bash
# Start web + API servers
pnpm dev

# In separate terminal - run the agent
cd agent && make run
```

### Services
| Service | URL |
|---------|-----|
| Web UI | http://localhost:4321 |
| API | http://localhost:3001 |
| PostgreSQL | localhost:5432 |
| Redis | localhost:6379 |
| MinIO | http://localhost:9001 |

## Implementation Status

> **See [ROADMAP.md](./ROADMAP.md) for detailed progress tracking**

### ✅ Completed
- [x] Monorepo structure (Turborepo + pnpm workspaces)
- [x] Astro web app with React islands
- [x] Hono API server structure
- [x] Drizzle database schema (20+ tables)
- [x] Shared packages (types, validators, constants)
- [x] Docker Compose configuration
- [x] Go agent structure (CLI, heartbeat, collectors)
- [x] Architecture documentation
- [x] **Authentication system** (login, register, MFA, password reset)
- [x] **Auth middleware** (JWT verification, scope checking)
- [x] **Auth UI** (all forms, pages, state management)

### 🟡 In Progress (Phase 1)
- [ ] Complete RBAC (permission middleware, role UI)
- [ ] Organization management (Partner/Org/Site CRUD)
- [ ] User management (profiles, invitations)

### 🔲 Next Phases
- Phase 2: Agent Core (enrollment, heartbeat, collectors)
- Phase 3: Device Management (list, groups, inventory)
- Phase 4: Scripting (library, editor, execution)
- Phase 5: Alerting (rules, notifications)
- Phase 6: Remote Access (WebRTC, terminal, file transfer)
- Phase 7: Automation (workflows, policies)
- Phase 8: Enterprise (SSO, advanced RBAC, audit)

## Key Files Reference

| File | Purpose |
|------|---------|
| [architecture.md](./architecture.md) | Full architecture specification |
| [apps/api/src/db/schema/](../apps/api/src/db/schema/) | Database schema definitions |
| [packages/shared/src/types/](../packages/shared/src/types/) | TypeScript type definitions |
| [packages/shared/src/validators/](../packages/shared/src/validators/) | Zod validation schemas |
| [agent/cmd/breeze-agent/main.go](../agent/cmd/breeze-agent/main.go) | Agent CLI entry point |
| [scripts/setup.sh](../scripts/setup.sh) | Development setup script |

## Environment Variables

See [.env.example](../.env.example) for all configuration options:

```env
DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze
REDIS_URL=redis://localhost:6379
JWT_SECRET=<your-secret>
MINIO_ENDPOINT=localhost:9000
```
