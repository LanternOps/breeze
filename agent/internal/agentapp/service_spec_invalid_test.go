package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

// A build made with a raw -ldflags -X skips build-edition.sh, so the Spec must
// not trust the value: an invalid brand falls back to today's text.
func TestAgentServiceSpecIgnoresInvalidBrand(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		AgentServiceDisplayName: `Acme "Pro"`,
		AgentServiceDescription: "bad\nvalue",
	})
	defer restore()
	got := agentServiceSpec("BreezeAgent")
	if got.DisplayName != "Breeze RMM Agent" {
		t.Fatalf("DisplayName = %q, want the default", got.DisplayName)
	}
	if got.Description != "Breeze Remote Monitoring and Management Agent" {
		t.Fatalf("Description = %q, want the default", got.Description)
	}
}
