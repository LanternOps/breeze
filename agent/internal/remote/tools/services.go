package tools

import (
	"fmt"
	"time"
)

// ListServices returns a list of system services
// Platform-specific implementations are in services_*.go files
func ListServices(payload map[string]any) CommandResult {
	startTime := time.Now()

	page := GetPayloadInt(payload, "page", 1)
	limit := GetPayloadInt(payload, "limit", 50)
	search := GetPayloadString(payload, "search", "")
	status := GetPayloadString(payload, "status", "")

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
	}

	return NewSuccessResult(response, time.Since(startTime).Milliseconds())
}

// GetService returns details for a specific service
func GetService(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := GetPayloadString(payload, "name", "")
	if name == "" {
		return NewErrorResult(fmt.Errorf("service name is required"), time.Since(startTime).Milliseconds())
	}

	service, err := getServiceOS(name)
	if err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	return NewSuccessResult(service, time.Since(startTime).Milliseconds())
}

// StartService starts a stopped service
func StartService(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := GetPayloadString(payload, "name", "")
	if name == "" {
		return NewErrorResult(fmt.Errorf("service name is required"), time.Since(startTime).Milliseconds())
	}

	err := startServiceOS(name)
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
	if name == "" {
		return NewErrorResult(fmt.Errorf("service name is required"), time.Since(startTime).Milliseconds())
	}

	err := stopServiceOS(name)
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
	if name == "" {
		return NewErrorResult(fmt.Errorf("service name is required"), time.Since(startTime).Milliseconds())
	}

	err := restartServiceOS(name)
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
