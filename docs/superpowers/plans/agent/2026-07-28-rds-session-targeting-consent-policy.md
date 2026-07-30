# RDS Session Targeting, Consent Routing & Policy Plumbing Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the plan-2 lease lifecycle into the real command paths: a tech on an RDS host can pick a specific session to shadow (with the consent prompt/banner delivered to *that* session's user) or to run a script as *that* session's user — with typed failures instead of hangs — plus the helper config-policy transport extension for the lifecycle-mode override and the two pre-existing policy bugs (partner-owned helper policies never resolving; consent child-table RLS being org-only).

**Architecture:** Spec: `docs/superpowers/specs/agent/2026-07-28-rds-per-session-helpers-design.md` (sections "Capture, routing, consent", "Policy plumbing", "API / web"). Plan 2 built `AcquireLease`/`ReleaseLease`/`RenewLease`/`WaitForHelperReady` and the mode-switched desired set — all currently with **zero non-test callers**. This plan consumes them from `handleStartDesktop`/`handleScript`, adds session-scoped consent routing in the broker/consent gate, extends `list_sessions` with idle time and exposes it via a synchronous device API endpoint, threads `targetSessionId` through the script stack, extends the `HelperSettings` heartbeat transport with a `lifecycleMode` override (live-applied via a new `SetModeOverride` on the lifecycle manager), and gates the new web pickers on `device.helperLifecycleMode === 'on-demand'`.

**Tech Stack:** Go (agent), Hono + Zod + Drizzle (API), hand-written SQL migration, React + Vitest/jsdom (web), i18next (7 locales).

## Global Constraints

- Branch: `ToddHebebrand/multiple-user-helpers` (continues PR #2911). Commit per task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Workstation / always-on behavior stays bit-identical.** Every new agent behavior is gated on `lifecycleMode() == "on-demand"` or on an *explicit* `targetSessionId`. All existing Go tests must pass unmodified except mechanical updates forced by signature changes (which are called out per task).
- **Consent invariant:** the user being shadowed is the one who sees the consent prompt / notify toast / session banner. Never a helper in a different Windows session when a target is specified.
- CI runs Go tests on non-Windows: **all new logic goes in build-tag-free files**; `//go:build windows` files get thin wiring only. `lifecycle.go` is windows-tagged; `lifecycle_core.go`, `lifecycle_lease.go`, `lifecycle_wait.go`, `lifecycle_mode.go`, `handlers_desktop.go`, `handlers_desktop_helper.go`, `handlers_script.go`, `consent_gate.go` are untagged.
- Go test commands: `cd agent && go test -race ./internal/sessionbroker/... ./internal/heartbeat/... ./internal/remote/...` (plus package under edit). Cross-compile check after every agent task: `cd agent && GOOS=windows go build ./...`.
- Plan-2 contracts consumed here (do not re-declare): `AcquireLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error`, `RenewLease(...same...) error`, `ReleaseLease(sessionID uint32, role ipc.HelperRole, opID string)` (`lifecycle_lease.go:55/101/119`); `WaitForHelperReady(ctx context.Context, key HelperKey) HelperWaitResult` with statuses `ready | fatal-cooldown | retries-exhausted | session-gone | timeout | spawner-unavailable` (`lifecycle_wait.go:8-38`); errors `ErrLeaseSessionNotFound`, `ErrLeaseRoleNotSpawnable`; constants `leaseLinger=2m`, `defaultLeaseTTL=5m`, `maxLeaseTTL=30m`; `Mode() string` (`lifecycle_core.go:200`); `HelperKey{WindowsSessionID uint32, Role ipc.HelperRole}`; `Broker.HelperSessionByKey(key HelperKey) *Session`.
- Session state strings: `"active" | "connected" | "disconnected"`; types `"console" | "rdp" | "services"`. String↔uint32 session IDs convert via `sessionbroker.ParseWindowsSessionIDForHeartbeat(s string) (uint32, error)`.
- `targetSessionId` on every wire hop is a **number, integer, 0–65535** (matches `webrtcOfferSchema`, `remote/schemas.ts:28-32`). Agent-side broker APIs take the string form.
- `device.helperLifecycleMode` (`'always-on' | 'on-demand' | null`) is a **hint, not a guarantee** — the heartbeat ingest guard (`agents/heartbeat.ts:530-532`) never clears a stale value. All UI keyed on it must degrade gracefully when stale (the live session fetch still works and targeting the console session is harmless).
- Migrations: idempotent (`IF NOT EXISTS` / `DROP POLICY IF EXISTS`), **no inner `BEGIN;`/`COMMIT;`**, filename `YYYY-MM-DD-<slug>.sql`, never edit a shipped migration. No new tables → no cascade-list registration needed in this plan.
- Zod heartbeat/response schemas default-strip unknown keys — every new field must be added to the relevant schema or it is silently dropped.
- **i18n:** every new UI string key must be added to ALL seven locale files (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`) in the same commit — key-parity checks red main otherwise. Non-English values may be reasonable translations.
- `pnpm test` does NOT run the separate-config suites. Run explicitly where a task says so: RLS/integration suites need a real local Postgres (`vitest.integration.config.ts` / `vitest.config.rls.ts`, test PG on :5433).
- Server-side single-desktop-session ordering (`remote/sessions.ts:214`) is unchanged by this plan: a second desktop connect to the same device kills the first, even to a different Windows session. Known, accepted for phase 1.

---

### Task 1: `list_sessions` gains idle time + session filtering (agent)

**Files:**
- Create: `agent/internal/sessionbroker/session_info.go`
- Create: `agent/internal/sessionbroker/session_info_test.go`
- Modify: `agent/internal/ipc/message.go:390-398` (`SessionInfoItem` — add `IdleMinutes`)
- Modify: `agent/internal/heartbeat/handlers_desktop.go:284-324` (`handleListSessions` — use the new builder)
- Modify: `agent/internal/remote/desktop/session_control.go:292-331` (`list_sessions` control message — use the new builder)

**Interfaces:**
- Consumes: `DetectedSession{Session, Username, State, Type, IdleFor, IdleKnown}` (`detector.go:29-45`), `ParseWindowsSessionIDForHeartbeat`.
- Produces: `ipc.SessionInfoItem.IdleMinutes *int` (json `idleMinutes,omitempty`); `func BuildSessionInfoItems(detected []DetectedSession, helperByWinSession map[string]bool) []ipc.SessionInfoItem` in package `sessionbroker` — filters `services`-type and empty-username sessions, caps idle at 10080 minutes. Task 2's API endpoint and Task 13/14's UI consume the JSON shape `{sessionId, username, state, type, helperConnected, idleMinutes?}`.

Idle time is already computed on `DetectedSession` (`detector_windows.go:157-161` via WTSSessionInfoEx; `idle.go:19-38`) — `list_sessions` just discards it today. The heartbeat variant (`handlers_desktop.go:284`) currently does NOT filter `services`/empty-username sessions while the WebRTC variant (`session_control.go:292`) does; the heartbeat variant has **no callers today**, so unifying on the filtered behavior is safe.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/sessionbroker/session_info_test.go`:

```go
package sessionbroker

import (
	"testing"
	"time"
)

func TestBuildSessionInfoItems(t *testing.T) {
	detected := []DetectedSession{
		{Session: "0", Username: "", State: "connected", Type: "services"},                                                    // filtered: services
		{Session: "1", Username: "console-user", State: "active", Type: "console", IdleFor: 7 * time.Minute, IdleKnown: true}, // kept, idle 7
		{Session: "3", Username: "rdp-alice", State: "active", Type: "rdp"},                                                   // kept, idle unknown
		{Session: "4", Username: "", State: "connected", Type: "rdp"},                                                         // filtered: no user (RDP listener)
		{Session: "not-a-number", Username: "x", State: "active", Type: "rdp"},                                                // filtered: unparseable id
		{Session: "5", Username: "rdp-bob", State: "disconnected", Type: "rdp", IdleFor: 30 * 24 * time.Hour, IdleKnown: true}, // kept, idle capped
	}
	items := BuildSessionInfoItems(detected, map[string]bool{"3": true})

	if len(items) != 3 {
		t.Fatalf("expected 3 items, got %d: %+v", len(items), items)
	}
	if items[0].SessionID != 1 || items[0].IdleMinutes == nil || *items[0].IdleMinutes != 7 || items[0].HelperConnected {
		t.Errorf("item 0 wrong: %+v", items[0])
	}
	if items[1].SessionID != 3 || items[1].IdleMinutes != nil || !items[1].HelperConnected {
		t.Errorf("item 1 wrong: %+v", items[1])
	}
	if items[2].SessionID != 5 || items[2].IdleMinutes == nil || *items[2].IdleMinutes != 10080 || items[2].State != "disconnected" {
		t.Errorf("item 2 wrong: %+v", items[2])
	}
}

func TestBuildSessionInfoItemsNilHelperMap(t *testing.T) {
	items := BuildSessionInfoItems([]DetectedSession{{Session: "2", Username: "u", State: "active", Type: "rdp"}}, nil)
	if len(items) != 1 || items[0].HelperConnected {
		t.Fatalf("nil helper map should mean HelperConnected=false: %+v", items)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestBuildSessionInfoItems -v`
Expected: FAIL — `undefined: BuildSessionInfoItems`

- [ ] **Step 3: Add `IdleMinutes` to `SessionInfoItem` and implement the builder**

In `agent/internal/ipc/message.go`, extend the struct at `:390-398`:

```go
// SessionInfoItem describes one interactive Windows session for the
// list_sessions command response.
type SessionInfoItem struct {
	SessionID       uint32 `json:"sessionId"`
	Username        string `json:"username"`
	State           string `json:"state"`
	Type            string `json:"type"`
	HelperConnected bool   `json:"helperConnected"`
	// IdleMinutes is minutes since last user input in the session, capped at
	// one week. Nil when the platform could not measure input idle.
	IdleMinutes *int `json:"idleMinutes,omitempty"`
}
```

Create `agent/internal/sessionbroker/session_info.go`:

```go
package sessionbroker

import (
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// maxSessionIdleMinutes caps reported idle at one week, mirroring the
// collectors/sessions.go device-session cap.
const maxSessionIdleMinutes = 10080

// BuildSessionInfoItems converts detector output to the list_sessions wire
// shape. It drops the services pseudo-session, sessions with no logged-in user
// (pre-allocated RDP listeners visible at the lock screen), and sessions whose
// ID doesn't parse. helperByWinSession marks sessions with a connected helper
// (keyed by the DetectedSession.Session string); nil means "unknown/none".
func BuildSessionInfoItems(detected []DetectedSession, helperByWinSession map[string]bool) []ipc.SessionInfoItem {
	items := make([]ipc.SessionInfoItem, 0, len(detected))
	for _, ds := range detected {
		if ds.Type == "services" || ds.Username == "" {
			continue
		}
		sessionNum, err := ParseWindowsSessionIDForHeartbeat(ds.Session)
		if err != nil {
			continue
		}
		item := ipc.SessionInfoItem{
			SessionID:       sessionNum,
			Username:        ds.Username,
			State:           ds.State,
			Type:            ds.Type,
			HelperConnected: helperByWinSession[ds.Session],
		}
		if ds.IdleKnown {
			m := int(ds.IdleFor / time.Minute)
			if m < 0 {
				m = 0
			}
			if m > maxSessionIdleMinutes {
				m = maxSessionIdleMinutes
			}
			item.IdleMinutes = &m
		}
		items = append(items, item)
	}
	return items
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestBuildSessionInfoItems -v`
Expected: PASS

- [ ] **Step 5: Rewire both `list_sessions` call sites onto the builder**

In `agent/internal/heartbeat/handlers_desktop.go:284-324` (`handleListSessions`): keep the detector call and the broker merge that builds `helperByWinSession` (`:290-298`), then replace the entire hand-rolled `items := ...` loop (`:299-317`) with:

```go
	items := sessionbroker.BuildSessionInfoItems(detected, helperByWinSession)
```

In `agent/internal/remote/desktop/session_control.go:292-331` (`case "list_sessions":`): replace the hand-rolled filter/convert loop with:

```go
		items := sessionbroker.BuildSessionInfoItems(detected, nil)
```

keeping the surrounding `detector.ListSessions()` error handling and the `{"type": "sessions", "sessions": items}` marshal unchanged. (This variant previously hardcoded `HelperConnected: false`; `nil` map preserves that, and it now also reports `idleMinutes` — additive for the viewer toolbar, which ignores unknown fields.)

- [ ] **Step 6: Run package tests + cross-compile**

Run: `cd agent && go test -race ./internal/sessionbroker/... ./internal/heartbeat/... ./internal/remote/... && GOOS=windows go build ./...`
Expected: PASS (existing `session_control` / `handlers_desktop` tests unchanged)

- [ ] **Step 7: Commit**

```bash
git add agent/internal/ipc/message.go agent/internal/sessionbroker/session_info.go agent/internal/sessionbroker/session_info_test.go agent/internal/heartbeat/handlers_desktop.go agent/internal/remote/desktop/session_control.go
git commit -m "feat(agent): list_sessions reports idle time, filters service/userless sessions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Live-sessions device API endpoint

**Files:**
- Modify: `apps/api/src/routes/devices/sessions.ts` (add `GET /:id/sessions/live` beside the existing `GET /:id/sessions/active` at `:35-79`)
- Test: `apps/api/src/routes/devices/sessions.live.test.ts`

**Interfaces:**
- Consumes: `sendCommandToAgentAwaitResult(agentId, command, timeoutMs)` from `apps/api/src/services/agentCommandAwait.ts` (result `{status, stdout?, error?}`; agents put structured output as a JSON string in `stdout` — copy the caller pattern from `apps/api/src/routes/tunnelHttp.ts:322-341`); agent `list_sessions` JSON from Task 1.
- Produces: `GET /devices/:id/sessions/live` → `200 {data: {deviceId, sessions: LiveSession[]}}` where `LiveSession = {sessionId: number, username: string, state: string, type: string, helperConnected: boolean, idleMinutes: number | null}`; `404` unknown device (or cross-tenant, via RLS), `403` site access denied (device access resolved via `getDeviceWithOrgAndSiteCheck`, same as the sibling `/sessions/active` — site scoping is app-layer, RLS alone does not cover it), `409` no agent enrolled, `502` agent offline/failed, `504` agent timeout. Tasks 13/14 consume this endpoint. *(Amended during execution: the original 404-only contract omitted the site check — flagged by security review.)*

This is a read-only synchronous probe: **no `device_commands` row** — synthetic command id, result consumed entirely by the awaiting promise (same shape as `tunnelHttp.ts`; `resolvePendingAgentCommand` at `agentWs.ts:1666` short-circuits result processing).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/devices/sessions.live.test.ts`. Mirror the mocking conventions of the existing tests in `apps/api/src/routes/devices/` (module-mock the db and services; adapt import paths to what `sessions.ts` actually imports):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const awaitResultMock = vi.fn();
vi.mock('../../services/agentCommandAwait', () => ({
  sendCommandToAgentAwaitResult: (...args: unknown[]) => awaitResultMock(...args),
}));

// Mock the db so the device lookup resolves; follow the chained-builder mock
// pattern used by sibling tests in routes/devices/ (limit() resolving the rows).
const deviceRow = { id: 'dev-1', agentId: 'agent-1' };
vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [deviceRow]),
          })),
        })),
      })),
    },
  };
});

import { parseLiveSessionsStdout } from './sessions';

