package sim

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// budgetExempt lists steady-state routes with no API DB budget, and why.
var budgetExempt = map[string]string{
	RouteCrawlConfig: "ee/workspace extension route, mounted only with BREEZE_WORKSPACE_ENABLED; its budget belongs with that module",
}

// Every request the simulator sends per minute must have a pinned DB budget in
// the API Integration Tests job (W0d, #8151), so a new query on any hot agent
// path reds CI. The TS file owns the numbers; this only checks the keys exist.
// Adding a simulator route touches agent/**, so this runs in Test Agent.
func TestEverySteadyStateRouteHasAnAPIDBBudget(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "apps", "api", "src", "__tests__", "integration",
		"agentHotPathQueryBudget.integration.test.ts")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the API budget test (%s): %v", path, err)
	}
	for _, route := range SteadyStateRoutes() {
		if _, exempt := budgetExempt[route]; exempt {
			continue
		}
		if !strings.Contains(string(src), "'"+route+"'") {
			t.Errorf("simulator route %q has no DB budget in %s (add it to HOT_ROUTES or W0D_EXTRA_KEYS and pin it)", route, filepath.Base(path))
		}
	}
}
