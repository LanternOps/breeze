package logging

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// TokenRevealer is implemented by secmem.SecureString. Using an interface
// here avoids a circular import (secmem already imports logging).
type TokenRevealer interface {
	Reveal() string
}

// AuthSkipper is implemented by authstate.Monitor. Using an interface
// here avoids taking on a hard dependency on authstate from the logging
// package (logging is very low-level and many other packages import it).
type AuthSkipper interface {
	ShouldSkip() bool
	RecordAuthFailure()
	RecordSuccess()
}

const (
	defaultBatchInterval = 60 * time.Second
	defaultMaxBatchSize  = 500
	defaultBufferSize    = 500
)

// maxEntriesPerShipRequest mirrors the API log endpoint's per-request cap:
// apps/api/src/routes/agents/logs.ts validates `logs: z.array(...).max(200)`
// and 400s the entire request when exceeded — and 4xx responses are never
// retried, so an oversized request loses every entry in it (#2397). The
// shipper accumulates up to defaultMaxBatchSize (500) entries per flush, so
// each flush is split into chunks of at most this many entries per HTTP
// request. Go and TypeScript can't share a constant; this comment is the
// sync mechanism — this value must stay <= the API-side cap (never raise it
// in lockstep with a server bump: self-hosted API versions vary, so the
// agent must conform to the oldest supported cap).
const maxEntriesPerShipRequest = 200

// LogEntry represents a single log entry to be shipped remotely.
type LogEntry struct {
	Timestamp    time.Time      `json:"timestamp"`
	Level        string         `json:"level"`
	Component    string         `json:"component"`
	Message      string         `json:"message"`
	Fields       map[string]any `json:"fields,omitempty"`
	AgentVersion string         `json:"agentVersion"`
}

// Shipper buffers log entries and ships them to the API in compressed batches.
type Shipper struct {
	serverURL    func() string
	agentID      string
	authToken    TokenRevealer
	agentVersion string
	httpClient   *http.Client
	buffer       chan LogEntry
	stopChan     chan struct{}
	wg           sync.WaitGroup
	stopOnce     sync.Once
	minLevel     slog.Level   // configured base level; see SetMinLevel
	mu           sync.RWMutex // protects minLevel, override*
	// overrideLevel/overrideExpiresAt hold a temporary set_log_level override
	// (#7416). It wins over minLevel until overrideExpiresAt, after which
	// ShouldShip falls back to minLevel with no timer involved. A zero
	// overrideExpiresAt means no override.
	overrideLevel     slog.Level
	overrideExpiresAt time.Time
	// overrideSetAt is when the command that produced the override ran. A
	// persisted override replaces the in-memory one only if it is at least
	// as new, so a stale file cannot displace a newer override whose write
	// failed.
	overrideSetAt time.Time
	// overridePath is the persisted override file (LevelOverrideFileName);
	// empty disables persistence and polling.
	overridePath string
	// overrideReadErrLogged rate-limits the "cannot read override file"
	// warning to once per shipper.
	overrideReadErrLogged atomic.Bool
	// now is the clock; nil means time.Now (tests inject a fixed clock).
	now          func() time.Time
	droppedCount atomic.Int64
	// urlErrCount rate-limits the unresolvable-server-URL report. That state
	// never self-heals, so an unguarded stderr write would emit a line on every
	// flush for the process lifetime.
	urlErrCount atomic.Int64
	authMon     AuthSkipper
	// lastAttempt is the last terminal chunk outcome (shipper_health.go):
	// one immutable record behind one pointer, so snapshots never tear.
	lastAttempt atomic.Pointer[attemptRecord]
	// pendingBatch is the size of the batch shipLoop holds in hand while
	// shipBatch runs; 0 otherwise. Counted in QueueDepth.
	pendingBatch atomic.Int32
	// retryMu guards notBefore and deferLogged. shipChunk (sets) and shipLoop
	// (reads) run on one goroutine today, but Stop-path drains and tests call
	// shipBatch from others, so the carried hint is mutex-guarded.
	retryMu sync.Mutex
	// notBefore is the earliest time the next batch may be posted: the
	// server's (jittered, capped) Retry-After from a chunk we gave up on.
	// Zero means nothing is carried. See carryRetryAfter / shipDeferred.
	notBefore time.Time
	// deferLogged is true once the current deferral has been announced on
	// stderr, so the line is emitted once per deferral, not once per tick.
	deferLogged bool
}

