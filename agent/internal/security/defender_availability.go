package security

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// Microsoft Defender availability gate (#10908).
//
// GetDefenderStatus runs on every Windows security tick. Windows Server with
// the Windows-Defender feature removed has no Get-MpComputerStatus cmdlet, and
// a host whose Defender service is disabled by policy or by a third-party AV
// fails the cmdlet with HRESULT 0x800106ba. Without a gate both spawned
// PowerShell and failed every five minutes, forever, as a collection warning.
// The status call checks this one cached answer first and reports
// ErrNotSupported (which CollectStatus skips silently) when Defender is absent.
// Same shape as the BitLocker gate (#10902, bitlocker_availability.go).

// defenderAvailabilityTTL is how long a definite answer (available or
// unavailable) is trusted. Installing the Defender feature needs a reboot and
// removing a third-party AV re-enables Defender rarely; a day is soon enough.
const defenderAvailabilityTTL = 24 * time.Hour

// defenderServiceDisabledTTL is how long HRESULT 0x800106ba ("service not
// running") keeps the gate closed. It is shorter than the absent-cmdlet TTL
// because the condition is not always permanent: WinDefend may not have
// started yet at boot, or a third-party AV may have just been removed. An
// hour still cuts the failing spawn from every tick to one per hour.
const defenderServiceDisabledTTL = time.Hour

// defenderStatusPS is the per-tick Defender status query.
const defenderStatusPS = "Get-MpComputerStatus | Select-Object AMServiceEnabled,AntispywareEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureVersion,AntivirusSignatureLastUpdated,QuickScanEndTime,FullScanEndTime | ConvertTo-Json -Compress"

// defenderGetCommandPS confirms the cmdlet is absent before the gate closes.
// It runs only when the module directory is missing, at most once per TTL.
const defenderGetCommandPS = `if (Get-Command -Name Get-MpComputerStatus -ErrorAction SilentlyContinue) { 'available' } else { 'unavailable' }`

// errDefenderNotAvailable is returned while the gate is closed. It wraps
// ErrNotSupported: Defender being absent is a property of the host, not a
// failed read.
var errDefenderNotAvailable = fmt.Errorf("microsoft defender is not available on this host: %w", ErrNotSupported)

var errDefenderStatusTimeout = errors.New("defender status timed out")

// runDefenderPowerShell runs one Defender PowerShell script and returns the
// combined output even when the command fails, so the caller can read the
// HRESULT PowerShell wrote to stderr. It is the only spawn path for the
// Defender status probe, so tests can count spawns.
var runDefenderPowerShell = func(timeout time.Duration, script string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := procspawn.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(output), errDefenderStatusTimeout
	}
	return string(output), err
}

type defenderState int

const (
	// defenderIndeterminate: the check itself failed. The status call runs as
	// before so nothing is hidden; re-checked after slowProbeErrorTTL.
	defenderIndeterminate defenderState = iota
	defenderAvailable
	defenderUnavailable
)

type defenderAvailabilityProbe struct {
	now             func() time.Time
	moduleInstalled func() bool

	mu        sync.Mutex
	state     defenderState
	checkedAt time.Time
	valid     bool
	// closedFor is how long the current unavailable answer is trusted:
	// defenderAvailabilityTTL when the cmdlet is absent,
	// defenderServiceDisabledTTL after 0x800106ba.
	closedFor time.Duration
}

func newDefenderAvailabilityProbe() *defenderAvailabilityProbe {
	return &defenderAvailabilityProbe{now: time.Now, moduleInstalled: defenderModuleInstalled}
}

var defenderAvailability = newDefenderAvailabilityProbe()

// defenderModuleInstalled reports whether the inbox Defender PowerShell module
// is on disk. A stat, not a spawn, so hosts with Defender pay nothing. A miss
// costs one confirming Get-Command spawn per TTL, never a skipped probe.
func defenderModuleInstalled() bool {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	info, err := os.Stat(filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "Modules", "Defender"))
	return err == nil && info.IsDir()
}

// unavailable reports whether Defender is confirmed absent. An indeterminate
// check returns false so the caller falls back to running the status query.
func (p *defenderAvailabilityProbe) unavailable() bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.now()
	ttl := defenderAvailabilityTTL
	switch {
	case p.state == defenderIndeterminate:
		ttl = slowProbeErrorTTL
	case p.state == defenderUnavailable && p.closedFor > 0:
		ttl = p.closedFor
	}
	if !p.valid || now.Sub(p.checkedAt) >= ttl {
		prev, wasValid := p.state, p.valid
		p.state = p.detect()
		p.checkedAt = now
		p.valid = true
		p.closedFor = defenderAvailabilityTTL
		if p.state == defenderUnavailable && (!wasValid || prev != defenderUnavailable) {
			log.Debug("Get-MpComputerStatus is not available on this host; skipping Microsoft Defender status",
				"recheckIn", defenderAvailabilityTTL.String())
		}
	}
	return p.state == defenderUnavailable
}

