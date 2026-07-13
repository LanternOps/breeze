package logging

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
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
	minLevel     slog.Level
	mu           sync.RWMutex // protects minLevel
	droppedCount atomic.Int64
	authMon      AuthSkipper
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
		return "", errors.New("log shipper: ServerURL provider not set")
	}
	serverURL := s.serverURL()
	if serverURL == "" {
		return "", errors.New("log shipper: ServerURL provider returned an empty server URL")
	}
	return serverURL, nil
}

// Start begins the background shipping loop.
func (s *Shipper) Start() {
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

// ShouldShip returns true if the given level meets the minimum threshold.
func (s *Shipper) ShouldShip(level slog.Level) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return level >= s.minLevel
}

func (s *Shipper) shipLoop() {
	defer s.wg.Done()

	ticker := time.NewTicker(defaultBatchInterval)
	defer ticker.Stop()

	batch := make([]LogEntry, 0, defaultMaxBatchSize)

	for {
		select {
		case <-s.stopChan:
			// Drain remaining buffered entries
		drain:
			for {
				select {
				case entry := <-s.buffer:
					batch = append(batch, entry)
					if len(batch) >= defaultMaxBatchSize {
						s.shipBatch(batch)
						batch = batch[:0]
					}
				default:
					break drain
				}
			}
			if len(batch) > 0 {
				s.shipBatch(batch)
			}
			return

		case entry := <-s.buffer:
			batch = append(batch, entry)
			if len(batch) >= defaultMaxBatchSize {
				s.shipBatch(batch)
				batch = batch[:0]
			}

		case <-ticker.C:
			if len(batch) > 0 {
				s.shipBatch(batch)
				batch = batch[:0]
			}
		}
	}
}

const (
	shipRetryCount   = 2
	shipRetryBackoff = 1 * time.Second
)

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
	payload, err := json.Marshal(map[string]any{
		"logs": entries,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] marshal error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		return true
	}

	// Compress payload with gzip
	var compressed bytes.Buffer
	gw := gzip.NewWriter(&compressed)
	if _, err := gw.Write(payload); err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] gzip write error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		return true
	}
	if err := gw.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] gzip close error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		return true
	}
	compressedBytes := compressed.Bytes()

	// Resolved here, on every flush, rather than captured once at init: after a
	// backup-server-URL promotion (#2323) the next flush must go to the
	// promoted primary. The retry attempts below deliberately keep the URL this
	// flush started with — a promotion landing inside a single chunk's ~3s
	// retry window is picked up by the next batch (<=60s), which is what
	// matters; the bug being fixed was a URL frozen for the process lifetime
	// (#2463).
	baseURL, err := s.resolveServerURL()
	if err != nil {
		// Terminal for the whole batch: every remaining chunk would hit the
		// same wiring bug, so shipBatch must not burn a request per chunk.
		fmt.Fprintf(os.Stderr, "[log-shipper] %v — dropping %d entries\n", err, len(entries))
		s.droppedCount.Add(int64(len(entries)))
		return false
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/logs", baseURL, s.agentID)

	// nextSleepOverride, if non-zero, replaces the default fixed-jitter sleep
	// for the next retry. Set when the server sends Retry-After on 429/503.
	var nextSleepOverride time.Duration

	for attempt := 0; attempt <= shipRetryCount; attempt++ {
		if attempt > 0 {
			if nextSleepOverride > 0 {
				time.Sleep(nextSleepOverride)
				nextSleepOverride = 0
			} else {
				jitter := time.Duration(rand.Intn(int(shipRetryBackoff / 2)))
				time.Sleep(shipRetryBackoff + jitter)
			}
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(compressedBytes))
		if err != nil {
			cancel()
			fmt.Fprintf(os.Stderr, "[log-shipper] request build error: %v\n", err)
			s.droppedCount.Add(int64(len(entries)))
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
			return false
		}

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
			// 429/503: retryable, and may carry Retry-After.
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			if ra := parseRetryAfter(resp.Header, time.Now()); ra > 0 {
				nextSleepOverride = ra
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
