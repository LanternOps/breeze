package heartbeat

import (
	"crypto/tls"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
)

const cpHost = "cp.example"

var blockT0 = time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)

type blockClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *blockClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *blockClock) Advance(d time.Duration) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
	return c.t
}

func webFilterStatus(at time.Time) ech.HostStatus {
	return ech.HostStatus{Evidence: ech.BlockEvidence{
		Kind: ech.BlockWebFilter, HTTPStatus: 302, LocationHost: "warn.filter-a.example", SeenAt: at,
	}}
}

func signatureErr() error {
	return fmt.Errorf("Post: %w", tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake", RecordHeader: [5]byte{'H', 'T', 'T', 'P', '/'}})
}

func newTestTracker(t *testing.T) (*blockTracker, *blockClock, string) {
	t.Helper()
	clock := &blockClock{t: blockT0}
	path := filepath.Join(t.TempDir(), "control-plane-block.json")
	return newBlockTracker(path, clock.Now), clock, path
}

func TestBlockTracker_StartsAndUpdatesEpisode(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	if tr.Report() != nil {
		t.Fatal("report before any evidence")
	}
	tr.Observe(cpHost, webFilterStatus(blockT0))
	r := tr.Report()
	want := ControlPlaneBlockReport{
		Kind: "web_filter", Host: cpHost, FirstSeenAt: "2026-10-18T09:00:00Z", LastSeenAt: "2026-10-18T09:00:00Z",
		HTTPStatus: 302, LocationHost: "warn.filter-a.example",
	}
	if r == nil || *r != want {
		t.Fatalf("Report = %+v, want %+v", r, want)
	}
	later := clock.Advance(3 * time.Minute)
	tr.Observe(cpHost, webFilterStatus(later))
	r = tr.Report()
	if r.FirstSeenAt != "2026-10-18T09:00:00Z" || r.LastSeenAt != "2026-10-18T09:03:00Z" {
		t.Fatalf("Report = %+v, want lastSeenAt advanced, firstSeenAt kept", r)
	}
	if cur, ok := tr.Current(cpHost); !ok || cur.Kind != "web_filter" {
		t.Fatalf("Current = %+v, %v", cur, ok)
	}
	if _, ok := tr.Current("other.example"); ok {
		t.Fatal("Current reports an episode for another host")
	}
}

func TestBlockTracker_PlainSuccessClears(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	ok := clock.Advance(time.Minute)
	st := webFilterStatus(blockT0)
	st.LastPlainSuccessAt = ok
	tr.Observe(cpHost, st)
	r := tr.Report()
	if r == nil || r.ClearedBy != "plain_success" || r.ClearedAt != "2026-10-18T09:01:00Z" {
		t.Fatalf("Report = %+v, want cleared plain_success", r)
	}
	if _, active := tr.Current(cpHost); active {
		t.Fatal("Current still active after clear")
	}
	// The stale evidence must not reopen the episode.
	tr.Observe(cpHost, st)
	if r := tr.Report(); r == nil || r.ClearedAt == "" {
		t.Fatalf("Report = %+v, want still the cleared episode", r)
	}
}

func TestBlockTracker_ECHAcceptKeepsEpisodeOpen(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	at := clock.Advance(time.Minute)
	st := webFilterStatus(blockT0)
	st.ECHActive = true
	st.LastECHAcceptedAt = at
	tr.Observe(cpHost, st)
	tr.ObserveReached(cpHost, true)
	if r := tr.Report(); r == nil || r.ClearedAt != "" {
		t.Fatalf("Report = %+v, want the episode still active", r)
	}
}

func TestBlockTracker_ReachedWithoutECHClears(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.ObserveRequestError(cpHost, signatureErr())
	clock.Advance(time.Minute)
	tr.ObserveReached("other.example", false)
	if r := tr.Report(); r == nil || r.ClearedAt != "" {
		t.Fatalf("a 200 from another host cleared the episode: %+v", r)
	}
	tr.ObserveReached(cpHost, false)
	if r := tr.Report(); r == nil || r.ClearedBy != "plain_success" || r.ClearedAt != "2026-10-18T09:01:00Z" {
		t.Fatalf("Report = %+v, want cleared plain_success", r)
	}
}

func TestBlockTracker_UnobservedExpiresAfter24h(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	clock.Advance(23*time.Hour + 59*time.Minute)
	if r := tr.Report(); r == nil || r.ClearedAt != "" {
		t.Fatalf("at 23h59m Report = %+v, want still active", r)
	}
	clock.Advance(2 * time.Minute)
	r := tr.Report()
	if r == nil || r.ClearedBy != "unobserved" || r.ClearedAt != "2026-10-19T09:01:00Z" {
		t.Fatalf("at 24h01m Report = %+v, want cleared unobserved", r)
	}
	// The same old evidence does not restart it.
	tr.Observe(cpHost, webFilterStatus(blockT0))
	if r := tr.Report(); r == nil || r.ClearedBy != "unobserved" {
		t.Fatalf("stale evidence reopened the episode: %+v", r)
	}
}

func TestBlockTracker_OutcomesKeepEpisodeObserved(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	for i := 0; i < 3; i++ {
		at := clock.Advance(20 * time.Hour)
		tr.Observe(cpHost, webFilterStatus(at))
	}
	if r := tr.Report(); r == nil || r.ClearedAt != "" {
		t.Fatalf("Report = %+v, want active while evidence keeps arriving", r)
	}
}

func TestBlockTracker_RestartThenPlainSuccessDeliversOnce(t *testing.T) {
	tr, clock, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))

	tr2 := newBlockTracker(path, clock.Now)
	r := tr2.Report()
	if r == nil || r.Kind != "web_filter" || r.ClearedAt != "" {
		t.Fatalf("after restart Report = %+v, want the active episode", r)
	}
	ok := clock.Advance(10 * time.Minute)
	tr2.Observe(cpHost, ech.HostStatus{LastPlainSuccessAt: ok})
	r = tr2.Report()
	if r == nil || r.ClearedBy != "plain_success" {
		t.Fatalf("Report = %+v, want cleared plain_success", r)
	}
	tr2.MarkDelivered(r)
	if got := tr2.Report(); got != nil {
		t.Fatalf("Report after delivery = %+v, want nil", got)
	}
	if got := newBlockTracker(path, clock.Now).Report(); got != nil {
		t.Fatalf("third tracker Report = %+v, want nil", got)
	}
}

