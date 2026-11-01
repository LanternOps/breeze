package updater

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

func setTestIsolation(t *testing.T, active bool) {
	t.Helper()
	SetIsolationGate(func() bool { return active })
	t.Cleanup(func() { SetIsolationGate(nil) })
}

func TestIsolationGateArtifactRequests(t *testing.T)       { testIsolationArtifactRequests(t, false) }
func TestIsolationGateArtifactRequestsMemory(t *testing.T) { testIsolationArtifactRequests(t, true) }
func testIsolationArtifactRequests(t *testing.T, memory bool) {
	for _, kind := range []string{"binary", "pkg"} {
		for _, active := range []bool{false, true} {
			for _, route := range []string{"on-host", "backup", "off-host", "redirect"} {
				t.Run(kind+"/"+route+"/active="+map[bool]string{false: "false", true: "true"}[active], func(t *testing.T) {
					setTestIsolation(t, active)
					var offHits atomic.Int32
					offURL, controlURL := "https://relay.example.test", "https://control.example.test"
					offHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { offHits.Add(1); _, _ = w.Write([]byte("artifact")) })
					controlHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path == "/redirect" {
							http.Redirect(w, r, offURL, http.StatusFound)
							return
						}
						_, _ = w.Write([]byte("artifact"))
					})
					client := &http.Client{Transport: isolationTestTransport(func(r *http.Request) (*http.Response, error) {
						w := httptest.NewRecorder()
						if r.URL.Host == "relay.example.test" {
							offHandler.ServeHTTP(w, r)
						} else {
							controlHandler.ServeHTTP(w, r)
						}
						return w.Result(), nil
					})}
					if !memory {
						off := httptest.NewServer(offHandler)
						defer off.Close()
						offURL = off.URL
						control := httptest.NewServer(controlHandler)
						defer control.Close()
						controlURL = control.URL
						client = control.Client()
					}
					cfg := &Config{ServerURL: staticServerURL(controlURL), AuthToken: secmem.NewSecureString("test-token"), TempDir: t.TempDir()}
					defer cfg.AuthToken.Zero()
					u := New(cfg)
					u.client = client
					target := controlURL
					switch route {
					case "off-host":
						target = offURL
					case "redirect":
						target = controlURL + "/redirect"
					case "backup":
						cfg.BackupServerURL = offURL
						target = offURL
					}
					var path string
					var err error
					if kind == "binary" {
						path, err = u.downloadFromURL(target)
					} else {
						path, err = u.downloadPkgFrom(target)
					}
					if path != "" {
						defer removeCleanup(path)
					}
					blocked := active && (route == "off-host" || route == "redirect")
					if blocked {
						if !errors.Is(err, ErrUpdateBlockedByIsolation) {
							t.Fatalf("error = %v, want isolation rejection", err)
						}
						if offHits.Load() != 0 {
							t.Fatal("blocked server received request")
						}
					} else if err != nil {
						t.Fatalf("allowed download failed: %v", err)
					}
				})
			}
		}
	}
}

func TestIsolationGateControlPlaneNormalization(t *testing.T) {
	setTestIsolation(t, true)
	u := New(&Config{ServerURL: staticServerURL("https://CONTROL.example.test:443/"), BackupServerURL: "http://relay.example.test"})
	for _, tc := range []struct {
		url     string
		blocked bool
	}{
		{"https://control.example.test/file", false}, {"https://control.example.test:0443/file", false},
		{"http://relay.example.test:80/file", false}, {"https://control.example.test:8443/file", true},
		{"https://relay.example.test/file", true}, {"https://relay.example.test:443/file", true},
		{"file:///artifact", true}, {"https://user@control.example.test/file", true},
	} {
		t.Run(tc.url, func(t *testing.T) {
			err := u.checkIsolationURL(tc.url)
			if errors.Is(err, ErrUpdateBlockedByIsolation) != tc.blocked {
				t.Fatalf("error = %v, blocked = %v", err, tc.blocked)
			}
		})
	}
}

func TestIsolationGateUnsetIsNoop(t *testing.T) {
	SetIsolationGate(nil)
	t.Cleanup(func() { SetIsolationGate(nil) })
	u := New(&Config{})
	if err := u.checkIsolationURL("https://relay.example.test/file"); err != nil {
		t.Fatal(err)
	}
}

func TestIsolationGatePkgFallback(t *testing.T) {
	setTestIsolation(t, true)
	urls := pkgDownloadURLs("https://control.example.test", "1.2.3", "arm64")
	if len(urls) != 1 || !strings.HasPrefix(urls[0], "https://control.example.test/") {
		t.Fatalf("unexpected isolated package sources: %v", urls)
	}
	if urls := pkgDownloadURLs("", "1.2.3", "arm64"); len(urls) != 0 {
		t.Fatal("isolated package fetch without control plane has a fallback")
	}
}

