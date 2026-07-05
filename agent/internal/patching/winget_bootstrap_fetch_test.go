package patching

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVerifySHA256(t *testing.T) {
	data := []byte("hello winget")
	sum := sha256.Sum256(data)
	if err := verifySHA256(data, hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if err := verifySHA256(data, "deadbeef"); err == nil {
		t.Fatal("want mismatch error")
	}
}

func TestFetchArtifactVerifies(t *testing.T) {
	body := []byte("bundle-bytes")
	sum := sha256.Sum256(body)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/artifacts/winget/appinstaller.msixbundle" {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	defer srv.Close()

	ref := artifactRef{Name: "appinstaller", SHA256: hex.EncodeToString(sum[:]), Path: "/artifacts/winget/appinstaller.msixbundle"}
	got, err := fetchArtifact(srv.Client(), srv.URL, ref)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatalf("body mismatch")
	}

	bad := ref
	bad.SHA256 = "00"
	if _, err := fetchArtifact(srv.Client(), srv.URL, bad); err == nil {
		t.Fatal("want SHA mismatch error")
	}
}
