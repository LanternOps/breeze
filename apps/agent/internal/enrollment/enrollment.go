package enrollment

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/collector"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/pkg/models"
	"go.uber.org/zap"
)

// EnrollmentError represents an enrollment-specific error
type EnrollmentError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *EnrollmentError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Common enrollment error codes
const (
	ErrCodeInvalidKey    = "INVALID_KEY"
	ErrCodeExpiredKey    = "EXPIRED_KEY"
	ErrCodeLimitReached  = "LIMIT_REACHED"
	ErrCodeServerError   = "SERVER_ERROR"
	ErrCodeNetworkError  = "NETWORK_ERROR"
)

// EnrollmentManager handles device enrollment with the Breeze server
type EnrollmentManager struct {
	config   *config.Config
	hardware *collector.HardwareCollector
	logger   *zap.Logger
	client   *http.Client
}

// New creates a new EnrollmentManager
func New(cfg *config.Config, hw *collector.HardwareCollector, logger *zap.Logger) *EnrollmentManager {
	// Configure HTTP client with TLS settings
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.InsecureSkipVerify,
		},
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}

	return &EnrollmentManager{
		config:   cfg,
		hardware: hw,
		logger:   logger,
		client:   client,
	}
}

// Enroll registers this device with the Breeze server
func (e *EnrollmentManager) Enroll(enrollmentKey string) (*models.EnrollmentResponse, error) {
	e.logger.Info("Starting enrollment process",
		zap.String("server", e.config.ServerURL))

	// Collect device information
	deviceInfo := GetDeviceInfo()
	e.logger.Debug("Collected device info",
		zap.String("hostname", deviceInfo.Hostname),
		zap.String("os", deviceInfo.OS),
		zap.String("arch", deviceInfo.Architecture))

	// Collect hardware information
	hwData, err := e.hardware.Collect()
	if err != nil {
		e.logger.Warn("Hardware collection had errors", zap.Error(err))
	}

	hardwareInfo, ok := hwData.(models.HardwareInfo)
	if !ok {
		e.logger.Warn("Failed to type assert hardware info, using empty struct")
		hardwareInfo = models.HardwareInfo{}
	}

	e.logger.Debug("Collected hardware info",
		zap.String("cpu", hardwareInfo.CPU.Model),
		zap.Uint64("memory", hardwareInfo.Memory.Total))

	// Build enrollment request
	request := models.EnrollmentRequest{
		EnrollmentKey: enrollmentKey,
		Device:        deviceInfo,
		Hardware:      hardwareInfo,
	}

	// Send enrollment request
	response, err := e.sendEnrollmentRequest(request)
	if err != nil {
		e.logger.Error("Enrollment failed", zap.Error(err))
		return nil, err
	}

	// Save credentials to config
	if err := e.saveCredentials(response); err != nil {
		e.logger.Error("Failed to save credentials", zap.Error(err))
		return nil, fmt.Errorf("enrollment succeeded but failed to save credentials: %w", err)
	}

	e.logger.Info("Enrollment successful",
		zap.String("deviceId", response.DeviceID),
		zap.String("orgId", response.OrgID))

	return response, nil
}

// sendEnrollmentRequest sends the enrollment request to the server
func (e *EnrollmentManager) sendEnrollmentRequest(request models.EnrollmentRequest) (*models.EnrollmentResponse, error) {
	// Marshal request to JSON
	body, err := json.Marshal(request)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal enrollment request: %w", err)
	}

	// Build URL
	url := fmt.Sprintf("%s/api/agents/enroll", e.config.ServerURL)

	// Create HTTP request
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", fmt.Sprintf("Breeze-Agent/%s", AgentVersion))

	// Send request
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, &EnrollmentError{
			Code:    ErrCodeNetworkError,
			Message: fmt.Sprintf("failed to connect to server: %v", err),
		}
	}
	defer resp.Body.Close()

	// Read response body
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Handle error responses
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, e.handleErrorResponse(resp.StatusCode, respBody)
	}

	// Parse successful response
	var response models.EnrollmentResponse
	if err := json.Unmarshal(respBody, &response); err != nil {
		return nil, fmt.Errorf("failed to parse enrollment response: %w", err)
	}

	return &response, nil
}

// handleErrorResponse converts HTTP error responses to EnrollmentError
func (e *EnrollmentManager) handleErrorResponse(statusCode int, body []byte) *EnrollmentError {
	// Try to parse error response from server
	var serverError struct {
		Error   string `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}

	if err := json.Unmarshal(body, &serverError); err == nil && serverError.Code != "" {
		return &EnrollmentError{
			Code:    serverError.Code,
			Message: serverError.Message,
		}
	}

	// Map HTTP status codes to error codes
	switch statusCode {
	case http.StatusBadRequest:
		return &EnrollmentError{
			Code:    ErrCodeInvalidKey,
			Message: "Invalid enrollment key",
		}
	case http.StatusUnauthorized:
		return &EnrollmentError{
			Code:    ErrCodeInvalidKey,
			Message: "Enrollment key not found or invalid",
		}
	case http.StatusForbidden:
		return &EnrollmentError{
			Code:    ErrCodeExpiredKey,
			Message: "Enrollment key has expired",
		}
	case http.StatusConflict:
		return &EnrollmentError{
			Code:    ErrCodeLimitReached,
			Message: "Enrollment limit reached for this key",
		}
	case http.StatusTooManyRequests:
		return &EnrollmentError{
			Code:    ErrCodeLimitReached,
			Message: "Too many enrollment attempts",
		}
	default:
		return &EnrollmentError{
			Code:    ErrCodeServerError,
			Message: fmt.Sprintf("Server error (status %d): %s", statusCode, string(body)),
		}
	}
}

// saveCredentials persists the enrollment credentials to the config file
func (e *EnrollmentManager) saveCredentials(response *models.EnrollmentResponse) error {
	e.config.DeviceID = response.DeviceID
	e.config.APIKey = response.APIKey
	e.config.OrgID = response.OrgID
	e.config.SiteID = response.SiteID

	return e.config.Save()
}

// IsEnrolled checks if the device is already enrolled
func (e *EnrollmentManager) IsEnrolled() bool {
	return e.config.DeviceID != "" && e.config.APIKey != ""
}

// GetDeviceID returns the enrolled device ID
func (e *EnrollmentManager) GetDeviceID() string {
	return e.config.DeviceID
}

// GetOrgID returns the enrolled organization ID
func (e *EnrollmentManager) GetOrgID() string {
	return e.config.OrgID
}

// GetAPIKey returns the API key (for authenticated requests)
func (e *EnrollmentManager) GetAPIKey() string {
	return e.config.APIKey
}
