package bmr

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