// ShipperConfig configures the log shipper.
type ShipperConfig struct {
	// ServerURL returns the CURRENT Breeze server root, e.g.
	// https://breeze.example.com — NOT including /api/v1. It is a provider
	// (heartbeat.ServerURL in the agent; a persisted-config reader in the
	// helper processes), not a copied string, so backup-server-URL promotion
	// after failover (#2323) is visible to every flush.
	//
	// The type is deliberately a func rather than a string plus an optional
	// "and also watch this for updates" field: a by-value cfg.ServerURL copy
	// pinned diagnostics to the DEAD primary for the whole process lifetime —
	// exactly when those logs are most wanted — and the same mistake had
	// already been made twice in sibling clients (#2423, #2425). Making the
	// field a func makes it unrepresentable (#2463).
	ServerURL    func() string
	AgentID      string
	AuthToken    TokenRevealer
	AgentVersion string
	HTTPClient   *http.Client
	MinLevel     string // "debug", "info", "warn", "error"
	AuthMonitor  AuthSkipper
	// LevelOverridePath is the persisted set_log_level override file
	// (filepath.Join(config.ConfigDir(), LevelOverrideFileName)). When set,
	// the shipper applies an active override at Start and re-reads the file
	// every levelOverridePollInterval, so an override outlives a restart and
	// reaches helper processes (#7416). Empty disables both.
	LevelOverridePath string
}

// NewShipper creates a new log shipper.
func NewShipper(cfg ShipperConfig) *Shipper {
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &Shipper{
		serverURL:    cfg.ServerURL,
		agentID:      cfg.AgentID,
		authToken:    cfg.AuthToken,
		agentVersion: cfg.AgentVersion,
		httpClient:   client,
		buffer:       make(chan LogEntry, defaultBufferSize),
		stopChan:     make(chan struct{}),
		minLevel:     parseLevel(cfg.MinLevel),
		authMon:      cfg.AuthMonitor,
		overridePath: cfg.LevelOverridePath,
	}
}

// resolveServerURL returns the CURRENT server root from the provider.
//
// An unset provider, or one that returns an empty string, is a wiring bug
// rather than a runtime condition: report it as a named error instead of
// calling a nil func — which would panic the ship loop goroutine, and unlike
// the sibling client loops the shipper carries no observability.Recoverer, so
// the panic would take the whole agent down — or building a scheme-less
// relative URL that fails forever as a cryptic transport error.
func (s *Shipper) resolveServerURL() (string, error) {
	if s.serverURL == nil {
		return "", fmt.Errorf("%w: ServerURL provider not set", errShipURLUnresolved)
	}
	serverURL := s.serverURL()
	if serverURL == "" {
		return "", fmt.Errorf("%w: ServerURL provider returned an empty server URL", errShipURLUnresolved)
	}
	return serverURL, nil
}

// Start begins the background shipping loop.
func (s *Shipper) Start() {
	if s.overridePath != "" {
		// Synchronously, so a restarted process ships at the override level
		// from its first log line rather than one poll interval later.
		s.refreshLevelOverride()
		s.wg.Add(1)
		go s.overrideLoop()
	}
	s.wg.Add(1)
	go s.shipLoop()
}

// Stop gracefully stops the shipper, flushing remaining logs.
// Safe to call multiple times.
func (s *Shipper) Stop() {
	s.stopOnce.Do(func() {
		close(s.stopChan)
	})
	s.wg.Wait()
}

// maxShippedFieldsJSONBytes mirrors the API log endpoint's per-entry cap
// (apps/api/src/routes/agents/logs.ts rejects entries whose stringified
// `fields` exceeds 32,000 chars — and a single oversized entry 400s the
// whole batch, burning every legitimate entry shipped with it, #2386).
// For strings, Go's marshaled byte length is >= JSON.stringify().length
// (UTF-8 bytes >= UTF-16 units, plus Go additionally HTML-escapes <>& to
// six-byte \u00XX forms); float formatting can differ by a few bytes per
// field in either direction, which the 1,000-byte headroom absorbs.
//
// Note this guards only `fields` — the API also caps message (10,000) and
// component (100), which nothing in the agent currently approaches.
const maxShippedFieldsJSONBytes = 31000

// maxSalvagedFieldBytes is the per-field size above which a field is dropped
// (by name) when the entry as a whole is over the ship limit.
const maxSalvagedFieldBytes = 1024

