package watchdog

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/authstate"
	"github.com/breeze-rmm/agent/internal/hostpolicy"
	"github.com/breeze-rmm/agent/internal/netcache"
)

// FailoverCommand is a command returned by the API during failover polling.
type FailoverCommand struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload,omitempty"`
}

// HeartbeatResponse is the API response to a watchdog heartbeat POST.
type HeartbeatResponse struct {
	Commands          []FailoverCommand `json:"commands,omitempty"`
	WatchdogUpgradeTo string            `json:"watchdogUpgradeTo,omitempty"`
	UpgradeTo         string            `json:"upgradeTo,omitempty"`
}

// RestartStats summarizes the watchdog's recent restart activity for the
// failover heartbeat payload. Pulled out of RecoveryManager to keep
// failover.go independent of recovery internals.
type RestartStats struct {
	Count24h      int
	LastRestartAt time.Time
	FlapDetected  bool
}

// Failover auth backoff (#2796). A watchdog in FAILOVER for a device whose
// credentials the server rejects used to POST /heartbeat every
// FailoverPollInterval (30s → 2880 requests/day) forever — ~50x the agent's
// own auth-dead rate. Rejections now back the client off exponentially with
// jitter: ~1m, 2m, 4m ... capped at 30m (the agent's own ceiling), i.e.
// roughly 48 attempts/day at steady state. It keeps retrying rather than
// giving up so a device that is re-approved or re-credentialed recovers on
// its own within one ceiling.
const (
	// failoverAuthThreshold consecutive rejections arm the backoff, so a
	// single transient 401 (deploy/restore blip) costs nothing extra.
	failoverAuthThreshold      = 2
	failoverAuthInitialBackoff = 1 * time.Minute
	failoverAuthMaxBackoff     = 30 * time.Minute
	failoverAuthJitter         = 0.2
)

// ErrAuthBackoff is returned WITHOUT sending a request while the server has
// been rejecting the watchdog's credentials and the backoff window has not
// elapsed. Callers treat it as a skipped tick, not a failure.
var ErrAuthBackoff = errors.New("failover: skipped, server rejected watchdog credentials; backing off")

// AuthRejectedError is a 401/403 response from the API.
type AuthRejectedError struct {
	Op         string
	StatusCode int
	Body       string
}

func (e *AuthRejectedError) Error() string {
	return fmt.Sprintf("failover: %s returned %d: %s", e.Op, e.StatusCode, e.Body)
}

// IsAuthRejected reports whether err is (or wraps) an AuthRejectedError.
func IsAuthRejected(err error) bool {
	var ae *AuthRejectedError
	return errors.As(err, &ae)
}

// NewFailoverAuthMonitor returns the auth monitor schedule the failover
// client uses. Extra options (tests) are applied after the defaults.
func NewFailoverAuthMonitor(opts ...authstate.Option) *authstate.Monitor {
	base := []authstate.Option{
		authstate.WithBackoff(failoverAuthInitialBackoff, failoverAuthMaxBackoff),
		authstate.WithJitter(failoverAuthJitter),
	}
	return authstate.NewMonitor(failoverAuthThreshold, append(base, opts...)...)
}

func isAuthStatus(code int) bool {
	return code == http.StatusUnauthorized || code == http.StatusForbidden
}

// FailoverClient is an HTTP client for API communication during failover mode.
type FailoverClient struct {
	mu      sync.RWMutex
	baseURL string
	agentID string
	token   string
	client  *http.Client
	// pollClient carries a longer timeout than the heartbeat client. The
	// commands GET is the ONLY channel through which an operator can revive
	// an agent while the watchdog is in FAILOVER, and in the field it has
	// been observed taking >30s server-side (connection-hold class, #1105)
	// — with a 30s client timeout every poll died with "context deadline
	// exceeded" and the escape hatch was permanently dead (#2763). Cost: the
	// poll runs synchronously in the main select loop, so a worst-case slow
	// server now stalls other ticks for up to 90s instead of 30s — in
	// FAILOVER there is nothing time-critical queued behind it (the 64-slot
	// IPC buffer absorbs the window), and a bounded stall beats a
	// permanently dead revive channel.
	pollClient *http.Client

	// auth gates SendHeartbeat/PollCommands on repeated 401/403s — see
	// ErrAuthBackoff. Replaceable via SetAuthMonitor so the backoff can
	// outlive one failover window.
	auth *authstate.Monitor
}

