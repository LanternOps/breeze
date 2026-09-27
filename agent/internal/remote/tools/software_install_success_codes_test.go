package tools

import (
	"context"
	"runtime"
	"strings"
	"testing"
	"time"
)

// #7038: a Software Library version can declare vendor-documented success exit
// codes (winget's InstallerSuccessCodes analog). They ADD to the built-in
// defaults — never replace them — and are compared by their uint32 bit
// pattern, because Windows exit codes are DWORDs that the API may carry in
// either signed or unsigned spelling.
func TestInstallerExitIndicatesSuccessWithDeclaredCodes(t *testing.T) {
	t.Parallel()

	// 0x80070005 (E_ACCESSDENIED) as Go reports it on Windows: the DWORD
	// widened to int, i.e. its unsigned spelling.
	const hresultUnsigned = 2147942405

	cases := []struct {
		name     string
		fileType string
		exitCode int
		declared []uint32
		want     bool
	}{
		{"veeam 1000 declared", "exe", 1000, []uint32{1000, 1101}, true},
		{"veeam 1101 declared", "exe", 1101, []uint32{1000, 1101}, true},
		{"veeam 1002 not declared", "exe", 1002, []uint32{1000, 1101}, false},
		{"1000 without declaration still fails", "exe", 1000, nil, false},
		{"declared codes add to defaults: 0", "exe", 0, []uint32{1000}, true},
		{"declared codes add to defaults: 3010", "msi", 3010, []uint32{1000}, true},
		{"declared code on msi", "msi", 1000, []uint32{1000}, true},
		{"declared code on deb", "deb", 7, []uint32{7}, true},
		{"unsigned exit matches signed declaration", "exe", hresultUnsigned, []uint32{0x80070005}, true},
		// A negative exit code is Go's "did not exit normally" (signal) sentinel,
		// never a real Windows DWORD — it must not alias 0xFFFFFFFF.
		{"-1 sentinel never matches 0xFFFFFFFF", "exe", -1, []uint32{0xFFFFFFFF}, false},
		{"real 0xFFFFFFFF exit matches", "exe", 0xFFFFFFFF, []uint32{0xFFFFFFFF}, true},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := installerExitIndicatesSuccess(tc.fileType, tc.exitCode, tc.declared); got != tc.want {
				t.Fatalf("installerExitIndicatesSuccess(%q, %d, %v) = %v, want %v", tc.fileType, tc.exitCode, tc.declared, got, tc.want)
			}
		})
	}
}

func TestParseSuccessExitCodes(t *testing.T) {
	t.Parallel()

	t.Run("absent → nil", func(t *testing.T) {
		codes, err := parseSuccessExitCodes(map[string]any{})
		if err != nil || codes != nil {
			t.Fatalf("want nil,nil got %v,%v", codes, err)
		}
	})
	t.Run("null → nil", func(t *testing.T) {
		codes, err := parseSuccessExitCodes(map[string]any{"successExitCodes": nil})
		if err != nil || codes != nil {
			t.Fatalf("want nil,nil got %v,%v", codes, err)
		}
	})
	t.Run("JSON numbers decode and normalize signed to unsigned", func(t *testing.T) {
		codes, err := parseSuccessExitCodes(map[string]any{
			"successExitCodes": []any{float64(1000), float64(1101), float64(-2147024891), float64(4294967295)},
		})
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := []uint32{1000, 1101, 2147942405, 4294967295}
		if len(codes) != len(want) {
			t.Fatalf("got %v want %v", codes, want)
		}
		for i := range want {
			if codes[i] != want[i] {
				t.Fatalf("got %v want %v", codes, want)
			}
		}
	})

	bad := map[string]any{
		"not an array":          "1000",
		"non-number entry":      []any{"1000"},
		"fractional":            []any{float64(1000.5)},
		"above uint32":          []any{float64(4294967296)},
		"below int32":           []any{float64(-2147483649)},
		"too many entries (33)": make33Codes(),
	}
	for name, raw := range bad {
		name, raw := name, raw
		t.Run("rejects "+name, func(t *testing.T) {
			if _, err := parseSuccessExitCodes(map[string]any{"successExitCodes": raw}); err == nil {
				t.Fatalf("expected error for %s", name)
			}
		})
	}
}

func make33Codes() []any {
	out := make([]any, 33)
	for i := range out {
		out[i] = float64(1000 + i)
	}
	return out
}

// A malformed declaration is refused before anything is downloaded or run —
// silently dropping it would turn every declared-success install into a
// reported failure with no hint why.
func TestInstallSoftwareRejectsMalformedSuccessExitCodes(t *testing.T) {
	t.Parallel()

	r := InstallSoftware(map[string]any{
		"downloadUrl":      "https://example.invalid/setup.exe",
		"fileName":         "setup.exe",
		"fileType":         "exe",
		"successExitCodes": []any{"oops"},
	})
	if r.Status != "failed" || !strings.Contains(r.Error, "successExitCodes") {
		t.Fatalf("want failed with successExitCodes error, got status=%q err=%q", r.Status, r.Error)
	}
}

func TestRunInstallerCommandHonorsDeclaredSuccessCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("test drives the helper through sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	exitCode, _, _, err := runInstallerCommand(ctx, shInstallerCommand(ctx, "exit 7"), "exe", []uint32{7})
	if err != nil {
		t.Fatalf("declared success code 7 should not error, got %v", err)
	}
	if exitCode != 7 {
		t.Fatalf("real exit code must be preserved, got %d", exitCode)
	}

	// Undeclared codes still fail with the real code in the message.
	exitCode, _, _, err = runInstallerCommand(ctx, shInstallerCommand(ctx, "exit 8"), "exe", []uint32{7})
	if exitCode != 8 || err == nil || !strings.Contains(err.Error(), "installer exited with code 8") {
		t.Fatalf("want code 8 failure, got %d %v", exitCode, err)
	}
}
