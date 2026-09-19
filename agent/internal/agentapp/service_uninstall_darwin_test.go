//go:build darwin

package agentapp

import (
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/macosuninstall"
)

func TestServiceUninstallUsesPackageCleanup(t *testing.T) {
	for _, failed := range []bool{false, true} {
		calls := 0
		err := uninstallDarwinService(func(name string, args ...string) ([]byte, error) {
			calls++
			if name != "/bin/sh" || len(args) != 2 || args[0] != "-c" || args[1] != macosuninstall.Script() {
				t.Fatalf("unexpected runner invocation %q %v", name, args)
			}
			if failed {
				return []byte("could not stop gui/502 helper"), errors.New("exit 1")
			}
			return nil, nil
		})
		if calls != 1 || (err != nil) != failed {
			t.Fatalf("calls=%d err=%v", calls, err)
		}
		if failed && !strings.Contains(err.Error(), "could not stop gui/502 helper") {
			t.Fatalf("lost failure: %v", err)
		}
	}
}
