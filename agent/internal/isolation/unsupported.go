package isolation

import (
	"context"
	"errors"
	"time"
)

// ErrUnsupported is returned by the capability-0 isolator and scheduler.
var ErrUnsupported = errors.New("network isolation is not supported by this agent build on this platform")

// unsupportedReason is reported in securityCapabilities while capability is 0.
const unsupportedReason = "network isolation is not available in this agent build on this platform"

// unsupportedIsolator reports capability 0 and owns nothing. It is the
// platform isolator until an OS's real isolator ships.
type unsupportedIsolator struct{}

func (unsupportedIsolator) Capability() Capability {
	return Capability{Version: 0, UnsupportedReason: unsupportedReason}
}
func (unsupportedIsolator) Apply(context.Context, ResolvedSpec) (Digest, error) {
	return "", ErrUnsupported
}
func (unsupportedIsolator) Verify(context.Context, ResolvedSpec) (Digest, error) {
	return "", ErrUnsupported
}

// Release and Owned fail rather than claim absence: a build without an
// isolator may have inherited rules a capable build installed, and only an
// isolator that can see the engine may confirm they are gone.
func (unsupportedIsolator) Release(context.Context) error        { return ErrUnsupported }
func (unsupportedIsolator) Owned(context.Context) (bool, error)  { return false, ErrUnsupported }
func (unsupportedIsolator) Mark(context.Context) (Marker, error) { return Marker{}, ErrUnsupported }
func (unsupportedIsolator) DropObserved(context.Context, Marker) (bool, error) {
	return false, ErrUnsupported
}

// unsupportedScheduler is never ready, so no apply can pass preflight.
type unsupportedScheduler struct{}

func (unsupportedScheduler) ArmProvisional(string, time.Time) error { return ErrUnsupported }
func (unsupportedScheduler) DisarmProvisional(string) error         { return nil }
func (unsupportedScheduler) ArmExpiry(string, int, time.Time) error { return ErrUnsupported }
func (unsupportedScheduler) EnsurePoll() error                      { return ErrUnsupported }
func (unsupportedScheduler) RemoveAll() error                       { return nil }
func (unsupportedScheduler) Ready() (bool, string)                  { return false, unsupportedReason }
