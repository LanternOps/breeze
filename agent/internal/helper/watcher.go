package helper

import (
	"context"
	"errors"
	"time"
)

var (
	watcherBaseInterval = 30 * time.Second
	watcherBackoffCap   = 30 * time.Second
)

const watcherMaxRetries = 5

// watcherHealthyUptime is how long Assist must stay up after its last launch
// before a running tick clears the watcher's failure count (#10302). Resetting
// on any running tick let an Assist that lived a few seconds, or that the
// heartbeat relaunched just before a tick, restart forever without reaching
// watcherMaxRetries. Only a running tick at least this long after the launch
// clears it; earlier ticks (the short backoff after a crash) leave it alone.
const watcherHealthyUptime = 60 * time.Second

// watcherGiveUpRetry is how long a session whose watcher gave up stays given
// up before ensureRunningSession tries Assist again (#10183). A new Assist
// version retries at once. Matches helperAbandonRetryAfter: a few attempts per
// six hours bounds a permanent crash without needing an agent restart.
const watcherGiveUpRetry = 6 * time.Hour

type watcher struct {
	ctx    context.Context
	cancel context.CancelFunc
	mgr    *Manager
	state  *sessionState
	done   chan struct{}
}

func newSessionWatcher(parent context.Context, mgr *Manager, state *sessionState) *watcher {
	ctx, cancel := context.WithCancel(parent)
	return &watcher{
		ctx:    ctx,
		cancel: cancel,
		mgr:    mgr,
		state:  state,
		done:   make(chan struct{}),
	}
}

func (w *watcher) run() {
	defer close(w.done)

	interval := watcherBaseInterval
	timer := time.NewTimer(interval)
	defer timer.Stop()

	for {
		select {
		case <-w.ctx.Done():
			return
		case <-timer.C:
		}

		w.mgr.mu.Lock()
		w.state.refreshPID()
		running := isHelperRunningInSession(w.state.key, w.mgr.binaryPath) ||
			(w.state.spawnedPID > 0 && w.mgr.isOurProcessFunc(w.state.spawnedPID, w.mgr.binaryPath)) ||
			(w.state.pid > 0 && w.mgr.isOurProcessFunc(w.state.pid, w.mgr.binaryPath))
		if running {
			w.mgr.reapDuplicateHelpersLocked(w.state)
			w.mgr.trackAssistExitsLocked(w.state)
			// Not yet healthy: the failure count stands, so a crash after this
			// tick is still counted against it (#10302).
			w.mgr.noteAssistRunningLocked(w.state)
			w.mgr.mu.Unlock()
			interval = watcherBaseInterval
			timer.Reset(interval)
			continue
		}

		// Helper is not running — this counts as a failure whether the
		// spawn itself fails OR the previous spawn succeeded but the
		// helper crashed before the next check.
		w.state.crashFailures++
		failures := w.state.crashFailures
		exit, exitKnown := w.mgr.takeAssistExitLocked(w.state)
		if exitKnown {
			w.state.lastExit, w.state.lastExitKnown = exit, true
		}

		if failures > watcherMaxRetries {
			w.state.watcherGaveUp = true
			w.state.gaveUpAt = w.mgr.nowTime()
			w.state.gaveUpVersion = w.mgr.installedVersionLocked()
			w.state.crashFailures = 0 // a retry after the give-up starts a fresh count
			lastExit, lastKnown := w.state.lastExit, w.state.lastExitKnown
			w.mgr.mu.Unlock()
			log.Error("breeze assist keeps crashing, giving up",
				"session", w.state.key,
				"failures", failures,
				"exitCode", exitCodeField(exit, exitKnown),
				"lastExitCode", exitCodeField(lastExit, lastKnown),
				"retryAfter", watcherGiveUpRetry.String(),
			)
			return
		}

		err := w.mgr.ensureRunningSession(w.state)
		if errors.Is(err, ErrNotInstalled) || errors.Is(err, errWebView2Outdated) || errors.Is(err, errCrashLoop) {
			// #6872: not a crash. The failure counted above is dropped,
			// watcherGaveUp is left alone, and Apply starts a
			// fresh watcher once the server-offered install lands (or, for a
			// WebView2 refusal the gate already logged, once the runtime is
			// updated; for a crash loop given up earlier, at its retry).
			w.state.crashFailures = 0
			w.mgr.mu.Unlock()
			log.Debug("breeze assist cannot be started; watcher exiting", "session", w.state.key, "reason", err.Error())
			return
		}
		w.mgr.mu.Unlock()

		if err != nil {
			log.Warn("watcher failed to restart breeze assist",
				"session", w.state.key,
				"error", err.Error(),
				"failures", failures,
				"exitCode", exitCodeField(exit, exitKnown),
			)
		} else {
			// WARN, not INFO: the helper exited unexpectedly (there is no Exit
			// menu item), and only warn+ ships to the server by default — at
			// info a crash-looping helper was invisible fleet-wide (#8138).
			log.Warn("breeze assist restarted by watcher",
				"session", w.state.key,
				"failures", failures,
				"exitCode", exitCodeField(exit, exitKnown),
			)
		}

		backoff := time.Duration(1<<uint(failures)) * time.Second
		if backoff > watcherBackoffCap {
			backoff = watcherBackoffCap
		}
		interval = backoff
		timer.Reset(interval)
	}
}

// noteAssistRunningLocked records a tick that found Assist running. The
// failure count is cleared only once Assist has stayed up watcherHealthyUptime
// since its last launch by the agent (any ensureRunningSession caller). With
// no agent launch recorded (Assist was already running when the agent started)
// the run counts as healthy. Reports whether the run is healthy. Must be
// called with m.mu held.
func (m *Manager) noteAssistRunningLocked(state *sessionState) bool {
	if !state.lastSpawnAt.IsZero() && m.nowTime().Sub(state.lastSpawnAt) < watcherHealthyUptime {
		return false
	}
	state.crashFailures = 0
	return true
}

func (w *watcher) stop() {
	w.cancel()
	<-w.done
}
