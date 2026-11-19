//go:build windows

package security

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// GetDefenderStatus queries Microsoft Defender status via PowerShell. It
// returns an error wrapping ErrNotSupported when Defender is absent or
// disabled on this host (see defender_availability.go, #10908).
func GetDefenderStatus() (DefenderStatus, error) {
	return collectDefenderStatus()
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
	cmd := procspawn.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to trigger defender scan: %w", err)
	}
	return nil
}
