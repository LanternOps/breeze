package heartbeat

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/atomicrename"
	"github.com/breeze-rmm/agent/internal/ech"
)

// Control-plane block episodes (#8868).
//
// The ECH dialer records per-host evidence of what answered a failed
// control-plane handshake (a filter's plaintext reply, an untrusted
// certificate). The tracker turns that into an *episode* — one blocked host,
// first/last seen, how it cleared — persists it so a restart does not lose
// it, and hands it to every heartbeat until the server has it:
//
//   - An active episode is sent on every beat.
//   - A cleared episode is sent until a beat carrying it gets a 200
//     (MarkDelivered), then dropped. A new episode replaces an undelivered
//     cleared one.
//   - At most one active episode exists; evidence for another host is
//     ignored while one is active (the primary is observed first).
//   - Evidence of the other class (plaintext signature vs untrusted
//     certificate) ends the active episode and starts a new one.
//
// Single writer: only the main agent's Heartbeat owns the file. Watchdog,
// helper, backup and one-shot processes never construct a Heartbeat.

const (
	controlPlaneBlockFile = "control-plane-block.json"
	// blockUnobservedExpiry clears an episode when no dial outcome for its
	// host (evidence, plain success, ECH accept) has been seen for this long.
	blockUnobservedExpiry = 24 * time.Hour
	// blockLastSeenPersistEvery throttles writes that only move lastSeenAt.
	blockLastSeenPersistEvery = 5 * time.Minute

	// blockHoldFreshness bounds how old an episode's last evidence may be for
	// it to hold watchdog restarts on a failure that is not itself a filter
	// signature (an ECH timeout, the proxy path). Same window as the
	// control_plane health component's filter row.
	blockHoldFreshness = 10 * time.Minute

	blockClearedByPlainSuccess = "plain_success"
	blockClearedByUnobserved   = "unobserved"
)

// ControlPlaneBlockReport is the heartbeat's controlPlaneBlock object. Times
// are RFC 3339 UTC. Host and LocationHost are sanitized hostnames only; no
// Location path, query, fragment or userinfo is ever carried.
type ControlPlaneBlockReport struct {
	Kind         string `json:"kind"`
	Host         string `json:"host"`
	FirstSeenAt  string `json:"firstSeenAt"`
	LastSeenAt   string `json:"lastSeenAt"`
	ClearedAt    string `json:"clearedAt,omitempty"`
	ClearedBy    string `json:"clearedBy,omitempty"`
	HTTPStatus   int    `json:"httpStatus,omitempty"`
	LocationHost string `json:"locationHost,omitempty"`
	CertIssuer   string `json:"certIssuer,omitempty"`
}

// blockEpisode is the tracker's (and the file's) form of an episode.
type blockEpisode struct {
	Kind         ech.BlockKind `json:"kind"`
	Host         string        `json:"host"`
	FirstSeenAt  time.Time     `json:"firstSeenAt"`
	LastSeenAt   time.Time     `json:"lastSeenAt"`
	ClearedAt    time.Time     `json:"clearedAt,omitzero"`
	ClearedBy    string        `json:"clearedBy,omitempty"`
	HTTPStatus   int           `json:"httpStatus,omitempty"`
	LocationHost string        `json:"locationHost,omitempty"`
	CertIssuer   string        `json:"certIssuer,omitempty"`
	// LastOutcomeAt is the newest dial outcome seen for Host, for the
	// unobserved expiry. Never sent.
	LastOutcomeAt time.Time `json:"lastOutcomeAt"`
}

type blockFileV1 struct {
	Active  *blockEpisode `json:"active,omitempty"`
	Pending *blockEpisode `json:"pending,omitempty"`
}

func validBlockKind(k ech.BlockKind) bool {
	return k.PlaintextSignature() || k == ech.BlockUntrustedCertificate
}

