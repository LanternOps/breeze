package heartbeat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

const reliabilityStateFileName = "reliability_state.json"

// reliabilityPostInterval is the minimum spacing between reliability posts —
// metrics are meant to go out at most once per this window.
const reliabilityPostInterval = 24 * time.Hour

// reliabilityPostDue reports whether a reliability post is due given the last
// time one was sent and the current time. A zero `last` (never sent, or an
// unreadable/corrupt persisted state) is always due, so the first post fails
// open. Extracted as a pure function so the gate — the heart of #1906 — is
// unit-testable without driving the long-running heartbeat loop.
func reliabilityPostDue(last, now time.Time) bool {
	return now.Sub(last) > reliabilityPostInterval
}

// reliabilityState persists the last time reliability metrics were posted so
// the 24h send cadence survives agent restarts. Without it, every restart
// (crash, auto-update, machine reboot — frequent on POS/checkout boxes) reset
// the in-memory timer to its zero value and immediately re-posted an
// overlapping event-log window, creating duplicate device_reliability_history
// rows and inflating failure counts (issue #1906).
type reliabilityState struct {
	LastUpdate time.Time `json:"lastUpdate"`
}

// reliabilityStatePath mirrors ipStatePath: prefer the per-user ~/.breeze dir,
// fall back to the configured data dir, then a temp dir as a last resort.
func (h *Heartbeat) reliabilityStatePath() string {
	if homeDir, err := os.UserHomeDir(); err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, ".breeze", reliabilityStateFileName)
	}

	dataDir := strings.TrimSpace(config.GetDataDir())
	if dataDir == "" {
		tmpPath := filepath.Join(os.TempDir(), "breeze", reliabilityStateFileName)
		log.Warn("reliability state directory unavailable, falling back to temp dir", "path", tmpPath)
		return tmpPath
	}
	return filepath.Join(dataDir, reliabilityStateFileName)
}

// loadLastReliabilityUpdate returns the persisted last-send timestamp, or the
// zero time when no state exists yet or it can't be read/decoded. A zero time
// is treated as "never sent" by the caller, so a fresh or unreadable state
// lets the first post go out (fail-open — at worst one extra post, which
// #1905's aggregation dedup absorbs).
func (h *Heartbeat) loadLastReliabilityUpdate() time.Time {
	path := h.reliabilityStatePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("failed to read reliability state", "path", path, "error", err.Error())
		}
		return time.Time{}
	}

	var st reliabilityState
	if err := json.Unmarshal(raw, &st); err != nil {
		log.Warn("failed to decode reliability state", "path", path, "error", err.Error())
		return time.Time{}
	}
	return st.LastUpdate
}

// saveLastReliabilityUpdate atomically persists the last-send timestamp.
func (h *Heartbeat) saveLastReliabilityUpdate(t time.Time) error {
	path := h.reliabilityStatePath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create reliability state directory %s: %w", dir, err)
	}

	payload, err := json.Marshal(reliabilityState{LastUpdate: t})
	if err != nil {
		return fmt.Errorf("failed to encode reliability state: %w", err)
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0600); err != nil {
		return fmt.Errorf("failed to write reliability state temp file %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("failed to persist reliability state %s: %w", path, err)
	}
	return nil
}

// persistReliabilitySent records on disk that a reliability post succeeded at
// time t, so the 24h cadence survives restarts (#1906). Called only from the
// success path of sendReliabilityMetrics: a failed upload leaves the persisted
// timestamp stale so a restart retries, while the in-memory timer (advanced at
// dispatch under h.mu) still prevents duplicate sends within this process. A
// persist failure is logged but non-fatal.
func (h *Heartbeat) persistReliabilitySent(t time.Time) {
	if err := h.saveLastReliabilityUpdate(t); err != nil {
		log.Warn("failed to persist reliability send timestamp", "error", err.Error())
	}
}
