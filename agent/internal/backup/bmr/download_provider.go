package bmr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/httputil"
)

const (
	// downloadRetryInitialDelay/downloadRetryMaxDelay bound the exponential
	// backoff schedule for a single retryable download failure (429/502/503/
	// 504). downloadRetryMaxTotalWait is the minimum cumulative time the
	// retry loop spends sleeping before giving up on one object — D13: a
	// live 10,047-file BMR recovery hit the download route's per-token rate
	// limiter (BMR_DOWNLOAD_TOKEN_LIMIT, apps/api/src/routes/backup/bmr.ts)
	// after ~134 files and treated every subsequent 429 as a permanent
	// failure, finishing "partial" with 9,913 files missing in under two
	// minutes — nowhere near long enough for a 100-req/60s limiter window to
	// clear.
	downloadRetryInitialDelay = 1 * time.Second
	downloadRetryMaxDelay     = 30 * time.Second
	downloadRetryMaxTotalWait = 5 * time.Minute

	// downloadMaxRedirectHops bounds how many redirect hops downloadOnce
	// will follow for a single object: the first redirect (typically a 302
	// handing back a presigned storage URL) is always followed, plus up to
	// 5 further redirects, matching the contract's "at most 5 further
	// redirects" — 1 + 5 = 6 total hops before giving up.
	downloadMaxRedirectHops = 6
)

// retrySleep is a seam for tests to skip the real backoff delay while still
// exercising the retry loop's attempt/duration accounting, and — in
// production — the mechanism that makes a backoff step cooperatively
// cancellable: the retry loop can wait up to downloadRetryMaxTotalWait (5
// minutes) across a recovery, so a cancelled context must interrupt an
// in-flight sleep immediately rather than being noticed only after it
// elapses. Returns ctx.Err() if ctx is cancelled/expires before d passes,
// else nil. Mirrors renameRetrySleep in agent/internal/config/config.go.
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

// downloadStatusError is a typed HTTP-status download failure so callers
// (isSessionExpired, the retry loop) can branch on the status code directly
// instead of substring-matching the formatted error text.
type downloadStatusError struct {
	statusCode int
	message    string
	retryAfter time.Duration
}

func (e *downloadStatusError) Error() string {
	if e.message != "" {
		return fmt.Sprintf("bmr: download failed with status %d: %s", e.statusCode, e.message)
	}
	return fmt.Sprintf("bmr: download failed with status %d", e.statusCode)
}

// Is reports a 404 downloadStatusError as providers.ErrObjectNotFound so
// every caller that distinguishes "confirmed absent" from "some other
// download failure" via errors.Is(err, providers.ErrObjectNotFound) —
// DownloadSystemState's soft ErrNoSystemState skip is the one that
// surfaced this via the QEMU end-to-end proof (W04b Task 4): a recovery
// token's HTTP download path returned this error's un-translated 404
// straight through, so a snapshot with no system state failed preflight
// hard instead of taking the intended soft-skip path — never wrapped
// providers.ErrObjectNotFound at all, unlike LocalProvider/S3Provider's
// own Download implementations — was ALWAYS unreachable for a
// token/HTTP-driven recovery (every BMR token recovery goes through this
// provider, never LocalProvider/S3Provider directly: see
// newRecoveryDownloadProvider). A 401/403/5xx/etc. still does not satisfy
// this — those are exactly the "not confirmed absent" cases
// ErrObjectNotFound's own doc comment says must never match.
func (e *downloadStatusError) Is(target error) bool {
	return e.statusCode == http.StatusNotFound && target == providers.ErrObjectNotFound
}

