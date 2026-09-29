package storagesession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

// sessionControl is the control-plane side shared by read and write
// providers: the validated descriptor, the agent credential, the lease and
// its renewal, and the "session lost" state. Safe for concurrent use.
type sessionControl struct {
	base    context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	closeMu sync.Once

	desc     *Descriptor
	creds    Credentials
	control  *http.Client
	now      func() time.Time
	canRenew bool

	lostMu  sync.Mutex
	lostErr error

	// leaseExpiresAt, the deadline and renewNotBefore are on the control
	// plane's clock; serverNow estimates it from the device clock and the
	// skew learned from control-plane answers.
	leaseMu        sync.Mutex
	leaseExpiresAt time.Time
	leaseDuration  time.Duration
	renewNotBefore time.Time
	// leaseDurationProvisional: leaseDuration was measured on the device
	// clock before any answer showed the skew; it is measured again once
	// one has.
	leaseDurationProvisional bool

	skewMu    sync.Mutex
	skew      time.Duration // device clock minus control-plane clock
	skewKnown bool

	// Client-side pacing of control-plane calls (see pace) and the
	// session's total time spent waiting out rate limiting.
	paceMu         sync.Mutex
	paceInterval   time.Duration // 0 = unpaced
	paceAllowance  time.Duration
	paceTAT        time.Time
	throttleMu     sync.Mutex
	throttleWaited time.Duration
}

const (
	// defaultControlCallsPerMinute / controlCallBurst pace this helper's
	// control-plane calls when the session advertises no controlRate: such a
	// control plane limits every request from a device (its agent's
	// heartbeats included) per source address, so the helper keeps well
	// inside that on its own and never sends more than this, whatever the
	// backup's size.
	defaultControlCallsPerMinute = 20
	controlCallBurst             = 10
	// throttleSessionBudget bounds the time one session spends waiting out
	// rate limiting in total; past it the session ends instead of spinning.
	throttleSessionBudget = 15 * time.Minute
	// throttleMaxBackoff caps one rate-limit backoff step.
	throttleMaxBackoff = 60 * time.Second
)

