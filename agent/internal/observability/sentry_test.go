package observability

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestInitNoDSNIsNoOp(t *testing.T) {
	// Ensure DSN is unset; Init must return nil without error.
	t.Setenv("BREEZE_SENTRY_DSN", "")
	if err := Init("test-version"); err != nil {
		t.Fatalf("Init with no DSN should be a no-op, got: %v", err)
	}
	// Flush / CaptureException must be safe to call when uninitialized.
	Flush(50 * time.Millisecond)
	CaptureException(errors.New("dropped on the floor — Sentry uninitialized"))
}

func TestRedactSecretsBearer(t *testing.T) {
	out := redactSecrets("Authorization: Bearer abc123def")
	if !strings.Contains(out, "[REDACTED]") || strings.Contains(out, "abc123def") {
		t.Fatalf("expected bearer to be redacted, got: %s", out)
	}
}

func TestRedactSecretsBearerMidString(t *testing.T) {
	out := redactSecrets("calling api with bearer xyz789 and more text")
	if strings.Contains(out, "xyz789") {
		t.Fatalf("expected bearer token to be redacted, got: %s", out)
	}
	if !strings.Contains(out, "and more text") {
		t.Fatalf("expected suffix preserved, got: %s", out)
	}
}

func TestRedactSecretsBrzToken(t *testing.T) {
	out := redactSecrets("token=brz_aaaabbbbccccdddd eeee")
	if !strings.Contains(out, "brz_[REDACTED]") || strings.Contains(out, "brz_aaaabbbbccccdddd") {
		t.Fatalf("expected brz_ token to be redacted, got: %s", out)
	}
	if !strings.Contains(out, "eeee") {
		t.Fatalf("expected trailing word preserved, got: %s", out)
	}
}

func TestRedactSecretsPassthrough(t *testing.T) {
	in := "no secrets here, just a regular log line"
	if out := redactSecrets(in); out != in {
		t.Fatalf("expected passthrough, got: %s", out)
	}
}

func TestScrubHeaders(t *testing.T) {
	in := map[string]string{
		"Authorization": "Bearer abc",
		"X-Agent-Token": "brz_abcdef",
		"User-Agent":    "breeze-agent/1.0",
		"Cookie":        "session=xyz",
	}
	out := scrubHeaders(in)
	if out["Authorization"] != "[REDACTED]" {
		t.Errorf("Authorization not redacted: %s", out["Authorization"])
	}
	if out["X-Agent-Token"] != "[REDACTED]" {
		t.Errorf("X-Agent-Token not redacted: %s", out["X-Agent-Token"])
	}
	if out["Cookie"] != "[REDACTED]" {
		t.Errorf("Cookie not redacted: %s", out["Cookie"])
	}
	if out["User-Agent"] != "breeze-agent/1.0" {
		t.Errorf("User-Agent should pass through, got: %s", out["User-Agent"])
	}
}

func TestRecovererSwallowsErrorPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Recoverer did not swallow panic: %v", r)
		}
	}()
	func() {
		defer Recoverer("test.error")
		panic(errors.New("smoke"))
	}()
}

func TestRecovererSwallowsStringPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Recoverer did not swallow panic: %v", r)
		}
	}()
	func() {
		defer Recoverer("test.string")
		panic("string-panic")
	}()
}

func TestRecovererSwallowsOtherPanic(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Recoverer did not swallow panic: %v", r)
		}
	}()
	func() {
		defer Recoverer("test.other")
		panic(42)
	}()
}

func TestRecovererNoPanic(t *testing.T) {
	// Recoverer called with no active panic must not log or report.
	func() {
		defer Recoverer("test.no-panic")
	}()
}

func TestInitEmptyDSNAfterWhitespace(t *testing.T) {
	// Whitespace-only DSN should be treated as unset.
	os.Setenv("BREEZE_SENTRY_DSN", "   ")
	defer os.Unsetenv("BREEZE_SENTRY_DSN")
	if err := Init(""); err != nil {
		t.Fatalf("Init with whitespace DSN should be a no-op, got: %v", err)
	}
}