// isRetryableDownloadStatus reports whether a status is a transient
// condition worth retrying with backoff. Any other 4xx (401/403/404/etc.) is
// permanent here — a 401 is instead handled by Download's session refresh
// (download_session.go).
func isRetryableDownloadStatus(code int) bool {
	switch code {
	case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

// noAuthRedirectClient is used both for the initial download request and
// for manually following any redirect Location it returns. CheckRedirect
// always returns http.ErrUseLastResponse so net/http never auto-follows a
// redirect on our behalf — see D21: net/http's default redirect policy
// forwards sensitive headers (Authorization included) to a redirect target
// whenever the target's *host* matches the original request's host,
// ignoring port. A presigned storage URL handed back by a 302 on the same
// host as the API but a different port (the self-hosted shape: API and
// MinIO/S3 on one box) would otherwise receive the recovery token's
// Authorization header alongside the presigned query signature, which
// S3/MinIO reject with 400 ("Only one auth mechanism allowed"). By
// intercepting every redirect ourselves and building a fresh request with
// no Authorization / token / cookie headers, the recovery token never
// leaves the API host.
var noAuthRedirectClient = &http.Client{
	Timeout: 30 * time.Minute,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// isRedirectStatus reports whether code is one of the redirect statuses
// net/http's own default policy would otherwise auto-follow (see
// net/http's redirectBehavior). Only these carry a Location header worth
// chasing.
func isRedirectStatus(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	default:
		return false
	}
}

// followDownloadRedirects takes the response to the initial download
// request (already performed via noAuthRedirectClient, so any redirect was
// returned to us rather than auto-followed) and, while the response is a
// redirect, issues a fresh GET at the resolved Location with no
// Authorization / X-Recovery-Token headers and no cookies — the recovery
// token must never reach a redirect target (D21). Follows up to
// downloadMaxRedirectHops hops total before giving up. A redirect to a
// non-http(s) scheme or with an empty/missing Location is a permanent
// error. Returns the first non-redirect response (success or failure
// status alike), whose body the caller owns and must close.
func (p *recoveryDownloadProvider) followDownloadRedirects(resp *http.Response, initialURL *url.URL) (*http.Response, error) {
	current := initialURL
	hops := 0

	for isRedirectStatus(resp.StatusCode) {
		hops++
		if hops > downloadMaxRedirectHops {
			_ = resp.Body.Close()
			return nil, fmt.Errorf("bmr: too many download redirects (> %d)", downloadMaxRedirectHops)
		}

		location := strings.TrimSpace(resp.Header.Get("Location"))
		_ = resp.Body.Close()
		if location == "" {
			return nil, fmt.Errorf("bmr: download redirect (status %d) missing Location header", resp.StatusCode)
		}

		locationURL, err := url.Parse(location)
		if err != nil {
			return nil, fmt.Errorf("bmr: invalid download redirect location: %w", err)
		}
		target := current.ResolveReference(locationURL)
		if target.Scheme != "http" && target.Scheme != "https" {
			return nil, fmt.Errorf("bmr: refusing to follow download redirect to non-http(s) scheme %q", target.Scheme)
		}

		slog.Debug("bmr: following download redirect", "host", target.Host)

		req, err := http.NewRequestWithContext(p.ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("bmr: create download redirect request: %w", err)
		}
		// Deliberately no Authorization / token / cookie headers set here —
		// that is the entire point of handling redirects by hand.

		redirectResp, err := noAuthRedirectClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("bmr: download redirect request failed: %w", err)
		}

		resp = redirectResp
		current = target
	}

	return resp, nil
}

type recoveryDownloadProvider struct {
	ctx       context.Context
	serverURL string
	token     string

	// mu guards descriptor, generation and lostErr.
	mu         sync.RWMutex
	descriptor *AuthenticatedDownloadDescriptor
	// generation counts successful session refreshes, so a download that
	// hit 401 on generation N can tell whether someone else already
	// refreshed past N (see refreshAfterUnauthorized).
	generation uint64
	// lostErr, once set, is a run-level failure (wraps
	// ErrRecoverySessionLost): every later Download returns it without
	// touching the network. See download_session.go.
	lostErr error

	// sessionMu serialises session refreshes (single-flight) and guards the
	// fields below. It is never held while a download is in flight.
	sessionMu sync.Mutex
	// lastAuthAt is when the current session was established, on the
	// LOCAL clock (monotonic) — the proactive refresh's rate bound.
	lastAuthAt time.Time
	// authNotBefore is the earliest time another authenticate may be sent
	// (a server Retry-After, or our own backoff).
	authNotBefore time.Time
	// proactiveTriedFor is the descriptor expiresAt a proactive refresh was
	// already attempted for — at most one attempt per expiry.
	proactiveTriedFor time.Time

	// now is the clock seam for tests.
	now func() time.Time

	// admissible holds exact external object keys widened into scope by
	// bmr.ApplyManifestScope (scope.go, Task 10) after the manifest is
	// downloaded. Guarded by mu, same as descriptor/generation. Keys are
	// never removed — only ever added — for the life of the provider.
	admissible map[string]struct{}
	// membership mirrors HasCapability(descriptor.Capabilities,
	// CapabilitySnapshotFileMembershipV1) at construction/last swap time.
	membership bool
}

func newRecoveryDownloadProvider(ctx context.Context, serverURL, token string, descriptor *AuthenticatedDownloadDescriptor) *recoveryDownloadProvider {
	d := rewriteDescriptorOrigin(serverURL, descriptor)
	return &recoveryDownloadProvider{
		ctx:        ctx,
		serverURL:  serverURL,
		token:      token,
		descriptor: d,
		// The bootstrap carrying descriptor was authenticated just before
		// the provider is built (authenticate or exchange).
		lastAuthAt: time.Now(),
		now:        time.Now,
		admissible: make(map[string]struct{}),
		membership: d != nil && HasCapability(d.Capabilities, CapabilitySnapshotFileMembershipV1),
	}
}

// ErrCapabilityDowngrade is returned by authenticateAndSwap when a session
// refresh's fresh descriptor no longer grants
// CapabilitySnapshotFileMembershipV1 but the provider had already negotiated
// it — the admissible set built from the old descriptor could then admit
// keys the server no longer authorizes. The previous descriptor is kept in
// place; the caller (bmr.go / rebuild_cmd.go) treats this as a hard refusal.
var ErrCapabilityDowngrade = errors.New("bmr: server dropped snapshot-file-membership-v1 on session refresh")

// MembershipNegotiated reports whether the current descriptor grants
// CapabilitySnapshotFileMembershipV1.
func (p *recoveryDownloadProvider) MembershipNegotiated() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.membership
}

