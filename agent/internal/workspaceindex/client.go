package workspaceindex

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/secmem"
)

const (
	// DefaultEndpointBase is the default server path for agent workspace-index
	// operations. ClientConfig.EndpointBase can override it.
	DefaultEndpointBase = "/api/v1/workspace/agent"

	maxErrorBodyBytes = 64 * 1024
	requestTimeout    = 30 * time.Second
	batchRetryCount   = 2
)

// batchRetryDelay is a var (not const) so tests exercising retry exhaustion
// can shrink it instead of sleeping real seconds.
var batchRetryDelay = time.Second

var (
	ErrModuleAbsent    = errors.New("workspace index module absent")
	ErrRunConflict     = errors.New("workspace index run conflict")
	ErrBatchTooLarge   = errors.New("workspace index batch too large")
	ErrAuthUnavailable = errors.New("workspace index request skipped while authentication is unavailable")
	// ErrNoServerURL names a wiring bug — the ServerURL provider is unset or
	// returned empty — so it can't masquerade as a transport failure.
	ErrNoServerURL = errors.New("workspace index client has no server URL (ServerURL provider unset or empty)")
)

// HTTPError describes a non-successful server response. Body is capped at 64
// KiB and has known credential material redacted.
type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("workspace index request failed with status %d", e.StatusCode)
	}
	return fmt.Sprintf("workspace index request failed with status %d: %s", e.StatusCode, e.Body)
}

// ClientConfig supplies the workspace-index client dependencies.
type ClientConfig struct {
	// ServerURL returns the CURRENT server base URL. It is a provider
	// (typically heartbeat.ServerURL), not a copied string, so backup-server-URL
	// promotion after failover (#2323) is visible to every request. A copied
	// cfg.ServerURL kept uploading to a dead primary for the process lifetime
	// (#2423).
	ServerURL    func() string
	EndpointBase string
	AuthToken    *secmem.SecureString
	HTTPClient   *http.Client
	AuthMonitor  *authstate.Monitor
}

// Client calls the server's agent workspace-index endpoints.
type Client struct {
	serverURL    func() string
	endpointBase string
	authToken    *secmem.SecureString
	httpClient   *http.Client
	authMonitor  *authstate.Monitor
}

// NewClient creates a workspace-index API client.
func NewClient(cfg ClientConfig) *Client {
	endpointBase := strings.TrimRight(cfg.EndpointBase, "/")
	if endpointBase == "" {
		endpointBase = DefaultEndpointBase
	}
	if !strings.HasPrefix(endpointBase, "/") {
		endpointBase = "/" + endpointBase
	}

	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	clientCopy := *httpClient
	clientCopy.Timeout = requestTimeout
	clientCopy.CheckRedirect = refuseUntrustedRedirect

	// A nil provider is a wiring bug. Keep the client constructible (callers
	// don't handle an error here) but never let it degrade into a scheme-less
	// relative URL that fails forever as a cryptic transport error — name the
	// real cause in every request error instead.
	serverURL := cfg.ServerURL
	if serverURL == nil {
		serverURL = func() string { return "" }
	}

	return &Client{
		serverURL:    serverURL,
		endpointBase: endpointBase,
		authToken:    cfg.AuthToken,
		httpClient:   &clientCopy,
		authMonitor:  cfg.AuthMonitor,
	}
}

// FetchConfig returns the current server-driven crawl configuration.
func (c *Client) FetchConfig(ctx context.Context) (*CrawlConfig, error) {
	resp, err := c.do(ctx, http.MethodGet, "/crawl-config", nil, false)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := c.checkResponse(resp, ErrModuleAbsent, http.StatusNotFound); err != nil {
		return nil, err
	}

	var config CrawlConfig
	if err := json.NewDecoder(resp.Body).Decode(&config); err != nil {
		return nil, fmt.Errorf("decode crawl config: %w", err)
	}
	return &config, nil
}

// FetchCredential returns the credential for sourceID. The caller owns the
// returned sensitive value and must call Credential.Zero after use.
func (c *Client) FetchCredential(ctx context.Context, sourceID string) (*Credential, error) {
	resp, err := c.do(ctx, http.MethodPost, "/sources/"+url.PathEscape(sourceID)+"/credential", nil, false)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := c.checkResponse(resp, nil, 0); err != nil {
		return nil, err
	}

	var credential Credential
	if err := json.NewDecoder(resp.Body).Decode(&credential); err != nil {
		return nil, fmt.Errorf("decode source credential: %w", err)
	}
	return &credential, nil
}

// StartRun starts a crawl for sourceID.
func (c *Client) StartRun(ctx context.Context, sourceID string) (*ActiveRun, error) {
	body, err := json.Marshal(struct {
		SourceID string `json:"sourceId"`
	}{SourceID: sourceID})
	if err != nil {
		return nil, fmt.Errorf("encode start-run request: %w", err)
	}
	resp, err := c.do(ctx, http.MethodPost, "/runs", body, false)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := c.checkResponse(resp, ErrRunConflict, http.StatusConflict); err != nil {
		return nil, err
	}

	var run ActiveRun
	if err := json.NewDecoder(resp.Body).Decode(&run); err != nil {
		return nil, fmt.Errorf("decode start-run response: %w", err)
	}
	return &run, nil
}

