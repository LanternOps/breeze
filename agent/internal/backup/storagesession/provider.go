package storagesession

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/httputil"
)

const (
	// urlRefreshMargin: a resolved URL is re-resolved once it is this close
	// to its expiry, so a transfer never starts on a URL about to lapse.
	urlRefreshMargin = 30 * time.Second
	// maxURLLifetime caps how long a resolved URL is trusted locally,
	// whatever expiry the server states.
	maxURLLifetime = 300 * time.Second

	// MaxRedirectHops bounds storage redirects followed per object.
	MaxRedirectHops = 3

	// Control-plane retry bounds: rate-limited (429) and transient (5xx)
	// answers back off, honouring Retry-After, for at most
	// rateLimitMaxTotalWait in total; transport failures and 5xx are
	// attempt-bounded.
	retryInitialDelay     = 1 * time.Second
	retryMaxDelay         = 30 * time.Second
	rateLimitMaxTotalWait = 5 * time.Minute
	transientMaxAttempts  = 4

	// maxReResolves bounds how often one Download asks for a fresh URL after
	// storage refused the previous one (403).
	maxReResolves = 2

	// renewFailureBackoff spaces renew attempts after a failed renew.
	renewFailureBackoff = 5 * time.Second
	// minLeaseDuration floors the renew window so a very short lease cannot
	// turn into a renew loop.
	minLeaseDuration = 30 * time.Second

	defaultRenewCheckInterval = 10 * time.Second

	// defaultStorageIdleTimeout aborts a storage transfer that receives no
	// bytes for this long. It bounds inactivity only, never the total
	// transfer time, so multi-gigabyte objects on slow links still complete.
	defaultStorageIdleTimeout = 2 * time.Minute
	// maxStallRetries bounds how often one Download restarts a transfer that
	// stopped making progress; each restart asks for a fresh URL.
	maxStallRetries = 3

	maxControlResponseBytes = 16 << 20
)

