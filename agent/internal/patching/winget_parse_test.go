package patching

import (
	"fmt"
	"strings"
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

func TestWingetListParseWithAvailableColumn(t *testing.T) {
	// When any package has an upgrade, `winget list` grows an Available column;
	// the Version cell must stop there instead of swallowing it (a row used to
	// parse as Version "2.51.0.2   2.55.0.3").
	row := func(name, id, version, available, source string) string {
		return fmt.Sprintf("%-11s%-14s%-11s%-12s%s", name, id, version, available, source)
	}
	// The last row's raw bytes end before the Available column position
	// (right-trimmed output) — the version slice must clamp, not drop the row.
	output := row("Name", "Id", "Version", "Available", "Source") + "\n" +
		strings.Repeat("-", 55) + "\n" +
		row("Git", "Git.Git", "2.51.0.2", "2.55.0.3", "winget") + "\n" +
		row("7-Zip", "7zip.7zip", "26.00", "26.02", "winget") + "\n" +
		row("Paint", "Corel.Paint", "1.2.3", "", "winget") + "\n" +
		fmt.Sprintf("%-11s%-14s%s", "Short", "Short.App", "1.0") + "\n"

	installed := parseWingetListOutput(output)
	if len(installed) != 4 {
		t.Fatalf("expected 4 installed, got %d: %+v", len(installed), installed)
	}
	want := map[string]string{
		"Git.Git":     "2.51.0.2",
		"7zip.7zip":   "26.00",
		"Corel.Paint": "1.2.3",
		"Short.App":   "1.0",
	}
	for _, p := range installed {
		if p.Version != want[p.ID] {
			t.Errorf("%s: Version = %q, want %q", p.ID, p.Version, want[p.ID])
		}
	}
}

func TestWingetListParseWithoutAvailableColumn(t *testing.T) {
	row := func(name, id, version, source string) string {
		return fmt.Sprintf("%-11s%-14s%-11s%s", name, id, version, source)
	}
	output := row("Name", "Id", "Version", "Source") + "\n" +
		strings.Repeat("-", 45) + "\n" +
		row("Git", "Git.Git", "2.51.0.2", "winget") + "\n"

	installed := parseWingetListOutput(output)
	if len(installed) != 1 {
		t.Fatalf("expected 1 installed, got %d: %+v", len(installed), installed)
	}
	if installed[0].Version != "2.51.0.2" {
		t.Errorf("Version = %q, want %q", installed[0].Version, "2.51.0.2")
	}
}
