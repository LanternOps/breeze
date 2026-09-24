//go:build windows

package hwhealth

import (
	"context"
	"os"
	"testing"
)

// Opt-in smoke test that runs the real PowerShell Storage cmdlets on the host
// (fixture tests cover parsing only). Set BREEZE_HWHEALTH_LIVE=1 to run it on a
// Windows lab box; CI leaves it skipped so it never depends on host hardware.
func TestLiveWindowsSources(t *testing.T) {
	if os.Getenv("BREEZE_HWHEALTH_LIVE") != "1" {
		t.Skip("set BREEZE_HWHEALTH_LIVE=1 to run against this host's disks")
	}
	ctx := context.Background()

	pd := newWinPD()
	r, e := pd.Collect(ctx, pd.Detect(ctx))
	if e != nil {
		t.Fatalf("windows_physical_disk collect: %v", e)
	}
	if len(r.Components) == 0 {
		t.Fatal("windows_physical_disk reported no disks on a host that has at least one")
	}
	for _, c := range r.Components {
		if c.ComponentType != "physical_disk" || c.OSHealthStatus == nil {
			t.Fatalf("unexpected component %+v", c)
		}
		t.Logf("disk %s state=%s os=%s model=%v", c.ComponentKey, c.State, *c.OSHealthStatus, deref(c.Model))
	}
	t.Logf("windows_physical_disk complete=%v warnings=%v", r.Complete, r.Warnings)

	ss := newStorageSpaces(map[string]string{})
	a := ss.Detect(ctx)
	t.Logf("storage_spaces available=%v", a.Available)
	// Collect runs even when detection says unavailable: a host without any
	// pool (the common case) must yield an empty, complete result, never an
	// error — Get-StoragePool throws ObjectNotFound there under Stop.
	r, e = ss.Collect(ctx, a)
	if e != nil {
		t.Fatalf("storage_spaces collect: %v", e)
	}
	if !a.Available && (len(r.Components) != 0 || !r.Complete) {
		t.Fatalf("no-pool host must collect empty+complete: %+v", r)
	}
	t.Logf("storage_spaces components=%d complete=%v warnings=%v", len(r.Components), r.Complete, r.Warnings)

	// The real platform source set end to end: a healthy host must not report
	// any source as failed (a false "collector failing" alert fleet-wide).
	snap, e := New(Options{DataDir: t.TempDir()}).Run(ctx, []Tier{TierRAID, TierDisk})
	if e != nil || snap == nil {
		t.Fatalf("collector run: snap=%v err=%v", snap, e)
	}
	for _, s := range snap.Sources {
		t.Logf("source %s status=%s error=%q", s.Source, s.Status, s.Error)
		if s.Status == "failed" || s.Status == "backing_off" {
			t.Fatalf("source %s %s on a healthy host: %+v", s.Source, s.Status, s)
		}
	}
	t.Logf("snapshot tiers=%v components=%d", snap.TiersRun, len(snap.Components))
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
