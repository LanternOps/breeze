package tools

import (
	"fmt"
	"strings"
	"time"
)

func validateServiceName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", fmt.Errorf("service name is required")
	}
	if trimmed != name {
		return "", fmt.Errorf("service name must not include leading or trailing whitespace")
	}
	if _, truncated := truncateStringBytes(trimmed, maxServiceFieldBytes); truncated {
		return "", fmt.Errorf("service name exceeds maximum length of %d bytes", maxServiceFieldBytes)
	}
	if strings.Contains(trimmed, "..") || strings.ContainsAny(trimmed, "/\\\x00\r\n\t ") {
		return "", fmt.Errorf("service name contains invalid characters")
	}
	return trimmed, nil
}

// ListServices returns a list of system services
// Platform-specific implementations are in services_*.go files
func ListServices(payload map[string]any) CommandResult {
	startTime := time.Now()

	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)
	search := GetPayloadString(payload, "search", "")
	status := GetPayloadString(payload, "status", "")
	search, _ = truncateStringBytes(search, maxServiceFieldBytes)
	status, _ = truncateStringBytes(status, maxServiceFieldBytes)

	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 500 {
		limit = 50
	}

	services, err := listServicesOS(search, status)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	services, truncated := sanitizeServiceList(services)

	// Paginate
	total := len(services)
	totalPages := (total + limit - 1) / limit
	start := (page - 1) * limit
	end := start + limit

	if start > total {
		start = total
	}
	if end > total {
		end = total
	}

	response := ServiceListResponse{
		Services:   services[start:end],
		Total:      total,
		Page:       page,
		Limit:      limit,
		TotalPages: totalPages,
		Truncated:  truncated,
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

// GetService returns details for a specific service
func GetService(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := GetPayloadString(payload, "name", "")
	var err error
	name, err = validateServiceName(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	service, err := getServiceOS(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	serviceValue, _ := sanitizeServiceInfo(*service)

	return NewSuccessResult(serviceValue, time.Since(startTime).Milliseconds())
}

// StartService starts a stopped service
func StartService(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := GetPayloadString(payload, "name", "")
	var err error
	name, err = validateServiceName(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	err = startServiceOS(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":    name,
		"action":  "start",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

// StopService stops a running service
func StopService(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := GetPayloadString(payload, "name", "")
	var err error
	name, err = validateServiceName(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if isAgentService(name) {
		return NewErrorResult(
			fmt.Errorf("cannot stop the Breeze agent service — the device will go offline and become unreachable"),
			time.Since(startTime).Milliseconds(),
		)
	}

	err = stopServiceOS(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":    name,
		"action":  "stop",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

// RestartService restarts a service
func RestartService(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := GetPayloadString(payload, "name", "")
	var err error
	name, err = validateServiceName(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if isAgentService(name) {
		return RestartAgentService(startTime)
	}

	err = restartServiceOS(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":    name,
		"action":  "restart",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}
