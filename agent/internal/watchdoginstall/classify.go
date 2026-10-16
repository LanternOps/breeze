// Package watchdoginstall holds the pure logic behind the enrolled agent's
// repair of a missing breeze-watchdog service: the closed error-class enum,
// the persisted attempt state and operator opt-out marker, the bounded backoff
// schedule, the per-OS "is the watchdog registered?" detector, and the
// cross-process install lock. The orchestration (download, exec, telemetry)
// lives in package heartbeat.
package watchdoginstall

import (
	"errors"
	"net"
	"net/url"

	"github.com/breeze-rmm/agent/internal/netpolicy"
	"github.com/breeze-rmm/agent/internal/updater"
)

// ErrorClass is the closed set of reasons a watchdog install attempt failed.
// It is the ONLY failure detail that leaves the device (heartbeat telemetry);
// error text never does, because download errors can embed request URLs.
type ErrorClass string

const (
	ClassNetwork       ErrorClass = "network"
	ClassServer        ErrorClass = "server"
	ClassPolicy        ErrorClass = "policy"
	ClassSignature     ErrorClass = "signature"
	ClassChecksum      ErrorClass = "checksum"
	ClassDevBuild      ErrorClass = "dev_build"
	ClassUnsupportedOS ErrorClass = "unsupported_os"
	ClassInstallCmd    ErrorClass = "install_cmd"
	ClassLocked        ErrorClass = "locked"
	ClassUnknown       ErrorClass = "unknown"
)

// AllErrorClasses returns every member of the closed set.
func AllErrorClasses() []ErrorClass {
	return []ErrorClass{
		ClassNetwork, ClassServer, ClassPolicy, ClassSignature, ClassChecksum,
		ClassDevBuild, ClassUnsupportedOS, ClassInstallCmd, ClassLocked, ClassUnknown,
	}
}

// Valid reports whether c is a member of the closed set.
func (c ErrorClass) Valid() bool {
	for _, k := range AllErrorClasses() {
		if c == k {
			return true
		}
	}
	return false
}

// Permanent reports whether a failure of this class cannot be fixed by
// retrying the same version on this host. Permanent classes go terminal on
// first occurrence and are re-probed only on the slow security cadence.
func (c ErrorClass) Permanent() bool {
	switch c {
	case ClassSignature, ClassChecksum, ClassPolicy, ClassDevBuild, ClassUnsupportedOS:
		return true
	}
	return false
}

var (
	// ErrDevBuild: the running agent is a local build with no published
	// watchdog to fetch. Never touches the network.
	ErrDevBuild = errors.New("agent is a dev build; no published watchdog to install")
	// ErrUnsupportedOS: this OS / init system has no watchdog service.
	ErrUnsupportedOS = errors.New("watchdog is not supported on this platform")
	// ErrInstallCommand: the verified watchdog's own `service install` failed,
	// timed out, or left the service unregistered or not running.
	ErrInstallCommand = errors.New("watchdog service install did not complete")
	// ErrLockHeld: another process holds the cross-process install lock.
	ErrLockHeld = errors.New("watchdog install lock is held by another process")
)

// Classify maps err to its class and permanence using only typed checks
// (errors.Is / errors.As); it never inspects error text. A nil or unrecognised
// error is ClassUnknown, which is transient but still bounded by the budget.
func Classify(err error) (ErrorClass, bool) {
	c := classify(err)
	return c, c.Permanent()
}

func classify(err error) ErrorClass {
	if err == nil {
		return ClassUnknown
	}
	// Policy first: a netpolicy refusal arrives wrapped in *url.Error, which
	// would otherwise read as a network failure.
	var pe *netpolicy.PolicyError
	if errors.As(err, &pe) {
		return ClassPolicy
	}
	switch {
	case errors.Is(err, ErrDevBuild):
		return ClassDevBuild
	case errors.Is(err, ErrUnsupportedOS):
		return ClassUnsupportedOS
	case errors.Is(err, updater.ErrChecksumMismatch):
		return ClassChecksum
	case errors.Is(err, updater.ErrManifestSignature),
		errors.Is(err, updater.ErrManifestKey),
		errors.Is(err, updater.ErrUntrustedRelease),
		errors.Is(err, updater.ErrCodeSignatureInvalid):
		return ClassSignature
	case errors.Is(err, updater.ErrFileLocked), errors.Is(err, ErrLockHeld):
		return ClassLocked
	case errors.Is(err, updater.ErrReadOnlyFS), errors.Is(err, ErrInstallCommand):
		// Read-only FS is transient on purpose: a remount heals it.
		return ClassInstallCmd
	}
	var se *updater.HTTPStatusError
	if errors.As(err, &se) {
		if se.Code == 429 || (se.Code >= 500 && se.Code <= 599) {
			return ClassServer
		}
		return ClassUnknown
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return ClassNetwork
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return ClassNetwork
	}
	return ClassUnknown
}
