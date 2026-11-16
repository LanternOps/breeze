package heartbeat

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/updater"
)

type fakeRecoveryDownloader struct {
	t           *testing.T
	body        []byte
	downloadErr error
	env         updater.ReleaseEnvelope
	envErr      error
	temp        string
	digestArgs  []string
}

func (f *fakeRecoveryDownloader) DownloadBinary(version string) (string, error) {
	if f.downloadErr != nil {
		return "", f.downloadErr
	}
	f.temp = filepath.Join(f.t.TempDir(), "download-"+version)
	if err := os.WriteFile(f.temp, f.body, 0o600); err != nil {
		f.t.Fatal(err)
	}
	return f.temp, nil
}

func (f *fakeRecoveryDownloader) VerifiedDownloadEnvelope(string) (updater.ReleaseEnvelope, error) {
	return f.env, f.envErr
}

func (f *fakeRecoveryDownloader) VerifiedReleaseAssetSHA256(manifest, signature, keyID, version, asset string) (string, error) {
	f.digestArgs = []string{manifest, signature, keyID, version, asset}
	return "abc", nil
}

func TestRecoveryDistributionFetchCopiesVerifiedDownload(t *testing.T) {
	f := &fakeRecoveryDownloader{t: t, body: []byte("verified recovery bytes")}
	_, src := recoveryDistribution(func() recoveryDownloader { return f }, true)
	var buf bytes.Buffer
	if err := src.Fetch(context.Background(), "1.2.3", &buf); err != nil {
		t.Fatal(err)
	}
	if buf.String() != "verified recovery bytes" {
		t.Fatalf("fetched %q", buf.String())
	}
	if _, err := os.Stat(f.temp); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("updater temp download not removed: %v", err)
	}
}

func TestRecoveryDistributionFetchFailureWritesNothing(t *testing.T) {
	sentinel := errors.New("checksum mismatch")
	f := &fakeRecoveryDownloader{t: t, downloadErr: sentinel}
	_, src := recoveryDistribution(func() recoveryDownloader { return f }, true)
	var buf bytes.Buffer
	if err := src.Fetch(context.Background(), "1.2.3", &buf); !errors.Is(err, sentinel) {
		t.Fatalf("want the download error, got %v", err)
	}
	if buf.Len() != 0 {
		t.Fatal("bytes written despite a failed verified download")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := src.Fetch(ctx, "1.2.3", &buf); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled fetch: %v", err)
	}
}

func TestRecoveryDistributionEnvelopeAndDigest(t *testing.T) {
	f := &fakeRecoveryDownloader{t: t, env: updater.ReleaseEnvelope{Manifest: "m", Signature: "s", SigningKeyID: "k"}}
	trust, src := recoveryDistribution(func() recoveryDownloader { return f }, true)
	env, err := src.FetchEnvelope(context.Background(), "1.2.3")
	if err != nil || env != (recoveryinstall.ManifestEnvelope{Manifest: "m", Signature: "s", SigningKeyID: "k"}) {
		t.Fatalf("envelope %+v %v", env, err)
	}
	if !trust.SelfHostEdition || trust.ManifestDigest == nil {
		t.Fatalf("self-host trust not configured: %+v", trust)
	}
	if _, err := trust.ManifestDigest(env, "1.2.3", "asset.exe"); err != nil {
		t.Fatal(err)
	}
	want := []string{"m", "s", "k", "1.2.3", "asset.exe"}
	for i := range want {
		if f.digestArgs[i] != want[i] {
			t.Fatalf("digest args %v, want %v", f.digestArgs, want)
		}
	}
	f.envErr = errors.New("untrusted")
	if _, err := src.FetchEnvelope(context.Background(), "1.2.3"); err == nil {
		t.Fatal("untrusted envelope accepted")
	}
}

func TestRecoveryDistributionHostedHasNoPathB(t *testing.T) {
	trust, _ := recoveryDistribution(func() recoveryDownloader { return &fakeRecoveryDownloader{t: t} }, false)
	if trust.SelfHostEdition {
		t.Fatal("hosted build enabled the self-host manifest-hash path")
	}
}

// The edition signal is the updater's: a hosted (allowlist-enforced) build is
// never self-host.
func TestRecoverySelfHostEditionFollowsHostPolicy(t *testing.T) {
	if !recoverySelfHostEdition() {
		t.Fatal("unenforced build should be self-host")
	}
	restore := hostpolicy.SetAllowedHostsForTest("hosted.example")
	defer restore()
	if recoverySelfHostEdition() {
		t.Fatal("hosted build reported self-host")
	}
}

// The recovery downloader is the ordinary signed-manifest updater for the
// isolation-recovery component, with the agent's live trust settings.
func TestRecoveryUpdaterConfig(t *testing.T) {
	h := &Heartbeat{
		config:       &config.Config{ServerURL: "https://control.example", PinnedManifestPubKeys: []string{"k:AAAA"}, RequireManifestSigningKeyID: true},
		secureToken:  secmem.NewSecureString("brz_test"),
		agentVersion: "1.2.3",
	}
	cfg := recoveryUpdaterConfig(h)
	if cfg.Component != "isolation-recovery" || cfg.AuthToken == nil || cfg.CurrentVersion != "1.2.3" {
		t.Fatalf("config %+v", cfg)
	}
	if len(cfg.PinnedManifestPubKeys) != 1 || cfg.PinnedManifestPubKeys[0] != "k:AAAA" || !cfg.RequireManifestSigningKeyID {
		t.Fatalf("trust settings not carried: %+v", cfg)
	}
	if cfg.ServerURL == nil || cfg.ServerURL() != "https://control.example" {
		t.Fatal("server URL not wired")
	}
}
