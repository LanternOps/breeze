package mgmtdetect

import (
	"runtime"
	"testing"
)

func TestSignaturesNotEmpty(t *testing.T) {
	sigs := AllSignatures()
	if len(sigs) == 0 {
		t.Fatal("signature database should not be empty")
	}
}

func TestSignaturesHaveRequiredFields(t *testing.T) {
	for _, sig := range AllSignatures() {
		if sig.Name == "" {
			t.Error("signature missing name")
		}
		if sig.Category == "" {
			t.Errorf("signature %s missing category", sig.Name)
		}
		if len(sig.OS) == 0 {
			t.Errorf("signature %s missing OS", sig.Name)
		}
		if len(sig.Checks) == 0 {
			t.Errorf("signature %s has no checks", sig.Name)
		}
	}
}

func TestSignaturesForCurrentOS(t *testing.T) {
	count := 0
	for _, sig := range AllSignatures() {
		if sig.MatchesOS(runtime.GOOS) {
			count++
		}
	}
	if count == 0 {
		t.Errorf("no signatures match current OS %s", runtime.GOOS)
	}
	t.Logf("%d signatures match %s", count, runtime.GOOS)
}

func TestSignatureChecksHaveFirstActiveCheck(t *testing.T) {
	activeTypes := map[CheckType]bool{
		CheckServiceRunning: true,
		CheckProcessRunning: true,
	}
	for _, sig := range AllSignatures() {
		first := sig.Checks[0]
		if !activeTypes[first.Type] {
			t.Errorf("signature %s leads with %s instead of active-state check", sig.Name, first.Type)
		}
	}
}
