package watchdog

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
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

// FailoverClient is an HTTP client for API communication during failover mode.
type FailoverClient struct {
	baseURL string
	agentID string
	token   string
	client  *http.Client
}

// NewFailoverClient creates a FailoverClient with a 30-second timeout. If
// tlsConfig is non-nil it is applied to the underlying transport.
func NewFailoverClient(baseURL, agentID, token string, tlsConfig *tls.Config) *FailoverClient {
	transport := &http.Transport{}
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
	}
}

// UpdateToken replaces the auth token used for subsequent requests.
func (c *FailoverClient) UpdateToken(token string) {
	c.token = token
}

// setHeaders attaches the standard watchdog headers to req.
func (c *FailoverClient) setHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Breeze-Role", "watchdog")
}

// SendHeartbeat POSTs a watchdog heartbeat to the API and returns the parsed
// response. The request body includes role, watchdogState, agentVersion,
// journalExcerpt, and timestamp fields.
func (c *FailoverClient) SendHeartbeat(watchdogVersion, currentState string, journalEntries []JournalEntry) (*HeartbeatResponse, error) {
	body := map[string]any{
		"role":           "watchdog",
		"watchdogState":  currentState,
		"status":         "ok",
		"agentVersion":   watchdogVersion,
		"journalExcerpt": journalEntries,
		"timestamp":      time.Now().UTC().Format(time.RFC3339),
	}

	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("failover: marshal heartbeat: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", c.baseURL, c.agentID)
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
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failover: heartbeat returned %d: %s", resp.StatusCode, string(respBody))
	}

	var result HeartbeatResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failover: decode heartbeat response: %w", err)
	}
	return &result, nil
}

// PollCommands GETs pending commands from the API with role=watchdog.
func (c *FailoverClient) PollCommands() ([]FailoverCommand, error) {
	url := fmt.Sprintf("%s/api/v1/agents/%s/commands?role=watchdog", c.baseURL, c.agentID)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("failover: build poll request: %w", err)
	}
	c.setHeaders(req)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failover: poll request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failover: poll returned %d: %s", resp.StatusCode, string(respBody))
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

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", c.baseURL, c.agentID, commandID)
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

// ShipLogs POSTs a batch of journal entries to the agent logs endpoint.
func (c *FailoverClient) ShipLogs(entries []JournalEntry) error {
	data, err := json.Marshal(entries)
	if err != nil {
		return fmt.Errorf("failover: marshal logs: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/logs", c.baseURL, c.agentID)
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
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failover: ship logs returned %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}
