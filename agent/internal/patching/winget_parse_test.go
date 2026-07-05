package patching

import (
	"testing"
)

// --- Table parsing edge cases ---

func TestWingetParseNoHeader(t *testing.T) {
	output := "some random output\nno table here\n"
	patches := parseWingetUpgradeOutput(output)
	if len(patches) != 0 {
		t.Errorf("expected 0 patches from headerless output, got %d", len(patches))
	}
}

func TestWingetParseSeparatorDetection(t *testing.T) {
	if !isSeparatorLine("-----------------------------------------------") {
		t.Error("should detect all-dash line as separator")
	}
	if !isSeparatorLine("---- ---- ---- ----") {
		t.Error("should detect dashes-with-spaces as separator")
	}
	if isSeparatorLine("Name   Id   Version") {
		t.Error("should not detect header line as separator")
	}
	if isSeparatorLine("---") {
		t.Error("should not detect short dash line as separator")
	}
}

func TestWingetScanSkipsFooterLines(t *testing.T) {
	output := `Name     Id                Version   Available   Source
--------------------------------------------------------
Firefox  Mozilla.Firefox   128.0     129.0       winget
1 upgrades available.
`

	patches := parseWingetUpgradeOutput(output)
	if len(patches) != 1 {
		t.Fatalf("expected 1 patch, got %d", len(patches))
	}
	if patches[0].ID != "Mozilla.Firefox" {
		t.Errorf("ID = %q, want %q", patches[0].ID, "Mozilla.Firefox")
	}
}
