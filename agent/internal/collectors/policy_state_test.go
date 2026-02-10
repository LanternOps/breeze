package collectors

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExtractConfigValue(t *testing.T) {
	content := `
# sshd config
PermitRootLogin no
PasswordAuthentication = yes
ChallengeResponseAuthentication yes # inline comment
UsePAM: no
ProxyURL http://proxy.example:8080
`

	tests := []struct {
		key      string
		expected string
		found    bool
	}{
		{key: "PermitRootLogin", expected: "no", found: true},
		{key: "PasswordAuthentication", expected: "yes", found: true},
		{key: "ChallengeResponseAuthentication", expected: "yes", found: true},
		{key: "UsePAM", expected: "no", found: true},
		{key: "ProxyURL", expected: "http://proxy.example:8080", found: true},
		{key: "MissingKey", expected: "", found: false},
	}

	for _, test := range tests {
		value, ok := extractConfigValue(content, test.key)
		if ok != test.found {
			t.Fatalf("key %s found mismatch: got %v want %v", test.key, ok, test.found)
		}
		if value != test.expected {
			t.Fatalf("key %s value mismatch: got %q want %q", test.key, value, test.expected)
		}
	}
}

func TestCollectConfigState(t *testing.T) {
	tempDir := t.TempDir()
	configPath := filepath.Join(tempDir, "example.conf")
	if err := os.WriteFile(configPath, []byte("Enabled=true\n"), 0600); err != nil {
		t.Fatalf("write temp config: %v", err)
	}

	collector := NewPolicyStateCollector()
	entries, err := collector.CollectConfigState([]ConfigProbe{
		{FilePath: configPath, ConfigKey: "Enabled"},
		{FilePath: configPath, ConfigKey: "Missing"},
	})
	if err != nil {
		t.Fatalf("collect config state failed: %v", err)
	}

	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}

	entry := entries[0]
	if entry.FilePath != configPath {
		t.Fatalf("file path mismatch: got %q want %q", entry.FilePath, configPath)
	}
	if entry.ConfigKey != "Enabled" {
		t.Fatalf("config key mismatch: got %q want %q", entry.ConfigKey, "Enabled")
	}
	if entry.ConfigValue != "true" {
		t.Fatalf("config value mismatch: got %v want %q", entry.ConfigValue, "true")
	}
}
