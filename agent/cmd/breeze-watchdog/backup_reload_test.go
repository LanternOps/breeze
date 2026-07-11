package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

func TestDecideWatchdogServerURL(t *testing.T) {
	cases := []struct {
		name     string
		current  string
		reloaded config.Config
		failures int
		want     string
	}{
		{"agent already swapped on disk: follow it", "https://old.example.com",
			config.Config{ServerURL: "https://new.example.com"}, 1, "https://new.example.com"},
		{"below threshold, no swap on disk: stay", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 9, "https://old.example.com"},
		{"at threshold with backup: transient backup", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com", BackupServerURL: "https://new.example.com"}, 10, "https://new.example.com"},
		{"at threshold without backup: stay", "https://old.example.com",
			config.Config{ServerURL: "https://old.example.com"}, 10, "https://old.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideWatchdogServerURL(tc.current, &tc.reloaded, tc.failures)
			if got != tc.want {
				t.Fatalf("decideWatchdogServerURL(%q, ..., %d) = %q, want %q", tc.current, tc.failures, got, tc.want)
			}
		})
	}
}
