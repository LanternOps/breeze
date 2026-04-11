package userhelper

import (
	"errors"
	"fmt"
	"testing"
)

// ---------------------------------------------------------------------------
// PermanentRejectError tests
// ---------------------------------------------------------------------------

func TestPermanentRejectError_Error(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		err    *PermanentRejectError
		want   string
	}{
		{
			name:  "nil receiver returns sentinel string",
			err:   nil,
			want:  "permanent reject",
		},
		{
			name:  "both Code and Reason set — includes both",
			err:   &PermanentRejectError{Code: "binary_path_unknown", Reason: "binary path not registered"},
			want:  "broker permanently rejected helper: binary path not registered (binary_path_unknown)",
		},
		{
			name:  "empty Code — omits Code from output",
			err:   &PermanentRejectError{Code: "", Reason: "some reason"},
			want:  "broker permanently rejected helper: some reason",
		},
		{
			name:  "empty Reason with Code — only Reason branch, shows empty reason",
			err:   &PermanentRejectError{Code: "sid_mismatch", Reason: ""},
			want:  "broker permanently rejected helper:  (sid_mismatch)",
		},
		{
			name:  "both empty — shows empty reason, no code",
			err:   &PermanentRejectError{Code: "", Reason: ""},
			want:  "broker permanently rejected helper: ",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := tc.err.Error()
			if got != tc.want {
				t.Errorf("Error() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPermanentRejectError_CodeOr(t *testing.T) {
	t.Parallel()

	fallback := "fallback_code"

	tests := []struct {
		name string
		err  *PermanentRejectError
		want string
	}{
		{
			name: "nil receiver returns fallback",
			err:  nil,
			want: fallback,
		},
		{
			name: "non-empty Code returns Code",
			err:  &PermanentRejectError{Code: "binary_path_unknown"},
			want: "binary_path_unknown",
		},
		{
			name: "empty Code returns fallback",
			err:  &PermanentRejectError{Code: ""},
			want: fallback,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := tc.err.CodeOr(fallback)
			if got != tc.want {
				t.Errorf("CodeOr(%q) = %q, want %q", fallback, got, tc.want)
			}
		})
	}
}

func TestPermanentRejectError_ReasonOr(t *testing.T) {
	t.Parallel()

	fallback := "fallback_reason"

	tests := []struct {
		name string
		err  *PermanentRejectError
		want string
	}{
		{
			name: "nil receiver returns fallback",
			err:  nil,
			want: fallback,
		},
		{
			name: "non-empty Reason returns Reason",
			err:  &PermanentRejectError{Reason: "binary path not registered"},
			want: "binary path not registered",
		},
		{
			name: "empty Reason returns fallback",
			err:  &PermanentRejectError{Reason: ""},
			want: fallback,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := tc.err.ReasonOr(fallback)
			if got != tc.want {
				t.Errorf("ReasonOr(%q) = %q, want %q", fallback, got, tc.want)
			}
		})
	}
}

// TestPermanentRejectError_ErrorsIs verifies that PermanentRejectError does NOT
// implement errors.Is sentinel matching (it has no Is() method and is a pointer
// type, so errors.Is only matches if the exact same pointer is used).
func TestPermanentRejectError_ErrorsIs(t *testing.T) {
	t.Parallel()

	err1 := &PermanentRejectError{Code: "sid_mismatch", Reason: "SID mismatch"}
	err2 := &PermanentRejectError{Code: "sid_mismatch", Reason: "SID mismatch"}

	// Different pointers with same content — errors.Is should NOT match.
	if errors.Is(err1, err2) {
		t.Error("errors.Is(err1, err2): expected false for different pointers, got true")
	}

	// Same pointer — should match.
	if !errors.Is(err1, err1) {
		t.Error("errors.Is(err1, err1): expected true for same pointer, got false")
	}
}

// TestPermanentRejectError_ErrorsAs verifies that errors.As correctly extracts
// a *PermanentRejectError through a wrapping chain.
func TestPermanentRejectError_ErrorsAs(t *testing.T) {
	t.Parallel()

	perm := &PermanentRejectError{Code: "binary_path_unknown", Reason: "test rejection"}
	wrapped := fmt.Errorf("outer: %w", perm)

	var target *PermanentRejectError
	if !errors.As(wrapped, &target) {
		t.Fatal("errors.As(wrapped, &target): expected true, got false")
	}
	if target.Code != perm.Code {
		t.Errorf("extracted Code = %q, want %q", target.Code, perm.Code)
	}
	if target.Reason != perm.Reason {
		t.Errorf("extracted Reason = %q, want %q", target.Reason, perm.Reason)
	}
}

// TestPermanentRejectError_IsError verifies that *PermanentRejectError satisfies
// the error interface (compile-time check via assignment).
func TestPermanentRejectError_IsError(t *testing.T) {
	t.Parallel()

	var _ error = &PermanentRejectError{Code: "test", Reason: "test"}
}

// ---------------------------------------------------------------------------
// looksLikeSID tests
// ---------------------------------------------------------------------------

func TestLooksLikeSID(t *testing.T) {
	t.Parallel()

	// looksLikeSID returns true when: strings.HasPrefix(s, "S-1-") && len(s) >= 7
	// "S-1-" is 4 chars; min valid = "S-1-" + 3 more chars → len 7.
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{
			// Typical Windows user SID.
			name:  "valid full SID",
			input: "S-1-5-21-123-456-789-1000",
			want:  true,
		},
		{
			// Minimum length that satisfies both conditions: "S-1-5-6" = 7 chars.
			// HasPrefix("S-1-") = true, len = 7 >= 7.
			name:  "minimum valid length (7 chars)",
			input: "S-1-5-6",
			want:  true,
		},
		{
			// Length exactly 7, starts with "S-1-".
			name:  "minimum with different suffix",
			input: "S-1-xxx",
			want:  true,
		},
		{
			// Length 8 — above minimum, correct prefix.
			name:  "length 8 valid",
			input: "S-1-5-18",
			want:  true,
		},
		{
			// Empty string.
			name:  "empty string",
			input: "",
			want:  false,
		},
		{
			// "S-1-" alone is 4 chars — fails len >= 7.
			name:  "prefix only (len 4)",
			input: "S-1-",
			want:  false,
		},
		{
			// "S-1-5" is 5 chars — fails len >= 7.
			name:  "5 chars",
			input: "S-1-5",
			want:  false,
		},
		{
			// "S-1-55" is 6 chars — fails len >= 7.
			name:  "6 chars (one short of minimum)",
			input: "S-1-55",
			want:  false,
		},
		{
			// Wrong first digit — "S-2-" is not the "S-1-" prefix.
			name:  "wrong SID revision (S-2-)",
			input: "S-2-5-21-123-456-789-1000",
			want:  false,
		},
		{
			// Completely wrong format.
			name:  "random non-SID string",
			input: "random-not-a-sid",
			want:  false,
		},
		{
			// Close but wrong: missing the dash before the revision number.
			name:  "malformed prefix S-15-",
			input: "S-15-21-123-456-789-1000",
			want:  false,
		},
		{
			// Lowercase prefix — should not match (case-sensitive).
			name:  "lowercase s-1- prefix",
			input: "s-1-5-21-123",
			want:  false,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := looksLikeSID(tc.input)
			if got != tc.want {
				t.Errorf("looksLikeSID(%q) = %v, want %v", tc.input, got, tc.want)
			}
		})
	}
}
