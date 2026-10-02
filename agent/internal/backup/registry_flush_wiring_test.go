package backup

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// #7367: the run's shadow copy only holds what the configuration manager has
// already written to the hive files, so the loaded registry hives are flushed
// immediately before the run's VSS snapshot is created.

func recordRegistryFlush(t *testing.T, events *[]string) {
	t.Helper()
	orig := flushRegistryBeforeSnapshot
	t.Cleanup(func() { flushRegistryBeforeSnapshot = orig })
	flushRegistryBeforeSnapshot = func() { *events = append(*events, "flush") }
}

func TestRunBackupContext_FlushesRegistryBeforeTheRunsSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name      string
		createErr error
	}{
		{name: "snapshot succeeds"},
		// A failed snapshot still had the flush first; the flush itself
		// never decides whether the run proceeds.
		{name: "snapshot fails", createErr: errors.New("VSS_E_WRITERERROR_TIMEOUT")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srcDir := t.TempDir()
			createTempFile(t, srcDir, "a.txt", "alpha")
			var events []string
			recordRegistryFlush(t, &events)
			provider := &fakeVSSProvider{
				session:   &vss.VSSSession{ID: "s1", ShadowPaths: map[string]string{}},
				createErr: tc.createErr,
				onCreate:  func() { events = append(events, "snapshot") },
			}
			mgr := NewBackupManager(BackupConfig{
				Provider:    newMockProvider(),
				Paths:       []string{srcDir},
				VSSEnabled:  true,
				VSSProvider: provider,
			})
			if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if want := []string{"flush", "snapshot"}; !reflect.DeepEqual(events, want) {
				t.Errorf("events = %v, want %v (registry flushed once, before the snapshot)", events, want)
			}
		})
	}
}

// A run without VSS takes no snapshot, so it has nothing to flush for.
func TestRunBackupContext_NoVSSNoRegistryFlush(t *testing.T) {
	srcDir := t.TempDir()
	createTempFile(t, srcDir, "a.txt", "alpha")
	var events []string
	recordRegistryFlush(t, &events)
	mgr := NewBackupManager(BackupConfig{Provider: newMockProvider(), Paths: []string{srcDir}})
	if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("registry flushed %d times on a run without VSS", len(events))
	}
}