describe('live sessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses and validates agent stdout', () => {
    const stdout = JSON.stringify({
      sessions: [
        { sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: 7 },
        { sessionId: 1, username: 'bob', state: 'disconnected', type: 'rdp', helperConnected: false },
      ],
    });
    const sessions = parseLiveSessionsStdout(stdout);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({ sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: 7 });
    expect(sessions[1].idleMinutes).toBeNull();
  });

  it('drops malformed entries instead of failing the request', () => {
    const stdout = JSON.stringify({ sessions: [{ sessionId: 99999999, username: 'x' }, { sessionId: 2, username: 'ok', state: 'active', type: 'console' }] });
    const sessions = parseLiveSessionsStdout(stdout);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(2);
  });

  it('returns [] on unparseable stdout', () => {
    expect(parseLiveSessionsStdout('not-json')).toEqual([]);
    expect(parseLiveSessionsStdout(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/devices/sessions.live.test.ts`
Expected: FAIL — `parseLiveSessionsStdout` is not exported

- [ ] **Step 3: Implement the parser + endpoint**

In `apps/api/src/routes/devices/sessions.ts`, add (imports: `z` from zod, `randomUUID` from `node:crypto`, `sendCommandToAgentAwaitResult` from `../../services/agentCommandAwait`, `devices` schema + `eq`):

```ts
const liveSessionItemSchema = z.object({
  sessionId: z.number().int().min(0).max(65535),
  username: z.string(),
  state: z.string(),
  type: z.string(),
  helperConnected: z.boolean().optional().default(false),
  idleMinutes: z.number().int().min(0).nullable().optional().default(null),
});

export type LiveSessionItem = z.infer<typeof liveSessionItemSchema>;

const LIST_SESSIONS_TIMEOUT_MS = 10_000;

// Exported for tests. Agents return structured command output as a JSON string
// in CommandResult.Stdout; malformed individual entries are dropped, a fully
// malformed payload yields [] (the dialog shows "no sessions" rather than 500).
export function parseLiveSessionsStdout(stdout: string | undefined): LiveSessionItem[] {
  if (!stdout) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = (raw as { sessions?: unknown[] })?.sessions;
  if (!Array.isArray(list)) return [];
  const out: LiveSessionItem[] = [];
  for (const entry of list) {
    const parsed = liveSessionItemSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
```

Then register the route on the same router object, directly below the `GET /:id/sessions/active` handler, with the identical middleware/auth chain that handler uses:

```ts
// Live WTS session enumeration straight from the agent (no DB persistence).
// Used by the RDS session pickers; distinct from /sessions/active, which reads
// the inventoried device_sessions rows and may be minutes stale.
<router>.get('/:id/sessions/live', async (c) => {
  const deviceId = c.req.param('id');

  const [device] = await db
    .select({ id: devices.id, agentId: devices.agentId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return c.json({ error: 'Device not found' }, 404);
  if (!device.agentId) return c.json({ error: 'Device has no enrolled agent' }, 409);

  const awaitResult = await sendCommandToAgentAwaitResult(
    device.agentId,
    { id: `list-sessions-${randomUUID()}`, type: 'list_sessions', payload: {} },
    LIST_SESSIONS_TIMEOUT_MS,
  );

  if (awaitResult.status !== 'completed') {
    const err = awaitResult.error ?? 'agent did not respond';
    return c.json({ error: err }, /timeout/i.test(err) ? 504 : 502);
  }

  return c.json({ data: { deviceId, sessions: parseLiveSessionsStdout(awaitResult.stdout) } });
});
```

(`<router>` = the exported Hono router variable already used by `/:id/sessions/active` in this file — reuse it verbatim, including any `requirePermission` middleware it carries. The `db.select` runs inside the request's org-scoped RLS context, so a cross-tenant device id yields no row → 404.)

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/routes/devices/sessions.live.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/sessions.ts apps/api/src/routes/devices/sessions.live.test.ts
git commit -m "feat(api): GET /devices/:id/sessions/live — synchronous WTS session probe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Broker session-scoped selection + explicit-target disconnected filter

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go` (`FindCapableSession` `:1308-1391`; new `SessionWithScopeInWinSession`; new `isSessionDisconnectedFn` seam)
- Test: `agent/internal/sessionbroker/broker_target_test.go` (new)

**Interfaces:**
- Consumes: `Session{WinSessionID, HelperRole, Scopes/HasScope, Capabilities}`, `betterSession`, `IsSessionDisconnected`, `GetConsoleSessionID`.
- Produces (Tasks 4 and 6/7 consume):
  - `func (b *Broker) SessionWithScopeInWinSession(scope, winSessionID string) *Session` — best connected helper session holding `scope` in exactly that Windows session; nil if none.
  - `FindCapableSession` behavior change: when the caller passes an **explicit** target (non-empty `targetWinSession` argument), pass 1 now skips sessions whose Windows session is disconnected (spec: "Exact-target selection must apply the disconnected-session filter"). Untargeted calls (empty string → console rewrite) are bit-identical.
  - package var `isSessionDisconnectedFn = IsSessionDisconnected` (test seam — `IsSessionDisconnected` makes a WTS syscall).

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/sessionbroker/broker_target_test.go`. Register fake sessions the same way existing `broker.go` tests do (direct insertion into `b.sessions` under `b.mu` — reuse the existing session-fixture helper in the broker tests if one exists; otherwise the minimal literal below, adapted to `Session`'s real field names for scopes/capabilities):

```go
package sessionbroker

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// addTestSession registers a connected helper session directly in broker state.
// Adjust field names to the Session struct if they differ (scopes/capabilities).
func addTestSession(b *Broker, winSession string, role ipc.HelperRole, scopes []string, capabilities []string) *Session {
	s := &Session{
		WinSessionID: winSession,
		HelperRole:   role,
		Scopes:       scopes,
		Capabilities: capabilities,
	}
	b.mu.Lock()
	b.sessions[winSession+"/"+string(role)] = s
	b.mu.Unlock()
	return s
}

func TestSessionWithScopeInWinSession(t *testing.T) {
	b := New("scope-target", nil)
	other := addTestSession(b, "2", ipc.HelperRoleUser, []string{"notify", "consent_ui_fallback"}, nil)
	want := addTestSession(b, "3", ipc.HelperRoleUser, []string{"notify", "consent_ui_fallback"}, nil)

	if got := b.SessionWithScopeInWinSession("consent_ui_fallback", "3"); got != want {
		t.Fatalf("expected session in win session 3, got %+v", got)
	}
	if got := b.SessionWithScopeInWinSession("consent_ui_fallback", "9"); got != nil {
		t.Fatalf("expected nil for absent session, got %+v", got)
	}
	if got := b.SessionWithScopeInWinSession("pam", "2"); got != nil {
		t.Fatalf("expected nil for scope not held, got %+v", got)
	}
	_ = other
}

func TestFindCapableSessionExplicitTargetSkipsDisconnected(t *testing.T) {
	old := isSessionDisconnectedFn
	isSessionDisconnectedFn = func(winSessionID string) bool { return winSessionID == "3" }
	defer func() { isSessionDisconnectedFn = old }()

	b := New("target-disconnected", nil)
	addTestSession(b, "3", ipc.HelperRoleSystem, []string{"desktop"}, []string{"capture"})

	// Explicit target in a disconnected session: pass 1 must now reject it.
	if got := b.FindCapableSession("capture", "3"); got != nil {
		t.Fatalf("explicit target in disconnected session must not match, got %+v", got)
	}
}

func TestFindCapableSessionUntargetedUnchanged(t *testing.T) {
	old := isSessionDisconnectedFn
	isSessionDisconnectedFn = func(string) bool { return false }
	defer func() { isSessionDisconnectedFn = old }()

	b := New("untargeted", nil)
	console := GetConsoleSessionID()
	want := addTestSession(b, console, ipc.HelperRoleSystem, []string{"desktop"}, []string{"capture"})

	if got := b.FindCapableSession("capture", ""); got != want {
		t.Fatalf("untargeted lookup must still resolve console, got %+v", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestSessionWithScopeInWinSession|TestFindCapableSession' -v`
Expected: FAIL — `undefined: isSessionDisconnectedFn`, `undefined: (*Broker).SessionWithScopeInWinSession` (the two new tests; `TestFindCapableSessionUntargetedUnchanged` also fails to compile for the same reason)

- [ ] **Step 3: Implement**

In `agent/internal/sessionbroker/broker.go`:

Add near `IsSessionDisconnected`'s use site:

```go
// isSessionDisconnectedFn is swappable in tests; IsSessionDisconnected makes a
// live WTS syscall.
var isSessionDisconnectedFn = IsSessionDisconnected
```

Add the session-scoped selector next to `PreferredSessionWithScope` (`:953`):

```go
// SessionWithScopeInWinSession returns the best connected helper session in
// exactly the given Windows session that holds the scope. Unlike
// PreferredSessionWithScope this never falls back to another session — it is
// the routing primitive for per-session consent/notify/banner delivery on
// multi-session hosts (the user being shadowed must be the one who sees the
// prompt).
func (b *Broker) SessionWithScopeInWinSession(scope, winSessionID string) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()

	var best *Session
	for _, s := range b.sessions {
		if s.WinSessionID != winSessionID || !s.HasScope(scope) {
			continue
		}
		if betterSession(s, best) {
			best = s
		}
	}
	return best
}
```

In `FindCapableSession` (`:1318-1391`): capture explicitness **before** the console rewrite at `:1327-1329`, and apply the disconnected filter in pass 1 only for explicit targets. Replace the two touched fragments:

```go
	explicitTarget := targetWinSession != "" && targetWinSession != "0"
	if targetWinSession == "" || targetWinSession == "0" {
		targetWinSession = GetConsoleSessionID()
	}
```

and in the first pass (`:1356-1361`):

```go
	// First pass: find a capable session in the target (console) session.
	// An explicitly-targeted session that is disconnected has no input desktop
	// to capture — reject it here so the caller fails with a clear reason
	// instead of answering with a black stream.
	for _, s := range sessions {
		if s.WinSessionID != targetWinSession {
			continue
		}
		if explicitTarget && isSessionDisconnectedFn(s.WinSessionID) {
			continue
		}
		if hasCapability(s) {
			if betterSession(s, best) {
				best = s
			}
		}
	}
```

Also switch the existing pass-2 `IsSessionDisconnected(...)` call (`:1386`) to `isSessionDisconnectedFn(...)` so both passes share the seam.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/sessionbroker/ && cd agent && GOOS=windows go build ./...`
Expected: PASS — including all pre-existing `FindCapableSession` tests (untargeted behavior unchanged; if an existing test passes an explicit target with the real syscall in play, it runs off-Windows where `IsSessionDisconnected` returns its non-Windows default — verify none regress).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_target_test.go
git commit -m "feat(agent): session-scoped scope lookup; explicit-target selection rejects disconnected sessions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Consent / notify / banner routing to the target session (agent)

**Files:**
- Modify: `agent/internal/heartbeat/consent_gate.go` (`requestConsent :85`, `consentUISession :133-141`, `sendSessionNotify :160-179`, `sendBannerShow :184-201`, `sendBannerHide :205`)
- Modify: `agent/internal/heartbeat/handlers_desktop.go` (`handleStartDesktop` consent block `:164-196`; the stop-path banner/notify call sites — grep `sendBannerHide|sendSessionNotify|sendBannerShow` in `agent/internal/heartbeat/` and thread the new argument at every call site)
- Modify: `agent/internal/heartbeat/heartbeat.go` (new `desktopTargets` map + accessors)
- Test: `agent/internal/heartbeat/consent_gate_test.go` (extend)

**Interfaces:**
- Consumes: `Broker.SessionWithScopeInWinSession` (Task 3), `Broker.PreferredSessionWithScope`, `ipc.ScopeConsentUI` (`"consent_ui"`, assist-role only), `ipc.ScopeConsentUIFallback` (`"consent_ui_fallback"`, user-role helpers that advertised `SupportsConsentUI` at auth — `broker.go:2505-2513`).
- Produces (Task 6 consumes):
  - `func (h *Heartbeat) sessionWithScopeForTarget(scope, targetWinSession string) *sessionbroker.Session` — `""` target = legacy machine-global `PreferredSessionWithScope`; non-empty = strict session-scoped.
  - `func (h *Heartbeat) consentUISessionForTarget(targetWinSession string) *sessionbroker.Session`
  - `requestConsent(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string)`, `sendSessionNotify(..., targetWinSession string)`, `sendBannerShow(..., targetWinSession string)`, `sendBannerHide(..., targetWinSession string)` — same behavior as today when `targetWinSession == ""`.
  - `h.desktopTargets map[string]string` (remote session id → target Windows session, guarded by `h.mu`), with `setDesktopTarget`/`takeDesktopTarget` helpers, so the stop path can route the banner-hide/end-notify to the right session.

The defect being fixed: `consentUISession` and the notify/banner senders use machine-global `PreferredSessionWithScope`, so on a multi-session host the prompt/banner can land in a *different user's* session than the one being shadowed. Behavior with no explicit target is unchanged (workstations stay bit-identical).

- [ ] **Step 1: Write the failing tests**

Extend `agent/internal/heartbeat/consent_gate_test.go` (follow its existing conventions for constructing a `Heartbeat` with a real `sessionbroker.Broker`; reuse Task 3's session-registration approach — if that helper lives in package `sessionbroker` tests, duplicate the minimal fixture locally here):

```go
func TestConsentUISessionForTarget(t *testing.T) {
	b := sessionbroker.New("consent-target", nil)
	h := &Heartbeat{sessionBroker: b}

	// user helper with native-dialog fallback in win session 3, another in 5
	s3 := registerConsentTestSession(t, b, "3", ipc.HelperRoleUser, []string{"notify", ipc.ScopeConsentUIFallback})
	s5 := registerConsentTestSession(t, b, "5", ipc.HelperRoleUser, []string{"notify", ipc.ScopeConsentUIFallback})

	if got := h.consentUISessionForTarget("3"); got != s3 {
		t.Fatalf("target 3 must resolve session 3's helper, got %+v", got)
	}
	if got := h.consentUISessionForTarget("5"); got != s5 {
		t.Fatalf("target 5 must resolve session 5's helper, got %+v", got)
	}
	// Strictness: target with no consent-capable helper => nil (never another session's UI)
	if got := h.consentUISessionForTarget("9"); got != nil {
		t.Fatalf("target 9 has no helper; must be nil, got %+v", got)
	}
	// Legacy: empty target falls back to the machine-global preference
	if got := h.consentUISessionForTarget(""); got == nil {
		t.Fatalf("empty target must keep legacy global selection")
	}
}
```

Add `registerConsentTestSession` as a small local fixture mirroring the Task 3 helper (register a `*sessionbroker.Session` with the given scopes in the broker). If broker internals aren't reachable from package `heartbeat`, add an exported test hook in `sessionbroker` guarded for tests — `func (b *Broker) RegisterSessionForTest(s *Session, key string)` in a `_test`-only file is NOT possible cross-package, so instead add `export_test.go`-style registration in `sessionbroker` only if needed; prefer whatever mechanism `heartbeat` tests already use to fake broker sessions (`handlers_desktop_helper` tests use the `helperFinder` seam — check first).

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestConsentUISessionForTarget -v`
Expected: FAIL — `undefined: (*Heartbeat).consentUISessionForTarget`

- [ ] **Step 3: Implement routing**

In `agent/internal/heartbeat/consent_gate.go`:

```go
// sessionWithScopeForTarget resolves the helper session that should present
// user-facing UI for an operation. An empty target keeps the legacy
// machine-global selection (workstations, untargeted connects). A non-empty
// target is strict: UI must land in that Windows session or nowhere —
// falling back to another session would show the prompt to the wrong user.
func (h *Heartbeat) sessionWithScopeForTarget(scope, targetWinSession string) *sessionbroker.Session {
	if targetWinSession == "" {
		return h.sessionBroker.PreferredSessionWithScope(scope)
	}
	return h.sessionBroker.SessionWithScopeInWinSession(scope, targetWinSession)
}

func (h *Heartbeat) consentUISessionForTarget(targetWinSession string) *sessionbroker.Session {
	if s := h.sessionWithScopeForTarget(ipc.ScopeConsentUI, targetWinSession); s != nil {
		return s
	}
	return h.sessionWithScopeForTarget(ipc.ScopeConsentUIFallback, targetWinSession)
}
```

Then thread the parameter:
- `requestConsent(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string)`: replace `session := h.consentUISession()` with `session := h.consentUISessionForTarget(targetWinSession)`. Delete the now-unused `consentUISession` (or keep it as a one-line delegate to `consentUISessionForTarget("")` if other callers exist — grep first).
- `sendSessionNotify(..., targetWinSession string)`: replace its `PreferredSessionWithScope("notify")` with `h.sessionWithScopeForTarget("notify", targetWinSession)`.
- `sendBannerShow(..., targetWinSession string)` / `sendBannerHide(..., targetWinSession string)`: same substitution.

In `agent/internal/heartbeat/heartbeat.go` add the per-session target registry (near the other `h.mu`-guarded maps):

```go
	// desktopTargets maps remote desktop session id -> explicitly targeted
	// Windows session ("" for untargeted/legacy connects) so the stop path can
	// route the banner-hide and end-of-session notify to the same user who saw
	// the consent prompt. Guarded by h.mu.
	desktopTargets map[string]string
```

(initialize in the `Heartbeat` constructor alongside the other maps), plus:

```go
func (h *Heartbeat) setDesktopTarget(sessionID, targetWinSession string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.desktopTargets == nil {
		h.desktopTargets = make(map[string]string)
	}
	h.desktopTargets[sessionID] = targetWinSession
}

// takeDesktopTarget returns and clears the recorded target for a session.
func (h *Heartbeat) takeDesktopTarget(sessionID string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.desktopTargets[sessionID]
	delete(h.desktopTargets, sessionID)
	return t
}
```

In `handleStartDesktop` (`handlers_desktop.go:164-196`): parse the target **before** the consent gate and record it:

```go
	targetSession := ""
	if ts, ok := cmd.Payload["targetSessionId"].(float64); ok {
		targetSession = strconv.Itoa(int(ts))
	}
	h.setDesktopTarget(sessionID, targetSession)

	prompt := parseDesktopPrompt(cmd.Payload)
	if prompt != nil && prompt.Mode == "consent" {
		verdict, helperPresent, timedOut := h.requestConsent(sessionID, prompt, targetSession)
		...
	}
```

Every other call site found by the grep in the Files list gets the argument: start-path `sendSessionNotify`/`sendBannerShow` pass `targetSession`; stop-path `sendBannerHide`/end-notify pass `h.takeDesktopTarget(sessionID)`. Failure returns inside `handleStartDesktop` (consent denied, helper start failed) must also clear the entry via `h.takeDesktopTarget(sessionID)`.

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./internal/heartbeat/... && GOOS=windows go build ./...`
Expected: PASS — existing consent tests updated only mechanically (extra `""` argument at legacy call sites in tests).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/consent_gate.go agent/internal/heartbeat/consent_gate_test.go agent/internal/heartbeat/handlers_desktop.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): route consent prompt, notify, and banner to the targeted Windows session

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Capture probe fails on nil-frame instead of black-streaming

**Files:**
- Create: `agent/internal/remote/desktop/probe.go`
- Create: `agent/internal/remote/desktop/probe_test.go`
- Modify: `agent/internal/remote/desktop/session_webrtc.go:267-285` (probe block)
- Modify: `agent/internal/remote/desktop/capture_windows_nocgo.go:276` (comment only)

**Interfaces:**
- Consumes: capturer `Capture() (*image.RGBA, error)` — the GDI fallback deliberately returns `(nil, nil)` for transient failures (`capture_windows_nocgo.go:276-305`), which today slips through the probe's `probeErr == nil && probeImg != nil` / `probeErr != nil` branches (`session_webrtc.go:268-280`) and lets a session start that streams black frames.
- Produces: `func probeCapture(capture func() (*image.RGBA, error), attempts int, delay time.Duration) (*image.RGBA, error)` — retries nil-frame results (secure-desktop transitions get a grace window), returns an error if no frame after `attempts`; hard errors propagate immediately.

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/remote/desktop/probe_test.go`:

```go
package desktop

import (
	"errors"
	"image"
	"testing"
	"time"
)

func TestProbeCaptureFirstFrame(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	got, err := probeCapture(func() (*image.RGBA, error) { return img, nil }, 3, time.Millisecond)
	if err != nil || got != img {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestProbeCaptureRetriesNilFrame(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	calls := 0
	got, err := probeCapture(func() (*image.RGBA, error) {
		calls++
		if calls < 3 {
			return nil, nil // GDI transient: no frame, no error
		}
		return img, nil
	}, 5, time.Millisecond)
	if err != nil || got != img || calls != 3 {
		t.Fatalf("got %v err %v calls %d", got, err, calls)
	}
}

func TestProbeCaptureNilFrameExhausted(t *testing.T) {
	got, err := probeCapture(func() (*image.RGBA, error) { return nil, nil }, 4, time.Millisecond)
	if got != nil || err == nil {
		t.Fatalf("exhausted nil-frame probe must error, got %v err %v", got, err)
	}
}

func TestProbeCaptureHardErrorImmediate(t *testing.T) {
	sentinel := errors.New("boom")
	calls := 0
	_, err := probeCapture(func() (*image.RGBA, error) { calls++; return nil, sentinel }, 5, time.Millisecond)
	if !errors.Is(err, sentinel) || calls != 1 {
		t.Fatalf("hard error must propagate on first call, err %v calls %d", err, calls)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test -race ./internal/remote/desktop/ -run TestProbeCapture -v`
Expected: FAIL — `undefined: probeCapture`

- [ ] **Step 3: Implement**

Create `agent/internal/remote/desktop/probe.go`:

```go
package desktop

import (
	"fmt"
	"image"
	"time"
)

// probeCapture validates that a capturer can actually produce a frame before
// a WebRTC answer is returned. The GDI fallback reports transient failures as
// (nil, nil) — "no frame yet" — which the streaming loop tolerates, but the
// startup probe must not: a session in a non-capturable Windows session (e.g.
// no input desktop) would otherwise start and stream black. Nil-frame results
// are retried with a short delay to ride out secure-desktop transitions; a
// hard error fails immediately.
func probeCapture(capture func() (*image.RGBA, error), attempts int, delay time.Duration) (*image.RGBA, error) {
	for i := 0; i < attempts; i++ {
		if i > 0 {
			time.Sleep(delay)
		}
		img, err := capture()
		if err != nil {
			return nil, err
		}
		if img != nil {
			return img, nil
		}
	}
	return nil, fmt.Errorf("screen capture produced no frame after %d attempts (session may have no capturable desktop)", attempts)
}
```

In `session_webrtc.go:267-285`, replace the probe block:

```go
	probeStart := time.Now()
	probeImg, probeErr := probeCapture(capturer.Capture, 5, 200*time.Millisecond)
	if probeErr != nil {
		// The display is inaccessible (disconnected Windows session, no input
		// desktop, GDI handle churn). Abort instead of returning a WebRTC
		// answer that will stream zero frames. The defer at line 80 calls
		// StopSession which closes the capturer.
		return "", fmt.Errorf("screen capture failed (display may be unavailable): %w", probeErr)
	}
	pw, ph := probeImg.Rect.Dx(), probeImg.Rect.Dy()
	if pw != w || ph != h {
		slog.Info("Capture probe: actual dimensions differ from GetScreenBounds", "boundsW", w, "boundsH", h, "probeW", pw, "probeH", ph)
		w, h = pw, ph
	}
	captureImagePool.Put(probeImg)
```

(keep the existing "probe capture done" log line after this block). In `capture_windows_nocgo.go:276`, extend the comment above `return nil, nil` with: `// The startup probe (probeCapture) retries then fails on persistent nil frames.`

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./internal/remote/desktop/... && GOOS=windows go build ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/probe.go agent/internal/remote/desktop/probe_test.go agent/internal/remote/desktop/session_webrtc.go agent/internal/remote/desktop/capture_windows_nocgo.go
git commit -m "fix(agent): capture probe fails closed on persistent nil frames instead of streaming black

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Desktop on-demand lease wiring + strict target semantics

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (`helperLifecycleController` interface `:168-172`; new `lifecycleMode()`; `desktopLeases` map)
- Create: `agent/internal/heartbeat/handlers_desktop_lease.go`
- Create: `agent/internal/heartbeat/handlers_desktop_lease_test.go`
- Modify: `agent/internal/heartbeat/handlers_desktop.go` (`handleStartDesktop` — lease acquisition before consent; `handleStopDesktop` — release)
- Modify: `agent/internal/heartbeat/handlers_desktop_helper.go` (`startDesktopViaHelper :98` — mode branch; extract `startDesktopOnSession`)

**Interfaces:**
- Consumes: plan-2 lease API + `WaitForHelperReady` (Global Constraints), Task 4's target registry/consent routing, `Broker.ConsoleSessionID()`, `Broker.HelperSessionByKey`.
- Produces (Task 7 reuses the interface + `lifecycleMode()`):
  - Widened controller interface (any existing test fake implementing it gets mechanical additions):

```go
type helperLifecycleController interface {
	Stop()
	Done() <-chan struct{}
	Mode() string
	AcquireLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error
	RenewLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error
	ReleaseLease(sessionID uint32, role ipc.HelperRole, opID string)
	WaitForHelperReady(ctx context.Context, key sessionbroker.HelperKey) sessionbroker.HelperWaitResult
}
```

  - `func (h *Heartbeat) lifecycleMode() string` — `""` when no lifecycle manager runs (non-Windows / non-service).
  - `func helperWaitFailureMessage(res sessionbroker.HelperWaitResult) string` — typed status → operator-readable message.
  - `desktopLeaseHold{winID uint32, roles []ipc.HelperRole, cancel context.CancelFunc}`; `h.desktopLeases map[string]*desktopLeaseHold` (`h.mu`); `acquireDesktopLeases` / `releaseDesktopLeases`.
  - `func (h *Heartbeat) startDesktopOnSession(session *sessionbroker.Session, sessionID, offer string, iceServers []desktop.ICEServerConfig, displayIndex int, policy desktop.SessionPolicy, payload map[string]any) tools.CommandResult` — the extracted per-attempt body of today's retry loop, shared by both paths.

**Behavior spec:**
- On-demand mode, `handleStartDesktop`, before the consent gate: default an empty target to the console session; acquire a `system`-role lease (opID `"desk-"+sessionID`, TTL 5m) — and a `user`-role lease too when a prompt is configured (`prompt != nil && prompt.Mode != "off"`), because the consent dialog / banner render through the target session's user helper. Wait up to 30s for the user helper before prompting (not-ready ⇒ `helperPresent=false` ⇒ existing `consentUnavailableBehavior` semantics decide). Consent denied ⇒ release leases, return the existing denied result.
- On-demand mode, `startDesktopViaHelper`: bypass the legacy find-or-spawn/10s-poll path entirely; `WaitForHelperReady` (ctx 95s) on the `system` key; non-ready ⇒ typed error message (never a bare timeout); ready ⇒ `startDesktopOnSession`, then start a renewal goroutine (60s ticker, renew all held roles with 5m TTL; stop when ctx cancelled or the system-role helper session has vanished on two consecutive ticks — covers stream death without `stop_desktop`; the 2m lease linger + TTL then reap the helper).
- `handleStopDesktop`: `releaseDesktopLeases(sessionID)` (cancels renewal, releases all held roles). Also released on any failure return after acquisition.
- **#434 strict-by-mode:** the on-demand path never falls back to another session — `session-gone` surfaces as `"target session has ended"`. Workstation/always-on keeps today's `findActiveHelper` fallback bit-identical.
- Always-on hosts with an explicit target keep today's behavior entirely (strictness is mode-gated; an RDS host forced to `always-on` opted out of on-demand semantics).

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/heartbeat/handlers_desktop_lease_test.go` with a scripted fake controller:

```go
package heartbeat

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type fakeLifecycle struct {
	mode        string
	acquired    []sessionbroker.HelperKey
	released    []sessionbroker.HelperKey
	renewed     int
	waitResults map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult
	acquireErr  error
}

func (f *fakeLifecycle) Stop()                {}
func (f *fakeLifecycle) Done() <-chan struct{} { return nil }
func (f *fakeLifecycle) Mode() string          { return f.mode }
func (f *fakeLifecycle) AcquireLease(id uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	if f.acquireErr != nil {
		return f.acquireErr
	}
	f.acquired = append(f.acquired, sessionbroker.HelperKey{WindowsSessionID: id, Role: role})
	return nil
}
func (f *fakeLifecycle) RenewLease(id uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	f.renewed++
	return nil
}
func (f *fakeLifecycle) ReleaseLease(id uint32, role ipc.HelperRole, opID string) {
	f.released = append(f.released, sessionbroker.HelperKey{WindowsSessionID: id, Role: role})
}
func (f *fakeLifecycle) WaitForHelperReady(ctx context.Context, key sessionbroker.HelperKey) sessionbroker.HelperWaitResult {
	if r, ok := f.waitResults[key]; ok {
		return r
	}
	return sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitTimeout}
}

func TestHelperWaitFailureMessage(t *testing.T) {
	tests := []struct {
		res  sessionbroker.HelperWaitResult
		want string
	}{
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: 7 * time.Minute}, "helper is in crash cooldown; retry in 7m0s"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitSessionGone}, "target session has ended"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitRetriesExhausted}, "helper failed to start after repeated attempts"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitSpawnerUnavailable}, "helper spawning is unavailable on this host"},
		{sessionbroker.HelperWaitResult{Status: sessionbroker.HelperWaitTimeout}, "helper did not become ready in time"},
	}
	for _, tt := range tests {
		if got := helperWaitFailureMessage(tt.res); got != tt.want {
			t.Errorf("status %s: got %q want %q", tt.res.Status, got, tt.want)
		}
	}
}

func TestAcquireDesktopLeasesRolesAndRelease(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{helperLifecycle: f}

	// prompt configured => system + user roles
	if res := h.acquireDesktopLeases("sess-1", 3, true); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	if len(f.acquired) != 2 {
		t.Fatalf("expected system+user leases, got %+v", f.acquired)
	}
	h.releaseDesktopLeases("sess-1")
	if len(f.released) != 2 {
		t.Fatalf("expected both roles released, got %+v", f.released)
	}

	// no prompt => system only
	f.acquired = nil
	if res := h.acquireDesktopLeases("sess-2", 4, false); res != nil {
		t.Fatalf("acquire failed: %+v", res)
	}
	if len(f.acquired) != 1 || f.acquired[0].Role != ipc.HelperRoleSystem {
		t.Fatalf("expected system-only lease, got %+v", f.acquired)
	}
	h.releaseDesktopLeases("sess-2")
}

func TestAcquireDesktopLeasesSessionGone(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand", acquireErr: sessionbroker.ErrLeaseSessionNotFound}
	h := &Heartbeat{helperLifecycle: f}
	res := h.acquireDesktopLeases("sess-1", 3, false)
	if res == nil || res.Status != "failed" {
		t.Fatalf("expected failed result, got %+v", res)
	}
}
```

(`acquireDesktopLeases` returning `*tools.CommandResult` — nil on success, a populated failure result otherwise — keeps the handler code linear.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestHelperWaitFailureMessage|TestAcquireDesktopLeases' -v`
Expected: FAIL — undefined symbols

- [ ] **Step 3: Widen the controller interface + add `lifecycleMode()`**

In `agent/internal/heartbeat/heartbeat.go`, replace the interface at `:168-172` with the widened one from the Interfaces block above (imports: `context`, `time`, `sessionbroker`, `ipc`). Add:

```go
// lifecycleMode returns the resolved helper lifecycle mode, or "" when no
// lifecycle manager runs (non-Windows, non-service). "on-demand" gates every
// RDS-specific behavior in the command handlers.
func (h *Heartbeat) lifecycleMode() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.helperLifecycle == nil {
		return ""
	}
	return h.helperLifecycle.Mode()
}
```

`*sessionbroker.HelperLifecycleManager` already satisfies the widened interface (the four new methods are plan-2 exports). Update any test fake implementing `helperLifecycleController` mechanically.

- [ ] **Step 4: Implement the lease-hold machinery**

Create `agent/internal/heartbeat/handlers_desktop_lease.go`:

```go
package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

const (
	desktopLeaseTTL        = 5 * time.Minute
	desktopLeaseRenewEvery = time.Minute
	helperReadyBudget      = 95 * time.Second // lifecycle startup timeout (90s) + margin
	consentHelperWait      = 30 * time.Second
)

type desktopLeaseHold struct {
	winID  uint32
	roles  []ipc.HelperRole
	cancel context.CancelFunc // stops the renewal goroutine; nil until renewal starts
}

func desktopLeaseOpID(sessionID string) string { return "desk-" + sessionID }

// helperWaitFailureMessage maps a typed wait result to the operator-facing
// error. Never a bare timeout string without a reason.
func helperWaitFailureMessage(res sessionbroker.HelperWaitResult) string {
	switch res.Status {
	case sessionbroker.HelperWaitFatalCooldown:
		return fmt.Sprintf("helper is in crash cooldown; retry in %s", res.RetryAfter.Round(time.Second))
	case sessionbroker.HelperWaitRetriesExhausted:
		return "helper failed to start after repeated attempts"
	case sessionbroker.HelperWaitSessionGone:
		return "target session has ended"
	case sessionbroker.HelperWaitSpawnerUnavailable:
		return "helper spawning is unavailable on this host"
	case sessionbroker.HelperWaitTimeout:
		return "helper did not become ready in time"
	}
	return "helper unavailable"
}

// acquireDesktopLeases takes the on-demand leases for a desktop connect:
// always the system role (capture); additionally the user role when a
// prompt/banner is configured, since consent UI renders through the target
// session's user helper. Returns nil on success or a ready-to-return failure
// CommandResult.
func (h *Heartbeat) acquireDesktopLeases(sessionID string, winID uint32, wantConsentUI bool) *tools.CommandResult {
	roles := []ipc.HelperRole{ipc.HelperRoleSystem}
	if wantConsentUI {
		roles = append(roles, ipc.HelperRoleUser)
	}
	opID := desktopLeaseOpID(sessionID)
	for i, role := range roles {
		if err := h.helperLifecycle.AcquireLease(winID, role, opID, desktopLeaseTTL); err != nil {
			// Roll back any lease taken before the failure.
			for _, taken := range roles[:i] {
				h.helperLifecycle.ReleaseLease(winID, taken, opID)
			}
			msg := fmt.Sprintf("failed to reserve helper for session %d: %v", winID, err)
			if errors.Is(err, sessionbroker.ErrLeaseSessionNotFound) {
				msg = fmt.Sprintf("target session %d no longer exists", winID)
			}
			r := tools.NewErrorResult(errors.New(msg), 0)
			return &r
		}
	}
	h.mu.Lock()
	if h.desktopLeases == nil {
		h.desktopLeases = make(map[string]*desktopLeaseHold)
	}
	h.desktopLeases[sessionID] = &desktopLeaseHold{winID: winID, roles: roles}
	h.mu.Unlock()
	return nil
}

// releaseDesktopLeases stops renewal and releases every role held for the
// remote session. Safe to call when nothing is held.
func (h *Heartbeat) releaseDesktopLeases(sessionID string) {
	h.mu.Lock()
	hold := h.desktopLeases[sessionID]
	delete(h.desktopLeases, sessionID)
	lc := h.helperLifecycle
	h.mu.Unlock()
	if hold == nil || lc == nil {
		return
	}
	if hold.cancel != nil {
		hold.cancel()
	}
	for _, role := range hold.roles {
		lc.ReleaseLease(hold.winID, role, desktopLeaseOpID(sessionID))
	}
}

// startDesktopLeaseRenewal keeps the desktop leases alive for the stream's
// lifetime. It stops itself when the system-role helper session has vanished
// on two consecutive ticks (stream died without a stop_desktop); the lease TTL
// + linger then reap the helper.
func (h *Heartbeat) startDesktopLeaseRenewal(sessionID string) {
	h.mu.Lock()
	hold := h.desktopLeases[sessionID]
	lc := h.helperLifecycle
	broker := h.sessionBroker
	h.mu.Unlock()
	if hold == nil || lc == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	hold.cancel = cancel

	go func() {
		ticker := time.NewTicker(desktopLeaseRenewEvery)
		defer ticker.Stop()
		gone := 0
		sysKey := sessionbroker.HelperKey{WindowsSessionID: hold.winID, Role: ipc.HelperRoleSystem}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if broker != nil && broker.HelperSessionByKey(sysKey) == nil {
					gone++
					if gone >= 2 {
						return
					}
					continue
				}
				gone = 0
				for _, role := range hold.roles {
					if err := lc.RenewLease(hold.winID, role, desktopLeaseOpID(sessionID), desktopLeaseTTL); err != nil {
						return
					}
				}
			}
		}
	}()
}

// resolveDesktopTargetWinID parses the target session string ("" already
// defaulted to console by the caller) into the lease key form.
func resolveDesktopTargetWinID(targetSession string) (uint32, error) {
	winID, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(targetSession)
	if err != nil {
		return 0, fmt.Errorf("invalid targetSessionId %q: %w", targetSession, err)
	}
	return winID, nil
}
```

(Drop the `strconv` import from this file if unused after wiring — it is needed in `handlers_desktop.go`, not necessarily here.)

Add the `desktopLeases map[string]*desktopLeaseHold` field to the `Heartbeat` struct in `heartbeat.go` next to `desktopTargets` (Task 4).

- [ ] **Step 5: Run the new unit tests**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestHelperWaitFailureMessage|TestAcquireDesktopLeases' -v`
Expected: PASS

- [ ] **Step 6: Wire `handleStartDesktop` / `handleStopDesktop`**

In `handleStartDesktop` (`handlers_desktop.go`), directly after Task 4's `prompt := parseDesktopPrompt(cmd.Payload)` line (the block below reads `prompt`) and before the consent gate:

```go
	onDemand := h.lifecycleMode() == "on-demand"
	if onDemand && h.sessionBroker != nil {
		if targetSession == "" {
			// Legacy callers (no picker) get the console session — at rest an
			// RDS host has zero helpers, so an untargeted connect must still
			// pick a concrete session to lease.
			targetSession = h.sessionBroker.ConsoleSessionID()
			if n, err := strconv.Atoi(targetSession); err == nil {
				cmd.Payload["targetSessionId"] = float64(n) // startDesktopViaHelper re-parses payload
			}
			h.setDesktopTarget(sessionID, targetSession)
		}
		winID, err := resolveDesktopTargetWinID(targetSession)
		if err != nil {
			h.takeDesktopTarget(sessionID)
			return tools.NewErrorResult(err, time.Since(start).Milliseconds())
		}
		wantConsentUI := prompt != nil && prompt.Mode != "off"
		if failure := h.acquireDesktopLeases(sessionID, winID, wantConsentUI); failure != nil {
			h.takeDesktopTarget(sessionID)
			return *failure
		}
		if wantConsentUI {
			// Give the user-role helper a bounded head start so the consent
			// dialog can render in-session; not-ready degrades to the
			// policy's consentUnavailableBehavior (helperPresent=false).
			waitCtx, cancelWait := context.WithTimeout(context.Background(), consentHelperWait)
			res := h.helperLifecycle.WaitForHelperReady(waitCtx, sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleUser})
			cancelWait()
			if res.Status != sessionbroker.HelperWaitReady {
				log.Warn("consent helper not ready in target session", "sessionId", sessionID, "target", targetSession, "status", string(res.Status))
			}
		}
	}
```

In the consent-denied return path add `h.releaseDesktopLeases(sessionID)` before returning; same for any error return between acquisition and the successful start. In `handleStopDesktop`, add at the top:

```go
	h.releaseDesktopLeases(sessionID)
```

(before the existing stop logic; `takeDesktopTarget` is already consumed there by Task 4's banner-hide routing).

- [ ] **Step 7: Mode-branch `startDesktopViaHelper` + extract `startDesktopOnSession`**

In `handlers_desktop_helper.go`: extract the body of the existing retry loop (`:150-190` — everything from resolving `session` through forwarding the offer and returning the success/failure result for that attempt) into:

```go
func (h *Heartbeat) startDesktopOnSession(session *sessionbroker.Session, sessionID, offer string, iceServers []desktop.ICEServerConfig, displayIndex int, policy desktop.SessionPolicy, payload map[string]any) tools.CommandResult
```

so the legacy loop becomes `session := h.helperSessionForTarget(targetSession); if session == nil {...}; result := h.startDesktopOnSession(...)` with retry semantics unchanged (existing tests must pass unmodified). Then add the mode branch right after the `targetSession` parse at `:111-115`:

```go
	if h.lifecycleMode() == "on-demand" {
		winID, err := resolveDesktopTargetWinID(targetSession)
		if err != nil {
			return tools.NewErrorResult(err, 0)
		}
		waitCtx, cancelWait := context.WithTimeout(context.Background(), helperReadyBudget)
		res := h.helperLifecycle.WaitForHelperReady(waitCtx, sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleSystem})
		cancelWait()
		if res.Status != sessionbroker.HelperWaitReady {
			// Strict by design (#434): an explicit target on an RDS host never
			// falls back to another session — surface the typed reason.
			return tools.NewErrorResult(errors.New(helperWaitFailureMessage(res)), 0)
		}
		result := h.startDesktopOnSession(res.Session, sessionID, offer, iceServers, displayIndex, policy, payload)
		if result.Status != "failed" {
			h.startDesktopLeaseRenewal(sessionID)
		} else {
			h.releaseDesktopLeases(sessionID)
			h.takeDesktopTarget(sessionID)
		}
		return result
	}
	// legacy always-on path below, unchanged
```

(On the on-demand path `targetSession` is never empty — `handleStartDesktop` defaulted it to console and wrote it back into the payload.)

- [ ] **Step 8: Full package tests + cross-compile**

Run: `cd agent && go test -race ./internal/heartbeat/... ./internal/sessionbroker/... && GOOS=windows go build ./...`
Expected: PASS — legacy-path desktop tests unmodified (fakes for `helperLifecycleController` updated mechanically only).

- [ ] **Step 9: Commit**

```bash
git add agent/internal/heartbeat/
git commit -m "feat(agent): desktop connects drive on-demand leases with typed wait failures and strict targeting

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Script session targeting (agent)

**Files:**
- Modify: `agent/internal/heartbeat/handlers_script.go` (`handleScript :23`, `resolveRunAsSession :103-119`, the runAs=user fail-fast block `:52-79`)
- Test: `agent/internal/heartbeat/handlers_script_test.go` (extend — `:219` pins the current fail-fast message)

**Interfaces:**
- Consumes: Task 6's widened `helperLifecycleController` + `lifecycleMode()` + `helperWaitFailureMessage`; `Broker.FindUserSession(winSessionID string) *Session` (`broker.go:1427` — currently has zero non-test callers); `executeViaUserHelper(session, cmd, timeout)` (`handlers_script.go:218`); `sessionbroker.NewSessionDetector()`.
- Produces:
  - Script command payload accepts `targetSessionId` (number). Routing rules (spec): explicit target → that session's `user`-role helper (lease-spawned in on-demand mode, direct lookup in always-on); `runAs=user` with no target in on-demand mode → error naming the eligible sessions; no target on a workstation → today's console behavior, bit-identical.
  - `func (h *Heartbeat) executeScriptInSession(cmd Command, script executor.ScriptExecution, winID uint32, start time.Time) tools.CommandResult`
  - `func eligibleSessionsSummary() string` — e.g. `"1:console-user(active), 3:alice(disconnected)"`, `"none"` when empty, `"unknown"` on detector error.

Phase 0 note (confirmed by code read): the existing fail-fast at `:64-70` is an **inline untyped** `tools.CommandResult` — it does not name sessions. This task upgrades the message only in on-demand mode; the workstation message stays byte-identical (pinned by `handlers_script_test.go:219`).

- [ ] **Step 1: Write the failing tests**

Extend `agent/internal/heartbeat/handlers_script_test.go` (reuse the `fakeLifecycle` from Task 6's test file — same package):

```go
func TestHandleScriptOnDemandRunAsUserWithoutTargetNamesEligibleSessions(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand"}
	h := newScriptTestHeartbeat(t) // reuse/extend the existing test constructor in this file
	h.helperLifecycle = f

	res := handleScript(h, Command{
		ID:      "cmd-1",
		Payload: map[string]any{"content": "whoami", "language": "powershell", "runAs": "user"},
	})
	if res.Status != "failed" {
		t.Fatalf("expected failure, got %+v", res)
	}
	if !strings.Contains(res.Error, "targetSessionId") {
		t.Errorf("on-demand error must direct the caller to session targeting, got %q", res.Error)
	}
}

func TestHandleScriptTargetSessionNotFoundOnDemand(t *testing.T) {
	f := &fakeLifecycle{mode: "on-demand", acquireErr: sessionbroker.ErrLeaseSessionNotFound}
	h := newScriptTestHeartbeat(t)
	h.helperLifecycle = f

	res := handleScript(h, Command{
		ID:      "cmd-2",
		Payload: map[string]any{"content": "whoami", "language": "powershell", "runAs": "user", "targetSessionId": float64(7)},
	})
	if res.Status != "failed" || !strings.Contains(res.Error, "no longer exists") {
		t.Fatalf("expected session-gone failure, got %+v", res)
	}
	if len(f.released) != 0 {
		t.Errorf("nothing to release when acquire failed, got %+v", f.released)
	}
}

func TestHandleScriptTargetWaitFailureTyped(t *testing.T) {
	key := sessionbroker.HelperKey{WindowsSessionID: 7, Role: ipc.HelperRoleUser}
	f := &fakeLifecycle{
		mode:        "on-demand",
		waitResults: map[sessionbroker.HelperKey]sessionbroker.HelperWaitResult{key: {Status: sessionbroker.HelperWaitFatalCooldown, RetryAfter: 3 * time.Minute}},
	}
	h := newScriptTestHeartbeat(t)
	h.helperLifecycle = f

	res := handleScript(h, Command{
		ID:      "cmd-3",
		Payload: map[string]any{"content": "whoami", "language": "powershell", "runAs": "user", "targetSessionId": float64(7)},
	})
	if res.Status != "failed" || !strings.Contains(res.Error, "crash cooldown") {
		t.Fatalf("expected typed cooldown failure, got %+v", res)
	}
	// lease must be released after the failed wait
	if len(f.acquired) != 1 || len(f.released) != 1 {
		t.Errorf("expected acquire+release, got acquired=%v released=%v", f.acquired, f.released)
	}
}

func TestHandleScriptWorkstationBehaviorUnchanged(t *testing.T) {
	// No lifecycle manager (workstation / non-service): the pinned legacy
	// message at :219 must be byte-identical — run the existing pinned test
	// unmodified; this case just asserts no panic with a target present but
	// mode empty (target ignored on always-on non-Windows test env is fine;
	// on Windows always-on it resolves via FindUserSession — covered by the
	// broker's own tests).
	h := newScriptTestHeartbeat(t)
	res := handleScript(h, Command{
		ID:      "cmd-4",
		Payload: map[string]any{"content": "whoami", "language": "powershell", "runAs": "user"},
	})
	if res.Status != "failed" {
		t.Fatalf("expected legacy failure, got %+v", res)
	}
}
```

(`newScriptTestHeartbeat` = whatever constructor/fixture the existing tests in this file use to build a `*Heartbeat` with a broker and no connected helpers — reuse it; only add one if none exists.)

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestHandleScript -v`
Expected: new tests FAIL (target payload ignored today; on-demand message absent); existing pinned tests still PASS.

- [ ] **Step 3: Implement**

In `agent/internal/heartbeat/handlers_script.go`:

Parse the target right after the `script` struct is built (`:33`):

```go
	targetSessionID := -1
	if ts, ok := cmd.Payload["targetSessionId"].(float64); ok && ts >= 0 && ts <= 65535 {
		targetSessionID = int(ts)
	}
```

Insert the targeted branch **before** the existing "Phase 3" console-pinned routing (`:52`):

```go
	// Explicit session targeting (RDS phase 1): route to exactly that
	// session's user-role helper. Only meaningful for user-context runs —
	// the API rejects targetSessionId with runAs!=user.
	if targetSessionID >= 0 && runtime.GOOS == "windows" && h.sessionBroker != nil && strings.EqualFold(script.RunAs, "user") {
		return h.executeScriptInSession(cmd, script, uint32(targetSessionID), start)
	}
```

Change the untargeted fail-fast block (`:58-79`) to add the on-demand variant while keeping the workstation string byte-identical:

```go
	if strings.EqualFold(script.RunAs, "user") {
		msg := "runAs=user requires a connected user helper session; no eligible session found (script was not executed)"
		if h.lifecycleMode() == "on-demand" {
			// On an RDS host at rest there are no helpers to find — the
			// caller must target a session. Name the candidates so the tech
			// can retry without a round trip.
			msg = "runAs=user on an RD Session Host requires targetSessionId; eligible sessions: " + eligibleSessionsSummary()
		}
		return tools.CommandResult{
			Status:     "failed",
			ExitCode:   1,
			Error:      msg,
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
```

Add the two new functions at the bottom of the file:

```go
// executeScriptInSession delivers a user-context script to exactly the given
// Windows session's user-role helper. In on-demand mode the helper is
// lease-spawned and the wait failure is typed; in always-on mode the helper
// must already be connected.
func (h *Heartbeat) executeScriptInSession(cmd Command, script executor.ScriptExecution, winID uint32, start time.Time) tools.CommandResult {
	winStr := strconv.FormatUint(uint64(winID), 10)
	fail := func(msg string) tools.CommandResult {
		return tools.CommandResult{Status: "failed", ExitCode: 1, Error: msg, DurationMs: time.Since(start).Milliseconds()}
	}

	if h.lifecycleMode() == "on-demand" {
		ttl := time.Duration(script.Timeout)*time.Second + time.Minute
		if ttl < 5*time.Minute {
			ttl = 5 * time.Minute
		}
		if ttl > 30*time.Minute {
			ttl = 30 * time.Minute
		}
		if err := h.helperLifecycle.AcquireLease(winID, ipc.HelperRoleUser, cmd.ID, ttl); err != nil {
			if errors.Is(err, sessionbroker.ErrLeaseSessionNotFound) {
				return fail(fmt.Sprintf("target session %d no longer exists; eligible sessions: %s", winID, eligibleSessionsSummary()))
			}
			return fail(fmt.Sprintf("failed to reserve helper for session %d: %v", winID, err))
		}
		defer h.helperLifecycle.ReleaseLease(winID, ipc.HelperRoleUser, cmd.ID)

		waitCtx, cancel := context.WithTimeout(context.Background(), helperReadyBudget)
		res := h.helperLifecycle.WaitForHelperReady(waitCtx, sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleUser})
		cancel()
		if res.Status != sessionbroker.HelperWaitReady {
			return fail(fmt.Sprintf("cannot run in session %d: %s", winID, helperWaitFailureMessage(res)))
		}
		return h.executeViaUserHelper(res.Session, cmd, script.Timeout)
	}

	// Always-on (workstation multi-user, or RDS forced always-on): the helper
	// for the target session must already be connected.
	session := h.sessionBroker.FindUserSession(winStr)
	if session == nil {
		return fail(fmt.Sprintf("no user helper connected in session %d; eligible sessions: %s", winID, eligibleSessionsSummary()))
	}
	return h.executeViaUserHelper(session, cmd, script.Timeout)
}

// eligibleSessionsSummary enumerates targetable interactive sessions for
// error messages: "id:username(state), ...".
func eligibleSessionsSummary() string {
	detector := sessionbroker.NewSessionDetector()
	detected, err := detector.ListSessions()
	if err != nil {
		return "unknown"
	}
	var parts []string
	for _, ds := range detected {
		if ds.Type == "services" || ds.Username == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s:%s(%s)", ds.Session, ds.Username, ds.State))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}
```

(Imports to add: `context`, `errors`, `strconv`, `sessionbroker`. `executeViaUserHelper` re-checks the `run_as_user` scope itself at `:221` — no duplicate check needed.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test -race ./internal/heartbeat/... && GOOS=windows go build ./...`
Expected: PASS — including the pinned legacy-message test at `handlers_script_test.go:219`, unmodified.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/handlers_script.go agent/internal/heartbeat/handlers_script_test.go
git commit -m "feat(agent): scripts target a specific session's user helper via leases

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Script `targetSessionId` through the API + web service layer

**Files:**
- Modify: `apps/api/src/routes/scripts.ts:200-208` (`executeScriptSchema`) and the pass-through at `:811-819`
- Modify: `apps/api/src/services/scriptExecution.ts:25-33` (`ExecuteScriptOnDevicesInput`) and the payload literal at `:200-209`
- Modify: `apps/web/src/services/deviceActions.ts:360-382` (`executeScript`)
- Test: `apps/api/src/routes/scripts.execute-schema.test.ts` (new)

**Interfaces:**
- Consumes: agent payload contract from Task 7 (`targetSessionId` number in the script command payload).
- Produces: `POST /scripts/:id/execute` accepts `targetSessionId?: number (int, 0–65535)`, valid **only** with `runAs: 'user'` and **only** with exactly one device; persisted into `device_commands.payload` (the existing insert at `scriptExecution.ts:200` replays payload verbatim at `:225` — no separate wire change needed). Web: `executeScript(scriptId, deviceIds, parameters?, runAs?, targetSessionId?)`. Task 14 consumes the web signature.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/scripts.execute-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { executeScriptSchema } from './scripts';

const base = { deviceIds: ['0b56e4a6-5f2a-4b7e-9c3d-2e8f1a6b7c8d'] };

describe('executeScriptSchema targetSessionId', () => {
  it('accepts a session target with runAs=user on a single device', () => {
    const parsed = executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: 3 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.targetSessionId).toBe(3);
  });

  it('rejects a target without runAs=user', () => {
    expect(executeScriptSchema.safeParse({ ...base, targetSessionId: 3 }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'system', targetSessionId: 3 }).success).toBe(false);
  });

  it('rejects a target across multiple devices (session ids are per-device)', () => {
    const two = { deviceIds: [base.deviceIds[0], '1c67f5b7-6a3b-4c8f-8d4e-3f9a2b7c8d9e'], runAs: 'user', targetSessionId: 3 };
    expect(executeScriptSchema.safeParse(two).success).toBe(false);
  });

  it('rejects out-of-range and non-integer targets', () => {
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: 70000 }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: 1.5 }).success).toBe(false);
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user', targetSessionId: -1 }).success).toBe(false);
  });

  it('still accepts untargeted runs unchanged', () => {
    expect(executeScriptSchema.safeParse({ ...base, runAs: 'user' }).success).toBe(true);
    expect(executeScriptSchema.safeParse(base).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/scripts.execute-schema.test.ts`
Expected: FAIL — `executeScriptSchema` not exported / field unknown (stripped)

- [ ] **Step 3: Implement API side**

In `apps/api/src/routes/scripts.ts`, export and extend the schema (`:200-208`):

```ts
export const executeScriptSchema = z
  .object({
    deviceIds: z.array(z.string().guid()).min(1),
    parameters: z.record(z.string(), z.any()).refine(
      (val) => JSON.stringify(val).length <= 65536,
      { message: 'Object too large (max 64KB)' }
    ).optional(),
    triggerType: z.enum(['manual', 'scheduled', 'alert', 'policy']).optional(),
    runAs: z.enum(['system', 'user']).optional(),
    // Windows session to run the user-context script in (RDS session
    // targeting). Session ids are per-device, hence single-device only.
    // min(1): session 0 is never an interactive session — the agent rejects
    // it with a typed error, but rejecting here saves the round trip
    // (amended during execution after the Task 6 session-0 finding).
    targetSessionId: z.number().int().min(1).max(65535).optional(),
  })
  .refine((d) => d.targetSessionId == null || d.runAs === 'user', {
    message: 'targetSessionId requires runAs=user',
    path: ['targetSessionId'],
  })
  .refine((d) => d.targetSessionId == null || d.deviceIds.length === 1, {
    message: 'targetSessionId requires exactly one device',
    path: ['targetSessionId'],
  });
```

Thread it through the endpoint pass-through at `:811-819` (`targetSessionId: data.targetSessionId,`), then in `apps/api/src/services/scriptExecution.ts`: add `targetSessionId?: number;` to `ExecuteScriptOnDevicesInput` (`:25-33`) and extend the payload literal (`:200-209`):

```ts
        payload: {
          scriptId: input.scriptId,
          executionId: execution.id,
          batchId,
          language: script.language,
          content: script.content,
          parameters,
          timeoutSeconds: script.timeoutSeconds,
          runAs,
          ...(input.targetSessionId != null ? { targetSessionId: input.targetSessionId } : {}),
        },
```

- [ ] **Step 4: Implement the web service call**

In `apps/web/src/services/deviceActions.ts:362-382`:

```ts
export async function executeScript(
  scriptId: string,
  deviceIds: string[],
  parameters?: Record<string, unknown>,
  runAs?: ScriptRunAsOverride,
  targetSessionId?: number
): Promise<ScriptExecuteResult> {
  const body: Record<string, unknown> = { deviceIds };
  if (parameters) body.parameters = parameters;
  if (runAs) body.runAs = runAs;
  if (targetSessionId != null) body.targetSessionId = targetSessionId;
  ...
```

(rest of the function unchanged).

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/api && npx vitest run src/routes/scripts.execute-schema.test.ts && npx tsc --noEmit && cd ../../apps/web && npx tsc --noEmit`
Expected: PASS. (If `scripts.ts` has an existing route test suite, run it too: `npx vitest run src/routes/scripts.test.ts`.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/scripts.ts apps/api/src/routes/scripts.execute-schema.test.ts apps/api/src/services/scriptExecution.ts apps/web/src/services/deviceActions.ts
git commit -m "feat(api,web): script execution accepts a per-device Windows session target

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Helper policy resolver — dual-axis fix + disabled-policy precedence (pre-existing bugs 1 & 2)

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (`resolveDeviceHelperSettings :2418-2497`, `buildHelperConfigUpdate :2513-2545`)
- Test: `apps/api/src/__tests__/integration/helperPolicyResolution.integration.test.ts` (new)

**Interfaces:**
- Consumes: dual-axis reference condition from `resolveEffectiveConfigWithExecutor` (`services/configurationPolicy.ts:1794-1802`); `getOrgHelperSettings` (`agents/helpers.ts:2318`); `HELPER_DEFAULTS` (`:2410`).
- Produces: `export async function resolveDeviceHelperSettings(deviceId: string): Promise<HelperSettings | null>` — **now exported**, and returns `null` when *no* helper feature link matched (previously it returned defaults, making "no policy" indistinguishable from "policy says disabled"). `buildHelperConfigUpdate` falls back to legacy org settings **only** when the resolver returned `null`. Task 11 extends the same resolver with `lifecycleMode`.

**Bug 1 (partner-owned policies never resolve):** the join at `agents/helpers.ts:2474` requires `configurationPolicies.orgId = device.orgId`, but partner-owned policies have `orgId = NULL` — so a partner-wide helper policy is authorable in the UI yet silently never reaches any agent. The partner-level *assignment* targeting already exists (`:2453-2457`); only the ownership filter is wrong.

**Bug 2 (explicit disabled overridden):** `buildHelperConfigUpdate` treats `!settings.enabled` (`:2525`) as "no policy" and falls through to org-level legacy settings, so a policy that *explicitly disables* the helper is overridden by `organizations.settings.helper.enabled=true` — and the fallback also discards the four resolved UI fields (`{ ...HELPER_DEFAULTS, enabled: true }`).

Known & accepted: resolved settings are cached 120s (`helper:settings:device:*`, `:2500-2510`) with **no invalidation on policy edit** — changes land within cache TTL + heartbeat interval. Sibling resolvers in this file have the identical org-only bug (event_log `:1797`, monitoring `:1986`, pam `:2626`, patch_source `:2797`) — **out of scope here**; file a follow-up issue in the wrap-up task.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/helperPolicyResolution.integration.test.ts`. Mirror the setup/teardown conventions of `apps/api/src/__tests__/integration/remote-access-settings-rls.integration.test.ts` (real Postgres, seed under `withSystemDbAccessContext`, unique-suffixed fixture names, cleanup in `afterAll`):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { partners } from '../../db/schema/partners';
import { organizations } from '../../db/schema/organizations';
import { devices } from '../../db/schema/devices';
import { configurationPolicies, configPolicyFeatureLinks, configPolicyAssignments } from '../../db/schema/configurationPolicies';
import { resolveDeviceHelperSettings } from '../../routes/agents/helpers';

// Adapt column lists to the schema's NOT NULL requirements the way the
// remote-access RLS integration test does (it seeds the same four tables).

const suffix = `hpr-${Date.now()}`;

describe('helper policy resolution (dual-axis + disabled precedence)', () => {
  let partnerId: string;
  let orgId: string;
  let deviceId: string;

  beforeAll(async () => {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        [{ id: partnerId }] = await db.insert(partners).values({ name: `p-${suffix}` }).returning({ id: partners.id });
        [{ id: orgId }] = await db.insert(organizations).values({ name: `o-${suffix}`, partnerId }).returning({ id: organizations.id });
        [{ id: deviceId }] = await db.insert(devices).values({
          orgId,
          hostname: `d-${suffix}`,
          // ...remaining NOT NULL device columns per the sibling test's seed
        }).returning({ id: devices.id });
      })
    );
  });

  afterAll(async () => {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        // delete in FK order: assignments/links -> policies -> device -> org -> partner
      })
    );
  });

  it('resolves a PARTNER-OWNED helper policy assigned at partner level (bug 1)', async () => {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [{ id: policyId }] = await db.insert(configurationPolicies).values({
          name: `partner-wide-${suffix}`, status: 'active', orgId: null, partnerId,
        }).returning({ id: configurationPolicies.id });
        await db.insert(configPolicyFeatureLinks).values({
          configPolicyId: policyId, featureType: 'helper',
          inlineSettings: { enabled: true, showOpenPortal: false, showDeviceInfo: true, showRequestSupport: true },
        });
        await db.insert(configPolicyAssignments).values({ configPolicyId: policyId, level: 'partner', targetId: partnerId });
      })
    );

    const settings = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => resolveDeviceHelperSettings(deviceId))
    );
    expect(settings).not.toBeNull();
    expect(settings!.enabled).toBe(true);
    expect(settings!.showOpenPortal).toBe(false); // resolved fields survive, not defaults
  });

  it('an explicitly DISABLED policy resolves as disabled, not null (bug 2 precondition)', async () => {
    // Re-point the feature link's inlineSettings at enabled:false (update the
    // link created above), then:
    const settings = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => resolveDeviceHelperSettings(deviceId))
    );
    expect(settings).not.toBeNull();
    expect(settings!.enabled).toBe(false);
  });

  it('returns null when no helper feature link exists at all', async () => {
    // Delete the assignment+link+policy, then:
    const settings = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => resolveDeviceHelperSettings(deviceId))
    );
    expect(settings).toBeNull();
  });
});
```

(The three `it` blocks run in declaration order and mutate shared fixtures — keep them sequential as written. Fill in the NOT NULL columns and cleanup statements by copying the sibling test's seed helpers verbatim.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/helperPolicyResolution.integration.test.ts`
(requires the local test Postgres per the integration config — see `apps/api/vitest.integration.config.ts` env expectations)
Expected: FAIL — `resolveDeviceHelperSettings` is not exported; after exporting mechanically, the partner-owned case fails (resolver returns defaults / misses the policy).

