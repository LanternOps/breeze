package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/collectors/timesync"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/observability"
)

// A 2xx alone does not establish acceptance. Keep this specific to time-status.
func validateTimeSyncResponse(body io.Reader) error {
	const maxResponseBytes = 64 * 1024
	raw, err := io.ReadAll(io.LimitReader(body, maxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxResponseBytes {
		return fmt.Errorf("time sync response exceeds 64 KiB")
	}
	var result struct {
		Accepted *bool  `json:"accepted"`
		Reason   string `json:"reason"`
	}
	if err = json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("invalid time sync response: %w", err)
	}
	if result.Accepted != nil && (*result.Accepted || result.Reason == "stale_sequence") {
		return nil
	}
	return errors.New("time sync response did not qualify for cursor commit")
}

type timeSyncSubmissionError struct{ status int }

func (e *timeSyncSubmissionError) Error() string {
	return fmt.Sprintf("inventory send failed for time sync: status %d", e.status)
}
func timeSyncHash(id string, last time.Time) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(id + ":time-sync:" + strconv.FormatInt(last.UnixNano(), 10)))
	return h.Sum64()
}
func timeSyncFirstDelay(id string) time.Duration {
	return 2*time.Minute + time.Duration(timeSyncHash(id, time.Time{})%uint64(3*time.Minute+1))
}
func timeSyncInterval(id string, last time.Time) time.Duration {
	const interval = 30 * time.Minute
	offset := int64(timeSyncHash(id, last)%20001) - 10000
	return interval + time.Duration(int64(interval)*offset/100000)
}

// timeSyncManager is the heartbeat's view of timesync.Manager; tests substitute a fake.
type timeSyncManager interface {
	Apply(any) (bool, error)
	Cycle(context.Context) error
	Command(context.Context, string, map[string]any) (any, error)
}

// timeSyncRuntime owns the one time-sync worker: collection, reconcile and upload
// all run through Manager.Cycle on this goroutine, cancelled by ctx.
type timeSyncRuntime struct {
	manager            timeSyncManager
	ctx                context.Context
	cancel             context.CancelFunc
	wake               chan struct{}
	started            bool // All scheduler fields below are protected by Heartbeat.mu.
	running            bool
	stopping           bool
	lastTimeSyncUpdate time.Time
	pending            any
	hasPending         bool
}

// timeSyncUpload carries the cycle's context to sendInventoryData while
// serialising exactly as the snapshot it wraps.
type timeSyncUpload struct {
	ctx  context.Context
	data any
}

func (p timeSyncUpload) MarshalJSON() ([]byte, error) { return json.Marshal(p.data) }

func (h *Heartbeat) initTimeSync() {
	sys := timesync.NewSystem()
	writer := timesync.NewWriter()
	if sys == nil || writer == nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	manager, err := timesync.NewManagement(config.GetDataDir(), sys, writer, func(ctx context.Context, p any) error {
		return h.sendInventoryData("time-status", timeSyncUpload{ctx: ctx, data: p}, "time sync")
	})
	if err != nil {
		log.Warn("time management state rejected; enforcement disabled until valid delivery", "error", err)
	}
	h.timeSync = &timeSyncRuntime{manager: manager, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1)}
}

// Caller holds h.mu.
func (h *Heartbeat) wakeTimeSyncLocked() {
	if h.timeSync == nil || h.timeSync.stopping {
		return
	}
	select {
	case h.timeSync.wake <- struct{}{}:
	default:
	}
}

// applyTimeSyncSettings queues a delivery for the worker; the heartbeat response
// path never blocks on management execution.
func (h *Heartbeat) applyTimeSyncSettings(raw any) {
	// Detach the payload from the heartbeat response before handing it to the worker.
	b, err := json.Marshal(raw)
	var detached any
	if err == nil {
		err = json.Unmarshal(b, &detached)
	}
	if err != nil {
		detached = nil // Parser records invalid_settings, without an OS write.
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.timeSync
	if r == nil || r.stopping {
		return
	}
	r.pending = detached
	r.hasPending = true
	h.wakeTimeSyncLocked()
}

// timeSyncTickLocked wakes the worker when the jittered interval has elapsed.
// Caller holds h.mu.
func (h *Heartbeat) timeSyncTickLocked(now time.Time) {
	r := h.timeSync
	if r == nil || !r.started || r.running || r.stopping || r.lastTimeSyncUpdate.IsZero() {
		return
	}
	if !dueForRun(now, r.lastTimeSyncUpdate, timeSyncInterval(h.config.AgentID, r.lastTimeSyncUpdate)) {
		return
	}
	h.wakeTimeSyncLocked()
}

func (h *Heartbeat) startTimeSync() {
	h.mu.Lock()
	r := h.timeSync
	if r == nil || r.started || r.stopping {
		h.mu.Unlock()
		return
	}
	r.started = true
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.timeSync")
		timer := time.NewTimer(timeSyncFirstDelay(h.config.AgentID))
		defer timer.Stop()
		first := timer.C
		for {
			scheduled := false
			select {
			case <-r.ctx.Done():
				return
			case <-first:
				first = nil
				scheduled = true
			case <-r.wake:
			}
			if r.ctx.Err() != nil {
				return
			}
			h.mu.Lock()
			pending, hasPending := r.pending, r.hasPending
			r.pending = nil
			r.hasPending = false
			h.mu.Unlock()
			if hasPending {
				changed, err := r.manager.Apply(pending)
				if err != nil {
					log.Warn("time sync settings rejected or not persisted", "error", err)
				}
				// Only a change forces an immediate cycle. Apply returns changed=false for a
				// repeated identical delivery, a repeated rejection, and a repeated
				// persistence failure; an error alone must never turn every heartbeat
				// into an upload (and a new enforcement audit row per minute).
				if !changed {
					h.mu.Lock()
					last := r.lastTimeSyncUpdate
					due := !last.IsZero() && dueForRun(time.Now(), last, timeSyncInterval(h.config.AgentID, last))
					h.mu.Unlock()
					if !scheduled && !due {
						continue
					}
				}
			}
			// An actual immediate cycle supersedes the delayed first collection.
			timer.Stop()
			first = nil
			h.mu.Lock()
			r.lastTimeSyncUpdate = time.Now()
			r.running = true
			h.mu.Unlock()
			ctx, cancel := context.WithTimeout(r.ctx, 60*time.Second)
			_, err := collectors.Guard("timesync.management", func() (bool, error) { return true, r.manager.Cycle(ctx) })
			cancel()
			h.mu.Lock()
			r.running = false
			h.mu.Unlock()
			if err != nil && r.ctx.Err() == nil {
				log.Warn("time sync cycle failed", "error", err)
			}
		}
	}()
}

func (h *Heartbeat) stopTimeSync() {
	h.mu.Lock()
	r := h.timeSync
	if r != nil {
		r.stopping = true
		r.cancel()
	}
	h.mu.Unlock()
}
