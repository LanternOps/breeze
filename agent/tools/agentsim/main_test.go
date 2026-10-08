package main

import (
	"testing"
	"time"
)

func TestParseFlagsTakesSecretsFromTheEnvironment(t *testing.T) {
	env := map[string]string{
		"AGENTSIM_SERVER":                "http://localhost:9",
		"AGENTSIM_ENROLLMENT_KEY":        "key-from-env",
		"BREEZE_AGENT_ENROLLMENT_SECRET": "secret-from-env",
	}
	cfg, err := parseFlags([]string{"--agents", "200", "--duration", "20m", "--cadence", "heartbeat=30s"},
		func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "http://localhost:9" || cfg.EnrollmentKey != "key-from-env" || cfg.EnrollmentSecret != "secret-from-env" {
		t.Fatalf("env defaults not applied: %+v", cfg)
	}
	if cfg.Agents != 200 || cfg.Duration != 20*time.Minute || cfg.Cadence.Heartbeat != 30*time.Second {
		t.Fatalf("flags not applied: agents %d duration %s heartbeat %s", cfg.Agents, cfg.Duration, cfg.Cadence.Heartbeat)
	}
}

func TestParseFlagsRejectsAnInvalidConfig(t *testing.T) {
	if _, err := parseFlags([]string{"--agents", "0"}, func(string) string { return "" }); err == nil {
		t.Fatal("want a validation error")
	}
}
