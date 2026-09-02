package userhelper

import (
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"
)

// SupervisedClient is the subset of *Client that the reconnect supervisor
// drives. It exists so the loop can be exercised without a real IPC socket.
type SupervisedClient interface {
	// Run connects, authenticates and blocks until the connection drops or
	// Stop is called.
	Run() error
	// Stop asks a running client to shut down.
	Stop()
	// AuthenticatedAt reports when the client last completed auth on this
	// Run, or the zero time if it never did.
	AuthenticatedAt() time.Time
}

// Compile-time proof that the real client satisfies the seam.
var _ SupervisedClient = (*Client)(nil)

// StopReason explains why the supervisor's loop returned.
type StopReason string

const (
	// StopShutdown means the loop ended because shutdown was requested (or
	// the client returned cleanly). The caller should exit successfully.
	StopShutdown StopReason = "shutdown"
	// StopFatal means the client hit an error that retrying cannot fix.
	// The caller decides the process exit code from Err.
	StopFatal StopReason = "fatal"
)

// SupervisorResult is the outcome of a supervision loop.
type SupervisorResult struct {
	Reason StopReason
	// Err is the error that ended the loop. Always set for StopFatal; set
	// for StopShutdown only when shutdown interrupted an errored attempt.
	Err error
}

// ReconnectPolicy tunes the supervisor's backoff and log-rate behaviour.
//
// The two shipped tunings differ deliberately:
//
//   - The Windows/Linux user-helper uses a conservative 30s floor because most
//     of its disconnects in production are permanent identity problems
//     (binary path mismatch, SID lookup failure), not socket hiccups (#387).
//   - The macOS desktop helper uses a 1s floor because its dominant failure is
//     a transient IPC gap (agent restart or sleep/wake) that clears in
//     seconds, and every second spent disconnected is a second of greyed-out
//     Desktop Access in the UI (#4194).
type ReconnectPolicy struct {
	// MinBackoff is the first wait after a failed attempt, and the value the
	// backoff resets to after a stable connection.
	MinBackoff time.Duration
	// MaxBackoff caps the exponential growth.
	MaxBackoff time.Duration
	// StableThreshold is how long a connection must stay authenticated
	// before a later failure is allowed to reset the backoff. Resetting on
	// mere iteration duration lets a storm restart from the floor every time
	// a server-side rate-limit window expires (#387).
	StableThreshold time.Duration
	// WarnLimit and WarnWindow rate-limit the repeated "disconnected" warning.
	WarnLimit  int
	WarnWindow time.Duration
	// StuckThreshold is how long a supervised run may go without EVER
	// completing auth before the supervisor escalates to ERROR.
	//
	// This exists because the reconnect loop trades away a signal. Before
	// #4194 a permanently-broken helper — a socket path that will never
	// exist, an account with no passwd entry, a broker that keeps
	// non-permanently rejecting — died on every attempt, and the
	// launchd/systemd crash-loop was itself the alarm. A resident process
	// retrying quietly forever looks healthy to every service manager, so
	// something has to say "this is wedged, not riding out a blip".
	StuckThreshold time.Duration
}

const (
	defaultMinBackoff      = 30 * time.Second
	defaultMaxBackoff      = 5 * time.Minute
	defaultStableThreshold = 60 * time.Second
	defaultWarnLimit       = 3
	defaultWarnWindow      = 5 * time.Minute

	// defaultStuckThreshold is deliberately generous. A helper can legitimately
	// spend a while unable to connect at boot or during an agent upgrade, and
	// crying wolf there would train people to ignore the line that matters.
	defaultStuckThreshold = 15 * time.Minute
)

// stuckLogInterval rate-limits the "wedged" ERROR so a helper that stays
// broken for days does not flood the shipped logs.
const stuckLogInterval = 30 * time.Minute

// normalize fills in zero fields with safe defaults and repairs an inverted
// backoff range, so a partially-specified policy can never produce a backoff
// that shrinks on every attempt or a zero-length sleep that spins hot.
func (p ReconnectPolicy) normalize() ReconnectPolicy {
	if p.MinBackoff <= 0 {
		p.MinBackoff = defaultMinBackoff
	}
	if p.MaxBackoff <= 0 {
		p.MaxBackoff = defaultMaxBackoff
	}
	if p.MaxBackoff < p.MinBackoff {
		p.MaxBackoff = p.MinBackoff
	}
	if p.StableThreshold <= 0 {
		p.StableThreshold = defaultStableThreshold
	}
	if p.WarnLimit <= 0 {
		p.WarnLimit = defaultWarnLimit
	}
	if p.WarnWindow <= 0 {
		p.WarnWindow = defaultWarnWindow
	}
	if p.StuckThreshold <= 0 {
		p.StuckThreshold = defaultStuckThreshold
	}
	return p
}

