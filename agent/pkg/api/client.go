package api

import (
	"bytes"
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
	EnrollmentKey string        `json:"enrollmentKey"`
	Hostname      string        `json:"hostname"`
	OSType        string        `json:"osType"`
	OSVersion     string        `json:"osVersion"`
	Architecture  string        `json:"architecture"`
	AgentVersion  string        `json:"agentVersion,omitempty"`
	HardwareInfo  *HardwareInfo `json:"hardwareInfo,omitempty"`
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

type EnrollResponse struct {
	AgentID   string      `json:"agentId"`
	AuthToken string      `json:"authToken"`
	OrgID     string      `json:"orgId"`
	SiteID    string      `json:"siteId"`
	Config    AgentConfig `json:"config"`
}

type AgentConfig struct {
	HeartbeatIntervalSeconds int      `json:"heartbeatIntervalSeconds"`
	MetricsIntervalSeconds   int      `json:"metricsIntervalSeconds"`
	EnabledCollectors        []string `json:"enabledCollectors"`
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
