//go:build darwin && !cgo

package networkcontext

import (
	"context"
	"testing"
)

type fakeDNSRunner struct{ calls int }

func (f *fakeDNSRunner) Output(_ context.Context, name string, args ...string) ([]byte, error) {
	f.calls++
	if name != "/usr/sbin/scutil" || len(args) != 1 || args[0] != "--dns" {
		panic("unexpected command")
	}
	return []byte("No DNS configuration available"), nil
}
func TestNoCGODNSUsesBoundedFixedCommand(t *testing.T) {
	f := &fakeDNSRunner{}
	s, e := ReadScopedDNS(context.Background(), f)
	if e != nil || s.Outcome != Complete || f.calls != 1 {
		t.Fatal(s, e)
	}
}
