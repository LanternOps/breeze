package userhelper

import (
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// Asking the service to replace this process (#12624).
//
// A Windows SYSTEM helper in which a DXGI duplication outlived its session
// runs every later session on GDI until the process ends. The session that
// finds out keeps its GDI video: replacing the helper under it would cost the
// viewer more than the 15s it waits for an answer. Once nothing is running the
// helper asks the service to replace it. The service decides (it owns the
// budget) and asks back with helper_recycle_prepare; only this process knows
// what it is hosting, so it has the last word.

// Seams for tests.
var (
	captureProcessPoisoned    = desktop.CaptureProcessPoisoned
	sessionTeardownInProgress = desktop.SessionTeardownInProgress
)

const (
	// recycleSettle is how long the helper must stay idle before it asks: a
	// session that just ended reports its end on its own goroutine.
	recycleSettle = time.Second
	recyclePoll   = 10 * time.Second
	recycleMinGap = 30 * time.Second
	recycleMaxGap = 30 * time.Minute
)

// recycleIntakeHoldLimit bounds how long the helper takes no work after
// answering Ready. The service ends it within milliseconds of that answer; if
// it declines instead (a desktop start arrived, the answer came too late, the
// kill failed) the helper cannot be told, and a start queued behind the hold
// must still be answered well inside the viewer's 15s. A var for tests.
var recycleIntakeHoldLimit = 3 * time.Second

// helperRecycleSupported limits the request to the one helper that captures
// with DXGI and that the service's lifecycle manager can replace at once.
func helperRecycleSupported(goos string, role ipc.HelperRole) bool {
	return goos == "windows" && role == ipc.HelperRoleSystem
}

type recycleWatchConfig struct {
	poisoned func() string
	busy     func() string
	send     func(reason string) error
	changed  <-chan struct{}
	settle   time.Duration
	poll     time.Duration
	minGap   time.Duration
	maxGap   time.Duration
}

func (c *Client) recycleWatchConfig() recycleWatchConfig {
	return recycleWatchConfig{
		poisoned: captureProcessPoisoned,
		busy:     c.selfRestartBusy,
		send: func(reason string) error {
			return c.conn.SendTyped("helper-recycle", ipc.TypeHelperRecycleRequest, ipc.HelperRecycleRequest{Reason: reason})
		},
		changed: desktop.CaptureProcessChanged(),
		settle:  recycleSettle,
		poll:    recyclePoll,
		minGap:  recycleMinGap,
		maxGap:  recycleMaxGap,
	}
}

// nextRecycleGap doubles the wait before asking again, up to max.
func nextRecycleGap(gap, max time.Duration) time.Duration { return min(gap*2, max) }

// runRecycleWatch asks to be replaced while the process is poisoned and idle,
// until done closes (the end of one connection). It repeats with a growing gap:
// the service may refuse, or be a version that does not know the request.
func runRecycleWatch(done <-chan struct{}, cfg recycleWatchConfig) {
	ticker := time.NewTicker(cfg.poll)
	defer ticker.Stop()
	gap := cfg.minGap
	var notBefore time.Time
	for {
		select {
		case <-done:
			return
		case <-cfg.changed:
		case <-ticker.C:
		}
		if cfg.poisoned() == "" {
			gap, notBefore = cfg.minGap, time.Time{}
			continue
		}
		if time.Now().Before(notBefore) || cfg.busy() != "" {
			continue
		}
		if !WaitOrShutdown(cfg.settle, done) {
			return
		}
		reason := cfg.poisoned()
		if reason == "" || cfg.busy() != "" {
			continue
		}
		log.Info("this helper can no longer use DXGI capture; asking the service to replace it", "reason", reason)
		if err := cfg.send(reason); err != nil {
			log.Warn("failed to ask for a helper replacement", "error", err.Error())
		}
		notBefore = time.Now().Add(gap)
		gap = nextRecycleGap(gap, cfg.maxGap)
	}
}

// handleRecyclePrepare answers the service's helper_recycle_prepare. On Ready
// the command loop takes nothing more until the service ends this process, or
// recycleIntakeHoldLimit passes. It runs on its own goroutine: the hold
// waits out the message being dispatched now.
func (c *Client) handleRecyclePrepare(env *ipc.Envelope) {
	res := ipc.HelperRecyclePrepareResult{}
	if captureProcessPoisoned() == "" {
		res.Busy = "capture has recovered"
	} else if busy := c.holdIntakeFor(recycleIntakeHoldLimit, "a replacement"); busy != "" {
		res.Busy = busy
	} else {
		res.Ready = true
	}
	if err := c.conn.SendTyped(env.ID, ipc.TypeHelperRecyclePrepare, res); err != nil {
		log.Warn("failed to answer helper_recycle_prepare", "error", err.Error())
	}
}
