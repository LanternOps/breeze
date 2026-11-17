package heartbeat

import (
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
)

func countLogLines(logs *syncBuf, level, msg string) int {
	n := 0
	for _, line := range strings.Split(logs.String(), "\n") {
		if strings.Contains(line, "level="+level) && strings.Contains(line, msg) {
			n++
		}
	}
	return n
}

// Evidence that alternates between classes every beat (a load-balanced pair
// of middleboxes, one filtering and one inspecting) must not cost two INFO
// lines and an fsynced state write per beat. Each switch still takes effect
// in memory at once: a certificate observation ends the plaintext hold.
func TestBlockTracker_AlternatingClassesThrottleLogsAndWrites(t *testing.T) {
	logs := captureBlockLogs(t)
	tr, clock, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	base := tr.persistCount()

	// 20 beats 30 s apart (10 minutes), alternating certificate / plaintext.
	for i := 0; i < 20; i++ {
		at := clock.Advance(30 * time.Second)
		if i%2 == 0 {
			tr.Observe(cpHost, certStatus(at))
			if tr.HoldsRestart(cpHost) {
				t.Fatalf("beat %d: certificate evidence left the plaintext restart hold in place", i)
			}
			if r := tr.Report(); r == nil || r.Kind != string(ech.BlockUntrustedCertificate) {
				t.Fatalf("beat %d: Report = %+v, want untrusted_certificate", i, r)
			}
		} else {
			tr.Observe(cpHost, webFilterStatus(at))
			if !tr.HoldsRestart(cpHost) {
				t.Fatalf("beat %d: fresh plaintext evidence does not hold the restart", i)
			}
			if r := tr.Report(); r == nil || r.Kind != string(ech.BlockWebFilter) {
				t.Fatalf("beat %d: Report = %+v, want web_filter", i, r)
			}
		}
	}

	// One immediate write and one INFO per blockLastSeenPersistEvery window
	// (two windows in 10 minutes), not one per beat.
	if writes := tr.persistCount() - base; writes > 3 {
		t.Fatalf("%d state writes for 20 alternating beats, want at most 3", writes)
	}
	if n := countLogLines(logs, "INFO", "control-plane block episode superseded"); n < 1 || n > 2 {
		t.Fatalf("%d superseded INFO lines for 20 alternating beats, want 1-2\n%s", n, logs.String())
	}
	if n := countLogLines(logs, "INFO", "control-plane block episode started"); n > 3 {
		t.Fatalf("%d started INFO lines (incl. the first episode), want at most 3\n%s", n, logs.String())
	}

	// Once the flapping stops, the next throttled write lands the current
	// episode on disk: a restart reloads what answers now.
	at := clock.Advance(blockLastSeenPersistEvery + time.Minute)
	tr.Observe(cpHost, webFilterStatus(at))
	again := newBlockTracker(path, clock.Now)
	r := again.Report()
	if r == nil || r.Kind != string(ech.BlockWebFilter) || r.LastSeenAt != at.UTC().Format(time.RFC3339) {
		t.Fatalf("reloaded Report = %+v, want the current web_filter episode", r)
	}
}

// A quiet switch with no further evidence: the file lags memory until the
// first Report (every beat) after the window, then catches up. A reload
// inside the lag gets the previous, well-formed episode.
func TestBlockTracker_QuietSwitchFlushedByReportWithoutNewEvidence(t *testing.T) {
	tr, clock, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.Observe(cpHost, certStatus(clock.Advance(30*time.Second)))      // loud: written at once
	tr.Observe(cpHost, webFilterStatus(clock.Advance(30*time.Second))) // quiet: deferred
	if !tr.HoldsRestart(cpHost) {
		t.Fatal("quiet switch to plaintext did not take effect in memory")
	}

	lagging := newBlockTracker(path, clock.Now).Report()
	if lagging == nil || lagging.Kind != string(ech.BlockUntrustedCertificate) {
		t.Fatalf("reload inside the lag = %+v, want the previous (certificate) episode", lagging)
	}

	clock.Advance(time.Minute)
	before := tr.persistCount()
	tr.Report() // still inside the window: no write
	if tr.persistCount() != before {
		t.Fatal("Report wrote inside the throttle window")
	}
	clock.Advance(blockLastSeenPersistEvery)
	tr.Report() // first beat after the window: flushes
	if tr.persistCount() != before+1 {
		t.Fatalf("Report did not flush the quiet switch (writes %d -> %d)", before, tr.persistCount())
	}
	if r := newBlockTracker(path, clock.Now).Report(); r == nil || r.Kind != string(ech.BlockWebFilter) {
		t.Fatalf("reload after the flush = %+v, want web_filter", r)
	}
	tr.Report()
	if tr.persistCount() != before+1 {
		t.Fatal("Report kept writing after the flush")
	}
}

