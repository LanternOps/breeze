//go:build windows

package isolation

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/serviceinstall"
)

// The production scheduler carries the installer adapters; without them the
// activated agent would keep the fail-closed stub and never become ready.
func TestPlatformSchedulerHasInstallerAdapters(t *testing.T) {
	s := NewPlatformScheduler(t.TempDir()).(*windowsScheduler)
	if s.installDir == nil || s.runRecovery == nil {
		t.Fatal("production Windows scheduler is missing installDir or runRecovery")
	}
	dir, err := s.installDir()
	if err != nil {
		t.Fatal(err)
	}
	agent, err := serviceinstall.ProtectedBinaryPath("breeze-agent.exe")
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Dir(agent) {
		t.Fatalf("recovery install dir %q, want the protected agent directory %q", dir, filepath.Dir(agent))
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if _, err := s.runRecovery(ctx, filepath.Join(t.TempDir(), "absent.exe"), "self-test"); err == nil {
		t.Fatal("recovery command ran past an expired deadline")
	}
}

// The activated isolator's readiness probe installs through the scheduler's
// production installer, not the ErrUnavailable stub.
func TestWindowsReadinessUsesSchedulerInstaller(t *testing.T) {
	exe := []byte("unsigned self-host recovery")
	s, tasks, _, _, _ := sourceScheduler(t, exe, journal.SchemaVersion)
	fetches := 0
	ConfigureRecoverySource(s, testSource(exe, &fetches))
	i := newWindowsIsolator(nil).(*windowsIsolator)
	i.open = func() (windowsWFPSession, error) { return &fakeWindowsSession{}, nil }
	i.configureRecoveryReadiness(s, trustTestVersion)
	i.RefreshReadiness(context.Background())
	if fetches != 1 {
		t.Fatalf("readiness probe did not install through the scheduler (fetches=%d)", fetches)
	}
	if _, ok := tasks[pollTaskName]; !ok {
		t.Fatal("poll task not registered by the readiness probe")
	}
	if got := i.Capability(); got.Version != 1 || !got.Ready {
		t.Fatalf("capability after a successful install %+v", got)
	}
}
