package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// The .pkg must come from the control plane that issued the signed manifest
// first: a hosted deployment's manifest lists ITS OWN .pkg, which differs from
// the public GitHub release asset, so a GitHub-only download can never match
// it. The GitHub release asset stays as a second source for deployments whose
// control plane cannot serve the package.
func TestPkgDownloadURLs_ControlPlaneFirstThenRelease(t *testing.T) {
	got := pkgDownloadURLs("https://us.example.test/", "0.121.0", "arm64")
	want := []string{
		"https://us.example.test/api/v1/agents/download/darwin/arm64/pkg",
		"https://github.com/LanternOps/breeze/releases/download/v0.121.0/breeze-agent-darwin-arm64.pkg",
	}
	if len(got) != len(want) {
		t.Fatalf("pkgDownloadURLs = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("pkgDownloadURLs[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestPkgDownloadURLs_NoServerURLUsesReleaseOnly(t *testing.T) {
	got := pkgDownloadURLs("  ", "v0.121.0", "amd64")
	want := "https://github.com/LanternOps/breeze/releases/download/v0.121.0/breeze-agent-darwin-amd64.pkg"
	if len(got) != 1 || got[0] != want {
		t.Fatalf("pkgDownloadURLs = %v, want [%s]", got, want)
	}
}

func TestFetchVerifiedPkg_SkipsMismatchedSourceAndUsesMatchingOne(t *testing.T) {
	good := []byte("signed package bytes for this deployment")
	other := []byte("a different edition's package")
	var otherHits, goodHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("pkg download to %s carried an Authorization header", r.URL.Path)
		}
		switch r.URL.Path {
		case "/other.pkg":
			otherHits.Add(1)
			_, _ = w.Write(other)
		case "/good.pkg":
			goodHits.Add(1)
			_, _ = w.Write(good)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	u := New(&Config{})
	u.client = srv.Client()

	path, err := u.fetchVerifiedPkg([]string{srv.URL + "/other.pkg", srv.URL + "/good.pkg"}, sha256Hex(good))
	if err != nil {
		t.Fatalf("fetchVerifiedPkg: %v", err)
	}
	defer os.Remove(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(good) {
		t.Fatalf("fetchVerifiedPkg returned the wrong bytes: %q", data)
	}
	if otherHits.Load() != 1 || goodHits.Load() != 1 {
		t.Fatalf("hits other=%d good=%d, want 1 and 1", otherHits.Load(), goodHits.Load())
	}
}

func TestFetchVerifiedPkg_StopsAtFirstMatch(t *testing.T) {
	good := []byte("pkg")
	var secondHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/second.pkg" {
			secondHits.Add(1)
		}
		_, _ = w.Write(good)
	}))
	defer srv.Close()

	u := New(&Config{})
	u.client = srv.Client()
	path, err := u.fetchVerifiedPkg([]string{srv.URL + "/first.pkg", srv.URL + "/second.pkg"}, sha256Hex(good))
	if err != nil {
		t.Fatalf("fetchVerifiedPkg: %v", err)
	}
	os.Remove(path)
	if secondHits.Load() != 0 {
		t.Fatal("fetchVerifiedPkg downloaded a second source after the first one matched")
	}
}

func TestFetchVerifiedPkg_UnavailableSourceFallsThrough(t *testing.T) {
	good := []byte("pkg")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/down.pkg" {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write(good)
	}))
	defer srv.Close()

	u := New(&Config{})
	u.client = srv.Client()
	path, err := u.fetchVerifiedPkg([]string{srv.URL + "/down.pkg", srv.URL + "/up.pkg"}, sha256Hex(good))
	if err != nil {
		t.Fatalf("fetchVerifiedPkg: %v", err)
	}
	os.Remove(path)
}

func TestFetchVerifiedPkg_NoMatchingSourceFailsWithEveryReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/down.pkg" {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("wrong bytes"))
	}))
	defer srv.Close()

	u := New(&Config{})
	u.client = srv.Client()
	expected := sha256Hex([]byte("the signed package"))
	path, err := u.fetchVerifiedPkg([]string{srv.URL + "/down.pkg", srv.URL + "/wrong.pkg"}, expected)
	if err == nil {
		os.Remove(path)
		t.Fatal("fetchVerifiedPkg must fail when no source matches the signed checksum")
	}
	msg := err.Error()
	if !strings.Contains(msg, "status 503") || !strings.Contains(msg, "checksum mismatch") {
		t.Fatalf("error should report every source's failure, got: %s", msg)
	}
	if path != "" {
		t.Fatalf("fetchVerifiedPkg returned a path %q alongside an error", path)
	}
}

func TestFetchVerifiedPkg_RefusesEmptyChecksum(t *testing.T) {
	u := New(&Config{})
	if _, err := u.fetchVerifiedPkg([]string{"https://example.test/x.pkg"}, ""); err == nil {
		t.Fatal("fetchVerifiedPkg must refuse an empty signed checksum")
	}
}