// NewFailoverClient creates a FailoverClient with a 30-second timeout. If
// tlsConfig is non-nil it is applied to the underlying transport.
func NewFailoverClient(baseURL, agentID, token string, tlsConfig *tls.Config) *FailoverClient {
	// Dials go through the last-known-good DNS cache (#2288) so a pure DNS
	// outage doesn't blind the watchdog; TLS hostname verification unchanged.
	transport := &http.Transport{DialContext: netcache.Shared().DialContext}
	if tlsConfig != nil {
		transport.TLSClientConfig = tlsConfig
	}
	return &FailoverClient{
		baseURL: baseURL,
		agentID: agentID,
		token:   token,
		client: &http.Client{
			Timeout:   30 * time.Second,
			Transport: transport,
		},
		pollClient: &http.Client{
			Timeout:   90 * time.Second,
			Transport: transport,
		},
		auth: NewFailoverAuthMonitor(),
	}
}

// SetAuthMonitor replaces the auth backoff monitor. The watchdog run loop
// passes one monitor for the life of the process: failoverClient is rebuilt
// on every FAILOVER entry, and a per-client monitor would restart the
// backoff from scratch each time.
func (c *FailoverClient) SetAuthMonitor(m *authstate.Monitor) {
	if m == nil {
		return
	}
	c.mu.Lock()
	c.auth = m
	c.mu.Unlock()
}

func (c *FailoverClient) authMonitor() *authstate.Monitor {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.auth
}

// AuthRetryIn reports how long until the next request is allowed through
// the auth backoff; zero when not backing off.
func (c *FailoverClient) AuthRetryIn() time.Duration {
	return c.authMonitor().RetryIn()
}

// noteAuthStatus feeds a response status into the auth monitor and returns
// the error to surface for a non-200 (nil for 200).
func (c *FailoverClient) noteAuthStatus(op string, code int, body []byte) error {
	m := c.authMonitor()
	switch {
	case code == http.StatusOK:
		m.RecordSuccess()
		return nil
	case isAuthStatus(code):
		m.RecordAuthFailure()
		return &AuthRejectedError{Op: op, StatusCode: code, Body: string(body)}
	default:
		return fmt.Errorf("failover: %s returned %d: %s", op, code, string(body))
	}
}

// UpdateToken replaces the auth token used for subsequent requests.
func (c *FailoverClient) UpdateToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = token
}

// BaseURL returns the base URL used for subsequent requests.
func (c *FailoverClient) BaseURL() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.baseURL
}

// SetBaseURL replaces the base URL used for subsequent requests.
func (c *FailoverClient) SetBaseURL(baseURL string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.baseURL = baseURL
}

// setHeaders attaches the standard watchdog headers to req.
func (c *FailoverClient) setHeaders(req *http.Request) {
	c.mu.RLock()
	token := c.token
	c.mu.RUnlock()
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-Breeze-Role", "watchdog")
}