// capFields enforces the API's per-entry `fields` size limit locally before
// the entry is buffered, so one bloated or unmarshalable entry cannot get
// the whole shipped batch rejected (the API 400s the entire batch on any
// invalid entry, and shipBatch drops all entries on a whole-batch marshal
// failure). Small fields are salvaged — operators need correlating scalars
// like ids and durations — and the oversized/unmarshalable ones are dropped
// by name in a `fields_dropped` marker.
func capFields(fields map[string]any) map[string]any {
	if fields == nil {
		return nil
	}
	b, err := json.Marshal(fields)
	if err == nil && len(b) <= maxShippedFieldsJSONBytes {
		return fields
	}
	var reason string
	if err != nil {
		// e.g. a NaN/Inf float or a non-marshalable value smuggled into a
		// slog attr. Left alone it would fail the whole-batch marshal in
		// shipBatch and silently drop every co-batched entry.
		reason = fmt.Sprintf("fields not JSON-marshalable (%v)", err)
	} else {
		reason = fmt.Sprintf("fields JSON was %d bytes, exceeds ship limit of %d", len(b), maxShippedFieldsJSONBytes)
	}

	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic salvage order

	capped := make(map[string]any, len(fields)+1)
	var dropped []string
	// Salvage into half the ship limit so the kept fields + marker + JSON
	// syntax overhead can never re-breach the cap.
	const salvageBudget = maxShippedFieldsJSONBytes / 2
	used := 0
	for _, k := range keys {
		vb, verr := json.Marshal(fields[k])
		if verr != nil {
			dropped = append(dropped, k+"(unmarshalable)")
			continue
		}
		if len(vb) > maxSalvagedFieldBytes || used+len(vb)+len(k)+8 > salvageBudget {
			dropped = append(dropped, fmt.Sprintf("%s(%dB)", k, len(vb)))
			continue
		}
		capped[k] = fields[k]
		used += len(vb) + len(k) + 8
	}

	marker := reason + "; dropped: " + strings.Join(dropped, ", ")
	if len(marker) > 2000 {
		marker = marker[:2000] + "..."
	}
	capped["fields_dropped"] = marker
	return capped
}

// Enqueue adds a log entry to the buffer. Non-blocking; drops if buffer is full.
func (s *Shipper) Enqueue(entry LogEntry) {
	entry.Fields = capFields(entry.Fields)
	select {
	case s.buffer <- entry:
	default:
		dropped := s.droppedCount.Add(1)
		if dropped == 1 || dropped%100 == 0 {
			fmt.Fprintf(os.Stderr, "[log-shipper] buffer full, dropped %d log entries\n", dropped)
		}
	}
}

// SetMinLevel dynamically adjusts the minimum shipping level.
func (s *Shipper) SetMinLevel(level string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.minLevel = parseLevel(level)
}

// ShouldShip returns true if the given level meets the effective threshold:
// an active override when there is one, otherwise the base level.
func (s *Shipper) ShouldShip(level slog.Level) bool {
	s.mu.RLock()
	floor := s.minLevel
	if !s.overrideExpiresAt.IsZero() && s.clock().Before(s.overrideExpiresAt) {
		floor = s.overrideLevel
	}
	s.mu.RUnlock()
	return level >= floor
}

func (s *Shipper) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// setLevelOverride installs an override that expires at expiresAt, set by a
// command that ran at setAt.
func (s *Shipper) setLevelOverride(level slog.Level, expiresAt, setAt time.Time) {
	s.mu.Lock()
	s.overrideLevel = level
	s.overrideExpiresAt = expiresAt
	s.overrideSetAt = setAt
	s.mu.Unlock()
}

func (s *Shipper) baseLevelName() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return levelName(s.minLevel)
}

