package tools

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// ---------------------------------------------------------------------------
// parseDetectionRules
// ---------------------------------------------------------------------------

func TestParseDetectionRules(t *testing.T) {
	t.Run("absent key returns nil", func(t *testing.T) {
		got := parseDetectionRules(map[string]any{})
		if got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("nil slice value returns nil", func(t *testing.T) {
		got := parseDetectionRules(map[string]any{"detectionRules": nil})
		if got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("wrong type returns nil", func(t *testing.T) {
		got := parseDetectionRules(map[string]any{"detectionRules": "bad"})
		if got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("empty slice returns nil", func(t *testing.T) {
		got := parseDetectionRules(map[string]any{"detectionRules": []any{}})
		if got != nil {
			t.Fatalf("expected nil, got %v", got)
		}
	})

	t.Run("clause with empty type is skipped", func(t *testing.T) {
		payload := map[string]any{
			"detectionRules": []any{
				map[string]any{"type": "", "path": "/some/path"},
				map[string]any{"type": "file_exists", "path": "/foo"},
			},
		}
		got := parseDetectionRules(payload)
		if len(got) != 1 {
			t.Fatalf("expected 1 rule, got %d", len(got))
		}
		if got[0].Type != "file_exists" {
			t.Errorf("expected file_exists, got %q", got[0].Type)
		}
	})

	t.Run("garbage entry (not a map) is skipped", func(t *testing.T) {
		payload := map[string]any{
			"detectionRules": []any{
				"not a map",
				map[string]any{"type": "file_exists", "path": "/foo"},
			},
		}
		got := parseDetectionRules(payload)
		if len(got) != 1 {
			t.Fatalf("expected 1 rule, got %d", len(got))
		}
	})

	t.Run("valid file_exists rule", func(t *testing.T) {
		payload := map[string]any{
			"detectionRules": []any{
				map[string]any{"type": "file_exists", "path": "/usr/bin/foo"},
			},
		}
		got := parseDetectionRules(payload)
		if len(got) != 1 {
			t.Fatalf("expected 1 rule, got %d", len(got))
		}
		r := got[0]
		if r.Type != "file_exists" {
			t.Errorf("Type: want file_exists, got %q", r.Type)
		}
		if r.Path != "/usr/bin/foo" {
			t.Errorf("Path: want /usr/bin/foo, got %q", r.Path)
		}
	})

	t.Run("valid registry rule", func(t *testing.T) {
		payload := map[string]any{
			"detectionRules": []any{
				map[string]any{
					"type":      "registry",
					"hive":      "HKLM",
					"path":      `SOFTWARE\MyApp`,
					"valueName": "Version",
					"valueData": "1.0",
				},
			},
		}
		got := parseDetectionRules(payload)
		if len(got) != 1 {
			t.Fatalf("expected 1 rule, got %d", len(got))
		}
		r := got[0]
		if r.Type != "registry" || r.Hive != "HKLM" || r.Path != `SOFTWARE\MyApp` ||
			r.ValueName != "Version" || r.ValueData != "1.0" {
			t.Errorf("unexpected parsed rule: %+v", r)
		}
	})

	t.Run("valid msi_product_code rule", func(t *testing.T) {
		payload := map[string]any{
			"detectionRules": []any{
				map[string]any{
					"type":        "msi_product_code",
					"productCode": "{AABBCCDD-1234-5678-ABCD-000000000001}",
				},
			},
		}
		got := parseDetectionRules(payload)
		if len(got) != 1 {
			t.Fatalf("expected 1 rule, got %d", len(got))
		}
		if got[0].ProductCode != "{AABBCCDD-1234-5678-ABCD-000000000001}" {
			t.Errorf("unexpected ProductCode: %q", got[0].ProductCode)
		}
	})

	t.Run("valid file_version rule", func(t *testing.T) {
		payload := map[string]any{
			"detectionRules": []any{
				map[string]any{
					"type":     "file_version",
					"path":     `C:\Program Files\Acme\app.exe`,
					"operator": ">=",
					"version":  "1.2.3.4",
				},
			},
		}
		got := parseDetectionRules(payload)
		if len(got) != 1 {
			t.Fatalf("expected 1 rule, got %d", len(got))
		}
		r := got[0]
		if r.Type != "file_version" || r.Path != `C:\Program Files\Acme\app.exe` ||
			r.Operator != ">=" || r.Version != "1.2.3.4" {
			t.Errorf("unexpected parsed rule: %+v", r)
		}
	})
}

// ---------------------------------------------------------------------------
// file_version — version parsing and comparison (cross-platform)
// ---------------------------------------------------------------------------

func TestParseFileVersion(t *testing.T) {
	okCases := []struct {
		in   string
		want [4]int64
	}{
		{"1", [4]int64{1, 0, 0, 0}},
		{"1.2", [4]int64{1, 2, 0, 0}},
		{"1.2.3", [4]int64{1, 2, 3, 0}},
		{"1.2.3.4", [4]int64{1, 2, 3, 4}},
		{"  10.0.19041.1  ", [4]int64{10, 0, 19041, 1}},
		{"0.0.0.0", [4]int64{0, 0, 0, 0}},
	}
	for _, tc := range okCases {
		got, err := parseFileVersion(tc.in)
		if err != nil {
			t.Errorf("parseFileVersion(%q) unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("parseFileVersion(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}

	badCases := []string{"", "   ", "1.2.3.4.5", "1.x", "abc", "1..2", "-1.0", "1.-2"}
	for _, in := range badCases {
		if _, err := parseFileVersion(in); err == nil {
			t.Errorf("parseFileVersion(%q) expected error, got nil", in)
		}
	}
}

func TestCompareFileVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.3.4", "1.2.3.4", 0},
		{"1.2", "1.2.0.0", 0},
		{"1.9", "1.10", -1},   // numeric, not lexical
		{"1.10", "1.9", 1},    // numeric, not lexical
		{"2.0", "1.9.9.9", 1}, // major dominates
		{"1.0.0.1", "1.0.0.0", 1},
		{"1.0.0.0", "1.0.0.1", -1},
	}
	for _, tc := range cases {
		a, err := parseFileVersion(tc.a)
		if err != nil {
			t.Fatalf("setup parseFileVersion(%q): %v", tc.a, err)
		}
		b, err := parseFileVersion(tc.b)
		if err != nil {
			t.Fatalf("setup parseFileVersion(%q): %v", tc.b, err)
		}
		if got := compareFileVersions(a, b); got != tc.want {
			t.Errorf("compareFileVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestEvaluateFileVersionComparison(t *testing.T) {
	tests := []struct {
		name          string
		actual        string
		operator      string
		target        string
		wantMatched   bool
		wantSupported bool
	}{
		{"ge equal", "1.2.3.4", ">=", "1.2.3.4", true, true},
		{"ge greater", "2.0.0.0", ">=", "1.2.3.4", true, true},
		{"ge lesser", "1.0.0.0", ">=", "1.2.3.4", false, true},
		{"gt equal is false", "1.2.3.4", ">", "1.2.3.4", false, true},
		{"gt greater", "1.2.3.5", ">", "1.2.3.4", true, true},
		{"eq match", "1.2", "==", "1.2.0.0", true, true},
		{"eq mismatch", "1.2.0.1", "==", "1.2", false, true},
		{"single = alias for eq", "1.2.3.4", "=", "1.2.3.4", true, true},
		{"le equal", "1.2.3.4", "<=", "1.2.3.4", true, true},
		{"le lesser", "1.0", "<=", "1.2", true, true},
		{"lt greater is false", "2.0", "<", "1.9", false, true},
		{"numeric not lexical: 1.10 >= 1.9", "1.10", ">=", "1.9", true, true},
		{"unknown operator => unsupported", "1.2.3.4", "~=", "1.2.3.4", false, false},
		{"unparseable actual => unsupported", "1.x", ">=", "1.0", false, false},
		{"unparseable target => unsupported", "1.0", ">=", "1.x", false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			matched, supported := evaluateFileVersionComparison(tc.actual, tc.operator, tc.target)
			if matched != tc.wantMatched {
				t.Errorf("matched: want %v, got %v", tc.wantMatched, matched)
			}
			if supported != tc.wantSupported {
				t.Errorf("supported: want %v, got %v", tc.wantSupported, supported)
			}
		})
	}
}

// On non-Windows, a file_version clause is platform-unsupported and the whole
// rule set must report Supported=false (fall back to exit-code behavior).
func TestEvaluateDetectionRules_FileVersionUnsupportedOnNonWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file_version is supported on Windows")
	}
	out := EvaluateDetectionRules([]DetectionRule{
		{Type: "file_version", Path: `C:\app.exe`, Operator: ">=", Version: "1.0"},
	})
	if out.Supported {
		t.Errorf("expected Supported=false on non-Windows, got true (detail: %q)", out.Detail)
	}
	if out.Detected {
		t.Errorf("expected Detected=false, got true (detail: %q)", out.Detail)
	}
}

// ---------------------------------------------------------------------------
// EvaluateDetectionRules — file_exists (cross-platform)
// ---------------------------------------------------------------------------

func TestEvaluateDetectionRules_FileExists(t *testing.T) {
	dir := t.TempDir()
	existingFile := filepath.Join(dir, "present.txt")
	if err := os.WriteFile(existingFile, []byte("hello"), 0o644); err != nil {
		t.Fatalf("setup: %v", err)
	}
	missingPath := filepath.Join(dir, "absent.txt")

	tests := []struct {
		name          string
		rules         []DetectionRule
		wantDetected  bool
		wantSupported bool
	}{
		{
			name:          "existing file => detected",
			rules:         []DetectionRule{{Type: "file_exists", Path: existingFile}},
			wantDetected:  true,
			wantSupported: true,
		},
		{
			name:          "missing path => not detected",
			rules:         []DetectionRule{{Type: "file_exists", Path: missingPath}},
			wantDetected:  false,
			wantSupported: true,
		},
		{
			name:          "directory path => detected",
			rules:         []DetectionRule{{Type: "file_exists", Path: dir}},
			wantDetected:  true,
			wantSupported: true,
		},
		{
			name: "AND two existing => detected",
			rules: []DetectionRule{
				{Type: "file_exists", Path: existingFile},
				{Type: "file_exists", Path: dir},
			},
			wantDetected:  true,
			wantSupported: true,
		},
		{
			name: "AND existing + missing => not detected",
			rules: []DetectionRule{
				{Type: "file_exists", Path: existingFile},
				{Type: "file_exists", Path: missingPath},
			},
			wantDetected:  false,
			wantSupported: true,
		},
		{
			name: "AND missing + existing => not detected (short-circuits on first fail)",
			rules: []DetectionRule{
				{Type: "file_exists", Path: missingPath},
				{Type: "file_exists", Path: existingFile},
			},
			wantDetected:  false,
			wantSupported: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out := EvaluateDetectionRules(tc.rules)
			if out.Detected != tc.wantDetected {
				t.Errorf("Detected: want %v, got %v (detail: %q)", tc.wantDetected, out.Detected, out.Detail)
			}
			if out.Supported != tc.wantSupported {
				t.Errorf("Supported: want %v, got %v (detail: %q)", tc.wantSupported, out.Supported, out.Detail)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// EvaluateDetectionRules — empty rules
// ---------------------------------------------------------------------------

func TestEvaluateDetectionRules_EmptyRules(t *testing.T) {
	out := EvaluateDetectionRules(nil)
	if out.Supported {
		t.Error("expected Supported=false for nil rules")
	}
	if out.Detected {
		t.Error("expected Detected=false for nil rules")
	}

	out = EvaluateDetectionRules([]DetectionRule{})
	if out.Supported {
		t.Error("expected Supported=false for empty rules slice")
	}
	if out.Detected {
		t.Error("expected Detected=false for empty rules slice")
	}
}

// ---------------------------------------------------------------------------
// EvaluateDetectionRules — platform-unsupported clauses (non-Windows)
// On Windows CI these tests would behave differently; we guard with
// runtime.GOOS so the assertions always match the platform being tested.
// ---------------------------------------------------------------------------

func TestEvaluateDetectionRules_UnsupportedOnNonWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unsupported-clause path only tested on non-Windows")
	}

	t.Run("registry clause alone => Supported=false", func(t *testing.T) {
		rules := []DetectionRule{
			{Type: "registry", Hive: "HKLM", Path: `SOFTWARE\MyApp`},
		}
		out := EvaluateDetectionRules(rules)
		if out.Supported {
			t.Errorf("expected Supported=false, got true (detail: %q)", out.Detail)
		}
		if out.Detected {
			t.Errorf("expected Detected=false, got true (detail: %q)", out.Detail)
		}
	})

	t.Run("msi_product_code clause alone => Supported=false", func(t *testing.T) {
		rules := []DetectionRule{
			{Type: "msi_product_code", ProductCode: "{AABBCCDD-1234-5678-ABCD-000000000001}"},
		}
		out := EvaluateDetectionRules(rules)
		if out.Supported {
			t.Errorf("expected Supported=false, got true (detail: %q)", out.Detail)
		}
	})

	t.Run("file_exists (present) + registry => Supported=false", func(t *testing.T) {
		dir := t.TempDir()
		existingFile := filepath.Join(dir, "present.txt")
		if err := os.WriteFile(existingFile, []byte("hello"), 0o644); err != nil {
			t.Fatalf("setup: %v", err)
		}
		rules := []DetectionRule{
			{Type: "file_exists", Path: existingFile},
			{Type: "registry", Hive: "HKLM", Path: `SOFTWARE\MyApp`},
		}
		out := EvaluateDetectionRules(rules)
		if out.Supported {
			t.Errorf("expected Supported=false due to registry clause, got true (detail: %q)", out.Detail)
		}
		if out.Detected {
			t.Errorf("expected Detected=false, got true (detail: %q)", out.Detail)
		}
	})

	t.Run("unknown clause type => Supported=false", func(t *testing.T) {
		rules := []DetectionRule{
			{Type: "wmi_query", Path: "SELECT * FROM Win32_Product"},
		}
		out := EvaluateDetectionRules(rules)
		if out.Supported {
			t.Errorf("expected Supported=false for unknown type, got true (detail: %q)", out.Detail)
		}
	})
}
