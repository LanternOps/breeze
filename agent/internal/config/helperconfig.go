package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// LoadHelperConfig loads the subset of configuration a user-context helper
// process needs, reading agent.yaml ONLY and never touching secrets.yaml.
//
// Why this exists (issue #2483): the full Load() unconditionally opens
// secrets.yaml whenever it exists on disk. secrets.yaml is root/SYSTEM-only by
// design — 0600 root-owned on Unix (permissions_unix.go), an SDDL with no Users
// ACE on Windows (permissions_windows.go) — while the config DIRECTORY is
// traversable (0755 / BU:FRFX), so os.Stat succeeds and the subsequent read
// fails with EACCES/ACCESS_DENIED. Load() then returns (nil, error) in any
// helper running as the logged-in user. Both helper entry points discarded that
// error and fell back to config.Default(), whose empty AgentID/ServerURL
// silently failed the log-shipper gate — so user-session helpers shipped no
// diagnostics at all, precisely where remote-desktop / consent / capture
// features live.
//
// Everything a helper needs is deliberately kept in agent.yaml, which is
// world-readable (0644) for exactly this reason: the server URL, agent id, and
// the helper-scoped helper_auth_token (see secretKeyAllowedInAgentYAML and the
// permissions_unix.go comment). This function returns those layered over
// Default(), without the global-viper mutation or secrets.yaml dependency of
// Load(). It mirrors PersistedServerURL's partial-decode approach (PR #2477):
// no viper singleton, no ValidateTiered fatals from the missing secrets, and
// unrelated schema drift elsewhere in agent.yaml cannot break the helper load.
//
// cfgFile may be empty, in which case the default agent.yaml path is used.
func LoadHelperConfig(cfgFile string) (*Config, error) {
	cfg := Default()

	path := cfgFile
	if path == "" {
		path = defaultConfigFilePath()
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	// Decode only the keys a helper consumes. Pointers distinguish "absent"
	// (keep the Default) from "present but empty". Nothing here can pull in a
	// secrets.yaml value. If a helper ever needs another agent.yaml field, add
	// it here — keep the list to keys that genuinely live in agent.yaml.
	var parsed struct {
		AgentID          *string `yaml:"agent_id"`
		ServerURL        *string `yaml:"server_url"`
		HelperAuthToken  *string `yaml:"helper_auth_token"`
		IPCSocketPath    *string `yaml:"ipc_socket_path"`
		LogShippingLevel *string `yaml:"log_shipping_level"`
		DesktopDebug     *bool   `yaml:"desktop_debug"`
	}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}

	if parsed.AgentID != nil {
		cfg.AgentID = *parsed.AgentID
	}
	if parsed.ServerURL != nil {
		cfg.ServerURL = *parsed.ServerURL
	}
	if parsed.HelperAuthToken != nil {
		cfg.HelperAuthToken = *parsed.HelperAuthToken
	}
	if parsed.IPCSocketPath != nil {
		cfg.IPCSocketPath = *parsed.IPCSocketPath
	}
	if parsed.LogShippingLevel != nil {
		cfg.LogShippingLevel = *parsed.LogShippingLevel
	}
	if parsed.DesktopDebug != nil {
		cfg.DesktopDebug = *parsed.DesktopDebug
	}

	return cfg, nil
}
