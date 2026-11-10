package cgroup

import (
	"os"
	"strings"
	"testing"
)

// The split needs systemd to hand the unit's cgroup subtree to the agent.
// Delegate= is not a sandbox directive, so the unit stays unsandboxed.
func TestAgentUnitDelegatesItsCgroup(t *testing.T) {
	data, err := os.ReadFile("../../../service/systemd/breeze-agent.service")
	if err != nil {
		t.Fatalf("read unit: %v", err)
	}
	unit := string(data)
	service := unit[strings.Index(unit, "[Service]"):strings.Index(unit, "[Install]")]
	found := 0
	for _, line := range strings.Split(service, "\n") {
		if strings.TrimSpace(line) == "Delegate=yes" {
			found++
		}
	}
	if found != 1 {
		t.Fatalf("[Service] has %d Delegate=yes lines, want exactly 1", found)
	}
	if !strings.Contains(unit, "# INTENTIONALLY UNSANDBOXED.") {
		t.Fatal("the INTENTIONALLY UNSANDBOXED comment must stay")
	}
}
