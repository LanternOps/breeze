package patching

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// --- Table parsing edge cases ---

// TestParseWingetUpgradeOutputHeaderDetection pins the three-way distinction the
// tombstoning contract depends on (#2726): parsed rows, a confirmed-empty scan,
// and "we could not read this output at all" — which must be an error so the
// caller reports ErrScanSkipped instead of an empty (sweep-triggering) result.
func TestParseWingetUpgradeOutputHeaderDetection(t *testing.T) {
	validTable := "Name     Id                Version   Available   Source\n" +
		"--------------------------------------------------------\n" +
		"Firefox  Mozilla.Firefox   128.0     129.0       winget\n" +
		"Git      Git.Git           2.51.0    2.55.0      winget\n"

	tests := []struct {
		name      string
		output    string
		wantIDs   []string
		wantErr   error
		wantNoErr bool // genuinely-empty: no rows AND no error
	}{
		{
			name:    "valid header parses every row",
			output:  validTable,
			wantIDs: []string{"Mozilla.Firefox", "Git.Git"},
		},
		{
			name: "valid header with zero data rows is a confirmed-empty scan",
			output: "Name     Id                Version   Available   Source\n" +
				"--------------------------------------------------------\n",
			wantNoErr: true,
		},
		{
			name:      "no header but explicit no-results message is confirmed-empty",
			output:    "No installed package found matching input criteria.\n",
			wantNoErr: true,
		},
		{
			name:      "no header with no-applicable-upgrade message is confirmed-empty",
			output:    "   -\nNo applicable upgrade found.\n",
			wantNoErr: true,
		},
		{
			name:    "missing header errors",
			output:  "some random output\nno table here\n",
			wantErr: errWingetNoTable,
		},
		{
			name:    "empty output errors",
			output:  "",
			wantErr: errWingetNoTable,
		},
		{
			name:    "whitespace-only output errors",
			output:  "\n   \n\t\n",
			wantErr: errWingetNoTable,
		},
		{
			name:    "garbled output errors",
			output:  "\x00\xff\x01��� garbled\n\x1b[2J\x1b[H\n",
			wantErr: errWingetNoTable,
		},
		{
			name: "localized header errors rather than reporting empty",
			output: "Nombre   Id                Versión   Disponible  Origen\n" +
				"--------------------------------------------------------\n" +
				"Firefox  Mozilla.Firefox   128.0     129.0       winget\n",
			wantErr: errWingetNoTable,
		},
		{
			name: "out-of-order columns error rather than mis-parsing",
			output: "Id       Name              Version   Available   Source\n" +
				"--------------------------------------------------------\n",
			wantErr: errWingetNoTable,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			patches, err := parseWingetUpgradeOutput(tc.output)

			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				if patches != nil {
					t.Errorf("patches = %+v, want nil alongside an error", patches)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantNoErr {
				if len(patches) != 0 {
					t.Fatalf("patches = %+v, want empty", patches)
				}
				return
			}

			if len(patches) != len(tc.wantIDs) {
				t.Fatalf("got %d patches %+v, want %d", len(patches), patches, len(tc.wantIDs))
			}
			for i, want := range tc.wantIDs {
				if patches[i].ID != want {
					t.Errorf("patches[%d].ID = %q, want %q", i, patches[i].ID, want)
				}
			}
		})
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

	patches, err := parseWingetUpgradeOutput(output)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
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