// ExtendAdmissible widens the admissible set with exact external object
// keys. It does not itself check MembershipNegotiated — downloadOnce and
// Admits are the enforcement points, so a caller that widens the set on a
// non-membership provider still cannot download anything through it.
func (p *recoveryDownloadProvider) ExtendAdmissible(keys []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, k := range keys {
		p.admissible[k] = struct{}{}
	}
}

// Admits reports whether key is a member of the admissible set under an
// active membership grant. It is the exact predicate downloadOnce uses for
// external keys and must be called while NOT already holding p.mu (it
// acquires its own read lock).
func (p *recoveryDownloadProvider) Admits(key string) bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.descriptor != nil {
		normalizedKey := strings.TrimLeft(pathClean(key), "/")
		normalizedPrefix := strings.Trim(p.descriptor.PathPrefix, "/")
		if normalizedPrefix != "" && (normalizedKey == normalizedPrefix || strings.HasPrefix(normalizedKey, normalizedPrefix+"/")) {
			return true
		}
	}
	if !p.membership {
		return false
	}
	_, ok := p.admissible[key]
	return ok
}

// rewriteDescriptorOrigin makes the download descriptor's URL target the
// same origin the helper authenticated against via --server, rather than
// whatever public URL the server was configured with (BREEZE_SERVER /
// PUBLIC_API_URL / request origin — see recoveryBootstrap.ts). A mis-set or
// internal-only public URL otherwise makes every recovery fail downloads
// even though --server is reachable (D10). Only the scheme and host are
// touched; path and query are left exactly as the server sent them, since
// the server may sign or scope them.
func rewriteDescriptorOrigin(serverURL string, descriptor *AuthenticatedDownloadDescriptor) *AuthenticatedDownloadDescriptor {
	if descriptor == nil || strings.TrimSpace(descriptor.URL) == "" {
		return descriptor
	}

	serverParsed, err := url.Parse(serverURL)
	if err != nil {
		slog.Warn("bmr: could not parse --server URL, leaving download descriptor origin unchanged",
			"server", serverURL, "error", err.Error())
		return descriptor
	}
	if serverParsed.Host == "" {
		slog.Warn("bmr: --server URL has no host, leaving download descriptor origin unchanged",
			"server", serverURL)
		return descriptor
	}

	descParsed, err := url.Parse(descriptor.URL)
	if err != nil {
		slog.Warn("bmr: could not parse download descriptor URL, leaving it unchanged",
			"url", descriptor.URL, "error", err.Error())
		return descriptor
	}

	if descParsed.Host == "" {
		// Relative descriptor URL: resolve it against the server origin.
		resolved := serverParsed.ResolveReference(descParsed)
		rewritten := *descriptor
		rewritten.URL = resolved.String()
		slog.Info("bmr: download descriptor origin rewritten", "from", descriptor.URL, "to", rewritten.URL)
		return &rewritten
	}

	if descParsed.Scheme == serverParsed.Scheme && descParsed.Host == serverParsed.Host {
		return descriptor
	}

	downgrade := descParsed.Scheme == "https" && serverParsed.Scheme == "http"

	rewrittenURL := *descParsed
	rewrittenURL.Scheme = serverParsed.Scheme
	rewrittenURL.Host = serverParsed.Host

	rewritten := *descriptor
	rewritten.URL = rewrittenURL.String()

	if downgrade {
		slog.Warn("bmr: download descriptor origin rewritten, downgraded https to http to match --server",
			"from", descriptor.URL, "to", rewritten.URL, "server", serverURL)
	} else {
		slog.Info("bmr: download descriptor origin rewritten", "from", descriptor.URL, "to", rewritten.URL)
	}
	return &rewritten
}

