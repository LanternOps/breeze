package patching

import (
	"testing"
	"time"
)

func TestRegisterSystemWinget(t *testing.T) {
	run := func(string, []string, time.Duration) (string, string, int, error) { return "", "", 0, nil }

	m := NewPatchManager()
	if RegisterSystemWinget(m, EnsureResult{Available: false, Reason: "x"}, run) {
		t.Fatal("must not register when unavailable")
	}
	if m.HasProvider("winget") {
		t.Fatal("no winget provider expected")
	}

	m2 := NewPatchManager()
	if !RegisterSystemWinget(m2, EnsureResult{Available: true, WingetPath: `C:\wg\winget.exe`}, run) {
		t.Fatal("should register when available")
	}
	if !m2.HasProvider("winget") {
		t.Fatal("winget provider expected")
	}
}
