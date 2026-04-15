# ICE TURN Fallback + Diagnostics

**Status:** items 1-4 applied on branch `diag/remote-desktop-434` as part of the
#434 fix bundle (see "Relationship to #434" section below). Item 5 — the
`desktop_debug` config gating — is the remaining work to clean up the
shipping-level noise before merge.

## Problem this is meant to fix

From the Apr 12 handoff (work item B):

> ICE media path runs over Tailscale (`<agent-tailscale-v4>` / `<agent-tailscale-v6>`) with
> prflx/host pairing, no TURN relay fallback. Any Tailscale flap (or similar
> transient IP path loss) makes the ICE state go `disconnected` → 8s grace
> timer expires → session killed. We have TURN configured
> (`<turn-host>:3478`) but never used.

Two distinct sub-problems:
1. **"Never used"** may mean TURN candidates are never gathered, or they
   are gathered but never selected. Currently the agent has no visibility —
   you can read the per-candidate log stream, but there's no summary and no
   warning when zero relay candidates are gathered.
2. **8s grace is too short** for pion's ICE agent to finish probing alternate
   candidate pairs (including relay) when Tailscale flaps. pion will naturally
   fall back to TURN if the relay candidate is in its pool, but the grace
   timer kills the session before it gets there.

A true ICE restart would be better, but requires the **viewer** to re-offer
with `ICERestart: true` — pion v4 does not expose `RestartICE()` on the
answerer side. Out of scope for this patch.

## Logical changes (apply to `agent/internal/remote/desktop/session_webrtc.go`)

### 1. Add `sync` import

```go
import (
	"fmt"
	"log/slog"
	"sync"    // NEW
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	...
)
```

### 2. Add `logSelectedPair` helper + call from ICE state handler

Place immediately before the existing `peerConn.OnICEConnectionStateChange`
call (currently line 412 in the file being actively edited).

```go
// Helper for logging the ICE-selected candidate pair. Lets us tell a
// Tailscale peer-reflexive pair apart from a TURN relay fallback in logs.
logSelectedPair := func(context string) {
	sctp := peerConn.SCTP()
	if sctp == nil {
		return
	}
	dtls := sctp.Transport()
	if dtls == nil {
		return
	}
	ice := dtls.ICETransport()
	if ice == nil {
		return
	}
	pair, perr := ice.GetSelectedCandidatePair()
	if perr != nil || pair == nil {
		slog.Info("ICE selected pair", "session", sessionID, "context", context, "pair", "none")
		return
	}
	localType, remoteType := "nil", "nil"
	localAddr, remoteAddr := "", ""
	if pair.Local != nil {
		localType = pair.Local.Typ.String()
		localAddr = fmt.Sprintf("%s:%d", pair.Local.Address, pair.Local.Port)
	}
	if pair.Remote != nil {
		remoteType = pair.Remote.Typ.String()
		remoteAddr = fmt.Sprintf("%s:%d", pair.Remote.Address, pair.Remote.Port)
	}
	slog.Info("ICE selected pair",
		"session", sessionID,
		"context", context,
		"localType", localType,
		"localAddr", localAddr,
		"remoteType", remoteType,
		"remoteAddr", remoteAddr,
	)
}
```

Then extend the existing `OnICEConnectionStateChange` closure to also log the
selected pair when ICE reaches connected / completed — that's the first point
at which `GetSelectedCandidatePair()` returns non-nil:

```go
peerConn.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
	slog.Warn("Desktop WebRTC ICE state", "session", sessionID, "state", state.String())
	switch state {
	case webrtc.ICEConnectionStateConnected, webrtc.ICEConnectionStateCompleted:
		logSelectedPair("ice-" + state.String())
	}
})
```

### 3. Extend disconnect grace to 20s + log selected pair on transitions

In the existing `OnConnectionStateChange` switch (currently line 429):