func TestIsolationGateUnsignedUpdateDoesNotReplace(t *testing.T) {
	setTestIsolation(t, true)
	dir := t.TempDir()
	binary := filepath.Join(dir, "agent")
	if err := os.WriteFile(binary, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	u := New(&Config{BinaryPath: binary, BackupPath: binary + ".bak", ServerURL: staticServerURL("https://control.example.test")})
	err := u.UpdateFromURL("https://control.example.test/agent", sha256Hex([]byte("replacement")), UpdateOptions{})
	if !errors.Is(err, ErrUpdateBlockedByIsolation) {
		t.Fatalf("error = %v, want unsigned isolation rejection", err)
	}
	b, err := os.ReadFile(binary)
	if err != nil || string(b) != "original" {
		t.Fatal("unsigned update changed binary")
	}
}

func TestIsolationGateUpdateToVerifiesBeforeMutation(t *testing.T) {
	testIsolationUpdateVerification(t, false)
}

// Exercise signed-artifact staging without a listener as well. This keeps the
// trust-boundary tests runnable in environments that prohibit binding sockets.
func TestIsolationGateUpdateVerificationMemory(t *testing.T) {
	testIsolationUpdateVerification(t, true)
}

type isolationTestTransport func(*http.Request) (*http.Response, error)

func (f isolationTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func testIsolationUpdateVerification(t *testing.T, memory bool) {
	for _, invalid := range []string{"signature", "checksum", "size", "missing-size", "valid-download", "missing-size-download"} {
		t.Run(invalid, func(t *testing.T) {
			setTestIsolation(t, true)
			pub, priv, err := ed25519.GenerateKey(nil)
			if err != nil {
				t.Fatal(err)
			}
			installEmbeddedManifestKey(t, testEmbeddedKeyID, pub)
			content := []byte("replacement")
			var info downloadInfo
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/api/") {
					_ = json.NewEncoder(w).Encode(info)
					return
				}
				_, _ = w.Write(content)
			})
			base := "https://control.example.test"
			client := &http.Client{Transport: isolationTestTransport(func(r *http.Request) (*http.Response, error) {
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				return w.Result(), nil
			})}
			if !memory {
				srv := httptest.NewServer(handler)
				defer srv.Close()
				base = srv.URL
				client = srv.Client()
			}
			sum := sha256.Sum256(content)
			manifest := updateManifest{Version: "1.2.3", Component: "agent", Platform: manifestPlatform(), Arch: runtime.GOARCH, URL: base + "/agent", Checksum: hex.EncodeToString(sum[:]), Size: int64(len(content))}
			switch invalid {
			case "checksum":
				manifest.Checksum = strings.Repeat("a", 64)
			case "size":
				manifest.Size++
			case "missing-size", "missing-size-download":
				manifest.Size = 0
			}
			payload, _ := json.Marshal(manifest)
			sig := ed25519.Sign(priv, payload)
			if invalid == "signature" {
				sig[0] ^= 1
			}
			info = downloadInfo{URL: manifest.URL, Checksum: manifest.Checksum, Manifest: string(payload), ManifestSignature: base64.StdEncoding.EncodeToString(sig), SigningKeyID: testEmbeddedKeyID}
			dir := t.TempDir()
			binary := filepath.Join(dir, "agent")
			if err := os.WriteFile(binary, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			token := secmem.NewSecureString("test-token")
			defer token.Zero()
			u := New(&Config{ServerURL: staticServerURL(base), AuthToken: token, BinaryPath: binary, BackupPath: binary + ".bak", TempDir: dir})
			u.client = client
			if strings.HasSuffix(invalid, "-download") {
				path, downloadErr := u.DownloadBinary("1.2.3")
				if path != "" {
					defer removeCleanup(path)
				}
				if invalid == "valid-download" {
					if downloadErr != nil {
						t.Fatal(downloadErr)
					}
				} else if !errors.Is(downloadErr, ErrUpdateBlockedByIsolation) {
					t.Fatalf("missing-size download error = %v", downloadErr)
				}
			} else if err := u.UpdateTo("1.2.3"); err == nil {
				t.Fatal("invalid artifact update succeeded")
			}
			got, err := os.ReadFile(binary)
			if err != nil || string(got) != "original" {
				t.Fatal("invalid artifact changed binary")
			}
			if _, err := os.Stat(binary + ".bak"); !os.IsNotExist(err) {
				t.Fatal("update began backing up binary before verification")
			}
		})
	}
}

func TestIsolationGatePkgRequiresSignedSize(t *testing.T) {
	setTestIsolation(t, true)
	content := []byte("package")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(content) }))
	defer srv.Close()
	for _, size := range []int64{0, int64(len(content)) - 1, int64(len(content))} {
		u := New(&Config{ServerURL: staticServerURL(srv.URL)})
		u.client = srv.Client()
		u.signedPkgSize = size
		path, err := u.fetchVerifiedPkg([]string{srv.URL}, sha256Hex(content))
		if path != "" {
			defer removeCleanup(path)
		}
		if size == int64(len(content)) {
			if err != nil {
				t.Fatal(err)
			}
		} else if err == nil {
			t.Fatal("package without matching signed size accepted")
		}
	}
}

