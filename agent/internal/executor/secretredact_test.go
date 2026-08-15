package executor

import (
	"strings"
	"testing"
)

// #3409 PR4b — value-based output redactor. Mirrors
// apps/api/src/services/exactSecretRedaction.ts (not present in this
// worktree; behavior specified in the task brief).

func TestBuildSecretRedactor_ReplacesEveryOccurrence(t *testing.T) {
	redact := BuildSecretRedactor([]string{"hunter2000"})
	got := redact("token=hunter2000 and again hunter2000")
	want := "token=[REDACTED] and again [REDACTED]"
	if got != want {
		t.Fatalf("redact() = %q, want %q", got, want)
	}
}

func TestBuildSecretRedactor_NeverNamesTheVariable(t *testing.T) {
	redact := BuildSecretRedactor([]string{"hunter2000"})
	got := redact("hunter2000")
	if got != SecretRedactionMarker {
		t.Fatalf("redact() = %q, want exactly %q (marker must never name the variable)", got, SecretRedactionMarker)
	}
}

func TestBuildSecretRedactor_LiteralNotPattern(t *testing.T) {
	// "a.c*d" would match "abcd" as a regex (. and * are metacharacters).
	// Treated as a literal, it must not.
	redact := BuildSecretRedactor([]string{"a.c*d"})
	got := redact("abcd a.c*d")
	want := "abcd [REDACTED]"
	if got != want {
		t.Fatalf("redact() = %q, want %q (value must be matched literally, not compiled as regex)", got, want)
	}
}

func TestBuildSecretRedactor_MergesOverlappingMatchesIntoOneMarker(t *testing.T) {
	// "abcabc" matches [2,8) in "xxabcabcxx"; "bcab" matches [3,7). These
	// overlap and must collapse into a single marker, not two adjacent ones.
	redact := BuildSecretRedactor([]string{"abcabc", "bcab"})
	got := redact("xxabcabcxx")
	want := "xx[REDACTED]xx"
	if got != want {
		t.Fatalf("redact() = %q, want %q (overlapping ranges must merge into one marker)", got, want)
	}
}

func TestBuildSecretRedactor_DoesNotRescanItsOwnMarker(t *testing.T) {
	// "REDACTED" is itself a supplied secret value. The text "secret" does not
	// contain "REDACTED" until AFTER redaction, so matching must happen only
	// against the original text — never against intermediate output.
	redact := BuildSecretRedactor([]string{"secret", "REDACTED"})
	got := redact("secret")
	if got != SecretRedactionMarker {
		t.Fatalf("redact() = %q, want exactly %q (must not rescan its own marker text)", got, SecretRedactionMarker)
	}
}

func TestBuildSecretRedactor_Idempotent(t *testing.T) {
	redact := BuildSecretRedactor([]string{"hunter2000"})
	once := redact("token=hunter2000 and again hunter2000")
	twice := redact(once)
	if twice != once {
		t.Fatalf("redacting output again changed it: once=%q twice=%q", once, twice)
	}
}

func TestBuildSecretRedactor_DedupesIdenticalValues(t *testing.T) {
	redact := BuildSecretRedactor([]string{"hunter2000", "hunter2000"})
	got := redact("token=hunter2000")
	want := "token=[REDACTED]"
	if got != want {
		t.Fatalf("redact() = %q, want %q", got, want)
	}
}

func TestBuildSecretRedactor_IgnoresEmptyAndSubFloorValues(t *testing.T) {
	if MinSecretValueLength <= 2 {
		t.Fatalf("test assumes MinSecretValueLength > 2, got %d", MinSecretValueLength)
	}
	redact := BuildSecretRedactor([]string{"", "ab"})
	input := "ab and an empty  gap"
	got := redact(input)
	if got != input {
		t.Fatalf("redact() = %q, want input unchanged %q (empty and sub-floor values must be ignored, not shred output)", got, input)
	}
}

func TestBuildSecretRedactor_PassthroughWhenNothingToRedact(t *testing.T) {
	tests := []struct {
		name   string
		values []string
	}{
		{"nil slice", nil},
		{"empty slice", []string{}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			redact := BuildSecretRedactor(tt.values)
			if redact == nil {
				t.Fatalf("BuildSecretRedactor(%#v) returned a nil function, want a passthrough function", tt.values)
			}
			input := "nothing here should change"
			got := redact(input)
			if got != input {
				t.Fatalf("redact() = %q, want input unchanged %q", got, input)
			}
		})
	}
}

func TestBuildSecretRedactor_LargeInputNoQuadraticBlowup(t *testing.T) {
	const secret = "super-secret-token-value-123456"
	filler := strings.Repeat("x", 512*1024)
	input := filler + secret + filler

	redact := BuildSecretRedactor([]string{secret})
	got := redact(input)

	if !strings.Contains(got, SecretRedactionMarker) {
		t.Fatalf("redact() output missing marker %q", SecretRedactionMarker)
	}
	if strings.Contains(got, secret) {
		t.Fatalf("redact() output still contains the secret value")
	}
	wantLen := len(filler)*2 + len(SecretRedactionMarker)
	if len(got) != wantLen {
		t.Fatalf("redact() output length = %d, want %d", len(got), wantLen)
	}
}
