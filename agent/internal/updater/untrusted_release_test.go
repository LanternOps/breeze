package updater

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// Issue #3544: the control plane answers download-info with 409 + a
// machine-readable `reason` when a registered version has no valid signed
// release manifest. The agent used to discard the body entirely and report
// only "download info request failed with status 409", then retry every
// heartbeat forever. These tests pin both halves of the fix: the reason is
// surfaced, and the failure is classified as terminal via ErrUntrustedRelease.

func newDownloadInfo409Server(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/download") {
			t.Errorf("unexpected request path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		if body != "" {
			_, _ = w.Write([]byte(body))
		}
	}))
}

func downloadBinaryAgainst(t *testing.T, server *httptest.Server) error {
	t.Helper()
	u := New(&Config{
		ServerURL: staticServerURL(server.URL),
		AuthToken: secmem.NewSecureString("test-token"),
	})
	u.client = server.Client()
	_, _, _, err := u.downloadBinary("1.0.0")
	if err == nil {
		t.Fatal("expected download to fail on 409")
	}
	return err
}

func TestDownloadBinary409SurfacesReasonAndIsTerminal(t *testing.T) {
	server := newDownloadInfo409Server(t, `{"error":"Release manifest is not trusted","reason":"signed_release_manifest_required"}`)
	defer server.Close()

	err := downloadBinaryAgainst(t, server)

	if !errors.Is(err, ErrUntrustedRelease) {
		t.Fatalf("expected ErrUntrustedRelease, got %v", err)
	}
	if !strings.Contains(err.Error(), "signed_release_manifest_required") {
		t.Fatalf("expected the server's reason in the error, got %q", err.Error())
	}
	// The old opaque message must be gone — it is what made #3544 take hours
	// to diagnose.
	if strings.Contains(err.Error(), "failed with status 409") {
		t.Fatalf("409 still reported as an opaque status: %q", err.Error())
	}
}

func TestDownloadBinary409WithoutReasonStillTerminal(t *testing.T) {
	// A control plane that predates the `reason` field, or an intermediary
	// that replaced the body, must still be classified as terminal — the
	// backoff must not depend on parsing succeeding.
	for name, body := range map[string]string{
		"empty body":     "",
		"not json":       "gateway timeout",
		"json no reason": `{"error":"nope"}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := newDownloadInfo409Server(t, body)
			defer server.Close()

			err := downloadBinaryAgainst(t, server)
			if !errors.Is(err, ErrUntrustedRelease) {
				t.Fatalf("expected ErrUntrustedRelease, got %v", err)
			}
		})
	}
}

func TestDownloadInfoRejectionReasonSanitizesServerText(t *testing.T) {
	// The reason lands in agent logs, so only the closed set of lowercase
	// snake_case identifiers is accepted. Anything else is dropped rather
	// than echoed — consistent with how the redirect branch of
	// parseDownloadInfo and SafeDownloadErrorFields treat server-supplied
	// text.
	tests := []struct {
		name string
		body string
		want string
	}{
		{"valid reason", `{"reason":"invalid_release_manifest_signature"}`, "invalid_release_manifest_signature"},
		{"uppercase rejected", `{"reason":"Signed_Manifest"}`, ""},
		{"url rejected", `{"reason":"https://evil.example/?token=abc"}`, ""},
		{"spaces rejected", `{"reason":"some prose with detail"}`, ""},
		{"newline injection rejected", `{"reason":"ok\nfake=log line"}`, ""},
		{"digits rejected", `{"reason":"reason123"}`, ""},
		{"empty rejected", `{"reason":""}`, ""},
		{"overlong rejected", `{"reason":"` + strings.Repeat("a", 65) + `"}`, ""},
		{"max length accepted", `{"reason":"` + strings.Repeat("a", 64) + `"}`, strings.Repeat("a", 64)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := downloadInfoRejectionReason(strings.NewReader(tc.body)); got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDownloadInfoRejectionReasonBoundsBodySize(t *testing.T) {
	// A hostile endpoint must not be able to stream unbounded data into the
	// agent just to produce a log line. The truncated read yields invalid
	// JSON, so the reason is dropped.
	huge := `{"reason":"` + strings.Repeat("a", maxDownloadInfoErrorBodyBytes*2) + `"}`
	if got := downloadInfoRejectionReason(strings.NewReader(huge)); got != "" {
		t.Fatalf("expected oversized body to yield no reason, got %q", got)
	}
}

func TestNon409StatusStillReportsOpaqueStatus(t *testing.T) {
	// Only 409 is terminal. Other failures (e.g. a 503 from a restarting
	// control plane) must keep retrying on the normal heartbeat cadence.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	err := downloadBinaryAgainst(t, server)
	if errors.Is(err, ErrUntrustedRelease) {
		t.Fatalf("503 must not be classified as terminal: %v", err)
	}
	if !strings.Contains(err.Error(), "503") {
		t.Fatalf("expected status in error, got %q", err.Error())
	}
}
