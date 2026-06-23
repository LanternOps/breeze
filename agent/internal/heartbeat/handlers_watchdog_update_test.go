package heartbeat

import (
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestHandleUpdateWatchdogInstallsThroughVerifiedInstaller(t *testing.T) {
	var installed string
	h := &Heartbeat{
		config:       &config.Config{AutoUpdate: false},
		agentVersion: "0.66.0",
		watchdogInstaller: func(targetVersion string) error {
			installed = targetVersion
			return nil
		},
	}

	result := handleUpdateWatchdog(h, Command{
		Type: tools.CmdUpdateWatchdog,
		Payload: map[string]any{
			"version": "0.66.0",
		},
	})

	if result.Status != "completed" {
		t.Fatalf("Status = %q, Error = %q; want completed", result.Status, result.Error)
	}
	if installed != "0.66.0" {
		t.Fatalf("installed = %q, want 0.66.0", installed)
	}
	if h.watchdogInstalledVersion != "0.66.0" {
		t.Fatalf("watchdogInstalledVersion = %q, want 0.66.0", h.watchdogInstalledVersion)
	}
}

func TestHandleUpdateWatchdogBypassesLocalAutoUpdateForManualCommand(t *testing.T) {
	called := false
	h := &Heartbeat{
		config:       &config.Config{AutoUpdate: false},
		agentVersion: "0.66.0",
		watchdogInstaller: func(string) error {
			called = true
			return nil
		},
	}

	result := handleUpdateWatchdog(h, Command{
		Type: tools.CmdUpdateWatchdog,
		Payload: map[string]any{
			"version": "0.66.0",
		},
	})

	if result.Status != "completed" {
		t.Fatalf("Status = %q, Error = %q; want completed", result.Status, result.Error)
	}
	if !called {
		t.Fatal("expected manual watchdog update to bypass local AutoUpdate=false")
	}
}

func TestHandleUpdateWatchdogRejectsDevBuild(t *testing.T) {
	h := &Heartbeat{config: &config.Config{}, agentVersion: "0.66.0"}

	result := handleUpdateWatchdog(h, Command{
		Type: tools.CmdUpdateWatchdog,
		Payload: map[string]any{
			"version": "dev-local",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("Status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "refusing to install dev watchdog build") {
		t.Fatalf("Error = %q, want dev-build refusal", result.Error)
	}
}

func TestHandleUpdateWatchdogRejectsNonSemverTarget(t *testing.T) {
	h := &Heartbeat{config: &config.Config{}, agentVersion: "0.66.0"}

	result := handleUpdateWatchdog(h, Command{
		Type: tools.CmdUpdateWatchdog,
		Payload: map[string]any{
			"version": "agent-watchdog-update-abc123",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("Status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "non-semver") {
		t.Fatalf("Error = %q, want non-semver refusal", result.Error)
	}
}

func TestHandleUpdateWatchdogRejectsDowngrade(t *testing.T) {
	h := &Heartbeat{config: &config.Config{}, agentVersion: "0.82.1"}

	result := handleUpdateWatchdog(h, Command{
		Type: tools.CmdUpdateWatchdog,
		Payload: map[string]any{
			"version": "0.70.0",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("Status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "downgrade") {
		t.Fatalf("Error = %q, want downgrade refusal", result.Error)
	}
}

func TestHandleUpdateWatchdogReportsSignatureFailureReason(t *testing.T) {
	h := &Heartbeat{
		config:       &config.Config{},
		agentVersion: "0.66.0",
		watchdogInstaller: func(_ string) error {
			return fmt.Errorf("manifest signature invalid")
		},
	}

	result := handleUpdateWatchdog(h, Command{
		Type: tools.CmdUpdateWatchdog,
		Payload: map[string]any{
			"version": "0.66.0",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("Status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, watchdogRepairSignatureFailed) {
		t.Fatalf("Error = %q, want %q", result.Error, watchdogRepairSignatureFailed)
	}
}

func TestHandleUpdateWatchdogRejectsWhileInProgress(t *testing.T) {
	h := &Heartbeat{config: &config.Config{}, agentVersion: "0.66.0"}
	h.watchdogUpgradeInProgress.Store(true)

	result := handleUpdateWatchdog(h, Command{
		Type: tools.CmdUpdateWatchdog,
		Payload: map[string]any{
			"version": "0.66.0",
		},
	})

	if result.Status != "failed" {
		t.Fatalf("Status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, watchdogRepairAlreadyRunning) {
		t.Fatalf("Error = %q, want %q", result.Error, watchdogRepairAlreadyRunning)
	}
}
