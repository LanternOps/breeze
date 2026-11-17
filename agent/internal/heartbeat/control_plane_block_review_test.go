package heartbeat

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/state"
)

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func captureBlockLogs(t *testing.T) *syncBuf {
	t.Helper()
	b := &syncBuf{}
	logging.Init("text", "info", b)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return b
}

func TestBlockTracker_HoldsRestartOnlyWhileFreshPlaintext(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	if tr.HoldsRestart(cpHost) {
		t.Fatal("no episode, yet holds")
	}
	tr.Observe(cpHost, webFilterStatus(blockT0))
	clock.Advance(9 * time.Minute)
	if !tr.HoldsRestart(cpHost) {
		t.Fatal("fresh web_filter episode does not hold")
	}
	if tr.HoldsRestart("other.example") {
		t.Fatal("holds for another host")
	}
	clock.Advance(2 * time.Minute)
	if tr.HoldsRestart(cpHost) {
		t.Fatal("episode last seen 11m ago still holds the watchdog restart")
	}

	cert, clock2, _ := newTestTracker(t)
	cert.Observe(cpHost, ech.HostStatus{Evidence: ech.BlockEvidence{Kind: ech.BlockUntrustedCertificate, SeenAt: blockT0}})
	clock2.Advance(time.Minute)
	if cert.HoldsRestart(cpHost) {
		t.Fatal("untrusted_certificate holds the restart")
	}
}

func TestBlockTracker_OutcomePersistedSoRestartDoesNotExpire(t *testing.T) {
	tr, clock, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	// ECH carries beats for 30 h: outcomes advance, lastSeenAt does not.
	for i := 0; i < 30; i++ {
		at := clock.Advance(time.Hour)
		st := webFilterStatus(blockT0)
		st.ECHActive, st.LastECHAcceptedAt = true, at
		tr.Observe(cpHost, st)
	}
	if r := tr.Report(); r == nil || r.ClearedAt != "" {
		t.Fatalf("Report = %+v, want active while ECH outcomes arrive", r)
	}
	if r := newBlockTracker(path, clock.Now).Report(); r == nil || r.ClearedAt != "" {
		t.Fatalf("after restart Report = %+v, want still active (outcome persisted)", r)
	}
}

func TestBlockTracker_ForgetOtherHosts(t *testing.T) {
	tr, _, _ := newTestTracker(t)
	tr.Observe("old.example", webFilterStatus(blockT0))
	tr.ForgetOtherHosts(cpHost, "")
	r := tr.Report()
	if r == nil || r.Host != "old.example" || r.ClearedBy != "unobserved" {
		t.Fatalf("Report = %+v, want the old host's episode cleared unobserved", r)
	}
	tr.Observe(cpHost, webFilterStatus(blockT0.Add(time.Second)))
	if _, ok := tr.Current(cpHost); !ok {
		t.Fatal("new host's evidence still ignored")
	}
	tr.ForgetOtherHosts(cpHost, "backup.example")
	if _, ok := tr.Current(cpHost); !ok {
		t.Fatal("ForgetOtherHosts cleared a kept host")
	}
}

