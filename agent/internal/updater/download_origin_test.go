package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

type downloadOriginTransport func(*http.Request) (*http.Response, error)

func (f downloadOriginTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// newDownloadOriginUpdater returns an updater for control plane
// https://api.example with backup https://backup.example whose transport
// records the Authorization header of every request and answers 200.
func newDownloadOriginUpdater(t *testing.T) (*Updater, func() []string) {
	t.Helper()
	var (
		mu   sync.Mutex
		seen []string
	)
	u := New(&Config{
		ServerURL:       staticServerURL("https://api.example"),
		BackupServerURL: "https://backup.example",
		AuthToken:       secmem.NewSecureString("test-token"),
		TempDir:         t.TempDir(),
	})
	u.client = &http.Client{Transport: downloadOriginTransport(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("artifact")), Request: r}, nil
	})}
	return u, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
}

// The artifact download sends the agent credential only to the configured
// primary or backup control-plane origin (scheme, host and port).
func TestArtifactDownloadSendsCredentialOnlyToControlPlaneOrigin(t *testing.T) {
	for _, tc := range []struct {
		url           string
		authenticated bool
	}{
		{"https://api.example/asset", true},
		{"https://API.EXAMPLE:443/asset", true},
		{"HTTPS://api.example/asset", true},
		{"https://backup.example/asset", true},
		{"https://cdn.example/asset", false},
		{"https://sub.api.example/asset", false},
		{"https://api.example:8443/asset", false},
		{"http://api.example/asset", false},
		{"https://user:pass@api.example/asset", false},
	} {
		t.Run(tc.url, func(t *testing.T) {
			u, seen := newDownloadOriginUpdater(t)
			filename, err := u.downloadFromURL(tc.url)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Remove(filename) })
			got := seen()
			if len(got) != 1 {
				t.Fatalf("requests = %d, want 1", len(got))
			}
			// (net/http turns URL userinfo into Basic auth on its own; what
			// matters is whether the agent credential was sent.)
			if (got[0] == "Bearer test-token") != tc.authenticated {
				t.Fatalf("Authorization = %q, want agent credential sent = %v", got[0], tc.authenticated)
			}
		})
	}
}

// The caller-supplied URL path (helper dev push) follows the same rule.
func TestDownloadAndVerifySendsNoCredentialToOtherOrigin(t *testing.T) {
	u, seen := newDownloadOriginUpdater(t)
	sum := sha256.Sum256([]byte("artifact"))
	path, err := u.DownloadAndVerify("https://cdn.example/asset", hex.EncodeToString(sum[:]))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(path) })
	if got := seen(); len(got) != 1 || got[0] != "" {
		t.Fatalf("Authorization headers = %q, want one request with none", got)
	}
}
