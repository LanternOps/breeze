package isolation

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/isolation/recoveryinstall"
)

// sourceScheduler is the fake Windows scheduler wired the way production wires
// it: the recovery path comes from the journal, files are real, and the
// recovery executable's own commands are faked.
func sourceScheduler(t *testing.T, exe []byte, schema int) (s *windowsScheduler, tasks map[string][]byte, installDir, dataDir string, runs *[]string) {
	t.Helper()
	s, tasks, _ = newFakeRecoveryScheduler(t)
	root := t.TempDir()
	installDir, dataDir = filepath.Join(root, "Breeze"), filepath.Join(root, "data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	s.dataDir, s.tempDir = dataDir, dataDir
	s.installDir = func() (string, error) { return installDir, nil }
	s.recoveryPath = func() (string, error) {
		j, err := journal.Load(journal.Path(dataDir))
		if err != nil {
			return "", err
		}
		return j.RecoveryPath, nil
	}
	s.exists = func(path string) bool { info, err := os.Stat(path); return err == nil && info.Mode().IsRegular() }
	s.verifySignature = func(string) error { return errors.New("unsigned") }
	calls := []string{}
	runs = &calls
	s.runRecovery = func(ctx context.Context, path string, args ...string) ([]byte, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("recovery command run without a deadline")
		}
		calls = append(calls, filepath.Base(filepath.Dir(path))+" "+strings.Join(args, " "))
		switch strings.Join(args, " ") {
		case "--journal-schema":
			return []byte(strconv.Itoa(schema) + "\r\n"), nil
		case "self-test":
			return nil, nil
		}
		return nil, errors.New("unexpected recovery command")
	}
	ConfigureRecoveryManifestTrust(s, selfHostManifestTrust(true, exe))
	return s, tasks, installDir, dataDir, runs
}

func testSource(exe []byte, fetches *int) RecoverySource {
	return RecoverySource{
		Fetch: func(_ context.Context, version string, w io.Writer) error {
			*fetches++
			if version != trustTestVersion {
				return errors.New("wrong version requested")
			}
			_, err := w.Write(exe)
			return err
		},
		FetchEnvelope: func(context.Context, string) (recoveryinstall.ManifestEnvelope, error) {
			return recoveryinstall.ManifestEnvelope{Manifest: "signed manifest", Signature: "sig", SigningKeyID: "release-artifact-manifest-ed25519"}, nil
		},
	}
}

func TestRecoveryEnsureUnavailableWithoutSource(t *testing.T) {
	s, _, _, _, _ := sourceScheduler(t, []byte("x"), journal.SchemaVersion)
	if _, err := recoveryEnsure(s, trustTestVersion)(context.Background()); !errors.Is(err, recoveryinstall.ErrUnavailable) {
		t.Fatalf("no source configured: want ErrUnavailable, got %v", err)
	}
	// A scheduler that cannot install (Linux, macOS, fakes) keeps the stub.
	if _, err := recoveryEnsure(newFakeScheduler(&callLog{}), trustTestVersion)(context.Background()); !errors.Is(err, recoveryinstall.ErrUnavailable) {
		t.Fatalf("plain scheduler: want ErrUnavailable, got %v", err)
	}
}

