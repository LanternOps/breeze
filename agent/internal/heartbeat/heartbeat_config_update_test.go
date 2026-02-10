package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

func TestApplyConfigUpdateParsesAndClearsPolicyProbeLists(t *testing.T) {
	h := &Heartbeat{config: config.Default()}

	h.applyConfigUpdate(map[string]any{
		"policy_registry_state_probes": []any{
			map[string]any{"registry_path": " HKLM\\SOFTWARE\\Policies\\Example ", "value_name": " Enabled "},
			map[string]any{"registry_path": "hklm\\software\\policies\\example", "value_name": "enabled"},
		},
		"policy_config_state_probes": []any{
			map[string]any{"file_path": " /etc/ssh/sshd_config ", "config_key": " PermitRootLogin "},
			map[string]any{"filePath": "/etc/ssh/sshd_config", "configKey": "permitrootlogin"},
		},
	})

	if len(h.config.PolicyRegistryStateProbes) != 1 {
		t.Fatalf("expected 1 registry probe, got %d", len(h.config.PolicyRegistryStateProbes))
	}
	if len(h.config.PolicyConfigStateProbes) != 1 {
		t.Fatalf("expected 1 config probe, got %d", len(h.config.PolicyConfigStateProbes))
	}

	if got := h.config.PolicyRegistryStateProbes[0].RegistryPath; got != "HKLM\\SOFTWARE\\Policies\\Example" {
		t.Fatalf("unexpected registry path: %q", got)
	}
	if got := h.config.PolicyRegistryStateProbes[0].ValueName; got != "Enabled" {
		t.Fatalf("unexpected registry value name: %q", got)
	}

	if got := h.config.PolicyConfigStateProbes[0].FilePath; got != "/etc/ssh/sshd_config" {
		t.Fatalf("unexpected config file path: %q", got)
	}
	if got := h.config.PolicyConfigStateProbes[0].ConfigKey; got != "PermitRootLogin" {
		t.Fatalf("unexpected config key: %q", got)
	}

	h.applyConfigUpdate(map[string]any{
		"policy_registry_state_probes": []any{},
		"policy_config_state_probes":   []any{},
	})

	if len(h.config.PolicyRegistryStateProbes) != 0 {
		t.Fatalf("expected registry probes to be cleared, got %d", len(h.config.PolicyRegistryStateProbes))
	}
	if len(h.config.PolicyConfigStateProbes) != 0 {
		t.Fatalf("expected config probes to be cleared, got %d", len(h.config.PolicyConfigStateProbes))
	}
}

func TestApplyConfigUpdateSupportsCamelCaseKeys(t *testing.T) {
	h := &Heartbeat{config: config.Default()}

	h.applyConfigUpdate(map[string]any{
		"policyRegistryStateProbes": []any{
			map[string]any{"registryPath": "HKLM\\SOFTWARE\\Policies\\Example", "valueName": "Enabled"},
		},
		"policyConfigStateProbes": []any{
			map[string]any{"filePath": "/etc/example.conf", "configKey": "Enabled"},
		},
	})

	if len(h.config.PolicyRegistryStateProbes) != 1 {
		t.Fatalf("expected 1 registry probe, got %d", len(h.config.PolicyRegistryStateProbes))
	}
	if len(h.config.PolicyConfigStateProbes) != 1 {
		t.Fatalf("expected 1 config probe, got %d", len(h.config.PolicyConfigStateProbes))
	}
}

func TestApplyConfigUpdateIgnoresInvalidProbePayloads(t *testing.T) {
	h := &Heartbeat{config: config.Default()}
	h.config.PolicyRegistryStateProbes = []config.PolicyRegistryStateProbe{
		{RegistryPath: "HKLM\\SOFTWARE\\Policies\\Example", ValueName: "Enabled"},
	}

	h.applyConfigUpdate(map[string]any{
		"policy_registry_state_probes": "invalid",
	})

	if len(h.config.PolicyRegistryStateProbes) != 1 {
		t.Fatalf("expected existing registry probes to remain unchanged, got %d", len(h.config.PolicyRegistryStateProbes))
	}
}
