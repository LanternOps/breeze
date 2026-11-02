package security

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// BitLocker availability gate (#10902).
//
// Windows Server without the BitLocker feature and Windows Home ship neither
// the BitLocker PowerShell module nor Get-BitLockerVolume. Without a gate the
// three BitLocker probes (system-drive status, volume details and the
// recovery-password query MDR products flag) spawned PowerShell and failed on
// every error retry, forever. Every BitLocker caller checks this one cached
// answer first and skips its spawn when BitLocker is confirmed absent.

// ErrBitLockerUnavailable means BitLocker is not installed on this host. It
// is a permanent property of the host, not a failed read: status reports
// "unsupported" and the heartbeat does not warn or retry early.
var ErrBitLockerUnavailable = errors.New("bitlocker is not installed on this host")

// bitLockerAvailabilityTTL is how long a definite answer (available or
// unavailable) is trusted. Installing the BitLocker feature needs a reboot,
// so a day is soon enough to notice it; CollectStatusFresh re-detects at once.
const bitLockerAvailabilityTTL = 24 * time.Hour

// bitLockerGetCommandPS confirms the cmdlet is absent before the gate closes.
// It runs only when the module directory is missing, at most once per TTL.
const bitLockerGetCommandPS = `if (Get-Command -Name Get-BitLockerVolume -ErrorAction SilentlyContinue) { 'available' } else { 'unavailable' }`

// runBitLockerPowerShell runs one BitLocker-related PowerShell script. It is
// the only spawn path for BitLocker probes, so tests can count spawns.
var runBitLockerPowerShell = func(timeout time.Duration, script string) (string, error) {
	return runCommand(timeout, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
}

type bitLockerState int

const (
	// bitLockerIndeterminate: the check itself failed. Callers run their
	// probes as before so nothing is hidden; re-checked after slowProbeErrorTTL.
	bitLockerIndeterminate bitLockerState = iota
	bitLockerAvailable
	bitLockerUnavailable
)

type bitLockerAvailabilityProbe struct {
	now             func() time.Time
	moduleInstalled func() bool

	mu        sync.Mutex
	state     bitLockerState
	checkedAt time.Time
	valid     bool
}

func newBitLockerAvailabilityProbe() *bitLockerAvailabilityProbe {
	return &bitLockerAvailabilityProbe{now: time.Now, moduleInstalled: bitLockerModuleInstalled}
}

var bitLockerAvailability = newBitLockerAvailabilityProbe()

// bitLockerModuleInstalled reports whether the inbox BitLocker PowerShell
// module is on disk. A stat, not a spawn, so supported hosts pay nothing.
func bitLockerModuleInstalled() bool {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	info, err := os.Stat(filepath.Join(root, "System32", "WindowsPowerShell", "v1.0", "Modules", "BitLocker"))
	return err == nil && info.IsDir()
}

// unavailable reports whether BitLocker is confirmed absent. An indeterminate
// check returns false so callers fall back to running their probe.
func (p *bitLockerAvailabilityProbe) unavailable() bool {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.now()
	ttl := bitLockerAvailabilityTTL
	if p.state == bitLockerIndeterminate {
		ttl = slowProbeErrorTTL
	}
	if !p.valid || now.Sub(p.checkedAt) >= ttl {
		prev, wasValid := p.state, p.valid
		p.state = p.detect()
		p.checkedAt = now
		p.valid = true
		if p.state == bitLockerUnavailable && (!wasValid || prev != bitLockerUnavailable) {
			log.Debug("BitLocker is not installed on this host; skipping BitLocker status and recovery-key probes",
				"recheckIn", bitLockerAvailabilityTTL.String())
		}
	}
	return p.state == bitLockerUnavailable
}

func (p *bitLockerAvailabilityProbe) detect() bitLockerState {
	if p.moduleInstalled() {
		return bitLockerAvailable
	}
	output, err := runBitLockerPowerShell(10*time.Second, bitLockerGetCommandPS)
	if err != nil {
		log.Debug("BitLocker availability check failed; running BitLocker probes ungated", "error", err.Error())
		return bitLockerIndeterminate
	}
	switch strings.TrimSpace(output) {
	case "available":
		return bitLockerAvailable
	case "unavailable":
		return bitLockerUnavailable
	default:
		log.Debug("BitLocker availability check returned unexpected output; running BitLocker probes ungated",
			"output", truncateForLog(strings.TrimSpace(output), 200))
		return bitLockerIndeterminate
	}
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

func (p *bitLockerAvailabilityProbe) invalidate() {
	p.mu.Lock()
	p.valid = false
	p.mu.Unlock()
}

// RedetectBitLockerAvailability discards the cached answer so the next
// BitLocker probe re-detects. Technician-initiated commands call it so a
// feature installed since the last check is seen immediately.
func RedetectBitLockerAvailability() { bitLockerAvailability.invalidate() }

// bitLockerNotInstalled is the gate every BitLocker probe checks first.
func bitLockerNotInstalled() bool { return bitLockerAvailability.unavailable() }
