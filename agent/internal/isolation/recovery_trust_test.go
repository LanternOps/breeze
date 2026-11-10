package isolation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
)

const trustTestVersion = "1.2.3"

var trustTestAsset = recoveryinstall.ReleaseAssetName("windows", runtime.GOARCH)

// installedRecovery lays out <install>/isolation-recovery/<version>/ the way
// the installer places it: the unsigned exe and its signed release manifest.
func installedRecovery(t *testing.T, exe []byte) (installDir, exePath string) {
	t.Helper()
	installDir = filepath.Join(t.TempDir(), "Breeze")
	dir := filepath.Join(installDir, recoveryinstall.RecoveryDirName, trustTestVersion)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// The installer's own file name for this OS (".exe" only on Windows).
	name := "breeze-isolation-recovery"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	exePath = filepath.Join(dir, name)
	if err := os.WriteFile(exePath, exe, 0o700); err != nil {
		t.Fatal(err)
	}
	env, _ := json.Marshal(recoveryinstall.ManifestEnvelope{Manifest: "signed manifest", Signature: "sig", SigningKeyID: "release-artifact-manifest-ed25519"})
	if err := os.WriteFile(filepath.Join(dir, recoveryinstall.ManifestEnvelopeName), env, 0o600); err != nil {
		t.Fatal(err)
	}
	return installDir, exePath
}

// selfHostManifestTrust stands in for updater.VerifiedReleaseAssetSHA256 over a
// manifest that lists sha for the recovery asset at trustTestVersion.
func selfHostManifestTrust(selfHost bool, exe []byte) recoveryinstall.ManifestTrust {
	sum := sha256.Sum256(exe)
	return recoveryinstall.ManifestTrust{
		SelfHostEdition: selfHost,
		ManifestDigest: func(env recoveryinstall.ManifestEnvelope, version, asset string) (string, error) {
			if env.Signature != "sig" || version != trustTestVersion || asset != trustTestAsset {
				return "", errors.New("manifest does not verify for this version and asset")
			}
			return hex.EncodeToString(sum[:]), nil
		},
	}
}