func TestIsolationGatePreservesRedirectPolicy(t *testing.T) {
	setTestIsolation(t, true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/artifact", http.StatusFound) }))
	defer srv.Close()
	token := secmem.NewSecureString("test-token")
	defer token.Zero()
	u := New(&Config{ServerURL: staticServerURL(srv.URL), AuthToken: token})
	u.client = srv.Client()
	sentinel := errors.New("existing redirect policy")
	u.client.CheckRedirect = func(*http.Request, []*http.Request) error { return sentinel }
	if _, err := u.downloadFromURL(srv.URL); !errors.Is(err, sentinel) {
		t.Fatalf("existing redirect policy lost: %v", err)
	}
}

func TestIsolationGateRejectsUnverifiedCompanions(t *testing.T) {
	setTestIsolation(t, true)
	for _, kind := range []string{"user-helper", "backup"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			binary := filepath.Join(dir, "agent")
			companion := filepath.Join(dir, "companion")
			if err := os.WriteFile(binary, []byte("original"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(companion, []byte("unsigned"), 0600); err != nil {
				t.Fatal(err)
			}
			pair := &BinaryPair{Temp: companion, Target: filepath.Join(dir, "target")}
			opts := UpdateOptions{}
			if kind == "user-helper" {
				opts.UserHelper = pair
			} else {
				opts.Backup = pair
			}
			u := New(&Config{BinaryPath: binary, ServerURL: staticServerURL("https://control.example.test")})
			if err := u.UpdateToWithOptions("1.2.3", opts); !errors.Is(err, ErrUpdateBlockedByIsolation) {
				t.Fatalf("unverified companion error = %v", err)
			}
			if _, err := os.Stat(companion); !os.IsNotExist(err) {
				t.Fatal("rejected companion was not cleaned up")
			}
		})
	}
}

func TestIsolationGateEmptyPkgSourcesFail(t *testing.T) {
	setTestIsolation(t, true)
	u := New(&Config{})
	if _, err := u.fetchVerifiedPkg(nil, strings.Repeat("a", 64)); err == nil {
		t.Fatal("empty package sources silently succeeded")
	}
}

func TestIsolationGateRechecksBeforeInstall(t *testing.T) {
	var active atomic.Bool
	SetIsolationGate(active.Load)
	t.Cleanup(func() { SetIsolationGate(nil) })
	path := filepath.Join(t.TempDir(), "staged")
	content := []byte("signed staged artifact")
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	u := New(&Config{})
	if err := u.checkIsolationInstall(path, nil, UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	active.Store(true)
	if err := u.checkIsolationInstall(path, nil, UpdateOptions{}); !errors.Is(err, ErrUpdateBlockedByIsolation) {
		t.Fatalf("unsigned install after isolation started: %v", err)
	}
	manifest := &updateManifest{Size: int64(len(content)), Checksum: sha256Hex(content)}
	if err := u.checkIsolationInstall(path, manifest, UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := u.checkIsolationInstall(path, manifest, UpdateOptions{Backup: &BinaryPair{Temp: path}}); !errors.Is(err, ErrUpdateBlockedByIsolation) {
		t.Fatalf("unverified companion install: %v", err)
	}
	manifest.Size = 0
	if err := u.checkIsolationInstall(path, manifest, UpdateOptions{}); !errors.Is(err, ErrUpdateBlockedByIsolation) {
		t.Fatalf("size-less install: %v", err)
	}
	manifest.Size = int64(len(content))
	if err := os.WriteFile(path, []byte(strings.Repeat("x", len(content))), 0600); err != nil {
		t.Fatal(err)
	}
	if err := u.checkIsolationInstall(path, manifest, UpdateOptions{}); !errors.Is(err, ErrChecksumMismatch) {
		t.Fatalf("changed staged artifact install: %v", err)
	}
}

func TestIsolationGatePkgSignedSizeBinding(t *testing.T) {
	u := New(&Config{})
	payload := buildReleaseManifest(t, "v1.2.3", []releaseArtifactAsset{{Name: pkgAssetName(), Size: 42, SHA256: strings.Repeat("a", 64)}})
	staged := u.withVerifiedPkgSize(payload)
	if staged.signedPkgSize != 42 || u.signedPkgSize != 0 {
		t.Fatal("package size was not bound on an independent updater copy")
	}
	if got := u.withVerifiedPkgSize([]byte("invalid")); got.signedPkgSize != 0 {
		t.Fatal("invalid manifest provided package size")
	}
}