// refreshLevelOverride applies the persisted override when it is active, at
// least as new as the one in memory, and different from it. An absent or
// expired file changes nothing (see leveloverride.go); an untrustworthy one
// is reported once per bad spell and ignored.
//
// Never call this while holding shipperMu: it logs, and the log record goes
// through shippingHandler.Handle, which read-locks shipperMu.
func (s *Shipper) refreshLevelOverride() {
	o, ok, err := ReadLevelOverride(s.overridePath, s.clock())
	if err != nil {
		if s.overrideReadErrLogged.CompareAndSwap(false, true) {
			slog.Warn("ignoring log shipping level override file",
				"path", s.overridePath, "error", err.Error())
		}
		return
	}
	// A good read (including "no file" and "expired") re-arms the warning,
	// so a later bad file is reported again.
	s.overrideReadErrLogged.Store(false)
	if !ok {
		return
	}
	level := parseLevel(o.Level)
	s.mu.Lock()
	changed := !o.SetAt.Before(s.overrideSetAt) &&
		(s.overrideLevel != level || !s.overrideExpiresAt.Equal(o.ExpiresAt))
	if changed {
		s.overrideLevel = level
		s.overrideExpiresAt = o.ExpiresAt
		s.overrideSetAt = o.SetAt
	}
	base := s.minLevel
	s.mu.Unlock()
	if changed {
		// Logged outside s.mu: the record re-enters ShouldShip.
		slog.Info("log shipping level override applied",
			"level", o.Level, "baseLevel", levelName(base),
			"expiresAt", o.ExpiresAt.Format(time.RFC3339))
	}
}

// overrideLoop re-reads the override file until Stop, and announces the
// moment an active override lapses back to the base level.
func (s *Shipper) overrideLoop() {
	defer s.wg.Done()
	ticker := time.NewTicker(levelOverridePollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopChan:
			return
		case <-ticker.C:
			s.expireLevelOverride()
			s.refreshLevelOverride()
		}
	}
}

// expireLevelOverride clears an override whose expiry has passed so the
// reversion is logged exactly once.
func (s *Shipper) expireLevelOverride() {
	s.mu.Lock()
	expired := !s.overrideExpiresAt.IsZero() && !s.clock().Before(s.overrideExpiresAt)
	var level, base slog.Level
	if expired {
		level, base = s.overrideLevel, s.minLevel
		s.overrideExpiresAt = time.Time{}
	}
	s.mu.Unlock()
	if expired {
		slog.Info("log shipping level override expired; reverted to base level",
			"overrideLevel", levelName(level), "baseLevel", levelName(base))
	}
}

func (s *Shipper) shipLoop() {
	defer s.wg.Done()

	tick, stopTick := shipperTick(defaultBatchInterval)
	defer stopTick()

	batch := make([]LogEntry, 0, defaultMaxBatchSize)

	for {
		// While a Retry-After hold keeps a full batch unshipped, stop pulling
		// from the buffer (nil channel never selects) instead of growing the
		// batch: the 500-entry buffer then fills and Enqueue drops-when-full
		// with its existing accounting, so memory stays bounded.
		in := s.buffer
		if len(batch) >= defaultMaxBatchSize {
			in = nil
		}

		select {
		case <-s.stopChan:
			// Drain remaining buffered entries. Deliberately ignores any
			// Retry-After hold: shutdown ships what it can, retrying a
			// transient failure with the short fixed backoff but never
			// waiting out a long server Retry-After (see sleep).
		drain:
			for {
				select {
				case entry := <-s.buffer:
					batch = append(batch, entry)
					if len(batch) >= defaultMaxBatchSize {
						s.shipHeld(batch)
						clear(batch)
						batch = batch[:0]
					}
				default:
					break drain
				}
			}
			if len(batch) > 0 {
				s.shipHeld(batch)
			}
			return

		case entry := <-in:
			batch = append(batch, entry)
			if len(batch) >= defaultMaxBatchSize && !s.shipDeferred() {
				s.shipHeld(batch)
				// Release strings and field maps before reusing the backing array.
				// shipBatch has finished; any re-buffered entries are value copies.
				clear(batch)
				batch = batch[:0]
			}

		case <-tick:
			if len(batch) > 0 && !s.shipDeferred() {
				s.shipHeld(batch)
				clear(batch)
				batch = batch[:0]
			}
		}
	}
}

const (
	shipRetryCount   = 2
	shipRetryBackoff = 1 * time.Second
	// retryAfterJitterFrac stretches a server Retry-After by up to +30% so a
	// fleet told "wait 40 s" does not return in lockstep.
	retryAfterJitterFrac = 0.3
)

// Test seams (W09, #8148). Tests swap these and must not run in parallel.
var (
	shipperNow   = time.Now
	shipperAfter = time.After
	shipperRand  = rand.Float64
	// shipperTick supplies the flush tick channel and its stop func.
	shipperTick = func(d time.Duration) (<-chan time.Time, func()) {
		t := time.NewTicker(d)
		return t.C, t.Stop
	}
)

