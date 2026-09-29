package storagesession

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
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

	leaseMu        sync.Mutex
	leaseExpiresAt time.Time
	leaseDuration  time.Duration
	renewNotBefore time.Time
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
	c.leaseExpiresAt = d.expiresAt
	c.leaseDuration = leaseDurationFrom(d.expiresAt, now())
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
	return c.control.Do(req)
}

func (c *sessionControl) checkDeadline() error {
	if !c.now().Before(c.desc.deadline) {
		return c.markLost(errors.New("session deadline has passed"))
	}
	return nil
}

// ensureLease renews the lease once less than a third of it remains.
// Renewal is single-flight. A failed renew is not fatal by itself (the
// server decides whether the lease still holds); a rejected renew (the
// session was revoked or ended) ends the session.
func (c *sessionControl) ensureLease(ctx context.Context) error {
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
	now := c.now()
	if c.leaseExpiresAt.Sub(now) > c.leaseDuration/3 {
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
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&wire); err != nil {
			c.renewNotBefore = now.Add(renewFailureBackoff)
			return nil
		}
		expiresAt, err := time.Parse(time.RFC3339, wire.ExpiresAt)
		if err != nil || !expiresAt.After(now) {
			c.renewNotBefore = now.Add(renewFailureBackoff)
			return nil
		}
		if expiresAt.After(c.desc.deadline) {
			expiresAt = c.desc.deadline
		}
		c.leaseExpiresAt = expiresAt
		c.leaseDuration = leaseDurationFrom(expiresAt, now)
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
			if err := c.ensureLease(c.base); err != nil && errors.Is(err, ErrSessionUnavailable) {
				return
			}
		}
	}
}
