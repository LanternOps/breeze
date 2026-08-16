//go:build !darwin

package patching

import (
	"errors"
	"testing"
)

func TestEnsureBrewInstalledStubIsUnavailable(t *testing.T) {
	_, alreadyInstalled, err := EnsureBrewInstalled("homebrew_formula", "firefox")
	if err == nil {
		t.Fatal("want an error on non-darwin")
	}
	if !errors.Is(err, ErrBrewUnavailable) {
		t.Fatalf("err = %v, want errors.Is(err, ErrBrewUnavailable)", err)
	}
	if alreadyInstalled {
		t.Fatal("alreadyInstalled must be false on the stub path")
	}
}