- [ ] **Step 3: Fix the resolver**

In `apps/api/src/routes/agents/helpers.ts`:

1. Export the resolver and change its contract:

```ts
// Resolves the helper feature settings for a device from configuration
// policies. Returns null when NO helper feature link matched — callers
// distinguish "no policy" (legacy org fallback applies) from an explicit
// enabled:false (which must win; see buildHelperConfigUpdate).
export async function resolveDeviceHelperSettings(deviceId: string): Promise<HelperSettings | null> {
```

2. Replace the org-only ownership filter (`:2474`) with the dual-axis condition (same shape as `configurationPolicy.ts:1794-1802`; `sql` import from drizzle-orm):

```ts
    .where(and(
      eq(configurationPolicies.status, 'active'),
      org?.partnerId
        ? sql`(${configurationPolicies.orgId} = ${device.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${org.partnerId}))`
        : eq(configurationPolicies.orgId, device.orgId),
      or(...targetConditions),
    ));
```

3. At the no-winner exit (where it currently returns `HELPER_DEFAULTS`): `return null;`. The winner branch (`:2490-2497`) is unchanged.

4. In `buildHelperConfigUpdate` (`:2513-2545`), replace the fallback block:

```ts
  let settings = await resolveDeviceHelperSettings(deviceId);

  // Legacy org-level fallback applies ONLY when no policy matched at all. An
  // explicit enabled:false policy must win over organizations.settings.helper
  // (previously `!settings.enabled` fell through, and the fallback also
  // discarded the four resolved UI fields).
  if (settings === null) {
    let orgEnabled = false;
    try {
      orgEnabled = (await getOrgHelperSettings(orgId)).enabled;
    } catch {
      // defaults are fine
    }
    settings = { ...HELPER_DEFAULTS, enabled: orgEnabled };
  }
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/helperPolicyResolution.integration.test.ts && npx vitest run src/routes/agents && npx tsc --noEmit`
Expected: PASS (integration + any existing agents-route unit suites).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/__tests__/integration/helperPolicyResolution.integration.test.ts
git commit -m "fix(api): helper policies resolve partner-owned rows; explicit disabled beats org fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Dual-axis RLS for `config_policy_remote_access_settings` (pre-existing bug 4)