// valid reports whether a loaded episode honours the wire contract; detail
// fields that do not are dropped rather than failing the episode.
func (e *blockEpisode) valid(cleared bool) bool {
	if e == nil || !validBlockKind(e.Kind) || e.Host == "" || ech.SanitizeHost(e.Host) != e.Host ||
		e.FirstSeenAt.IsZero() || e.LastSeenAt.Before(e.FirstSeenAt) {
		return false
	}
	if cleared != !e.ClearedAt.IsZero() {
		return false
	}
	if cleared && e.ClearedBy != blockClearedByPlainSuccess && e.ClearedBy != blockClearedByUnobserved {
		return false
	}
	if e.HTTPStatus != 0 && (e.HTTPStatus < 100 || e.HTTPStatus > 599) {
		e.HTTPStatus = 0
	}
	if e.LocationHost != "" && ech.SanitizeHost(e.LocationHost) != e.LocationHost {
		e.LocationHost = ""
	}
	if e.CertIssuer != "" && ech.SanitizeIssuer(e.CertIssuer) != e.CertIssuer {
		e.CertIssuer = ""
	}
	return true
}

func (e *blockEpisode) report() *ControlPlaneBlockReport {
	r := &ControlPlaneBlockReport{
		Kind:         string(e.Kind),
		Host:         e.Host,
		FirstSeenAt:  e.FirstSeenAt.UTC().Format(time.RFC3339),
		LastSeenAt:   e.LastSeenAt.UTC().Format(time.RFC3339),
		HTTPStatus:   e.HTTPStatus,
		LocationHost: e.LocationHost,
		CertIssuer:   e.CertIssuer,
	}
	if !e.ClearedAt.IsZero() {
		r.ClearedAt = e.ClearedAt.UTC().Format(time.RFC3339)
		r.ClearedBy = e.ClearedBy
	}
	return r
}

// setDetails copies ev's non-empty details onto e.
func (e *blockEpisode) setDetails(ev ech.BlockEvidence) {
	if ev.HTTPStatus != 0 {
		e.HTTPStatus = ev.HTTPStatus
	}
	if ev.LocationHost != "" {
		e.LocationHost = ev.LocationHost
	}
	if ev.CertIssuer != "" {
		e.CertIssuer = ev.CertIssuer
	}
}

// blockTracker holds the episode state. Every method is nil-receiver safe:
// many heartbeat tests build &Heartbeat{} literals without a tracker.
type blockTracker struct {
	path string
	now  func() time.Time

	// persistMu serialises disk writes (the snapshot is taken under it, so
	// writes land in update order). mu guards the fields below it and is
	// never held during disk I/O.
	persistMu sync.Mutex
	mu        sync.Mutex
	active    *blockEpisode
	pending   *blockEpisode
	// clearedThrough is, per host, the latest clear: dialer evidence at or
	// before it belongs to an episode that already ended.
	clearedThrough map[string]time.Time
	lastPersistAt  time.Time
	persistWarned  bool
	// loudSupersedeAt is when a class switch last logged at INFO and wrote
	// at once; switches within blockLastSeenPersistEvery of it are quiet
	// (DEBUG, throttled write) and counted in quietSupersedes.
	loudSupersedeAt time.Time
	quietSupersedes int
	// unpersisted marks in-memory state a quiet switch has not yet written;
	// Report (every beat) flushes it once the throttle window allows.
	unpersisted bool

	dirSyncWarned atomic.Bool
	writes        atomic.Int64 // test seam
}

// newBlockTracker loads path. A missing file is the normal case; a corrupt or
// unreadable one starts empty with one WARN. path "" keeps state in memory.
func newBlockTracker(path string, now func() time.Time) *blockTracker {
	if now == nil {
		now = time.Now
	}
	t := &blockTracker{path: path, now: now, clearedThrough: map[string]time.Time{}}
	if path != "" {
		t.load()
	}
	return t
}