// Supervisor keeps a helper's IPC connection up: it runs a client, and when
// the client returns a retryable error it constructs a *new* client and tries
// again after an exponential, jittered backoff.
//
// A new client per attempt is mandatory, not stylistic: Client.stopChan is
// created once in NewWithOptions and closed by Stop, so a Client is
// single-use.
//
// The supervisor never calls os.Exit. It classifies the outcome and returns;
// exit-code policy belongs to the caller, because it differs per platform
// (launchd KeepAlive vs. the Windows lifecycle manager).
type Supervisor struct {
	// Name identifies the helper in log lines (e.g. "desktop helper").
	Name string
	// Policy tunes backoff. The zero value is normalized to the
	// conservative user-helper defaults.
	Policy ReconnectPolicy
	// NewClient constructs a fresh client for each attempt. Required.
	NewClient func() SupervisedClient
	// IsFatal classifies an error from Run as unretryable. Defaults to
	// IsFatalHelperError.
	IsFatal func(error) bool
	// Log receives the reconnect diagnostics. Defaults to the package logger.
	Log *slog.Logger

	// Test seams. Nil in production; see the default* helpers below.
	now    func() time.Time
	jitter func(n int64) int64
	sleep  func(d time.Duration, done <-chan struct{}) bool
}

func (s *Supervisor) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return log
}

func (s *Supervisor) nowFn() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

func (s *Supervisor) jitterFn() func(int64) int64 {
	if s.jitter != nil {
		return s.jitter
	}
	return rand.Int64N
}

func (s *Supervisor) sleepFn(d time.Duration, done <-chan struct{}) bool {
	if s.sleep != nil {
		return s.sleep(d, done)
	}
	return WaitOrShutdown(d, done)
}

func (s *Supervisor) isFatal(err error) bool {
	if s.IsFatal != nil {
		return s.IsFatal(err)
	}
	return IsFatalHelperError(err)
}

// Run supervises the helper until shutdown is signalled on done or an
// unretryable error occurs. It blocks.
func (s *Supervisor) Run(done <-chan struct{}) SupervisorResult {
	policy := s.Policy.normalize()
	lg := s.logger()
	limiter := newWarnLimiter(policy.WarnLimit, policy.WarnWindow)
	backoff := policy.MinBackoff

	startedAt := s.nowFn()
	everAuthenticated := false
	var lastStuckLog time.Time
	attempts := 0

	for {
		select {
		case <-done:
			return SupervisorResult{Reason: StopShutdown}
		default:
		}

		client := s.NewClient()
		attempts++

		// Relay shutdown to the running client. clientDone lets this
		// goroutine exit when Run returns on its own, so the loop does not
		// leak one goroutine per reconnect attempt.
		clientDone := make(chan struct{})
		go func() {
			select {
			case <-done:
				lg.Info("shutting down helper", "name", s.Name)
				client.Stop()
			case <-clientDone:
			}
		}()

		err := client.Run()
		close(clientDone)

		// Read the auth timestamp before the client goes out of scope. A
		// zero value means this attempt never completed auth.
		authAt := client.AuthenticatedAt()

		if err == nil {
			return SupervisorResult{Reason: StopShutdown}
		}

		// Shutdown raced with the error — do not reconnect into a teardown.
		select {
		case <-done:
			return SupervisorResult{Reason: StopShutdown, Err: err}
		default:
		}

		if s.isFatal(err) {
			return SupervisorResult{Reason: StopFatal, Err: err}
		}

		if !authAt.IsZero() {
			everAuthenticated = true
			if s.nowFn().Sub(authAt) > policy.StableThreshold {
				backoff = policy.MinBackoff
				limiter.reset()
			}
		}

		wait := backoffWithJitter(backoff, s.jitterFn())

		errMsg := err.Error()

		// A helper that has never once connected is wedged, not riding out a
		// blip, and the warn limiter has long since demoted the evidence to a
		// periodic INFO. Say so at ERROR so it reaches the shipped
		// diagnostics — nothing else will, now that the process no longer
		// dies and shows up as a crash-loop to launchd/systemd (#4194).
		if !everAuthenticated {
			if elapsed := s.nowFn().Sub(startedAt); elapsed >= policy.StuckThreshold {
				now := s.nowFn()
				if lastStuckLog.IsZero() || now.Sub(lastStuckLog) >= stuckLogInterval {
					lastStuckLog = now
					lg.Error("helper has never connected since start; treating as wedged, not a transient blip",
						"name", s.Name,
						"error", errMsg,
						"attempts", attempts,
						"stuckFor", elapsed.Round(time.Second).String())
				}
			}
		}

		if emit, suppressed := limiter.shouldLog(errMsg, s.nowFn()); emit {
			lg.Warn("helper disconnected, reconnecting",
				"name", s.Name, "error", errMsg, "backoff", wait.String())
		} else if suppressed > 0 {
			lg.Info("helper still disconnected, suppressing further warnings",
				"name", s.Name,
				"error", errMsg,
				"suppressed_count", suppressed,
				"backoff", wait.String())
		}

		if !s.sleepFn(wait, done) {
			lg.Info("helper stopped during reconnect backoff", "name", s.Name)
			return SupervisorResult{Reason: StopShutdown, Err: err}
		}
		backoff = nextBackoff(backoff, policy.MaxBackoff)
	}
}

