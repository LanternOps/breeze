package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// #12690 — the workspace-index client builds its default base from the agent
// ID; dropping it from the wiring would make every call fail with
// ErrNoAgentID (and, before the fix, sent ID-less paths that 401).
func TestWorkspaceIndexClientConfigCarriesAgentIDAndEndpointBase(t *testing.T) {
	cfg := &config.Config{AgentID: "agent-123"}
	cfg.WorkspaceIndex.EndpointBase = "/custom/base"
	serverURL := func() string { return "https://server.test" }

	got := workspaceIndexClientConfig(cfg, serverURL, nil, nil, nil)

	if got.AgentID != "agent-123" {
		t.Errorf("AgentID = %q, want %q", got.AgentID, "agent-123")
	}
	if got.EndpointBase != "/custom/base" {
		t.Errorf("EndpointBase = %q, want %q", got.EndpointBase, "/custom/base")
	}
	if got.ServerURL == nil || got.ServerURL() != "https://server.test" {
		t.Error("ServerURL provider was not passed through")
	}
}