func (t *blockTracker) load() {
	data, err := os.ReadFile(t.path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Warn("control-plane block state unreadable; starting empty", "error", err.Error())
		}
		return
	}
	var f blockFileV1
	if err := json.Unmarshal(data, &f); err != nil {
		log.Warn("control-plane block state corrupt; starting empty", "error", err.Error())
		return
	}
	if f.Active != nil {
		if f.Active.valid(false) {
			t.active = f.Active
			if t.active.LastOutcomeAt.Before(t.active.LastSeenAt) {
				t.active.LastOutcomeAt = t.active.LastSeenAt
			}
		} else {
			log.Warn("control-plane block state dropped an invalid episode", "slot", "active")
		}
	}
	if f.Pending != nil {
		if f.Pending.valid(true) {
			t.pending = f.Pending
			t.clearedThrough[f.Pending.Host] = f.Pending.ClearedAt
		} else {
			log.Warn("control-plane block state dropped an invalid episode", "slot", "pending")
		}
	}
}

func (t *blockTracker) persistCount() int64 { return t.writes.Load() }

// persist writes the current state (or removes the file when there is none):
// temp file at 0600, then rename.
func (t *blockTracker) persist() {
	if t == nil || t.path == "" {
		return
	}
	t.persistMu.Lock()
	defer t.persistMu.Unlock()
	t.mu.Lock()
	f := blockFileV1{}
	if t.active != nil {
		a := *t.active
		f.Active = &a
	}
	if t.pending != nil {
		p := *t.pending
		f.Pending = &p
	}
	t.lastPersistAt = t.now()
	t.unpersisted = false
	t.mu.Unlock()
	t.writes.Add(1)

	err := t.write(f)
	t.mu.Lock()
	warn := err != nil && !t.persistWarned
	if err != nil {
		t.persistWarned = true
	} else {
		t.persistWarned = false
	}
	t.mu.Unlock()
	if warn {
		log.Warn("failed to persist control-plane block state", "error", err.Error())
	}
}

