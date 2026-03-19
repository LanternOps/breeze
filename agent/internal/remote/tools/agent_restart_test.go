package tools

import (
	"strings"
	"testing"
)

func TestIsAgentService(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{"exact match", agentServiceName, true},
		{"case insensitive", strings.ToUpper(agentServiceName), true},
		{"random service", "SomeOtherService", false},
		{"empty", "", false},
		{"partial match", agentServiceName + "-extra", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := isAgentService(tt.input)
			if got != tt.expected {
				t.Errorf("isAgentService(%q) = %v, want %v", tt.input, got, tt.expected)
			}
		})
	}
}

func TestStopServiceBlocksAgentService(t *testing.T) {
	payload := map[string]any{"name": agentServiceName}
	result := StopService(payload)
	if result.Status != "failed" {
		t.Errorf("StopService should fail for agent service, got status=%s", result.Status)
	}
}

func TestRestartServiceDetectsAgentService(t *testing.T) {
	if !isAgentService(agentServiceName) {
		t.Error("expected agent service name to be detected")
	}
}
