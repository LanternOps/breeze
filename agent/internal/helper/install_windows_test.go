package helper

import (
	"reflect"
	"testing"
)

// #6868: the retry against a product already registered at the target must
// be a repair that rewrites every file from the package, not `/i`.
func TestMSIReinstallArgsForceFileReinstallFromPackage(t *testing.T) {
	got := msiReinstallArgs(`C:\tmp\breeze-helper-windows.msi`)
	want := []string{"/fvamus", `C:\tmp\breeze-helper-windows.msi`, "/qn", "/norestart"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args=%v, want %v", got, want)
	}
}