func (p *recoveryDownloadProvider) Upload(localPath, remotePath string) error {
	return fmt.Errorf("bmr: upload is not supported for authenticated recovery downloads")
}

func (p *recoveryDownloadProvider) List(prefix string) ([]string, error) {
	return nil, fmt.Errorf("bmr: list is not supported for authenticated recovery downloads")
}

func (p *recoveryDownloadProvider) Delete(remotePath string) error {
	return fmt.Errorf("bmr: delete is not supported for authenticated recovery downloads")
}

func (p *recoveryDownloadProvider) Download(remotePath, localPath string) error {
	if strings.TrimSpace(remotePath) == "" {
		return fmt.Errorf("bmr: remote path is required")
	}
	if strings.TrimSpace(localPath) == "" {
		return fmt.Errorf("bmr: local destination path is required")
	}

	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("bmr: create destination directory: %w", err)
	}

	if err := p.sessionLost(); err != nil {
		return err
	}
	p.maybeRefreshBeforeExpiry()

	generation := p.sessionGeneration()
	err := p.downloadWithRetry(remotePath, localPath)
	if err == nil || !isSessionExpired(err) {
		return err
	}

	if refreshErr := p.refreshAfterUnauthorized(generation); refreshErr != nil {
		return refreshErr
	}

	err = p.downloadWithRetry(remotePath, localPath)
	if err != nil && isSessionExpired(err) {
		// The session was re-established a moment ago and still answers
		// 401: authenticating again cannot help, and doing it per file is
		// the flood #5635 is about.
		return p.markSessionLost(fmt.Errorf("download still unauthorized after re-authenticating: %w", err))
	}
	return err
}

// isSessionExpired reports whether a download failure means the recovery
// session (not this one object) is no longer accepted. Only 401: the
// recovery download route answers every session-level rejection — expired
// window, revoked/expired/used token, invalid token — with 401 and never
// sends 403. A 403 can only come from a storage redirect target (an S3/MinIO
// presigned URL answering AccessDenied for one object), which a new session
// cannot fix; treating it as a session expiry re-authenticated once per such
// file.
func isSessionExpired(err error) bool {
	var statusErr *downloadStatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.statusCode == http.StatusUnauthorized
}

// downloadWithRetry retries downloadOnce with exponential backoff on a
// transient status (429/502/503/504), honoring the server's Retry-After
// header when present instead of the internal schedule. It keeps retrying
// until it has waited at least downloadRetryMaxTotalWait cumulative time,
// then gives up. Non-retryable errors (including 401, left for Download's
// session refresh, and any non-HTTP error) return
// immediately on the first attempt.
func (p *recoveryDownloadProvider) downloadWithRetry(remotePath, localPath string) error {
	delay := downloadRetryInitialDelay
	var totalWaited time.Duration
	var retried bool

	for {
		err := p.downloadOnce(remotePath, localPath)
		if err == nil {
			if retried {
				slog.Info("bmr: download succeeded after retry", "path", remotePath)
			}
			return nil
		}

		var statusErr *downloadStatusError
		if !errors.As(err, &statusErr) || !isRetryableDownloadStatus(statusErr.statusCode) {
			return err
		}

		if totalWaited >= downloadRetryMaxTotalWait {
			return fmt.Errorf("bmr: download retries exhausted after %s: %w", totalWaited.Round(time.Second), err)
		}

		wait := delay
		if statusErr.retryAfter > 0 {
			wait = statusErr.retryAfter
		}

		if !retried {
			slog.Warn("bmr: download failed, retrying with backoff",
				"path", remotePath, "status", statusErr.statusCode, "wait", wait)
			retried = true
		}

		if sleepErr := retrySleep(p.ctx, wait); sleepErr != nil {
			return fmt.Errorf("bmr: download cancelled during retry backoff: %w", sleepErr)
		}
		totalWaited += wait

		delay *= 2
		if delay > downloadRetryMaxDelay {
			delay = downloadRetryMaxDelay
		}
	}
}

