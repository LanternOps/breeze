package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// TestDoUpdateWatchdogFollowsFailoverBaseURLPromotion is the #2478 regression
// guard for the watchdog binary updater. doUpdateWatchdog (and its identically
// wired sibling doUpdateAgent) must resolve the control-plane URL from the live
// provider — the FailoverClient's BaseURL — at download time, NOT from the
// cfg.ServerURL copy captured at startup. Before the fix the updater built
// updater.Config{ServerURL: cfg.ServerURL} and therefore kept downloading from
// the dead primary even after the FailoverClient had retargeted itself to the
// promoted backup via SetBaseURL during a failover window.
//
// doUpdateWatchdog is used (rather than doUpdateAgent) because it derives its
// BinaryPath from os.Executable() — the test binary, in a writable temp dir — so
// the updater's write-preflight passes and the download actually routes over
// HTTP where the two servers below can observe which origin was contacted.
// doUpdateAgent shares the exact same serverURL wiring, so this proves the class.
func TestDoUpdateWatchdogFollowsFailoverBaseURLPromotion(t *testing.T) {
	// deadPrimary stands in for the failed primary captured in cfg at startup.
	// A hit here after promotion is the bug the fix removes.
	deadHit := false
	deadPrimary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadHit = true
		http.Error(w, "dead primary must not be contacted", http.StatusGone)
	}))
	defer deadPrimary.Close()

	// promotedBackup is what the FailoverClient was retargeted to. It returns a
	// well-formed-but-untrusted download info body so the updater proceeds past
	// the request into manifest verification (which fails closed — fine; we only
	// assert which origin received the download request, not update success).
	promotedHit := false
	promotedBackup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/agent-versions/") && strings.Contains(r.URL.Path, "/download") {
			promotedHit = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"url":"` + r.URL.Scheme + `","checksum":"x","manifest":"{}","manifestSignature":"AAAA"}`))
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer promotedBackup.Close()

	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer journal.Close()

	// cfg pins the dead primary — proving doUpdateWatchdog does not read
	// cfg.ServerURL for the download origin.
	cfg := &config.Config{AgentID: "agent-1", ServerURL: deadPrimary.URL}
	tokens := &tokenHolder{}
	tokens.Replace("tok")

	// The FailoverClient starts on the dead primary, then is promoted to the
	// backup — exactly what noteFailoverHeartbeatFailure -> SetBaseURL does.
	fc := watchdog.NewFailoverClient(deadPrimary.URL, "agent-1", "tok", nil)
	fc.SetBaseURL(promotedBackup.URL)

	// Expected to fail (untrusted manifest); we assert routing, not success. The
	// download failure also means restartWatchdogService() is never reached.
	_ = doUpdateWatchdog("2.1.0", fc.BaseURL, cfg, tokens, journal)

	if deadHit {
		t.Fatal("doUpdateWatchdog contacted the dead primary (cfg.ServerURL) after failover promotion (#2478)")
	}
	if !promotedHit {
		t.Fatal("doUpdateWatchdog did not download from the promoted backup (fc.BaseURL)")
	}
}
