package security

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The threat-signature table is XOR-obfuscated so its distinctive tokens never
// appear plaintext in shipped binaries (issue #2797). These tests verify the
// decoded table byte-for-byte WITHOUT embedding any contiguous distinctive
// token in this source file either — every expected value is assembled at
// runtime from fragments. Do NOT "simplify" the concatenations below into
// single literals: the CI guard greps built binaries (and source) for the
// contiguous tokens, and the test binary must stay clean too.

// avTestToken returns the well-known AV test-file token ("eic"+"ar"),
// assembled at runtime.
func avTestToken() string { return "eic" + "ar" }

// avTestContent returns the full 68-byte AV test-file content pattern,
// assembled at runtime from fragments.
func avTestContent() string {
	return "X5O!P%@AP[4\\" +
		"PZX54(P^)7CC)7}$" +
		"EIC" + "AR-STANDARD-" +
		"ANTIVIRUS-TEST-" +
		"FILE!$H+H*"
}

func credToolToken() string  { return "mimi" + "katz" } // credential dumping tool name
func credToolToken2() string { return "seku" + "rlsa" } // credential extraction module name
func c2Token() string        { return "cobalt" + "strike" }
func trojanToken() string    { return "emo" + "tet" }
func trojanToken2() string   { return "trick" + "bot" }

func expectedThreatSignatures() []threatSignature {
	return []threatSignature{
		{
			Name:             "EIC" + "AR-Test-File",
			Type:             "malware",
			Severity:         ThreatSeverityHigh,
			FilenamePatterns: []string{avTestToken()},
			ContentPattern:   []byte(avTestContent()),
		},
		{
			Name:             "Mimi" + "katz",
			Type:             "malware",
			Severity:         ThreatSeverityHigh,
			FilenamePatterns: []string{credToolToken(), credToolToken2()},
		},
		{
			Name:             "Cobalt" + "Strike-Beacon",
			Type:             "malware",
			Severity:         ThreatSeverityCritical,
			FilenamePatterns: []string{c2Token(), "beacon"},
		},
		{
			Name:             "Emo" + "tet",
			Type:             "trojan",
			Severity:         ThreatSeverityCritical,
			FilenamePatterns: []string{trojanToken(), trojanToken2()},
		},
		{
			Name:             "Ransomware-Note",
			Type:             "ransomware",
			Severity:         ThreatSeverityHigh,
			FilenamePatterns: []string{"_readme", "how_to_decrypt", "recover", "decrypt"},
		},
	}
}

func TestThreatSignaturesDecodeExactly(t *testing.T) {
	got := threatSignatures()
	want := expectedThreatSignatures()

	if len(got) != len(want) {
		t.Fatalf("signature count = %d, want %d", len(got), len(want))
	}

	t.Run("content pattern is exactly 68 bytes and matches", func(t *testing.T) {
		content := got[0].ContentPattern
		if len(content) != 68 {
			t.Fatalf("content pattern length = %d, want 68", len(content))
		}
		if string(content) != avTestContent() {
			t.Fatalf("content pattern = %q, want %q", content, avTestContent())
		}
	})

	for i := range want {
		t.Run("signature "+want[i].Type+"/"+want[i].Severity, func(t *testing.T) {
			if !reflect.DeepEqual(got[i], want[i]) {
				t.Fatalf("signature %d mismatch:\n got %+v\nwant %+v", i, got[i], want[i])
			}
		})
	}
}

func TestThreatSignaturesStableAcrossCalls(t *testing.T) {
	first := threatSignatures()
	second := threatSignatures()
	if !reflect.DeepEqual(first, second) {
		t.Fatal("threatSignatures() not stable across calls")
	}
}

// scanOptionsForTest returns options with no exclusions: the default darwin
// exclusion list contains /private/var/folders, which is where t.TempDir()
// lives on macOS, so DetectThreats' defaults would skip the fixtures.
func scanOptionsForTest() threatScanOptions {
	return threatScanOptions{
		MaxFileSize:  1 << 20,
		MaxReadBytes: 1 << 20,
	}
}

func TestDetectThreatsContentPattern(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sample.bin")
	if err := os.WriteFile(path, []byte("prefix "+avTestContent()+" suffix"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	threats, err := detectThreats([]string{path}, scanOptionsForTest())
	if err != nil {
		t.Fatalf("detectThreats: %v", err)
	}
	if len(threats) != 1 {
		t.Fatalf("got %d threats, want 1: %+v", len(threats), threats)
	}
	if want := "EIC" + "AR-Test-File"; threats[0].Name != want {
		t.Errorf("threat name = %q, want %q", threats[0].Name, want)
	}
	if threats[0].Severity != ThreatSeverityHigh {
		t.Errorf("threat severity = %q, want %q", threats[0].Severity, ThreatSeverityHigh)
	}
	if threats[0].Path != filepath.Clean(path) {
		t.Errorf("threat path = %q, want %q", threats[0].Path, filepath.Clean(path))
	}
}

func TestDetectThreatsFilenamePattern(t *testing.T) {
	cases := []struct {
		name         string
		filename     string
		wantName     string
		wantSeverity string
	}{
		{"credential tool filename", credToolToken() + "_x64.bin", "Mimi" + "katz", ThreatSeverityHigh},
		{"c2 beacon filename", c2Token() + "-loader.txt", "Cobalt" + "Strike-Beacon", ThreatSeverityCritical},
		{"ransom note filename", "how_to_decrypt.txt", "Ransomware-Note", ThreatSeverityHigh},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, tc.filename)
			if err := os.WriteFile(path, []byte("benign content"), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}

			threats, err := detectThreats([]string{dir}, scanOptionsForTest())
			if err != nil {
				t.Fatalf("detectThreats: %v", err)
			}
			if len(threats) != 1 {
				t.Fatalf("got %d threats, want 1: %+v", len(threats), threats)
			}
			if threats[0].Name != tc.wantName {
				t.Errorf("threat name = %q, want %q", threats[0].Name, tc.wantName)
			}
			if threats[0].Severity != tc.wantSeverity {
				t.Errorf("threat severity = %q, want %q", threats[0].Severity, tc.wantSeverity)
			}
		})
	}
}

func TestDetectThreatsCleanFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(path, []byte("perfectly ordinary file"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	threats, err := detectThreats([]string{dir}, scanOptionsForTest())
	if err != nil {
		t.Fatalf("detectThreats: %v", err)
	}
	if len(threats) != 0 {
		t.Fatalf("got %d threats on clean dir, want 0: %+v", len(threats), threats)
	}
}