func (p *recoveryDownloadProvider) currentDescriptor() (*AuthenticatedDownloadDescriptor, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	if p.descriptor == nil {
		return nil, fmt.Errorf("bmr: missing download descriptor")
	}
	if p.descriptor.URL == "" {
		return nil, fmt.Errorf("bmr: download descriptor url is required")
	}
	if p.descriptor.PathPrefix == "" {
		return nil, fmt.Errorf("bmr: download descriptor path prefix is required")
	}
	return p.descriptor, nil
}

func (p *recoveryDownloadProvider) downloadOnce(remotePath, localPath string) error {
	descriptor, err := p.currentDescriptor()
	if err != nil {
		return err
	}

	normalizedRemotePath := strings.TrimLeft(pathClean(remotePath), "/")
	normalizedPrefix := strings.Trim(descriptor.PathPrefix, "/")
	ownPrefix := normalizedPrefix + "/"
	if normalizedRemotePath != normalizedPrefix && !strings.HasPrefix(normalizedRemotePath, ownPrefix) {
		if !p.Admits(remotePath) {
			return fmt.Errorf("bmr: requested path %q is not an authorized object of snapshot %q", remotePath, normalizedPrefix)
		}
	}

	requestURL, err := url.Parse(descriptor.URL)
	if err != nil {
		return fmt.Errorf("bmr: invalid download url: %w", err)
	}
	query := requestURL.Query()
	pathParam := descriptor.PathQueryParam
	if pathParam == "" {
		pathParam = "path"
	}
	query.Set(pathParam, normalizedRemotePath)
	requestURL.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(p.ctx, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return fmt.Errorf("bmr: create download request: %w", err)
	}
	if strings.TrimSpace(descriptor.TokenHeaderName) != "" {
		req.Header.Set(descriptor.TokenHeaderName, formatRecoveryTokenHeader(descriptor.TokenHeaderFormat, p.token))
	} else {
		tokenParam := descriptor.TokenQueryParam
		if tokenParam == "" {
			tokenParam = "token"
		}
		query.Set(tokenParam, p.token)
		requestURL.RawQuery = query.Encode()
		req.URL = requestURL
	}

	resp, err := noAuthRedirectClient.Do(req)
	if err != nil {
		return fmt.Errorf("bmr: download request failed: %w", err)
	}

	resp, err = p.followDownloadRedirects(resp, req.URL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		statusErr := &downloadStatusError{
			statusCode: resp.StatusCode,
			retryAfter: httputil.ParseRetryAfter(resp.Header, time.Now()),
		}
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err == nil {
			if message, ok := body["error"].(string); ok && message != "" {
				statusErr.message = message
			}
		}
		return statusErr
	}

	file, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("bmr: create local destination file: %w", err)
	}
	_, copyErr := io.Copy(file, resp.Body)
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("bmr: write downloaded file: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("bmr: close downloaded file: %w", closeErr)
	}
	return nil
}

func formatRecoveryTokenHeader(format, token string) string {
	trimmed := strings.TrimSpace(format)
	if trimmed == "" {
		return token
	}
	if strings.Contains(trimmed, "<recovery-token>") {
		return strings.ReplaceAll(trimmed, "<recovery-token>", token)
	}
	return trimmed + " " + token
}

func pathClean(path string) string {
	cleaned := filepath.ToSlash(filepath.Clean(path))
	if cleaned == "." {
		return ""
	}
	return cleaned
}
