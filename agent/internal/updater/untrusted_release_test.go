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
	//
	// `malformed` distinguishes "the server sent a reason we refused" from
	// "the server sent no reason". Collapsing those would hide a future
	// server/agent vocabulary drift forever — the exact silent failure this
	// change exists to remove.
	tests := []struct {
		name          string
		body          string
		want          string
		wantMalformed bool
	}{
		{"valid reason", `{"reason":"invalid_release_manifest_signature"}`, "invalid_release_manifest_signature", false},
		{"max length accepted", `{"reason":"` + strings.Repeat("a", 64) + `"}`, strings.Repeat("a", 64), false},

		// Refused, but the caller must still learn a reason WAS present.
		{"uppercase refused", `{"reason":"Signed_Manifest"}`, "", true},
		{"url refused", `{"reason":"https://evil.example/?token=abc"}`, "", true},
		{"spaces refused", `{"reason":"some prose with detail"}`, "", true},
		{"newline injection refused", `{"reason":"ok\nfake=log line"}`, "", true},
		{"digits refused", `{"reason":"reason123"}`, "", true},
		{"overlong refused", `{"reason":"` + strings.Repeat("a", 65) + `"}`, "", true},

		// Genuinely absent — not malformed, nothing was refused.
		{"empty reason field", `{"reason":""}`, "", false},
		{"no reason field", `{"error":"nope"}`, "", false},
		{"not json", `<html>gateway timeout</html>`, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, malformed := downloadInfoRejectionReason(strings.NewReader(tc.body))
			if got != tc.want {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
			if malformed != tc.wantMalformed {
				t.Fatalf("malformed = %v, want %v", malformed, tc.wantMalformed)
			}
		})
	}
}

// A refused reason must produce a DIFFERENT operator-visible message than an
// absent one, and must never echo the raw server text.
func TestDownloadBinary409RefusedReasonIsDistinguishable(t *testing.T) {
	server := newDownloadInfo409Server(t, `{"reason":"https://evil.example/?token=SECRET"}`)
	defer server.Close()

	err := downloadBinaryAgainst(t, server)
	if !errors.Is(err, ErrUntrustedRelease) {
		t.Fatalf("expected ErrUntrustedRelease, got %v", err)
	}
	if !strings.Contains(err.Error(), "unrecognized reason code") {
		t.Fatalf("a refused reason must be reported as such, got %q", err.Error())
	}
	if strings.Contains(err.Error(), "gave no reason") {
		t.Fatalf("a refused reason must not be reported as an absent one: %q", err.Error())
	}
	if strings.Contains(err.Error(), "evil.example") || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("raw server text leaked into the error: %q", err.Error())
	}
}

func TestDownloadInfoRejectionReasonBoundsBodySize(t *testing.T) {
	// A hostile endpoint must not be able to stream unbounded data into the
	// agent just to produce a log line. The truncated read yields invalid
	// JSON, so the reason is dropped.
	huge := `{"reason":"` + strings.Repeat("a", maxDownloadInfoErrorBodyBytes*2) + `"}`
	got, malformed := downloadInfoRejectionReason(strings.NewReader(huge))
	if got != "" {
		t.Fatalf("expected oversized body to yield no reason, got %q", got)
	}
	// A truncated body is inconclusive, NOT absent: a reason may have been
	// present and simply cut off mid-string. Reporting it as "server gave no
	// reason" would be the same silent collapse the malformed flag exists to
	// prevent, reached through size rather than charset.
	if !malformed {
		t.Fatal("a truncated body must be reported as malformed, not as an absent reason")
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
