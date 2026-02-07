package config

import (
	"fmt"
	"strings"
	"testing"
)

func TestValidateTieredInvalidUUIDIsFatal(t *testing.T) {
	cfg := Default()
	cfg.AgentID = "not-a-uuid"
	result := cfg.ValidateTiered()
	if !result.HasFatals() {
		t.Fatal("invalid UUID should be fatal")
	}
	found := false
	for _, err := range result.Fatals {
		if strings.Contains(err.Error(), "not a valid UUID") {
			found = true
		}
	}
	if !found {
		t.Fatal("expected UUID validation error in fatals")
	}
}

func TestValidateTieredInvalidURLSchemeIsFatal(t *testing.T) {
	cfg := Default()
	cfg.ServerURL = "ftp://example.com"
	result := cfg.ValidateTiered()
	if !result.HasFatals() {
		t.Fatal("invalid URL scheme should be fatal")
	}
}

func TestValidateTieredControlCharsInTokenIsFatal(t *testing.T) {
	cfg := Default()
	cfg.AuthToken = "token\x00with\x01control"
	result := cfg.ValidateTiered()
	if !result.HasFatals() {
		t.Fatal("control chars in token should be fatal")
	}
}

func TestValidateTieredIntervalClampingIsWarning(t *testing.T) {
	cfg := Default()
	cfg.HeartbeatIntervalSeconds = 1 // below minimum 5
	result := cfg.ValidateTiered()

	// Should NOT be a fatal since it's auto-corrected
	if result.HasFatals() {
		t.Fatalf("clamped interval should be warning, not fatal: %v", result.Fatals)
	}
	// Should be a warning
	if len(result.Warnings) == 0 {
		t.Fatal("expected warning for clamped interval")
	}
	// Value should be clamped
	if cfg.HeartbeatIntervalSeconds != 5 {
		t.Fatalf("HeartbeatIntervalSeconds = %d, want 5 (clamped)", cfg.HeartbeatIntervalSeconds)
	}
}

func TestValidateTieredHighIntervalClampingIsWarning(t *testing.T) {
	cfg := Default()
	cfg.HeartbeatIntervalSeconds = 9999
	result := cfg.ValidateTiered()
	if result.HasFatals() {
		t.Fatalf("clamped interval should be warning, not fatal: %v", result.Fatals)
	}
	if cfg.HeartbeatIntervalSeconds != 3600 {
		t.Fatalf("HeartbeatIntervalSeconds = %d, want 3600 (clamped)", cfg.HeartbeatIntervalSeconds)
	}
}

func TestValidateTieredMetricsIntervalClamping(t *testing.T) {
	cfg := Default()
	cfg.MetricsIntervalSeconds = 0
	result := cfg.ValidateTiered()
	if result.HasFatals() {
		t.Fatalf("clamped metrics interval should be warning: %v", result.Fatals)
	}
	if cfg.MetricsIntervalSeconds != 5 {
		t.Fatalf("MetricsIntervalSeconds = %d, want 5", cfg.MetricsIntervalSeconds)
	}
}

func TestValidateTieredConcurrencyClamping(t *testing.T) {
	cfg := Default()
	cfg.MaxConcurrentCommands = 0
	cfg.CommandQueueSize = 0
	result := cfg.ValidateTiered()
	if result.HasFatals() {
		t.Fatalf("clamped concurrency should be warning: %v", result.Fatals)
	}
	if cfg.MaxConcurrentCommands != 1 {
		t.Fatalf("MaxConcurrentCommands = %d, want 1", cfg.MaxConcurrentCommands)
	}
	if cfg.CommandQueueSize != 1 {
		t.Fatalf("CommandQueueSize = %d, want 1", cfg.CommandQueueSize)
	}
}

func TestValidateTieredUnknownCollectorIsWarning(t *testing.T) {
	cfg := Default()
	cfg.EnabledCollectors = []string{"hardware", "bogus_collector"}
	result := cfg.ValidateTiered()
	if result.HasFatals() {
		t.Fatal("unknown collector should not be fatal")
	}
	found := false
	for _, err := range result.Warnings {
		if strings.Contains(err.Error(), "bogus_collector") {
			found = true
		}
	}
	if !found {
		t.Fatal("expected warning about unknown collector")
	}
}

func TestValidateTieredUnknownLogLevelIsWarning(t *testing.T) {
	cfg := Default()
	cfg.LogLevel = "verbose"
	result := cfg.ValidateTiered()
	if result.HasFatals() {
		t.Fatal("unknown log level should not be fatal")
	}
	if len(result.Warnings) == 0 {
		t.Fatal("expected warning for unknown log level")
	}
}

func TestValidateTieredInvalidLogFormatIsWarning(t *testing.T) {
	cfg := Default()
	cfg.LogFormat = "xml"
	result := cfg.ValidateTiered()
	if result.HasFatals() {
		t.Fatal("invalid log format should not be fatal")
	}
	if len(result.Warnings) == 0 {
		t.Fatal("expected warning for invalid log format")
	}
}

func TestHasFatals(t *testing.T) {
	r := ValidationResult{}
	if r.HasFatals() {
		t.Fatal("HasFatals() on empty result should be false")
	}
	r.Fatals = append(r.Fatals, fmt.Errorf("test error"))
	if !r.HasFatals() {
		t.Fatal("HasFatals() should be true with a fatal error")
	}
}

func TestAllErrorsReturnsBoth(t *testing.T) {
	cfg := Default()
	cfg.ServerURL = "ftp://bad"              // fatal
	cfg.EnabledCollectors = []string{"fake"} // warning
	result := cfg.ValidateTiered()

	all := result.AllErrors()
	if len(all) < 2 {
		t.Fatalf("AllErrors() returned %d errors, expected at least 2 (fatals + warnings)", len(all))
	}
}

func TestValidConfigHasNoErrors(t *testing.T) {
	cfg := Default()
	cfg.AgentID = "12345678-1234-1234-1234-123456789abc"
	cfg.ServerURL = "https://example.com"
	cfg.AuthToken = "clean-token"
	result := cfg.ValidateTiered()
	if result.HasFatals() {
		t.Fatalf("valid config has fatals: %v", result.Fatals)
	}
	if len(result.Warnings) > 0 {
		t.Fatalf("valid config has warnings: %v", result.Warnings)
	}
}
