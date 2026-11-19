package heartbeat

import (
	"context"
	"hash/fnv"
	"log/slog"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/hpwarrantyobserve"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/observability"
)

// HP warranty observe schedule (#5511 observe-first amendment §2). While the
// fresh hp_cmsl_mode is observe or act, the agent observes at most once per
// hpObserveInterval, plus once when the mode differs from the one it last
// observed under. It never runs:
//
//   - without a fresh mode (warranty_mode.go): the persisted legacy flag is
//     never enough;
//   - within the start-up delay, so a crash-looping agent emits nothing;
//   - on the heartbeat goroutine: one run at a time, in its own goroutine,
//     with a deadline, cancelled by stopHpWarrantyObserve at shutdown;
//   - off Windows.
//
// The record goes to the agent-log path with EmitShipAlways: component
// hp_warranty_observe, message vendor_observation, field observation. The API
// keeps it only if it parses against the shared contract.

const (
	hpObserveInterval = 24 * time.Hour
	hpObserveTimeout  = 2 * time.Minute
	// hpObserveMaxFirstDelay bounds hpObserveFirstDelay.
	hpObserveMaxFirstDelay = 3 * time.Minute
)

var hpObserveLog = logging.L(hpwarrantyobserve.Component)

// emitShipAlways is logging.EmitShipAlways at info; a seam for the record test.
var emitShipAlways = func(logger *slog.Logger, msg string, args ...any) {
	logging.EmitShipAlways(logger, slog.LevelInfo, msg, args...)
}

// hpObserveFirstDelay keeps the first observe off the start-up path and spreads
// a fleet that restarted together: one minute plus up to two, deterministic per
// agent.
func hpObserveFirstDelay(agentID string) time.Duration {
	h := fnv.New64a()
	_, _ = h.Write([]byte(agentID + ":hp-warranty-observe"))
	spread := hpObserveMaxFirstDelay - time.Minute
	return time.Minute + time.Duration(h.Sum64()%uint64(spread+1))
}

func emitHpWarrantyObservation(o *hpwarrantyobserve.Observation) {
	emitShipAlways(hpObserveLog, hpwarrantyobserve.Message, "observation", o)
}

func collectHpWarrantyObservation(ctx context.Context, mode string) *hpwarrantyobserve.Observation {
	return hpwarrantyobserve.Collect(ctx, hpwarrantyobserve.SystemHost(), mode)
}

// maybeStartHpWarrantyObserve starts an observe run when one is due. It is
// called for every heartbeat that carries warranty_settings and returns at
// once; the run happens in its own goroutine.
func (h *Heartbeat) maybeStartHpWarrantyObserve() {
	now := h.hpNow()
	s := &h.hpWarranty
	s.mu.Lock()
	collect, emit := s.collect, s.emit
	if collect == nil {
		if runtime.GOOS != "windows" {
			s.mu.Unlock()
			return
		}
		collect = collectHpWarrantyObservation
	}
	if emit == nil {
		emit = emitHpWarrantyObservation
	}
	if s.observeFirstAt.IsZero() {
		agentID := ""
		if h.config != nil {
			agentID = h.config.AgentID
		}
		s.observeFirstAt = now.Add(hpObserveFirstDelay(agentID))
	}
	mode, _ := s.authorityLocked(now)
	due := s.observeLastRun.IsZero() || now.Sub(s.observeLastRun) >= hpObserveInterval || mode != s.observeLastMode
	if s.observeStopping || (mode != hpCmslModeObserve && mode != hpCmslModeAct) || s.observeRunning ||
		now.Before(s.observeFirstAt) || !due {
		s.mu.Unlock()
		return
	}
	s.observeRunning, s.observeLastRun, s.observeLastMode = true, now, mode
	ctx, cancel := context.WithTimeout(context.Background(), hpObserveTimeout)
	s.observeCancel = cancel
	// Added to inventoryWg under s.mu: once stopHpWarrantyObserve has set
	// observeStopping, no run can be added while DrainAndWait waits.
	h.inventoryWg.Go(func() {
		defer func() {
			cancel()
			s.mu.Lock()
			s.observeRunning, s.observeCancel = false, nil
			s.mu.Unlock()
		}()
		defer observability.Recoverer("heartbeat.hp_warranty_observe")
		// A run that hit its deadline still emits: the timeout is a recorded
		// error code, which is evidence too.
		if o := collect(ctx, mode); o != nil {
			emit(o)
		}
	})
	s.mu.Unlock()
}

// stopHpWarrantyObserve is the shutdown hook: it cancels a run in flight and
// stops new ones. DrainAndWait and Stop call it before waiting.
func (h *Heartbeat) stopHpWarrantyObserve() {
	s := &h.hpWarranty
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observeStopping = true
	if s.observeCancel != nil {
		s.observeCancel()
	}
}