**Files:**
- Create: `apps/api/migrations/2026-07-29-remote-access-settings-partner-rls.sql`
- Modify: `apps/api/src/__tests__/integration/remote-access-settings-rls.integration.test.ts` (add partner-owned cases)
- Verify (no edit expected): `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:475-491` (`PARENT_FK_JOIN_POLICY_TABLES` keeps `['config_policy_remote_access_settings', ['configuration_policies']]`)

**Interfaces:**
- Consumes: `breeze_current_scope()`, `breeze_has_org_access(uuid)`, `breeze_has_partner_access(uuid)`; the four org-only per-command policies from `2026-06-19-remote-session-consent-settings.sql:29-65`.
- Produces: one `FOR ALL` dual-axis policy `config_policy_remote_access_settings_isolation`. The table keeps the EXISTS-with-`configuration_policies`-in-FROM shape so the `PARENT_FK_JOIN_POLICY_TABLES` contract assertion still recognizes the parent join.

**The gap:** the child-table policies reach ownership via `breeze_has_org_access(cp.org_id)` only; for a partner-owned parent (`org_id NULL`) that is `breeze_has_org_access(NULL)` → no rows. The **read path used by agents is unaffected** (it runs under `withSystemDbAccessContext`, `remote/helpers.ts:429-461`); the broken surface is the org/partner-scoped **UI write path** — a technician editing a partner-wide policy's consent settings writes/reads 0 rows silently. Note this table owns neither `org_id` nor `partner_id`, so the flat `2026-07-01-*-partner-ownership.sql` template does NOT apply literally — the EXISTS/scalar-subquery form below is required.