// A clock that steps backward after a loud switch makes the next switch loud
// (written at once), never silences switches for the length of the step.
func TestBlockTracker_SupersedeAfterClockStepBackIsLoud(t *testing.T) {
	logs := captureBlockLogs(t)
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.Observe(cpHost, certStatus(clock.Advance(30*time.Second)))      // loud
	tr.Observe(cpHost, webFilterStatus(clock.Advance(30*time.Second))) // quiet
	quiet := countLogLines(logs, "INFO", "control-plane block episode superseded")

	clock.Advance(-10 * time.Minute)
	before := tr.persistCount()
	// Evidence must be newer than the episode's lastSeenAt to apply; the
	// dialer's evidence carries its own (pre-step) time.
	tr.Observe(cpHost, certStatus(blockT0.Add(2*time.Minute)))
	if tr.persistCount() != before+1 {
		t.Fatal("switch after a backward clock step was not written at once")
	}
	if n := countLogLines(logs, "INFO", "control-plane block episode superseded"); n != quiet+1 {
		t.Fatalf("switch after a backward clock step logged %d INFO lines, want %d", n, quiet+1)
	}
	if !strings.Contains(logs.String(), "quiet_switches_since_last=1") {
		t.Fatalf("loud switch did not report the quiet switch count\n%s", logs.String())
	}
}

// The quiet window is [loud, loud + blockLastSeenPersistEvery).
func TestBlockTracker_QuietWindowBoundary(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	loudAt := clock.Advance(time.Second)
	tr.Observe(cpHost, certStatus(loudAt)) // loud
	before := tr.persistCount()
	tr.Observe(cpHost, webFilterStatus(clock.Advance(blockLastSeenPersistEvery-time.Nanosecond))) // quiet
	if tr.persistCount() != before {
		t.Fatal("switch one nanosecond inside the window was written at once")
	}
	tr.Observe(cpHost, certStatus(clock.Advance(time.Nanosecond))) // exactly loudAt+window: loud
	if tr.persistCount() != before+1 {
		t.Fatal("switch exactly one window after the loud one was not written at once")
	}
}

// Wiring: a certificate failure that follows a filter failure must not
// refresh the watchdog's blocked-liveness marker, also on the throttled
// (quiet) supersede path of an alternating stream.
func TestDoHeartbeatPost_CertificateAfterFilterDoesNotRefreshMarker(t *testing.T) {
	swapSharedECHDialer(t)
	h := newFailoverTestHeartbeat(swapTestConfig(t, "https://"+cpHost, ""), nil)
	clock := &blockClock{t: time.Now()}
	h.blocks = newBlockTracker("", clock.Now)
	leaf := selfSignedLeaf(t, pkix.Name{Organization: []string{"Example Inspect CA"}})
	certErr := &tls.CertificateVerificationError{UnverifiedCertificates: []*x509.Certificate{leaf}, Err: x509.UnknownAuthorityError{Cert: leaf}}

	for i := 0; i < 6; i++ {
		// The dialer's capture of the filter's reply (what doHeartbeatPost
		// folds in first via ech.Shared().Status): a web_filter episode, not
		// the plaintext_unknown the bare request error alone would give.
		h.blocks.Observe(cpHost, webFilterStatus(clock.Advance(30*time.Second)))
		clock.Advance(time.Second)
		if r, _ := h.blocks.Current(cpHost); r.Kind != string(ech.BlockWebFilter) {
			t.Fatalf("round %d: Current = %+v, want web_filter", i, r)
		}
		if !postFailing(t, h, signatureErr()) {
			t.Fatalf("round %d: filter failure did not write the blocked-liveness marker", i)
		}
		clock.Advance(30 * time.Second)
		if postFailing(t, h, certErr) {
			t.Fatalf("round %d: certificate failure after a filter failure refreshed the blocked-liveness marker", i)
		}
		if r, ok := h.blocks.Current(cpHost); !ok || r.Kind != string(ech.BlockUntrustedCertificate) {
			t.Fatalf("round %d: Current = %+v %v, want the certificate episode", i, r, ok)
		}
	}
}
