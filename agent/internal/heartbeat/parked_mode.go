package heartbeat

import (
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/parked"
)

// Parked mode (#8318 wave D-1a).
//
// A device enrolled into its partner's holding area (a deploy key's
// destination) is confined by the server to a short allow-list until a
// person assigns it to a customer organization; every other agent route
// answers 403 device_pending_assignment and the WebSocket upgrade is refused.
// Without a parked mode the agent kept calling all of them on their usual
// cadences (~7 refused requests and ~14 WARN lines a minute per device), and
// the startup hardware and patch inventory, refused while parked, were not
// sent again for up to a day after assignment.
//
// While parked:
//   - the heartbeat, command delivery, token rotation, rebind and TPM
//     attestation run exactly as before;
//   - the tick schedules nothing else (inventory, security, sessions,
//     posture, event logs, reliability, boot performance, hardware health,
//     time sync, helper reconciles), and loopReady refuses every route the
//     server would refuse, so a sender already in flight makes no request;
//   - the log shipper holds its buffer, the UniFi and workspace loops and
//     the WebSocket wait for the state to change (internal/parked readers).
//
// On assignment (the first successful beat without `parked: true`) every
// loop resumes at once, the WebSocket redials, and the startup sends run
// again once: inventory, hardware, patches, and reliability when due.
//
// The state lives in internal/parked; this file owns its transitions' side
// effects and the one INFO line on each.

// parkedSelfRenewInterval bounds how often a parked agent starts a
// self-initiated certificate renewal for a certificate that is merely close
// to expiry. A server that bounds parked certificates refuses parked renewal
// (403 device_pending_assignment) and issues the real certificate at
// assignment, so retrying every tick only produced a refused request and an
// error line a minute. An expired certificate is still recovered every tick.
const parkedSelfRenewInterval = time.Hour

// parkedAllowedRoutes mirrors the server's allow-list
// (apps/api/src/middleware/agentAuthParked.ts) plus the routes that
// authenticate outside agent auth (renew-cert*, rebind-confirm). Matched on
// the path after /api/v1/agents/<agentId>/; "*" matches one id segment.
var parkedAllowedRoutes = [][]string{
	{"heartbeat"},
	{"commands"},
	{"commands", "*", "result"},
	{"rotate-token"},
	{"rotate-token", "confirm"},
	{"uninstall-intent"},
	{"rebind"},
	{"rebind-confirm"},
	{"attestation", "challenge"},
	{"attestation", "complete"},
	{"renew-cert"},
	{"renew-cert", "challenge"},
	{"renew-cert", "confirm"},
}

