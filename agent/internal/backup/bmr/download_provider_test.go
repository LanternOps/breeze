package bmr

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecoveryDownloadProviderUsesAdvertisedAuthHeader(t *testing.T) {
	var sawAuth string
	var sawQueryToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/download" {
			http.NotFound(w, r)
			return
		}
		sawAuth = r.Header.Get("Authorization")
		sawQueryToken = r.URL.Query().Get("token")
		if got := r.URL.Query().Get("path"); got != "snapshots/provider-snapshot-1/manifest.json" {
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		Type:              "breeze_proxy",
		Method:            "GET",
		URL:               server.URL + "/download",
		TokenHeaderName:   "authorization",
		TokenHeaderFormat: "Bearer <recovery-token>",
		PathQueryParam:    "path",
		PathPrefix:        "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if sawAuth != "Bearer brz_rec_test" {
		t.Fatalf("Authorization header = %q, want bearer token", sawAuth)
	}
	if sawQueryToken != "" {
		t.Fatalf("query token = %q, want empty", sawQueryToken)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != `{"ok":true}` {
		t.Fatalf("downloaded data = %q", string(data))
	}
}

func TestRecoveryDownloadProviderFallsBackToLegacyQueryToken(t *testing.T) {
	var sawQueryToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawQueryToken = r.URL.Query().Get("legacy_token")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_legacy", &AuthenticatedDownloadDescriptor{
		Type:            "breeze_proxy",
		Method:          "GET",
		URL:             server.URL + "/download",
		TokenQueryParam: "legacy_token",
		PathQueryParam:  "path",
		PathPrefix:      "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if sawQueryToken != "brz_rec_legacy" {
		t.Fatalf("legacy query token = %q, want token", sawQueryToken)
	}
}

// closedOrigin starts a throwaway httptest server, captures its URL, then
// closes it immediately so nothing is listening there. Connecting to it
// fails fast and deterministically (connection refused) regardless of the
// host environment — standing in for D10's "descriptor points at a public
// URL unreachable from the operator's vantage point" scenario without
// depending on any real network resource.
func closedOrigin(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("request must not reach the descriptor's original (unreachable) origin")
	}))
	origin := srv.URL
	srv.Close()
	return origin
}

func TestRecoveryDownloadProviderRewritesDescriptorOriginToServer(t *testing.T) {
	var sawPath, sawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawQuery = r.URL.Query().Get("path")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	descriptorOrigin := closedOrigin(t)

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		Type:           "breeze_proxy",
		Method:         "GET",
		URL:            descriptorOrigin + "/api/v1/backup/bmr/recover/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v (descriptor origin was not rewritten to --server)", err)
	}
	if sawPath != "/api/v1/backup/bmr/recover/download" {
		t.Fatalf("request path = %q, want rewritten descriptor path", sawPath)
	}
	if sawQuery != "snapshots/provider-snapshot-1/manifest.json" {
		t.Fatalf("request path query = %q", sawQuery)
	}
}

func TestRewriteDescriptorOriginLeavesSameOriginUnchanged(t *testing.T) {
	descriptor := &AuthenticatedDownloadDescriptor{
		URL:        "http://10.0.2.2:33933/api/v1/backup/bmr/recover/download",
		PathPrefix: "snapshots/x",
	}
	got := rewriteDescriptorOrigin("http://10.0.2.2:33933", descriptor)
	if got != descriptor {
		t.Fatalf("expected the same descriptor when origin already matches --server, got a rewritten copy: %+v", got)
	}
}

func TestRecoveryDownloadProviderResolvesRelativeDescriptorAgainstServer(t *testing.T) {
	var sawPath, sawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawQuery = r.URL.Query().Get("path")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            "/api/v1/backup/bmr/recover/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v (relative descriptor was not resolved against --server)", err)
	}
	if sawPath != "/api/v1/backup/bmr/recover/download" {
		t.Fatalf("request path = %q, want resolved relative descriptor path", sawPath)
	}
	if sawQuery != "snapshots/provider-snapshot-1/manifest.json" {
		t.Fatalf("request path query = %q", sawQuery)
	}
}

func TestRecoveryDownloadProviderRewritesHTTPSDescriptorToHTTPServerAndWarns(t *testing.T) {
	var sawPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	descriptorHost := strings.TrimPrefix(closedOrigin(t), "http://")

	var logBuf bytes.Buffer
	origLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	defer slog.SetDefault(origLogger)

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            "https://" + descriptorHost + "/api/v1/backup/bmr/recover/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v (https descriptor was not rewritten to the http --server)", err)
	}
	if sawPath != "/api/v1/backup/bmr/recover/download" {
		t.Fatalf("request path = %q, want rewritten descriptor path", sawPath)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected a WARN log for the https->http downgrade, got: %s", logged)
	}
	if !strings.Contains(logged, "downgraded") {
		t.Fatalf("expected the warning to mention the https->http downgrade, got: %s", logged)
	}
}
