package heartbeat

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
)

func certStatus(at time.Time) ech.HostStatus {
	return ech.HostStatus{Evidence: ech.BlockEvidence{
		Kind: ech.BlockUntrustedCertificate, CertIssuer: "Example Inspect CA", SeenAt: at,
	}}
}

// A plaintext episode must not be kept fresh by untrusted-certificate
// evidence: once a TLS-inspecting middlebox answers instead of the filter,
// the report names the certificate and the watchdog hold ends.
func TestBlockTracker_CertificateEvidenceDoesNotExtendPlaintextEpisode(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	if !tr.HoldsRestart(cpHost) {
		t.Fatal("fresh web_filter episode does not hold")
	}
	for i := 0; i < 6; i++ {
		at := clock.Advance(9 * time.Minute)
		tr.Observe(cpHost, certStatus(at))
		if at.Sub(blockT0) > blockHoldFreshness && tr.HoldsRestart(cpHost) {
			t.Fatalf("observation %d: certificate evidence keeps the plaintext hold alive", i+1)
		}
	}
	if tr.HoldsRestart(cpHost) {
		t.Fatal("certificate evidence holds the watchdog restart")
	}
	r := tr.Report()
	if r == nil || r.Kind == string(ech.BlockWebFilter) {
		t.Fatalf("Report = %+v, want the certificate, not the old web_filter", r)
	}
	if r.Kind != string(ech.BlockUntrustedCertificate) || r.CertIssuer != "Example Inspect CA" ||
		r.LocationHost != "" || r.HTTPStatus != 0 || r.ClearedAt != "" {
		t.Fatalf("Report = %+v, want an active untrusted_certificate episode with only its own details", r)
	}
	if r.FirstSeenAt != "2026-10-18T09:09:00Z" || r.LastSeenAt != "2026-10-18T09:54:00Z" {
		t.Fatalf("Report = %+v, want a new episode from the first certificate observation", r)
	}
}

// The reverse: a filter that replaces TLS inspection reports its plaintext
// kind and holds the restart.
func TestBlockTracker_PlaintextEvidenceSupersedesCertificateEpisode(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, certStatus(blockT0))
	if tr.HoldsRestart(cpHost) {
		t.Fatal("untrusted_certificate holds the restart")
	}
	at := clock.Advance(time.Minute)
	tr.Observe(cpHost, webFilterStatus(at))
	r := tr.Report()
	if r == nil || r.Kind != string(ech.BlockWebFilter) || r.LocationHost != "warn.filter-a.example" ||
		r.CertIssuer != "" || r.FirstSeenAt != "2026-10-18T09:01:00Z" {
		t.Fatalf("Report = %+v, want a new web_filter episode", r)
	}
	if !tr.HoldsRestart(cpHost) {
		t.Fatal("plaintext evidence after a certificate episode does not hold")
	}
}

// The HTTPS-proxy path classifies without the dialer; a signature there also
// supersedes a certificate episode.
func TestBlockTracker_RequestErrorSignatureSupersedesCertificateEpisode(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, certStatus(blockT0))
	clock.Advance(time.Minute)
	tr.ObserveRequestError(cpHost, signatureErr())
	if r := tr.Report(); r == nil || r.Kind != string(ech.BlockPlaintextUnknown) || r.CertIssuer != "" {
		t.Fatalf("Report = %+v, want plaintext_unknown", r)
	}
	if !tr.HoldsRestart(cpHost) {
		t.Fatal("plaintext signature after a certificate episode does not hold")
	}
}

// Kinds within the plaintext class still share one episode.
func TestBlockTracker_SameClassKeepsEpisode(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	at := clock.Advance(time.Minute)
	tr.Observe(cpHost, ech.HostStatus{Evidence: ech.BlockEvidence{Kind: ech.BlockCaptivePortal, SeenAt: at}})
	r := tr.Report()
	if r.FirstSeenAt != "2026-10-18T09:00:00Z" || r.LastSeenAt != "2026-10-18T09:01:00Z" {
		t.Fatalf("Report = %+v, want one plaintext episode extended", r)
	}
}

// The superseding episode is what a restart reloads; the old one is gone.
func TestBlockTracker_SupersededEpisodeSurvivesReload(t *testing.T) {
	tr, clock, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.Observe(cpHost, certStatus(clock.Advance(time.Minute)))

	again := newBlockTracker(path, clock.Now)
	r := again.Report()
	if r == nil || r.Kind != string(ech.BlockUntrustedCertificate) || r.CertIssuer != "Example Inspect CA" ||
		r.FirstSeenAt != "2026-10-18T09:01:00Z" || r.LocationHost != "" {
		t.Fatalf("reloaded Report = %+v, want the certificate episode only", r)
	}
	if again.HoldsRestart(cpHost) {
		t.Fatal("reloaded certificate episode holds the restart")
	}
}

// A plain success after a supersede clears the second episode; the first is
// not resurrected by its own older evidence.
func TestBlockTracker_SupersededThenPlainSuccess(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, certStatus(blockT0))
	tr.Observe(cpHost, webFilterStatus(clock.Advance(time.Minute)))
	ok := clock.Advance(time.Minute)
	tr.Observe(cpHost, ech.HostStatus{Evidence: certStatus(blockT0).Evidence, LastPlainSuccessAt: ok})
	r := tr.Report()
	if r == nil || r.Kind != string(ech.BlockWebFilter) || r.ClearedBy != blockClearedByPlainSuccess ||
		r.FirstSeenAt != "2026-10-18T09:01:00Z" {
		t.Fatalf("Report = %+v, want the web_filter episode cleared by plain success", r)
	}
	tr.Observe(cpHost, certStatus(blockT0))
	if r := tr.Report(); r == nil || r.ClearedAt == "" {
		t.Fatalf("Report = %+v, old certificate evidence reopened an episode", r)
	}
}

// A directory fsync failure after a successful rename is not a persist
// failure: the file is in place and one distinct WARN is logged.
func TestBlockTracker_DirSyncFailureIsBestEffort(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a POSIX directory that can be written but not opened")
	}
	logs := captureBlockLogs(t)
	dir := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "control-plane-block.json")
	clock := &blockClock{t: blockT0}
	tr := newBlockTracker(path, clock.Now)
	// Write and search, no read: create and rename work, opening the
	// directory for fsync does not.
	if err := os.Chmod(dir, 0o300); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.Observe(cpHost, certStatus(clock.Advance(time.Minute)))
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("state file not written: %v", err)
	}
	out := logs.String()
	if strings.Contains(out, "failed to persist control-plane block state") {
		t.Fatal("directory fsync failure reported as a persist failure")
	}
	if n := strings.Count(out, "state directory fsync failed"); n != 1 {
		t.Fatalf("directory fsync WARNs = %d, want 1", n)
	}
}

// A backward clock step must not stretch the hold by the size of the step.
func TestBlockTracker_HoldsRestartRejectsNegativeAge(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	clock.Advance(-time.Hour)
	if tr.HoldsRestart(cpHost) {
		t.Fatal("episode last seen in the future (clock stepped back) holds the restart")
	}
}
