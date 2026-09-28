package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/systemstate"
	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// stubCollectSystemStateOpts swaps the collector seam for one that records the
// options RunBackupContext hands it.
func stubCollectSystemStateOpts(t *testing.T, got *[]systemstate.CollectOptions) {
	t.Helper()
	stagingDir := t.TempDir()
	content := []byte("svc")
	if err := os.WriteFile(filepath.Join(stagingDir, "services.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	orig := collectSystemState
	t.Cleanup(func() { collectSystemState = orig })
	collectSystemState = func(opts systemstate.CollectOptions) (*systemstate.SystemStateManifest, string, error) {
		*got = append(*got, opts)
		return &systemstate.SystemStateManifest{
			Platform: "test",
			Artifacts: []systemstate.Artifact{{
				Name: "services", Category: "services", Path: "services.txt",
				SizeBytes: int64(len(content)),
				Checksum:  "348c658682ae8701d3e9d21f191872491cf15e6acbb1681770b1cb787c1cf7ff",
			}},
		}, stagingDir, nil
	}
}

// #5397 follow-up: system state is collected AFTER the run's shadow copy is
// created, and the collector must be handed that session's shadow roots so the
// Windows collector can copy the registry hive files out of the shadow copy
// instead of spawning `reg.exe save` (which Defender blocks for SAM/SECURITY).
func TestRunBackupContext_SystemStateReceivesTheRunsShadowPaths(t *testing.T) {
	srcDir := t.TempDir()
	createTempFile(t, srcDir, "a.txt", "alpha")
	shadowRoot := t.TempDir()
	createTempFile(t, shadowedSourceDir(t, shadowRoot, srcDir), "a.txt", "alpha")

	shadowPaths := map[string]string{filepath.VolumeName(srcDir): shadowRoot}
	vssProvider := &fakeVSSProvider{session: &vss.VSSSession{ID: "s1", ShadowPaths: shadowPaths}}

	var got []systemstate.CollectOptions
	stubCollectSystemStateOpts(t, &got)

	mgr := NewBackupManager(BackupConfig{
		Provider:           newMockProvider(),
		Paths:              []string{srcDir},
		VSSEnabled:         true,
		VSSProvider:        vssProvider,
		SystemStateEnabled: true,
	})
	if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("system state collected %d times, want 1", len(got))
	}
	if !reflect.DeepEqual(got[0].ShadowPaths, shadowPaths) {
		t.Errorf("collector got ShadowPaths %v, want the run's session map %v", got[0].ShadowPaths, shadowPaths)
	}
	if got[0].AcquireBackupPrivilege == nil {
		t.Error("collector got no AcquireBackupPrivilege; the hive copy would run without the ref-counted privilege scope")
	}
}

// Without a VSS session the collector gets no shadow roots, so it keeps the
// reg.exe fallback.
func TestRunBackupContext_SystemStateWithoutVSSGetsNoShadowPaths(t *testing.T) {
	srcDir := t.TempDir()
	createTempFile(t, srcDir, "a.txt", "alpha")

	var got []systemstate.CollectOptions
	stubCollectSystemStateOpts(t, &got)

	mgr := NewBackupManager(BackupConfig{
		Provider:           newMockProvider(),
		Paths:              []string{srcDir},
		SystemStateEnabled: true,
	})
	if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if len(got) != 1 || got[0].ShadowPaths != nil {
		t.Fatalf("collector options = %+v, want one call with nil ShadowPaths", got)
	}
	// No VSS was attempted, so the collector must stay free to take its own
	// shadow copy of the system volume for the hives (review item 1).
	if got[0].SkipSystemVolumeSnapshot {
		t.Error("SkipSystemVolumeSnapshot set although this run never attempted VSS")
	}
}

// When the run's own VSS attempt failed, the collector is told not to try a
// second snapshot: a wedged VSS subsystem would stall the run a second time
// before the reg.exe fallback.
func TestRunBackupContext_SystemStateSkipsOwnSnapshotWhenRunVSSFailed(t *testing.T) {
	srcDir := t.TempDir()
	createTempFile(t, srcDir, "a.txt", "alpha")

	var got []systemstate.CollectOptions
	stubCollectSystemStateOpts(t, &got)

	mgr := NewBackupManager(BackupConfig{
		Provider:           newMockProvider(),
		Paths:              []string{srcDir},
		VSSEnabled:         true,
		VSSProvider:        &fakeVSSProvider{createErr: errors.New("VSS_E_WRITERERROR_TIMEOUT")},
		SystemStateEnabled: true,
	})
	if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if len(got) != 1 || !got[0].SkipSystemVolumeSnapshot {
		t.Fatalf("collector options = %+v, want SkipSystemVolumeSnapshot after the run's VSS attempt failed", got)
	}
}
