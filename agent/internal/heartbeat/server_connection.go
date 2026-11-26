package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
)

// serverConnectionComponentName is the health component that tells the server
// whether this agent talks to it unencrypted (#12729). It rides the existing
// healthStatus observation, so the server stores it without a schema change.
const serverConnectionComponentName = "server_connection"

// serverConnectionPlaintextReason is the component reason when server_url is
// http:// to a host that is not this machine: the WebSocket is plain ws:// and
// the heartbeat is plain HTTP. A closed value the server matches on; keep it in
// step with apps/api (AGENT_HEALTH_PLAINTEXT_SERVER_CONNECTION).
const serverConnectionPlaintextReason = "plaintext_websocket"

// observeServerConnection records the server_connection component from the
// current server URL: warning when it is plaintext to a remote host (the rule
// is config.PlaintextRemoteHost), healthy otherwise. It reports only; it never
// changes the connection. Monitor.Update warn-logs every non-healthy call, so
// the component is re-recorded only when its value changes.
func (h *Heartbeat) observeServerConnection() {
	if h.healthMon == nil {
		return
	}
	status, reason := health.Healthy, ""
	if _, plaintext := config.PlaintextRemoteHost(h.serverURL()); plaintext {
		status, reason = health.Degraded, serverConnectionPlaintextReason
	}
	if c, ok := h.healthMon.Get(serverConnectionComponentName); ok && c.Status == status && c.Message == reason {
		return
	}
	h.healthMon.Update(serverConnectionComponentName, status, reason)
}