// loopRetryAfterDisabled is the D10 escape hatch, inverted so the zero value
// means the feature is ON.
var loopRetryAfterDisabled atomic.Bool

// SetLoopRetryAfter enables (default) or disables carrying a server
// Retry-After across batches. When disabled, a chunk given up on forgets the
// hint, as before W09; in-loop retry waits stay cancellable either way.
func SetLoopRetryAfter(enabled bool) {
	loopRetryAfterDisabled.Store(!enabled)
}

// shipDrainMaxRetryWait is the longest retry wait the shutdown drain still
// sits through: the fixed backoff plus its jitter. A longer server
// Retry-After is not waited out once Stop has run.
const shipDrainMaxRetryWait = shipRetryBackoff + shipRetryBackoff/2

// sleep waits d or until the shipper is stopped. It returns false if stopped.
// Once stopped (the shutdown drain), a wait no longer than the fixed backoff
// still runs, so the final flush rides out a transient failure as it did
// before the waits became cancellable (W09, #8148).
func (s *Shipper) sleep(d time.Duration) bool {
	if d <= shipDrainMaxRetryWait {
		<-shipperAfter(d) // short: bounded, and the same with or without Stop
		return true
	}
	select {
	case <-s.stopChan:
		return false
	default:
	}
	select {
	case <-s.stopChan:
		return false
	case <-shipperAfter(d):
		return true
	}
}

// jitterRetryAfter returns ra x (1 + 0.3 x rand) clamped to retryAfterMaxCap.
// Computed once per hint and reused for the in-loop wait and the carried hold.
func jitterRetryAfter(ra time.Duration) time.Duration {
	d := time.Duration(float64(ra) * (1 + retryAfterJitterFrac*shipperRand()))
	if d > retryAfterMaxCap {
		d = retryAfterMaxCap
	}
	return d
}

// carryRetryAfter records that no batch should be posted for d, keeping the
// later of any existing hold. No-op when the loop hint is disabled.
func (s *Shipper) carryRetryAfter(d time.Duration) {
	if d <= 0 || loopRetryAfterDisabled.Load() {
		return
	}
	nb := shipperNow().Add(d)
	s.retryMu.Lock()
	if nb.After(s.notBefore) {
		s.notBefore = nb
		s.deferLogged = false
	}
	s.retryMu.Unlock()
}

// shipDeferred reports whether the ship loop must hold its batch because the
// server asked us to back off. Logs once per deferral. Only the ticker and
// batch-full paths consult it; the shutdown drain deliberately does not.
func (s *Shipper) shipDeferred() bool {
	now := shipperNow()
	s.retryMu.Lock()
	defer s.retryMu.Unlock()
	if !now.Before(s.notBefore) {
		s.notBefore = time.Time{}
		s.deferLogged = false
		return false
	}
	if !s.deferLogged {
		s.deferLogged = true
		fmt.Fprintf(os.Stderr, "[log-shipper] deferring log shipping for %v (server Retry-After)\n",
			s.notBefore.Sub(now).Round(time.Second))
	}
	return true
}

// shipBatch ships a flushed batch, splitting it into chunks of at most
// maxEntriesPerShipRequest entries per HTTP request — the API rejects any
// larger request wholesale (#2397). Each chunk succeeds or fails
// independently: a non-auth 4xx on one chunk drops only that chunk's entries
// and later chunks still ship. A terminal failure — network error or 429/5xx
// after exhausting retries (server unreachable/unhealthy), or a 401 (token
// dead for every chunk alike) — aborts the remaining chunks instead, since
// each further chunk would burn another doomed request or retry cycle for
// the same outcome, blocking the ship loop.
func (s *Shipper) shipBatch(entries []LogEntry) {
	if s.authMon != nil && s.authMon.ShouldSkip() {
		// Auth-dead: don't drop entries on the ticker path — re-buffer
		// them so they ship once auth recovers. On the drain path
		// (stopChan closed) we must NOT re-buffer, or the drain loop
		// pulls them right back out and hangs forever. Drop with count
		// in that case.
		//
		// stopChan is checked first (priority select) before attempting
		// the buffer send, because when both are ready Go picks randomly
		// and we need shutdown to win deterministically.
		for i, e := range entries {
			select {
			case <-s.stopChan:
				// Shutting down: drop entries we haven't re-buffered yet.
				// Entries [0..i-1] are already back in the buffer and will
				// be handled by the drain path (which also drops when
				// auth-dead).
				s.droppedCount.Add(int64(len(entries) - i))
				return
			default:
			}
			select {
			case s.buffer <- e:
			default:
				s.droppedCount.Add(1)
			}
		}
		return
	}

	for start := 0; start < len(entries); start += maxEntriesPerShipRequest {
		end := min(start+maxEntriesPerShipRequest, len(entries))
		if !s.shipChunk(entries[start:end]) {
			if remaining := len(entries) - end; remaining > 0 {
				fmt.Fprintf(os.Stderr, "[log-shipper] dropping %d entries in remaining chunks after terminal failure\n", remaining)
				s.droppedCount.Add(int64(remaining))
			}
			return
		}
	}
}