```go
switch state {
case webrtc.PeerConnectionStateConnected:
	logSelectedPair("connected")   // NEW
	session.startStreaming()

case webrtc.PeerConnectionStateDisconnected:
	logSelectedPair("disconnected")  // NEW
	// 20s grace — dimensioned for Tailscale flaps and short transient
	// path loss. During this window pion's ICE agent retries all
	// gathered candidate pairs (including relay) and can recover
	// without any agent↔viewer signaling.
	// A true ICE restart requires the viewer to re-offer with
	// ICERestart=true (agent is the answerer) — tracked as follow-up.
	disconnectTimer = time.AfterFunc(20*time.Second, func() {   // was 8*time.Second
		currentState := peerConn.ConnectionState()
		if currentState != webrtc.PeerConnectionStateConnected {
			slog.Warn("Desktop WebRTC did not recover from disconnected state, stopping",
				"session", sessionID, "finalState", currentState.String())
			logSelectedPair("disconnect-timeout")   // NEW
			m.StopSession(sessionID)
			if m.OnSessionStopped != nil {
				go m.OnSessionStopped(sessionID)
			}
		}
	})

case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
	logSelectedPair("failed-or-closed")   // NEW
	m.StopSession(sessionID)
	if m.OnSessionStopped != nil {
		go m.OnSessionStopped(sessionID)
	}
}
```

### 4. Count ICE candidates by type; warn on zero-relay

Replace the current `peerConn.OnICECandidate` closure (currently around
line 539) with:

```go
firstCandidate := make(chan struct{}, 1)
var candMu sync.Mutex
candCounts := map[string]int{}
peerConn.OnICECandidate(func(c *webrtc.ICECandidate) {
	if c == nil {
		// pion signals end-of-gathering with a nil candidate. Summarize
		// what we gathered so we can tell whether TURN was reachable.
		// Relay candidates are the fallback path when host/srflx/prflx
		// become unreachable mid-session (e.g. Tailscale flap); no relay
		// means the session has no backup path.
		candMu.Lock()
		total := 0
		for _, n := range candCounts {
			total += n
		}
		summary := make(map[string]int, len(candCounts))
		for k, v := range candCounts {
			summary[k] = v
		}
		candMu.Unlock()
		if summary["relay"] == 0 {
			slog.Warn("ICE gathering complete with no relay candidates — TURN unreachable or unconfigured, session has no fallback path",
				"session", sessionID, "total", total, "counts", summary)
		} else {
			slog.Info("ICE gathering complete",
				"session", sessionID, "total", total, "counts", summary)
		}
		return
	}
	candMu.Lock()
	candCounts[c.Typ.String()]++
	candMu.Unlock()
	slog.Info("ICE candidate gathered",
		"session", sessionID,
		"type", c.Typ.String(),
		"protocol", c.Protocol.String(),
		"address", c.Address,
		"port", c.Port,
		"relatedAddr", c.RelatedAddress,
	)
	select {
	case firstCandidate <- struct{}{}:
	default:
	}
})
```

## Verify

```bash
cd agent
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build \
  ./internal/remote/desktop/ ./internal/heartbeat/ ./cmd/breeze-agent
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /dev/null \
  ./internal/remote/desktop/ ./internal/heartbeat/
CGO_ENABLED=0 go test -count=1 \
  ./internal/remote/desktop/ ./internal/heartbeat/
```

All four passed cleanly in the original session before revert.

## What to query after deploying

```sql
-- Did TURN candidates gather at all?
SELECT timestamp, message, fields
FROM agent_logs
WHERE device_id = '<device-uuid>'
  AND message LIKE 'ICE gathering complete%'
ORDER BY timestamp DESC LIMIT 10;

-- Which candidate pair is actually being used?
SELECT timestamp, fields->>'context' AS ctx,
       fields->>'localType' AS lt, fields->>'remoteType' AS rt,
       fields->>'localAddr' AS la, fields->>'remoteAddr' AS ra
FROM agent_logs
WHERE device_id = '<device-uuid>'
  AND message = 'ICE selected pair'
ORDER BY timestamp DESC LIMIT 20;
```

If `ICE gathering complete with no relay candidates` ever fires, the root
cause is upstream (API `TURN_HOST` env var unset, or TURN server unreachable
from the agent's network) — not an agent bug.

## Why this was reverted the first time

Unrelated "5-frame death" debugging required trimming log surface in the same
file. The diagnostics here are additive but collided with in-flight work, so
they're parked here for a second agent to re-apply after the 5-frame fix lands.

## Relationship to #434

Items 1-4 were applied while investigating #434 (viewer disconnects on
remote user logout instead of handing off to loginwindow). The root cause of
#434 turned out to be in `heartbeat.go` (`executeCommand` dedup'ing `start_desktop`
retries because the viewer re-uses the same `commandId` across reconnect
attempts), not in `session_webrtc.go`. However applying items 1-4 in parallel
confirmed two useful facts from the same repro:

