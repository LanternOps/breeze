# Breeze RMM Developer Guide

A comprehensive guide for developers working on the Breeze Remote Monitoring and Management platform.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Local Development Setup](#2-local-development-setup)
3. [API Development](#3-api-development)
4. [Frontend Development](#4-frontend-development)
5. [Agent Development](#5-agent-development)
6. [Database](#6-database)
7. [Testing](#7-testing)
8. [API Reference](#8-api-reference)
9. [Contributing](#9-contributing)

---

## 1. Architecture Overview

### Monorepo Structure

Breeze uses a monorepo architecture powered by **Turborepo** and **pnpm workspaces**:

```
breeze/
├── apps/
│   ├── web/                    # Astro + React frontend (port 4321)
│   └── api/                    # Hono API server (port 3001)
├── packages/
│   └── shared/                 # Shared types, validators, constants
├── agent/                      # Go agent (cross-platform)
├── docker/                     # Docker configurations
├── docs/                       # Documentation
└── scripts/                    # Development scripts
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| **Frontend** | Astro + React | Server-rendered pages with interactive React islands |
| **API Server** | Hono (TypeScript) | Fast, lightweight HTTP framework |
| **Database ORM** | Drizzle | Type-safe SQL queries |
| **Database** | PostgreSQL | Primary data store |
| **Job Queue** | BullMQ + Redis | Background job processing |
| **Agent** | Go | Cross-platform system monitoring agent |
| **Real-time** | HTTP Polling + WebSocket | Agent communication and live updates |
| **Remote Access** | WebRTC | Terminal, desktop, and file transfer |

### Service Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Users / Technicians                      │
└────────────────────────────────┬────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     Astro Frontend      │
                    │    (React Islands)      │
                    │      :4321              │
                    └────────────┬────────────┘
                                 │ REST API
                    ┌────────────▼────────────┐
                    │      Hono API           │
                    │        :3001            │
                    └─────┬──────────┬────────┘
                          │          │
          ┌───────────────┤          ├───────────────┐
          │               │          │               │
    ┌─────▼─────┐   ┌─────▼─────┐   ┌▼─────────────┐│
    │ PostgreSQL│   │   Redis   │   │   BullMQ     ││
    │   :5432   │   │   :6379   │   │  (Workers)   ││
    └───────────┘   └───────────┘   └──────────────┘│
                                                     │
                    ┌────────────────────────────────┘
                    │
        ┌───────────▼───────────┐
        │    Breeze Agent       │  ← Heartbeat/Metrics
        │   (Go - on devices)   │  → Commands/Scripts
        └───────────────────────┘
```

### Multi-Tenant Data Model

Breeze implements a hierarchical multi-tenant architecture:

```
Partner (MSP)
├── Organization (Customer)
│   ├── Site (Location)
│   │   ├── Device Group
│   │   │   └── Device
│   │   └── Device
│   └── Site
└── Organization
```

**Key Concepts:**

- **Partner**: An MSP or enterprise managing multiple organizations
- **Organization**: A customer or business unit
- **Site**: A physical location within an organization
- **Device Group**: Logical grouping of devices (static or dynamic)
- **Device**: A managed endpoint with the Breeze agent

**Access Scopes:**

- `system`: Full platform access (internal admins)
- `partner`: Access to all organizations under a partner
- `organization`: Access limited to a single organization

---

## 2. Local Development Setup

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Runtime for web and API |
| pnpm | 9+ | Package manager |
| Docker & Docker Compose | Latest | Local services (PostgreSQL, Redis) |
| Go | 1.21+ | Agent development |

### Clone and Install

```bash
# Clone the repository
git clone https://github.com/your-org/breeze.git
cd breeze

# Install dependencies
pnpm install
```

### Environment Configuration

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your local settings
```

**Required Environment Variables:**

```env
# Database
DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze

# Redis
REDIS_URL=redis://localhost:6379

# Authentication
JWT_SECRET=your-super-secret-key-change-in-production

# Optional: MinIO for file storage
MINIO_ENDPOINT=localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
```

### Running Services Locally

**1. Start infrastructure services:**

```bash
docker-compose -f docker/docker-compose.yml up -d
```

This starts:
- PostgreSQL on port 5432
- Redis on port 6379
- MinIO on port 9000/9001 (optional)

**2. Initialize the database:**

```bash
# Push schema to database
pnpm db:push

# Optional: Open Drizzle Studio to inspect data
pnpm db:studio
```

**3. Start development servers:**

```bash
# Start all services (web + API)
pnpm dev
```

| Service | URL |
|---------|-----|
| Web UI | http://localhost:4321 |
| API | http://localhost:3001 |
| Drizzle Studio | http://localhost:4983 |

### Database Setup and Migrations

```bash
# Generate migration from schema changes
pnpm db:generate

# Push schema directly (development)
pnpm db:push

# Run migrations (production)
pnpm db:migrate

# Open database GUI
pnpm db:studio
```

---

## 3. API Development

### Hono Framework Basics

The API uses [Hono](https://hono.dev/), a lightweight TypeScript web framework similar to Express but with better type safety.

**Creating a route file:**

```typescript
// apps/api/src/routes/example.ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';

export const exampleRoutes = new Hono();

// Apply auth to all routes
exampleRoutes.use('*', authMiddleware);

// GET endpoint with query validation
exampleRoutes.get(
  '/',
  zValidator('query', z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(50)
  })),
  async (c) => {
    const { page, limit } = c.req.valid('query');
    // ... query database
    return c.json({ data: [], pagination: { page, limit, total: 0 } });
  }
);

// POST endpoint with body validation
exampleRoutes.post(
  '/',
  zValidator('json', z.object({
    name: z.string().min(1).max(255),
    description: z.string().optional()
  })),
  async (c) => {
    const data = c.req.valid('json');
    // ... create resource
    return c.json({ id: 'new-id', ...data }, 201);
  }
);
```

### Route Structure

Routes are organized by resource in `apps/api/src/routes/`:

```
routes/
├── auth.ts          # Authentication endpoints
├── users.ts         # User management
├── orgs.ts          # Organizations and sites
├── devices.ts       # Device management
├── scripts.ts       # Script library
├── automations.ts   # Automation workflows
├── alerts.ts        # Alert rules and instances
├── agents.ts        # Agent enrollment and heartbeat
├── remote.ts        # Remote access sessions
├── audit.ts         # Audit log queries
├── roles.ts         # RBAC role management
├── apiKeys.ts       # API key management
├── sso.ts           # SSO configuration
├── reports.ts       # Reporting endpoints
└── docs.ts          # OpenAPI documentation
```

**Mounting routes in the main app:**

```typescript
// apps/api/src/index.ts
import { Hono } from 'hono';
import { deviceRoutes } from './routes/devices';
import { authRoutes } from './routes/auth';

const app = new Hono();

app.route('/api/v1/devices', deviceRoutes);
app.route('/api/v1/auth', authRoutes);
// ... other routes
```

### Authentication Middleware

The auth middleware extracts and validates JWT tokens:

```typescript
// apps/api/src/middleware/auth.ts
import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyToken } from '../services/jwt';

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing authorization header' });
  }

  const token = authHeader.slice(7);
  const payload = await verifyToken(token);

  if (!payload) {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  // Set auth context for route handlers
  c.set('auth', {
    user: { id: payload.sub, email: payload.email, name: payload.name },
    token: payload,
    partnerId: payload.partnerId,
    orgId: payload.orgId,
    scope: payload.scope
  });

  await next();
}
```

**Accessing auth in route handlers:**

```typescript
exampleRoutes.get('/', authMiddleware, async (c) => {
  const auth = c.get('auth');
  console.log('User ID:', auth.user.id);
  console.log('Organization:', auth.orgId);
  console.log('Scope:', auth.scope);
  // ...
});
```

### Permission Middleware

Use `requireScope` to enforce access levels:

```typescript
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';

// Require specific scopes
exampleRoutes.get(
  '/admin-only',
  authMiddleware,
  requireScope('system'),
  async (c) => { /* ... */ }
);

// Allow multiple scopes
exampleRoutes.get(
  '/org-data',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  async (c) => { /* ... */ }
);

// Check specific permissions
exampleRoutes.delete(
  '/:id',
  authMiddleware,
  requirePermission('devices', 'delete'),
  async (c) => { /* ... */ }
);
```

### Error Handling Patterns

```typescript
import { HTTPException } from 'hono/http-exception';

// Throw HTTP exceptions
if (!resource) {
  throw new HTTPException(404, { message: 'Resource not found' });
}

if (!hasPermission) {
  throw new HTTPException(403, { message: 'Permission denied' });
}

// Return JSON errors (for validation)
if (!isValid) {
  return c.json({ error: 'Validation failed', details: errors }, 400);
}
```

### Database Queries with Drizzle

**Basic queries:**

```typescript
import { db } from '../db';
import { devices, organizations } from '../db/schema';
import { eq, and, like, desc, sql } from 'drizzle-orm';

// Select with conditions
const [device] = await db
  .select()
  .from(devices)
  .where(eq(devices.id, deviceId))
  .limit(1);

// Select with joins
const results = await db
  .select({
    id: devices.id,
    hostname: devices.hostname,
    orgName: organizations.name
  })
  .from(devices)
  .innerJoin(organizations, eq(devices.orgId, organizations.id))
  .where(eq(devices.status, 'online'))
  .orderBy(desc(devices.lastSeenAt))
  .limit(50);

// Insert
const [newDevice] = await db
  .insert(devices)
  .values({
    orgId: 'org-uuid',
    hostname: 'workstation-01',
    osType: 'windows',
    // ...
  })
  .returning();

// Update
await db
  .update(devices)
  .set({ status: 'offline', updatedAt: new Date() })
  .where(eq(devices.id, deviceId));

// Count
const [{ count }] = await db
  .select({ count: sql<number>`count(*)` })
  .from(devices)
  .where(eq(devices.orgId, orgId));
```

**Multi-tenant query pattern:**

```typescript
async function getDevicesForAuth(auth: AuthContext) {
  const conditions = [];

  // Apply tenant filter based on scope
  if (auth.scope === 'organization') {
    conditions.push(eq(devices.orgId, auth.orgId!));
  } else if (auth.scope === 'partner') {
    // Get all orgs under this partner
    const partnerOrgs = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.partnerId, auth.partnerId!));

    const orgIds = partnerOrgs.map(o => o.id);
    conditions.push(inArray(devices.orgId, orgIds));
  }
  // system scope has no filter

  return db
    .select()
    .from(devices)
    .where(conditions.length > 0 ? and(...conditions) : undefined);
}
```

---

## 4. Frontend Development

### Astro with React Islands

Breeze uses [Astro](https://astro.build/) for the frontend with React components for interactive parts.

**Astro configuration:**

```javascript
// apps/web/astro.config.mjs
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',           // Server-side rendering
  adapter: node({ mode: 'standalone' }),
  integrations: [
    react(),                   // React island support
    tailwind({ applyBaseStyles: false })
  ],
  server: { port: 4321 }
});
```

**Page structure:**

```
apps/web/src/
├── pages/
│   ├── index.astro           # Dashboard
│   ├── login.astro           # Login page
│   ├── devices/
│   │   ├── index.astro       # Device list
│   │   └── [id].astro        # Device details
│   └── settings/
│       ├── index.astro
│       ├── users.astro
│       └── profile.astro
├── layouts/
│   ├── Layout.astro          # Base HTML layout
│   ├── DashboardLayout.astro # Authenticated layout
│   └── AuthLayout.astro      # Login/register layout
├── components/
│   ├── dashboard/            # Dashboard components
│   ├── devices/              # Device management
│   ├── auth/                 # Authentication forms
│   └── settings/             # Settings components
├── stores/                   # Zustand state stores
└── styles/
    └── globals.css           # Tailwind imports
