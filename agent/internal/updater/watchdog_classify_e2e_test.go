package updater_test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// TestRealDownloaderFailuresClassified drives the REAL updater download path
// (download-info request, manifest signature check against a pinned key,
// binary fetch, checksum) against an httptest control plane and asserts the
// watchdog install classifier maps each real failure to the right class —
// not synthetic sentinels.
func TestRealDownloaderFailuresClassified(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	const keyID = "test-pinned"
	pinned := []string{keyID + ":" + base64.StdEncoding.EncodeToString(pub)}
	content := []byte("WATCHDOG-binary-bytes")
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "macos"
	}

	type mode int
	const (
		okMode mode = iota
		badChecksum
		badSignature
		unknownKey
		status503
		status429
		status404
	)
	newServer := func(m mode) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasPrefix(r.URL.Path, "/api/v1/agent-versions/"):
				switch m {
				case status503:
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				case status429:
					w.WriteHeader(http.StatusTooManyRequests)
					return
				case status404:
					w.WriteHeader(http.StatusNotFound)
					return
				}
				binURL := "http://" + r.Host + "/binary"
				sum := sha256.Sum256(content)
				manifest, _ := json.Marshal(map[string]any{
					"version": "1.5.0", "component": "watchdog", "platform": platform,
					"arch": runtime.GOARCH, "url": binURL, "checksum": hex.EncodeToString(sum[:]),
					"size": len(content),
				})
				sig := ed25519.Sign(priv, manifest)
				if m == badSignature {
					sig[0] ^= 0xff
				}
				id := keyID
				if m == unknownKey {
					id = "nobody"
				}
				_ = json.NewEncoder(w).Encode(map[string]string{
					"url": binURL, "checksum": hex.EncodeToString(sum[:]), "manifest": string(manifest),
					"manifestSignature": base64.StdEncoding.EncodeToString(sig), "signingKeyId": id,
				})
			case r.URL.Path == "/binary":
				if m == badChecksum {
					_, _ = w.Write([]byte("TAMPERED-binary-bytes"))
					return
				}
				_, _ = w.Write(content)
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		}))
	}
	cfg := func(srv *httptest.Server) *updater.Config {
		return &updater.Config{
			ServerURL:             func() string { return srv.URL },
			AuthToken:             secmem.NewSecureString("token"),
			Component:             "watchdog",
			PinnedManifestPubKeys: pinned,
			TempDir:               t.TempDir(),
		}
	}

	cases := []struct {
		name      string
		m         mode
		want      watchdoginstall.ErrorClass
		permanent bool
	}{
		{"bad checksum", badChecksum, watchdoginstall.ClassChecksum, true},
		{"bad signature", badSignature, watchdoginstall.ClassSignature, true},
		{"unknown key id", unknownKey, watchdoginstall.ClassSignature, true},
		{"503", status503, watchdoginstall.ClassServer, false},
		{"429", status429, watchdoginstall.ClassServer, false},
		{"404", status404, watchdoginstall.ClassUnknown, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := newServer(tc.m)
			defer srv.Close()
			_, err := updater.NewWithClientForTest(cfg(srv), srv.Client()).DownloadBinary("1.5.0")
			if err == nil {
				t.Fatal("expected a failure")
			}
			class, permanent := watchdoginstall.Classify(err)
			if class != tc.want || permanent != tc.permanent {
				t.Fatalf("Classify(%v) = (%s,%v) want (%s,%v)", err, class, permanent, tc.want, tc.permanent)
			}
		})
	}

	// Refused download target: the production netpolicy client refuses a
	// loopback control plane outright — the real policy path.
	t.Run("refused target (real netpolicy client)", func(t *testing.T) {
		srv := newServer(okMode)
		defer srv.Close()
		_, err := updater.New(cfg(srv)).DownloadBinary("1.5.0")
		class, permanent := watchdoginstall.Classify(err)
		if class != watchdoginstall.ClassPolicy || !permanent {
			t.Fatalf("Classify(%v) = (%s,%v) want (policy,true)", err, class, permanent)
		}
	})

	t.Run("success", func(t *testing.T) {
		srv := newServer(okMode)
		defer srv.Close()
		c := cfg(srv)
		path, err := updater.NewWithClientForTest(c, srv.Client()).DownloadBinary("1.5.0")
		if err != nil {
			t.Fatalf("download: %v", err)
		}
		if !strings.HasPrefix(path, c.TempDir) {
			t.Fatalf("downloaded to %q, want inside %q", path, c.TempDir)
		}
	})
}