// A raw-swap-updated agent with no MSI-placed recovery fetches the executable
// and its signed envelope, installs it side by side, points the poll task at
// it, and the scheduler then reports ready through the same trust path.
func TestRecoveryEnsureInstallsAndArmsPoll(t *testing.T) {
	exe := []byte("unsigned self-host recovery")
	s, tasks, installDir, _, runs := sourceScheduler(t, exe, journal.SchemaVersion)
	fetches := 0
	ConfigureRecoverySource(s, testSource(exe, &fetches))
	if ok, _ := s.Ready(); ok {
		t.Fatal("ready before any install")
	}
	path, err := recoveryEnsure(s, trustTestVersion)(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(installDir, recoveryinstall.RecoveryDirName, trustTestVersion, filepath.Base(path))
	if path != want || fetches != 1 {
		t.Fatalf("path=%q want %q fetches=%d", path, want, fetches)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), recoveryinstall.ManifestEnvelopeName)); err != nil {
		t.Fatalf("envelope not placed: %v", err)
	}
	poll, ok := tasks[recoveryTaskFolder+"IsolationPoll"]
	if !ok {
		t.Fatalf("poll task not registered: %v", keys(tasks))
	}
	command, _, err := parseTaskAction(poll)
	if err != nil || command != path {
		t.Fatalf("poll task command %q (%v), want %q", command, err, path)
	}
	if len(tasks) != 1 {
		t.Fatalf("only the poll task may be armed while idle, got %v", keys(tasks))
	}
	if trust, err := s.recoveryReadiness(); err != nil || trust != recoveryinstall.TrustManifestHash {
		t.Fatalf("readiness after install: %q %v", trust, err)
	}
	if !contains(*runs, trustTestVersion+" --journal-schema") || !contains(*runs, trustTestVersion+" self-test") {
		t.Fatalf("installer did not probe schema and self-test: %v", *runs)
	}
	// Present version: no second download.
	if _, err := recoveryEnsure(s, trustTestVersion)(context.Background()); err != nil || fetches != 1 {
		t.Fatalf("second ensure: fetches=%d err=%v", fetches, err)
	}
}

func TestRecoveryEnsureRefusesIncompatibleSchema(t *testing.T) {
	exe := []byte("unsigned self-host recovery")
	s, tasks, _, dataDir, _ := sourceScheduler(t, exe, journal.SchemaVersion+1)
	fetches := 0
	ConfigureRecoverySource(s, testSource(exe, &fetches))
	if _, err := recoveryEnsure(s, trustTestVersion)(context.Background()); err == nil || !strings.Contains(err.Error(), "schema") {
		t.Fatalf("want an incompatible-schema error, got %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("armed a task for an incompatible recovery: %v", keys(tasks))
	}
	if _, err := journal.Load(journal.Path(dataDir)); !errors.Is(err, journal.ErrNotFound) {
		t.Fatalf("journal written for a refused recovery: %v", err)
	}
}

func TestRecoveryEnsureRefusesHostedUnsigned(t *testing.T) {
	exe := []byte("unsigned recovery")
	s, tasks, _, _, _ := sourceScheduler(t, exe, journal.SchemaVersion)
	ConfigureRecoveryManifestTrust(s, selfHostManifestTrust(false, exe))
	fetches := 0
	ConfigureRecoverySource(s, testSource(exe, &fetches))
	if _, err := recoveryEnsure(s, trustTestVersion)(context.Background()); !errors.Is(err, recoveryinstall.ErrUntrusted) {
		t.Fatalf("hosted unsigned: want ErrUntrusted, got %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("armed a task for an untrusted recovery: %v", keys(tasks))
	}
}

func TestSchedulerRepointRefusesForeignTask(t *testing.T) {
	exe := []byte("unsigned self-host recovery")
	s, _, _, _, _ := sourceScheduler(t, exe, journal.SchemaVersion)
	fetches := 0
	ConfigureRecoverySource(s, testSource(exe, &fetches))
	inst, err := s.recoveryInstaller()
	if err != nil {
		t.Fatal(err)
	}
	if err := inst.Repoint(recoveryinstall.Task{Name: `\Microsoft\Windows\Defrag\ScheduledDefrag`}, "x"); err == nil {
		t.Fatal("repointed a task the scheduler does not own")
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func contains(list []string, want string) bool {
	return slices.Contains(list, want)
}

// The poll task is registered once; healthy re-probes only read it back.
func TestRecoveryEnsureReprobeDoesNotReregister(t *testing.T) {
	exe := []byte("unsigned self-host recovery")
	s, _, _, _, _ := sourceScheduler(t, exe, journal.SchemaVersion)
	fetches := 0
	ConfigureRecoverySource(s, testSource(exe, &fetches))
	creates := 0
	run := s.run
	s.run = func(args ...string) ([]byte, error) {
		if args[0] == "/Create" {
			creates++
		}
		return run(args...)
	}
	ensure := recoveryEnsure(s, trustTestVersion)
	for range 3 {
		if _, err := ensure(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if creates != 1 {
		t.Fatalf("poll task registered %d times across 3 probes, want 1", creates)
	}
}
