package branding

// TEST ONLY. SetForTest overrides the branding variables so tests in this and
// other packages can exercise branded behavior without rebuilding the binary
// with ldflags. It panics outside `go test`, like the hostpolicy seams.
//
// The variables are plain globals, so tests that use SetForTest must not run
// in parallel with each other.

import "testing"

// Values groups every branding variable.
type Values struct {
	AgentServiceDisplayName    string
	AgentServiceDescription    string
	WatchdogServiceDisplayName string
	WatchdogServiceDescription string
	AgentCLIShort              string
	WatchdogCLIShort           string
}

func current() Values {
	return Values{
		AgentServiceDisplayName:    AgentServiceDisplayName,
		AgentServiceDescription:    AgentServiceDescription,
		WatchdogServiceDisplayName: WatchdogServiceDisplayName,
		WatchdogServiceDescription: WatchdogServiceDescription,
		AgentCLIShort:              AgentCLIShort,
		WatchdogCLIShort:           WatchdogCLIShort,
	}
}

func apply(v Values) {
	AgentServiceDisplayName = v.AgentServiceDisplayName
	AgentServiceDescription = v.AgentServiceDescription
	WatchdogServiceDisplayName = v.WatchdogServiceDisplayName
	WatchdogServiceDescription = v.WatchdogServiceDescription
	AgentCLIShort = v.AgentCLIShort
	WatchdogCLIShort = v.WatchdogCLIShort
}

// SetForTest replaces every branding variable with v (fields left empty are
// cleared) and returns a func that restores the previous values. Panics if
// called outside `go test`.
func SetForTest(v Values) (restore func()) {
	if !testing.Testing() {
		panic("branding test seams are test-only")
	}
	prev := current()
	apply(v)
	return func() { apply(prev) }
}
