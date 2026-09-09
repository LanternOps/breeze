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
)

// retrySleep is a seam for tests to skip the real backoff delay while still
// exercising the retry loop's attempt/duration accounting. Defaults to
// time.Sleep in production. Mirrors renameRetrySleep in
// agent/internal/config/config.go.
var retrySleep = time.Sleep

// downloadStatusError is a typed HTTP-status download failure so callers
// (shouldRefresh, the retry loop) can branch on the status code directly
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

// isRetryableDownloadStatus reports whether a status is a transient
// condition worth retrying with backoff. Any other 4xx (401/403/404/etc.) is
// permanent — 401/403 are instead handled by the existing re-authenticate
// path in Download.
func isRetryableDownloadStatus(code int) bool {
	switch code {
	case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	default:
		return false
	}
}

type recoveryDownloadProvider struct {
	ctx       context.Context
	serverURL string
	token     string

	mu         sync.RWMutex
	descriptor *AuthenticatedDownloadDescriptor
}

func newRecoveryDownloadProvider(ctx context.Context, serverURL, token string, descriptor *AuthenticatedDownloadDescriptor) *recoveryDownloadProvider {
	return &recoveryDownloadProvider{
		ctx:        ctx,
		serverURL:  serverURL,
		token:      token,
		descriptor: rewriteDescriptorOrigin(serverURL, descriptor),
	}
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
	if err != nil || serverParsed.Host == "" {
		return descriptor
	}

	descParsed, err := url.Parse(descriptor.URL)
	if err != nil {
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

	if err := p.downloadWithRetry(remotePath, localPath); err == nil {
		return nil
	} else if !p.shouldRefresh(err) {
		return err
	}

	bootstrap, authErr := authenticateRecoverySessionContext(p.ctx, p.serverURL, p.token)
	if authErr != nil {
		return fmt.Errorf("%w; re-authenticate failed: %v", authErr, authErr)
	}
	if bootstrap.Download == nil {
		return fmt.Errorf("bmr: refreshed bootstrap missing download descriptor")
	}
	p.mu.Lock()
	p.descriptor = rewriteDescriptorOrigin(p.serverURL, bootstrap.Download)
	p.mu.Unlock()

	return p.downloadWithRetry(remotePath, localPath)
}

func (p *recoveryDownloadProvider) shouldRefresh(err error) bool {
	var statusErr *downloadStatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.statusCode == http.StatusUnauthorized || statusErr.statusCode == http.StatusForbidden
}

// downloadWithRetry retries downloadOnce with exponential backoff on a
// transient status (429/502/503/504), honoring the server's Retry-After
// header when present instead of the internal schedule. It keeps retrying
// until it has waited at least downloadRetryMaxTotalWait cumulative time,
// then gives up. Non-retryable errors (including 401/403, left for
// Download's existing re-authenticate path, and any non-HTTP error) return
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

		retrySleep(wait)
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
	if normalizedRemotePath != normalizedPrefix && !strings.HasPrefix(normalizedRemotePath, normalizedPrefix+"/") {
		return fmt.Errorf("bmr: requested path %q is outside allowed prefix %q", remotePath, descriptor.PathPrefix)
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

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("bmr: download request failed: %w", err)
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