// retrySleep waits d or until ctx is done. A seam for tests.
var retrySleep = func(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

var agentIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// ErrSessionUnavailable wraps every failure that ends the whole session
// (rejected, revoked, expired, past its deadline, closed). Once set, every
// later Download fails with it without contacting the server.
var ErrSessionUnavailable = errors.New("storage session: session is no longer usable")

// Credentials authenticate the helper to the control plane as the agent.
type Credentials struct {
	AgentID    string
	AgentToken string
	// ControlPlaneOrigins lists the origins the agent is configured to talk
	// to. The session's baseUrl must be one of them: the agent credential is
	// never sent anywhere else.
	ControlPlaneOrigins []string
	// ClientTLS optionally carries the agent's mTLS client certificate for
	// control-plane calls. It is never presented to storage.
	ClientTLS *tls.Config
}

// Options tune a Provider. Zero values are production defaults.
type Options struct {
	// ControlClient / StorageClient supply transports (tests trust their TLS
	// servers through them). Only the Transport and Timeout are used: the
	// provider always disables automatic redirects and cookie jars.
	ControlClient *http.Client
	StorageClient *http.Client
	// Now is the clock (tests).
	Now func() time.Time
	// RenewCheckInterval is how often the background renewer checks the
	// lease.
	RenewCheckInterval time.Duration
	// StorageIdleTimeout aborts a storage transfer that receives no bytes for
	// this long. Zero means defaultStorageIdleTimeout.
	StorageIdleTimeout time.Duration
}

type resolvedObject struct {
	url       *url.URL
	headers   http.Header
	expiresAt time.Time
}

// Provider is a read-only providers.BackupProvider backed by a storage
// session. Safe for concurrent use.
type Provider struct {
	base    context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	closeMu sync.Once

	desc     *Descriptor
	creds    Credentials
	control  *http.Client
	storage  *http.Client
	now      func() time.Time
	maxBatch int
	canRenew bool
	// idleTimeout bounds how long a storage transfer may go without
	// receiving a byte.
	idleTimeout time.Duration

	mu           sync.Mutex
	plan         []string
	planIndex    map[string]int
	cache        map[string]*resolvedObject
	denied       map[string]struct{}
	inflight     map[string]chan struct{}
	storageHosts map[string]struct{}
	lostErr      error

	leaseMu        sync.Mutex
	leaseExpiresAt time.Time
	leaseDuration  time.Duration
	renewNotBefore time.Time
}

var (
	_ providers.BackupProvider    = (*Provider)(nil)
	_ providers.ContextDownloader = (*Provider)(nil)
	_ providers.DownloadPlanner   = (*Provider)(nil)
)

// New builds a provider for a validated descriptor (from ParsePayload). ctx
// bounds every operation; Close releases the background renewer.
func New(ctx context.Context, d *Descriptor, creds Credentials, opts Options) (*Provider, error) {
	now := opts.Now
	if now == nil {
		now = time.Now
	}
	if d == nil {
		return nil, sessionErr("descriptor is missing")
	}
	// Validate a private copy: New never trusts a caller-built descriptor.
	validated := *d
	if err := validated.validate(now()); err != nil {
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
	p := &Provider{
		base:         base,
		cancel:       cancel,
		done:         make(chan struct{}),
		desc:         d,
		creds:        creds,
		control:      controlClient(opts.ControlClient, creds.ClientTLS),
		storage:      storageClient(opts.StorageClient),
		now:          now,
		maxBatch:     d.MaxBatch,
		canRenew:     hasCapability(d.Capabilities, CapabilityRenew),
		planIndex:    map[string]int{},
		cache:        map[string]*resolvedObject{},
		denied:       map[string]struct{}{},
		inflight:     map[string]chan struct{}{},
		storageHosts: map[string]struct{}{},
	}
	p.idleTimeout = opts.StorageIdleTimeout
	if p.idleTimeout <= 0 {
		p.idleTimeout = defaultStorageIdleTimeout
	}
	p.leaseExpiresAt = d.expiresAt
	p.leaseDuration = leaseDurationFrom(d.expiresAt, now())

	if p.canRenew {
		interval := opts.RenewCheckInterval
		if interval <= 0 {
			interval = defaultRenewCheckInterval
		}
		go p.renewLoop(interval)
	}
	return p, nil
}

func leaseDurationFrom(expiresAt, now time.Time) time.Duration {
	d := expiresAt.Sub(now)
	if d < minLeaseDuration {
		d = minLeaseDuration
	}
	return d
}

// controlClient never follows redirects (a redirected control-plane call
// would carry both credentials to the redirect target) and keeps no cookies.
func controlClient(injected *http.Client, clientTLS *tls.Config) *http.Client {
	c := &http.Client{Timeout: 60 * time.Second, CheckRedirect: noFollow}
	if injected != nil {
		c.Transport = injected.Transport
		if injected.Timeout > 0 {
			c.Timeout = injected.Timeout
		}
		return c
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if clientTLS != nil {
		transport.TLSClientConfig = clientTLS.Clone()
	}
	c.Transport = transport
	return c
}

// storageClient carries no client certificate, no cookies and follows no
// redirects on its own; redirects are handled by fetchOnce. Transfers are
// bounded by the caller's context rather than a fixed timeout.
func storageClient(injected *http.Client) *http.Client {
	c := &http.Client{CheckRedirect: noFollow}
	if injected != nil {
		c.Transport = injected.Transport
		c.Timeout = injected.Timeout
		return c
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 2 * time.Minute
	c.Transport = transport
	return c
}

func noFollow(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// Close stops the background renewer and cancels in-flight operations. Every
// later Download fails.
func (p *Provider) Close() {
	p.closeMu.Do(func() {
		close(p.done)
		p.cancel()
		p.mu.Lock()
		if p.lostErr == nil {
			p.lostErr = fmt.Errorf("%w: closed", ErrSessionUnavailable)
		}
		p.mu.Unlock()
	})
}

// Upload is not available through a read session.
func (p *Provider) Upload(string, string) error {
	return sessionErr("upload is not permitted through a read session")
}

// List is not available through a read session.
func (p *Provider) List(string) ([]string, error) {
	return nil, sessionErr("list is not permitted through a read session")
}

// Delete is not available through a read session.
func (p *Provider) Delete(string) error {
	return sessionErr("delete is not permitted through a read session")
}

// PrepareDownloads records the order in which keys will be downloaded. A
// Download that needs a URL then resolves itself plus the next unresolved
// planned keys, up to maxBatch, in one call. Keys are kept verbatim; an
// empty key is dropped from the plan (its own Download fails locally, as it
// always has, and it must never ride along in another key's batch).
func (p *Provider) PrepareDownloads(keys []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.plan = make([]string, 0, len(keys))
	for _, k := range keys {
		if k != "" {
			p.plan = append(p.plan, k)
		}
	}
	p.planIndex = make(map[string]int, len(p.plan))
	for i, k := range p.plan {
		if _, seen := p.planIndex[k]; !seen {
			p.planIndex[k] = i
		}
	}
}

// Download fetches remotePath into localPath under the provider's context.
func (p *Provider) Download(remotePath, localPath string) error {
	return p.DownloadContext(p.base, remotePath, localPath)
}

// DownloadContext fetches remotePath (an exact object key) into localPath.
func (p *Provider) DownloadContext(ctx context.Context, remotePath, localPath string) error {
	if remotePath == "" {
		return sessionErr("object key is required")
	}
	if strings.TrimSpace(localPath) == "" {
		return sessionErr("local destination path is required")
	}
	ctx, stop := p.merge(ctx)
	defer stop()

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("storage session: create destination directory: %w", err)
	}

	force := false
	reResolves := 0
	stalls := 0
	attempts := 0
	delay := retryInitialDelay
	for {
		obj, err := p.object(ctx, remotePath, force)
		if err != nil {
			return err
		}
		force = false
		err = p.fetchOnce(ctx, obj, localPath)
		if err == nil {
			return nil
		}
		var statusErr *storageStatusError
		var transportErr *storageTransportError
		var stallErr *storageStallError
		switch {
		case errors.As(err, &stallErr):
			// The transfer stopped making progress: start it again on a
			// fresh URL, a bounded number of times.
			if stalls >= maxStallRetries {
				return err
			}
			stalls++
			force = true
			continue
		case errors.As(err, &statusErr) && statusErr.status == http.StatusForbidden:
			// The URL lapsed or was refused: ask for a fresh one, a bounded
			// number of times.
			if reResolves >= maxReResolves {
				return err
			}
			reResolves++
			force = true
			continue
		case errors.As(err, &statusErr) && isRetryableStatus(statusErr.status):
			attempts++
			if attempts >= transientMaxAttempts {
				return err
			}
			wait := delay
			if statusErr.retryAfter > 0 {
				wait = statusErr.retryAfter
			}
			if sleepErr := retrySleep(ctx, wait); sleepErr != nil {
				return fmt.Errorf("storage session: download cancelled: %w", sleepErr)
			}
		case errors.As(err, &transportErr):
			if ctxErr := ctx.Err(); ctxErr != nil {
				return fmt.Errorf("storage session: download cancelled: %w (%w)", ctxErr, err)
			}
			attempts++
			if attempts >= transientMaxAttempts {
				return err
			}
			if sleepErr := retrySleep(ctx, delay); sleepErr != nil {
				return fmt.Errorf("storage session: download cancelled: %w", sleepErr)
			}
		default:
			return err
		}
		delay *= 2
		if delay > retryMaxDelay {
			delay = retryMaxDelay
		}
	}
}

// merge returns a context done when either ctx or the provider is done.
func (p *Provider) merge(ctx context.Context) (context.Context, func()) {
	if ctx == nil {
		ctx = context.Background()
	}
	merged, cancel := context.WithCancel(ctx)
	stopAfter := context.AfterFunc(p.base, cancel)
	return merged, func() {
		stopAfter()
		cancel()
	}
}

func (p *Provider) usable(obj *resolvedObject) bool {
	return p.now().Before(obj.expiresAt.Add(-urlRefreshMargin))
}

// object returns a URL for key, resolving (with look-ahead) when needed.
func (p *Provider) object(ctx context.Context, key string, force bool) (*resolvedObject, error) {
	for {
		p.mu.Lock()
		if p.lostErr != nil {
			err := p.lostErr
			p.mu.Unlock()
			return nil, err
		}
		if _, denied := p.denied[key]; denied {
			p.mu.Unlock()
			return nil, deniedErr(key)
		}
		if force {
			delete(p.cache, key)
			force = false
		}
		if obj := p.cache[key]; obj != nil && p.usable(obj) {
			p.mu.Unlock()
			return obj, nil
		}
		if wait := p.inflight[key]; wait != nil {
			p.mu.Unlock()
			select {
			case <-wait:
				continue
			case <-ctx.Done():
				return nil, fmt.Errorf("storage session: cancelled waiting for object resolution: %w", ctx.Err())
			}
		}
		batch := p.batchLocked(key)
		ch := make(chan struct{})
		for _, k := range batch {
			p.inflight[k] = ch
		}
		p.mu.Unlock()

		objects, denied, err := p.resolve(ctx, batch)

		p.mu.Lock()
		for _, k := range batch {
			delete(p.inflight, k)
		}
		var result *resolvedObject
		var resultDenied bool
		if err == nil {
			for k, obj := range objects {
				p.cache[k] = obj
				p.storageHosts[strings.ToLower(obj.url.Host)] = struct{}{}
			}
			for _, k := range denied {
				p.denied[k] = struct{}{}
			}
			result = objects[key]
			_, resultDenied = p.denied[key]
		}
		close(ch)
		p.mu.Unlock()

		switch {
		case err != nil:
			return nil, err
		case resultDenied:
			return nil, deniedErr(key)
		case result == nil:
			return nil, sessionErr("server did not resolve the requested object")
		}
		// A freshly resolved URL is used even when its stated lifetime is
		// already inside the refresh margin; the next Download re-resolves.
		return result, nil
	}
}

// batchLocked builds the resolve batch for key: key itself, then the planned
// keys after it that still need a URL, up to maxBatch. Caller holds p.mu.
func (p *Provider) batchLocked(key string) []string {
	batch := []string{key}
	idx, planned := p.planIndex[key]
	if !planned {
		return batch
	}
	in := map[string]struct{}{key: {}}
	for i := idx + 1; i < len(p.plan) && len(batch) < p.maxBatch; i++ {
		k := p.plan[i]
		if _, dup := in[k]; dup {
			continue
		}
		if _, denied := p.denied[k]; denied {
			continue
		}
		if p.inflight[k] != nil {
			continue
		}
		if obj := p.cache[k]; obj != nil && p.usable(obj) {
			continue
		}
		in[k] = struct{}{}
		batch = append(batch, k)
	}
	return batch
}

func deniedErr(key string) error {
	return sessionErr("object %q is not authorized for this session", key)
}

// markLost ends the session; every later operation fails with err.
func (p *Provider) markLost(err error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lostErr == nil {
		p.lostErr = fmt.Errorf("%w: %v", ErrSessionUnavailable, err)
	}
	return p.lostErr
}

func (p *Provider) sessionLost() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lostErr
}

func (p *Provider) endpoint(op string) string {
	u := *p.desc.baseURL
	u.Path = "/api/v1/agents/" + p.creds.AgentID + "/storage-sessions/" + p.desc.SessionID + "/" + op
	return u.String()
}

// controlRequest performs one authenticated control-plane POST.
func (p *Provider) controlRequest(ctx context.Context, op string, body any) (*http.Response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("storage session: encode %s request: %w", op, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.endpoint(op), bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("storage session: build %s request: %w", op, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.creds.AgentToken)
	req.Header.Set(SessionHeader, p.desc.Token)
	return p.control.Do(req)
}

type resolveObjectWire struct {
	Key       string            `json:"key"`
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	ExpiresAt string            `json:"expiresAt"`
}

type resolveWire struct {
	Objects []resolveObjectWire `json:"objects"`
	Denied  []string            `json:"denied"`
}

// resolve exchanges keys for object URLs. Session-level rejections end the
// session; 429 and transient failures back off within bounds.
func (p *Provider) resolve(ctx context.Context, keys []string) (map[string]*resolvedObject, []string, error) {
	if err := p.ensureLease(ctx); err != nil {
		return nil, nil, err
	}
	delay := retryInitialDelay
	var waited time.Duration
	transient := 0
	for {
		if err := p.checkDeadline(); err != nil {
			return nil, nil, err
		}
		resp, err := p.controlRequest(ctx, "objects:resolve", map[string]any{"keys": keys})
		var wait time.Duration
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, nil, fmt.Errorf("storage session: resolve cancelled: %w", ctxErr)
			}
			transient++
			if transient >= transientMaxAttempts {
				return nil, nil, fmt.Errorf("storage session: resolve failed after %d attempts: %w", transient, err)
			}
			wait = delay
		} else {
			status := resp.StatusCode
			switch {
			case status == http.StatusOK:
				objects, denied, perr := p.parseResolve(resp.Body, keys)
				_ = resp.Body.Close()
				return objects, denied, perr
			case status == http.StatusTooManyRequests:
				wait = httputil.ParseRetryAfter(resp.Header, time.Now())
				if wait <= 0 {
					wait = delay
				}
				drain(resp)
				if waited >= rateLimitMaxTotalWait {
					return nil, nil, sessionErr("resolve still rate limited after %s", waited.Round(time.Second))
				}
			case isRetryableStatus(status):
				drain(resp)
				transient++
				if transient >= transientMaxAttempts {
					return nil, nil, sessionErr("resolve failed with status %d after %d attempts", status, transient)
				}
				wait = httputil.ParseRetryAfter(resp.Header, time.Now())
				if wait <= 0 {
					wait = delay
				}
			case status == http.StatusUnauthorized, status == http.StatusForbidden,
				status == http.StatusNotFound, status == http.StatusGone:
				drain(resp)
				return nil, nil, p.markLost(fmt.Errorf("resolve rejected with status %d", status))
			case status >= 300 && status < 400:
				drain(resp)
				return nil, nil, p.markLost(fmt.Errorf("control plane answered resolve with a redirect (status %d); redirects are not followed", status))
			default:
				drain(resp)
				return nil, nil, sessionErr("resolve failed with status %d", status)
			}
		}
		if sleepErr := retrySleep(ctx, wait); sleepErr != nil {
			return nil, nil, fmt.Errorf("storage session: resolve cancelled during backoff: %w", sleepErr)
		}
		waited += wait
		delay *= 2
		if delay > retryMaxDelay {
			delay = retryMaxDelay
		}
	}
}

func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
}

// forbiddenObjectHeaders may never be set from a resolve answer.
var forbiddenObjectHeaders = map[string]struct{}{
	"Authorization":                        {},
	"Proxy-Authorization":                  {},
	"Cookie":                               {},
	"Host":                                 {},
	"Connection":                           {},
	"Content-Length":                       {},
	"Transfer-Encoding":                    {},
	"Te":                                   {},
	"Trailer":                              {},
	"Upgrade":                              {},
	"Keep-Alive":                           {},
	http.CanonicalHeaderKey(SessionHeader): {},
}

// parseResolve validates a resolve answer strictly: only requested keys, GET
// only, https storage URLs without credentials, no credential-bearing
// headers, a stated expiry, and every requested key answered exactly once.
// Any violation rejects the whole answer.
func (p *Provider) parseResolve(body io.Reader, requested []string) (map[string]*resolvedObject, []string, error) {
	var wire resolveWire
	if err := json.NewDecoder(io.LimitReader(body, maxControlResponseBytes)).Decode(&wire); err != nil {
		return nil, nil, sessionErr("invalid resolve answer: %v", err)
	}
	want := make(map[string]bool, len(requested))
	for _, k := range requested {
		want[k] = false
	}
	now := p.now()
	objects := make(map[string]*resolvedObject, len(wire.Objects))
	for _, o := range wire.Objects {
		answered, ok := want[o.Key]
		if !ok {
			return nil, nil, sessionErr("resolve answered an object that was not requested")
		}
		if answered {
			return nil, nil, sessionErr("resolve answered an object twice")
		}
		want[o.Key] = true
		if o.Method != http.MethodGet {
			return nil, nil, sessionErr("resolve returned method %q; only GET is accepted", o.Method)
		}
		u, err := url.Parse(o.URL)
		if err != nil || u.Host == "" || u.User != nil || !schemeAllowed(u) {
			return nil, nil, sessionErr("resolve returned an unacceptable storage URL")
		}
		headers := http.Header{}
		for name, value := range o.Headers {
			canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
			if canonical == "" {
				return nil, nil, sessionErr("resolve returned an empty header name")
			}
			if _, bad := forbiddenObjectHeaders[canonical]; bad {
				return nil, nil, sessionErr("resolve returned forbidden header %q", canonical)
			}
			headers.Set(canonical, value)
		}
		expiresAt, err := time.Parse(time.RFC3339, o.ExpiresAt)
		if err != nil {
			return nil, nil, sessionErr("resolve returned an object without a valid expiry")
		}
		if cap := now.Add(maxURLLifetime); expiresAt.After(cap) {
			expiresAt = cap
		}
		objects[o.Key] = &resolvedObject{url: u, headers: headers, expiresAt: expiresAt}
	}
	for _, k := range wire.Denied {
		answered, ok := want[k]
		if !ok {
			return nil, nil, sessionErr("resolve denied an object that was not requested")
		}
		if answered {
			return nil, nil, sessionErr("resolve both granted and denied an object")
		}
		want[k] = true
	}
	for _, answered := range want {
		if !answered {
			return nil, nil, sessionErr("resolve left a requested object unanswered")
		}
	}
	return objects, wire.Denied, nil
}

func isRetryableStatus(code int) bool {
	switch code {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// --- lease ---

func (p *Provider) checkDeadline() error {
	if !p.now().Before(p.desc.deadline) {
		return p.markLost(errors.New("session deadline has passed"))
	}
	return nil
}

// ensureLease renews the lease once less than a third of it remains.
// Renewal is single-flight. A failed renew is not fatal by itself (the
// server decides whether the lease still holds); a rejected renew (the
// session was revoked or ended) ends the session.
func (p *Provider) ensureLease(ctx context.Context) error {
	if err := p.sessionLost(); err != nil {
		return err
	}
	if err := p.checkDeadline(); err != nil {
		return err
	}
	if !p.canRenew {
		return nil
	}
	p.leaseMu.Lock()
	defer p.leaseMu.Unlock()
	now := p.now()
	if p.leaseExpiresAt.Sub(now) > p.leaseDuration/3 {
		return nil
	}
	if now.Before(p.renewNotBefore) {
		return nil
	}
	resp, err := p.controlRequest(ctx, "renew", map[string]any{})
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("storage session: renew cancelled: %w", ctx.Err())
		}
		p.renewNotBefore = now.Add(renewFailureBackoff)
		slog.Warn("storage session: lease renew failed; will retry", "sessionId", p.desc.SessionID, "error", err.Error())
		return nil
	}
	defer drain(resp)
	switch status := resp.StatusCode; {
	case status == http.StatusOK:
		var wire struct {
			ExpiresAt string `json:"expiresAt"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&wire); err != nil {
			p.renewNotBefore = now.Add(renewFailureBackoff)
			return nil
		}
		expiresAt, err := time.Parse(time.RFC3339, wire.ExpiresAt)
		if err != nil || !expiresAt.After(now) {
			p.renewNotBefore = now.Add(renewFailureBackoff)
			return nil
		}
		if expiresAt.After(p.desc.deadline) {
			expiresAt = p.desc.deadline
		}
		p.leaseExpiresAt = expiresAt
		p.leaseDuration = leaseDurationFrom(expiresAt, now)
		p.renewNotBefore = time.Time{}
		return nil
	case status == http.StatusUnauthorized, status == http.StatusForbidden,
		status == http.StatusNotFound, status == http.StatusGone:
		return p.markLost(fmt.Errorf("renew rejected with status %d", status))
	case status >= 300 && status < 400:
		return p.markLost(fmt.Errorf("control plane answered renew with a redirect (status %d); redirects are not followed", status))
	default:
		wait := httputil.ParseRetryAfter(resp.Header, time.Now())
		if wait <= 0 {
			wait = renewFailureBackoff
		}
		p.renewNotBefore = now.Add(wait)
		return nil
	}
}

func (p *Provider) renewLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-p.base.Done():
			return
		case <-ticker.C:
			if err := p.ensureLease(p.base); err != nil && errors.Is(err, ErrSessionUnavailable) {
				return
			}
		}
	}
}

// --- storage fetch ---

type storageStatusError struct {
	status     int
	retryAfter time.Duration
}

func (e *storageStatusError) Error() string {
	return fmt.Sprintf("storage session: storage answered status %d", e.status)
}

// Is makes a storage 404 a confirmed-absent object.
func (e *storageStatusError) Is(target error) bool {
	return e.status == http.StatusNotFound && target == providers.ErrObjectNotFound
}

type storageTransportError struct {
	stage string
	cause error
}

func (e *storageTransportError) Error() string {
	return fmt.Sprintf("storage session: storage %s failed: %v", e.stage, e.cause)
}

func (e *storageTransportError) Unwrap() error { return e.cause }

// errStorageStalled is the cancellation cause set by the idle watchdog.
var errStorageStalled = errors.New("storage transfer made no progress")

// storageStallError reports a transfer aborted because no bytes arrived
// within the idle timeout. Download retries it on a fresh URL.
type storageStallError struct {
	idle time.Duration
}

func (e *storageStallError) Error() string {
	return fmt.Sprintf("storage session: storage transfer stalled (no data received for %s)", e.idle)
}

// progressReader calls onRead whenever a Read returns data.
type progressReader struct {
	r      io.Reader
	onRead func()
}

func (r *progressReader) Read(b []byte) (int, error) {
	n, err := r.r.Read(b)
	if n > 0 {
		r.onRead()
	}
	return n, err
}

// newStorageTransportError wraps a storage transport failure, stripping the
// query string from any URL net/http embedded in it: object URLs carry
// signatures that must not end up in command results or shipped logs.
func newStorageTransportError(stage string, err error) *storageTransportError {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		redacted := &url.Error{Op: urlErr.Op, URL: redactURL(urlErr.URL), Err: urlErr.Err}
		return &storageTransportError{stage: stage, cause: redacted}
	}
	return &storageTransportError{stage: stage, cause: err}
}

func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "<storage url>"
	}
	u.User = nil
	u.RawQuery = ""
	u.Fragment = ""
	return u.String()
}

// idleTimer is the subset of *time.Timer the idle watchdog uses.
type idleTimer interface {
	Reset(d time.Duration) bool
	Stop() bool
}

// idleAfterFunc arms the idle watchdog. It is a variable only so tests can
// drive the watchdog with a fake clock instead of racing real time (#7380);
// production always uses time.AfterFunc.
var idleAfterFunc = func(d time.Duration, f func()) idleTimer { return time.AfterFunc(d, f) }

// fetchOnce GETs one resolved URL into localPath. It follows at most
// MaxRedirectHops redirects by hand: each hop is a fresh request with no
// headers at all (never the session header, the agent credential or a
// cookie), must stay on https (no downgrade), and must target a host the
// session's resolve answers returned.
//
// An idle watchdog aborts the attempt when no response or body bytes arrive
// for p.idleTimeout; the failure is then reported as a storageStallError.
func (p *Provider) fetchOnce(ctx context.Context, obj *resolvedObject, localPath string) (err error) {
	parent := ctx
	fetchCtx, cancelFetch := context.WithCancelCause(parent)
	defer cancelFetch(nil)
	idle := idleAfterFunc(p.idleTimeout, func() { cancelFetch(errStorageStalled) })
	defer idle.Stop()
	progress := func() { idle.Reset(p.idleTimeout) }
	defer func() {
		// Only the watchdog's own cancellation is a stall; a cancelled
		// caller context stays a cancellation.
		if err != nil && parent.Err() == nil && errors.Is(context.Cause(fetchCtx), errStorageStalled) {
			err = &storageStallError{idle: p.idleTimeout}
		}
	}()
	ctx = fetchCtx

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, obj.url.String(), nil)
	if err != nil {
		return fmt.Errorf("storage session: build storage request: %w", err)
	}
	for name, values := range obj.headers {
		for _, v := range values {
			req.Header.Add(name, v)
		}
	}
	resp, err := p.storage.Do(req)
	if err != nil {
		return newStorageTransportError("request", err)
	}
	progress()
	current := obj.url
	for hops := 0; isRedirect(resp.StatusCode); {
		hops++
		location := strings.TrimSpace(resp.Header.Get("Location"))
		drain(resp)
		if hops > MaxRedirectHops {
			return sessionErr("too many storage redirects (more than %d)", MaxRedirectHops)
		}
		if location == "" {
			return sessionErr("storage redirect without a Location")
		}
		loc, err := url.Parse(location)
		if err != nil {
			return sessionErr("invalid storage redirect location")
		}
		target := current.ResolveReference(loc)
		if err := p.checkRedirectTarget(current, target); err != nil {
			return err
		}
		next, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return fmt.Errorf("storage session: build redirect request: %w", err)
		}
		resp, err = p.storage.Do(next)
		if err != nil {
			return newStorageTransportError("redirect request", err)
		}
		progress()
		current = target
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		statusErr := &storageStatusError{status: resp.StatusCode, retryAfter: httputil.ParseRetryAfter(resp.Header, time.Now())}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return statusErr
	}

	file, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("storage session: create local destination file: %w", err)
	}
	_, copyErr := io.Copy(providers.DownloadProgressWriter(ctx, file), &progressReader{r: resp.Body, onRead: progress})
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(localPath)
		if ctx.Err() != nil {
			return fmt.Errorf("storage session: download cancelled: %w", ctx.Err())
		}
		if _, probe := resp.Body.Read(make([]byte, 1)); probe != nil && probe != io.EOF {
			return newStorageTransportError("body read", copyErr)
		}
		return fmt.Errorf("storage session: write downloaded file: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(localPath)
		return fmt.Errorf("storage session: close downloaded file: %w", closeErr)
	}
	return nil
}

func (p *Provider) checkRedirectTarget(current, target *url.URL) error {
	if target.User != nil || target.Host == "" {
		return sessionErr("storage redirect to an unacceptable URL")
	}
	if !schemeAllowed(target) {
		return sessionErr("storage redirect to a non-https URL")
	}
	if strings.EqualFold(current.Scheme, "https") && !strings.EqualFold(target.Scheme, "https") {
		return sessionErr("storage redirect downgrades from https")
	}
	p.mu.Lock()
	_, allowed := p.storageHosts[strings.ToLower(target.Host)]
	p.mu.Unlock()
	if !allowed {
		return sessionErr("storage redirect to a host the session did not return")
	}
	return nil
}

func isRedirect(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}
