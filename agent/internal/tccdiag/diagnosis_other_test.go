//go:build !darwin || !cgo

package tccdiag

import "testing"

// Off macOS, or without cgo, nothing can be read: every service is
// unobservable and the reason says why.
func TestRunUnsupportedIsUnobservable(t *testing.T) {
	d := Run([]Service{ServiceScreenCapture, ServiceAccessibility})
	if Supported || d.Verdict != VerdictUnobservable || len(d.Services) != 2 || d.Services[0].Error == "" {
		t.Fatalf("Run = %+v, want unobservable with a reason for each service", d)
	}
}
