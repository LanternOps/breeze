package heartbeat

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

// Loop-level Retry-After (W09, #8148, design D5). When the server answers a
// periodic route with 429/503 and a Retry-After, httputil.Do returns a
// RetryAt. The route is then skipped until that time, on every later cycle
// too, and the skip happens BEFORE anything is collected, popped or claimed,
// so a deferred cycle loses nothing a failed send would not.
//
// Never deferred: heartbeats (the watchdog restarts an agent whose
// LastHeartbeat is 3 min stale; #9146 keeps overload answers as liveness) and
// command results. See loop_deferral_contract_test.go for the full audit.

// ErrDeferred is returned by a gated sender that skipped its request because
// the server asked this route to wait. Callers treat it as a failed send.
var ErrDeferred = errors.New("deferred by server Retry-After")

// loopDeferral is the per-route not-before store. The zero value is ready to
// use. Keys are origin + method + route template (see loopKey), so a promoted
// backup server starts clean.
type loopDeferral struct {
	mu    sync.Mutex
	until map[string]time.Time
	// now is the clock; nil means time.Now. Tests set it.
	now func() time.Time
}

func (d *loopDeferral) clock() time.Time {
	if d.now != nil {
		return d.now()
	}
	return time.Now()
}

// Ready reports whether key may be called now and, when it may not, until
// when. Asking never extends a deferral. Always ready when loop-level
// Retry-After is off (config loop_retry_after=false).
func (d *loopDeferral) Ready(key string) (bool, time.Time) {
	if !httputil.LoopRetryAfterEnabled() {
		return true, time.Time{}
	}
	now := d.clock()
	d.mu.Lock()
	defer d.mu.Unlock()
	until, ok := d.until[key]
	if !ok {
		return true, time.Time{}
	}
	if !now.Before(until) {
		delete(d.until, key)
		return true, time.Time{}
	}
	return false, until
}

// Record stores the RetryAt carried by err for key and reports whether it
// set or extended the deferral. An error without a RetryAt never clears or
// shortens one; of two RetryAts the later wins.
func (d *loopDeferral) Record(key string, err error) (time.Time, bool) {
	if !httputil.LoopRetryAfterEnabled() {
		return time.Time{}, false
	}
	at, ok := httputil.RetryAtFrom(err)
	if !ok {
		return time.Time{}, false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if prev, exists := d.until[key]; exists && !at.After(prev) {
		return prev, false
	}
	if d.until == nil {
		d.until = map[string]time.Time{}
	}
	d.until[key] = at
	return at, true
}

// idSegment matches path segments that carry an identifier rather than a
// route name: UUIDs and long hex/base64url-ish tokens.
var idSegment = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9A-Za-z_-]{24,})$`)

// loopKey maps a request to its deferral key: "origin METHOD /route", with
// the agent id (the segment after /agents/) and any id-shaped segment
// replaced by ":id", so every request to one route template shares a key.
func loopKey(method, rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return method + " " + rawURL
	}
	segs := strings.Split(u.Path, "/")
	for i, s := range segs {
		if s == "" {
			continue
		}
		if (i > 0 && segs[i-1] == "agents") || idSegment.MatchString(s) {
			segs[i] = ":id"
		}
	}
	return u.Scheme + "://" + u.Host + " " + method + " " + strings.Join(segs, "/")
}

// agentRouteURL is the URL of an agent route under /api/v1/agents/:id/.
func (h *Heartbeat) agentRouteURL(route string) string {
	return h.serverURL() + "/api/v1/agents/" + h.config.AgentID + "/" + route
}

// loopReady reports whether a periodic sender may call method+url now.
func (h *Heartbeat) loopReady(method, rawURL string) bool {
	key := loopKey(method, rawURL)
	ok, until := h.loopDefer.Ready(key)
	if !ok {
		log.Debug("skipping request deferred by server Retry-After",
			"route", key, "until", until.UTC().Format(time.RFC3339),
			"remaining", time.Until(until).Round(time.Second))
	}
	return ok
}

// noteLoopAnswer records a RetryAt from a failed request, if it carried one.
func (h *Heartbeat) noteLoopAnswer(method, rawURL string, err error) {
	if err == nil {
		return
	}
	key := loopKey(method, rawURL)
	if until, set := h.loopDefer.Record(key, err); set {
		log.Info("route deferred by server Retry-After",
			"route", key, "until", until.UTC().Format(time.RFC3339),
			"remaining", time.Until(until).Round(time.Second))
	}
}