// shipChunk sends one HTTP request carrying at most maxEntriesPerShipRequest
// entries, with per-chunk retry for network errors and 429/5xx responses.
// It returns false on terminal failures that would doom every remaining
// chunk alike — network error or retryable status after exhausting retries,
// or a 401 (dead token) — so the caller can stop burning requests on the
// rest of the batch. Chunk-local outcomes (success, or a non-retried
// non-auth 4xx that drops only this chunk) return true.
func (s *Shipper) shipChunk(entries []LogEntry) bool {
	// Resolved here, on every flush, rather than captured once at init: after a
	// backup-server-URL promotion (#2323) the next flush must go to the
	// promoted primary. The retry attempts below deliberately keep the URL this
	// flush started with — a promotion landing inside a single chunk's ~3s
	// retry window is picked up by the next batch (<=60s), which is what
	// matters; the bug being fixed was a URL frozen for the process lifetime
	// (#2463).
	//
	// Resolved BEFORE the marshal+gzip below so a wiring bug doesn't burn a
	// compression pass over 200 entries before discovering it has nowhere to
	// send them.
	baseURL, err := s.resolveServerURL()
	if err != nil {
		// Terminal for the whole batch: every remaining chunk would hit the
		// same wiring bug, so shipBatch must not burn a request per chunk.
		// Rate-limited — this state does not self-heal, so an unguarded write
		// would emit a line on every flush forever.
		dropped := s.droppedCount.Add(int64(len(entries)))
		if s.urlErrCount.Add(1)%10 == 1 {
			fmt.Fprintf(os.Stderr, "[log-shipper] %v — dropped %d entries (%d total)\n", err, len(entries), dropped)
		}
		s.recordShipFailure(sanitizeShipError(err, 0))
		return false
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/logs", baseURL, s.agentID)

	payload, err := json.Marshal(map[string]any{
		"logs": entries,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] marshal error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		s.recordShipFailure(sanitizeShipError(err, 0))
		return true
	}

	// Compress payload with gzip
	var compressed bytes.Buffer
	gw := gzip.NewWriter(&compressed)
	if _, err := gw.Write(payload); err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] gzip write error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		s.recordShipFailure(sanitizeShipError(err, 0))
		return true
	}
	if err := gw.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] gzip close error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		s.recordShipFailure(sanitizeShipError(err, 0))
		return true
	}
	compressedBytes := compressed.Bytes()

	// nextSleepOverride, if non-zero, replaces the default fixed-jitter sleep
	// for the next retry. Set when the server sends Retry-After on 429/503.
	var nextSleepOverride time.Duration
	// lastStatus is the most recent retryable HTTP status, for the failure
	// record when a wait is cut short by shutdown.
	lastStatus := 0

	for attempt := 0; attempt <= shipRetryCount; attempt++ {
		if attempt > 0 {
			wait := shipRetryBackoff + time.Duration(rand.Intn(int(shipRetryBackoff/2)))
			if nextSleepOverride > 0 {
				wait = nextSleepOverride
				nextSleepOverride = 0
			}
			if !s.sleep(wait) {
				// Shutdown mid-retry: this chunk is lost like any other
				// terminal drop; the caller drops the remaining chunks.
				fmt.Fprintf(os.Stderr, "[log-shipper] shutdown during retry wait; dropping %d entries\n", len(entries))
				s.droppedCount.Add(int64(len(entries)))
				s.recordShipFailure(sanitizeShipError(nil, lastStatus))
				return false
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(compressedBytes))
		if err != nil {
			cancel()
			fmt.Fprintf(os.Stderr, "[log-shipper] request build error: %v\n", err)
			s.droppedCount.Add(int64(len(entries)))
			s.recordShipFailure(sanitizeShipError(err, 0))
			return true
		}

		req.Header.Set("Authorization", "Bearer "+s.authToken.Reveal())
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Content-Encoding", "gzip")

		resp, err := s.httpClient.Do(req)
		if err != nil {
			cancel()
			// Network error: retry if we have attempts left
			if attempt < shipRetryCount {
				fmt.Fprintf(os.Stderr, "[log-shipper] HTTP error (attempt %d/%d): %v\n", attempt+1, shipRetryCount+1, err)
				continue
			}
			fmt.Fprintf(os.Stderr, "[log-shipper] HTTP error (giving up after %d attempts): %v\n", shipRetryCount+1, err)
			s.droppedCount.Add(int64(len(entries)))
			s.recordShipFailure(sanitizeShipError(err, 0))
			return false
		}

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
			// 429/503: retryable, and may carry Retry-After.
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			lastStatus = resp.StatusCode
			if ra := parseRetryAfter(resp.Header, shipperNow()); ra > 0 {
				nextSleepOverride = jitterRetryAfter(ra)
			}
			resp.Body.Close()
			cancel()
			if attempt < shipRetryCount {
				fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d (attempt %d/%d, next sleep %v): %s\n",
					resp.StatusCode, attempt+1, shipRetryCount+1, nextSleepOverride, string(body))
				continue
			}
			fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d (giving up after %d attempts): %s\n",
				resp.StatusCode, shipRetryCount+1, string(body))
			s.droppedCount.Add(int64(len(entries)))
			s.recordShipFailure(sanitizeShipError(nil, resp.StatusCode))
			// The chunk is lost but the server's ask stands: hold the next
			// batch until it has passed (jittered once, capped at 300 s).
			s.carryRetryAfter(nextSleepOverride)
			return false
		}

		if resp.StatusCode >= 500 {
			// Other 5xx: retry without Retry-After awareness.
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			cancel()
			if attempt < shipRetryCount {
				fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d (attempt %d/%d): %s\n",
					resp.StatusCode, attempt+1, shipRetryCount+1, string(body))
				continue
			}
			fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d (giving up after %d attempts): %s\n",
				resp.StatusCode, shipRetryCount+1, string(body))
			s.droppedCount.Add(int64(len(entries)))
			s.recordShipFailure(sanitizeShipError(nil, resp.StatusCode))
			return false
		}

		if resp.StatusCode >= 400 {
			// Client error (4xx): do not retry this chunk.
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			cancel()
			fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d for %d entries: %s\n",
				resp.StatusCode, len(entries), string(body))
			s.droppedCount.Add(int64(len(entries)))
			s.recordShipFailure(sanitizeShipError(nil, resp.StatusCode))
			if resp.StatusCode == http.StatusUnauthorized {
				// Auth is request-independent: the token won't get healthier
				// between chunks, so shipping the batch's remaining chunks
				// would just burn one doomed request — and one extra
				// RecordAuthFailure — per chunk, skewing the auth monitor's
				// skip threshold (tuned for one failure per flush, the
				// pre-chunking behavior). Terminal: record once, abort batch.
				if s.authMon != nil {
					s.authMon.RecordAuthFailure()
				}
				return false
			}
			// Other 4xxs are chunk-local — the rejection is about this
			// request's contents (e.g. a validation failure) — so only this
			// chunk's entries are dropped and the batch's remaining chunks
			// still ship (#2397).
			return true
		}

		// Success
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		cancel()
		s.recordShipSuccess()
		if s.authMon != nil {
			s.authMon.RecordSuccess()
		}
		return true
	}
	return true // unreachable: the loop always returns on its final attempt
}

// DroppedLogCount returns the current count of dropped log entries without
// resetting the counter. Use CommitDroppedLogCount to clear it after the
// heartbeat has been successfully sent.
func (s *Shipper) DroppedLogCount() int64 {
	return s.droppedCount.Load()
}

// CommitDroppedLogCount resets the dropped log counter to zero. Call this
// after the heartbeat POST succeeds so that the count is preserved for retry
// if the heartbeat fails.
func (s *Shipper) CommitDroppedLogCount() {
	s.droppedCount.Store(0)
}
