package oemupdates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// tlsServer serves body at /tool.exe and returns the allowlist entry for it.
func tlsServer(t *testing.T, h http.Handler) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	return srv, u.Host
}

func TestFetchHappyPath(t *testing.T) {
	body := []byte("vendor installer bytes")
	srv, host := tlsServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	dest := filepath.Join(t.TempDir(), "tool.exe")
	err := Fetch(context.Background(), srv.Client(), srv.URL+"/tool.exe", sum(body), LaneAllowlist{Hosts: []string{host}}, dest)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	got, _ := os.ReadFile(dest)
	if string(got) != string(body) {
		t.Fatalf("dest = %q", got)
	}
}

func TestRefusesOffListHost(t *testing.T) {
	var hits int
	srv, _ := tlsServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	dest := filepath.Join(t.TempDir(), "tool.exe")
	err := Fetch(context.Background(), srv.Client(), srv.URL+"/tool.exe", sum(nil), LaneAllowlist{Hosts: []string{"dl.dell.com"}}, dest)
	if !errors.Is(err, ErrHostNotAllowed) {
		t.Fatalf("err = %v, want ErrHostNotAllowed", err)
	}
	if hits != 0 {
		t.Fatal("an off-list host was contacted")
	}
}

func TestHostMatchIsExact(t *testing.T) {
	allow := LaneAllowlist{Hosts: []string{"dl.vendor.example"}}
	for _, raw := range []string{
		"https://dl.vendor.example.evil.example/x", "https://evil-dl.vendor.example/x", "https://dl.vendor.exampl/x",
		"https://user@dl.vendor.example/x", "https://dl.vendor.example:8443/x",
	} {
		if err := checkFetchURL(raw, allow); err == nil {
			t.Errorf("%s allowed", raw)
		}
	}
	for _, raw := range []string{"https://dl.vendor.example/x", "https://DL.Vendor.Example/x", "https://dl.vendor.example:443/x"} {
		if err := checkFetchURL(raw, allow); err != nil {
			t.Errorf("%s refused: %v", raw, err)
		}
	}
}

func TestRefusesRedirectToOffListHost(t *testing.T) {
	var offListHits int
	off := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offListHits++
		_, _ = w.Write([]byte("evil"))
	}))
	defer off.Close()
	srv, host := tlsServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, off.URL+"/tool.exe", http.StatusFound)
	}))
	client := srv.Client()
	client.Transport.(*http.Transport).TLSClientConfig.RootCAs.AddCert(off.Certificate())
	dest := filepath.Join(t.TempDir(), "tool.exe")
	err := Fetch(context.Background(), client, srv.URL+"/tool.exe", sum([]byte("evil")), LaneAllowlist{Hosts: []string{host}}, dest)
	if !errors.Is(err, ErrHostNotAllowed) {
		t.Fatalf("err = %v, want ErrHostNotAllowed on the redirect hop", err)
	}
	if offListHits != 0 {
		t.Fatal("the redirect target was contacted")
	}
	if _, statErr := os.Stat(dest); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("a file was left at dest")
	}
}

func TestRedirectWithinListIsFollowed(t *testing.T) {
	body := []byte("ok")
	mux := http.NewServeMux()
	mux.HandleFunc("/a", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/b", http.StatusFound) })
	mux.HandleFunc("/b", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) })
	srv, host := tlsServer(t, mux)
	dest := filepath.Join(t.TempDir(), "tool.exe")
	if err := Fetch(context.Background(), srv.Client(), srv.URL+"/a", sum(body), LaneAllowlist{Hosts: []string{host}}, dest); err != nil {
		t.Fatalf("fetch: %v", err)
	}
}

func TestRefusesHTTP(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits++ }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	dest := filepath.Join(t.TempDir(), "tool.exe")
	err := Fetch(context.Background(), srv.Client(), srv.URL+"/tool.exe", sum(nil), LaneAllowlist{Hosts: []string{u.Host}}, dest)
	if err == nil || hits != 0 {
		t.Fatalf("plain http fetched (err=%v hits=%d)", err, hits)
	}
}

func TestShaMismatchDeletesFile(t *testing.T) {
	srv, host := tlsServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("tampered")) }))
	dir := t.TempDir()
	dest := filepath.Join(dir, "tool.exe")
	err := Fetch(context.Background(), srv.Client(), srv.URL+"/tool.exe", sum([]byte("genuine")), LaneAllowlist{Hosts: []string{host}}, dest)
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("err = %v, want ErrDigestMismatch", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("left behind: %v", entries)
	}
}

func TestSizeCapEnforced(t *testing.T) {
	restore := maxDownloadBytes
	maxDownloadBytes = 16
	defer func() { maxDownloadBytes = restore }()
	big := []byte(strings.Repeat("x", 17))
	for name, h := range map[string]http.HandlerFunc{
		"declared": func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(big) },
		"streamed": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Transfer-Encoding", "chunked")
			w.(http.Flusher).Flush()
			_, _ = w.Write(big)
		},
	} {
		t.Run(name, func(t *testing.T) {
			srv, host := tlsServer(t, h)
			dir := t.TempDir()
			err := Fetch(context.Background(), srv.Client(), srv.URL+"/tool.exe", sum(big), LaneAllowlist{Hosts: []string{host}}, filepath.Join(dir, "tool.exe"))
			if !errors.Is(err, ErrTooLarge) {
				t.Fatalf("err = %v, want ErrTooLarge", err)
			}
			if entries, _ := os.ReadDir(dir); len(entries) != 0 {
				t.Fatalf("left behind: %v", entries)
			}
		})
	}
}

func TestFetchNon200Fails(t *testing.T) {
	srv, host := tlsServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) }))
	err := Fetch(context.Background(), srv.Client(), srv.URL+"/gone.exe", sum(nil), LaneAllowlist{Hosts: []string{host}}, filepath.Join(t.TempDir(), "t.exe"))
	if err == nil {
		t.Fatal("a 404 fetched")
	}
}

// The allowlist is per role: the Dell tool installer may only be Dell-signed
// from Dell's hosts, and only the .NET prerequisite may be Microsoft's.
// Otherwise any Microsoft-signed binary on a Microsoft host could be run as
// the "tool installer".
func TestCompiledAllowlistIsPerRole(t *testing.T) {
	tool, ok := laneAllowlist(LaneDell)
	if !ok {
		t.Fatal("no dell entry in allowlist.json")
	}
	if strings.Join(tool.Publishers, ",") != "Dell Inc" {
		t.Errorf("dell tool publishers = %v, want only Dell Inc", tool.Publishers)
	}
	if strings.Join(tool.Hosts, ",") != "dl.dell.com,downloads.dell.com" {
		t.Errorf("dell tool hosts = %v", tool.Hosts)
	}
	rt, ok := prerequisiteAllowlist(LaneDell, "dotnet_desktop_runtime")
	if !ok {
		t.Fatal("no dotnet_desktop_runtime entry")
	}
	if strings.Join(rt.Publishers, ",") != "Microsoft Corporation" {
		t.Errorf("runtime publishers = %v", rt.Publishers)
	}
	if strings.Join(rt.Hosts, ",") != "builds.dotnet.microsoft.com,download.visualstudio.microsoft.com" {
		t.Errorf("runtime hosts = %v", rt.Hosts)
	}
	if _, ok := laneAllowlist("acme"); ok {
		t.Fatal("an unknown lane has an allowlist")
	}
	if _, ok := prerequisiteAllowlist(LaneDell, "anything_else"); ok {
		t.Fatal("an unknown prerequisite has an allowlist")
	}
}