- [ ] **Step 1: Write the failing RLS test cases**

Extend `apps/api/src/__tests__/integration/remote-access-settings-rls.integration.test.ts` with a partner-owned describe block, following the file's existing helpers for creating scoped db contexts and forging rows (it already seeds partners/orgs/policies/links — reuse those fixtures):

```ts
describe('partner-owned policy consent settings (dual-axis)', () => {
  // Fixtures: partnerA with orgA; partnerB with orgB. A partner-owned
  // configuration policy for partnerA (org_id NULL, partner_id partnerA)
  // with a remote_access feature link.

  it('partner-scope token of the owning partner can INSERT + SELECT the child row', async () => {
    // withDbAccessContext for a partnerA-scoped principal:
    //   INSERT config_policy_remote_access_settings for the partner-owned link -> succeeds
    //   SELECT it back -> 1 row
  });

  it('org-scope token in the owning partner CANNOT see partner-wide child rows', async () => {
    // withDbAccessContext for an orgA-scoped principal: SELECT -> 0 rows
    // (org tokens never pass breeze_has_partner_access; RLS stays stricter
    // than the app layer — do not "fix" this by loosening the policy)
  });

  it('cross-partner forge fails with 42501', async () => {
    // withDbAccessContext for a partnerB-scoped principal:
    //   INSERT against partnerA's feature link -> expect error.code === '42501'
    //   (new row violates row-level security policy)
  });
});
```

