package mgmtdetect

import (
	"os"
	"runtime"
	"testing"
)

func TestCollectPostureReturnsResult(t *testing.T) {
	posture := CollectPosture()

	if posture.CollectedAt.IsZero() {
		t.Error("CollectedAt should not be zero")
	}
	if posture.ScanDurationMs < 0 {
		t.Error("ScanDurationMs should not be negative")
	}
	if posture.Categories == nil {
		t.Error("Categories should not be nil")
	}
	if posture.Identity.Source == "" {
		t.Error("Identity.Source should not be empty")
	}
	t.Logf("Posture scan completed in %dms with %d errors", posture.ScanDurationMs, len(posture.Errors))
	for cat, dets := range posture.Categories {
		t.Logf("  %s: %d detections", cat, len(dets))
		for _, d := range dets {
			t.Logf("    - %s [%s]", d.Name, d.Status)
		}
	}
}

func TestEvaluateSignature(t *testing.T) {
	// Create a minimal processSnapshot with known data
	snap := &processSnapshot{names: map[string]bool{"crowdstrike": true}}
	d := newCheckDispatcher(snap)

	// Test 1: Signature with process_running check that matches -> StatusActive
	sig := Signature{
		Name:     "CrowdStrike",
		Category: CategoryEndpointSecurity,
		OS:       []string{runtime.GOOS},
		Checks: []Check{
			{Type: CheckProcessRunning, Value: "crowdstrike"},
		},
	}
	det, found := evaluateSignature(d, sig)
	if !found {
		t.Fatal("expected detection")
	}
	if det.Status != StatusActive {
		t.Errorf("expected active, got %s", det.Status)
	}
	if det.Name != "CrowdStrike" {
		t.Errorf("expected CrowdStrike, got %s", det.Name)
	}

	// Test 2: Signature with process check that doesn't match -> not found
	sig2 := Signature{
		Name:     "NotInstalled",
		Category: CategoryRMM,
		OS:       []string{runtime.GOOS},
		Checks: []Check{
			{Type: CheckProcessRunning, Value: "nonexistent"},
		},
	}
	_, found2 := evaluateSignature(d, sig2)
	if found2 {
		t.Error("expected no detection")
	}

	// Test 3: file_exists check with temp file -> StatusInstalled
	tmpFile, err := os.CreateTemp("", "mgmtdetect-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())
	tmpFile.Close()

	sig3 := Signature{
		Name:     "TestTool",
		Category: CategoryRMM,
		OS:       []string{runtime.GOOS},
		Checks: []Check{
			{Type: CheckFileExists, Value: tmpFile.Name()},
		},
	}
	det3, found3 := evaluateSignature(d, sig3)
	if !found3 {
		t.Fatal("expected detection from file_exists")
	}
	if det3.Status != StatusInstalled {
		t.Errorf("expected installed for file_exists, got %s", det3.Status)
	}

	// Test 4: Multi-check scenario: first check is process_running (active), second is file_exists
	// evaluateSignature returns on the FIRST matching check, so process_running matching
	// first means status is active.
	sig4 := Signature{
		Name:     "MultiCheck",
		Category: CategoryRMM,
		OS:       []string{runtime.GOOS},
		Checks: []Check{
			{Type: CheckProcessRunning, Value: "crowdstrike"},
			{Type: CheckFileExists, Value: tmpFile.Name()},
		},
	}
	det4, found4 := evaluateSignature(d, sig4)
	if !found4 {
		t.Fatal("expected detection from multi-check")
	}
	if det4.Status != StatusActive {
		t.Errorf("expected active (process_running matches first), got %s", det4.Status)
	}

	// Test 5: Multi-check where first check fails, second matches as file_exists -> installed
	sig5 := Signature{
		Name:     "FallbackToFile",
		Category: CategoryRMM,
		OS:       []string{runtime.GOOS},
		Checks: []Check{
			{Type: CheckProcessRunning, Value: "nonexistent"},
			{Type: CheckFileExists, Value: tmpFile.Name()},
		},
	}
	det5, found5 := evaluateSignature(d, sig5)
	if !found5 {
		t.Fatal("expected detection from fallback file_exists")
	}
	if det5.Status != StatusInstalled {
		t.Errorf("expected installed (file_exists fallback), got %s", det5.Status)
	}

	// Test 6: All checks fail -> not found
	sig6 := Signature{
		Name:     "AllFail",
		Category: CategoryRMM,
		OS:       []string{runtime.GOOS},
		Checks: []Check{
			{Type: CheckProcessRunning, Value: "nonexistent"},
			{Type: CheckFileExists, Value: "/nonexistent/path/xyz"},
		},
	}
	_, found6 := evaluateSignature(d, sig6)
	if found6 {
		t.Error("expected no detection when all checks fail")
	}

	// Test 7: Empty checks slice -> not found
	sig7 := Signature{
		Name:     "NoChecks",
		Category: CategoryRMM,
		OS:       []string{runtime.GOOS},
		Checks:   []Check{},
	}
	_, found7 := evaluateSignature(d, sig7)
	if found7 {
		t.Error("expected no detection for empty checks")
	}
}
