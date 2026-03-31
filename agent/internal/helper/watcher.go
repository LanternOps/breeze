package helper

import (
	"context"
	"time"
)

const (
	watcherBaseInterval = 30 * time.Second
	watcherBackoffCap   = 30 * time.Second
	watcherMaxRetries   = 10
)

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

	var failures int
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
		running := w.state.pid > 0 && w.mgr.isOurProcessFunc(w.state.pid, w.mgr.binaryPath)
		if running {
			w.mgr.mu.Unlock()
			failures = 0
			interval = watcherBaseInterval
			timer.Reset(interval)
			continue
		}

		err := w.mgr.ensureRunningSession(w.state)
		w.mgr.mu.Unlock()

		if err == nil {
			failures = 0
			interval = watcherBaseInterval
			timer.Reset(interval)
			log.Info("breeze assist restarted by watcher", "session", w.state.key)
			continue
		}

		failures++
		log.Warn("watcher failed to restart breeze assist",
			"session", w.state.key,
			"error", err.Error(),
			"failures", failures,
			"maxRetries", watcherMaxRetries,
		)

		if failures >= watcherMaxRetries {
			log.Error("watcher giving up after max retries, will retry on next heartbeat",
				"session", w.state.key,
				"failures", failures,
			)
			return
		}

		backoff := time.Duration(1<<uint(failures)) * time.Second
		if backoff > watcherBackoffCap {
			backoff = watcherBackoffCap
		}
		interval = backoff
		timer.Reset(interval)
	}
}

func (w *watcher) stop() {
	w.cancel()
	<-w.done
}
