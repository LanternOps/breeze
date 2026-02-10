package config

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("config")

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var hexIDRegex = regexp.MustCompile(`^[0-9a-fA-F]{32,128}$`)

var knownCollectors = map[string]bool{
	"hardware": true,
	"software": true,
	"metrics":  true,
	"network":  true,
	"disks":    true,
	"patches":  true,
	"events":   true,
}

var validLogLevels = map[string]bool{
	"debug":   true,
	"info":    true,
	"warn":    true,
	"warning": true,
	"error":   true,
}

// ValidationResult separates fatal errors (prevent startup) from warnings
// (logged but allow startup).
type ValidationResult struct {
	Fatals   []error
	Warnings []error
}

// HasFatals returns true if there are any fatal validation errors.
func (r ValidationResult) HasFatals() bool {
	return len(r.Fatals) > 0
}

// AllErrors returns all errors (fatals + warnings) for backward compatibility.
func (r ValidationResult) AllErrors() []error {
	all := make([]error, 0, len(r.Fatals)+len(r.Warnings))
	all = append(all, r.Fatals...)
	all = append(all, r.Warnings...)
	return all
}

// Validate checks the config for invalid values and returns all errors as a flat list.
// Internally calls ValidateTiered, logs fatals at Error and warnings at Warn level,
// then returns all errors combined. See ValidateTiered for the structured result.
// Note: clamping side-effects mutate the Config receiver.
func (c *Config) Validate() []error {
	result := c.ValidateTiered()

	// Log fatals as errors, warnings as warnings
	for _, err := range result.Fatals {
		log.Error("config validation fatal", "error", err)
	}
	for _, err := range result.Warnings {
		log.Warn("config validation", "error", err)
	}

	return result.AllErrors()
}