1. **TURN is reachable.** `ICE gathering complete total=3 counts=map[relay:1 srflx:2]`
   fired on the fix-validation run. The Apr 12 handoff hypothesis "TURN never used"
   is correct at the "not selected" level but wrong at the "not gathered" level.
   pion has the relay candidate in the pool; it picks the lower-latency peer-reflexive
   (Tailscale) path unless that dies.
2. **Tailscale is the load-bearing path.** `ICE selected pair` confirms
   `localType=host localAddr=<agent-tailscale-ip>:<port> remoteType=prflx
   remoteAddr=<viewer-tailscale-ip>:<port>` — media flows over Tailscale, not
   TURN relay. A Tailscale flap still kills the session today because the
   8→20s grace window isn't long enough for pion to switch to relay (and
   requires viewer-side ICE restart to actually switch, which pion v4 doesn't
   expose on the answerer).

## Item 5 — Gate chatty diagnostics behind a `desktop_debug` config flag

### Motivation

The Apr 12 cherry-picked commits (`ad2f1849`, `48a75d7e`, etc.) promoted
several diagnostics from `slog.Info` to `slog.Warn` **as a shipping hack** —
the agent's default `log_shipping_level=warn` would otherwise drop info-level
logs before they reached the API. That worked for the immediate debugging
session but left the code with semantically wrong log levels. In a normal
production session the shipper now persists roughly:

- ~720 × `H264 frame sent` per hour (heartbeat every 150 frames ≈ 5s at 30fps)
- 5-10 × `Desktop WebRTC ICE state` / `Desktop WebRTC connection state`
- 1-N × `findActiveHelper: picked console session directly`

Per active session. That noise masks real warnings and burns `agent_logs`
storage on a high-cardinality table.

### Design

**Stop using log level as a shipping mechanism.** Separate the two axes:

- **Log level** = semantic severity of the event. Frame-sent heartbeats are
  `slog.Info`. Disconnect-timeouts and fallbacks are `slog.Warn`.
- **Shipping level** = operator choice of how much to persist per agent. Set
  via config; can be overridden temporarily for a single agent via the
  `desktop_debug` flag below.

### Lifecycle classification

**Permanent `slog.Warn`** — low frequency, always actionable, never gated:

- `findActiveHelper: picked console alternative`
- `findActiveHelper: picked non-disconnected alternative`
- `findActiveHelper: target WTS session no longer exists, falling back to any capable helper`
- `findActiveHelper: falling through to first-pick session`
- `helper panic caught at top level`
- `Desktop WebRTC did not recover from disconnected state, stopping`
- `ICE gathering complete with no relay candidates — TURN unreachable...`
- `helper is in a disconnected Windows session, will try spawning new helper first`
- `helper spawn failed`
- `Dropping oversized P-frame to prevent jitter burst`

**Demoted to `slog.Info`, gated behind `desktop_debug`** — high frequency
or chatty, only useful when actively diagnosing:

- `Desktop WebRTC ICE state` (transitions)
- `Desktop WebRTC connection state` (transitions)
- `findActiveHelper: picked console session directly` (hot path, every start_desktop)
- `H264 frame sent` (every 150 frames)
- `ICE candidate gathered` (per candidate)
- `ICE selected pair` (per transition; already `Info`)
- `ICE gathering complete` non-warning branch (already `Info`)
- `Failed to start audio capture` (cosmetic on login screens)

### Config mechanism

Add a new field to `agent/internal/config/config.go`:

```go
type Config struct {
    // ... existing fields ...

    // DesktopDebug enables verbose remote-desktop diagnostics. When true,
    // the agent's log shipper is forced to ship info-level logs from the
    // desktop and heartbeat components, which surfaces per-frame
    // heartbeats, per-candidate ICE gathering, WebRTC state transitions,
    // and findActiveHelper routing decisions. Leave off in production;
    // flip on via agent.yaml when debugging a specific device.
    DesktopDebug bool `mapstructure:"desktop_debug" yaml:"desktop_debug"`
}
```

