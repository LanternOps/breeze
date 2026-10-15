package updater

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

// downloadServer serves one download-info response (via info) and the binary
// bytes at /binary. status overrides the download-info status code when != 0;
// binStatus does the same for the binary fetch.
func downloadServer(t *testing.T, info func(host string) downloadInfo, served []byte, status, binStatus int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/v1/agent-versions/"):
			if status != 0 {
				w.WriteHeader(status)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(info(r.Host))
		case r.URL.Path == "/binary":
			if binStatus != 0 {
				w.WriteHeader(binStatus)
				return
			}
			_, _ = w.Write(served)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func newTestUpdater(t *testing.T, server *httptest.Server, cfg Config) *Updater {
	t.Helper()
	cfg.ServerURL = staticServerURL(server.URL)
	cfg.AuthToken = secmem.NewSecureString("test-token")
	u := New(&cfg)
	u.client = server.Client()
	return u
}

// The typed sentinels let callers (the watchdog install classifier) decide
// permanence with errors.Is instead of matching message text, while the
// message text itself stays byte-identical for existing log greps.
func TestDownloadBinary_TypedTrustFailures(t *testing.T) {
	content := []byte("INTENDED-binary-bytes")

	t.Run("checksum mismatch", func(t *testing.T) {
		tampered := []byte("TAMPERED-binary-bytes")
		srv := downloadServer(t, func(host string) downloadInfo {
			return signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
		}, tampered, 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrChecksumMismatch) {
			t.Fatalf("want ErrChecksumMismatch, got %v", err)
		}
		if !strings.Contains(err.Error(), "checksum verification failed: checksum mismatch: expected ") {
			t.Fatalf("message text changed: %v", err)
		}
	})

	t.Run("size mismatch", func(t *testing.T) {
		srv := downloadServer(t, func(host string) downloadInfo {
			return signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
		}, append(append([]byte{}, content...), 'x'), 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrChecksumMismatch) {
			t.Fatalf("want ErrChecksumMismatch for a size mismatch, got %v", err)
		}
	})

	t.Run("bad signature", func(t *testing.T) {
		srv := downloadServer(t, func(host string) downloadInfo {
			info := signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
			sig := []byte(info.ManifestSignature)
			// Flip one base64 char → still decodes to 64 bytes, but invalid.
			if sig[0] == 'A' {
				sig[0] = 'B'
			} else {
				sig[0] = 'A'
			}
			info.ManifestSignature = string(sig)
			return info
		}, content, 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrManifestSignature) {
			t.Fatalf("want ErrManifestSignature, got %v", err)
		}
		if !strings.Contains(err.Error(), "update manifest signature verification failed") {
			t.Fatalf("message text changed: %v", err)
		}
	})

	t.Run("malformed signature encoding", func(t *testing.T) {
		srv := downloadServer(t, func(host string) downloadInfo {
			info := signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
			info.ManifestSignature = "!!not-base64!!"
			return info
		}, content, 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrManifestSignature) {
			t.Fatalf("want ErrManifestSignature, got %v", err)
		}
	})

	t.Run("manifest content mismatch", func(t *testing.T) {
		srv := downloadServer(t, func(host string) downloadInfo {
			// Signed for a different component than the updater asks for.
			return signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
		}, content, 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{Component: "watchdog"}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrManifestSignature) {
			t.Fatalf("want ErrManifestSignature for a signed-manifest mismatch, got %v", err)
		}
		if !strings.Contains(err.Error(), "update manifest component mismatch") {
			t.Fatalf("message text changed: %v", err)
		}
	})

	t.Run("missing signed manifest", func(t *testing.T) {
		srv := downloadServer(t, func(host string) downloadInfo {
			info := signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
			info.Manifest = ""
			return info
		}, content, 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrManifestSignature) {
			t.Fatalf("want ErrManifestSignature, got %v", err)
		}
	})

	t.Run("unknown key id", func(t *testing.T) {
		srv := downloadServer(t, func(host string) downloadInfo {
			info := signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
			info.SigningKeyID = "not-a-trusted-key"
			return info
		}, content, 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrManifestKey) {
			t.Fatalf("want ErrManifestKey, got %v", err)
		}
		if errors.Is(err, ErrManifestSignature) {
			t.Fatalf("key failure must not also read as a signature failure: %v", err)
		}
		if !strings.Contains(err.Error(), `unknown update manifest signing key id "not-a-trusted-key"`) {
			t.Fatalf("message text changed: %v", err)
		}
	})

	t.Run("key id required", func(t *testing.T) {
		srv := downloadServer(t, func(host string) downloadInfo {
			info := signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
			info.SigningKeyID = ""
			return info
		}, content, 0, 0)
		defer srv.Close()
		_, err := newTestUpdater(t, srv, Config{RequireManifestSigningKeyID: true}).DownloadBinary("1.0.0")
		if !errors.Is(err, ErrManifestKey) {
			t.Fatalf("want ErrManifestKey, got %v", err)
		}
	})
}

func TestDownloadBinary_HTTPStatusErrorIsTyped(t *testing.T) {
	content := []byte("INTENDED-binary-bytes")
	cases := []struct {
		name      string
		status    int
		binStatus int
		wantMsg   string
	}{
		{"info 503", http.StatusServiceUnavailable, 0, "download info request failed with status 503"},
		{"info 429", http.StatusTooManyRequests, 0, "download info request failed with status 429"},
		{"binary 502", 0, http.StatusBadGateway, "binary download failed with status 502"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := downloadServer(t, func(host string) downloadInfo {
				return signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
			}, content, tc.status, tc.binStatus)
			defer srv.Close()
			_, err := newTestUpdater(t, srv, Config{}).DownloadBinary("1.0.0")
			var se *HTTPStatusError
			if !errors.As(err, &se) {
				t.Fatalf("want *HTTPStatusError, got %v", err)
			}
			want := tc.status
			if want == 0 {
				want = tc.binStatus
			}
			if se.Code != want {
				t.Fatalf("code=%d want %d", se.Code, want)
			}
			if err.Error() != tc.wantMsg {
				t.Fatalf("message text changed: %q", err.Error())
			}
		})
	}
}

// Config.TempDir routes the downloaded artifact into a caller-owned directory
// (the watchdog reconcile's private per-attempt dir) instead of the OS temp dir.
func TestDownload_UsesAttemptDir(t *testing.T) {
	content := []byte("INTENDED-binary-bytes")
	srv := downloadServer(t, func(host string) downloadInfo {
		return signedDownloadInfo(t, "1.0.0", "agent", "http://"+host+"/binary", content)
	}, content, 0, 0)
	defer srv.Close()
	dir := t.TempDir()
	path, err := newTestUpdater(t, srv, Config{TempDir: dir}).DownloadBinary("1.0.0")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	if filepath.Dir(path) != dir {
		t.Fatalf("downloaded to %q, want inside %q", path, dir)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(content) {
		t.Fatalf("content mismatch: %q err=%v", got, err)
	}
}
