package bitlockerguard

import (
	"context"
	"errors"
	"testing"
)

// TestReadOnlyDepsCarriesNoWriteSeam: oem_observe reads the guard's preflight
// with these deps. Nothing that suspends, resumes or records can be reached
// through them, so Suspend, Resume and ResumeOnStart refuse them outright.
func TestReadOnlyDepsCarriesNoWriteSeam(t *testing.T) {
	d := ReadOnlyDeps()
	if d.SuspendVolume != nil || d.ResumeVolume != nil || d.Store != nil {
		t.Fatal("ReadOnlyDeps must not carry SuspendVolume, ResumeVolume or Store")
	}
	if d.BootTime != nil || d.RebootPending != nil {
		t.Fatal("ReadOnlyDeps carries only the two readers")
	}
	if d.State == nil || d.Protectors == nil {
		t.Fatal("ReadOnlyDeps must carry State and Protectors for Preflight")
	}
	ctx := context.Background()
	if _, err := Suspend(ctx, MinRebootCount, d); !errors.Is(err, errSeamsMissing) {
		t.Fatalf("Suspend with read-only deps = %v, want errSeamsMissing", err)
	}
	if _, err := ResumeOnStart(ctx, d); !errors.Is(err, errSeamsMissing) {
		t.Fatalf("ResumeOnStart with read-only deps = %v, want errSeamsMissing", err)
	}
}
