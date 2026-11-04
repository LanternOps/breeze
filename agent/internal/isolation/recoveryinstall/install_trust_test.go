package recoveryinstall

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// placeEnvelope puts the signed release manifest where the distributor (MSI
// bundle or updater-component fetcher) places it: next to the executable.
func placeEnvelope(t *testing.T, i *Installer, version string, env *ManifestEnvelope) {
	t.Helper()
	dir := filepath.Join(i.InstallDir, RecoveryDirName, version)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestEnvelopeName), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func trustEvents(t *testing.T, i *Installer) []journal.Event {
	t.Helper()
	j, err := journal.Load(journal.Path(i.DataDir))
	if err != nil {
		t.Fatal(err)
	}
	var out []journal.Event
	for _, e := range j.Events {
		if e.Type == RecoveryTrustEvent {
			out = append(out, e)
		}
	}
	return out
}

// The fixture's Fetch writes these bytes.
var fetchedHash = shaHex([]byte("signed recovery"))

func TestEnsureRecoveryHonoursTrustPaths(t *testing.T) {
	unsigned := errors.New("WinVerifyTrust status 0x800b0100")
	for _, tc := range []struct {
		name      string
		signed    bool
		manifest  ManifestTrust
		envelope  bool
		wantTrust TrustPath
	}{
		{name: "A: signed exe", signed: true, wantTrust: TrustCodeSignature},
		{
			name:      "B: unsigned exe, self-host, matching signed-manifest hash",
			manifest:  ManifestTrust{SelfHostEdition: true, AssetName: testAsset, ManifestDigest: fakeManifestDigest("1.2.3", map[string]string{testAsset: fetchedHash})},
			envelope:  true,
			wantTrust: TrustManifestHash,
		},
		{
			name:     "hosted edition: unsigned exe refused despite a matching manifest",
			manifest: ManifestTrust{SelfHostEdition: false, AssetName: testAsset, ManifestDigest: fakeManifestDigest("1.2.3", map[string]string{testAsset: fetchedHash})},
			envelope: true,
		},
		{
			name:     "self-host: hash mismatch refused",
			manifest: ManifestTrust{SelfHostEdition: true, AssetName: testAsset, ManifestDigest: fakeManifestDigest("1.2.3", map[string]string{testAsset: shaHex([]byte("other"))})},
			envelope: true,
		},
		{
			name:     "self-host: no manifest next to the exe",
			manifest: ManifestTrust{SelfHostEdition: true, AssetName: testAsset, ManifestDigest: fakeManifestDigest("1.2.3", map[string]string{testAsset: fetchedHash})},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i, _, repointed := installerFixture(t)
			if !tc.signed {
				i.VerifySignature = func(string) error { return unsigned }
			}
			i.ManifestTrust = tc.manifest
			if tc.envelope {
				placeEnvelope(t, i, "1.2.3", signedEnvelope("1.2.3"))
			}
			path, err := i.EnsureRecovery(context.Background(), "1.2.3")
			if tc.wantTrust == "" {
				if !errors.Is(err, ErrUntrusted) || !errors.Is(err, unsigned) {
					t.Fatalf("want ErrUntrusted wrapping the signature failure, got %v", err)
				}
				if len(*repointed) != 0 {
					t.Fatal("repointed an untrusted executable")
				}
				if _, statErr := os.Stat(filepath.Join(i.InstallDir, RecoveryDirName, "1.2.3", recoveryExecutableName())); !errors.Is(statErr, os.ErrNotExist) {
					t.Fatal("untrusted executable was published")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			events := trustEvents(t, i)
			if len(events) != 1 || events[0].Detail != string(tc.wantTrust)+" 1.2.3" {
				t.Fatalf("journal trust events = %+v", events)
			}
			// Re-running readiness does not churn the bounded event log.
			if again, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil || again != path {
				t.Fatalf("second ensure: %q %v", again, err)
			}
			if events := trustEvents(t, i); len(events) != 1 {
				t.Fatalf("trust event re-appended: %+v", events)
			}
		})
	}
}

// An exe adopted from disk (MSI-bundled) is re-verified, and a tampered one is
// refused rather than adopted.
func TestEnsureRecoveryRefusesTamperedBundledExecutable(t *testing.T) {
	i, downloads, repointed := installerFixture(t)
	i.VerifySignature = func(string) error { return errors.New("unsigned") }
	i.ManifestTrust = ManifestTrust{SelfHostEdition: true, AssetName: testAsset, ManifestDigest: fakeManifestDigest("1.2.3", map[string]string{testAsset: fetchedHash})}
	placeEnvelope(t, i, "1.2.3", signedEnvelope("1.2.3"))
	path := filepath.Join(i.InstallDir, RecoveryDirName, "1.2.3", recoveryExecutableName())
	if err := os.WriteFile(path, []byte("signed recovery, then tampered"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); !errors.Is(err, ErrUntrusted) {
		t.Fatalf("want ErrUntrusted, got %v", err)
	}
	if *downloads != 0 || len(*repointed) != 0 {
		t.Fatalf("downloads=%d repoints=%v", *downloads, *repointed)
	}
}

// A changed trust path for the same version is recorded again.
func TestEnsureRecoveryRecordsTrustPathChange(t *testing.T) {
	i, _, _ := installerFixture(t)
	signed := true
	i.VerifySignature = func(string) error {
		if signed {
			return nil
		}
		return errors.New("unsigned")
	}
	i.ManifestTrust = ManifestTrust{SelfHostEdition: true, AssetName: testAsset, ManifestDigest: fakeManifestDigest("1.2.3", map[string]string{testAsset: fetchedHash})}
	placeEnvelope(t, i, "1.2.3", signedEnvelope("1.2.3"))
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatal(err)
	}
	signed = false
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatal(err)
	}
	events := trustEvents(t, i)
	if len(events) != 2 || events[0].Detail != "code_signature 1.2.3" || events[1].Detail != "manifest_hash 1.2.3" {
		t.Fatalf("events = %+v", events)
	}
}
