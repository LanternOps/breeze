# Connections Inventory 400 Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Linux agents from receiving HTTP 400 when submitting connections inventory on busy servers (472+ connections), by filtering out unsupported socket types in the agent before sending.

**Architecture:** The agent's `getProtocolString()` returns `"unknown"` for socket types other than TCP (1) and UDP (2) — e.g., Unix domain sockets, raw sockets. These hit the API's strict `z.enum(['tcp', 'tcp6', 'udp', 'udp6'])` and cause the entire payload to be rejected with 400. Fix at the agent (filter before send) and harden the API route (add `bodyLimit` for consistency).

**Tech Stack:** Go (gopsutil), TypeScript (Hono + Zod)

---

## Files

- Modify: `agent/internal/collectors/connections_linux.go` — skip connections where `getProtocolString` returns `"unknown"`
- Modify: `apps/api/src/routes/agents/connections.ts` — add `bodyLimit` middleware (consistency with other inventory routes)
- Modify: `apps/api/src/routes/agents/connections.test.ts` — add test confirming `"unknown"` protocol payloads would be caught

---

### Task 1: Filter unknown protocols in the Linux agent collector

**Files:**
- Modify: `agent/internal/collectors/connections_linux.go`
- Create: `agent/internal/collectors/connections_linux_test.go`

- [ ] **Step 1: Write a failing test for `getProtocolString`**

  Create `agent/internal/collectors/connections_linux_test.go`:

  ```go
  //go:build linux

  package collectors

  import (
  	"testing"
  )

  func TestGetProtocolString(t *testing.T) {
  	c := &ConnectionsCollector{}
  	tests := []struct {
  		connType uint32
  		family   uint32
  		want     string
  	}{
  		{connType: 1, family: 2, want: "tcp"},    // SOCK_STREAM, AF_INET
  		{connType: 1, family: 10, want: "tcp6"},   // SOCK_STREAM, AF_INET6
  		{connType: 2, family: 2, want: "udp"},     // SOCK_DGRAM, AF_INET
  		{connType: 2, family: 10, want: "udp6"},   // SOCK_DGRAM, AF_INET6
  		{connType: 3, family: 1, want: "unknown"}, // SOCK_RAW, AF_UNIX
  		{connType: 5, family: 1, want: "unknown"}, // SOCK_SEQPACKET, AF_UNIX
  	}

  	for _, tt := range tests {
  		got := c.getProtocolString(tt.connType, tt.family)
  		if got != tt.want {
  			t.Errorf("getProtocolString(%d, %d) = %q, want %q", tt.connType, tt.family, got, tt.want)
  		}
  	}
  }

  func TestCollectFiltersUnknownProtocols(t *testing.T) {
  	// Verify that connections with protocol "unknown" are excluded.
  	// We test getProtocolString directly since Collect() requires root for net.Connections.
  	c := &ConnectionsCollector{}
  	if got := c.getProtocolString(1, 2); got == "unknown" {
  		t.Error("tcp connections should not be filtered")
  	}
  	if got := c.getProtocolString(99, 99); got != "unknown" {
  		t.Errorf("unexpected socket type should return 'unknown', got %q", got)
  	}
  }
  ```

- [ ] **Step 2: Run the test to verify it passes (existing behavior)**

  ```bash
  cd agent && go test -race ./internal/collectors/... -run TestGetProtocolString -v
  ```
  Expected: PASS — `getProtocolString` already behaves correctly; we're testing it explicitly before changing the filter logic.

- [ ] **Step 3: Add the filter in `Collect()`**

  In `agent/internal/collectors/connections_linux.go`, the `Collect()` function appends every connection. Change it to skip connections where protocol is `"unknown"`:

  Replace:
  ```go
  		protocol := c.getProtocolString(conn.Type, conn.Family)

  		processName := ""
  ```
  With:
  ```go
  		protocol := c.getProtocolString(conn.Type, conn.Family)
  		if protocol == "unknown" {
  			continue // skip Unix sockets, raw sockets, and other unsupported types
  		}

  		processName := ""
  ```