Wire it into the shipper init path. Both the main agent (`main.go`
`startAgent`) and each helper process (`runHelperProcess` in `main.go`) set
up the log shipper via `logging.InitShipper(...)`. Add a shipping-level
override when `cfg.DesktopDebug` is true:

```go
shipLevel := cfg.LogShippingLevel
if cfg.DesktopDebug && (shipLevel == "" || shipLevel == "warn") {
    shipLevel = "info"
}
logging.InitShipper(logging.ShipperConfig{
    ServerURL:    cfg.ServerURL,
    AgentID:      cfg.AgentID,
    AuthToken:    helperToken,
    AgentVersion: version + "-helper",
    MinLevel:     shipLevel,
})
```

(The override keeps `desktop_debug` from *reducing* shipping — if the
operator has already set `log_shipping_level: debug` manually, that takes
precedence.)

### Code changes

1. **`agent/internal/remote/desktop/session_webrtc.go`** — demote the following
   to `slog.Info`:

   ```go
   slog.Warn("Desktop WebRTC ICE state", ...)          → slog.Info
   slog.Warn("Desktop WebRTC connection state", ...)   → slog.Info
   ```

   (`logSelectedPair` is already `slog.Info` — no change.)

2. **`agent/internal/remote/desktop/session_capture.go`** — demote the frame
   heartbeat:

   ```go
   slog.Warn("H264 frame sent", ...)  → slog.Info
   ```

   Note: `Dropping oversized P-frame` stays at `slog.Warn` — it's a real
   quality event, low frequency.

3. **`agent/internal/heartbeat/handlers_desktop_helper.go`** — demote the
   hot-path `findActiveHelper: picked console session directly` to `slog.Info`.
   Keep the other `findActiveHelper:` warns (fallback, picked alternative,
   falling through) at `slog.Warn` — they're the interesting cases.

4. **`agent/internal/config/config.go`** — add `DesktopDebug bool` field.

5. **`agent/cmd/breeze-agent/main.go`** — in both `startAgent` and
   `runHelperProcess`, apply the shipping-level override shown above when
   `cfg.DesktopDebug` is true.

6. **`agent/internal/config/config.go`** validator — no constraint needed;
   default `false` is fine.

### Rollout

- Ship the demotion + config field together as a single commit on the same
  branch as the #434 fixes.
- Default is `desktop_debug: false` — production sessions ship the minimal
  set of warn-level events.
- When debugging, edit `C:\ProgramData\Breeze\agent.yaml` (or macOS/Linux
  equivalent), set `desktop_debug: true`, `Restart-Service BreezeAgent`.
  Info-level logs from the desktop/heartbeat components now flow through
  the shipper.
- **Future:** expose `desktop_debug` via the Configuration Policy system so
  an operator can flip it from the web UI on a per-agent basis without SSH.
  Out of scope for this patch.

### Verify

```bash
# With desktop_debug=false (default) — warn-only
pnpm --filter=@breeze/api --dir apps/api exec vitest run routes/agents/heartbeat.test.ts
docker exec -i breeze-postgres psql -U breeze -d breeze -c \
  "SELECT level, COUNT(*) FROM agent_logs
   WHERE device_id='<dev-device>' AND timestamp > now() - interval '1 hour'
   GROUP BY level;"
# Expected: only warn+ entries, ~dozens per hour, not thousands

# With desktop_debug=true
# Edit agent.yaml, restart service, connect viewer, run for 1 min
# Expected: info-level Desktop WebRTC ICE state / connection state /
#           H264 frame sent / findActiveHelper rows appear
```

### Why not a build tag or env var

- **Build tag** (e.g. `//go:build desktopdebug`) — requires rebuild to toggle,
  no field ops path.
- **Env var** (e.g. `BREEZE_DESKTOP_DEBUG=1`) — requires service restart
  *and* edit to the service's environment; harder than editing agent.yaml
  which the operator already knows.
- **agent.yaml field** — restart required to pick up, but same file they
  already touch for `log_shipping_level`. Lowest friction.
