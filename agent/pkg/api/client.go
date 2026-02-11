package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

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
	AgentID   string        `json:"agentId"`
	AuthToken string        `json:"authToken"`
	OrgID     string        `json:"orgId"`
	SiteID    string        `json:"siteId"`
	Config    AgentConfig   `json:"config"`
	Mtls      *MtlsCertData `json:"mtls"`
}

type RenewCertResponse struct {
	Mtls        *MtlsCertData `json:"mtls"`
	Quarantined bool          `json:"quarantined,omitempty"`
	Error       string        `json:"error,omitempty"`
}

type AgentConfig struct {
	HeartbeatIntervalSeconds         int      `json:"heartbeatIntervalSeconds"`
	MetricsCollectionIntervalSeconds int      `json:"metricsCollectionIntervalSeconds"`
	EnabledCollectors                []string `json:"enabledCollectors,omitempty"`
}

func NewClient(baseURL, authToken, agentID string) *Client {
	return &Client{
		baseURL:   baseURL,
		authToken: authToken,
		agentID:   agentID,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
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
			Timeout:   30 * time.Second,
			Transport: transport,
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

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("enrollment failed with status %d: %s", resp.StatusCode, string(bodyBytes))
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
