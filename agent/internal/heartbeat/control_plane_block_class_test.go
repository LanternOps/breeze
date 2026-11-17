package heartbeat

import (
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

// A backward clock step must not stretch the hold by the size of the step.
func TestBlockTracker_HoldsRestartRejectsNegativeAge(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	clock.Advance(-time.Hour)
	if tr.HoldsRestart(cpHost) {
		t.Fatal("episode last seen in the future (clock stepped back) holds the restart")
	}
}