- [ ] **Step 4: Run tests**

  ```bash
  cd agent && go test -race ./internal/collectors/... -v
  ```
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add agent/internal/collectors/connections_linux.go agent/internal/collectors/connections_linux_test.go
  git commit -m "fix(agent): skip unknown-protocol connections before submitting inventory"
  ```

---

### Task 2: Add `bodyLimit` middleware to the connections route

**Files:**
- Modify: `apps/api/src/routes/agents/connections.ts`

- [ ] **Step 1: Add the import**

  The current `connections.ts` imports are:
  ```typescript
  import { Hono } from 'hono';
  import { zValidator } from '@hono/zod-validator';
  import { eq } from 'drizzle-orm';
  import { db } from '../../db';
  import { devices, deviceConnections } from '../../db/schema';
  import { submitConnectionsSchema } from './schemas';
  ```

  Add `bodyLimit` to the import list:
  ```typescript
  import { Hono } from 'hono';
  import { bodyLimit } from 'hono/body-limit';
  import { zValidator } from '@hono/zod-validator';
  import { eq } from 'drizzle-orm';
  import { db } from '../../db';
  import { devices, deviceConnections } from '../../db/schema';
  import { submitConnectionsSchema } from './schemas';
  ```

- [ ] **Step 2: Add `bodyLimit` to the route**

  Replace:
  ```typescript
  connectionsRoutes.put('/:id/connections', zValidator('json', submitConnectionsSchema), async (c) => {
  ```
  With:
  ```typescript
  connectionsRoutes.put(
    '/:id/connections',
    bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
    zValidator('json', submitConnectionsSchema),
    async (c) => {
  ```

  Also close the route registration properly. The route currently ends with `});`. That ending is unchanged — you are only modifying the middleware chain at the top.

- [ ] **Step 3: Run the existing tests**

  ```bash
  pnpm test --filter=@breeze/api -- connections
  ```
  Expected: all existing tests pass.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/api/src/routes/agents/connections.ts
  git commit -m "fix(api): add bodyLimit to connections inventory route (consistent with other inventory routes)"
  ```

---

### Task 3: Add a test documenting the "unknown protocol" rejection

**Files:**
- Modify: `apps/api/src/routes/agents/connections.test.ts`

The API correctly rejects `"unknown"` protocol (via the existing `z.enum` test at line 163). Add an explicit test case that names this scenario so it's clear this is deliberate behavior.

- [ ] **Step 1: Add the test**

  In `apps/api/src/routes/agents/connections.test.ts`, inside the `'PUT /agents/:id/connections'` describe block, add after the `'should validate protocol enum'` test:

  ```typescript
  it('should reject "unknown" protocol (Linux agent must filter before sending)', async () => {
    const res = await app.request(`/agents/${AGENT_ID}/connections`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connections: [
          {
            protocol: 'unknown',
            localAddr: '0.0.0.0',
            localPort: 80,
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
  });
  ```

- [ ] **Step 2: Run tests**

  ```bash
  pnpm test --filter=@breeze/api -- connections
  ```
  Expected: PASS (the existing schema already rejects this — we're just documenting it).

- [ ] **Step 3: Commit**

  ```bash
  git add apps/api/src/routes/agents/connections.test.ts
  git commit -m "test(api): document that unknown-protocol connections are rejected"
  ```

---

### Task 4: Comment on GitHub issue #382

- [ ] **Step 1: Post the fix comment**

  ```bash
  gh issue comment 382 --repo LanternOps/breeze --body "$(cat <<'EOF'
  Root cause confirmed and fix committed.

  **Root cause:** `getProtocolString()` in the Linux collector returns `"unknown"` for non-TCP/UDP socket types (Unix domain sockets, raw sockets, etc.). These are common on busy servers with many inter-process connections. The API schema enforces `z.enum(['tcp','tcp6','udp','udp6'])`, so any payload containing an `"unknown"` entry is rejected with 400.

  **Fix:** The agent now skips connections with protocol `"unknown"` before building the PUT payload. The API schema and bodyLimit middleware are unchanged (schema stays strict, bodyLimit added for consistency with other inventory routes).

  Fix: [commit SHA here]
  EOF
  )"
  ```
