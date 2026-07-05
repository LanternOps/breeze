package patching

import "testing"

// TestSystemWingetScan_Integration exercises the real detect-existing-winget
// path end to end: EnsureWinget locates a pre-installed winget.exe (Task 9b's
// bootstrap Provision is still a stub, so this only covers hosts that
// already have winget), then SystemWingetProvider.Scan shells out to it.
//
// Deliberately left untagged (no //go:build) rather than windows-only: it
// self-skips via res.Available on any host without winget (darwin/Linux CI,
// or a Windows box without winget), so it's safe to run unconditionally and
// still exercises the real path on a host where winget is present.
func TestSystemWingetScan_Integration(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test; run without -short on a host with winget")
	}
	res := EnsureWinget(NewEnsureDeps(nil)) // nil cfg is safe: cfg unused until Task 9b; Provision is a stub
	if !res.Available {
		t.Skipf("winget unavailable on this host: %s", res.Reason)
	}
	p := NewSystemWingetProvider(res.WingetPath, DefaultRunner)
	if _, err := p.Scan(); err != nil {
		t.Fatalf("winget scan failed: %v", err)
	}
}
