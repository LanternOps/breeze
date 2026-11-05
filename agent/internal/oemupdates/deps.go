package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/authenticode"
	"github.com/breeze-rmm/agent/internal/flashguard"
)

// Every external effect of a run goes through one of these seams, so the runner
// tests on fakes on any OS.

// Verifier checks a binary's Authenticode signature and names its signer.
type Verifier interface {
	Verify(path string) (authenticode.Signer, error)
}

// Fetcher downloads a vendor file: https only, hosts from the lane's allowlist,
// every redirect hop checked, SHA-256 pinned.
type Fetcher interface {
	Fetch(ctx context.Context, url, sha256 string, allow LaneAllowlist, dest string) error
}

// PowerStatus is SYSTEM_POWER_STATUS, the fields the flash gate reads.
type PowerStatus struct {
	ACLineStatus       byte
	BatteryFlag        byte
	BatteryLifePercent byte
}

// Power reads the power state.
type Power interface {
	Status() (PowerStatus, error)
}

// LiveProtectors is the OS volume's BitLocker state read live.
type LiveProtectors struct {
	// BitLockerOn means the OS volume is encrypted (protection on or suspended).
	BitLockerOn bool
	// RecoveryPasswordIDs are the OS volume's recovery-password protector ids.
	RecoveryPasswordIDs []string
}

// Protectors reads BitLocker. Live must be read immediately before a firmware
// install; State is the post-reboot reading.
type Protectors interface {
	Live() (LiveProtectors, error)
	State() string
}

// System reads facts the verification step compares.
type System interface {
	BiosVersion() (string, error)
	BootTime() (time.Time, error)
}

// Clock is the wall clock.
type Clock interface {
	Now() time.Time
}

// FlashGuard is the subset of flashguard.Guard a run uses.
type FlashGuard interface {
	Enter(kind, commandID string, ttl time.Duration) (release func() error, err error)
	// Active reports an open section, including one a previous process left
	// for a flash that may still be running.
	Active() (flashguard.Section, bool)
}

// Deps carries every seam. Production values come from ProductionDeps.
type Deps struct {
	Exec       Exec
	Verifier   Verifier
	Fetcher    Fetcher
	Power      Power
	Protectors Protectors
	System     System
	Clock      Clock
	Store      Store
	Guard      FlashGuard
	// Preflight runs the shared patch preflight (disk, service health).
	Preflight func() error
	// Elevated reports whether the agent runs as SYSTEM/root.
	Elevated func() bool
	// Progress reports a stage; nil reports nothing.
	Progress func(stage string)
	// BitLockerHeld reports a suspension of ours still open. The post-reboot
	// verification waits for it, because it reads BitLocker. Nil means none.
	BitLockerHeld func() bool
}

func (d Deps) now() time.Time {
	if d.Clock == nil {
		return time.Now()
	}
	return d.Clock.Now()
}

func (d Deps) progress(stage string) {
	if d.Progress != nil {
		d.Progress(stage)
	}
}

// RunError carries the contract errorCode for a refusal or failure.
type RunError struct {
	Code string
	Err  error
}

func (e *RunError) Error() string {
	if e.Err == nil {
		return e.Code
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Err)
}

func (e *RunError) Unwrap() error { return e.Err }

func runErr(code string, err error) error { return &RunError{Code: code, Err: err} }

func errorCodeOf(err error) string {
	var re *RunError
	if errors.As(err, &re) {
		return re.Code
	}
	return ""
}
