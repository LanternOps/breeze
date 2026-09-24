package heartbeat

import (
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/hwhealth"
	"github.com/breeze-rmm/agent/internal/observability"
)

// hardwareInterval jitters the configured interval by up to ±10%, deterministically
// derived from the agent id, tier and last-run time, so a fleet of agents that all
// booted at the same moment does not hammer the API on the same synchronized tick.
func hardwareInterval(id string, tier hwhealth.Tier, last time.Time, interval time.Duration) time.Duration {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(id + ":" + string(tier) + ":" + strconv.FormatInt(last.UnixNano(), 10)))
	offset := int64(hash.Sum64()%20001) - 10000
	return interval + time.Duration(int64(interval)*offset/100000)
}

// hardwareTiersLocked decides which tiers (if any) are due for a hardware health
// collection cycle. Called under h.mu, including by the startup goroutine. A nil
// result means no dispatch should happen.
func (h *Heartbeat) hardwareTiersLocked(now time.Time, first bool) []hwhealth.Tier {
	if h.hwStopping || h.hwRunning || h.hwhealthCol == nil {
		return nil
	}
	if !h.hwStarted && !first {
		return nil
	}
	h.hwStarted = true
	if !h.hwConfig.Enabled {
		if h.hwDisabledQueued {
			return nil
		}
		h.hwDisabledQueued = true
		h.hwRunning = true
		return []hwhealth.Tier{}
	}
	tiers := []hwhealth.Tier{}
	if first || dueForRun(now, h.lastHwRaidRun, hardwareInterval(h.config.AgentID, hwhealth.TierRAID, h.lastHwRaidRun, h.hwConfig.PollInterval)) {
		tiers = append(tiers, hwhealth.TierRAID)
	}
	if first || dueForRun(now, h.lastHwDiskRun, hardwareInterval(h.config.AgentID, hwhealth.TierDisk, h.lastHwDiskRun, h.hwConfig.DiskHealthInterval)) {
		tiers = append(tiers, hwhealth.TierDisk)
	}
	if len(tiers) == 0 {
		return nil
	}
	for _, t := range tiers {
		if t == hwhealth.TierRAID {
			h.lastHwRaidRun = now
		} else {
			h.lastHwDiskRun = now
		}
	}
	h.hwRunning = true
	return tiers
}

// hardwareFirstRunDelay is how long after Start() the first hardware health
// collection cycle fires, keeping it off the critical boot path.
const hardwareFirstRunDelay = 60 * time.Second

// startHardwareHealth arms the delayed first hardware health collection cycle.
// It is tracked by inventoryWg and cancellable via hwContext so shutdown never
// leaves an untracked goroutine behind.
func (h *Heartbeat) startHardwareHealth() {
	h.mu.Lock()
	if h.hwhealthCol == nil || h.hwStopping {
		h.mu.Unlock()
		return
	}
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.hardwareHealthStartup")
		timer := time.NewTimer(hardwareFirstRunDelay)
		defer timer.Stop()
		select {
		case <-h.hwContext.Done():
			return
		case now := <-timer.C:
			h.mu.Lock()
			tiers := h.hardwareTiersLocked(now, true)
			h.mu.Unlock()
			if tiers != nil {
				h.dispatchHardwareHealth(tiers)
			}
		}
	}()
}

// dispatchHardwareHealth runs a hardware health collection+upload cycle in a
// tracked, cancellable goroutine.
func (h *Heartbeat) dispatchHardwareHealth(tiers []hwhealth.Tier) {
	h.mu.Lock()
	if h.hwStopping {
		h.hwRunning = false
		h.mu.Unlock()
		return
	}
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.hardwareHealth")
		h.sendHardwareHealth(tiers)
	}()
}

// hardwareSubmissionError carries the HTTP status from a hardware-health PUT so
// sendHardwareHealth can distinguish a permanent rejection (4xx, not 429) from a
// retryable transport/server failure without sendInventoryData losing its
// existing generic error message for every other endpoint.
type hardwareSubmissionError struct{ status int }

func (e *hardwareSubmissionError) Error() string {
	return fmt.Sprintf("inventory send failed for hardware health: status %d", e.status)
}

