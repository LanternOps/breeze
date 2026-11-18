package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestRecoveryDependencyBoundary(t *testing.T) {
	goPath, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go is not on PATH")
	}
	out, err := exec.Command(goPath, "list", "-deps", ".").CombinedOutput()
	if err != nil {
		t.Fatalf("go list -deps failed: %v\n%s", err, out)
	}
	forbidden := map[string]bool{
		"github.com/breeze-rmm/agent/internal/heartbeat":    true,
		"github.com/breeze-rmm/agent/internal/config":       true,
		"github.com/breeze-rmm/agent/internal/updater":      true,
		"github.com/breeze-rmm/agent/internal/remote/tools": true,
	}
	for _, dep := range strings.Fields(string(out)) {
		if forbidden[dep] {
			t.Errorf("recovery links forbidden package %s", dep)
		}
	}
}
