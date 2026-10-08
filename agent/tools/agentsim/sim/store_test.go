package sim

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestStoreRoundTripAndPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "tokens.json")
	s, err := LoadStore(path, "http://localhost:1", "agentsim")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^agentsim-[0-9a-f]{6}-00007$`).MatchString(s.Hostname(7)) {
		t.Fatalf("hostname %q", s.Hostname(7))
	}
	s.Put(Identity{Index: 3, Hostname: s.Hostname(3), AgentID: "a3", AuthToken: "brz_x"})
	if s.Missing(5) != 4 {
		t.Fatalf("Missing(5) = %d, want 4", s.Missing(5))
	}
	if err := s.Save(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token store mode %o, want 600 (it holds bearer tokens)", perm)
	}
	again, err := LoadStore(path, "http://localhost:1", "ignored-on-reload")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := again.Get(3); !ok || got.AuthToken != "brz_x" {
		t.Fatalf("reloaded identity %+v %v", got, ok)
	}
	if again.HostnameBase() != s.HostnameBase() {
		t.Fatal("the hostname base must survive a reload, or re-runs would collide with their own rows")
	}
}

func TestLoadStoreRefusesAStoreFromAnotherServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokens.json")
	s, _ := LoadStore(path, "http://stack-a:1", "agentsim")
	if err := s.Save(path); err != nil {
		t.Fatal(err)
	}
	_, err := LoadStore(path, "http://stack-b:1", "agentsim")
	if err == nil || !strings.Contains(err.Error(), "http://stack-a:1") || !strings.Contains(err.Error(), "http://stack-b:1") {
		t.Fatalf("want a refusal naming both servers, got %v", err)
	}
}

func TestReenrollHostnamesNeverRepeat(t *testing.T) {
	s, _ := LoadStore(filepath.Join(t.TempDir(), "t.json"), "http://x:1", "agentsim")
	a, b := s.ReenrollHostname(1), s.ReenrollHostname(1)
	if a == b || !strings.HasPrefix(a, s.Hostname(1)+"-r") {
		t.Fatalf("re-enroll hostnames %q %q", a, b)
	}
}
