package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrHTTPStatus is returned by the api client when an HTTP request
// completes but the server returned a non-success status code. Callers
// can type-assert via errors.As to classify the failure (auth, not
// found, rate limit, server error).
type ErrHTTPStatus struct {
	StatusCode int
	Body       string
}

func (e *ErrHTTPStatus) Error() string {
	return fmt.Sprintf("http %d: %s", e.StatusCode, e.Body)
}

type Client struct {
	baseURL    string
	authToken  string
	agentID    string
	httpClient *http.Client
}

type EnrollRequest struct {
	EnrollmentKey    string        `json:"enrollmentKey"`
	EnrollmentSecret string        `json:"enrollmentSecret,omitempty"`
	Hostname         string        `json:"hostname"`
	OSType           string        `json:"osType"`
	OSVersion        string        `json:"osVersion"`
	Architecture     string        `json:"architecture"`
	AgentVersion     string        `json:"agentVersion,omitempty"`
	DeviceRole       string        `json:"deviceRole,omitempty"`
	HardwareInfo     *HardwareInfo `json:"hardwareInfo,omitempty"`
}

type HardwareInfo struct {
	CPUModel     string `json:"cpuModel,omitempty"`
	CPUCores     int    `json:"cpuCores,omitempty"`
	CPUThreads   int    `json:"cpuThreads,omitempty"`
	RAMTotalMB   uint64 `json:"ramTotalMb,omitempty"`
	DiskTotalGB  uint64 `json:"diskTotalGb,omitempty"`
	GPUModel     string `json:"gpuModel,omitempty"`
	SerialNumber string `json:"serialNumber,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	BIOSVersion  string `json:"biosVersion,omitempty"`
}

type MtlsCertData struct {
	Certificate  string `json:"certificate"`
	PrivateKey   string `json:"privateKey"`
	ExpiresAt    string `json:"expiresAt"`
	SerialNumber string `json:"serialNumber"`
}

type EnrollResponse struct {
	AgentID           string             `json:"agentId"`
	AuthToken         string             `json:"authToken"`
	WatchdogAuthToken string             `json:"watchdogAuthToken"`
	HelperAuthToken   string             `json:"helperAuthToken"`
	OrgID             string             `json:"orgId"`
	SiteID            string             `json:"siteId"`
	Config            AgentConfig        `json:"config"`
	Mtls              *MtlsCertData      `json:"mtls"`
	ManifestTrustKeys []ManifestTrustKey `json:"manifestTrustKeys,omitempty"`
}

// ManifestTrustKey is a per-deployment Ed25519 pubkey delivered at enrollment
// for self-host agent updates (#625). The agent pins these alongside the
// embedded LanternOps trust root.
type ManifestTrustKey struct {
	KeyID        string `json:"keyId"`
	PublicKeyB64 string `json:"publicKeyB64"`
	ValidFrom    string `json:"validFrom,omitempty"`
}

type RenewCertResponse struct {
	Mtls        *MtlsCertData `json:"mtls"`
	Quarantined bool          `json:"quarantined,omitempty"`
	Error       string        `json:"error,omitempty"`
}

type RotateTokenResponse struct {
	AuthToken         string `json:"authToken"`
	WatchdogAuthToken string `json:"watchdogAuthToken"`
	HelperAuthToken   string `json:"helperAuthToken"`
	RotatedAt         string `json:"rotatedAt"`
}

type AgentConfig struct {
	HeartbeatIntervalSeconds         int      `json:"heartbeatIntervalSeconds"`
	MetricsCollectionIntervalSeconds int      `json:"metricsCollectionIntervalSeconds"`
	EnabledCollectors                []string `json:"enabledCollectors,omitempty"`
}

// refuseUntrustedRedirect is the http.Client.CheckRedirect policy for the agent
// API client. Every request the client makes carries the device token — Enroll
// sends it as the custom x-agent-reenrollment-token header, the other calls send
// it as Authorization: Bearer. Go follows redirects by default and, while it
// drops Authorization/Cookie once a redirect leaves the original domain (it
// still trusts subdomains), it forwards arbitrary custom headers — so a
// compromised or MITM'd server could 30x a request to a host it controls and
// harvest the token.
//
// Merely stripping the headers is not enough: following the redirect would still
// hand the request body (during enroll: hostname, hardware serial, OS info) to
// the attacker and let it forge the response the agent parses and persists
// (e.g. authToken / mTLS cert). A legitimate Breeze server never redirects an
// agent to a different host, so refuse the redirect outright and surface it to
// the caller (which wraps the resulting error). Trusted redirects on the same
// endpoint — a different path, or an http->https upgrade — are still followed.
// An https->http downgrade is refused because it would expose the token over
// cleartext. See #1043.
func refuseUntrustedRedirect(req *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	prev := via[len(via)-1]
	// The hostname is the trust boundary: the agent already trusts its
	// configured server, so a same-host redirect (different path or port, or
	// an http->https upgrade) is fine, but a redirect to any other host is not.
	// Compared case-insensitively since hostnames are.
	if !strings.EqualFold(req.URL.Hostname(), prev.URL.Hostname()) {
		return fmt.Errorf("refusing redirect from host %s to untrusted host %s during credentialed request", prev.URL.Hostname(), req.URL.Hostname())
	}
	if prev.URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("refusing https->%s downgrade redirect to %s during credentialed request", req.URL.Scheme, req.URL.Hostname())
	}
	return nil
}

func NewClient(baseURL, authToken, agentID string) *Client {
	return &Client{
		baseURL:   baseURL,
		authToken: authToken,
		agentID:   agentID,
		httpClient: &http.Client{
			Timeout:       30 * time.Second,
			CheckRedirect: refuseUntrustedRedirect,
		},
	}
}

// NewClientWithTLS creates a client that presents a client certificate in TLS handshakes.
func NewClientWithTLS(baseURL, authToken, agentID string, tlsCfg *tls.Config) *Client {
	transport := &http.Transport{}
	if tlsCfg != nil {
		transport.TLSClientConfig = tlsCfg
	}
	return &Client{
		baseURL:   baseURL,
		authToken: authToken,
		agentID:   agentID,
		httpClient: &http.Client{
			Timeout:       30 * time.Second,
			Transport:     transport,
			CheckRedirect: refuseUntrustedRedirect,
		},
	}
}

func (c *Client) Enroll(req *EnrollRequest) (*EnrollResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal enroll request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", c.baseURL+"/api/v1/agents/enroll", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	// On a forced re-enrollment the agent still holds its existing device
	// token (loaded from secrets.yaml into the client). Present it so the
	// server can match the existing device row and re-enroll it in place
	// rather than treating this as a brand-new device and 409-ing on the
	// hostname collision with the agent's own active row. The server reads
	// this header in the enrollment route's existing-device branch. Empty on
	// a fresh enroll (no stored token) -> header omitted, behaviour
	// unchanged. See #1028.
	if c.authToken != "" {
		httpReq.Header.Set("x-agent-reenrollment-token", c.authToken)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, &ErrHTTPStatus{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
	}

	var enrollResp EnrollResponse
	if err := json.NewDecoder(resp.Body).Decode(&enrollResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &enrollResp, nil
}

func (c *Client) SubmitCommandResult(commandID string, result interface{}) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", c.baseURL, c.agentID, commandID)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("submit result failed with status %d", resp.StatusCode)
	}

	return nil
}

// RenewCert requests a new mTLS certificate from the server.
// This endpoint does not require mTLS itself (WAF-excluded), only bearer auth.
func (c *Client) RenewCert() (*RenewCertResponse, error) {
	url := fmt.Sprintf("%s/api/v1/agents/renew-cert", c.baseURL)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create renew-cert request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send renew-cert request: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read renew-cert response body: %w", err)
	}

	// Check status code before attempting to parse JSON
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusForbidden {
		return nil, fmt.Errorf("renew-cert failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var result RenewCertResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to decode renew-cert response (status %d): %w", resp.StatusCode, err)
	}

	if resp.StatusCode == http.StatusForbidden {
		return &result, nil // caller checks Quarantined or Error
	}

	return &result, nil
}

func (c *Client) RotateToken() (*RotateTokenResponse, error) {
	url := fmt.Sprintf("%s/api/v1/agents/%s/rotate-token", c.baseURL, c.agentID)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create rotate-token request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send rotate-token request: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read rotate-token response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rotate-token failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var result RotateTokenResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to decode rotate-token response: %w", err)
	}

	return &result, nil
}