// sendHardwareHealth runs (or reuses a pending disabled-status) snapshot and
// uploads it. A disabled-status snapshot is retried on subsequent cycles until
// the server accepts it or permanently rejects it (409/413/422).
func (h *Heartbeat) sendHardwareHealth(tiers []hwhealth.Tier) {
	defer func() {
		h.mu.Lock()
		h.hwRunning = false
		h.mu.Unlock()
	}()
	h.mu.Lock()
	snapshot := h.hwDisabledSnapshot
	h.mu.Unlock()
	var e error
	if snapshot == nil {
		snapshot, e = h.hwhealthCol.Run(h.hwContext, tiers)
	}
	if e != nil {
		log.Warn("hardware health collection failed", "error", e)
		h.mu.Lock()
		h.hwDisabledQueued = false
		h.mu.Unlock()
		return
	}
	if snapshot == nil {
		h.mu.Lock()
		h.hwDisabledQueued = false
		h.mu.Unlock()
		return
	}
	snapshot.AgentVersion = h.agentVersion
	e = h.sendInventoryData("hardware-health", snapshot, "hardware health")
	if e != nil {
		log.Warn("hardware health submission failed", "error", e)
	}
	disabled := len(snapshot.TiersRun) == 1 && snapshot.TiersRun[0] == "disabled"
	if !disabled {
		return
	}
	var status *hardwareSubmissionError
	permanent := errors.As(e, &status) && status.status >= 400 && status.status < 500 && status.status != 429
	h.mu.Lock()
	defer h.mu.Unlock()
	h.hwDisabledSnapshot = nil
	if e != nil && !permanent && !h.hwConfig.Enabled && !h.hwStopping {
		h.hwDisabledSnapshot = snapshot
		h.hwDisabledQueued = false
	}
}

// stopHardwareHealth cancels any in-flight hardware health collection/upload and
// prevents new cycles from being dispatched. It must run before inventoryWg.Wait
// so a cycle blocked in collection or upload actually unblocks during drain.
func (h *Heartbeat) stopHardwareHealth() {
	h.mu.Lock()
	h.hwStopping = true
	cancel := h.hwCancel
	h.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// applyHardwareMonitoringConfig parses a hardware_monitoring_settings /
// hardwareMonitoringSettings config update. An invalid payload is ignored
// entirely, leaving the previous valid config in place.
func (h *Heartbeat) applyHardwareMonitoringConfig(raw any) {
	m, ok := raw.(map[string]any)
	if !ok {
		log.Warn("ignoring invalid hardware_monitoring_settings object")
		return
	}
	enabled, ok := m["enabled"].(bool)
	if !ok {
		log.Warn("ignoring hardware monitoring config without enabled")
		return
	}
	integer := func(snake, camel string) (int, bool) {
		v, exists := m[snake]
		if !exists {
			v = m[camel]
		}
		switch n := v.(type) {
		case int:
			return n, true
		case float64:
			if !math.IsNaN(n) && !math.IsInf(n, 0) && n == math.Trunc(n) && n >= 0 && n <= 1440 {
				return int(n), true
			}
		}
		return 0, false
	}
	raid, rok := integer("poll_interval_minutes", "pollIntervalMinutes")
	disk, dok := integer("disk_health_interval_minutes", "diskHealthIntervalMinutes")
	if !rok || !dok || raid < 5 || raid > 60 || disk < 15 || disk > 1440 {
		log.Warn("ignoring invalid hardware monitoring intervals")
		return
	}
	cfg := hwhealth.Config{Enabled: enabled, PollInterval: time.Duration(raid) * time.Minute, DiskHealthInterval: time.Duration(disk) * time.Minute}
	h.mu.Lock()
	defer h.mu.Unlock()
	if cfg == h.hwConfig {
		return
	}
	wasEnabled := h.hwConfig.Enabled
	h.hwConfig = cfg
	h.hwDisabledQueued = false
	h.hwDisabledSnapshot = nil
	if enabled && !wasEnabled {
		h.lastHwRaidRun = time.Time{}
		h.lastHwDiskRun = time.Time{}
	}
	if h.hwhealthCol != nil {
		h.hwhealthCol.ApplyConfig(cfg)
	}
}
