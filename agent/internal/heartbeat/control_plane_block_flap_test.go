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
