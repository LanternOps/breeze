package executor

import (
	"strings"
	"testing"
)

// A representative base64 body line that must never survive redaction.
const testKeyBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDb1234567890abcd"

func TestSanitizeOutput_PrivateKeyRedaction(t *testing.T) {
	pkcs8 := "-----BEGIN PRIVATE KEY-----\n" + testKeyBody + "\nAnOtHeRlInE0987654321\n-----END PRIVATE KEY-----"
	rsa := "-----BEGIN RSA PRIVATE KEY-----\n" + testKeyBody + "\n-----END RSA PRIVATE KEY-----"
	openssh := "-----BEGIN OPENSSH PRIVATE KEY-----\n" + testKeyBody + "\n-----END OPENSSH PRIVATE KEY-----"
	ec := "-----BEGIN EC PRIVATE KEY-----\n" + testKeyBody + "\n-----END EC PRIVATE KEY-----"
	encrypted := "-----BEGIN ENCRYPTED PRIVATE KEY-----\n" + testKeyBody + "\n-----END ENCRYPTED PRIVATE KEY-----"
	// A key truncated between header and footer: BEGIN + full base64 body but no
	// END marker (output caps, killed process). The complete-block rule can't
	// match it, so the fallback header+body rule must catch it.
	truncated := "-----BEGIN PRIVATE KEY-----\n" + testKeyBody + "\nAnOtHeRlInE0987654321"

	tests := []struct {
		name  string
		input string
		// wantAbsent are substrings that must NOT appear in the sanitized output
		// (base64 body, footer markers, header markers).
		wantAbsent []string
		// wantPresent are substrings that MUST survive (surrounding non-key text).
		wantPresent []string
		// wantRedactionCount is how many [PRIVATE_KEY_REDACTED] markers to expect.
		wantRedactionCount int
	}{
		{
			name:               "PKCS#8 block fully redacted",
			input:              "before\n" + pkcs8 + "\nafter",
			wantAbsent:         []string{testKeyBody, "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----", "AnOtHeRlInE0987654321"},
			wantPresent:        []string{"before", "after"},
			wantRedactionCount: 1,
		},
		{
			name:               "RSA block body and END marker gone",
			input:              rsa,
			wantAbsent:         []string{testKeyBody, "-----BEGIN RSA PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----"},
			wantRedactionCount: 1,
		},
		{
			name:               "OPENSSH block fully redacted",
			input:              openssh,
			wantAbsent:         []string{testKeyBody, "OPENSSH PRIVATE KEY"},
			wantRedactionCount: 1,
		},
		{
			name:               "EC block fully redacted",
			input:              ec,
			wantAbsent:         []string{testKeyBody, "EC PRIVATE KEY"},
			wantRedactionCount: 1,
		},
		{
			name:               "ENCRYPTED block fully redacted",
			input:              encrypted,
			wantAbsent:         []string{testKeyBody, "ENCRYPTED PRIVATE KEY"},
			wantRedactionCount: 1,
		},
		{
			name:               "two keys both redacted",
			input:              rsa + "\nmiddle text\n" + openssh,
			wantAbsent:         []string{testKeyBody, "-----END RSA PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----"},
			wantPresent:        []string{"middle text"},
			wantRedactionCount: 2,
		},
		{
			// A truncated key is cut off at the end of output, so the greedy
			// fallback body match extends to end-of-string. Text BEFORE the BEGIN
			// header is untouched; there is no trailing text to preserve.
			name:               "truncated key (no END marker) still redacted",
			input:              "before the key\n" + truncated,
			wantAbsent:         []string{testKeyBody, "-----BEGIN PRIVATE KEY-----", "AnOtHeRlInE0987654321"},
			wantPresent:        []string{"before the key"},
			wantRedactionCount: 1,
		},
		{
			name:               "non-key text passthrough",
			input:              "just a normal script output with no secrets",
			wantPresent:        []string{"just a normal script output with no secrets"},
			wantRedactionCount: 0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SanitizeOutput(tt.input)

			for _, absent := range tt.wantAbsent {
				if strings.Contains(got, absent) {
					t.Errorf("sanitized output still contains %q; key not fully redacted.\ngot: %q", absent, got)
				}
			}
			for _, present := range tt.wantPresent {
				if !strings.Contains(got, present) {
					t.Errorf("sanitized output missing expected text %q.\ngot: %q", present, got)
				}
			}
			if n := strings.Count(got, "[PRIVATE_KEY_REDACTED]"); n != tt.wantRedactionCount {
				t.Errorf("expected %d [PRIVATE_KEY_REDACTED] markers, got %d.\noutput: %q", tt.wantRedactionCount, n, got)
			}
		})
	}
}

// deobfTok strips the '|' separators laced through a banned-token literal.
// The separator keeps the contiguous token bytes out of BOTH this source
// file and the compiled test binary (the bytes AV engines key on — issue
// #2797): `+` concatenation of literals is constant-folded at compile time,
// and even separate fragment literals get packed back-to-back into rodata by
// the linker (declaration-order packing was observed to reassemble the exact
// tokens). Only a single separator-laced literal stripped at RUNTIME is
// layout-proof. Do NOT "simplify" into plain literals or fragment joins.
func deobfTok(s string) string { return strings.ReplaceAll(s, "|", "") }

// TestValidate_ObfuscatedCredentialToolPatterns verifies the three
// credential-tool blocklist patterns still match after being moved to
// XOR-obfuscated storage (issue #2797). The tool names are assembled at
// runtime via deobfTok (see above). Each blocked case also asserts the
// error names the EXPECTED pattern description, so an unrelated pattern
// match cannot mask a broken decode.
func TestValidate_ObfuscatedCredentialToolPatterns(t *testing.T) {
	v := NewSecurityValidator(SecurityLevelStrict)

	credDumpTool := deobfTok("mimi|katz")
	credExtractMod := deobfTok("seku|rlsa")
	lsaDmp := deobfTok("lsa|dump")

	tests := []struct {
		name    string
		script  string
		wantErr string // "" = must pass; otherwise error must contain this description
	}{
		{"credential dumping tool invocation", "powershell -c .\\" + credDumpTool + ".exe", "credential dumping tool"},
		{"credential extraction module", "Invoke-Thing " + credExtractMod + "::logonpasswords", "credential extraction"},
		{"LSA dump keyword", "run " + lsaDmp + "::sam", "LSA dump"},
		{"mixed case still blocked", strings.ToUpper(credDumpTool), "credential dumping tool"},
		{"benign script passes", "Get-Process | Sort-Object CPU", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := v.Validate(tt.script)
			if tt.wantErr == "" {
				if err != nil {
					t.Errorf("Validate(%q) = %v, want nil", tt.script, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("Validate(%q) = nil, want dangerous-pattern error containing %q", tt.script, tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("Validate(%q) = %q, want error containing %q", tt.script, err.Error(), tt.wantErr)
			}
		})
	}

	// Basic level must NOT block strict-only patterns.
	basic := NewSecurityValidator(SecurityLevelBasic)
	if err := basic.Validate(credDumpTool); err != nil {
		t.Errorf("basic-level Validate blocked a strict-only pattern: %v", err)
	}
}
