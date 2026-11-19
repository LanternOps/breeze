package recoveryinstall

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// selfHostUnsigned configures the fixture as a public self-host build: the
// fetched executable has no Authenticode, so only trust Path B can accept it.
func selfHostUnsigned(i *Installer) {
	i.VerifySignature = func(string) error { return errUnsigned }
	i.ManifestTrust = ManifestTrust{SelfHostEdition: true, AssetName: testAsset,
		ManifestDigest: fakeManifestDigest("1.2.3", map[string]string{testAsset: fetchedHash})}
}

func envelopePath(i *Installer, version string) string {
	return filepath.Join(i.InstallDir, RecoveryDirName, version, ManifestEnvelopeName)
}

// The production fetcher persists the signed envelope beside the executable
// before staging, so Path B can verify the staged and published file.
func TestEnsureRecoveryPersistsFetchedEnvelopeForPathB(t *testing.T) {
	i, downloads, repointed := installerFixture(t)
	selfHostUnsigned(i)
	calls := 0
	i.FetchEnvelope = func(_ context.Context, version string) (ManifestEnvelope, error) {
		calls++
		return *signedEnvelope(version), nil
	}
	path, err := i.EnsureRecovery(context.Background(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || *downloads != 1 || len(*repointed) != 2 {
		t.Fatalf("envelope calls=%d downloads=%d repoints=%v", calls, *downloads, *repointed)
	}
	data, err := os.ReadFile(envelopePath(i, "1.2.3"))
	if err != nil {
		t.Fatalf("envelope not persisted: %v", err)
	}
	var got ManifestEnvelope
	if err := json.Unmarshal(data, &got); err != nil || got != *signedEnvelope("1.2.3") {
		t.Fatalf("persisted envelope = %+v (%v)", got, err)
	}
	if events := trustEvents(t, i); len(events) != 1 || events[0].Detail != "manifest_hash 1.2.3" {
		t.Fatalf("trust events = %+v", events)
	}
	// Present envelope: never re-fetched, never rewritten.
	if again, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil || again != path {
		t.Fatalf("second ensure: %q %v", again, err)
	}
	if calls != 1 {
		t.Fatalf("envelope re-fetched although present (calls=%d)", calls)
	}
}

// Hosted (or any Path-A-only) builds never fetch or write an envelope.
func TestEnsureRecoveryNoEnvelopeWithoutPathB(t *testing.T) {
	for _, tc := range []struct {
		name string
		mt   ManifestTrust
	}{
		{name: "hosted edition", mt: ManifestTrust{SelfHostEdition: false, AssetName: testAsset, ManifestDigest: fakeManifestDigest("1.2.3", nil)}},
		{name: "path B unconfigured", mt: ManifestTrust{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			i, _, _ := installerFixture(t)
			i.ManifestTrust = tc.mt
			i.FetchEnvelope = func(context.Context, string) (ManifestEnvelope, error) {
				t.Fatal("envelope fetched without Path B")
				return ManifestEnvelope{}, nil
			}
			if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(envelopePath(i, "1.2.3")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("envelope written without Path B: %v", err)
			}
		})
	}
}

// An envelope fetch failure is reported, and an unsigned executable is then
// refused (fail closed) and never published. A signed executable does not
// need the envelope, so the same failure does not block Path A.
func TestEnsureRecoveryEnvelopeFetchFailure(t *testing.T) {
	sentinel := errors.New("download info unavailable")
	t.Run("unsigned executable refused", func(t *testing.T) {
		i, _, repointed := installerFixture(t)
		selfHostUnsigned(i)
		i.FetchEnvelope = func(context.Context, string) (ManifestEnvelope, error) { return ManifestEnvelope{}, sentinel }
		_, err := i.EnsureRecovery(context.Background(), "1.2.3")
		if !errors.Is(err, ErrUntrusted) || !errors.Is(err, sentinel) {
			t.Fatalf("want ErrUntrusted joined with the fetch failure, got %v", err)
		}
		if len(*repointed) != 0 {
			t.Fatal("repointed an untrusted executable")
		}
		if _, statErr := os.Stat(filepath.Join(i.InstallDir, RecoveryDirName, "1.2.3", recoveryExecutableName())); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatal("untrusted executable was published")
		}
	})
	t.Run("signed executable still accepted", func(t *testing.T) {
		i, _, _ := installerFixture(t)
		selfHostUnsigned(i)
		i.VerifySignature = func(string) error { return nil }
		i.FetchEnvelope = func(context.Context, string) (ManifestEnvelope, error) { return ManifestEnvelope{}, sentinel }
		if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
			t.Fatal(err)
		}
	})
}

// A served envelope without a manifest or signature is never persisted.
func TestEnsureRecoveryRejectsIncompleteEnvelope(t *testing.T) {
	for _, env := range []ManifestEnvelope{{Manifest: "manifest:1.2.3"}, {Signature: "signed-by-trust-root"}} {
		i, _, _ := installerFixture(t)
		selfHostUnsigned(i)
		i.FetchEnvelope = func(context.Context, string) (ManifestEnvelope, error) { return env, nil }
		if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); !errors.Is(err, ErrUntrusted) {
			t.Fatalf("incomplete envelope %+v: want ErrUntrusted, got %v", env, err)
		}
		if _, err := os.Stat(envelopePath(i, "1.2.3")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("incomplete envelope persisted: %v", err)
		}
	}
}