// markUnavailable closes the gate for ttl after the status call itself proved
// Defender cannot answer on this host.
func (p *defenderAvailabilityProbe) markUnavailable(reason string, ttl time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.valid || p.state != defenderUnavailable {
		log.Debug("Microsoft Defender cannot report status on this host; skipping Defender status",
			"reason", reason, "recheckIn", ttl.String())
	}
	p.state = defenderUnavailable
	p.checkedAt = p.now()
	p.valid = true
	p.closedFor = ttl
}

func (p *defenderAvailabilityProbe) detect() defenderState {
	if p.moduleInstalled() {
		return defenderAvailable
	}
	output, err := runDefenderPowerShell(10*time.Second, defenderGetCommandPS)
	if err != nil {
		log.Debug("Defender availability check failed; querying Defender status ungated", "error", err.Error())
		return defenderIndeterminate
	}
	switch strings.TrimSpace(output) {
	case "available":
		return defenderAvailable
	case "unavailable":
		return defenderUnavailable
	default:
		log.Debug("Defender availability check returned unexpected output; querying Defender status ungated",
			"output", truncateForLog(strings.TrimSpace(output), 200))
		return defenderIndeterminate
	}
}

// Signatures in the status call's output that mean Defender cannot answer on
// this host. Both appear in FullyQualifiedErrorId, which is not localized.
const (
	// defenderServiceDisabledHRESULT: the Defender service is disabled by
	// policy or by a third-party AV (or not running yet).
	defenderServiceDisabledHRESULT = "0x800106ba"
	// defenderCmdletNotFound plus defenderCmdletNotFoundTarget: the module
	// directory survived but the cmdlet is gone. The target is matched in
	// CategoryInfo, not by name alone, because PowerShell echoes the whole
	// command line (which names Get-MpComputerStatus) for any missing command.
	defenderCmdletNotFound       = "commandnotfoundexception"
	defenderCmdletNotFoundTarget = "(get-mpcomputerstatus:string)"
)

// collectDefenderStatus is the Windows GetDefenderStatus implementation. It is
// platform-neutral (all spawns go through runDefenderPowerShell) so the gate
// is tested on every OS.
func collectDefenderStatus() (DefenderStatus, error) {
	if defenderAvailability.unavailable() {
		return DefenderStatus{}, errDefenderNotAvailable
	}

	output, err := runDefenderPowerShell(10*time.Second, defenderStatusPS)
	if err == nil {
		status, parseErr := parseDefenderStatus(output)
		if parseErr == nil {
			return status, nil
		}
		err = parseErr
	} else if !errors.Is(err, errDefenderStatusTimeout) {
		err = fmt.Errorf("defender status command failed: %w", err)
		if detail := strings.TrimSpace(output); detail != "" {
			err = fmt.Errorf("%w: %s", err, truncateForLog(detail, 300))
		}
	}

	// PowerShell can exit 0 with only the error record on stderr, so check
	// the signatures whether the spawn or the parse failed.
	lower := strings.ToLower(output)
	switch {
	case strings.Contains(lower, defenderServiceDisabledHRESULT):
		defenderAvailability.markUnavailable("HRESULT "+defenderServiceDisabledHRESULT, defenderServiceDisabledTTL)
		return DefenderStatus{}, errDefenderNotAvailable
	case strings.Contains(lower, defenderCmdletNotFound) && strings.Contains(lower, defenderCmdletNotFoundTarget):
		defenderAvailability.markUnavailable("Get-MpComputerStatus not found", defenderAvailabilityTTL)
		return DefenderStatus{}, errDefenderNotAvailable
	}
	return DefenderStatus{}, err
}

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

func parseDefenderStatus(output string) (DefenderStatus, error) {
	payload := strings.TrimSpace(output)
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

	return DefenderStatus{
		Enabled:              raw.AntivirusEnabled || raw.AntispywareEnabled || raw.AMServiceEnabled,
		RealTimeProtection:   raw.RealTimeProtectionEnabled,
		DefinitionsVersion:   strings.TrimSpace(raw.AntivirusSignatureVersion),
		DefinitionsUpdatedAt: normalizeTimeString(raw.AntivirusSignatureLastUpdated),
		LastQuickScan:        normalizeTimeString(raw.QuickScanEndTime),
		LastFullScan:         normalizeTimeString(raw.FullScanEndTime),
	}, nil
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
