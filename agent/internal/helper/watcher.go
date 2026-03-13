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

// watcher monitors Breeze Assist liveness and restarts it on crash.
// It uses an adaptive polling interval: 30s when healthy, exponential
// backoff (2s → 30s cap) on repeated failures. Stops after maxRetries
// consecutive failures; the next heartbeat Apply() resets it.
type watcher struct {
	ctx    context.Context
	cancel context.CancelFunc
	mgr    *Manager
	done   chan struct{}
}

func newWatcher(parent context.Context, mgr *Manager) *watcher {
	ctx, cancel := context.WithCancel(parent)
	return &watcher{
		ctx:    ctx,
		cancel: cancel,
		mgr:    mgr,
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
		running := isHelperRunning()
		if running {
			w.mgr.mu.Unlock()
			failures = 0
			interval = watcherBaseInterval
			timer.Reset(interval)
			continue
		}

		err := w.mgr.ensureRunning()
		w.mgr.mu.Unlock()

		if err == nil {
			failures = 0
			interval = watcherBaseInterval
			timer.Reset(interval)
			log.Info("breeze assist restarted by watcher")
			continue
		}

		failures++
		log.Warn("watcher failed to restart breeze assist",
			"error", err.Error(),
			"failures", failures,
			"maxRetries", watcherMaxRetries,
		)

		if failures >= watcherMaxRetries {
			log.Error("watcher giving up after max retries, will retry on next heartbeat",
				"failures", failures,
			)
			return
		}

		// Exponential backoff: 2s, 4s, 8s, 16s, 30s, 30s, ...
		backoff := time.Duration(1<<uint(failures)) * time.Second
		if backoff > watcherBackoffCap {
			backoff = watcherBackoffCap
		}
		interval = backoff
		timer.Reset(interval)
	}
}

// stop is available for testing and direct use outside the Manager mutex pattern.
// Manager.stopWatcher() handles cancel + join with mutex release/reacquire.
func (w *watcher) stop() {
	w.cancel()
	<-w.done
}