// ValidateTiered performs validation and returns a structured result with
// fatals and warnings separated.
func (c *Config) ValidateTiered() ValidationResult {
	var result ValidationResult

	if c.AgentID != "" && !uuidRegex.MatchString(c.AgentID) && !hexIDRegex.MatchString(c.AgentID) {
		result.Fatals = append(result.Fatals, fmt.Errorf("agent_id %q is not a valid UUID or hex identifier", c.AgentID))
	}

	if c.ServerURL != "" {
		u, err := url.Parse(c.ServerURL)
		if err != nil {
			result.Fatals = append(result.Fatals, fmt.Errorf("server_url %q is not a valid URL: %w", c.ServerURL, err))
		} else if u.Scheme != "http" && u.Scheme != "https" {
			result.Fatals = append(result.Fatals, fmt.Errorf("server_url scheme must be http or https, got %q", u.Scheme))
		}
	}

	if c.AuthToken != "" {
		for _, r := range c.AuthToken {
			if unicode.IsControl(r) {
				result.Fatals = append(result.Fatals, fmt.Errorf("auth_token contains control characters"))
				break
			}
		}
	}

	// Clamp intervals to safe range to prevent panics (e.g. rand.Int64N(0)).
	// These are warnings (not fatals) because the value is auto-corrected.
	if c.HeartbeatIntervalSeconds < 5 {
		result.Warnings = append(result.Warnings, fmt.Errorf("heartbeat_interval_seconds %d is below minimum 5, clamped to 5", c.HeartbeatIntervalSeconds))
		c.HeartbeatIntervalSeconds = 5
	} else if c.HeartbeatIntervalSeconds > 3600 {
		result.Warnings = append(result.Warnings, fmt.Errorf("heartbeat_interval_seconds %d exceeds maximum 3600, clamped to 3600", c.HeartbeatIntervalSeconds))
		c.HeartbeatIntervalSeconds = 3600
	}

	if c.MetricsIntervalSeconds < 5 {
		result.Warnings = append(result.Warnings, fmt.Errorf("metrics_interval_seconds %d is below minimum 5, clamped to 5", c.MetricsIntervalSeconds))
		c.MetricsIntervalSeconds = 5
	} else if c.MetricsIntervalSeconds > 3600 {
		result.Warnings = append(result.Warnings, fmt.Errorf("metrics_interval_seconds %d exceeds maximum 3600, clamped to 3600", c.MetricsIntervalSeconds))
		c.MetricsIntervalSeconds = 3600
	}

	// Warnings: unknown collectors
	for _, name := range c.EnabledCollectors {
		if !knownCollectors[strings.ToLower(name)] {
			result.Warnings = append(result.Warnings, fmt.Errorf("unknown collector %q", name))
		}
	}

	// Warnings: unknown log level
	if c.LogLevel != "" && !validLogLevels[strings.ToLower(c.LogLevel)] {
		result.Warnings = append(result.Warnings, fmt.Errorf("log_level %q is not valid (use debug, info, warn, error)", c.LogLevel))
	}

	if c.LogFormat != "" && c.LogFormat != "text" && c.LogFormat != "json" {
		result.Warnings = append(result.Warnings, fmt.Errorf("log_format %q is not valid (use text or json)", c.LogFormat))
	}

	// Clamp concurrency settings to safe range.
	// These are warnings (not fatals) because the value is auto-corrected.
	if c.MaxConcurrentCommands < 1 {
		result.Warnings = append(result.Warnings, fmt.Errorf("max_concurrent_commands %d is below minimum 1, clamped to 1", c.MaxConcurrentCommands))
		c.MaxConcurrentCommands = 1
	} else if c.MaxConcurrentCommands > 100 {
		result.Warnings = append(result.Warnings, fmt.Errorf("max_concurrent_commands %d exceeds maximum 100, clamped to 100", c.MaxConcurrentCommands))
		c.MaxConcurrentCommands = 100
	}

	if c.CommandQueueSize < 1 {
		result.Warnings = append(result.Warnings, fmt.Errorf("command_queue_size %d is below minimum 1, clamped to 1", c.CommandQueueSize))
		c.CommandQueueSize = 1
	} else if c.CommandQueueSize > 10000 {
		result.Warnings = append(result.Warnings, fmt.Errorf("command_queue_size %d exceeds maximum 10000, clamped to 10000", c.CommandQueueSize))
		c.CommandQueueSize = 10000
	}

	// Patch management validation
	if c.PatchMinDiskSpaceGB != 0 {
		if c.PatchMinDiskSpaceGB < 0.5 {
			result.Warnings = append(result.Warnings, fmt.Errorf("patch_min_disk_space_gb %.1f is below minimum 0.5, clamped to 0.5", c.PatchMinDiskSpaceGB))
			c.PatchMinDiskSpaceGB = 0.5
		} else if c.PatchMinDiskSpaceGB > 50 {
			result.Warnings = append(result.Warnings, fmt.Errorf("patch_min_disk_space_gb %.1f exceeds maximum 50, clamped to 50", c.PatchMinDiskSpaceGB))
			c.PatchMinDiskSpaceGB = 50
		}
	}

	if c.PatchRebootMaxPerDay != 0 {
		if c.PatchRebootMaxPerDay < 1 {
			result.Warnings = append(result.Warnings, fmt.Errorf("patch_reboot_max_per_day %d is below minimum 1, clamped to 1", c.PatchRebootMaxPerDay))
			c.PatchRebootMaxPerDay = 1
		} else if c.PatchRebootMaxPerDay > 10 {
			result.Warnings = append(result.Warnings, fmt.Errorf("patch_reboot_max_per_day %d exceeds maximum 10, clamped to 10", c.PatchRebootMaxPerDay))
			c.PatchRebootMaxPerDay = 10
		}
	}

	if c.PatchMaintenanceStart != "" {
		if _, err := time.Parse("15:04", c.PatchMaintenanceStart); err != nil {
			result.Warnings = append(result.Warnings, fmt.Errorf("patch_maintenance_start %q is not valid HH:MM, cleared", c.PatchMaintenanceStart))
			c.PatchMaintenanceStart = ""
		}
	}
	if c.PatchMaintenanceEnd != "" {
		if _, err := time.Parse("15:04", c.PatchMaintenanceEnd); err != nil {
			result.Warnings = append(result.Warnings, fmt.Errorf("patch_maintenance_end %q is not valid HH:MM, cleared", c.PatchMaintenanceEnd))
			c.PatchMaintenanceEnd = ""
		}
	}

	// Policy state probe validation (invalid entries are dropped with warnings).
	registryProbes := make([]PolicyRegistryStateProbe, 0, len(c.PolicyRegistryStateProbes))
	for idx, probe := range c.PolicyRegistryStateProbes {
		registryPath := strings.TrimSpace(probe.RegistryPath)
		valueName := strings.TrimSpace(probe.ValueName)
		if registryPath == "" || valueName == "" {
			result.Warnings = append(result.Warnings, fmt.Errorf("policy_registry_state_probes[%d] must include registry_path and value_name; entry ignored", idx))
			continue
		}
		registryProbes = append(registryProbes, PolicyRegistryStateProbe{
			RegistryPath: registryPath,
			ValueName:    valueName,
		})
	}
	c.PolicyRegistryStateProbes = registryProbes

	configProbes := make([]PolicyConfigStateProbe, 0, len(c.PolicyConfigStateProbes))
	for idx, probe := range c.PolicyConfigStateProbes {
		filePath := strings.TrimSpace(probe.FilePath)
		configKey := strings.TrimSpace(probe.ConfigKey)
		if filePath == "" || configKey == "" {
			result.Warnings = append(result.Warnings, fmt.Errorf("policy_config_state_probes[%d] must include file_path and config_key; entry ignored", idx))
			continue
		}
		configProbes = append(configProbes, PolicyConfigStateProbe{
			FilePath:  filePath,
			ConfigKey: configKey,
		})
	}
	c.PolicyConfigStateProbes = configProbes

	return result
}
