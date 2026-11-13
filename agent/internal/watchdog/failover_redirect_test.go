package watchdog

import (
	"testing"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

// Both failover clients send the watchdog credential on every request.
func TestFailoverClientsKeepRedirectsOnServerHost(t *testing.T) {
	fc := NewFailoverClient(httpguardtest.Origin, "agent-1", "token", nil)
	t.Run("client", func(t *testing.T) { httpguardtest.RequireSameHostRedirectsOnly(t, fc.client) })
	t.Run("pollClient", func(t *testing.T) { httpguardtest.RequireSameHostRedirectsOnly(t, fc.pollClient) })
}
