package updater

import (
	"runtime"
	"testing"
)

func TestExpectedReleaseAssetNamesIsolationRecovery(t *testing.T) {
	u := &Updater{config: &Config{Component: "isolation-recovery"}}
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	name := "breeze-isolation-recovery-" + runtime.GOOS + "-" + runtime.GOARCH + suffix
	names := u.expectedReleaseAssetNames()
	if _, ok := names[name]; !ok || len(names) != 1 {
		t.Fatalf("expected %s only, got %v", name, names)
	}
}