// SendHeartbeat POSTs a watchdog heartbeat to the API and returns the parsed
// response. The request body includes role, watchdogState, agentVersion,
// mainAgentRestartCount24h, mainAgentLastRestartAt, flapDetected, and
// timestamp fields.
//
// The heartbeat intentionally does NOT send a journalExcerpt: the API
// heartbeat schema (apps/api/src/routes/agents/schemas.ts) has no such field
// and silently strips it, so shipping it was dead wire data. Diagnostic
// journal entries reach the server via ShipLogs / the /logs endpoint instead.
func (c *FailoverClient) SendHeartbeat(watchdogVersion, currentState string, restartStats RestartStats) (*HeartbeatResponse, error) {
	if c.authMonitor().ShouldSkip() {
		return nil, ErrAuthBackoff
	}
	// Build-edition capability signal (#4072): a reported edition tells the
	// server this binary carries the one-way self-host → hosted allowance in
	// updater.editionAllowed (both ship in the same build), so it may be
	// offered this deployment's artifact edition. Silent (older) watchdogs
	// fall back to server-side version-band inference.
	edition := "self-host"
	if hostpolicy.Enforced() {
		edition = "hosted"
	}
	body := map[string]any{
		"role":                     "watchdog",
		"watchdogState":            currentState,
		"status":                   "ok",
		"agentVersion":             watchdogVersion,
		"agentEdition":             edition,
		"timestamp":                time.Now().UTC().Format(time.RFC3339),
		"mainAgentRestartCount24h": restartStats.Count24h,
		"flapDetected":             restartStats.FlapDetected,
	}
	if !restartStats.LastRestartAt.IsZero() {
		body["mainAgentLastRestartAt"] = restartStats.LastRestartAt.UTC().Format(time.RFC3339)
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("failover: marshal heartbeat: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", c.BaseURL(), c.agentID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failover: build heartbeat request: %w", err)
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failover: heartbeat request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if err := c.noteAuthStatus("heartbeat", resp.StatusCode, respBody); err != nil {
		return nil, err
	}

	var result HeartbeatResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failover: decode heartbeat response: %w", err)
	}
	return &result, nil
}

// PollCommands GETs pending commands from the API with role=watchdog.
func (c *FailoverClient) PollCommands() ([]FailoverCommand, error) {
	if c.authMonitor().ShouldSkip() {
		return nil, ErrAuthBackoff
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/commands?role=watchdog", c.BaseURL(), c.agentID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("failover: build poll request: %w", err)
	}
	c.setHeaders(req)

	resp, err := c.pollClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failover: poll request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if err := c.noteAuthStatus("poll", resp.StatusCode, respBody); err != nil {
		return nil, err
	}

	var result struct {
		Commands []FailoverCommand `json:"commands"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failover: decode poll response: %w", err)
	}
	return result.Commands, nil
}

// SubmitCommandResult POSTs a command result back to the API.
func (c *FailoverClient) SubmitCommandResult(commandID, status string, result any, errMsg string) error {
	body := map[string]any{
		"status": status,
		"result": result,
	}
	if errMsg != "" {
		body["error"] = errMsg
	}

	data, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failover: marshal command result: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", c.BaseURL(), c.agentID, commandID)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("failover: build result request: %w", err)
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failover: result request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failover: submit result returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// apiLogEntry mirrors the API's agent diagnostic-log ingest contract
// (apps/api/src/routes/agents/logs.ts, agentLogEntrySchema). The endpoint
// requires an OBJECT `{ logs: [...] }` whose entries carry timestamp/level/
// component/message(+optional fields) — NOT the watchdog's raw JournalEntry
// shape ({time, level, event, data}). We translate here so the watchdog
// speaks the API's existing contract rather than loosening the API.
type apiLogEntry struct {
	Timestamp string         `json:"timestamp"`
	Level     string         `json:"level"`
	Component string         `json:"component"`
	Message   string         `json:"message"`
	Fields    map[string]any `json:"fields,omitempty"`
}

// apiLogBatch is the request body wrapper the /logs endpoint requires.
type apiLogBatch struct {
	Logs []apiLogEntry `json:"logs"`
}

const (
	// shipLogsMaxBatchEntries matches the API's z.array(...).max(200) cap.
	shipLogsMaxBatchEntries = 200
	// shipLogsMaxBatchBytes keeps each POST comfortably under the API's 256KB
	// bodyLimit (the watchdog posts uncompressed), leaving headroom for JSON
	// framing overhead.
	shipLogsMaxBatchBytes = 240 * 1024
	// shipLogsMaxMessageLen matches the API's message .max(10000). Trim rather
	// than let one long line 400 the whole batch.
	shipLogsMaxMessageLen = 10000
	// shipLogsMaxFieldsBytes matches the API's fields 32KB refine. Drop
	// oversized data rather than reject the batch.
	shipLogsMaxFieldsBytes = 32000
)

// normalizeLogLevel maps a journal level onto the API's accepted enum
// (debug/info/warn/error). Watchdog levels (info/warn/error) already fall
// within it; anything unexpected degrades to "info" so a stray level can't
// reject the batch.
func normalizeLogLevel(level string) string {
	switch level {
	case "debug", "info", "warn", "error":
		return level
	default:
		return LevelInfo
	}
}

// journalEntryToAPI translates a watchdog JournalEntry into the API's log
// entry shape (time→timestamp RFC3339, event→message, fixed component, data→
// fields), enforcing the endpoint's per-field size limits.
func journalEntryToAPI(entry JournalEntry) apiLogEntry {
	message := entry.Event
	if len(message) > shipLogsMaxMessageLen {
		message = message[:shipLogsMaxMessageLen]
	}
	out := apiLogEntry{
		Timestamp: entry.Time.UTC().Format(time.RFC3339),
		Level:     normalizeLogLevel(entry.Level),
		Component: "watchdog",
		Message:   message,
	}
	if len(entry.Data) > 0 {
		if b, err := json.Marshal(entry.Data); err == nil && len(b) <= shipLogsMaxFieldsBytes {
			out.Fields = entry.Data
		}
	}
	return out
}

// ShipLogs translates watchdog journal entries into the API's diagnostic-log
// ingest contract and POSTs them in batches (respecting the API's 200-entry
// cap and 256KB body limit). It returns the number of entries successfully
// shipped and, if any batch failed, the first error encountered. Callers use
// the shipped count to distinguish a total failure (0 shipped) from a partial
// one (some shipped) so the command result isn't falsely reported "completed".
func (c *FailoverClient) ShipLogs(entries []JournalEntry) (int, error) {
	if len(entries) == 0 {
		return 0, nil
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/logs", c.BaseURL(), c.agentID)

	shipped := 0
	var firstErr error

	batch := make([]apiLogEntry, 0, shipLogsMaxBatchEntries)
	batchBytes := 0

	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := c.postLogBatch(url, batch); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		} else {
			shipped += len(batch)
		}
		batch = batch[:0]
		batchBytes = 0
	}

	for _, entry := range entries {
		apiEntry := journalEntryToAPI(entry)
		// Approximate the serialized size (+1 for the joining comma) so a batch
		// never crosses the API body limit mid-flight.
		entryBytes := shipLogsMaxMessageLen // conservative fallback
		if b, err := json.Marshal(apiEntry); err == nil {
			entryBytes = len(b) + 1
		}
		if len(batch) > 0 && (len(batch) >= shipLogsMaxBatchEntries || batchBytes+entryBytes > shipLogsMaxBatchBytes) {
			flush()
		}
		batch = append(batch, apiEntry)
		batchBytes += entryBytes
	}
	flush()

	return shipped, firstErr
}

// postLogBatch POSTs a single translated batch to the /logs endpoint.
func (c *FailoverClient) postLogBatch(url string, batch []apiLogEntry) error {
	data, err := json.Marshal(apiLogBatch{Logs: batch})
	if err != nil {
		return fmt.Errorf("failover: marshal logs: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("failover: build logs request: %w", err)
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("failover: logs request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	// Accept any 2xx: the /logs endpoint returns 201 (all inserted) or 207
	// (partial insert) — both mean the batch was received. (ShipLogs never
	// POSTs an empty batch; it early-returns on zero entries.)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("failover: ship logs returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}