func TestBlockTracker_MarkDeliveredIgnoresOtherEpisode(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	active := tr.Report()
	tr.MarkDelivered(active) // an active report is never "delivered"
	if tr.Report() == nil {
		t.Fatal("delivering an active report dropped it")
	}
	tr.ObserveReached(cpHost, false)
	cleared := tr.Report()
	other := *cleared
	other.FirstSeenAt = "2026-10-17T09:00:00Z"
	tr.MarkDelivered(&other)
	if tr.Report() == nil {
		t.Fatal("delivering another episode dropped the pending one")
	}
	otherHost := *cleared
	otherHost.Host = "other.example"
	tr.MarkDelivered(&otherHost)
	tr.MarkDelivered(nil)
	if tr.Report() == nil {
		t.Fatal("delivering another host's episode dropped the pending one")
	}
	tr.MarkDelivered(cleared)
	if tr.Report() != nil {
		t.Fatal("pending episode survived its own delivery")
	}
	_ = clock
}

func TestBlockTracker_NewEpisodeReplacesUndeliveredCleared(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.ObserveReached(cpHost, false)
	at := clock.Advance(time.Hour)
	tr.Observe(cpHost, webFilterStatus(at))
	r := tr.Report()
	if r == nil || r.ClearedAt != "" || r.FirstSeenAt != "2026-10-18T10:00:00Z" {
		t.Fatalf("Report = %+v, want the new active episode", r)
	}
	tr.ObserveReached(cpHost, false)
	if r := tr.Report(); r == nil || r.FirstSeenAt != "2026-10-18T10:00:00Z" {
		t.Fatalf("pending = %+v, want only the newer episode", r)
	}
}

func TestBlockTracker_RequestErrorNeverDowngrades(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	clock.Advance(time.Minute)
	tr.ObserveRequestError(cpHost, signatureErr())
	r := tr.Report()
	if r.Kind != "web_filter" || r.LocationHost != "warn.filter-a.example" || r.LastSeenAt != "2026-10-18T09:01:00Z" {
		t.Fatalf("Report = %+v, want web_filter kept with lastSeenAt advanced", r)
	}
}

func TestBlockTracker_PlaintextUnknownUpgrades(t *testing.T) {
	tr, clock, _ := newTestTracker(t)
	tr.ObserveRequestError(cpHost, signatureErr())
	if r := tr.Report(); r == nil || r.Kind != "plaintext_unknown" {
		t.Fatalf("Report = %+v, want plaintext_unknown", r)
	}
	at := clock.Advance(time.Minute)
	tr.Observe(cpHost, webFilterStatus(at))
	r := tr.Report()
	if r.Kind != "web_filter" || r.LocationHost != "warn.filter-a.example" || r.FirstSeenAt != "2026-10-18T09:00:00Z" {
		t.Fatalf("Report = %+v, want upgraded to web_filter in the same episode", r)
	}
}

func TestBlockTracker_NonEvidenceErrorIgnored(t *testing.T) {
	tr, _, _ := newTestTracker(t)
	tr.ObserveRequestError(cpHost, fmt.Errorf("dial tcp: i/o timeout"))
	tr.ObserveRequestError(cpHost, nil)
	if r := tr.Report(); r != nil {
		t.Fatalf("Report = %+v, want nil for a timeout", r)
	}
}