(Org-owned behavior needs no new case — the file's existing org-scoped describe blocks re-run against the new policy and must stay green.)

Flesh these out with the file's actual context helpers (`withDbAccessContext` signature, principal fixtures) — the three real cases are: owning-partner write+read succeeds, org-token sees 0 partner-wide rows, cross-partner forge → `42501`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/remote-access-settings-rls.integration.test.ts`
Expected: the new owning-partner case FAILS (0 rows / 42501 under current org-only policies); existing cases PASS.

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-07-29-remote-access-settings-partner-rls.sql`:

```sql
-- Dual-axis RLS for config_policy_remote_access_settings.
--
-- The 2026-06-19 policies reached ownership only via breeze_has_org_access on
-- the parent configuration_policies.org_id. Partner-owned parents (org_id
-- NULL, partner_id set — 2026-06-27-config-policies-partner-ownership) made
-- breeze_has_org_access(NULL) return false, so partner-wide consent settings
-- were invisible and unwritable to every non-system principal. Replace the
-- four per-command org-only policies with one dual-axis policy.
--
-- Shape note: this child table owns neither org_id nor partner_id — ownership
-- is two hops away (feature_link_id -> config_policy_feature_links ->
-- configuration_policies). Keep the scalar-subquery EXISTS form with
-- configuration_policies in the EXISTS FROM: the rls-coverage contract test
-- (PARENT_FK_JOIN_POLICY_TABLES) keys on exactly that join shape.

ALTER TABLE config_policy_remote_access_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_remote_access_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS config_policy_remote_access_settings_isolation ON config_policy_remote_access_settings;

CREATE POLICY config_policy_remote_access_settings_isolation
  ON config_policy_remote_access_settings
  USING (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM config_policy_feature_links fl
                      WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
        AND (
          (cp.org_id IS NOT NULL AND public.breeze_has_org_access(cp.org_id))
          OR (cp.partner_id IS NOT NULL AND public.breeze_has_partner_access(cp.partner_id))
        )
    )
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR EXISTS (
      SELECT 1 FROM configuration_policies cp
      WHERE cp.id = (SELECT fl.config_policy_id
                       FROM config_policy_feature_links fl
                      WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
        AND (
          (cp.org_id IS NOT NULL AND public.breeze_has_org_access(cp.org_id))
          OR (cp.partner_id IS NOT NULL AND public.breeze_has_partner_access(cp.partner_id))
        )
    )
  );
```

(No `BEGIN;`/`COMMIT;` — `autoMigrate` wraps the file. `DROP POLICY IF EXISTS` + `CREATE POLICY` after its own drop makes re-application a no-op-equivalent.)

- [ ] **Step 4: Apply + run both integration suites**

Run:
```bash
cd apps/api && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/remote-access-settings-rls.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: all PASS. If the `rls-coverage` parent-join assertion (`:475-491` block's checker) rejects the OR'd predicate, adjust the **test's matcher** to accept `breeze_has_org_access OR breeze_has_partner_access` inside the EXISTS (the dual-axis DML assertion at `:1020-1048` already tolerates either helper) — do not weaken the migration.

- [ ] **Step 5: Manual forge check as `breeze_app`**

Run: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and forge a cross-partner insert against a partner-owned link with a partnerB-scoped context — must fail with `new row violates row-level security policy`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-07-29-remote-access-settings-partner-rls.sql apps/api/src/__tests__/integration/remote-access-settings-rls.integration.test.ts
git commit -m "fix(api): dual-axis RLS for remote-access consent settings child table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: `lifecycleMode` policy override — transport end-to-end + live apply

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (`HelperSettings` interface `:2403-2416`, resolved-fields block `:2490-2497`)
- Modify: `apps/api/src/routes/agents/heartbeat.ts:951` (inline `helperSettings` type annotation gains the field)
- Modify: `agent/internal/heartbeat/heartbeat.go` (`HelperSettings` struct `:154-160`; settings application `:3553-3564`; `helperLifecycleController` — add `SetModeOverride`)
- Modify: `agent/internal/sessionbroker/lifecycle_core.go` (manager fields `rdsHost bool`, `localOverride string`; `Mode()` under lock; new `SetModeOverride`)
- Modify: `agent/internal/sessionbroker/lifecycle.go:39-53` + `agent/internal/sessionbroker/lifecycle_stub.go:8-12` (store `rdsHost`/`localOverride` at construction)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx` (mode selector)
- Test: `agent/internal/sessionbroker/lifecycle_mode_test.go` (extend), `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.test.tsx` (extend), locale files ×7

**Interfaces:**
- Consumes: `resolveLifecycleMode(override string, rdsHost bool) LifecycleMode` (`lifecycle_mode.go:32`), `detectRDSHost()`, Task 6's widened controller, Task 9's exported resolver.
- Produces:
  - API `HelperSettings.lifecycleMode?: 'auto' | 'always-on' | 'on-demand'` resolved from the helper feature's `inlineSettings.lifecycleMode` (invalid/absent → `undefined`, agent treats as auto). Flows to the agent automatically via the existing `helperSettings: helperSettings ?? undefined` spread (`heartbeat.ts:1105-1106`) once the type annotation includes it.
  - Go `HelperSettings.LifecycleMode string \`json:"lifecycleMode,omitempty"\``.
  - `func (m *HelperLifecycleManager) SetModeOverride(override string)` — recomputes the mode live; **an explicit local config override always wins** (config file / `BREEZE_HELPER_LIFECYCLE_MODE` is the break-glass; server policy applies only when local is `""`/`"auto"`). Switching to always-on clears the lease table; any switch kicks a reconcile (to always-on ⇒ helpers spawn for all sessions; to on-demand ⇒ unleased helpers reap). No-op when resolved mode is unchanged. Applied every heartbeat — cheap idempotent call.
  - Precedence, documented in both resolver and Go comments: **local agent config (explicit) > server policy override > auto-detection**.

- [ ] **Step 1: Write the failing Go tests**

Extend `agent/internal/sessionbroker/lifecycle_mode_test.go`:

```go
func TestSetModeOverride(t *testing.T) {
	newMgr := func(localOverride string, rdsHost bool) *HelperLifecycleManager {
		b := New("mode-override-"+t.Name(), nil)
		m := newHelperLifecycleManager(b, &stubLeaseDetector{}, nil, nil)
		m.rdsHost = rdsHost
		m.localOverride = localOverride
		m.mode = resolveLifecycleMode(localOverride, rdsHost)
		return m
	}

	t.Run("server override flips auto RDS host to always-on and clears leases", func(t *testing.T) {
		m := newMgr("", true) // auto -> on-demand
		m.mu.Lock()
		m.leases[HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}] = &helperLease{}
		m.mu.Unlock()

		m.SetModeOverride("always-on")
		if m.Mode() != string(LifecycleModeAlwaysOn) {
			t.Fatalf("mode = %s", m.Mode())
		}
		m.mu.Lock()
		n := len(m.leases)
		m.mu.Unlock()
		if n != 0 {
			t.Fatalf("leases must be cleared on switch to always-on, have %d", n)
		}
	})

	t.Run("server override flips workstation to on-demand", func(t *testing.T) {
		m := newMgr("", false)
		m.SetModeOverride("on-demand")
		if m.Mode() != string(LifecycleModeOnDemand) {
			t.Fatalf("mode = %s", m.Mode())
		}
	})

	t.Run("server auto returns to detection", func(t *testing.T) {
		m := newMgr("", true)
		m.SetModeOverride("always-on")
		m.SetModeOverride("auto")
		if m.Mode() != string(LifecycleModeOnDemand) {
			t.Fatalf("auto on RDS host must resolve on-demand, got %s", m.Mode())
		}
	})

	t.Run("explicit local config wins over server override", func(t *testing.T) {
		m := newMgr("always-on", true)
		m.SetModeOverride("on-demand")
		if m.Mode() != string(LifecycleModeAlwaysOn) {
			t.Fatalf("local explicit override must win, got %s", m.Mode())
		}
	})

	t.Run("no-op when unchanged", func(t *testing.T) {
		m := newMgr("", true)
		m.SetModeOverride("on-demand") // already on-demand
		if m.Mode() != string(LifecycleModeOnDemand) {
			t.Fatalf("mode = %s", m.Mode())
		}
	})
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestSetModeOverride -v`
Expected: FAIL — `m.rdsHost`/`m.localOverride`/`SetModeOverride` undefined

- [ ] **Step 3: Implement the Go side**

In `lifecycle_core.go`: add fields `rdsHost bool` and `localOverride string` next to `mode LifecycleMode` (`:163`); make `Mode()` (`:198-200`) read under `m.mu`; add:

```go
// SetModeOverride applies the server-delivered lifecycle override
// ("auto" | "always-on" | "on-demand" | ""). Precedence: an explicit local
// config override (helper_lifecycle_mode / BREEZE_HELPER_LIFECYCLE_MODE) is
// the operator's break-glass and always wins; otherwise the server value is
// resolved against RDS detection. A live switch to always-on strands no
// state: leases are cleared and the reconcile respawns per-session helpers.
// A switch to on-demand leaves the lease table empty, so the next reconcile
// reaps every unleased helper. Called every heartbeat — must be idempotent.
func (m *HelperLifecycleManager) SetModeOverride(override string) {
	m.mu.Lock()
	if m.localOverride != "" && m.localOverride != "auto" {
		m.mu.Unlock()
		return
	}
	newMode := resolveLifecycleMode(override, m.rdsHost)
	if newMode == m.mode {
		m.mu.Unlock()
		return
	}
	log.Info("helper lifecycle mode changed by server override",
		"from", string(m.mode), "to", string(newMode), "override", override)
	m.mode = newMode
	if newMode == LifecycleModeAlwaysOn {
		m.leases = make(map[HelperKey]*helperLease)
	}
	m.mu.Unlock()
	m.kickReconcile()
}
```

Also audit every read of `m.mode` (`computeDesired` `lifecycle_core.go:229-250`, the SCM handlers `lifecycle.go:121-137`) and route them through a locked read (`m.currentMode()` private helper or inline lock) — the field is now mutable.

In `lifecycle.go:39-53` (windows constructor) and `lifecycle_stub.go:8-12`: after `mode := resolveLifecycleMode(modeOverride, rdsHost)`, also set `manager.rdsHost = rdsHost; manager.localOverride = modeOverride` (stub: `rdsHost = false`).

In `heartbeat.go`: add `SetModeOverride(override string)` to `helperLifecycleController` (Task 6's widened interface; update test fakes mechanically — `fakeLifecycle` gets a recording no-op). Extend the decoder struct (`:154-160`):

```go
type HelperSettings struct {
	Enabled            bool   `json:"enabled"`
	ShowOpenPortal     bool   `json:"showOpenPortal"`
	ShowDeviceInfo     bool   `json:"showDeviceInfo"`
	ShowRequestSupport bool   `json:"showRequestSupport"`
	PortalUrl          string `json:"portalUrl,omitempty"`
	// LifecycleMode is the server-side helper lifecycle override
	// ("auto" | "always-on" | "on-demand"); empty means auto. Applied to the
	// sessionbroker lifecycle, NOT to the Tauri Assist manager.
	LifecycleMode string `json:"lifecycleMode,omitempty"`
}
```

and at the application site (`:3553-3564`), after the existing `h.helperMgr.Apply(...)` block (do NOT add the field to `helper.Settings` — it is not an Assist setting):

```go
	if response.HelperSettings != nil {
		h.mu.Lock()
		lc := h.helperLifecycle
		h.mu.Unlock()
		if lc != nil {
			lc.SetModeOverride(response.HelperSettings.LifecycleMode)
		}
	}
```

Run: `cd agent && go test -race ./internal/sessionbroker/... ./internal/heartbeat/... && GOOS=windows go build ./...` → PASS.

- [ ] **Step 4: Implement the API side**

In `apps/api/src/routes/agents/helpers.ts`:

```ts
export interface HelperSettings {
  enabled: boolean;
  showOpenPortal: boolean;
  showDeviceInfo: boolean;
  showRequestSupport: boolean;
  portalUrl?: string;
  /**
   * Helper lifecycle override for RDS hosts ('auto' | 'always-on' |
   * 'on-demand'). Undefined = auto. Precedence on the agent: explicit local
   * agent config > this value > RDS auto-detection. Cached with the rest of
   * the helper settings (120s) — mode changes land within TTL + heartbeat.
   */
  lifecycleMode?: 'auto' | 'always-on' | 'on-demand';
}
```

In the winner-mapping block (`:2490-2497`) add:

```ts
    lifecycleMode: s.lifecycleMode === 'auto' || s.lifecycleMode === 'always-on' || s.lifecycleMode === 'on-demand'
      ? s.lifecycleMode
      : undefined,
```

In `apps/api/src/routes/agents/heartbeat.ts:951`, extend the inline annotation:

```ts
  let helperSettings: { enabled: boolean; showOpenPortal: boolean; showDeviceInfo: boolean; showRequestSupport: boolean; portalUrl?: string; lifecycleMode?: 'auto' | 'always-on' | 'on-demand' } | null = null;
```

(the emit at `:1105-1106` passes the whole object — no further change). Run `cd apps/api && npx tsc --noEmit`.

- [ ] **Step 5: Web — HelperTab mode selector**

In `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx`: add `lifecycleMode` to the local `HelperSettings` type (`:9-15`) as `lifecycleMode?: 'auto' | 'always-on' | 'on-demand'` with default `'auto'` in `defaults` (`:16-23`); strip it from the save payload when `'auto'` (mirror the `portalUrl` cleanup at `:52-53`: `if (payload.lifecycleMode === 'auto') delete payload.lifecycleMode;`). Add the selector after the existing toggles, copying the `sessionPromptMode` select pattern (`RemoteAccessTab.tsx:424-452`):

```tsx
          <label className="block text-sm font-medium">
            {i18n.t('policies:helperTab.lifecycleMode')}
            <select
              value={settings.lifecycleMode ?? 'auto'}
              onChange={(e) => update('lifecycleMode', e.target.value as HelperSettings['lifecycleMode'])}
              data-testid="helper-lifecycle-mode"
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="auto">{i18n.t('policies:helperTab.lifecycleModeAuto')}</option>
              <option value="always-on">{i18n.t('policies:helperTab.lifecycleModeAlwaysOn')}</option>
              <option value="on-demand">{i18n.t('policies:helperTab.lifecycleModeOnDemand')}</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">{i18n.t('policies:helperTab.lifecycleModeHelp')}</p>
          </label>
```

(Adapt `update`/i18n accessor to HelperTab's actual local conventions — it may use a `useTranslation` hook rather than `i18n.t`; match the file.) English strings: `lifecycleMode` = "Helper lifecycle on RD Session Hosts"; `lifecycleModeAuto` = "Auto (on-demand on RDS hosts)"; `lifecycleModeAlwaysOn` = "Always on (helper per session)"; `lifecycleModeOnDemand` = "On demand (spawn when targeted)"; `lifecycleModeHelp` = "On-demand keeps RD Session Hosts at zero idle helpers and spawns one when a technician targets a session. An explicit setting in the agent's local config file overrides this policy." Add all five keys to the `policies` namespace in **all seven** locale files.

Extend `HelperTab.test.tsx`: assert the select renders with default `auto`, that choosing `on-demand` includes `lifecycleMode: 'on-demand'` in the saved `inlineSettings`, and that `auto` omits the key.

- [ ] **Step 6: Run everything for this task**

Run: `cd agent && go test -race ./internal/... && cd ../apps/api && npx tsc --noEmit && cd ../web && npx vitest run src/components/configurationPolicies/featureTabs/HelperTab.test.tsx && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/heartbeat.ts agent/internal/heartbeat/heartbeat.go agent/internal/sessionbroker/ apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx apps/web/src/components/configurationPolicies/featureTabs/HelperTab.test.tsx apps/web/src/locales/
git commit -m "feat(agent,api,web): server-driven helper lifecycle mode override, live-applied

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: `helperLifecycleMode` reaches the web app

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts` (device **list** column selects — the explicit select blocks near `:420-487` and `:604-731`; the detail endpoint at `:919-931` already passes the field through via the `stripSensitiveDeviceFields` spread)
- Modify: `apps/api/src/routes/devices/core.list-response-shape.test.ts` (shape contract)
- Modify: `apps/web/src/components/devices/DeviceList.tsx:116-175` (web `Device` type)
- Modify: `apps/web/src/components/devices/DeviceDetailPage.tsx:63-115` (fetch transform) and the corresponding list-row transform in `apps/web/src/components/devices/DevicesPage.tsx`
- Modify: `apps/api/src/routes/agents/heartbeat.ts:530-532` (comment only — document the hint semantics)

**Interfaces:**
- Consumes: `devices.helperLifecycleMode` column (plan 2), `GET /devices/:id` full-row spread, list endpoints' explicit selects.
- Produces: web `Device.helperLifecycleMode?: 'always-on' | 'on-demand' | null` available on both the detail page and list rows. Tasks 13/14 gate their pickers on `device.helperLifecycleMode === 'on-demand'`.

- [ ] **Step 1: Update the list-shape contract test first**

In `apps/api/src/routes/devices/core.list-response-shape.test.ts`, add `helperLifecycleMode` to the expected row shape (nullable string). Run `cd apps/api && npx vitest run src/routes/devices/core.list-response-shape.test.ts` → FAIL (column not selected).

- [ ] **Step 2: Add the column to the list selects**

In `apps/api/src/routes/devices/core.ts`, add `helperLifecycleMode: devices.helperLifecycleMode,` to every explicit device-row select feeding the list endpoint (grep `osType: devices.osType` in the file to find each select block — there are at least two, near `:420-487` and `:604-731`). Re-run the shape test → PASS.

- [ ] **Step 3: Document the hint semantics at the ingest guard**

In `apps/api/src/routes/agents/heartbeat.ts:530-532`, extend the comment (code unchanged — this is the known parked truthy-guard):

```ts
  // NOTE: truthy guard — a device that STOPS reporting a mode (agent
  // downgrade, host no longer RDS) keeps its last stored value forever.
  // devices.helper_lifecycle_mode is therefore a HINT for the web UI's
  // session pickers, never an authorization gate: a stale 'on-demand' just
  // shows a picker whose live session fetch still returns the truth.
  if (data.helperLifecycleMode && data.helperLifecycleMode !== device.helperLifecycleMode) {
    deviceUpdates.helperLifecycleMode = data.helperLifecycleMode;
  }
```

- [ ] **Step 4: Thread through the web types + transforms**

In `DeviceList.tsx`'s `Device` type add `helperLifecycleMode?: 'always-on' | 'on-demand' | null;`. In `DeviceDetailPage.tsx`'s `transformedDevice` add `helperLifecycleMode: data.helperLifecycleMode ?? null,`. In `DevicesPage.tsx`'s list-row transform (grep for where it builds `Device` rows from the list response) add the same line.

- [ ] **Step 5: Run + commit**

Run: `cd apps/api && npx vitest run src/routes/devices && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: PASS

```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/core.list-response-shape.test.ts apps/api/src/routes/agents/heartbeat.ts apps/web/src/components/devices/DeviceList.tsx apps/web/src/components/devices/DeviceDetailPage.tsx apps/web/src/components/devices/DevicesPage.tsx
git commit -m "feat(api,web): expose device helperLifecycleMode to the web app (list + detail)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: RD connect session picker (web)

**Files:**
- Create: `apps/web/src/components/remote/SessionPickerModal.tsx`
- Create: `apps/web/src/components/remote/SessionPickerModal.test.tsx`
- Modify: `apps/web/src/services/deviceActions.ts` (add `fetchLiveSessions`)
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx` (picker gate + deep-link param)
- Modify: prop threading at the four mount sites — `apps/web/src/components/devices/DeviceActions.tsx:284-292` and `:442-449`, `apps/web/src/components/devices/DeviceList.tsx:2217`, `apps/web/src/components/remote/RemoteToolsPage.tsx:829`
- Modify: locale files ×7

**Interfaces:**
- Consumes: `GET /devices/:id/sessions/live` (Task 2), `device.helperLifecycleMode` (Task 12), `fetchWithAuth`.
- Produces:
  - `export type LiveSession = { sessionId: number; username: string; state: string; type: string; helperConnected: boolean; idleMinutes: number | null };`
  - `export async function fetchLiveSessions(deviceId: string): Promise<LiveSession[]>` in `deviceActions.ts` (throws on non-OK with the server's `error` string).
  - `SessionPickerModal` props: `{ isOpen: boolean; deviceId: string; purpose: 'desktop' | 'script'; onSelect: (sessionId: number) => void; onClose: () => void }`. For `purpose='desktop'`, `state === 'disconnected'` rows render disabled (no input desktop to shadow — `detector_windows.go:315`); for `'script'` all rows are selectable.
  - `ConnectDesktopButton` new optional prop `helperLifecycleMode?: 'always-on' | 'on-demand' | null`. When `'on-demand'`, clicking connect opens the picker first; the chosen id is appended to the deep link as `&targetSessionId=N`. Otherwise behavior is unchanged (prop absent/other value ⇒ zero change for non-RDS devices).

Deliberate divergence from the Tauri viewer toolbar picker (`ViewerToolbar.tsx:563-583`, which lists disconnected sessions as selectable): the web pre-connect picker disables them, per spec goal 1. The viewer toolbar is untouched by this plan.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/remote/SessionPickerModal.test.tsx` (follow `ScriptPickerModal.test.tsx`'s conventions — `import '@/lib/i18n';`, mocked `fetchWithAuth`, `makeJsonResponse` helper):

```tsx
import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionPickerModal from './SessionPickerModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const SESSIONS = {
  data: {
    deviceId: 'dev-1',
    sessions: [
      { sessionId: 1, username: 'console-user', state: 'active', type: 'console', helperConnected: false, idleMinutes: 2 },
      { sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: null },
      { sessionId: 5, username: 'bob', state: 'disconnected', type: 'rdp', helperConnected: false, idleMinutes: 480 },
    ],
  },
};

describe('SessionPickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(SESSIONS));
  });

  it('lists live sessions and disables disconnected rows for desktop', async () => {
    const onSelect = vi.fn();
    render(<SessionPickerModal isOpen deviceId="dev-1" purpose="desktop" onSelect={onSelect} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('session-picker-row-3')).toBeDefined());
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/sessions/live');

    expect((screen.getByTestId('session-picker-row-5') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('session-picker-row-5'));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('session-picker-row-3'));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('keeps disconnected rows selectable for scripts', async () => {
    const onSelect = vi.fn();
    render(<SessionPickerModal isOpen deviceId="dev-1" purpose="script" onSelect={onSelect} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('session-picker-row-5')).toBeDefined());
    fireEvent.click(screen.getByTestId('session-picker-row-5'));
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it('shows the error state when the probe fails', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'agent offline' }, false, 502));
    render(<SessionPickerModal isOpen deviceId="dev-1" purpose="desktop" onSelect={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('session-picker-error')).toBeDefined());
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/remote/SessionPickerModal.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Implement service + modal**

In `apps/web/src/services/deviceActions.ts`:

```ts
export type LiveSession = {
  sessionId: number;
  username: string;
  state: string;
  type: string;
  helperConnected: boolean;
  idleMinutes: number | null;
};

export async function fetchLiveSessions(deviceId: string): Promise<LiveSession[]> {
  const response = await fetchWithAuth(`/devices/${deviceId}/sessions/live`);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? 'Failed to list sessions');
  }
  return (body as { data?: { sessions?: LiveSession[] } })?.data?.sessions ?? [];
}
```

Create `apps/web/src/components/remote/SessionPickerModal.tsx` — modest modal listing sessions as row buttons; match the app's existing modal chrome (copy the overlay/panel classes from `ScriptPickerModal.tsx`):

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fetchLiveSessions, type LiveSession } from '../../services/deviceActions';

type Props = {
  isOpen: boolean;
  deviceId: string;
  purpose: 'desktop' | 'script';
  onSelect: (sessionId: number) => void;
  onClose: () => void;
};

export default function SessionPickerModal({ isOpen, deviceId, purpose, onSelect, onClose }: Props) {
  const { t } = useTranslation('devices');
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(undefined);
    fetchLiveSessions(deviceId)
      .then(setSessions)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t('sessionPicker.fetchFailed')))
      .finally(() => setLoading(false));
  }, [isOpen, deviceId]);

  if (!isOpen) return null;

  const idleLabel = (s: LiveSession) =>
    s.idleMinutes == null ? '' : ` · ${t('sessionPicker.idleMinutes', { count: s.idleMinutes })}`;

  return (
    /* overlay + panel wrappers copied from ScriptPickerModal */
    <div /* overlay */>
      <div /* panel */ data-testid="session-picker-modal">
        <h2>{purpose === 'desktop' ? t('sessionPicker.titleDesktop') : t('sessionPicker.titleScript')}</h2>
        {loading && <p>{t('sessionPicker.loading')}</p>}
        {error && <p data-testid="session-picker-error">{error}</p>}
        {!loading && !error && sessions.length === 0 && <p data-testid="session-picker-empty">{t('sessionPicker.noSessions')}</p>}
        <ul>
          {sessions.map((s) => {
            const disabled = purpose === 'desktop' && s.state === 'disconnected';
            return (
              <li key={s.sessionId}>
                <button
                  type="button"
                  data-testid={`session-picker-row-${s.sessionId}`}
                  disabled={disabled}
                  title={disabled ? t('sessionPicker.disconnectedNotShadowable') : undefined}
                  onClick={() => { if (!disabled) { onSelect(s.sessionId); onClose(); } }}
                >
                  {s.username} — {t('sessionPicker.sessionLabel', { id: s.sessionId })} ({s.state}
                  {s.type === 'rdp' ? ' · RDP' : ''}{idleLabel(s)})
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" onClick={onClose}>{t('sessionPicker.cancel')}</button>
      </div>
    </div>
  );
}
```

i18n keys (namespace `devices`, all seven locales): `sessionPicker.titleDesktop` "Select a session to view", `sessionPicker.titleScript` "Select a session to run in", `sessionPicker.loading` "Loading sessions…", `sessionPicker.fetchFailed` "Could not load sessions", `sessionPicker.noSessions` "No interactive sessions found", `sessionPicker.sessionLabel` "session {{id}}", `sessionPicker.idleMinutes` "idle {{count}}m", `sessionPicker.disconnectedNotShadowable` "Disconnected sessions cannot be viewed — no active desktop to capture", `sessionPicker.cancel` "Cancel".

- [ ] **Step 4: Gate `ConnectDesktopButton`**

In `ConnectDesktopButton.tsx`: add `helperLifecycleMode?: 'always-on' | 'on-demand' | null;` to `Props` (`:14-24`). Refactor the click path so the existing connect logic (`:359-400`) becomes `startConnect(targetSessionId?: number)`; the button's `onClick` becomes:

```tsx
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleClick = () => {
    if (helperLifecycleMode === 'on-demand') {
      setPickerOpen(true); // RDS host: pick the session before creating the remote session
      return;
    }
    void startConnect();
  };
```

and the deep-link construction inside `startConnect` gains:

```tsx
      const deepLink = `breeze://connect?session=${encodeURIComponent(session.id)}&code=${encodeURIComponent(codeData.code)}&api=${encodeURIComponent(apiUrl)}&device=${encodeURIComponent(deviceId)}`
        + (targetSessionId != null ? `&targetSessionId=${targetSessionId}` : '');
```

(the viewer already parses `targetSessionId` from the deep link — `apps/viewer/src/lib/protocol.ts:87-122` — and threads it into the WebRTC offer; no viewer change needed). Render the modal next to the button:

```tsx
      <SessionPickerModal
        isOpen={pickerOpen}
        deviceId={deviceId}
        purpose="desktop"
        onSelect={(sessionId) => { setPickerOpen(false); void startConnect(sessionId); }}
        onClose={() => setPickerOpen(false)}
      />
```

Thread the prop at all four mount sites: `DeviceActions.tsx:284-292` and `:442-449` (`helperLifecycleMode={device.helperLifecycleMode}`), `DeviceList.tsx:2217`, `RemoteToolsPage.tsx:829` (same expression against whatever device row object each site holds — available after Task 12).

- [ ] **Step 5: Run tests + typecheck**

Run: `cd apps/web && npx vitest run src/components/remote/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/remote/ apps/web/src/services/deviceActions.ts apps/web/src/components/devices/DeviceActions.tsx apps/web/src/components/devices/DeviceList.tsx apps/web/src/locales/
git commit -m "feat(web): RDS session picker on remote-desktop connect

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Run-script dialog session dropdown (web)

**Files:**
- Modify: `apps/web/src/components/devices/ScriptPickerModal.tsx` (props `:39-46`, state `:47-70`, filters bar `:225-232`, both `onSelect` call sites `:152-153`/`:171-172`)
- Modify: `apps/web/src/components/devices/DeviceDetailPage.tsx:428-452` (`handleScriptSelect`) and the modal mount `:527-533`
- Modify: `apps/web/src/components/devices/DevicesPage.tsx:598-627` (signature only — multi-device path never targets)
- Test: `apps/web/src/components/devices/ScriptPickerModal.test.tsx` (extend)
- Modify: locale files ×7

**Interfaces:**
- Consumes: `fetchLiveSessions` (Task 13), `executeScript(..., targetSessionId?)` (Task 8), `device.helperLifecycleMode` (Task 12).
- Produces: `ScriptPickerModal` props gain `deviceId?: string; helperLifecycleMode?: 'always-on' | 'on-demand' | null;`; `onSelect` becomes `(script, runAs, parameters?, targetSessionId?) => void`. The session dropdown renders **only** when `runAs === 'user' && helperLifecycleMode === 'on-demand' && deviceId` is set — i.e. never for multi-device bulk runs (`DevicesPage` passes neither prop) and never for non-RDS devices. All sessions (incl. disconnected — processes keep running there) are selectable for scripts.

- [ ] **Step 1: Write the failing tests**

Extend `apps/web/src/components/devices/ScriptPickerModal.test.tsx` (the file already mocks `fetchWithAuth` for `GET /scripts`; make the mock route by URL):

```tsx
const SESSIONS_RESPONSE = {
  data: {
    deviceId: 'dev-1',
    sessions: [
      { sessionId: 1, username: 'console-user', state: 'active', type: 'console', helperConnected: false, idleMinutes: 0 },
      { sessionId: 5, username: 'bob', state: 'disconnected', type: 'rdp', helperConnected: false, idleMinutes: 90 },
    ],
  },
};

const routeFetchMock = () =>
  fetchWithAuthMock.mockImplementation(async (url: string) =>
    url.startsWith('/devices/') ? makeJsonResponse(SESSIONS_RESPONSE) : makeJsonResponse(SCRIPTS_DATA)
  );

describe('ScriptPickerModal session targeting', () => {
  it('shows the session dropdown only for runAs=user on an on-demand device', async () => {
    routeFetchMock();
    render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="rds-01"
        deviceOs="windows" deviceId="dev-1" helperLifecycleMode="on-demand" />
    );
    // default runAs=system: no dropdown
    expect(screen.queryByTestId('script-session-target')).toBeNull();

    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await waitFor(() => expect(screen.getByTestId('script-session-target')).toBeDefined());
    // disconnected sessions stay selectable for scripts
    expect(screen.getByText(/bob/)).toBeDefined();
  });

  it('never shows the dropdown without deviceId (bulk runs) or on always-on devices', () => {
    routeFetchMock();
    const { rerender } = render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="many" deviceOs="windows" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    expect(screen.queryByTestId('script-session-target')).toBeNull();

    rerender(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="ws-01"
        deviceOs="windows" deviceId="dev-2" helperLifecycleMode="always-on" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    expect(screen.queryByTestId('script-session-target')).toBeNull();
  });

  it('passes the chosen session to onSelect', async () => {
    routeFetchMock();
    const onSelect = vi.fn();
    render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={onSelect} deviceHostname="rds-01"
        deviceOs="windows" deviceId="dev-1" helperLifecycleMode="on-demand" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await waitFor(() => expect(screen.getByTestId('script-session-target')).toBeDefined());
    fireEvent.change(screen.getByTestId('script-session-target'), { target: { value: '5' } });
    // pick the first parameterless script the fixture provides, then:
    // expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: <fixture id> }), 'user', undefined, 5);
  });
});
```

(If the existing `runAs` select has no `data-testid`, add `data-testid="script-run-as"` to it as part of this task and query the fixture's script row the way the existing tests do.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/devices/ScriptPickerModal.test.tsx`
Expected: new cases FAIL (unknown props / missing dropdown); existing cases PASS.

- [ ] **Step 3: Implement the modal changes**

In `ScriptPickerModal.tsx`:

Props (`:39-46`):

```tsx
type ScriptPickerModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (script: Script, runAs: ScriptRunAsSelection, parameters?: Record<string, unknown>, targetSessionId?: number) => void;
  deviceHostname?: string;
  deviceOs?: OSType | OSType[];
  // Single-device context only: enables the RDS session-target dropdown for
  // runAs=user when the device reports on-demand helper lifecycle.
  deviceId?: string;
  helperLifecycleMode?: 'always-on' | 'on-demand' | null;
};
```

State + fetch (alongside the existing state block `:47-70`):

```tsx
  const [liveSessions, setLiveSessions] = useState<LiveSession[]>([]);
  const [targetSessionId, setTargetSessionId] = useState<number | undefined>();
  const showSessionTarget = runAs === 'user' && helperLifecycleMode === 'on-demand' && !!deviceId;

  useEffect(() => {
    if (!isOpen) return;
    setTargetSessionId(undefined);
    setLiveSessions([]);
  }, [isOpen]);

  useEffect(() => {
    if (!showSessionTarget || !deviceId) return;
    fetchLiveSessions(deviceId).then(setLiveSessions).catch(() => setLiveSessions([]));
  }, [showSessionTarget, deviceId]);
```

Dropdown in the filters bar, sibling of the `runAs` select (`:225-232`):

```tsx
        {showSessionTarget && (
          <select
            value={targetSessionId ?? ''}
            onChange={(e) => setTargetSessionId(e.target.value === '' ? undefined : Number(e.target.value))}
            data-testid="script-session-target"
            className={/* same classes as the runAs select */}
          >
            <option value="">{t('scriptPickerModal.sessionAny')}</option>
            {liveSessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.username} — {s.sessionId} ({s.state})
              </option>
            ))}
          </select>
        )}
```

Both `onSelect(...)` call sites (`:152-153` and `:171-172`) pass `showSessionTarget ? targetSessionId : undefined` as the fourth argument. i18n: `scriptPickerModal.sessionAny` = "Any session (console)" in all seven locales.

- [ ] **Step 4: Thread through the callers**

`DeviceDetailPage.tsx:428-452`:

```tsx
  const handleScriptSelect = async (
    script: Script,
    runAs: ScriptRunAsSelection,
    parameters?: Record<string, unknown>,
    targetSessionId?: number,
  ) => {
    ...
      await executeScript(script.id, [device.id], parameters, runAs, targetSessionId);
```

and the mount (`:527-533`) gains `deviceId={device.id} helperLifecycleMode={device.helperLifecycleMode ?? null}`. `DevicesPage.tsx` (`:598-605`): the handler signature accepts (and ignores) the fourth parameter for type compatibility; the mount at `:1297-1303` intentionally passes neither new prop (bulk runs stay untargeted).

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `cd apps/web && npx vitest run src/components/devices/ScriptPickerModal.test.tsx && npx tsc --noEmit`
Expected: PASS

```bash
git add apps/web/src/components/devices/ScriptPickerModal.tsx apps/web/src/components/devices/ScriptPickerModal.test.tsx apps/web/src/components/devices/DeviceDetailPage.tsx apps/web/src/components/devices/DevicesPage.tsx apps/web/src/locales/
git commit -m "feat(web): run-script dialog targets a specific session on RDS devices

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Full verification + manual RDS-rig release gate

**Files:** none created — verification only, plus one follow-up issue.

- [ ] **Step 1: Full automated sweep**

```bash
cd agent && go test -race ./... && GOOS=windows go build ./... && cd ..
pnpm test --filter=@breeze/api --filter=@breeze/web --filter=@breeze/shared
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/remote-access-settings-rls.integration.test.ts
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/helperPolicyResolution.integration.test.ts
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift
```
Expected: all green. Remember: `pnpm test` alone does NOT cover the three integration suites or drift — they must run explicitly (local green ≠ CI green).

- [ ] **Step 2: i18n key parity**

Verify every key added in Tasks 11/13/14 exists in all seven locale files (`grep -c 'sessionPicker' apps/web/src/locales/*/devices.json` and the `policies` namespace equivalents — counts must match across locales).

- [ ] **Step 3: File the sibling-resolver follow-up issue**

Task 9 fixed the org-only ownership filter for `helper` only. File a GitHub issue titled "Config-policy resolvers ignore partner-owned policies (event_log, monitoring, pam, patch_source)" citing `apps/api/src/routes/agents/helpers.ts:1797/:1986/:2626/:2797` and the dual-axis fix pattern from this plan. Do not fix them in this PR.

- [ ] **Step 4: Manual RDS-rig release gate (cannot be settled by CI)**

On the RDS rig (see `rds_helper_lifecycle_test_rig` memory), with two RDP users + console logged in:

1. **WTSClientProtocolType retention check (pre-existing open question):** disconnect an RDP session; watch the agent log for the phase-0 prune line (`"retention: pruning SYSTEM helper"`) ~10 min later. If it never fires, `WTSClientProtocolType` reverted to 0 on disconnect and the retention predicates in `helper_key.go:37` + the phase-0 cap must re-key on `State`+non-console — file immediately, this invalidates the `Type=="rdp"` assumption.
2. **Zero-at-rest:** on-demand mode with no operations → no `breeze-user-helper.exe` processes.
3. **Shadow each `sessionPromptMode`** (`off`/`notify`/`consent`) targeting user B's session while logged in as user A: the prompt/notify/banner appears **in B's session, never A's**; consent deny tears down cleanly (leases released, helpers reaped after linger).
4. **Disconnected shadow blocked:** picker shows the disconnected session disabled; a forged offer with its id fails typed ("target session has ended" / probe failure), not a black stream.
5. **Targeted script:** run `whoami` with runAs=user targeting B → returns B's identity; target a logged-off session id → typed "no longer exists" error listing eligible sessions.
6. **Idle reap:** after script completion + ~2 min linger + TTL, the helper exits.
7. **Mode override end-to-end:** set the helper policy override to `always-on` → within 120s cache + heartbeat, helpers spawn for all sessions and the pickers disappear (list may lag — hint semantics); back to `auto` → helpers reap.
8. **Logon task:** log a fresh user in under on-demand → the `\Breeze\AgentUserHelper` task's helper exits 0 without retry loop (plan 2's `not_desired` path, now under real load).

- [ ] **Step 5: Update the initiative memory + PR**

Record rig results in the PR description; plan 3 execution state → memory (`project_rds_per_session_helpers_initiative`). PR #2911 gains these commits (same branch); re-run `/code-review` per repo convention before merge.

---

## Self-Review Notes (spec coverage)

- Spec "Capture, routing, consent" → Tasks 3 (disconnected filter), 4 (consent routing invariant), 5 (GDI probe), 6 (#434 strict-by-mode, lease-driven desktop). The #434 strictness is gated on on-demand mode rather than raw RDS detection — an RDS host explicitly forced to `always-on` keeps legacy fallback; documented in Task 6.
- Spec "run_as_user" routing rules → Task 7 (agent) + 8 (API/web transport).
- Spec "Policy plumbing" bugs 1/2/4 → Tasks 9, 10; cache note (bug 3) documented in Task 9/11. The Tauri `manager.go` hop is deliberately NOT extended — `lifecycleMode` is a sessionbroker concern, not an Assist setting (Task 11).
- Spec "API / web" → Tasks 1, 2, 12, 13, 14.
- Spec "Error handling" → typed wait messages (Task 6/7), consent-decline path (Task 6), keepalive/lease interplay (Task 6 renewal self-stop; SCM invalidation shipped in plan 2).
- Spec "Testing" → unit tests per task; Windows-integration additions live in plan 2's `rds_lifecycle_integration_test.go` scope and the manual gate (Task 15) covers what fakes can't prove.
- Known consciously-accepted gaps, restated: single-desktop-session-per-device ordering unchanged; `device_commands`-less probe for `list_sessions`; 120s helper-settings cache with no invalidation; heartbeat truthy guard kept (hint semantics, Task 12); sibling resolver bugs → follow-up issue (Task 15).





