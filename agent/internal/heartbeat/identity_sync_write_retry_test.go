package heartbeat

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// #8623 — a failed write of the restart marker (or of agent.yaml) is local and
// usually passes. It used to park the identity as gave_up for the life of the
// process and report that to the server, which then held back assertions for
// an hour. It is now retried after a backoff and never reported; the only
// rule kept from before is that no restart happens without a marker.

// expectIdentityNotRefused checks that nothing about a local write failure
// looks like a refusal of the identity: nothing for the next beat to report,
// nothing given up on, nothing held back.
func expectIdentityNotRefused(t *testing.T, h *Heartbeat) {
	t.Helper()
	if got := h.identityRejectionForBeat(); got != nil {
		t.Fatalf("a local write failure was reported to the server as a refusal: %+v", got)
	}
	if p := h.identitySync.gaveUpOn.Load(); p != nil {
		t.Fatalf("gave up on %q after a local write failure", *p)
	}
	if h.identitySync.restartRequested.Load() {
		t.Fatal("the restart gate stayed closed after a failed write")
	}
	if reason := h.beatSkipReason(); reason != "" {
		t.Fatalf("beats held back after a failed write: %q", reason)
	}
}

func TestTransientRestartMarkerWriteFailureIsRetriedWithoutTheHold(t *testing.T) {
	s := withIdentitySeams(t, nil)
	t.Setenv("BREEZE_ORG_ID", "")
	t.Setenv("BREEZE_SITE_ID", "")
	// A directory where the marker goes: the temp file is written but the
	// rename onto the marker fails, as it does on Windows while an antivirus
	// scan holds the marker open.
	if err := os.Mkdir(s.markerPath, 0o700); err != nil {
		t.Fatal(err)
	}
	h := identityTestHeartbeat()

	if h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("reported a pending restart although the restart marker could not be recorded")
	}
	expectNoRestart(t, s, 50*time.Millisecond)
	expectIdentityNotRefused(t, h)
	// The writer stays atomic: the failed rename left no temp file behind.
	leftovers, err := filepath.Glob(filepath.Join(filepath.Dir(s.markerPath), identityRestartMarkerFile+".*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(leftovers) != 0 {
		t.Fatalf("a failed marker write left temp files: %v", leftovers)
	}

	// A beat inside the backoff does not try again.
	s.now = s.now.Add(identityWriteRetryMin - time.Second)
	if h.applyIdentityAssertion(goldenAssertion()) || s.persisted.Load() != 1 {
		t.Fatalf("tried again inside the backoff: persisted=%d", s.persisted.Load())
	}
	expectIdentityNotRefused(t, h)

	// The scan is over. The first beat after the backoff (about one beat, not
	// an hour) records the marker and restarts.
	if err := os.Remove(s.markerPath); err != nil {
		t.Fatal(err)
	}
	s.now = s.now.Add(time.Second)
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("the retry after the backoff did not schedule the restart")
	}
	waitForRestart(t, s)
	m, ok := readIdentityRestartMarker(s.markerPath)
	// A write that failed is not a restart attempt.
	if !ok || !m.isFor(identityTestOrgB, identityTestSiteB, 0) || m.Attempts != 1 {
		t.Fatalf("restart marker = %+v ok=%v, want attempt 1 for org B / site B", m, ok)
	}
	if h.identitySync.writeFailures.Load() != 0 || h.identitySync.writeRetryAt.Load() != nil {
		t.Fatal("the backoff was not reset once the marker was written")
	}
	if got := h.identityRejectionForBeat(); got != nil {
		t.Fatalf("reported a refusal: %+v", got)
	}
}

// A marker that can never be written (a data directory that does not exist or
// stays read-only) never leads to a restart, and is retried less and less
// often, down to once per identityWriteRetryMax.
func TestPersistentRestartMarkerWriteFailureStaysBounded(t *testing.T) {
	s := withIdentitySeams(t, nil)
	s.markerPath = filepath.Join(t.TempDir(), "missing-dir", identityRestartMarkerFile)
	h := identityTestHeartbeat()

	waits := []time.Duration{
		30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute,
		8 * time.Minute, 16 * time.Minute, 30 * time.Minute, 30 * time.Minute, 30 * time.Minute,
	}
	for i, wait := range waits {
		tries := int32(i + 1)
		if h.applyIdentityAssertion(goldenAssertion()) {
			t.Fatalf("try %d: a restart is pending without a marker", tries)
		}
		if got := s.persisted.Load(); got != tries {
			t.Fatalf("try %d: persisted %d times", tries, got)
		}
		retryAt := h.identitySync.writeRetryAt.Load()
		if retryAt == nil {
			t.Fatalf("try %d: no backoff after a failed write", tries)
		}
		if got := retryAt.Sub(s.now); got != wait {
			t.Fatalf("try %d: next try in %v, want %v", tries, got, wait)
		}
		expectIdentityNotRefused(t, h)

		// Beats inside the backoff verify the assertion and stop there.
		s.now = s.now.Add(wait - time.Second)
		if h.applyIdentityAssertion(goldenAssertion()) || s.persisted.Load() != tries {
			t.Fatalf("try %d: wrote again inside the backoff: persisted=%d", tries, s.persisted.Load())
		}
		s.now = s.now.Add(time.Second)
	}
	expectNoRestart(t, s, 50*time.Millisecond)
	if _, ok := readIdentityRestartMarker(s.markerPath); ok {
		t.Fatal("a marker appeared in a directory that does not exist")
	}
}

func TestIdentityWriteRetryDelay(t *testing.T) {
	tests := []struct {
		failures int
		want     time.Duration
	}{
		{1, 30 * time.Second},
		{2, time.Minute},
		{3, 2 * time.Minute},
		{6, 16 * time.Minute},
		{7, identityWriteRetryMax},
		{1 << 20, identityWriteRetryMax},
	}
	for _, tc := range tests {
		if got := identityWriteRetryDelay(tc.failures); got != tc.want {
			t.Errorf("identityWriteRetryDelay(%d) = %v, want %v", tc.failures, got, tc.want)
		}
	}
	// Never longer than the restart cooldown, so a write that recovers is
	// picked up no later than a restart that did not take effect would be.
	if identityWriteRetryMax > identityRestartCooldown {
		t.Fatalf("write backoff cap %v exceeds the restart cooldown %v", identityWriteRetryMax, identityRestartCooldown)
	}
}
