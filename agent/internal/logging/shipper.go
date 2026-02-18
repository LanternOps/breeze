package logging

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultBatchInterval = 60 * time.Second
	defaultMaxBatchSize  = 500
	defaultBufferSize    = 1000
)

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
	serverURL    string
	agentID      string
	authToken    string
	agentVersion string
	httpClient   *http.Client
	buffer       chan LogEntry
	stopChan     chan struct{}
	wg           sync.WaitGroup
	stopOnce     sync.Once
	minLevel     slog.Level
	mu           sync.RWMutex // protects minLevel
	droppedCount atomic.Int64
}

// ShipperConfig configures the log shipper.
type ShipperConfig struct {
	ServerURL    string
	AgentID      string
	AuthToken    string
	AgentVersion string
	HTTPClient   *http.Client
	MinLevel     string // "debug", "info", "warn", "error"
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
	}
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

// Enqueue adds a log entry to the buffer. Non-blocking; drops if buffer is full.
func (s *Shipper) Enqueue(entry LogEntry) {
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

func (s *Shipper) shipBatch(entries []LogEntry) {
	payload, err := json.Marshal(map[string]any{
		"logs": entries,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] marshal error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		return
	}

	// Compress payload with gzip
	var compressed bytes.Buffer
	gw := gzip.NewWriter(&compressed)
	if _, err := gw.Write(payload); err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] gzip write error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		return
	}
	if err := gw.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "[log-shipper] gzip close error: %v\n", err)
		s.droppedCount.Add(int64(len(entries)))
		return
	}
	compressedBytes := compressed.Bytes()

	url := fmt.Sprintf("%s/api/v1/agents/%s/logs", s.serverURL, s.agentID)

	for attempt := 0; attempt <= shipRetryCount; attempt++ {
		if attempt > 0 {
			time.Sleep(shipRetryBackoff)
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(compressedBytes))
		if err != nil {
			cancel()
			fmt.Fprintf(os.Stderr, "[log-shipper] request build error: %v\n", err)
			s.droppedCount.Add(int64(len(entries)))
			return
		}

		req.Header.Set("Authorization", "Bearer "+s.authToken)
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
			return
		}

		if resp.StatusCode >= 500 {
			// Server error: retry if we have attempts left
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
			return
		}

		if resp.StatusCode >= 400 {
			// Client error (4xx): do not retry
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			cancel()
			fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d for %d entries: %s\n",
				resp.StatusCode, len(entries), string(body))
			s.droppedCount.Add(int64(len(entries)))
			return
		}

		// Success
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		cancel()
		return
	}
}

// DroppedLogCount returns the current count of dropped log entries and resets
// the counter to zero. This allows the heartbeat to report and clear the count
// atomically.
func (s *Shipper) DroppedLogCount() int64 {
	return s.droppedCount.Swap(0)
}
