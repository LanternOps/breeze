package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

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
	"debug": true,
	"info":  true,
	"warn":  true,
	"warning": true,
	"error": true,
}

// Validate checks the config for invalid values and returns all errors found.
// Dangerous zero-values that would cause panics are clamped to safe defaults.
// Other validation errors are logged as warnings but do not prevent startup.
func (c *Config) Validate() []error {
	var errs []error

	if c.AgentID != "" && !uuidRegex.MatchString(c.AgentID) {
		errs = append(errs, fmt.Errorf("agent_id %q is not a valid UUID", c.AgentID))
	}

	if c.ServerURL != "" {
		u, err := url.Parse(c.ServerURL)
		if err != nil {
			errs = append(errs, fmt.Errorf("server_url %q is not a valid URL: %w", c.ServerURL, err))
		} else if u.Scheme != "http" && u.Scheme != "https" {
			errs = append(errs, fmt.Errorf("server_url scheme must be http or https, got %q", u.Scheme))
		}
	}

	if c.AuthToken != "" {
		for _, r := range c.AuthToken {
			if unicode.IsControl(r) {
				errs = append(errs, fmt.Errorf("auth_token contains control characters"))
				break
			}
		}
	}

	// Clamp intervals to safe range to prevent panics (e.g. rand.Int64N(0))
	if c.HeartbeatIntervalSeconds < 5 {
		errs = append(errs, fmt.Errorf("heartbeat_interval_seconds %d is below minimum 5, clamping", c.HeartbeatIntervalSeconds))
		c.HeartbeatIntervalSeconds = 5
	} else if c.HeartbeatIntervalSeconds > 3600 {
		errs = append(errs, fmt.Errorf("heartbeat_interval_seconds %d exceeds maximum 3600, clamping", c.HeartbeatIntervalSeconds))
		c.HeartbeatIntervalSeconds = 3600
	}

	if c.MetricsIntervalSeconds < 5 {
		errs = append(errs, fmt.Errorf("metrics_interval_seconds %d is below minimum 5, clamping", c.MetricsIntervalSeconds))
		c.MetricsIntervalSeconds = 5
	} else if c.MetricsIntervalSeconds > 3600 {
		errs = append(errs, fmt.Errorf("metrics_interval_seconds %d exceeds maximum 3600, clamping", c.MetricsIntervalSeconds))
		c.MetricsIntervalSeconds = 3600
	}

	for _, name := range c.EnabledCollectors {
		if !knownCollectors[strings.ToLower(name)] {
			errs = append(errs, fmt.Errorf("unknown collector %q", name))
		}
	}

	if c.LogLevel != "" && !validLogLevels[strings.ToLower(c.LogLevel)] {
		errs = append(errs, fmt.Errorf("log_level %q is not valid (use debug, info, warn, error)", c.LogLevel))
	}

	if c.LogFormat != "" && c.LogFormat != "text" && c.LogFormat != "json" {
		errs = append(errs, fmt.Errorf("log_format %q is not valid (use text or json)", c.LogFormat))
	}

	// Clamp concurrency settings to safe range
	if c.MaxConcurrentCommands < 1 {
		errs = append(errs, fmt.Errorf("max_concurrent_commands %d is below minimum 1, clamping", c.MaxConcurrentCommands))
		c.MaxConcurrentCommands = 1
	} else if c.MaxConcurrentCommands > 100 {
		errs = append(errs, fmt.Errorf("max_concurrent_commands %d exceeds maximum 100, clamping", c.MaxConcurrentCommands))
		c.MaxConcurrentCommands = 100
	}

	if c.CommandQueueSize < 1 {
		errs = append(errs, fmt.Errorf("command_queue_size %d is below minimum 1, clamping", c.CommandQueueSize))
		c.CommandQueueSize = 1
	} else if c.CommandQueueSize > 10000 {
		errs = append(errs, fmt.Errorf("command_queue_size %d exceeds maximum 10000, clamping", c.CommandQueueSize))
		c.CommandQueueSize = 10000
	}

	// Log validation errors as warnings
	for _, err := range errs {
		slog.Warn("config validation", "error", err)
	}

	return errs
}