// PostBatch uploads a gzip-compressed crawl batch.
func (c *Client) PostBatch(ctx context.Context, runID string, cursor string, entries []Entry) error {
	body, err := json.Marshal(struct {
		Cursor  string  `json:"cursor"`
		Entries []Entry `json:"entries"`
	}{Cursor: cursor, Entries: entries})
	if err != nil {
		return fmt.Errorf("encode batch request: %w", err)
	}

	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	if _, err := zw.Write(body); err != nil {
		_ = zw.Close()
		return fmt.Errorf("compress batch request: %w", err)
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("finish batch compression: %w", err)
	}

	resp, err := c.do(ctx, http.MethodPost, "/runs/"+url.PathEscape(runID)+"/batch", compressed.Bytes(), true)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return c.checkResponse(resp, ErrBatchTooLarge, http.StatusRequestEntityTooLarge)
}

// CompleteRun records a successful or failed crawl completion.
func (c *Client) CompleteRun(ctx context.Context, runID string, complete bool, stats Stats, errReason string) error {
	body, err := json.Marshal(struct {
		Complete bool   `json:"complete"`
		Stats    Stats  `json:"stats"`
		Error    string `json:"error,omitempty"`
	}{Complete: complete, Stats: stats, Error: errReason})
	if err != nil {
		return fmt.Errorf("encode complete-run request: %w", err)
	}
	resp, err := c.do(ctx, http.MethodPost, "/runs/"+url.PathEscape(runID)+"/complete", body, false)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return c.checkResponse(resp, nil, 0)
}

// PostEvents uploads runless source upserts and exact-path deletes.
func (c *Client) PostEvents(ctx context.Context, sourceID string, upserts []Entry, deletes []string) error {
	body, err := json.Marshal(struct {
		Upserts []Entry  `json:"upserts"`
		Deletes []string `json:"deletes"`
	}{Upserts: upserts, Deletes: deletes})
	if err != nil {
		return fmt.Errorf("encode events request: %w", err)
	}
	resp, err := c.do(ctx, http.MethodPost, "/sources/"+url.PathEscape(sourceID)+"/events", body, false)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return c.checkResponse(resp, nil, 0)
}

func (c *Client) do(ctx context.Context, method, path string, body []byte, retryBatch bool) (*http.Response, error) {
	if c.authMonitor != nil && c.authMonitor.ShouldSkip() {
		return nil, ErrAuthUnavailable
	}

	attempts := 1
	if retryBatch {
		attempts += batchRetryCount
	}
	delay := batchRetryDelay
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
			if delay < 30*time.Second {
				delay *= 2
			}
		}

		// Resolve the server URL per attempt: the provider reflects
		// backup-server-URL promotion after failover (#2423).
		//
		// A promotion mid-crawl re-points an in-flight run's PostBatch/
		// CompleteRun at the newly promoted server. That is deliberate: the
		// alternative — pinning the run to a server we already know is dead —
		// uploads nothing at all. If the promoted server does not share the
		// primary's database it rejects the stale runID, the crawl fails, and
		// the loop simply re-runs the source against the live server on the
		// next cadence. Failing one crawl beats stranding every future one.
		baseURL := strings.TrimRight(c.serverURL(), "/")
		if baseURL == "" {
			// Fail fast and by name. Building the request anyway yields a
			// scheme-less relative URL whose transport error ("unsupported
			// protocol scheme") sends the next reader hunting for a DNS/TLS
			// problem that does not exist, and burns the batch retries doing it.
			return nil, ErrNoServerURL
		}
		req, err := http.NewRequestWithContext(ctx, method, baseURL+c.endpointBase+path, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("create workspace index request: %w", err)
		}
		if token := c.authToken.Reveal(); token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if retryBatch {
			req.Header.Set("Content-Encoding", "gzip")
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			if attempt+1 < attempts {
				continue
			}
			return nil, fmt.Errorf("send workspace index request: %w", err)
		}

		if !retryBatch || !isRetryableStatus(resp.StatusCode) || attempt+1 == attempts {
			return resp, nil
		}
		if retryAfter := httputil.ParseRetryAfter(resp.Header, time.Now()); retryAfter > 0 {
			delay = retryAfter
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxErrorBodyBytes))
		resp.Body.Close()
	}
	return nil, errors.New("workspace index request exhausted retries")
}

func (c *Client) checkResponse(resp *http.Response, sentinel error, sentinelStatus int) error {
	if resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices {
		if c.authMonitor != nil {
			c.authMonitor.RecordSuccess()
		}
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized && c.authMonitor != nil {
		c.authMonitor.RecordAuthFailure()
	}

	token := c.authToken.Reveal()
	excerpt, readErr := io.ReadAll(io.LimitReader(resp.Body, maxErrorBodyBytes))
	body := strings.TrimSpace(string(excerpt))
	if token != "" {
		body = strings.ReplaceAll(body, token, "[REDACTED]")
	}
	httpErr := &HTTPError{StatusCode: resp.StatusCode, Body: body}
	if readErr != nil {
		httpErr.Body = "unable to read error response"
	}
	if sentinel != nil && resp.StatusCode == sentinelStatus {
		return fmt.Errorf("%w: %w", sentinel, httpErr)
	}
	return httpErr
}

func isRetryableStatus(status int) bool {
	return status == http.StatusTooManyRequests ||
		status == http.StatusInternalServerError ||
		status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable ||
		status == http.StatusGatewayTimeout
}

func refuseUntrustedRedirect(req *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	previous := via[len(via)-1]
	if !strings.EqualFold(req.URL.Hostname(), previous.URL.Hostname()) {
		return fmt.Errorf("refusing redirect from host %s to untrusted host %s during credentialed request", previous.URL.Hostname(), req.URL.Hostname())
	}
	if previous.URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("refusing https-to-%s downgrade redirect to %s during credentialed request", req.URL.Scheme, req.URL.Hostname())
	}
	return nil
}
