package sim

import "testing"

func TestRouteKeyTemplatesEveryAgentPath(t *testing.T) {
	for _, tc := range []struct{ method, path, want string }{
		{"POST", "/api/v1/agents/abc123/heartbeat", RouteHeartbeat},
		{"GET", "/api/v1/agents/abc123/unifi-collectors", RouteUnifi},
		{"PUT", "/api/v1/agents/abc123/security/status", RouteSecurity},
		{"POST", "/api/v1/agents/abc123/commands/9f1c/result", RouteCommandResult},
		{"POST", "/api/v1/agents/enroll", RouteEnroll},
		{"GET", "/api/v1/agent-ws/abc123/ws", RouteWSUpgrade},
		{"GET", "/api/v1/workspace/agent/crawl-config", RouteCrawlConfig},
	} {
		if got := RouteKey(tc.method, tc.path); got != tc.want {
			t.Errorf("RouteKey(%s %s) = %q, want %q", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestSteadyStateRoutesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range SteadyStateRoutes() {
		if seen[r] {
			t.Fatalf("duplicate route %q", r)
		}
		seen[r] = true
	}
	if len(seen) != 17 {
		t.Fatalf("SteadyStateRoutes has %d routes, want 17", len(seen))
	}
}
