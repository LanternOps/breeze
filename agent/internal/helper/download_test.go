package helper

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/updater"
)

// TestDefaultHelperDownloaderRejectsOffOriginRedirect proves the production
// helper download path (the updater-backed verified downloader) does NOT follow
// a redirect off the configured control-plane origin to an attacker-controlled
// CDN. This is the core of the HIGH-severity finding: the old downloadFile used
// http.DefaultClient (follows redirects) and ran the result as SYSTEM/root with
// no integrity check.
func TestDefaultHelperDownloaderRejectsOffOriginRedirect(t *testing.T) {
	// A malicious "CDN" that, if ever reached, would serve poisoned bytes.
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("POISONED-INSTALLER-PAYLOAD"))
	}))
	defer evil.Close()

	// The control plane: its download-info endpoint 302-redirects off-origin to
	// the evil CDN (mirrors BINARY_SOURCE=github serving the helper download).
	var infoHits int
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/download") {
			infoHits++
			http.Redirect(w, r, evil.URL+"/breeze-helper-windows.msi", http.StatusFound)
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer control.Close()

	dl := defaultHelperDownloader(control.URL, secmem.NewSecureString("tok"), "1.2.3", nil)
	path, err := dl("1.2.3")
	if err == nil {
		if path != "" {
			_ = os.Remove(path)
		}
		t.Fatalf("expected verified download to reject the off-origin redirect, got success (path=%q)", path)
	}
	// The error must come from refusing the unsigned redirect, never from having
	// fetched and trusted the evil payload.
	if !strings.Contains(err.Error(), "redirect") && !strings.Contains(err.Error(), "signed") && !strings.Contains(err.Error(), "manifest") {
		t.Fatalf("expected a redirect/manifest-trust rejection, got: %v", err)
	}
}

// TestDefaultHelperDownloaderUsesHelperComponent confirms the verified
// downloader queries the agent-versions download endpoint with
// component=helper, so the signed release manifest's helper asset
// (breeze-helper-*) is the trust anchor — not the unauthenticated
// /download/helper/:os/:arch redirect route.
func TestDefaultHelperDownloaderUsesHelperComponent(t *testing.T) {
	var gotComponent string
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotComponent = r.URL.Query().Get("component")
		// Return a well-formed-but-untrusted info body so the path proceeds past
		// the request and into manifest verification (which will fail closed —
		// that's fine; we only assert the component here).
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"url":"` + r.URL.Scheme + `","checksum":"x","manifest":"{}","manifestSignature":"AAAA"}`))
	}))
	defer control.Close()

	dl := defaultHelperDownloader(control.URL, secmem.NewSecureString("tok"), "9.9.9", nil)
	_, _ = dl("9.9.9") // error expected (untrusted manifest); we only inspect the request
	if gotComponent != "helper" {
		t.Fatalf("verified helper downloader queried component=%q, want %q", gotComponent, "helper")
	}
}

// Compile-time guard: the default helper downloader signature must stay
// compatible with updater.Updater.DownloadBinary so the production shim is a
// one-liner and the seam stays honest.
var _ func(string) (string, error) = (&updater.Updater{}).DownloadBinary
