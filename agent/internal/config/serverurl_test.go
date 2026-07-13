package config

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func writeAgentYAML(t *testing.T, serverURL string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	body := "agent_id: dev-1\n"
	if serverURL != "" {
		body += "server_url: " + serverURL + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	return path
}

func TestPersistedServerURL(t *testing.T) {
	path := writeAgentYAML(t, "https://primary.example.com")

	got, err := PersistedServerURL(path)
	if err != nil {
		t.Fatalf("PersistedServerURL() error = %v", err)
	}
	if want := "https://primary.example.com"; got != want {
		t.Fatalf("PersistedServerURL() = %q, want %q", got, want)
	}
}

func TestPersistedServerURLErrors(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		if _, err := PersistedServerURL(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
			t.Fatal("expected an error for a missing config file")
		}
	})

	t.Run("no server_url key", func(t *testing.T) {
		if _, err := PersistedServerURL(writeAgentYAML(t, "")); err == nil {
			t.Fatal("expected an error when server_url is absent")
		}
	})

	t.Run("malformed yaml", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "agent.yaml")
		if err := os.WriteFile(path, []byte("server_url: [unclosed\n"), 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := PersistedServerURL(path); err == nil {
			t.Fatal("expected a parse error for malformed yaml")
		}
	})
}

// TestPersistedServerURLProviderFollowsPromotion is the helper-process half of
// #2463: the agent persists the promoted server_url to agent.yaml, and the
// helper — which is never respawned on promotion — must pick it up rather than
// shipping to the dead primary for the rest of the logon session.
func TestPersistedServerURLProviderFollowsPromotion(t *testing.T) {
	path := writeAgentYAML(t, "https://primary.example.com")

	// ttl=1ns so the test doesn't sleep; the TTL logic itself is covered below.
	provider := NewPersistedServerURLProvider(path, "https://primary.example.com", time.Nanosecond)

	if got, want := provider(), "https://primary.example.com"; got != want {
		t.Fatalf("before promotion: provider() = %q, want %q", got, want)
	}

	// The agent promotes the backup and persists the swap.
	if err := os.WriteFile(path, []byte("server_url: https://backup.example.com\n"), 0644); err != nil {
		t.Fatal(err)
	}

	if got, want := provider(), "https://backup.example.com"; got != want {
		t.Fatalf("after promotion: provider() = %q, want %q — the helper must follow the persisted promotion (#2463)", got, want)
	}
}

// A transient read failure must NOT blank the URL: the helper keeps shipping
// to the last known good server. Losing the URL would silently stop shipping.
func TestPersistedServerURLProviderKeepsLastGoodOnReadFailure(t *testing.T) {
	path := writeAgentYAML(t, "https://primary.example.com")
	provider := NewPersistedServerURLProvider(path, "https://seed.example.com", time.Nanosecond)

	if got, want := provider(), "https://primary.example.com"; got != want {
		t.Fatalf("provider() = %q, want %q", got, want)
	}

	// Config file becomes unreadable (deleted / EACCES in a user-context helper).
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}

	if got, want := provider(), "https://primary.example.com"; got != want {
		t.Fatalf("after read failure: provider() = %q, want %q (last known good)", got, want)
	}
}

// With no readable config and no seed, the provider returns "" rather than a
// bogus URL — the shipper turns that into a named wiring error.
func TestPersistedServerURLProviderEmptyWhenNothingKnown(t *testing.T) {
	provider := NewPersistedServerURLProvider(filepath.Join(t.TempDir(), "absent.yaml"), "", time.Nanosecond)
	if got := provider(); got != "" {
		t.Fatalf("provider() = %q, want \"\"", got)
	}
}

// The TTL must actually throttle re-reads — the provider is called on every
// log flush and must not stat/parse agent.yaml more often than that.
func TestPersistedServerURLProviderRespectsTTL(t *testing.T) {
	path := writeAgentYAML(t, "https://primary.example.com")
	provider := NewPersistedServerURLProvider(path, "https://primary.example.com", time.Hour)

	if got, want := provider(), "https://primary.example.com"; got != want {
		t.Fatalf("provider() = %q, want %q", got, want)
	}

	if err := os.WriteFile(path, []byte("server_url: https://backup.example.com\n"), 0644); err != nil {
		t.Fatal(err)
	}

	// Inside the TTL window: the change must NOT be observed yet.
	if got, want := provider(), "https://primary.example.com"; got != want {
		t.Fatalf("within TTL: provider() = %q, want %q (re-read should be throttled)", got, want)
	}
}

// The shipper calls the provider from its own goroutine; -race must be clean.
func TestPersistedServerURLProviderConcurrent(t *testing.T) {
	path := writeAgentYAML(t, "https://primary.example.com")
	provider := NewPersistedServerURLProvider(path, "https://primary.example.com", time.Nanosecond)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 25; j++ {
				_ = provider()
			}
		}()
	}
	wg.Wait()
}