// paceSleep waits d or until ctx is done. A seam for tests.
var paceSleep = func(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// pace delays a control-plane call so this session sends at most
// defaultControlCallsPerMinute (after a burst of controlCallBurst).
func (c *sessionControl) pace(ctx context.Context) error {
	c.paceMu.Lock()
	if c.paceInterval <= 0 {
		c.paceMu.Unlock()
		return nil
	}
	now := time.Now()
	if c.paceTAT.Before(now) {
		c.paceTAT = now
	}
	wait := c.paceTAT.Sub(now) - c.paceAllowance
	c.paceTAT = c.paceTAT.Add(c.paceInterval)
	c.paceMu.Unlock()
	if wait <= 0 {
		return nil
	}
	if err := paceSleep(ctx, wait); err != nil {
		return fmt.Errorf("storage session: cancelled while pacing control-plane calls: %w", err)
	}
	return nil
}

// throttleWait is how long to wait after the attempt-th consecutive rate
// limit answer: the stated Retry-After, but never less than an exponential
// backoff with jitter (a control plane that keeps answering "retry in one
// second" is not retried every second). The session's total is bounded by
// throttleSessionBudget; past it the session ends.
func (c *sessionControl) throttleWait(retryAfter time.Duration, attempt int) (time.Duration, error) {
	backoff := retryInitialDelay << min(attempt, 6)
	backoff += time.Duration(rand.Int64N(int64(backoff)/2 + 1))
	backoff = min(backoff, throttleMaxBackoff)
	wait := max(retryAfter, backoff)
	c.throttleMu.Lock()
	defer c.throttleMu.Unlock()
	if c.throttleWaited+wait > throttleSessionBudget {
		return 0, c.markLost(fmt.Errorf("the control plane kept rate limiting this session for %s", c.throttleWaited.Round(time.Second)))
	}
	c.throttleWaited += wait
	return wait, nil
}

// clockSkewTolerance: a device clock within this of the control plane's
// (the Date header has one-second resolution) is treated as in step.
const clockSkewTolerance = 2 * time.Second

// observeServerDate learns the clock skew from a control-plane answer's Date
// header, received at the device time received.
func (c *sessionControl) observeServerDate(dateHeader string, received time.Time) {
	serverNow, err := http.ParseTime(dateHeader)
	if err != nil {
		return
	}
	skew := received.Sub(serverNow)
	if skew < clockSkewTolerance && skew > -clockSkewTolerance {
		skew = 0
	}
	c.skewMu.Lock()
	c.skew, c.skewKnown = skew, true
	c.skewMu.Unlock()
}

// serverNow is the control plane's current time as far as the device can
// tell: its own clock corrected by the last learned skew.
func (c *sessionControl) serverNow() time.Time {
	c.skewMu.Lock()
	defer c.skewMu.Unlock()
	return c.now().Add(-c.skew)
}

func (c *sessionControl) clockKnown() bool {
	c.skewMu.Lock()
	defer c.skewMu.Unlock()
	return c.skewKnown
}

// newSessionControl validates a private copy of d for commandClass and the
// agent credential, and starts the background renewer when the session
// offers renewal. ctx bounds every operation; close releases the renewer.
func newSessionControl(ctx context.Context, d *Descriptor, commandClass string, creds Credentials, opts Options) (*sessionControl, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	if d == nil {
		return nil, sessionErr("descriptor is missing")
	}
	// Validate a private copy: a provider never trusts a caller-built
	// descriptor.
	validated := *d
	if err := validated.validate(now()); err != nil {
		return nil, err
	}
	if err := validated.ValidateFor(commandClass); err != nil {
		return nil, err
	}
	d = &validated
	if !agentIDPattern.MatchString(creds.AgentID) {
		return nil, sessionErr("agent identity is unavailable")
	}
	if strings.TrimSpace(creds.AgentToken) == "" {
		return nil, sessionErr("agent credential is unavailable")
	}
	baseOrigin := canonicalOrigin(d.baseURL)
	matched := false
	for _, o := range creds.ControlPlaneOrigins {
		if origin, ok := originOf(o); ok && origin == baseOrigin {
			matched = true
			break
		}
	}
	if !matched {
		return nil, sessionErr("baseUrl %s is not a configured control-plane origin", baseOrigin)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	base, cancel := context.WithCancel(ctx)
	c := &sessionControl{
		base:     base,
		cancel:   cancel,
		done:     make(chan struct{}),
		desc:     d,
		creds:    creds,
		control:  controlClient(opts.ControlClient, creds.ClientTLS),
		now:      now,
		canRenew: hasCapability(d.Capabilities, CapabilityRenew),
	}
	if rate := opts.ControlCallsPerMinute; rate >= 0 {
		burst := controlCallBurst
		switch {
		case rate > 0:
		case d.ControlRate != nil:
			// The control plane limits session calls on their own and says
			// how fast: pace to exactly that.
			rate, burst = d.ControlRate.PerMinute, d.ControlRate.Burst
		default:
			// An older control plane counts session calls with the
			// agent's own traffic: stay conservative.
			rate = defaultControlCallsPerMinute
		}
		c.paceInterval = time.Minute / time.Duration(rate)
		c.paceAllowance = time.Duration(burst-1) * c.paceInterval
	}
	c.leaseExpiresAt = d.expiresAt
	c.leaseDuration = leaseDurationFrom(d.expiresAt, now())
	c.leaseDurationProvisional = true
	if c.canRenew {
		interval := opts.RenewCheckInterval
		if interval <= 0 {
			interval = defaultRenewCheckInterval
		}
		go c.renewLoop(interval)
	}
	return c, nil
}

// close stops the background renewer and cancels in-flight operations; every
// later operation fails.
func (c *sessionControl) close() {
	c.closeMu.Do(func() {
		close(c.done)
		c.cancel()
		c.lostMu.Lock()
		if c.lostErr == nil {
			c.lostErr = fmt.Errorf("%w: closed", ErrSessionUnavailable)
		}
		c.lostMu.Unlock()
	})
}

// markLost ends the session; every later operation fails with err.
func (c *sessionControl) markLost(err error) error {
	c.lostMu.Lock()
	defer c.lostMu.Unlock()
	if c.lostErr == nil {
		c.lostErr = fmt.Errorf("%w: %v", ErrSessionUnavailable, err)
	}
	return c.lostErr
}

func (c *sessionControl) sessionLost() error {
	c.lostMu.Lock()
	defer c.lostMu.Unlock()
	return c.lostErr
}

// merge returns a context done when either ctx or the session is done.
func (c *sessionControl) merge(ctx context.Context) (context.Context, func()) {
	if ctx == nil {
		ctx = context.Background()
	}
	merged, cancel := context.WithCancel(ctx)
	stopAfter := context.AfterFunc(c.base, cancel)
	return merged, func() {
		stopAfter()
		cancel()
	}
}

func (c *sessionControl) endpoint(op string) string {
	u := *c.desc.baseURL
	u.Path = "/api/v1/agents/" + c.creds.AgentID + "/storage-sessions/" + c.desc.SessionID + "/" + op
	return u.String()
}

// controlRequest performs one authenticated control-plane POST.
func (c *sessionControl) controlRequest(ctx context.Context, op string, body any) (*http.Response, error) {
	if err := c.pace(ctx); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("storage session: encode %s request: %w", op, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint(op), bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("storage session: build %s request: %w", op, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.creds.AgentToken)
	req.Header.Set(SessionHeader, c.desc.Token)
	resp, err := c.control.Do(req)
	if err == nil {
		c.observeServerDate(resp.Header.Get("Date"), c.now())
	}
	return resp, err
}

func (c *sessionControl) checkDeadline() error {
	if !c.serverNow().Before(c.desc.deadline) {
		return c.markLost(errors.New("session deadline has passed"))
	}
	return nil
}

// ensureLease renews the lease once less than a third of it remains, judged
// on the control plane's clock (see serverNow), so a device clock that is
// off neither lets the lease lapse nor renews on every call. Renewal is
// single-flight. A failed renew is not fatal by itself (the server decides
// whether the lease still holds); a rejected renew (the session was revoked
// or ended) ends the session.
func (c *sessionControl) ensureLease(ctx context.Context) error {
	return c.ensureLeaseAt(ctx, false)
}

// ensureLeaseAt is ensureLease; force renews whatever remains (the renewer
// uses it once, to learn the clock skew before any other call has).
func (c *sessionControl) ensureLeaseAt(ctx context.Context, force bool) error {
	if err := c.sessionLost(); err != nil {
		return err
	}
	if err := c.checkDeadline(); err != nil {
		return err
	}
	if !c.canRenew {
		return nil
	}
	c.leaseMu.Lock()
	defer c.leaseMu.Unlock()
	now := c.serverNow()
	if c.leaseDurationProvisional && c.clockKnown() {
		// Measured as expiresAt minus the device clock at delivery; on the
		// control plane's clock the lease is longer by exactly the skew.
		c.skewMu.Lock()
		skew := c.skew
		c.skewMu.Unlock()
		c.leaseDuration = max(c.leaseDuration+skew, minLeaseDuration)
		c.leaseDurationProvisional = false
	}
	if !force && c.leaseExpiresAt.Sub(now) > c.leaseDuration/3 {
		return nil
	}
	if now.Before(c.renewNotBefore) {
		return nil
	}
	resp, err := c.controlRequest(ctx, "renew", map[string]any{})
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("storage session: renew cancelled: %w", ctx.Err())
		}
		c.renewNotBefore = now.Add(renewFailureBackoff)
		slog.Warn("storage session: lease renew failed; will retry", "sessionId", c.desc.SessionID, "error", err.Error())
		return nil
	}
	defer drain(resp)
	switch status := resp.StatusCode; {
	case status == http.StatusOK:
		var wire struct {
			ExpiresAt string `json:"expiresAt"`
			// ExpiresIn, when present, is the lease's remaining lifetime in
			// whole seconds; it needs no clock agreement at all.
			ExpiresIn *int64 `json:"expiresIn"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&wire); err != nil {
			c.renewNotBefore = now.Add(renewFailureBackoff)
			return nil
		}
		now = c.serverNow() // the answer may have taught the skew
		expiresAt, err := time.Parse(time.RFC3339, wire.ExpiresAt)
		if wire.ExpiresIn != nil && *wire.ExpiresIn >= 0 {
			expiresAt, err = now.Add(time.Duration(*wire.ExpiresIn)*time.Second), nil
		}
		if err != nil || !expiresAt.After(now) {
			c.renewNotBefore = now.Add(renewFailureBackoff)
			return nil
		}
		if expiresAt.After(c.desc.deadline) {
			expiresAt = c.desc.deadline
		}
		c.leaseExpiresAt = expiresAt
		c.leaseDuration = leaseDurationFrom(expiresAt, now)
		c.leaseDurationProvisional = false
		c.renewNotBefore = time.Time{}
		return nil
	case status == http.StatusUnauthorized, status == http.StatusForbidden,
		status == http.StatusNotFound, status == http.StatusGone:
		return c.markLost(fmt.Errorf("renew rejected with status %d", status))
	case status >= 300 && status < 400:
		return c.markLost(fmt.Errorf("control plane answered renew with a redirect (status %d); redirects are not followed", status))
	default:
		wait := httputil.ParseRetryAfter(resp.Header, time.Now())
		if wait <= 0 {
			wait = renewFailureBackoff
		}
		c.renewNotBefore = now.Add(wait)
		return nil
	}
}

func (c *sessionControl) renewLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-c.base.Done():
			return
		case <-ticker.C:
			// Until some answer has shown the control plane's clock, the
			// lease cannot be judged: renew once to learn it.
			if err := c.ensureLeaseAt(c.base, !c.clockKnown()); err != nil && errors.Is(err, ErrSessionUnavailable) {
				return
			}
		}
	}
}