```

### Component Patterns

**Astro page with React island:**

```astro
---
// pages/devices/index.astro
import DashboardLayout from '@/layouts/DashboardLayout.astro';
import DevicesPage from '@/components/devices/DevicesPage';
---

<DashboardLayout title="Devices">
  <!-- React component with client hydration -->
  <DevicesPage client:load />
</DashboardLayout>
```

**React component:**

```tsx
// components/devices/DeviceList.tsx
import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '@/stores/auth';

export default function DeviceList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const res = await fetchWithAuth('/devices');
      if (!res.ok) throw new Error('Failed to fetch');
      return res.json();
    }
  });

  if (isLoading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div className="grid gap-4">
      {data.data.map(device => (
        <DeviceCard key={device.id} device={device} />
      ))}
    </div>
  );
}
```

### State Management with Zustand

```typescript
// stores/auth.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  user: User | null;
  tokens: Tokens | null;
  isAuthenticated: boolean;
  login: (user: User, tokens: Tokens) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      isAuthenticated: false,

      login: (user, tokens) => set({
        user,
        tokens,
        isAuthenticated: true
      }),

      logout: () => set({
        user: null,
        tokens: null,
        isAuthenticated: false
      })
    }),
    {
      name: 'breeze-auth',
      partialize: (state) => ({
        user: state.user,
        tokens: state.tokens,
        isAuthenticated: state.isAuthenticated
      })
    }
  )
);
```

### Form Handling with react-hook-form + Zod

```tsx
// components/auth/LoginForm.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters')
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function LoginForm() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema)
  });

  const onSubmit = async (data: LoginFormData) => {
    const result = await apiLogin(data.email, data.password);
    if (result.success) {
      useAuthStore.getState().login(result.user!, result.tokens!);
      window.location.href = '/';
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <input
        type="email"
        {...register('email')}
        className="input"
      />
      {errors.email && <span className="error">{errors.email.message}</span>}

      <input
        type="password"
        {...register('password')}
        className="input"
      />
      {errors.password && <span className="error">{errors.password.message}</span>}

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Logging in...' : 'Login'}
      </button>
    </form>
  );
}
```

### API Client Usage

```typescript
// stores/auth.ts
export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const { tokens, logout, setTokens } = useAuthStore.getState();

  const headers = new Headers(options.headers);
  if (tokens?.accessToken) {
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }
  headers.set('Content-Type', 'application/json');

  let response = await fetch(`/api${url}`, { ...options, headers });

  // Auto-refresh on 401
  if (response.status === 401 && tokens?.refreshToken) {
    const refreshResponse = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken })
    });

    if (refreshResponse.ok) {
      const { tokens: newTokens } = await refreshResponse.json();
      setTokens(newTokens);

      // Retry original request
      headers.set('Authorization', `Bearer ${newTokens.accessToken}`);
      response = await fetch(`/api${url}`, { ...options, headers });
    } else {
      logout();
    }
  }

  return response;
}
```

### Styling with Tailwind CSS

**Global styles:**

```css
/* styles/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --primary: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --success: 142 76% 36%;
    --warning: 38 92% 50%;
  }
}
```

**Component example:**

```tsx
import { cn } from '@/lib/utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive' | 'outline';
  size?: 'sm' | 'md' | 'lg';
}

export function Button({ variant = 'default', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium',
        variant === 'default' && 'bg-primary text-white hover:bg-primary/90',
        variant === 'destructive' && 'bg-destructive text-white hover:bg-destructive/90',
        variant === 'outline' && 'border border-input bg-background hover:bg-accent',
        size === 'sm' && 'h-8 px-3 text-sm',
        size === 'md' && 'h-10 px-4',
        size === 'lg' && 'h-12 px-6 text-lg',
        className
      )}
      {...props}
    />
  );
}
```

---

## 5. Agent Development

### Go Project Structure

```
agent/
├── cmd/
│   └── breeze-agent/
│       └── main.go           # CLI entry point
├── internal/
│   ├── config/
│   │   └── config.go         # Configuration management
│   ├── heartbeat/
│   │   └── heartbeat.go      # Server communication
│   ├── collectors/
│   │   ├── metrics.go        # System metrics
│   │   ├── hardware.go       # Hardware inventory
│   │   └── network.go        # Network interfaces
│   └── scripts/
│       └── runner.go         # Script execution
├── pkg/
│   └── api/
│       └── client.go         # API client
├── go.mod
├── go.sum
└── Makefile
```

### Building the Agent

```bash
cd agent

# Build for current platform
make build

# Build for all platforms
make build-all

# Run in development
make run

# Run tests
make test
```

**Makefile targets:**

```makefile
# Build for specific platforms
build-linux:
    GOOS=linux GOARCH=amd64 go build -o bin/breeze-agent-linux-amd64 ./cmd/breeze-agent
    GOOS=linux GOARCH=arm64 go build -o bin/breeze-agent-linux-arm64 ./cmd/breeze-agent

build-darwin:
    GOOS=darwin GOARCH=amd64 go build -o bin/breeze-agent-darwin-amd64 ./cmd/breeze-agent
    GOOS=darwin GOARCH=arm64 go build -o bin/breeze-agent-darwin-arm64 ./cmd/breeze-agent

build-windows:
    GOOS=windows GOARCH=amd64 go build -o bin/breeze-agent-windows-amd64.exe ./cmd/breeze-agent
```

### Adding Collectors

Collectors gather system information and send it to the server.

**Example: Metrics Collector**

```go
// internal/collectors/metrics.go
package collectors

import (
    "github.com/shirou/gopsutil/v3/cpu"
    "github.com/shirou/gopsutil/v3/disk"
    "github.com/shirou/gopsutil/v3/mem"
)

type SystemMetrics struct {
    CPUPercent      float64 `json:"cpuPercent"`
    RAMPercent      float64 `json:"ramPercent"`
    RAMUsedMB       uint64  `json:"ramUsedMb"`
    DiskPercent     float64 `json:"diskPercent"`
    DiskUsedGB      float64 `json:"diskUsedGb"`
    ProcessCount    int     `json:"processCount,omitempty"`
}

type MetricsCollector struct {
    lastNetIn  uint64
    lastNetOut uint64
}

func NewMetricsCollector() *MetricsCollector {
    return &MetricsCollector{}
}

func (c *MetricsCollector) Collect() (*SystemMetrics, error) {
    metrics := &SystemMetrics{}

    // CPU
    cpuPercent, err := cpu.Percent(0, false)
    if err == nil && len(cpuPercent) > 0 {
        metrics.CPUPercent = cpuPercent[0]
    }

    // Memory
    vmem, err := mem.VirtualMemory()
    if err == nil {
        metrics.RAMPercent = vmem.UsedPercent
        metrics.RAMUsedMB = vmem.Used / 1024 / 1024
    }

    // Disk
    diskUsage, err := disk.Usage("/")
    if err == nil {
        metrics.DiskPercent = diskUsage.UsedPercent
        metrics.DiskUsedGB = float64(diskUsage.Used) / 1024 / 1024 / 1024
    }

    return metrics, nil
}
```

**Creating a new collector:**

1. Create a new file in `internal/collectors/`
2. Define a struct for the collected data
3. Implement `Collect() (*YourData, error)` method
4. Register in the heartbeat loop

### Testing Locally

```bash
# Start the agent in development mode
cd agent
go run ./cmd/breeze-agent run --server http://localhost:3001

# Enroll a device
go run ./cmd/breeze-agent enroll YOUR_ENROLLMENT_KEY --server http://localhost:3001

# Check status
go run ./cmd/breeze-agent status
```

**Configuration file locations:**

| OS | Path |
|----|------|
| Windows | `C:\ProgramData\Breeze\agent.yaml` |
| macOS | `/Library/Application Support/Breeze/agent.yaml` |
| Linux | `/etc/breeze/agent.yaml` |

**Environment variables (prefix: `BREEZE_`):**

```bash
BREEZE_SERVER_URL=https://api.breeze.example.com
BREEZE_AGENT_ID=agent-uuid
BREEZE_AUTH_TOKEN=jwt-token
```

---

## 6. Database

### Schema Organization

Database schemas are defined in `apps/api/src/db/schema/`:

```
schema/
├── index.ts          # Re-exports all schemas
├── orgs.ts           # Partners, organizations, sites
├── users.ts          # Users, roles, permissions
├── devices.ts        # Devices, hardware, metrics, groups
├── scripts.ts        # Scripts, executions
├── automations.ts    # Automations, policies
├── alerts.ts         # Alert rules, alerts, notifications
├── remote.ts         # Remote sessions, file transfers
└── audit.ts          # Audit logs
```

**Example schema definition:**

```typescript
// schema/devices.ts
import { pgTable, uuid, varchar, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { organizations, sites } from './orgs';

export const deviceStatusEnum = pgEnum('device_status', [
  'online', 'offline', 'maintenance', 'decommissioned'
]);

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  siteId: uuid('site_id').notNull().references(() => sites.id),
  agentId: varchar('agent_id', { length: 64 }).notNull().unique(),
  hostname: varchar('hostname', { length: 255 }).notNull(),
  status: deviceStatusEnum('status').notNull().default('offline'),
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
```

### Migration Workflow

**Development (schema push):**

```bash
# Directly push schema changes to database
pnpm db:push
```

**Production (migrations):**

```bash
# Generate migration from schema changes
pnpm db:generate

# Review generated SQL in apps/api/drizzle/

# Apply migrations
pnpm db:migrate
```

### Common Query Patterns

**Pagination:**

```typescript
function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, parseInt(query.page ?? '1'));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '50')));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// Usage
const { page, limit, offset } = getPagination(c.req.query());
const data = await db
  .select()
  .from(devices)
  .limit(limit)
  .offset(offset);
```

**Filtering:**

```typescript
import { and, eq, like, inArray } from 'drizzle-orm';

const conditions = [];

if (query.status) {
  conditions.push(eq(devices.status, query.status));
}

if (query.search) {
  conditions.push(like(devices.hostname, `%${query.search}%`));
}

const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

const results = await db
  .select()
  .from(devices)
  .where(whereClause);
```

### Multi-Tenant Queries

Always filter by organization/partner context:

```typescript
async function getDevicesWithTenantFilter(auth: AuthContext) {
  const conditions = [];

  switch (auth.scope) {
    case 'organization':
      // Direct org filter
      conditions.push(eq(devices.orgId, auth.orgId!));
      break;

    case 'partner':
      // Get all orgs under partner, then filter
      const partnerOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.partnerId, auth.partnerId!));

      conditions.push(inArray(devices.orgId, partnerOrgs.map(o => o.id)));
      break;

    case 'system':
      // No tenant filter for system scope
      break;
  }

  return db.select().from(devices).where(and(...conditions));
}
```

---

## 7. Testing

### Unit Testing

**API tests (with Vitest):**

```typescript
// apps/api/src/routes/__tests__/auth.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { app } from '../index';

describe('Auth Routes', () => {
  it('should return 401 for invalid credentials', async () => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'invalid@example.com',
        password: 'wrongpassword'
      }),
      headers: { 'Content-Type': 'application/json' }
    });

    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});
```

**Frontend tests (with Vitest + Testing Library):**

```tsx
// apps/web/src/components/__tests__/LoginForm.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import LoginForm from '../auth/LoginForm';

describe('LoginForm', () => {
  it('should show validation errors for empty fields', async () => {
    render(<LoginForm />);

    fireEvent.click(screen.getByRole('button', { name: /login/i }));

    expect(await screen.findByText(/invalid email/i)).toBeInTheDocument();
  });
});
```

### Integration Testing

**Database integration tests:**

```typescript
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db } from '../db';
import { devices } from '../db/schema';

describe('Device Repository', () => {
  beforeEach(async () => {
    // Clean up test data
    await db.delete(devices).where(like(devices.hostname, 'test-%'));
  });

  it('should create a device', async () => {
    const [device] = await db
      .insert(devices)
      .values({
        orgId: 'test-org-id',
        siteId: 'test-site-id',
        agentId: 'test-agent-001',
        hostname: 'test-workstation',
        osType: 'windows',
        osVersion: '10.0.19041',
        architecture: 'amd64',
        agentVersion: '0.1.0'
      })
      .returning();

    expect(device.id).toBeDefined();
    expect(device.hostname).toBe('test-workstation');
  });
});
```

### E2E Testing

**Playwright tests:**

```typescript
// e2e/login.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('should login with valid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.fill('input[name="email"]', 'admin@example.com');
    await page.fill('input[name="password"]', 'password123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('/');
    await expect(page.locator('text=Dashboard')).toBeVisible();
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await page.goto('/login');

    await page.fill('input[name="email"]', 'invalid@example.com');
    await page.fill('input[name="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Invalid email or password')).toBeVisible();
  });
});
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for specific package
pnpm --filter @breeze/api test
pnpm --filter @breeze/web test

# Run with coverage
pnpm test -- --coverage

# Run E2E tests
pnpm e2e
```

---

## 8. API Reference

### OpenAPI Documentation

Interactive API documentation is available at:

```
http://localhost:3001/api/v1/docs
```

### Authentication Methods

**JWT Bearer Token:**

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**API Key:**

```http
X-API-Key: brz_live_abc123...
```

### Common Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/auth/login` | User login |
| POST | `/api/v1/auth/register` | User registration |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| GET | `/api/v1/auth/me` | Get current user |
| POST | `/api/v1/auth/mfa/setup` | Setup MFA |
| POST | `/api/v1/auth/mfa/verify` | Verify MFA code |
| GET | `/api/v1/devices` | List devices |
| GET | `/api/v1/devices/:id` | Get device details |
| PATCH | `/api/v1/devices/:id` | Update device |
| DELETE | `/api/v1/devices/:id` | Decommission device |
| GET | `/api/v1/devices/:id/metrics` | Get device metrics |
| POST | `/api/v1/devices/:id/commands` | Queue command |
| GET | `/api/v1/scripts` | List scripts |
| POST | `/api/v1/scripts/:id/execute` | Execute script |
| GET | `/api/v1/alerts` | List alerts |
| POST | `/api/v1/alerts/:id/acknowledge` | Acknowledge alert |
| GET | `/api/v1/organizations` | List organizations |
| GET | `/api/v1/users` | List users |
| GET | `/api/v1/audit` | Query audit logs |

### Response Format

**Success response:**

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 123
  }
}
```

**Error response:**

```json
{
  "error": "Error message",
  "details": {}
}
```

---

## 9. Contributing

### Code Style Guidelines

- **TypeScript**: Use strict mode, explicit return types for public functions
- **Go**: Follow standard Go conventions, run `gofmt` and `golangci-lint`
- **React**: Prefer functional components with hooks
- **CSS**: Use Tailwind utility classes, avoid custom CSS when possible

### PR Process

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make changes and commit:**
   ```bash
   git add .
   git commit -m "feat: add device filtering by OS type"
   ```

3. **Push and create PR:**
   ```bash
   git push -u origin feature/your-feature-name
   ```

4. **PR requirements:**
   - Passes all CI checks (lint, test, build)
   - Has appropriate test coverage
   - Includes documentation updates if needed
   - Has at least one approval

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:**

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, semicolons) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `chore` | Build process, dependencies, tooling |

**Examples:**

```bash
feat(devices): add filtering by OS type
fix(auth): handle expired refresh tokens correctly
docs(api): add examples for device endpoints
refactor(db): extract pagination helper function
```

### Development Workflow

1. Pick an issue from the backlog
2. Create a feature branch
3. Write tests first (TDD encouraged)
4. Implement the feature
5. Run linting and tests locally
6. Create PR with clear description
7. Address review feedback
8. Merge after approval

---

## Additional Resources

- [Project Status](./PROJECT_STATUS.md) - Current implementation status
- [Architecture](./architecture.md) - Detailed architecture specification
- [Hono Documentation](https://hono.dev/)
- [Drizzle ORM Documentation](https://orm.drizzle.team/)
- [Astro Documentation](https://docs.astro.build/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