func TestBlockTracker_OneActiveHost(t *testing.T) {
	tr, _, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.Observe("backup.example", webFilterStatus(blockT0))
	if r := tr.Report(); r.Host != cpHost {
		t.Fatalf("Report host = %q, want the first host kept", r.Host)
	}
}

func TestBlockTracker_InvalidHostIgnored(t *testing.T) {
	tr, _, _ := newTestTracker(t)
	tr.Observe("", webFilterStatus(blockT0))
	tr.ObserveRequestError("bad host", signatureErr())
	if r := tr.Report(); r != nil {
		t.Fatalf("Report = %+v, want nil for invalid hosts", r)
	}
}

func TestBlockTracker_CorruptFileStartsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control-plane-block.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	tr := newBlockTracker(path, (&blockClock{t: blockT0}).Now)
	if r := tr.Report(); r != nil {
		t.Fatalf("Report = %+v, want nil from a corrupt file", r)
	}
	tr.Observe(cpHost, webFilterStatus(blockT0))
	if newBlockTracker(path, (&blockClock{t: blockT0}).Now).Report() == nil {
		t.Fatal("tracker did not recover from the corrupt file")
	}
}

func TestBlockTracker_LoadDropsInvalidEpisode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "control-plane-block.json")
	body := `{"active":{"kind":"isp_filter","host":"cp.example","firstSeenAt":"2026-10-18T09:00:00Z","lastSeenAt":"2026-10-18T09:00:00Z","lastOutcomeAt":"2026-10-18T09:00:00Z"}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if r := newBlockTracker(path, (&blockClock{t: blockT0}).Now).Report(); r != nil {
		t.Fatalf("Report = %+v, want an unknown kind dropped", r)
	}
}

func TestBlockTracker_FileMode0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes")
	}
	tr, _, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if m := fi.Mode().Perm(); m != 0o600 {
		t.Fatalf("mode = %o, want 0600", m)
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".control-plane-block-*"))
	if len(leftovers) != 0 {
		t.Fatalf("temp files left behind: %v", leftovers)
	}
}

func TestBlockTracker_FileHoldsNoSecrets(t *testing.T) {
	tr, _, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "token") || strings.Contains(string(data), "/warn") {
		t.Fatalf("persisted file leaks a Location path: %s", data)
	}
}

func TestBlockTracker_LastSeenPersistThrottled(t *testing.T) {
	tr, clock, path := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	base := tr.persistCount()
	at := clock.Advance(time.Minute)
	tr.Observe(cpHost, webFilterStatus(at))
	if n := tr.persistCount() - base; n != 0 {
		t.Fatalf("lastSeenAt-only update after 1m wrote %d times, want 0", n)
	}
	at = clock.Advance(5 * time.Minute)
	tr.Observe(cpHost, webFilterStatus(at))
	if n := tr.persistCount() - base; n != 1 {
		t.Fatalf("lastSeenAt-only update after 6m wrote %d times, want 1", n)
	}
	if r := newBlockTracker(path, clock.Now).Report(); r.LastSeenAt != "2026-10-18T09:06:00Z" {
		t.Fatalf("persisted lastSeenAt = %s", r.LastSeenAt)
	}
}

func TestBlockTracker_NilReceiverSafe(t *testing.T) {
	var tr *blockTracker
	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.ObserveRequestError(cpHost, signatureErr())
	tr.ObserveReached(cpHost, false)
	tr.MarkDelivered(&ControlPlaneBlockReport{})
	if tr.Report() != nil {
		t.Fatal("nil tracker reported")
	}
	if _, ok := tr.Current(cpHost); ok {
		t.Fatal("nil tracker has a current episode")
	}
}

func TestBlockTracker_InMemoryWhenPathEmpty(t *testing.T) {
	tr := newBlockTracker("", (&blockClock{t: blockT0}).Now)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	if tr.Report() == nil {
		t.Fatal("in-memory tracker lost the episode")
	}
}

func TestBlockTracker_ObserveAndRequestErrorSameFailureOneEpisode(t *testing.T) {
	tr, _, _ := newTestTracker(t)
	tr.Observe(cpHost, webFilterStatus(blockT0))
	tr.ObserveRequestError(cpHost, signatureErr())
	r := tr.Report()
	if r.Kind != "web_filter" || r.FirstSeenAt != "2026-10-18T09:00:00Z" {
		t.Fatalf("Report = %+v, want one web_filter episode", r)
	}
	tr.ObserveReached(cpHost, false)
	tr.MarkDelivered(tr.Report())
	if tr.Report() != nil {
		t.Fatal("a second episode was hiding behind the first")
	}
}
