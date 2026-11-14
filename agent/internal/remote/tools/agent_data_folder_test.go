package tools

import "testing"

// The agent's data folder (Linux: /var/lib/breeze, which holds keys/) is a
// protected location for the file browser.
func TestAgentDataFolderIsProtected(t *testing.T) {
	for _, p := range []string{"/var/lib/breeze", "/var/lib/breeze/keys/pam-rules.key"} {
		if err := EnforcePathContainment("read", p); err == nil {
			t.Errorf("%s: file browser accepted the agent data folder", p)
		}
	}
}