func (t *blockTracker) write(f blockFileV1) error {
	if f.Active == nil && f.Pending == nil {
		if err := os.Remove(t.path); err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		t.syncDir()
		return nil
	}
	data, err := json.Marshal(f)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(t.path), ".control-plane-block-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func(e error) error {
		_ = tmp.Close()
		_ = os.Remove(name)
		return e
	}
	if err := tmp.Chmod(0o600); err != nil {
		return cleanup(err)
	}
	if _, err := tmp.Write(data); err != nil {
		return cleanup(err)
	}
	// An undelivered cleared episode must survive a power loss.
	if err := tmp.Sync(); err != nil {
		return cleanup(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	// POSIX-semantics replace on Windows (AV/indexer handles), as agent.state.
	if err := atomicrename.Replace(name, t.path); err != nil {
		_ = os.Remove(name)
		return err
	}
	t.syncDir()
	return nil
}

// syncDir fsyncs the state directory after a rename or removal in it, so the
// directory entry survives a power loss: atomicrename.Replace is a bare
// rename(2) off Windows. Best effort: the file is already in place, and some
// filesystems refuse a directory fsync, so a failure is one WARN per tracker
// and never a persist failure. Windows has no directory fsync.
func (t *blockTracker) syncDir() {
	if runtime.GOOS == "windows" {
		return
	}
	dir := filepath.Dir(t.path)
	err := func() error {
		d, err := os.Open(dir)
		if err != nil {
			return err
		}
		defer func() { _ = d.Close() }()
		return d.Sync()
	}()
	if err != nil && t.dirSyncWarned.CompareAndSwap(false, true) {
		log.Warn("control-plane block state directory fsync failed; the last change may not survive a power loss",
			"error", err.Error())
	}
}

// persistNeed says what an update changed.
type persistNeed int

const (
	persistNone persistNeed = iota
	persistLastSeen
	persistNow
)

// commit persists per need. Caller has released t.mu.
func (t *blockTracker) commit(need persistNeed) {
	switch need {
	case persistNow:
		t.persist()
	case persistLastSeen:
		t.mu.Lock()
		due := t.now().Sub(t.lastPersistAt) >= blockLastSeenPersistEvery
		t.mu.Unlock()
		if due {
			t.persist()
		}
	}
}

// expireLocked clears the active episode after blockUnobservedExpiry with no
// outcome for its host. Caller holds t.mu.
func (t *blockTracker) expireLocked(now time.Time) persistNeed {
	if t.active == nil || now.Sub(t.active.LastOutcomeAt) < blockUnobservedExpiry {
		return persistNone
	}
	t.clearLocked(blockClearedByUnobserved, now)
	return persistNow
}

// clearLocked moves the active episode to pending. Caller holds t.mu.
func (t *blockTracker) clearLocked(by string, at time.Time) {
	ep := *t.active
	if at.Before(ep.LastSeenAt) {
		at = ep.LastSeenAt
	}
	ep.ClearedAt, ep.ClearedBy = at, by
	t.pending = &ep
	t.active = nil
	if at.After(t.clearedThrough[ep.Host]) {
		t.clearedThrough[ep.Host] = at
	}
	log.Info("control-plane block cleared", "host", ep.Host, "kind", string(ep.Kind), "cleared_by", by)
}

// startEpisodeLocked makes ev host's active episode. quiet logs at DEBUG (a
// throttled class switch). Caller holds t.mu.
func (t *blockTracker) startEpisodeLocked(host string, ev ech.BlockEvidence, outcome time.Time, quiet bool) {
	ep := &blockEpisode{
		Kind: ev.Kind, Host: host, FirstSeenAt: ev.SeenAt, LastSeenAt: ev.SeenAt, LastOutcomeAt: outcome,
	}
	ep.setDetails(ev)
	t.active = ep
	t.pending = nil // a new episode replaces an undelivered cleared one
	logf := log.Info
	if quiet {
		logf = log.Debug
	}
	logf("control-plane block episode started", "host", host, "kind", string(ev.Kind),
		"http_status", ev.HTTPStatus, "location_host", ev.LocationHost, "cert_issuer", ev.CertIssuer)
}

// supersedeLocked replaces the active episode with a new one of the other
// class. The switch always takes effect in memory at once (a certificate
// observation ends a plaintext episode's restart hold on this very beat).
// Only its cost is throttled: when evidence alternates between classes every
// beat, at most one switch per blockLastSeenPersistEvery logs at INFO and
// writes at once; the others log at DEBUG and ride the throttled lastSeen
// write. Report flushes a pending quiet switch on the first beat after the
// window, even with no further evidence, so the file lags memory by at most
// one window plus one beat. A restart inside that lag reloads the previous
// class until the next failure's own evidence switches it again (accepted:
// a reloaded plaintext episode holds only while its evidence is fresh,
// blockHoldFreshness). A clock that stepped backward makes the switch loud.
// Caller holds t.mu.
func (t *blockTracker) supersedeLocked(host string, ev ech.BlockEvidence, outcome, now time.Time) persistNeed {
	old := t.active
	quiet := !t.loudSupersedeAt.IsZero() && now.Sub(t.loudSupersedeAt) >= 0 &&
		now.Sub(t.loudSupersedeAt) < blockLastSeenPersistEvery
	if quiet {
		t.unpersisted = true
		t.quietSupersedes++
		log.Debug("control-plane block episode superseded", "host", host,
			"kind", string(old.Kind), "new_kind", string(ev.Kind))
	} else {
		log.Info("control-plane block episode superseded", "host", host,
			"kind", string(old.Kind), "new_kind", string(ev.Kind),
			"quiet_switches_since_last", t.quietSupersedes)
		t.loudSupersedeAt = now
		t.quietSupersedes = 0
	}
	t.startEpisodeLocked(host, ev, maxTime(outcome, old.LastOutcomeAt), quiet)
	if quiet {
		return persistLastSeen
	}
	return persistNow
}

// applyEvidenceLocked starts or extends host's episode with ev. outcome is the
// newest dial outcome for host (>= ev.SeenAt). Caller holds t.mu.
//
// Evidence falls in two classes: a plaintext signature (a filter or portal
// answered) and an untrusted certificate (something answered with TLS).
// Evidence of the other class than the active episode's ends that episode and
// starts a new one, so the report names what answers now and a plaintext
// episode's restart hold is never kept fresh by certificate evidence. Within
// the plaintext class the episode continues; its kind only moves from
// plaintext_unknown to a richer kind.
func (t *blockTracker) applyEvidenceLocked(host string, ev ech.BlockEvidence, outcome time.Time, now time.Time) persistNeed {
	if t.active == nil {
		if !ev.SeenAt.After(t.clearedThrough[host]) || now.Sub(ev.SeenAt) >= blockUnobservedExpiry {
			return persistNone
		}
		t.startEpisodeLocked(host, ev, outcome, false)
		return persistNow
	}
	ep := t.active
	if ep.Host != host || !ev.SeenAt.After(ep.LastSeenAt) {
		return persistNone
	}
	if ep.Kind.PlaintextSignature() != ev.Kind.PlaintextSignature() {
		return t.supersedeLocked(host, ev, outcome, now)
	}
	ep.LastSeenAt = ev.SeenAt
	before := *ep
	switch {
	case ev.Kind == ep.Kind:
		ep.setDetails(ev)
	case ep.Kind == ech.BlockPlaintextUnknown:
		// The only kind change within an episode: to a richer plaintext kind.
		ep.Kind = ev.Kind
		ep.HTTPStatus, ep.LocationHost, ep.CertIssuer = 0, "", ""
		ep.setDetails(ev)
	}
	if *ep != before {
		return persistNow
	}
	return persistLastSeen
}

func maxTime(ts ...time.Time) time.Time {
	var m time.Time
	for _, x := range ts {
		if x.After(m) {
			m = x
		}
	}
	return m
}

// Observe folds the ECH dialer's status for host into the episode state:
// current evidence (newer than the last plain success) starts or extends an
// episode, a plain success newer than the episode's lastSeenAt clears it
// (plain_success), and 24 h without any outcome clears it (unobserved). An
// ECH accept keeps the episode open: it proves reachability, not that the
// filter is gone.
func (t *blockTracker) Observe(host string, st ech.HostStatus) {
	if t == nil {
		return
	}
	host = ech.SanitizeHost(host)
	if host == "" {
		return
	}
	t.mu.Lock()
	now := t.now()
	need := t.expireLocked(now)
	outcome := maxTime(st.Evidence.SeenAt, st.LastPlainSuccessAt, st.LastECHAcceptedAt)
	if ep := t.active; ep != nil && ep.Host == host {
		if outcome.After(ep.LastOutcomeAt) {
			ep.LastOutcomeAt = outcome
			// Persisted (throttled) so a restart after a long ECH-carried
			// stretch does not expire the episode as unobserved.
			need = max(need, persistLastSeen)
		}
		if st.LastPlainSuccessAt.After(ep.LastSeenAt) {
			t.clearLocked(blockClearedByPlainSuccess, st.LastPlainSuccessAt)
			need = persistNow
		}
	}
	if !st.Evidence.IsZero() && st.Evidence.SeenAt.After(st.LastPlainSuccessAt) {
		need = max(need, t.applyEvidenceLocked(host, st.Evidence, outcome, now))
	}
	t.mu.Unlock()
	t.commit(need)
}

// ObserveRequestError classifies a failed request to host without the
// dialer's capture (the HTTPS-proxy path bypasses the dialer): the filter
// signature is plaintext_unknown, an untrusted authority is
// untrusted_certificate. It never downgrades a richer kind in the same
// episode, and other errors are ignored.
func (t *blockTracker) ObserveRequestError(host string, err error) {
	if t == nil || err == nil {
		return
	}
	host = ech.SanitizeHost(host)
	if host == "" {
		return
	}
	t.mu.Lock()
	now := t.now()
	ev, ok := ech.ErrorEvidence(err, now)
	if !ok {
		t.mu.Unlock()
		return
	}
	need := t.expireLocked(now)
	if t.active != nil && t.active.Host == host && now.After(t.active.LastOutcomeAt) {
		t.active.LastOutcomeAt = now
	}
	need = max(need, t.applyEvidenceLocked(host, ev, now, now))
	t.mu.Unlock()
	t.commit(need)
}

// ObserveReached records a heartbeat 200 from host. Without ECH it clears
// host's active episode (plain_success): this also covers the proxy path,
// where the dialer never sees the handshake. Over ECH the episode stays open.
func (t *blockTracker) ObserveReached(host string, viaECH bool) {
	if t == nil || viaECH {
		return
	}
	host = ech.SanitizeHost(host)
	t.mu.Lock()
	need := persistNone
	if t.active != nil && t.active.Host == host {
		t.clearLocked(blockClearedByPlainSuccess, t.now())
		need = persistNow
	}
	t.mu.Unlock()
	t.commit(need)
}

// ForgetOtherHosts clears (unobserved) an active episode whose host is no
// longer one of keep (the current primary and backup): after a server URL
// change its host is never dialed again, and the one-active rule would
// otherwise ignore the new host's evidence for up to 24 h.
func (t *blockTracker) ForgetOtherHosts(keep ...string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	need := persistNone
	if t.active != nil {
		kept := false
		for _, k := range keep {
			if k != "" && ech.SanitizeHost(k) == t.active.Host {
				kept = true
			}
		}
		if !kept {
			t.clearLocked(blockClearedByUnobserved, t.now())
			need = persistNow
		}
	}
	t.mu.Unlock()
	t.commit(need)
}

// HoldsRestart reports whether host has an active plaintext-signature
// episode whose last evidence is at most blockHoldFreshness old. A failed
// heartbeat that is not itself a filter signature holds watchdog restarts
// only then. The test is the age of the last evidence alone: an episode
// reloaded from disk holds only while that evidence is still fresh, and one
// the filter stopped refreshing stops holding once it ages out. Evidence
// dated in the future (the clock stepped backward) does not hold, or the
// hold would last as long as the step. An untrusted certificate never holds.
func (t *blockTracker) HoldsRestart(host string) bool {
	if t == nil {
		return false
	}
	host = ech.SanitizeHost(host)
	t.mu.Lock()
	defer t.mu.Unlock()
	ep := t.active
	if ep == nil || ep.Host != host || !ep.Kind.PlaintextSignature() {
		return false
	}
	age := t.now().Sub(ep.LastSeenAt)
	return age >= 0 && age <= blockHoldFreshness
}

// Report returns the episode to send: the active one, else the pending
// cleared one, else nil.
func (t *blockTracker) Report() *ControlPlaneBlockReport {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	need := t.expireLocked(t.now())
	if t.unpersisted {
		need = max(need, persistLastSeen) // flush a throttled quiet switch
	}
	var r *ControlPlaneBlockReport
	switch {
	case t.active != nil:
		r = t.active.report()
	case t.pending != nil:
		r = t.pending.report()
	}
	t.mu.Unlock()
	t.commit(need)
	return r
}

// MarkDelivered drops the pending cleared episode once a beat carrying it got
// a 200: only when r is a cleared report of that same episode (host and
// firstSeenAt). An active report is never "delivered".
func (t *blockTracker) MarkDelivered(r *ControlPlaneBlockReport) {
	if t == nil || r == nil || r.ClearedAt == "" {
		return
	}
	t.mu.Lock()
	p := t.pending
	drop := p != nil && p.Host == r.Host && p.FirstSeenAt.UTC().Format(time.RFC3339) == r.FirstSeenAt
	if drop {
		t.pending = nil
	}
	t.mu.Unlock()
	if drop {
		t.persist()
	}
}

// Current returns host's active episode. It is the trigger contract for
// alternate control-plane discovery (#8870): act only when
// ech.BlockKind(r.Kind).PlaintextSignature() holds and the kind is not
// captive_portal; never for untrusted_certificate.
func (t *blockTracker) Current(host string) (ControlPlaneBlockReport, bool) {
	if t == nil {
		return ControlPlaneBlockReport{}, false
	}
	host = ech.SanitizeHost(host)
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.active == nil || t.active.Host != host {
		return ControlPlaneBlockReport{}, false
	}
	return *t.active.report(), true
}
