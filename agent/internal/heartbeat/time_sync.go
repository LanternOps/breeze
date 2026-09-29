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
	"github.com/breeze-rmm/agent/internal/observability"
)

type timeSyncCollector interface {
	Collect(context.Context) (*timesync.Snapshot, error)
	Commit(*timesync.Snapshot) error
}

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
func newTimeSyncCollector(dir string) timeSyncCollector {
	sys := timesync.NewSystem()
	if sys == nil {
		return nil
	}
	return timesync.New(dir, sys)
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

// Caller holds h.mu. Claim before dispatch so ticks cannot overlap.
func (h *Heartbeat) timeSyncDueLocked(now time.Time, first bool) bool {
	if h.timeSyncCol == nil || h.timeSyncStopping || h.timeSyncRunning {
		return false
	}
	if !h.timeSyncStarted && !first {
		return false
	}
	if !first && !dueForRun(now, h.lastTimeSyncUpdate, timeSyncInterval(h.config.AgentID, h.lastTimeSyncUpdate)) {
		return false
	}
	h.timeSyncStarted = true
	h.timeSyncRunning = true
	h.lastTimeSyncUpdate = now
	return true
}
func (h *Heartbeat) startTimeSync() {
	h.mu.Lock()
	if h.timeSyncCol == nil || h.timeSyncStopping || h.timeSyncArmed {
		h.mu.Unlock()
		return
	}
	h.timeSyncArmed = true
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.timeSyncStartup")
		timer := time.NewTimer(timeSyncFirstDelay(h.config.AgentID))
		defer timer.Stop()
		select {
		case <-h.timeSyncContext.Done():
			return
		case now := <-timer.C:
			h.mu.Lock()
			due := h.timeSyncDueLocked(now, true)
			h.mu.Unlock()
			if due {
				h.dispatchTimeSync()
			}
		}
	}()
}
func (h *Heartbeat) dispatchTimeSync() {
	h.mu.Lock()
	if h.timeSyncStopping {
		h.timeSyncRunning = false
		h.mu.Unlock()
		return
	}
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.timeSync")
		h.sendTimeSync()
	}()
}
func (h *Heartbeat) sendTimeSync() {
	defer func() { h.mu.Lock(); h.timeSyncRunning = false; h.mu.Unlock() }()
	snapshot, err := collectors.Guard("time-sync", func() (*timesync.Snapshot, error) { return h.timeSyncCol.Collect(h.timeSyncContext) })
	if err != nil {
		log.Warn("time sync collection failed", "error", err)
		return
	}
	if snapshot == nil {
		return
	}
	if err = h.sendInventoryData("time-status", snapshot, "time sync"); err != nil {
		log.Warn("time sync submission failed", "error", err)
		return
	}
	if err = h.timeSyncCol.Commit(snapshot); err != nil {
		log.Warn("time sync cursor commit failed", "error", err)
	}
}
func (h *Heartbeat) stopTimeSync() {
	h.mu.Lock()
	h.timeSyncStopping = true
	cancel := h.timeSyncCancel
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}
