package agentapp

import (
	"bytes"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// The --site-id flag on `enroll` was never read: the server derives the site
// from the enrollment key (#8474). It stays registered so install scripts that
// still pass it keep working, but it is deprecated and warns when used.
const wantSiteIDNotice = "--site-id is ignored; the site comes from the enrollment key. The flag will be removed in a future release."

func resetSiteIDFlag(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		enrollSiteID = ""
		if f := enrollCmd.Flags().Lookup("site-id"); f != nil {
			_ = f.Value.Set("")
			f.Changed = false
		}
		enrollCmd.SetOut(nil)
		enrollCmd.SetErr(nil)
	})
}

func TestEnrollSiteIDFlag_StillParsesAndPrintsDeprecationNotice(t *testing.T) {
	resetSiteIDFlag(t)
	var out bytes.Buffer
	enrollCmd.SetOut(&out)
	enrollCmd.SetErr(&out)

	if err := enrollCmd.ParseFlags([]string{"--site-id", "x"}); err != nil {
		t.Fatalf("--site-id must still parse (install scripts in the field pass it): %v", err)
	}
	if enrollSiteID != "x" {
		t.Errorf("enrollSiteID = %q, want %q", enrollSiteID, "x")
	}
	if !strings.Contains(out.String(), wantSiteIDNotice) {
		t.Errorf("deprecation notice not printed; output = %q, want it to contain %q", out.String(), wantSiteIDNotice)
	}
}

func TestEnrollSiteIDFlag_HiddenFromHelp(t *testing.T) {
	f := enrollCmd.Flags().Lookup("site-id")
	if f == nil {
		t.Fatal("--site-id must stay registered until the follow-up removal")
	}
	if !f.Hidden {
		t.Error("--site-id must be hidden from --help")
	}
	if f.Deprecated != wantSiteIDNotice {
		t.Errorf("Deprecated = %q, want %q", f.Deprecated, wantSiteIDNotice)
	}
}

func TestWarnIgnoredSiteID_LogsOneWarnWhenSet(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))

	warnIgnoredSiteID(logger, "site-123")

	got := buf.String()
	if n := strings.Count(got, "\n"); n != 1 {
		t.Fatalf("want exactly one log line, got %d: %q", n, got)
	}
	if !strings.Contains(got, "level=WARN") {
		t.Errorf("want a WARN line, got %q", got)
	}
	if !strings.Contains(got, "the site comes from the enrollment key") {
		t.Errorf("want the deprecation message, got %q", got)
	}
	if !strings.Contains(got, "site-123") {
		t.Errorf("want the ignored value in the line, got %q", got)
	}
}

func TestWarnIgnoredSiteID_SilentWhenUnset(t *testing.T) {
	var buf bytes.Buffer
	warnIgnoredSiteID(slog.New(slog.NewTextHandler(&buf, nil)), "")
	if buf.Len() != 0 {
		t.Errorf("want no output when --site-id is not passed, got %q", buf.String())
	}
}

// The ignored value must never reach the enroll endpoint.
func TestEnrollWithConfig_DoesNotSendSiteID(t *testing.T) {
	quietEnrollForTest(t)
	resetSiteIDFlag(t)
	enrollSiteID = "site-from-flag-8474"

	var body []byte
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/enroll", func(w http.ResponseWriter, r *http.Request) {
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"agentId":"a","deviceId":"d","authToken":"tok","orgId":"o","siteId":"key-site","config":{}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	origSave := saveEnrollmentFn
	t.Cleanup(func() { saveEnrollmentFn = origSave })
	saveEnrollmentFn = func(*config.Config, string) error { return nil }

	cfg := config.Default()
	cfg.ServerURL = srv.URL
	if err := enrollWithConfig(cfg, filepath.Join(t.TempDir(), "agent.yaml"), "key", "secret"); err != nil {
		t.Fatalf("enrollWithConfig: %v", err)
	}
	if len(body) == 0 {
		t.Fatal("enroll request not captured")
	}
	if bytes.Contains(body, []byte("site-from-flag-8474")) {
		t.Errorf("enroll request body carries the --site-id value: %s", body)
	}
}
