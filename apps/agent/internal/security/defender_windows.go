//go:build windows

package security

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

type defenderStatusRaw struct {
	AMServiceEnabled              bool   `json:"AMServiceEnabled"`
	AntispywareEnabled            bool   `json:"AntispywareEnabled"`
	AntivirusEnabled              bool   `json:"AntivirusEnabled"`
	RealTimeProtectionEnabled     bool   `json:"RealTimeProtectionEnabled"`
	AntivirusSignatureVersion     string `json:"AntivirusSignatureVersion"`
	AntivirusSignatureLastUpdated string `json:"AntivirusSignatureLastUpdated"`
	QuickScanEndTime              string `json:"QuickScanEndTime"`
	FullScanEndTime               string `json:"FullScanEndTime"`
}

// GetDefenderStatus queries Microsoft Defender status via PowerShell.
func GetDefenderStatus() (DefenderStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	command := "Get-MpComputerStatus | Select-Object AMServiceEnabled,AntispywareEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureVersion,AntivirusSignatureLastUpdated,QuickScanEndTime,FullScanEndTime | ConvertTo-Json -Compress"
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return DefenderStatus{}, fmt.Errorf("defender status timed out")
	}
	if err != nil {
		return DefenderStatus{}, fmt.Errorf("defender status command failed: %w", err)
	}

	payload := strings.TrimSpace(string(output))
	if payload == "" {
		return DefenderStatus{}, fmt.Errorf("empty defender status output")
	}
	if idx := strings.LastIndex(payload, "{"); idx > 0 {
		payload = payload[idx:]
	}

	var raw defenderStatusRaw
	if err := json.Unmarshal([]byte(payload), &raw); err != nil {
		return DefenderStatus{}, fmt.Errorf("failed to parse defender status: %w", err)
	}

	enabled := raw.AntivirusEnabled || raw.AntispywareEnabled || raw.AMServiceEnabled

	return DefenderStatus{
		Enabled:              enabled,
		RealTimeProtection:   raw.RealTimeProtectionEnabled,
		DefinitionsVersion:   strings.TrimSpace(raw.AntivirusSignatureVersion),
		DefinitionsUpdatedAt: normalizeTimeString(raw.AntivirusSignatureLastUpdated),
		LastQuickScan:        normalizeTimeString(raw.QuickScanEndTime),
		LastFullScan:         normalizeTimeString(raw.FullScanEndTime),
	}, nil
}

// TriggerDefenderScan invokes a Defender scan via PowerShell.
func TriggerDefenderScan(scanType string) error {
	mode := "QuickScan"
	switch strings.ToLower(strings.TrimSpace(scanType)) {
	case "quick", "quickscan":
		mode = "QuickScan"
	case "full", "fullscan":
		mode = "FullScan"
	default:
		return fmt.Errorf("invalid defender scan type: %s", scanType)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	command := fmt.Sprintf("Start-MpScan -ScanType %s", mode)
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to trigger defender scan: %w", err)
	}
	return nil
}

func normalizeTimeString(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}

	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05",
		"1/2/2006 3:04:05 PM",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC().Format(time.RFC3339)
		}
	}
	return value
}