// parkedAllowsURL reports whether a parked device may call rawURL: true for
// the allow-listed agent routes, false for every other agent route and for
// anything that is not an agent route at all (the server refuses extension
// and workspace routes for a parked device too).
func parkedAllowsURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	segs := strings.Split(strings.Trim(u.Path, "/"), "/")
	// api / v1 / agents / <id> / <route...>
	if len(segs) < 5 || segs[0] != "api" || segs[1] != "v1" || segs[2] != "agents" {
		return false
	}
	route := segs[4:]
	for _, allowed := range parkedAllowedRoutes {
		if len(allowed) != len(route) {
			continue
		}
		match := true
		for i, seg := range allowed {
			if seg != "*" && seg != route[i] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// SetParkedState shares st with this heartbeat, which owns its transitions:
// the heartbeat reports what each beat says, and logs and resumes on every
// change. Call it before Start, with the State the other loops read.
func (h *Heartbeat) SetParkedState(st *parked.State) {
	if st == nil {
		return
	}
	st.SetObserver(h.onParkedTransition)
	h.parkedState = st
}

// ParkedState is the State this heartbeat reports into.
func (h *Heartbeat) ParkedState() *parked.State { return h.parkedState }

// isParked reports whether the device is parked now. A heartbeat built
// without a State (most tests) is never parked.
func (h *Heartbeat) isParked() bool { return h.parkedState.Parked() }

// parkedRefuses reports whether the server would refuse method+rawURL because
// the device is parked. Logs nothing: entering the state logged once.
func (h *Heartbeat) parkedRefuses(rawURL string) bool {
	return h.isParked() && !parkedAllowsURL(rawURL)
}

// observeParkedBeat reports a successful heartbeat response to the state. It
// is called at the start of processHeartbeatResponse for a parked beat, so
// nothing the response triggers calls a refused route, and at the end for a
// full beat, so the resumed sends see the configuration it carried.
func (h *Heartbeat) observeParkedBeat(isParked bool) {
	h.parkedState.ObserveBeat(isParked)
}

// noteParkedRefusal checks a non-2xx response for the parked refusal and, if
// it is one, records it. It reports whether it was, so the caller can skip
// its warning: the refusal is expected while parked.
func (h *Heartbeat) noteParkedRefusal(resp *http.Response) bool {
	if !parked.IsRefusal(resp) {
		return false
	}
	h.parkedState.NoteRefusal()
	return true
}

// onParkedTransition is the State's observer: one INFO line per change, and
// the resume on leaving. It runs synchronously on the goroutine that made the
// observation; a Left comes only from processHeartbeatResponse, before the
// tick loop schedules this tick's sends.
func (h *Heartbeat) onParkedTransition(ev parked.Event) {
	switch ev.Transition {
	case parked.Entered:
		log.Info("device is waiting in its partner's holding area for assignment; "+
			"suspending inventory, telemetry, log shipping, UniFi and workspace collection and the WebSocket until it is assigned "+
			"(heartbeat, commands, credential rotation, rebind and attestation continue)",
			"signal", string(ev.Source))
	case parked.Left:
		if ev.RefusalMuted {
			// The server refused a request as parked but its beat does not
			// say so: a server older than the signal. Resume as before.
			log.Info("server does not report the holding-area state on its heartbeat; resuming normal operation",
				"parkedFor", ev.ParkedFor.Round(time.Second))
		} else {
			log.Info("device assigned; resuming every loop and re-sending startup inventory",
				"parkedFor", ev.ParkedFor.Round(time.Second))
		}
		h.resumeAfterParked(time.Now())
	}
}

// resumeAfterParked re-runs the startup sends once, staggered like a
// startup, and stamps their cadence gates so the tick that follows does not
// send them a second time. Every other cadence (security, sessions, posture,
// event logs) is already due, because the tick scheduled nothing while
// parked, and fires on the next tick.
func (h *Heartbeat) resumeAfterParked(now time.Time) {
	postReliability := h.reliabilityCol != nil && reliabilityPostDue(h.loadLastReliabilityUpdate(), now)
	h.mu.Lock()
	h.lastInventoryUpdate = now
	h.lastHardwareUpdate = now
	h.lastPatchUpdate = now
	h.nextPatchRetryAt = time.Time{}
	if postReliability {
		h.lastReliabilityUpdate = now
	}
	h.mu.Unlock()

	tasks := []startupTask{
		{name: "inventory", run: h.sendInventory},
		{name: "hardware inventory", run: h.sendHardwareInventory},
		{name: "patch inventory", run: h.sendPatchInventory},
	}
	if postReliability {
		tasks = append(tasks, startupTask{name: "reliability", run: func() { h.sendReliabilityMetrics(now) }})
	}
	startParkedResume(h, tasks)
}

// startParkedResume runs the resume tasks; a seam so tests can capture them.
// The stagger matches startup (W09): a bulk assignment would otherwise send
// every assigned device's full inventory in the same second.
var startParkedResume = func(h *Heartbeat, tasks []startupTask) {
	h.staggerStartup(tasks, startupStaggerWindow, rand.Float64, time.After)
}

// parkedSelfRenewAllowed rate-limits a self-initiated renewal of a
// certificate that has not expired yet while the device is parked; see
// parkedSelfRenewInterval. Always true when not parked.
func (h *Heartbeat) parkedSelfRenewAllowed(now time.Time) bool {
	if !h.isParked() {
		return true
	}
	last := h.parkedSelfRenewAt.Load()
	if last != 0 && now.Sub(time.Unix(0, last)) < parkedSelfRenewInterval {
		return false
	}
	return h.parkedSelfRenewAt.CompareAndSwap(last, now.UnixNano())
}
