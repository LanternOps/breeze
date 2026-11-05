// Package oemupdates runs hardware vendors' own update tools.
package oemupdates

import (
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("oemupdates")

// toolAvailabilityTTL is how long an answer about a vendor tool is trusted.
// Same TTL as the collectors' host probes (#10911): a tool is installed rarely,
// and a machine without one should pay for one check a day.
const toolAvailabilityTTL = 24 * time.Hour

const toolStateChangedLog = "vendor tool availability changed"

// ToolState is the answer to "is this tool here, where, and which version".
type ToolState struct {
	Present   bool
	Path      string
	Version   string
	CheckedAt time.Time
}

func (s ToolState) sameTool(other ToolState) bool {
	return s.Present == other.Present && s.Path == other.Path && s.Version == other.Version
}

// ToolGate caches a ToolState, in the shape of collectors.cachedHostProbe plus
// Invalidate. It is a local copy because collectors keeps its type unexported.
//
// The gate is NOT the security check. It says where a tool appears to be; the
// signature and publisher are verified fresh immediately before every execution,
// never from this cache. Installing a tool or failing that verification must call
// Invalidate.
//
// A missing tool is normal, so an absent answer is cached like any other and
// nothing here logs above DEBUG. detect must not spawn a process.
type ToolGate struct {
	name   string
	ttl    time.Duration
	detect func() ToolState
	now    func() time.Time

	mu       sync.Mutex
	value    ToolState
	valid    bool
	answered bool
}

// NewToolGate returns a gate for one tool. name appears only in logs. A nil
// detect reports the tool absent.
func NewToolGate(name string, detect func() ToolState) *ToolGate {
	if detect == nil {
		detect = func() ToolState { return ToolState{} }
	}
	return &ToolGate{name: name, ttl: toolAvailabilityTTL, detect: detect, now: time.Now}
}

// Get returns the cached answer, detecting first if there is none or it has
// expired. Detection runs under the lock so concurrent callers share one check.
func (g *ToolGate) Get() ToolState {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	// A negative age is a clock that went backwards; detect again rather than
	// trust the answer until the clock catches up.
	if age := now.Sub(g.value.CheckedAt); g.valid && age >= 0 && age < g.ttl {
		return g.value
	}
	next := g.detect()
	if !next.Present {
		next = ToolState{}
	}
	next.CheckedAt = now
	if g.answered && !next.sameTool(g.value) {
		log.Debug(toolStateChangedLog, "tool", g.name, "present", next.Present, "path", next.Path, "version", next.Version)
	}
	g.value, g.valid, g.answered = next, true, true
	return next
}

// Invalidate makes the next Get detect again. The previous answer is kept only to
// tell whether that detection found a change.
func (g *ToolGate) Invalidate() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.valid = false
}
