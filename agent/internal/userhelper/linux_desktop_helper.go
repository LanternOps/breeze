package userhelper

// Run mode of the Linux per-session desktop helper (#12117). Root starts it
// on demand with a single-use spawn ticket, so unlike every other helper it
// never reconnects: once its one connection ends, the process ends, and root
// starts a fresh helper with a fresh ticket when it needs one. Untagged so
// the lifecycle is tested on every host.

import (
	"errors"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// LinuxDesktopHelperIdleExit is how long the Linux desktop helper stays up
// with no live desktop session before it exits on its own.
const LinuxDesktopHelperIdleExit = 5 * time.Minute

// Bounds on how often the idle check looks at the session manager.
const (
	minLinuxDesktopIdlePoll = 10 * time.Millisecond
	maxLinuxDesktopIdlePoll = 5 * time.Second
)

// Process exit codes of the Linux desktop helper.
const (
	// LinuxDesktopExitOK: idle exit, shutdown, or the broker ended an
	// authenticated connection.
	LinuxDesktopExitOK = 0
	// LinuxDesktopExitFailed: the helper never authenticated (broker
	// unreachable, broker failed verification, or a transient rejection).
	LinuxDesktopExitFailed = 1
	// LinuxDesktopExitRejected: the broker permanently rejected the helper.
	LinuxDesktopExitRejected = 2
)

// NewLinuxDesktopClient builds the client for a Linux desktop helper: user
// role, desktop-helper binary kind, the socket root named in env, and env's
// logind session and spawn ticket for the auth request.
func NewLinuxDesktopClient(env LinuxDesktopEnv, desktopContext string) *Client {
	c := NewWithOptions(env.SocketPath, ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, desktopContext)
	c.logindSessionID = env.LogindSessionID
	c.spawnTicket = env.SpawnTicket
	return c
}

type linuxDesktopRunConfig struct {
	idleExit          time.Duration
	poll              time.Duration
	now               func() time.Time
	hasActiveSessions func() bool
}

// RunLinuxDesktopHelper runs c for exactly one connection. It returns when
// the connection ends, when done closes, or after idleExit with no live
// desktop session, and it never redials. Any desktop session is ended before
// it returns. The result is the process exit code and the error that ended
// the connection (nil when the helper stopped itself).
func RunLinuxDesktopHelper(c *Client, done <-chan struct{}, idleExit time.Duration) (int, error) {
	return runLinuxDesktopHelper(c, done, linuxDesktopRunConfig{
		idleExit:          idleExit,
		poll:              linuxDesktopIdlePoll(idleExit),
		now:               time.Now,
		hasActiveSessions: c.desktopMgr.hasActiveSessions,
	})
}

func linuxDesktopIdlePoll(idleExit time.Duration) time.Duration {
	return min(max(idleExit/10, minLinuxDesktopIdlePoll), maxLinuxDesktopIdlePoll)
}

func runLinuxDesktopHelper(c *Client, done <-chan struct{}, cfg linuxDesktopRunConfig) (int, error) {
	var stoppedSelf atomic.Bool
	runReturned := make(chan struct{})
	watcherDone := make(chan struct{})
	go func() {
		defer close(watcherDone)
		ticker := time.NewTicker(cfg.poll)
		defer ticker.Stop()
		idleSince := cfg.now()
		for {
			select {
			case <-runReturned:
				return
			case <-done:
				stoppedSelf.Store(true)
				c.Stop()
				return
			case <-ticker.C:
				if cfg.hasActiveSessions() {
					idleSince = cfg.now()
					continue
				}
				if cfg.now().Sub(idleSince) >= cfg.idleExit {
					log.Info("linux desktop helper has had no desktop session; exiting",
						"idleExit", cfg.idleExit.String())
					stoppedSelf.Store(true)
					c.Stop()
					return
				}
			}
		}
	}()

	err := c.Run()
	close(runReturned)
	<-watcherDone
	// Run already ends its sessions on return; Stop makes that hold on every
	// path, including a connect that failed before Run's own cleanup was set.
	c.Stop()

	if stoppedSelf.Load() {
		return LinuxDesktopExitOK, nil
	}
	return linuxDesktopExitCode(err, !c.AuthenticatedAt().IsZero()), err
}

// linuxDesktopExitCode maps how the one connection ended to an exit code.
func linuxDesktopExitCode(err error, authenticated bool) int {
	var perm *PermanentRejectError
	switch {
	case errors.As(err, &perm):
		return LinuxDesktopExitRejected
	case authenticated || err == nil:
		// The ticket is spent, so a disconnect after admission is final and
		// not a failure: root spawns a fresh helper when it needs one.
		return LinuxDesktopExitOK
	default:
		return LinuxDesktopExitFailed
	}
}
