package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

// Every heartbeat-family call (heartbeat, command results, rebind, PAM, chat
// and message events, adjacency reports, rule bundles) runs on this client
// with the device credential, so a redirect must stay on the server's host.
func TestHeartbeatClientKeepsRedirectsOnServerHost(t *testing.T) {
	httpguardtest.RequireSameHostRedirectsOnly(t, newHeartbeatHTTPClient(nil))
}
