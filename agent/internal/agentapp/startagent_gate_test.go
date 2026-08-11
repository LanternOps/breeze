package agentapp

import (
	"bytes"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
	"github.com/breeze-rmm/agent/internal/logging"
)

// TestEnforceBuildModeGate_Gap proves the untested half of startAgent's
// gap/strict wiring: a gap build (allowlist set, strict off) with a
// non-allowlisted persisted server must NOT exit and must let startup
// proceed past the check (enforceBuildModeGate returns nil).
func TestEnforceBuildModeGate_Gap(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	// strictMode intentionally left off (gap build default).

	exited := false
	origExit := osExit
	osExit = func(code int) { exited = true }
	t.Cleanup(func() { osExit = origExit })

	cfg := &config.Config{ServerURL: "https://selfhosted.example"}
	if err := enforceBuildModeGate(cfg); err != nil {
		t.Fatalf("gap build must not fail startup, got %v", err)
	}
	if exited {
		t.Fatal("gap build must not call osExit")
	}
}

// TestEnforceBuildModeGate_Strict proves the strict half: a strict build
// with a non-allowlisted persisted server must call osExit(1) and return a
// non-nil error (the refusal path startAgent's caller relies on).
func TestEnforceBuildModeGate_Strict(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	var exitCode int
	exited := false
	origExit := osExit
	osExit = func(code int) { exited = true; exitCode = code }
	t.Cleanup(func() { osExit = origExit })

	cfg := &config.Config{ServerURL: "https://selfhosted.example"}
	err := enforceBuildModeGate(cfg)
	if err == nil {
		t.Fatal("strict build must return a non-nil error (refusal path)")
	}
	if !exited || exitCode != 1 {
		t.Fatalf("strict build must call osExit(1); exited=%v code=%d", exited, exitCode)
	}
}

// TestEnforceBuildModeGate_SelfHost is the untouched-by-default control: the
// repo-default self-host build must never exit or fail startup, regardless
// of the persisted server URL.
func TestEnforceBuildModeGate_SelfHost(t *testing.T) {
	origExit := osExit
	osExit = func(code int) { t.Fatalf("self-host must never call osExit, got code %d", code) }
	t.Cleanup(func() { osExit = origExit })

	cfg := &config.Config{ServerURL: "https://anything.example"}
	if err := enforceBuildModeGate(cfg); err != nil {
		t.Fatalf("self-host build must not fail startup, got %v", err)
	}
}

// TestEnforceBuildModeGate_LogAllowedHosts pins item 5's log-line fix at the
// wiring level: self-host logs no allowedHosts attribute, while an enforced
// (gap or strict) build does.
func TestEnforceBuildModeGate_LogAllowedHosts(t *testing.T) {
	origExit := osExit
	osExit = func(code int) {}
	t.Cleanup(func() { osExit = origExit })

	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	if err := enforceBuildModeGate(&config.Config{}); err != nil {
		t.Fatalf("self-host must not fail startup, got %v", err)
	}
	if strings.Contains(buf.String(), "allowedHosts") {
		t.Errorf("self-host build-mode log must not include allowedHosts, got: %s", buf.String())
	}

	buf.Reset()
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()
	if err := enforceBuildModeGate(&config.Config{ServerURL: "https://hosted-a.example"}); err != nil {
		t.Fatalf("gap build with an allowlisted server must not fail startup, got %v", err)
	}
	if !strings.Contains(buf.String(), "allowedHosts") {
		t.Errorf("enforced build-mode log must include allowedHosts, got: %s", buf.String())
	}
}