func TestWindowsSchedulerRecoveryTrust(t *testing.T) {
	exe := []byte("unsigned self-host recovery")
	unsigned := func(string) error { return errors.New("WinVerifyTrust status 0x800b0100") }
	for _, tc := range []struct {
		name      string
		signed    bool
		manifest  *recoveryinstall.ManifestTrust
		tamper    bool
		wantTrust recoveryinstall.TrustPath
	}{
		{name: "A: Authenticode-signed exe, hosted", signed: true, wantTrust: recoveryinstall.TrustCodeSignature},
		{name: "B: unsigned exe + matching signed-manifest hash, self-host", manifest: ptr(selfHostManifestTrust(true, exe)), wantTrust: recoveryinstall.TrustManifestHash},
		{name: "hosted edition: matching manifest is not consulted", manifest: ptr(selfHostManifestTrust(false, exe))},
		{name: "self-host without manifest trust configured"},
		{name: "self-host: exe tampered after install", manifest: ptr(selfHostManifestTrust(true, exe)), tamper: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, exePath := installedRecovery(t, exe)
			s, _, calls := newFakeRecoveryScheduler(t)
			s.recoveryPath = func() (string, error) { return exePath, nil }
			if !tc.signed {
				s.verifySignature = unsigned
			}
			if tc.manifest != nil {
				ConfigureRecoveryManifestTrust(s, *tc.manifest)
			}
			if tc.tamper {
				// Trusted at install time, then rewritten in place.
				if err := s.EnsurePoll(); err != nil {
					t.Fatalf("poll before tamper: %v", err)
				}
				if err := os.WriteFile(exePath, append([]byte("evil "), exe...), 0o700); err != nil {
					t.Fatal(err)
				}
				*calls = nil
			} else if tc.wantTrust != "" {
				if err := s.EnsurePoll(); err != nil {
					t.Fatalf("EnsurePoll: %v", err)
				}
			}
			trust, err := s.recoveryReadiness()
			ready, why := s.Ready()
			if tc.wantTrust == "" {
				if !errors.Is(err, recoveryinstall.ErrUntrusted) || trust != "" || ready || why == "" {
					t.Fatalf("want untrusted: trust=%q err=%v ready=%v why=%q", trust, err, ready, why)
				}
				if err := s.ArmProvisional("attempt-1", s.now()); !errors.Is(err, recoveryinstall.ErrUntrusted) {
					t.Fatalf("armed an untrusted recovery executable: %v", err)
				}
				if len(*calls) != 0 {
					t.Fatalf("ran schtasks for an untrusted executable: %v", *calls)
				}
				return
			}
			if err != nil || trust != tc.wantTrust || !ready {
				t.Fatalf("trust=%q err=%v ready=%v why=%q", trust, err, ready, why)
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }

// The production asset name follows the agent's architecture when the wiring
// leaves it empty, matching the updater's isolation-recovery component.
func TestConfigureRecoveryManifestTrustDefaultsAssetName(t *testing.T) {
	s, _, _ := newFakeRecoveryScheduler(t)
	ConfigureRecoveryManifestTrust(s, recoveryinstall.ManifestTrust{SelfHostEdition: true})
	if got := s.trustPolicy().AssetName; got != trustTestAsset {
		t.Fatalf("asset name %q, want %q", got, trustTestAsset)
	}
	// Schedulers without a manifest path (macOS, the unsupported stub, fakes)
	// ignore the call.
	ConfigureRecoveryManifestTrust(newFakeScheduler(&callLog{}), recoveryinstall.ManifestTrust{SelfHostEdition: true})
}

// Ready() and the EnsureRecovery verify step take the same policy, so an
// executable the installer adopts via Path B is the one the scheduler accepts,
// and a hosted edition refuses it in both places.
func TestInstallerAndSchedulerShareRecoveryTrust(t *testing.T) {
	exe := []byte("unsigned self-host recovery")
	unsigned := func(string) error { return errors.New("unsigned") }
	for _, selfHost := range []bool{true, false} {
		t.Run(map[bool]string{true: "self-host", false: "hosted"}[selfHost], func(t *testing.T) {
			installDir, exePath := installedRecovery(t, exe)
			dataDir := filepath.Join(t.TempDir(), "data")
			if err := os.MkdirAll(dataDir, 0o700); err != nil {
				t.Fatal(err)
			}
			s, _, _ := newFakeRecoveryScheduler(t)
			s.verifySignature = unsigned
			s.recoveryPath = func() (string, error) { return exePath, nil }
			ConfigureRecoveryManifestTrust(s, selfHostManifestTrust(selfHost, exe))
			policy := s.trustPolicy()
			installer := &recoveryinstall.Installer{
				InstallDir: installDir, DataDir: dataDir,
				Fetch:           func(context.Context, string, io.Writer) error { t.Fatal("bundled version re-downloaded"); return nil },
				VerifySignature: policy.CodeSignature, ManifestTrust: policy.ManifestTrust,
				SupportedSchema: func(context.Context, string) (int, error) { return journal.SchemaVersion, nil },
				SelfTest:        func(context.Context, string) error { return nil },
				Tasks:           func() ([]recoveryinstall.Task, error) { return nil, nil },
				Repoint:         func(recoveryinstall.Task, string) error { return nil },
			}
			path, installErr := installer.EnsureRecovery(context.Background(), trustTestVersion)
			if !selfHost {
				_, schedErr := s.recoveryReadiness()
				if !errors.Is(installErr, recoveryinstall.ErrUntrusted) || !errors.Is(schedErr, recoveryinstall.ErrUntrusted) {
					t.Fatalf("hosted accepted an unsigned exe: install=%v scheduler=%v", installErr, schedErr)
				}
				return
			}
			if installErr != nil || path != exePath {
				t.Fatalf("install: %q %v", path, installErr)
			}
			if err := s.EnsurePoll(); err != nil {
				t.Fatal(err)
			}
			if trust, schedErr := s.recoveryReadiness(); schedErr != nil || trust != recoveryinstall.TrustManifestHash {
				t.Fatalf("scheduler: %q %v", trust, schedErr)
			}
			j, err := journal.Load(journal.Path(dataDir))
			if err != nil {
				t.Fatal(err)
			}
			last := j.Events[len(j.Events)-1]
			if last.Type != recoveryinstall.RecoveryTrustEvent || last.Detail != "manifest_hash "+trustTestVersion {
				t.Fatalf("journal trust event %+v", last)
			}
		})
	}
}

// The readiness probe turns the scheduler's trust decision into the cached
// capability: untrusted → recovery_untrusted, Path B → its detail string.
func TestReadinessProbeCarriesRecoveryTrust(t *testing.T) {
	untrusted := errors.New("verify recovery executable: " + recoveryinstall.ErrUntrusted.Error())
	for _, tc := range []struct {
		name  string
		trust recoveryinstall.TrustPath
		sched error
		want  Capability
	}{
		{name: "manifest hash", trust: recoveryinstall.TrustManifestHash, want: Capability{Version: 1, Mechanism: "wfp", Ready: true, UnsupportedReason: "self_host_manifest_hash"}},
		{name: "authenticode", trust: recoveryinstall.TrustCodeSignature, want: Capability{Version: 1, Mechanism: "wfp", Ready: true}},
		{name: "untrusted", sched: wrapUntrusted(untrusted), want: Capability{Mechanism: "wfp", UnsupportedReason: "recovery_untrusted"}},
		{name: "other scheduler failure", sched: errors.New("read back poll: mismatch"), want: Capability{Mechanism: "wfp", UnsupportedReason: "scheduler_unavailable"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := readinessFromProbe(nil, nil, func() (recoveryinstall.TrustPath, error) { return tc.trust, tc.sched })
			if got := wfpCapability(in, true); got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

func wrapUntrusted(err error) error { return errors.Join(recoveryinstall.ErrUntrusted, err) }

// A scheduler that only implements Ready() (macOS, fakes) still feeds the probe.
func TestSchedulerReadinessAdaptsPlainSchedulers(t *testing.T) {
	for _, ready := range []bool{true, false} {
		f := newFakeScheduler(&callLog{})
		f.ready, f.readyReason = ready, "poll task missing"
		trust, err := schedulerReadiness(f)()
		if ok, why := f.Ready(); ok != (err == nil) || (err != nil && err.Error() != why) || trust != "" {
			t.Fatalf("adapter disagrees with Ready(): trust=%q err=%v ok=%v why=%q", trust, err, ok, why)
		}
		if in := readinessFromProbe(nil, nil, schedulerReadiness(f)); in.schedulerReady != ready || in.schedulerUntrusted {
			t.Fatalf("probe inputs %+v for ready=%v", in, ready)
		}
	}
}

// Through the real cache: the Path B detail reaches Capability(), and a later
// probe that is ready via Authenticode (or untrusted) replaces it rather than
// leaving a stale "self_host_manifest_hash".
func TestReadinessCacheCarriesTrustDetailAcrossRefreshes(t *testing.T) {
	trust, schedErr := recoveryinstall.TrustManifestHash, error(nil)
	cache := readinessCache{probe: func(context.Context) readinessInputs {
		return readinessFromProbe(nil, nil, func() (recoveryinstall.TrustPath, error) { return trust, schedErr })
	}}
	steps := []struct {
		trust recoveryinstall.TrustPath
		err   error
		want  Capability
	}{
		{recoveryinstall.TrustManifestHash, nil, Capability{Version: 1, Mechanism: "wfp", Ready: true, UnsupportedReason: "self_host_manifest_hash"}},
		{recoveryinstall.TrustCodeSignature, nil, Capability{Version: 1, Mechanism: "wfp", Ready: true}},
		{"", wrapUntrusted(errors.New("hash drift")), Capability{Mechanism: "wfp", UnsupportedReason: "recovery_untrusted"}},
		{recoveryinstall.TrustManifestHash, nil, Capability{Version: 1, Mechanism: "wfp", Ready: true, UnsupportedReason: "self_host_manifest_hash"}},
	}
	for i, step := range steps {
		trust, schedErr = step.trust, step.err
		cache.refresh(context.Background(), true)
		if got := cache.capability(true); got != step.want {
			t.Fatalf("step %d: got %+v want %+v", i, got, step.want)
		}
	}
}
