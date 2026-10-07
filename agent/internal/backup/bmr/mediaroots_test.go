package bmr

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// x509.SetFallbackRoots panics when called twice in one process, so every
// scenario that actually loads roots runs in a fresh subprocess re-executing
// this test binary through TestHelperMediaRoots.

func certPEM(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func writeRootsFile(t *testing.T, name string, body []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func newRootsTLSServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// foreignRootDER returns a self-signed CA unrelated to httptest's cert.
func foreignRootDER(t *testing.T) []byte {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(42),
		Subject:               pkix.Name{CommonName: "foreign test root"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	return der
}

// TestHelperMediaRoots is the subprocess body, not a real test.
func TestHelperMediaRoots(t *testing.T) {
	if os.Getenv("BREEZE_MEDIAROOTS_HELPER") != "1" {
		t.Skip("subprocess helper")
	}
	n, err := LoadMediaRoots(os.Getenv("BREEZE_ROOTS"))
	if err != nil {
		fmt.Printf("LOADERR %v\n", err)
		os.Exit(3)
	}
	fmt.Printf("LOADED %d\n", n)
	url := os.Getenv("BREEZE_URL")
	clients := []struct {
		name string
		c    *http.Client
	}{
		{"newHTTPClient", newHTTPClient()},
		{"noAuthRedirectClient", noAuthRedirectClient},
	}
	failed := false
	for _, cl := range clients {
		resp, err := cl.c.Get(url)
		if err != nil {
			fmt.Printf("%s FAIL %v\n", cl.name, err)
			failed = true
			continue
		}
		_ = resp.Body.Close()
		fmt.Printf("%s OK\n", cl.name)
	}
	if failed {
		os.Exit(4)
	}
	os.Exit(0)
}

func runMediaRootsHelper(t *testing.T, url, rootsPath string, extraEnv ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperMediaRoots$")
	var env []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "GODEBUG=") {
			continue // each scenario states its own GODEBUG
		}
		env = append(env, e)
	}
	env = append(env, "BREEZE_MEDIAROOTS_HELPER=1", "BREEZE_URL="+url, "BREEZE_ROOTS="+rootsPath)
	env = append(env, extraEnv...)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func wantAll(t *testing.T, out string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Fatalf("missing %q in output:\n%s", w, out)
		}
	}
}

func TestLoadMediaRoots_UsedByEveryRecoveryClient(t *testing.T) {
	srv := newRootsTLSServer(t)
	roots := writeRootsFile(t, "roots.pem", certPEM(srv.Certificate().Raw))

	t.Run("launcher sets GODEBUG", func(t *testing.T) {
		out, err := runMediaRootsHelper(t, srv.URL, roots, "GODEBUG=x509usefallbackroots=1")
		if err != nil {
			t.Fatalf("expected success, got %v\n%s", err, out)
		}
		wantAll(t, out, "LOADED 1", "newHTTPClient OK", "noAuthRedirectClient OK")
	})

	t.Run("no GODEBUG in env: LoadMediaRoots enables it in-process", func(t *testing.T) {
		out, err := runMediaRootsHelper(t, srv.URL, roots)
		if err != nil {
			t.Fatalf("expected success without launcher GODEBUG, got %v\n%s", err, out)
		}
		wantAll(t, out, "LOADED 1", "newHTTPClient OK", "noAuthRedirectClient OK")
	})

	t.Run("existing GODEBUG is preserved and appended to", func(t *testing.T) {
		out, err := runMediaRootsHelper(t, srv.URL, roots, "GODEBUG=http2client=0")
		if err != nil {
			t.Fatalf("expected success, got %v\n%s", err, out)
		}
		wantAll(t, out, "newHTTPClient OK", "noAuthRedirectClient OK")
	})

	t.Run("without roots file every client rejects the server", func(t *testing.T) {
		out, err := runMediaRootsHelper(t, srv.URL, filepath.Join(t.TempDir(), "absent.pem"))
		if err == nil {
			t.Fatalf("expected failure, got success\n%s", out)
		}
		wantAll(t, out, "LOADED 0", "newHTTPClient FAIL", "noAuthRedirectClient FAIL", "x509: certificate signed by unknown authority")
	})

	t.Run("a foreign root does not trust this server", func(t *testing.T) {
		bogus := writeRootsFile(t, "foreign.pem", certPEM(foreignRootDER(t)))
		out, err := runMediaRootsHelper(t, srv.URL, bogus)
		if err == nil {
			t.Fatalf("a foreign root must not validate the server\n%s", out)
		}
		wantAll(t, out, "LOADED 1", "newHTTPClient FAIL", "noAuthRedirectClient FAIL")
	})
}

func TestLoadMediaRoots_MissingFileKeepsSystemRoots(t *testing.T) {
	// Safe in-process: a missing file / empty path never calls
	// SetFallbackRoots and must not touch GODEBUG.
	t.Setenv("GODEBUG", "")
	for _, p := range []string{"", filepath.Join(t.TempDir(), "nope.pem")} {
		n, err := LoadMediaRoots(p)
		if n != 0 || err != nil {
			t.Fatalf("LoadMediaRoots(%q) = %d, %v; want 0, nil", p, n, err)
		}
	}
	if got := os.Getenv("GODEBUG"); got != "" {
		t.Fatalf("GODEBUG modified for missing roots: %q", got)
	}
}

func TestLoadMediaRoots_GarbageIsError(t *testing.T) {
	t.Setenv("GODEBUG", "")
	cases := map[string][]byte{
		"garbage":       []byte("this is not pem"),
		"empty":         {},
		"wrong-type":    pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte{1, 2, 3}}),
		"bad-cert-body": pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte{1, 2, 3}}),
	}
	for name, body := range cases {
		p := writeRootsFile(t, name+".pem", body)
		n, err := LoadMediaRoots(p)
		if err == nil || n != 0 {
			t.Fatalf("%s: LoadMediaRoots = %d, %v; want 0, error", name, n, err)
		}
	}
	if got := os.Getenv("GODEBUG"); got != "" {
		t.Fatalf("GODEBUG modified on failure: %q", got)
	}
}

func TestLoadMediaRoots_GarbageFailsClosedInSubprocess(t *testing.T) {
	p := writeRootsFile(t, "bad.pem", []byte("junk"))
	out, err := runMediaRootsHelper(t, "https://127.0.0.1:1", p)
	if err == nil {
		t.Fatalf("expected non-zero exit, got success\n%s", out)
	}
	wantAll(t, out, "LOADERR")
}
