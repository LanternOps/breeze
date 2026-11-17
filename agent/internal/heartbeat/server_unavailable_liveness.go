package heartbeat

import (
	"errors"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/state"
)

// isServerOverloadStatus reports whether an HTTP answer means "the server is
// up but shedding load" rather than "this request or this agent is wrong":
// 429 and 503 from rate limiting / admission control / DB-saturation
// shedding, and 502/504 from the edge proxy while the API behind it is
// restarting or saturated. 500 is excluded — it can be caused by what this
// agent sent, and a restart may legitimately clear that.
func isServerOverloadStatus(code int) bool {
	switch code {
	case http.StatusTooManyRequests,
		http.StatusBadGateway,
		http.StatusServiceUnavailable,
		http.StatusGatewayTimeout:
		return true
	}
	return false
}

// serverOverloadAnswer extracts the overload status the server answered with
// from an httputil.Do error, if it answered at all during that call. A call
// in which no attempt got an HTTP answer (refused, reset, DNS, TLS, timeout
// before any response) returns false: from inside the agent that cannot be
// told apart from a broken transport on this side, which a restart or the
// watchdog's FAILOVER channel exists to work around. One overload answer
// followed by a transport failure within the same call does count — the
// transport demonstrably reached the server moments earlier, and an
// overloaded server resetting or stalling connections is the expected
// pattern, not evidence of a broken agent.
func serverOverloadAnswer(err error) (int, bool) {
	var rse *httputil.RetryableStatusError
	if !errors.As(err, &rse) || !isServerOverloadStatus(rse.StatusCode) {
		return 0, false
	}
	return rse.StatusCode, true
}

// noteServerUnavailableLiveness tells the watchdog that this agent is running
// its heartbeat loop and reached the server, but the server answered with an
// overload status (#8934; decision 2 on #8148). LastHeartbeat only advances
// on HTTP 200, so without this an agent riding out an API overload reads as
// wedged and the watchdog restarts it — one more reconnect and full re-sync
// against the server that is already shedding load. Written to agent.state
// AND sent over IPC, like the auth-rejected marker (#2763: the file alone is
// not reliable on AV/EDR-locked hosts).
func (h *Heartbeat) noteServerUnavailableLiveness(status int) {
	now := time.Now()
	log.Warn("heartbeat answered with server overload status; recording liveness marker",
		"status", status)
	if h.statePath != "" {
		if err := state.UpdateServerUnavailable(h.statePath, now); err != nil {
			log.Warn("failed to update state file server-unavailable marker", "error", err.Error())
		}
	}
	if h.sessionBroker == nil {
		return
	}
	sess := h.sessionBroker.PreferredSessionWithScope("watchdog")
	if sess == nil {
		log.Debug("no watchdog session; server-unavailable marker written to agent.state only")
		return
	}
	// LastHeartbeat stays empty: this must never read as a successful
	// heartbeat, to this watchdog or to one that predates the field.
	if err := sess.SendNotify("", ipc.TypeStateSync, ipc.StateSync{
		AgentVersion:        h.agentVersion,
		Connected:           false,
		ServerUnavailableAt: now.Format(time.RFC3339),
		ActiveBackupRuns:    h.sessionBroker.ActiveBackupRunCount(),
	}); err != nil {
		log.Warn("failed to send server-unavailable state_sync to watchdog", "error", err.Error())
	}
}

// noteControlPlaneBlockedLiveness tells the watchdog that this agent is running
// its heartbeat loop but a network filter is blocking its control plane
// (#8868). A restart cannot lift the filter, and a blocked agent fails every
// tick for as long as the filter stands, so without this marker the watchdog
// restart-churns it. Written to agent.state AND sent over IPC, like the
// server-unavailable marker (#2763). The WARN is logged once per streak (see
// clearControlPlaneBlockedLatch), not per call.
func (h *Heartbeat) noteControlPlaneBlockedLiveness() {
	now := time.Now()
	if h.controlPlaneBlockedWarned.CompareAndSwap(false, true) {
		log.Warn("control plane blocked by a network filter; recording liveness marker")
	}
	// Per-tick failures stay at Debug (a blocked agent fails every tick for
	// days), but a streak in which neither channel recorded the marker is
	// warned once: the watchdog would otherwise restart-churn the agent.
	var fileErr, ipcErr error
	fileOK := false
	if h.statePath != "" {
		if fileErr = state.UpdateControlPlaneBlocked(h.statePath, now); fileErr != nil {
			log.Debug("failed to update state file control-plane-blocked marker", "error", fileErr.Error())
		} else {
			fileOK = true
		}
	}
	ipcOK := false
	if h.sessionBroker != nil {
		if sess := h.sessionBroker.PreferredSessionWithScope("watchdog"); sess == nil {
			log.Debug("no watchdog session for the control-plane-blocked marker")
		} else if ipcErr = sess.SendNotify("", ipc.TypeStateSync, ipc.StateSync{
			// LastHeartbeat stays empty: this must never read as a successful
			// heartbeat, to this watchdog or to one that predates the field.
			AgentVersion:          h.agentVersion,
			Connected:             false,
			ControlPlaneBlockedAt: now.Format(time.RFC3339),
			ActiveBackupRuns:      h.sessionBroker.ActiveBackupRunCount(),
		}); ipcErr != nil {
			log.Debug("failed to send control-plane-blocked state_sync to watchdog", "error", ipcErr.Error())
		} else {
			ipcOK = true
		}
	}
	if !fileOK && !ipcOK && h.controlPlaneBlockedUnrecordedWarned.CompareAndSwap(false, true) {
		attrs := []any{"state_path_set", h.statePath != ""}
		if fileErr != nil {
			attrs = append(attrs, "state_error", fileErr.Error())
		}
		if ipcErr != nil {
			attrs = append(attrs, "ipc_error", ipcErr.Error())
		}
		log.Warn("control-plane-blocked liveness marker not recorded; the watchdog may restart this agent", attrs...)
	}
}

// clearControlPlaneBlockedLatch ends a blocked streak so the next one logs its
// WARN again. Call on a successful heartbeat.
func (h *Heartbeat) clearControlPlaneBlockedLatch() {
	h.controlPlaneBlockedWarned.Store(false)
	h.controlPlaneBlockedUnrecordedWarned.Store(false)
}
