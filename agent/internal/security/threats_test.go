package security

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The threat-signature table is XOR-obfuscated so its distinctive tokens never
// appear plaintext in shipped binaries (issue #2797). These tests verify the
// decoded table byte-for-byte WITHOUT embedding any contiguous distinctive
// token in this source file OR in the compiled test binary. Two traps make
// the obvious spellings unsafe:
//
//   - `"eic" + "ar-..."` is an untyped-constant expression the compiler folds
//     at BUILD time, so the contiguous token lands verbatim in the test
//     binary's data section — exactly the bytes AV engines key on, risking
//     quarantine of test binaries.
//   - Separate fragment literals (e.g. a []string joined at runtime) are not
//     safe either: the linker packs short string literals back-to-back into
//     rodata, and declaration-order packing was observed to reassemble the
//     exact contiguous tokens in the compiled test binary.
//
// The only layout-proof form is a SINGLE literal with a separator laced
// through the token, stripped at runtime by deobf() — the token bytes then
// never exist contiguously anywhere but in the runtime heap. Do NOT
// "simplify" these into plain literals, concatenations, or fragment joins.

// deobf strips the '|' separators laced through a token literal (see the
// comment above). None of the real tokens/payloads contain '|'.
func deobf(s string) string { return strings.ReplaceAll(s, "|", "") }

// avTestToken returns the well-known AV test-file token, assembled at runtime.
func avTestToken() string { return deobf("eic|ar") }

// avTestContent returns the full 68-byte AV test-file content pattern,
// assembled at runtime.
func avTestContent() string {
	return deobf("X5O!P|%@AP[4\\|PZX54|(P^)7C|C)7}$|EIC|AR-STAND|ARD-ANT|IVIRUS|-TEST-|FILE!|$H+H*")
}

func avSigName() string     { return deobf("EIC|AR-Test-File") }
func credSigName() string   { return deobf("Mimi|katz") }
func c2SigName() string     { return deobf("Cobalt|Strike-Beacon") }
func trojanSigName() string { return deobf("Emo|tet") }

func credToolToken() string  { return deobf("mimi|katz") } // credential dumping tool name
func credToolToken2() string { return deobf("seku|rlsa") } // credential extraction module name
func c2Token() string        { return deobf("cobalt|strike") }
func trojanToken() string    { return deobf("emo|tet") }
func trojanToken2() string   { return deobf("trick|bot") }

func expectedThreatSignatures() []threatSignature {
	return []threatSignature{
		{
			Name:             avSigName(),
			Type:             "malware",
			Severity:         ThreatSeverityHigh,
			FilenamePatterns: []string{avTestToken()},
			ContentPattern:   []byte(avTestContent()),
		},
		{
			Name:             credSigName(),
			Type:             "malware",
			Severity:         ThreatSeverityHigh,
			FilenamePatterns: []string{credToolToken(), credToolToken2()},
		},
		{
			Name:             c2SigName(),
			Type:             "malware",
			Severity:         ThreatSeverityCritical,
			FilenamePatterns: []string{c2Token(), "beacon"},
		},
		{
			Name:             trojanSigName(),
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
	if want := avSigName(); threats[0].Name != want {
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
		{"credential tool filename", credToolToken() + "_x64.bin", credSigName(), ThreatSeverityHigh},
		{"c2 beacon filename", c2Token() + "-loader.txt", c2SigName(), ThreatSeverityCritical},
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
