package recoveryinstall

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

func installerFixture(t *testing.T) (*Installer, *int, *[]string) {
	t.Helper()
	dir := t.TempDir()
	downloads := 0
	repointed := []string{}
	i := &Installer{InstallDir: filepath.Join(dir, "install"), DataDir: filepath.Join(dir, "data"),
		Fetch: func(ctx context.Context, version string, w io.Writer) error {
			downloads++
			_, err := io.WriteString(w, "signed recovery")
			return err
		},
		VerifySignature: func(string) error { return nil },
		SupportedSchema: func(context.Context, string) (int, error) { return journal.SchemaVersion, nil },
		SelfTest: func(ctx context.Context, path string) error {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 10*time.Second {
				t.Fatal("missing bounded self-test")
			}
			return nil
		},
		Tasks: func() ([]Task, error) { return []Task{{Name: "poll"}, {Name: "expiry"}}, nil },
		Repoint: func(task Task, path string) error {
			if _, err := os.Stat(path); err != nil {
				t.Fatalf("task points to absent file: %v", err)
			}
			repointed = append(repointed, path)
			return nil
		},
	}
	if err := os.MkdirAll(i.DataDir, 0700); err != nil {
		t.Fatal(err)
	}
	return i, &downloads, &repointed
}

func TestEnsureRecoveryRawSwapAndExistingVersion(t *testing.T) {
	i, downloads, repointed := installerFixture(t)
	path, err := i.EnsureRecovery(context.Background(), "1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(i.InstallDir, "isolation-recovery", "1.2.3", recoveryExecutableName())
	if path != want || *downloads != 1 || len(*repointed) != 2 {
		t.Fatalf("path=%q downloads=%d repoints=%v", path, *downloads, *repointed)
	}
	j, err := journal.Load(journal.Path(i.DataDir))
	if err != nil || j.RecoveryPath != path {
		t.Fatalf("journal=%+v err=%v", j, err)
	}
	if _, err = i.EnsureRecovery(context.Background(), "1.2.3"); err != nil {
		t.Fatal(err)
	}
	if *downloads != 1 {
		t.Fatal("existing version downloaded again")
	}
}

func TestEnsureRecoveryVerificationFailureChangesNothing(t *testing.T) {
	for _, stage := range []string{"fetch", "signature", "self-test"} {
		t.Run(stage, func(t *testing.T) {
			i, _, repointed := installerFixture(t)
			sentinel := errors.New(stage)
			switch stage {
			case "fetch":
				i.Fetch = func(context.Context, string, io.Writer) error { return sentinel }
			case "signature":
				i.VerifySignature = func(string) error { return sentinel }
			case "self-test":
				i.SelfTest = func(context.Context, string) error { return sentinel }
			}
			if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); !errors.Is(err, sentinel) {
				t.Fatalf("error=%v", err)
			}
			if len(*repointed) != 0 {
				t.Fatal("repointed despite failure")
			}
			if _, err := os.Stat(journal.Path(i.DataDir)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("journal changed")
			}
			files, err := os.ReadDir(filepath.Join(i.InstallDir, "isolation-recovery", "1.2.3"))
			if err != nil {
				t.Fatal(err)
			}
			if len(files) != 0 {
				t.Fatalf("failed artifact retained: %v", files)
			}
		})
	}
}

