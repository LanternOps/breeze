package updater

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
)

func recoveryAssetName() string {
	name := "breeze-isolation-recovery-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// envelopeServer serves download info for the isolation-recovery component and
// counts binary downloads, which VerifiedDownloadEnvelope must never make.
func envelopeServer(t *testing.T, info func(host string) downloadInfo) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var binaryHits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/agent-versions/1.0.0/download":
			if got := r.URL.Query().Get("component"); got != "isolation-recovery" {
				t.Errorf("component query = %q", got)
			}
			if r.Header.Get("Authorization") != "Bearer test-token" {
				t.Error("download info requested without the agent credential")
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(info(r.Host))
		default:
			binaryHits.Add(1)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server, &binaryHits
}

func recoveryUpdater(server *httptest.Server) *Updater {
	u := New(&Config{ServerURL: staticServerURL(server.URL), AuthToken: secmem.NewSecureString("test-token"), Component: "isolation-recovery"})
	u.client = server.Client()
	return u
}

func TestVerifiedDownloadEnvelope(t *testing.T) {
	content := []byte("recovery executable bytes")
	var served downloadInfo
	server, binaryHits := envelopeServer(t, func(host string) downloadInfo {
		served = signedReleaseArtifactDownloadInfo(t, "1.0.0", recoveryAssetName(), "http://"+host+"/binary", content)
		return served
	})
	u := recoveryUpdater(server)
	env, err := u.VerifiedDownloadEnvelope("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if env.Manifest != served.Manifest || env.Signature != served.ManifestSignature || env.SigningKeyID != served.SigningKeyID {
		t.Fatalf("envelope %+v does not carry the served manifest", env)
	}
	if binaryHits.Load() != 0 {
		t.Fatal("fetching the envelope downloaded the binary")
	}
	// The persisted envelope must satisfy the same trust check Path B makes.
	sha, err := u.VerifiedReleaseAssetSHA256(env.Manifest, env.Signature, env.SigningKeyID, "1.0.0", recoveryAssetName())
	if err != nil || sha != served.Checksum {
		t.Fatalf("Path B check of the returned envelope: %q %v", sha, err)
	}
}

func TestVerifiedDownloadEnvelopeRefusesUntrusted(t *testing.T) {
	content := []byte("recovery executable bytes")
	for _, tc := range []struct {
		name   string
		mutate func(*downloadInfo)
		asset  string
	}{
		{name: "tampered manifest", mutate: func(d *downloadInfo) { d.Manifest = strings.Replace(d.Manifest, "1.0.0", "1.0.1", 1) }},
		{name: "missing signature", mutate: func(d *downloadInfo) { d.ManifestSignature = "" }},
		{name: "manifest lacks the recovery asset", asset: "breeze-agent-" + runtime.GOOS + "-" + runtime.GOARCH},
		{name: "checksum not the signed one", mutate: func(d *downloadInfo) { d.Checksum = strings.Repeat("0", 64) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			asset := tc.asset
			if asset == "" {
				asset = recoveryAssetName()
			}
			server, _ := envelopeServer(t, func(host string) downloadInfo {
				d := signedReleaseArtifactDownloadInfo(t, "1.0.0", asset, "http://"+host+"/binary", content)
				if tc.mutate != nil {
					tc.mutate(&d)
				}
				return d
			})
			env, err := recoveryUpdater(server).VerifiedDownloadEnvelope("1.0.0")
			if err == nil {
				t.Fatalf("untrusted download info accepted: %+v", env)
			}
			if env != (ReleaseEnvelope{}) {
				t.Fatalf("returned an envelope alongside an error: %+v", env)
			}
		})
	}
}

func TestVerifiedDownloadEnvelopeRequiresComponent(t *testing.T) {
	u := New(&Config{ServerURL: staticServerURL("http://control.example.test"), AuthToken: secmem.NewSecureString("t")})
	if _, err := u.VerifiedDownloadEnvelope("1.0.0"); err == nil || !errors.Is(err, errEnvelopeComponent) {
		t.Fatalf("agent-component envelope fetch: want errEnvelopeComponent, got %v", err)
	}
}
