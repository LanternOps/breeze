package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

func supportNameTestHeartbeat(t *testing.T, stateDir string) *Heartbeat {
	t.Helper()
	h := &Heartbeat{}
	h.SetStatePath(filepath.Join(stateDir, "agent.state"))
	return h
}

func elevationTestServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(ts.Close)
	return ts
}

func TestSendElevationRequestParsesSupportName(t *testing.T) {
	t.Run("present", func(t *testing.T) {
		ts := elevationTestServer(t, `{"id":"req-123","status":"pending","supportName":"Contoso IT"}`)
		h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
		outcome, err := h.SendElevationRequest(sampleElevationEvent())
		if err != nil {
			t.Fatal(err)
		}
		if outcome.RequestID != "req-123" || outcome.Status != "pending" || outcome.SupportName != "Contoso IT" {
			t.Fatalf("outcome = %+v", outcome)
		}
		if got := h.lastSupportName(); got != "Contoso IT" {
			t.Fatalf("cached support name = %q, want Contoso IT", got)
		}
	})

	t.Run("absent leaves the cache unchanged", func(t *testing.T) {
		ts := elevationTestServer(t, `{"id":"req-124","status":"pending"}`)
		h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
		h.rememberSupportName("Contoso IT")
		outcome, err := h.SendElevationRequest(sampleElevationEvent())
		if err != nil {
			t.Fatal(err)
		}
		if outcome.RequestID != "req-124" || outcome.SupportName != "" {
			t.Fatalf("outcome = %+v", outcome)
		}
		if got := h.lastSupportName(); got != "Contoso IT" {
			t.Fatalf("cached support name = %q, want it unchanged", got)
		}
	})

	t.Run("malformed supportName does not lose the ingest decision", func(t *testing.T) {
		ts := elevationTestServer(t, `{"id":"req-125","status":"pending","supportName":42}`)
		h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
		outcome, err := h.SendElevationRequest(sampleElevationEvent())
		if err != nil {
			t.Fatal(err)
		}
		if outcome.RequestID != "req-125" || outcome.Status != "pending" || outcome.SupportName != "" {
			t.Fatalf("outcome = %+v", outcome)
		}
		if got := h.lastSupportName(); got != "" {
			t.Fatalf("cached support name = %q, want empty", got)
		}
	})

	t.Run("oversized supportName is truncated on the outcome", func(t *testing.T) {
		long := strings.Repeat("x", 150)
		ts := elevationTestServer(t, `{"id":"req-126","status":"pending","supportName":"`+long+`"}`)
		h := NewWithVersion(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"}, "test", nil, nil)
		outcome, err := h.SendElevationRequest(sampleElevationEvent())
		if err != nil {
			t.Fatal(err)
		}
		if outcome.SupportName != strings.Repeat("x", 120) {
			t.Fatalf("outcome support name has %d runes, want 120", len([]rune(outcome.SupportName)))
		}
	})
}

func TestRememberSupportNameIgnoresEmpty(t *testing.T) {
	dir := t.TempDir()
	h := supportNameTestHeartbeat(t, dir)
	h.rememberSupportName("Contoso IT")
	h.rememberSupportName("")
	h.rememberSupportName("   ")
	if got := h.lastSupportName(); got != "Contoso IT" {
		t.Fatalf("lastSupportName = %q, want Contoso IT", got)
	}
	reloaded := supportNameTestHeartbeat(t, dir)
	if got := reloaded.lastSupportName(); got != "Contoso IT" {
		t.Fatalf("persisted support name = %q, want Contoso IT", got)
	}
}

func TestSupportNameSurvivesReload(t *testing.T) {
	dir := t.TempDir()
	h := supportNameTestHeartbeat(t, dir)
	if got := h.lastSupportName(); got != "" {
		t.Fatalf("fresh heartbeat support name = %q, want empty", got)
	}
	h.rememberSupportName("Contoso IT")
	if _, err := os.Stat(filepath.Join(dir, pamSupportNameFile)); err != nil {
		t.Fatalf("sidecar not written next to the state path: %v", err)
	}

	reloaded := supportNameTestHeartbeat(t, dir)
	if got := reloaded.lastSupportName(); got != "Contoso IT" {
		t.Fatalf("reloaded support name = %q, want Contoso IT", got)
	}

	// A change is persisted too.
	reloaded.rememberSupportName("Fabrikam Support")
	again := supportNameTestHeartbeat(t, dir)
	if got := again.lastSupportName(); got != "Fabrikam Support" {
		t.Fatalf("changed support name = %q, want Fabrikam Support", got)
	}
}

func TestSupportNameCorruptFileIsEmpty(t *testing.T) {
	for name, content := range map[string]string{
		"not json":      "{not json",
		"wrong type":    `{"supportName":7}`,
		"empty file":    "",
		"blank name":    `{"supportName":"   "}`,
		"json non-obj":  `"Contoso IT"`,
		"missing field": `{}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, pamSupportNameFile), []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			h := supportNameTestHeartbeat(t, dir)
			if got := h.lastSupportName(); got != "" {
				t.Fatalf("support name from corrupt sidecar = %q, want empty", got)
			}
		})
	}

	t.Run("missing file", func(t *testing.T) {
		h := supportNameTestHeartbeat(t, t.TempDir())
		if got := h.lastSupportName(); got != "" {
			t.Fatalf("support name with no sidecar = %q, want empty", got)
		}
	})
}

func TestSupportNameTruncatedTo120(t *testing.T) {
	dir := t.TempDir()
	h := supportNameTestHeartbeat(t, dir)
	h.rememberSupportName(strings.Repeat("ß", 130))
	if got := h.lastSupportName(); got != strings.Repeat("ß", 120) {
		t.Fatalf("cached support name has %d runes, want 120", len([]rune(got)))
	}

	// An oversized value written to disk by hand is clamped on load too.
	if err := os.WriteFile(filepath.Join(dir, pamSupportNameFile),
		[]byte(`{"supportName":"`+strings.Repeat("y", 200)+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	reloaded := supportNameTestHeartbeat(t, dir)
	if got := reloaded.lastSupportName(); got != strings.Repeat("y", 120) {
		t.Fatalf("loaded support name has %d runes, want 120", len([]rune(got)))
	}
}

func TestSupportNameSidecarMode0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits; the Windows state dir ACL protects the file")
	}
	dir := t.TempDir()
	h := supportNameTestHeartbeat(t, dir)
	h.rememberSupportName("Contoso IT")
	info, err := os.Stat(filepath.Join(dir, pamSupportNameFile))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("sidecar mode = %o, want 600", mode)
	}
	// No temp files left behind.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != pamSupportNameFile {
			t.Fatalf("unexpected file left in state dir: %s", e.Name())
		}
	}
}

// Without a state path the name is still cached in memory and nothing is
// written anywhere.
func TestSupportNameWithoutStatePathIsMemoryOnly(t *testing.T) {
	h := &Heartbeat{}
	h.rememberSupportName("Contoso IT")
	if got := h.lastSupportName(); got != "Contoso IT" {
		t.Fatalf("lastSupportName = %q", got)
	}
}