// IsFatalHelperError reports whether an error from Client.Run is permanent,
// meaning reconnecting cannot fix it. Everything else — dial failures, EOF on
// a recreated socket, keepalive timeouts — is retryable.
func IsFatalHelperError(err error) bool {
	if err == nil {
		return false
	}
	var permErr *PermanentRejectError
	if errors.As(err, &permErr) {
		return true
	}
	return errors.Is(err, ErrSIDLookupFailed)
}

// nextBackoff doubles cur, clamped to max.
func nextBackoff(cur, max time.Duration) time.Duration {
	if cur >= max {
		return max
	}
	return min(cur*2, max)
}

// backoffWithJitter spreads the wait over [backoff, backoff+backoff/2] so
// concurrent helpers (multiple Aqua sessions, RDS hosts) do not synchronise
// their reconnect attempts into a thundering herd.
func backoffWithJitter(backoff time.Duration, jitter func(int64) int64) time.Duration {
	return backoff + time.Duration(jitter(int64(backoff/2)+1))
}

// WaitOrShutdown sleeps for d, returning false if shutdown was signalled
// first. A backoff must always be interruptible: a helper that ignores
// SIGTERM for five minutes stalls an agent upgrade or an uninstall.
func WaitOrShutdown(d time.Duration, done <-chan struct{}) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-done:
		return false
	}
}

// warnLimiter rate-limits a repeating warning message. After `limit`
// emissions of the same message within `window`, further WARN emissions are
// suppressed; an INFO "still disconnected" summary is emitted every
// infoInterval so ops can confirm the helper is still thrashing (not silently
// stuck). Call reset() when the condition clears (e.g. connection has been
// stably authenticated).
type warnLimiter struct {
	mu                  sync.Mutex
	limit               int
	window              time.Duration
	lastMsg             string
	firstSeenAt         time.Time
	count               int // total emissions (incl. suppressed) in this window
	warnsEmitted        int // warn-level emissions in this window
	suppressed          int // warnings suppressed since last info emission
	suppressedSinceInfo int // count since last INFO — reset on each INFO emit
	lastInfoEmit        time.Time
}

// infoInterval is the sub-window cadence for INFO summaries emitted while
// WARN emissions are suppressed. Short enough to confirm liveliness during
// log tail, long enough to avoid flooding.
const infoInterval = 60 * time.Second

func newWarnLimiter(limit int, window time.Duration) *warnLimiter {
	return &warnLimiter{limit: limit, window: window}
}

// shouldLog returns (emitWarn, suppressedCount). If emitWarn is true, the
// caller should log a WARN. Otherwise, if suppressedCount > 0, the caller
// should log a single INFO "still disconnected" line with that count.
// now is passed in by the caller (typically time.Now()) so that tests can
// control the clock without sleeping.
func (h *warnLimiter) shouldLog(msg string, now time.Time) (bool, int) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if msg != h.lastMsg || now.Sub(h.firstSeenAt) > h.window {
		// New message or window rolled over — reset counters.
		h.lastMsg = msg
		h.firstSeenAt = now
		h.count = 1
		h.warnsEmitted = 1
		h.suppressed = 0
		h.suppressedSinceInfo = 0
		h.lastInfoEmit = time.Time{}
		return true, 0
	}

	h.count++
	if h.warnsEmitted < h.limit {
		h.warnsEmitted++
		return true, 0
	}

	// Over the warn budget — suppress and maybe emit an INFO summary.
	// Summaries fire every infoInterval (60s) so ops can see the helper is
	// still thrashing; each summary reports only the count since the last INFO.
	h.suppressed++
	h.suppressedSinceInfo++
	if h.lastInfoEmit.IsZero() || now.Sub(h.lastInfoEmit) >= infoInterval {
		count := h.suppressedSinceInfo
		h.suppressedSinceInfo = 0
		h.lastInfoEmit = now
		return false, count
	}
	return false, 0
}

// reset clears limiter state so the next message starts a fresh window.
// Call after a helper has been stably connected — the next disconnect is
// a new event and deserves a full WARN.
func (h *warnLimiter) reset() {
	h.mu.Lock()
	h.lastMsg = ""
	h.firstSeenAt = time.Time{}
	h.count = 0
	h.warnsEmitted = 0
	h.suppressed = 0
	h.suppressedSinceInfo = 0
	h.lastInfoEmit = time.Time{}
	h.mu.Unlock()
}
