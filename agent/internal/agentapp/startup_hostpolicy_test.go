package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// checkPersistedServerAllowed is a pure predicate: it reports the violation
// (hosted build + persisted primary ServerURL outside the allowlist) but does
// not itself decide warn-vs-hard-fail — that split lives in runAgent, gated
// on hostpolicy.Strict().
func TestCheckPersistedServerAllowed(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	if err := checkPersistedServerAllowed(&config.Config{ServerURL: "https://selfhosted.example"}); err == nil {
		t.Fatal("hosted build must report a violation for a non-allowlisted persisted server")
	}
	if err := checkPersistedServerAllowed(&config.Config{ServerURL: "https://hosted-a.example"}); err != nil {
		t.Fatalf("hosted build must not report a violation for an allowlisted persisted server, got %v", err)
	}
	if err := checkPersistedServerAllowed(&config.Config{ServerURL: ""}); err != nil {
		t.Fatalf("empty (unenrolled) server must not report a violation, got %v", err)
	}
}

func TestCheckPersistedServerAllowed_SelfHost(t *testing.T) {
	if err := checkPersistedServerAllowed(&config.Config{ServerURL: "https://anything.example"}); err != nil {
		t.Fatalf("self-host must never report a violation, got %v", err)
	}
}