// While an episode is unresolved the tasks stay on the journal's pinned path.
// A failed fetch of a newer version must not turn a usable pinned recovery
// into a readiness failure.
func TestEnsureRecoveryPinnedEpisodeSurvivesFetchFailure(t *testing.T) {
	i, _, repointed := installerFixture(t)
	pinned, err := i.EnsureRecovery(context.Background(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	*repointed = nil
	j, err := journal.Load(journal.Path(i.DataDir))
	if err != nil {
		t.Fatal(err)
	}
	j.Phase = journal.PhaseCommitted
	if err := journal.Save(journal.Path(i.DataDir), j); err != nil {
		t.Fatal(err)
	}
	i.Fetch = func(context.Context, string, io.Writer) error { return errors.New("artifact host unreachable") }
	got, err := i.EnsureRecovery(context.Background(), "1.2.4")
	if err != nil || got != pinned {
		t.Fatalf("pinned episode: got %q, %v; want %q", got, err, pinned)
	}
	if len(*repointed) != 0 {
		t.Fatal("repointed tasks during an unresolved episode")
	}
	// A pinned executable that no longer verifies is still an error.
	i.VerifySignature = func(string) error { return errUnsigned }
	if _, err := i.EnsureRecovery(context.Background(), "1.2.4"); err == nil {
		t.Fatal("untrusted pinned recovery reported ready")
	}
}

// With no unresolved episode a fetch failure is still a failure.
func TestEnsureRecoveryIdleFetchFailureStillFails(t *testing.T) {
	i, _, _ := installerFixture(t)
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatal(err)
	}
	i.Fetch = func(context.Context, string, io.Writer) error { return errors.New("artifact host unreachable") }
	if _, err := i.EnsureRecovery(context.Background(), "1.2.4"); err == nil {
		t.Fatal("idle fetch failure reported success")
	}
}

// A readiness re-probe of an installed, unchanged recovery must not re-register
// tasks or rewrite the journal: re-registration resets the poll task's start
// boundary and churns Task Scheduler on every healthy device.
func TestEnsureRecoveryIdleReprobeIsNoOp(t *testing.T) {
	i, _, repointed := installerFixture(t)
	current := map[string]bool{}
	i.TaskCurrent = func(task Task, path string) bool { return current[task.Name+"|"+path] }
	path, err := i.EnsureRecovery(context.Background(), "1.2.3")
	if err != nil || len(*repointed) != 2 {
		t.Fatalf("first ensure: %v repoints=%v", err, *repointed)
	}
	current["poll|"+path], current["expiry|"+path] = true, true
	before, err := os.Stat(journal.Path(i.DataDir))
	if err != nil {
		t.Fatal(err)
	}
	if again, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil || again != path {
		t.Fatalf("re-probe: %q %v", again, err)
	}
	if len(*repointed) != 2 {
		t.Fatalf("re-probe repointed current tasks: %v", *repointed)
	}
	after, err := os.Stat(journal.Path(i.DataDir))
	if err != nil || !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("re-probe rewrote the journal")
	}
	// A task that drifted (deleted, disabled, repointed elsewhere) is repaired.
	current["expiry|"+path] = false
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatal(err)
	}
	if len(*repointed) != 4 {
		t.Fatalf("drifted task not repaired: %v", *repointed)
	}
}

// While an episode keeps its pinned recovery, a newer version that failed to
// stage is reported to Warn instead of disappearing.
func TestEnsureRecoveryPinnedEpisodeReportsDeferredStage(t *testing.T) {
	i, _, _ := installerFixture(t)
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatal(err)
	}
	j, err := journal.Load(journal.Path(i.DataDir))
	if err != nil {
		t.Fatal(err)
	}
	j.Phase = journal.PhaseCommitted
	if err := journal.Save(journal.Path(i.DataDir), j); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("artifact host unreachable")
	i.Fetch = func(context.Context, string, io.Writer) error { return sentinel }
	var warned []error
	i.Warn = func(_ string, err error) { warned = append(warned, err) }
	if _, err := i.EnsureRecovery(context.Background(), "1.2.4"); err != nil {
		t.Fatal(err)
	}
	if len(warned) != 1 || !errors.Is(warned[0], sentinel) {
		t.Fatalf("deferred stage failure not reported: %v", warned)
	}
}

// An envelope that no longer verifies (truncated, a rotated key, an edit) is
// replaced by a freshly fetched one, so Path B self-heals; a verifying one is
// never touched.
func TestEnsureRecoveryReplacesUnverifiableEnvelope(t *testing.T) {
	for _, stale := range []*ManifestEnvelope{
		{Manifest: "manifest:1.2.3", Signature: "signed-by-an-old-key"},
		{Manifest: "manifest:1.2.2", Signature: "signed-by-trust-root"},
	} {
		i, _, _ := installerFixture(t)
		selfHostUnsigned(i)
		placeEnvelope(t, i, "1.2.3", stale)
		calls := 0
		i.FetchEnvelope = func(_ context.Context, version string) (ManifestEnvelope, error) {
			calls++
			return *signedEnvelope(version), nil
		}
		if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
			t.Fatalf("stale envelope %+v not repaired: %v", stale, err)
		}
		if calls != 1 {
			t.Fatalf("calls=%d", calls)
		}
	}
	// A garbage file is also replaced.
	i, _, _ := installerFixture(t)
	selfHostUnsigned(i)
	placeEnvelope(t, i, "1.2.3", signedEnvelope("1.2.3"))
	if err := os.WriteFile(envelopePath(i, "1.2.3"), []byte("{trunc"), 0o600); err != nil {
		t.Fatal(err)
	}
	i.FetchEnvelope = func(_ context.Context, version string) (ManifestEnvelope, error) {
		return *signedEnvelope(version), nil
	}
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatalf("garbage envelope not repaired: %v", err)
	}
}
