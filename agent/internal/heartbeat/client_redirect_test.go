package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

// Heartbeat-family calls (heartbeat, command results, rebind, chat and message
// events, adjacency reports) run on this client with the device credential,
// so a redirect must stay on the server's host and port. Rule-bundle fetches
// and PAM calls use copies of this client that refuse every redirect.
func TestHeartbeatClientKeepsRedirectsOnServerHost(t *testing.T) {
	httpguardtest.RequireSameHostRedirectsOnly(t, newHeartbeatHTTPClient(nil))
}
