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
