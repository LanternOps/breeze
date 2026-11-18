//go:build darwin

package recoveryinstall

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// Every adapter is injected: nothing here downloads, signs, runs or schedules
// anything for real.

func TestDarwinRecoveryPathIsVersionedAndHasNoExeSuffix(t *testing.T) {
	i, _, _ := installerFixture(t)
	path, err := i.EnsureRecovery(context.Background(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(i.InstallDir, "isolation-recovery", "1.2.3", "breeze-isolation-recovery"); path != want {
		t.Fatalf("path %q, want %q", path, want)
	}
	if DarwinInstallDir != "/Library/Breeze" {
		t.Fatalf("install root %q: recovery must live in the root-only trusted tree, never /usr/local", DarwinInstallDir)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("mode %v err %v", info.Mode(), err)
	}
}

// The pkg and the agent both stage versions. An existing version directory is
// never rewritten: the bytes on disk stay, and are only checked.
func TestDarwinExistingVersionIsNeverOverwritten(t *testing.T) {
	i, downloads, _ := installerFixture(t)
	path := filepath.Join(i.InstallDir, "isolation-recovery", "1.2.3", "breeze-isolation-recovery")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("installed by the pkg"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != "installed by the pkg" || *downloads != 0 {
		t.Fatalf("existing version rewritten (downloads=%d): %q", *downloads, b)
	}
	t.Run("and a bad existing version is refused, not replaced", func(t *testing.T) {
		i.VerifySignature = func(string) error { return errors.New("not signed by us") }
		if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err == nil {
			t.Fatal("adopted an unsigned recovery executable")
		}
		if b, _ := os.ReadFile(path); string(b) != "installed by the pkg" {
			t.Fatalf("rewritten: %q", b)
		}
	})
}

func TestDarwinFailedVerificationLeavesNoArtifactOrRepoint(t *testing.T) {
	for _, stage := range []string{"signature", "schema", "self-test"} {
		t.Run(stage, func(t *testing.T) {
			i, _, repointed := installerFixture(t)
			sentinel := errors.New(stage)
			switch stage {
			case "signature":
				i.VerifySignature = func(string) error { return sentinel }
			case "schema":
				i.SupportedSchema = func(context.Context, string) (int, error) { return journal.SchemaVersion + 1, nil }
			case "self-test":
				i.SelfTest = func(context.Context, string) error { return sentinel }
			}
			if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err == nil {
				t.Fatal("accepted")
			}
			entries, _ := os.ReadDir(filepath.Join(i.InstallDir, "isolation-recovery", "1.2.3"))
			if len(entries) != 0 || len(*repointed) != 0 {
				t.Fatalf("left %v, repointed %v", entries, *repointed)
			}
		})
	}
}

func TestDarwinActiveEpisodePinsTheJournalledRecovery(t *testing.T) {
	i, _, repointed := installerFixture(t)
	old := filepath.Join(i.InstallDir, "isolation-recovery", "1.2.2", "breeze-isolation-recovery")
	if err := os.MkdirAll(filepath.Dir(old), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old, []byte("old"), 0o700); err != nil {
		t.Fatal(err)
	}
	j := journal.New()
	j.Phase = journal.PhaseCommitted
	j.RecoveryPath = old
	if err := journal.Save(journal.Path(i.DataDir), j); err != nil {
		t.Fatal(err)
	}
	i.Fetch = func(_ context.Context, _ string, w io.Writer) error { _, err := io.WriteString(w, "new"); return err }
	got, err := i.EnsureRecovery(context.Background(), "1.2.3")
	if err != nil || got != old || len(*repointed) != 0 {
		t.Fatalf("got %q err %v repointed %v", got, err, *repointed)
	}
}