func TestEnsureRecoveryPinsUnresolvedEpisode(t *testing.T) {
	for _, phase := range []journal.Phase{journal.PhaseProvisional, journal.PhaseCommitted, journal.PhaseReleasing, journal.PhaseReleased} {
		t.Run(string(phase), func(t *testing.T) {
			i, _, repointed := installerFixture(t)
			old := filepath.Join(i.InstallDir, "old.exe")
			if err := os.MkdirAll(i.InstallDir, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(old, []byte("old"), 0700); err != nil {
				t.Fatal(err)
			}
			j := journal.New()
			j.Phase = phase
			j.RecoveryPath = old
			j.Episode = &journal.EpisodeRecord{State: "released_locally"}
			if err := journal.Save(journal.Path(i.DataDir), j); err != nil {
				t.Fatal(err)
			}
			got, err := i.EnsureRecovery(context.Background(), "1.2.3")
			if err != nil {
				t.Fatal(err)
			}
			if got != old || len(*repointed) != 0 {
				t.Fatalf("active task changed: %q %v", got, *repointed)
			}
			j, err = journal.Load(journal.Path(i.DataDir))
			if err != nil || j.RecoveryPath != old {
				t.Fatalf("pin lost: %+v %v", j, err)
			}
		})
	}
}

func TestEnsureRecoveryRejectsUnsafeVersions(t *testing.T) {
	for _, v := range []string{"", "..", "../1.2.3", "1.2.3/child", `1.2.3\child`, "1.2.3..4", "1.2.3 ", "dev", "1.2", "1.2.3:stream"} {
		t.Run(v, func(t *testing.T) {
			i, n, _ := installerFixture(t)
			if _, err := i.EnsureRecovery(context.Background(), v); err == nil {
				t.Fatal("unsafe version accepted")
			}
			if *n != 0 {
				t.Fatal("downloaded unsafe version")
			}
		})
	}
}

func TestEnsureRecoveryRefusesConcurrentDifferentTarget(t *testing.T) {
	i, _, repointed := installerFixture(t)
	target := filepath.Join(i.InstallDir, "isolation-recovery", "1.2.3", recoveryExecutableName())
	i.SelfTest = func(context.Context, string) error { return os.WriteFile(target, []byte("other binary"), 0700) }
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err == nil {
		t.Fatal("overwrote racing target")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "other binary" {
		t.Fatalf("target=%s err=%v", data, err)
	}
	if len(*repointed) != 0 {
		t.Fatal("adopted collision")
	}
}

func TestProductionEnsureRecoveryHasNoSource(t *testing.T) {
	if _, err := EnsureRecovery(context.Background(), "1.2.3"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("production unexpectedly available: %v", err)
	}
}

func TestEnsureRecoverySelfTestDeadlineCannotBeIgnored(t *testing.T) {
	i, _, repointed := installerFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	i.SelfTest = func(context.Context, string) error { cancel(); return nil }
	if _, err := i.EnsureRecovery(ctx, "1.2.3"); !errors.Is(err, context.Canceled) {
		t.Fatalf("ignored cancellation: %v", err)
	}
	if len(*repointed) != 0 {
		t.Fatal("adopted cancelled self-test")
	}
}

func TestEnsureRecoveryTaskFailurePreservesJournalAndExistingTargets(t *testing.T) {
	i, _, _ := installerFixture(t)
	old := filepath.Join(i.InstallDir, "old.exe")
	if err := os.MkdirAll(i.InstallDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(old, []byte("old"), 0700); err != nil {
		t.Fatal(err)
	}
	j := journal.New()
	j.RecoveryPath = old
	if err := journal.Save(journal.Path(i.DataDir), j); err != nil {
		t.Fatal(err)
	}
	tasks := map[string]string{"poll": old, "expiry": old}
	i.Tasks = func() ([]Task, error) { return []Task{{Name: "poll", Path: old}, {Name: "expiry", Path: old}}, nil }
	i.Repoint = func(task Task, path string) error {
		if task.Name == "expiry" {
			return errors.New("failed registration")
		}
		tasks[task.Name] = path
		return nil
	}
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err == nil {
		t.Fatal("task failure swallowed")
	}
	for name, path := range tasks {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s points to nonexistent file: %v", name, err)
		}
	}
	got, err := journal.Load(journal.Path(i.DataDir))
	if err != nil || got.RecoveryPath != old {
		t.Fatalf("journal changed: %+v %v", got, err)
	}
}

func TestEnsureRecoveryRejectsUnknownSchemaWithoutRepoint(t *testing.T) {
	i, _, repointed := installerFixture(t)
	if err := os.WriteFile(journal.Path(i.DataDir), []byte(`{"schemaVersion":999,"phase":"committed","nextSeq":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); !errors.Is(err, journal.ErrUnknownSchema) {
		t.Fatalf("schema error=%v", err)
	}
	if len(*repointed) != 0 {
		t.Fatal("unknown schema task changed")
	}
}

func TestEnsureRecoveryRejectsIncompatibleSchemaBeforeAdoption(t *testing.T) {
	for _, which := range []string{"staged", "pinned", "query-failed"} {
		t.Run(which, func(t *testing.T) {
			i, _, repointed := installerFixture(t)
			if which == "pinned" {
				old := filepath.Join(i.InstallDir, "old.exe")
				if err := os.MkdirAll(i.InstallDir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(old, []byte("old"), 0700); err != nil {
					t.Fatal(err)
				}
				j := journal.New()
				j.Phase = journal.PhaseCommitted
				j.RecoveryPath = old
				if err := journal.Save(journal.Path(i.DataDir), j); err != nil {
					t.Fatal(err)
				}
			}
			i.SupportedSchema = func(_ context.Context, path string) (int, error) {
				if which == "query-failed" {
					return 0, errors.New("query failed")
				}
				if which == "staged" || filepath.Base(path) == "old.exe" {
					return journal.SchemaVersion + 1, nil
				}
				return journal.SchemaVersion, nil
			}
			if _, err := i.EnsureRecovery(context.Background(), "1.2.3"); err == nil {
				t.Fatal("incompatible recovery adopted")
			}
			if len(*repointed) != 0 {
				t.Fatal("incompatible task repointed")
			}
		})
	}
}
