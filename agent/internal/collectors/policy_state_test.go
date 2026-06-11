package collectors

import "testing"

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
	readCount := 0
	collector := &PolicyStateCollector{
		readFile: func(filePath string) ([]byte, error) {
			readCount++
			if filePath != "/etc/ssh/sshd_config" {
				t.Fatalf("unexpected file read: %s", filePath)
			}
			return []byte("PermitRootLogin no\n"), nil
		},
	}
	entries, err := collector.CollectConfigState([]ConfigProbe{
		{FilePath: "/etc/ssh/sshd_config", ConfigKey: "PermitRootLogin"},
		{FilePath: "/etc/ssh/sshd_config", ConfigKey: "Missing"},
	})
	if err != nil {
		t.Fatalf("collect config state failed: %v", err)
	}
	if readCount != 1 {
		t.Fatalf("expected 1 file read, got %d", readCount)
	}

	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}

	entry := entries[0]
	if entry.FilePath != "/etc/ssh/sshd_config" {
		t.Fatalf("file path mismatch: got %q want %q", entry.FilePath, "/etc/ssh/sshd_config")
	}
	if entry.ConfigKey != "PermitRootLogin" {
		t.Fatalf("config key mismatch: got %q want %q", entry.ConfigKey, "PermitRootLogin")
	}
	if entry.ConfigValue != "no" {
		t.Fatalf("config value mismatch: got %v want %q", entry.ConfigValue, "no")
	}
}

func TestCollectConfigStateRejectsUnsafeProbesBeforeRead(t *testing.T) {
	collector := &PolicyStateCollector{
		readFile: func(filePath string) ([]byte, error) {
			t.Fatalf("unsafe probe should not read file: %s", filePath)
			return nil, nil
		},
	}

	entries, err := collector.CollectConfigState([]ConfigProbe{
		{FilePath: "/etc/breeze/agent.yaml", ConfigKey: "auth_token"},
		{FilePath: "/root/.ssh/config", ConfigKey: "IdentityFile"},
		{FilePath: "/etc/ssh/sshd_config", ConfigKey: "ApiToken"},
		{FilePath: "/etc/../etc/shadow", ConfigKey: "root"},
	})
	if err != nil {
		t.Fatalf("collect config state failed: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no entries for unsafe probes, got %d", len(entries))
	}
}