func TestBlockTracker_LoadWarnsOnDroppedEpisode(t *testing.T) {
	logs := captureBlockLogs(t)
	path := filepath.Join(t.TempDir(), "control-plane-block.json")
	// A pending episode without clearedAt is invalid.
	body := `{"pending":{"kind":"web_filter","host":"cp.example","firstSeenAt":"2026-10-18T09:00:00Z","lastSeenAt":"2026-10-18T09:00:00Z","lastOutcomeAt":"2026-10-18T09:00:00Z"}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = newBlockTracker(path, (&blockClock{t: blockT0}).Now)
	if !strings.Contains(logs.String(), "control-plane block state dropped an invalid episode") {
		t.Fatalf("no WARN for a dropped pending episode; logs:\n%s", logs.String())
	}
}

func TestBlockTracker_ConcurrentUse(t *testing.T) {
	tr, _, _ := newTestTracker(t)
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				at := blockT0.Add(time.Duration(g*50+i) * time.Second)
				tr.Observe(cpHost, webFilterStatus(at))
				tr.ObserveRequestError(cpHost, signatureErr())
				r := tr.Report()
				if i%7 == 0 {
					tr.ObserveReached(cpHost, false)
				}
				tr.MarkDelivered(r)
				_, _ = tr.Current(cpHost)
				_ = tr.HoldsRestart(cpHost)
			}
		}(g)
	}
	wg.Wait()
}

func TestBlockTracker_PersistFailureKeepsInMemory(t *testing.T) {
	logs := captureBlockLogs(t)
	dir := filepath.Join(t.TempDir(), "missing-dir")
	tr := newBlockTracker(filepath.Join(dir, "control-plane-block.json"), (&blockClock{t: blockT0}).Now)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	if r := tr.Report(); r == nil || r.Kind != "web_filter" {
		t.Fatalf("Report = %+v, want the episode kept in memory", r)
	}
	if n := strings.Count(logs.String(), "failed to persist control-plane block state"); n != 1 {
		t.Fatalf("persist WARNs = %d, want 1", n)
	}
}

func TestNoteControlPlaneBlockedLiveness_WarnsOnceWhenUnrecorded(t *testing.T) {
	logs := captureBlockLogs(t)
	h := &Heartbeat{statePath: filepath.Join(t.TempDir(), "missing", "agent.state")}
	for i := 0; i < 3; i++ {
		h.noteControlPlaneBlockedLiveness()
	}
	const msg = "control-plane-blocked liveness marker not recorded"
	if n := strings.Count(logs.String(), msg); n != 1 {
		t.Fatalf("unrecorded WARNs = %d, want 1; logs:\n%s", n, logs.String())
	}
	h.clearControlPlaneBlockedLatch()
	h.noteControlPlaneBlockedLiveness()
	if n := strings.Count(logs.String(), msg); n != 2 {
		t.Fatalf("unrecorded WARNs after a new streak = %d, want 2", n)
	}

	ok := &Heartbeat{statePath: filepath.Join(t.TempDir(), "agent.state")}
	if err := state.Write(ok.statePath, &state.AgentState{}); err != nil {
		t.Fatal(err)
	}
	before := strings.Count(logs.String(), msg)
	ok.noteControlPlaneBlockedLiveness()
	if strings.Count(logs.String(), msg) != before {
		t.Fatal("warned although the state file recorded the marker")
	}
}

// postFailing drives one failed doHeartbeatPost with err and reports whether
// the blocked-liveness marker was written.
func postFailing(t *testing.T, h *Heartbeat, err error) bool {
	t.Helper()
	statePath := filepath.Join(t.TempDir(), "agent.state")
	if werr := state.Write(statePath, &state.AgentState{}); werr != nil {
		t.Fatal(werr)
	}
	h.statePath = statePath
	h.client = &http.Client{Transport: failoverRoundTripper(func(*http.Request) (*http.Response, error) { return nil, err })}
	if _, ok := h.doHeartbeatPost("https://"+cpHost, &HeartbeatPayload{Status: "ok"}); ok {
		t.Fatal("post succeeded")
	}
	s, rerr := state.Read(statePath)
	if rerr != nil {
		t.Fatal(rerr)
	}
	return !s.ControlPlaneBlockedAt.IsZero()
}

func TestDoHeartbeatPost_HoldDecision(t *testing.T) {
	swapSharedECHDialer(t)
	h := newFailoverTestHeartbeat(swapTestConfig(t, "https://"+cpHost, ""), nil)
	timeout := errors.New("dial tcp: i/o timeout")

	// Fresh plaintext episode + an unrelated error (ECH timing out, proxy
	// path): still blocked, hold.
	h.blocks = newBlockTracker("", time.Now)
	h.blocks.Observe(cpHost, webFilterStatus(time.Now().Add(-time.Minute)))
	if !postFailing(t, h, timeout) {
		t.Fatal("fresh web_filter episode + timeout did not hold the restart")
	}

	// Episode last seen long ago (e.g. reloaded from disk): a timeout is not
	// evidence of the filter, no hold.
	h.blocks = newBlockTracker("", time.Now)
	h.blocks.Observe(cpHost, webFilterStatus(time.Now().Add(-time.Hour)))
	if postFailing(t, h, timeout) {
		t.Fatal("stale episode + timeout held the restart")
	}

	// Untrusted certificate never holds.
	h.blocks = newBlockTracker("", time.Now)
	leaf := selfSignedLeaf(t, pkix.Name{Organization: []string{"Example Inspect CA"}})
	certErr := &tls.CertificateVerificationError{UnverifiedCertificates: []*x509.Certificate{leaf}, Err: x509.UnknownAuthorityError{Cert: leaf}}
	if postFailing(t, h, certErr) {
		t.Fatal("untrusted certificate held the restart")
	}
	if _, ok := h.blocks.Current(cpHost); !ok {
		t.Fatal("untrusted certificate did not start an episode")
	}
}
