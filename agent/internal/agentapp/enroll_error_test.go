package agentapp

import (
	"bytes"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/pkg/api"
)

func TestEnrollErrCategory_ExitCode(t *testing.T) {
	if got, want := catNetwork.exitCode(), 10; got != want {
		t.Errorf("catNetwork.exitCode() = %d, want %d", got, want)
	}
	if got, want := catUnknown.exitCode(), 16; got != want {
		t.Errorf("catUnknown.exitCode() = %d, want %d", got, want)
	}
	// catIdentityConflict (#2764 Task 6) was appended AFTER catUnknown
	// specifically so it gets the next unused code (17) without shifting
	// any previously-shipped code.
	if got, want := catIdentityConflict.exitCode(), 17; got != want {
		t.Errorf("catIdentityConflict.exitCode() = %d, want %d", got, want)
	}
}

func TestEnrollErrCategory_IsRefundable4xx(t *testing.T) {
	tests := []struct {
		cat  enrollErrCategory
		want bool
	}{
		{catAuth, true},
		{catNotFound, true},
		{catRateLimit, true},
		{catIdentityConflict, true},
		{catNetwork, false},
		{catServer, false},
		{catConfig, false},
		{catUnknown, false},
	}
	for _, tt := range tests {
		if got := tt.cat.isRefundable4xx(); got != tt.want {
			t.Errorf("%v.isRefundable4xx() = %v, want %v", tt.cat, got, tt.want)
		}
	}
}

func TestClassifyEnrollError_IdentityConflict(t *testing.T) {
	tests := []struct {
		name   string
		status int
		body   string
	}{
		{
			// Old servers only — new servers enroll a fresh row instead of
			// ever emitting this reason (#2764), but a self-hosted
			// deployment may still be running an older API.
			name:   "hostname collision (old server)",
			status: 409,
			body:   `{"error":"collision","reason":"hostname_collision_requires_existing_device_token"}`,
		},
		{
			name:   "decommissioned row with suspended token",
			status: 409,
			body:   `{"error":"suspended","reason":"existing_decommissioned_row_has_suspended_token"}`,
		},
		{
			name:   "device quarantined",
			status: 403,
			body:   `{"error":"quarantined","reason":"device_quarantined"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := &api.ErrHTTPStatus{StatusCode: tt.status, Body: tt.body}
			cat, friendly := classifyEnrollError(err, "https://example.com")
			if cat != catIdentityConflict {
				t.Errorf("category = %v, want catIdentityConflict", cat)
			}
			if !strings.Contains(strings.ToLower(friendly), "decommission") {
				t.Errorf("friendly = %q, should name the decommission-first remedy", friendly)
			}
			if friendly == "" {
				t.Error("friendly message should not be empty")
			}
		})
	}
}

// A plain 401/403/404 with no recognized `reason` field must still classify
// via the ordinary status-code switch — classifyIdentityConflict must not
// swallow every 4xx into catIdentityConflict.
func TestClassifyEnrollError_PlainStatusNotMisclassifiedAsIdentityConflict(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		wantCat enrollErrCategory
	}{
		{"403 with no reason field", 403, `{"error":"forbidden"}`, catAuth},
		{"403 with an unrecognized reason", 403, `{"error":"forbidden","reason":"some_other_reason"}`, catAuth},
		{"404 with no body", 404, "", catNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := &api.ErrHTTPStatus{StatusCode: tt.status, Body: tt.body}
			cat, _ := classifyEnrollError(err, "https://example.com")
			if cat != tt.wantCat {
				t.Errorf("category = %v, want %v", cat, tt.wantCat)
			}
		})
	}
}

func TestClassifyEnrollError_HTTPStatuses(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		wantCat enrollErrCategory
	}{
		{"401 unauthorized", 401, catAuth},
		{"403 forbidden", 403, catAuth},
		{"404 not found", 404, catNotFound},
		{"429 rate limited", 429, catRateLimit},
		{"500 internal error", 500, catServer},
		{"503 service unavailable", 503, catServer},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := &api.ErrHTTPStatus{StatusCode: tt.status, Body: "body"}
			cat, friendly := classifyEnrollError(err, "https://example.com")
			if cat != tt.wantCat {
				t.Errorf("category = %v, want %v", cat, tt.wantCat)
			}
			if friendly == "" {
				t.Error("friendly message should not be empty")
			}
		})
	}
}

func TestClassifyEnrollError_NetworkError(t *testing.T) {
	urlErr := &url.Error{Op: "Post", URL: "https://unreachable.example", Err: errors.New("dial tcp: connection refused")}
	cat, friendly := classifyEnrollError(urlErr, "https://unreachable.example")
	if cat != catNetwork {
		t.Errorf("category = %v, want catNetwork", cat)
	}
	if !strings.Contains(friendly, "server unreachable") {
		t.Errorf("friendly = %q, should contain 'server unreachable'", friendly)
	}
}

func TestClassifyEnrollError_Unknown(t *testing.T) {
	cat, friendly := classifyEnrollError(errors.New("something weird"), "https://example.com")
	if cat != catUnknown {
		t.Errorf("category = %v, want catUnknown", cat)
	}
	if friendly == "" {
		t.Error("friendly should echo the raw error string")
	}
}

func TestEnrollError_WritesAllFourSinks(t *testing.T) {
	// Redirect stderr to a buffer for observation.
	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w
	t.Cleanup(func() { os.Stderr = oldStderr })

	// Capture last-error file writes.
	var lastErrorCaptured string
	origWrite := writeLastErrorFile
	writeLastErrorFile = func(line string) { lastErrorCaptured = line }
	t.Cleanup(func() { writeLastErrorFile = origWrite })

	// Capture event-log writes.
	var eventLogCaptured string
	origEventLog := eventLogError
	eventLogError = func(source, message string) { eventLogCaptured = message }
	t.Cleanup(func() { eventLogError = origEventLog })

	// Capture exit code.
	var exitCapturedCode int
	origExit := osExit
	osExit = func(code int) {
		exitCapturedCode = code
		panic("test exit") // unwind the stack so enrollError's "never returns" is testable
	}
	t.Cleanup(func() { osExit = origExit })

	defer func() {
		recover() // swallow the test-exit panic
		w.Close()
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		stderrOutput := buf.String()

		if !strings.Contains(stderrOutput, "Enrollment failed:") {
			t.Errorf("stderr = %q, should contain 'Enrollment failed:'", stderrOutput)
		}
		if !strings.Contains(lastErrorCaptured, "Enrollment failed:") {
			t.Errorf("last error file = %q, should contain 'Enrollment failed:'", lastErrorCaptured)
		}
		if !strings.Contains(eventLogCaptured, "Enrollment failed:") {
			t.Errorf("event log = %q, should contain 'Enrollment failed:'", eventLogCaptured)
		}
		if exitCapturedCode != catAuth.exitCode() {
			t.Errorf("exit code = %d, want %d", exitCapturedCode, catAuth.exitCode())
		}
	}()

	enrollError(catAuth, "enrollment key not recognized", errors.New("http 401"))
}

func TestClearEnrollLastError_RemovesStaleFile(t *testing.T) {
	tmp := t.TempDir()
	// Override the path helper so the test doesn't touch real ProgramData.
	origPath := enrollLastErrorPath
	enrollLastErrorPath = func() string { return filepath.Join(tmp, "enroll-last-error.txt") }
	t.Cleanup(func() { enrollLastErrorPath = origPath })

	// Create a stale file.
	if err := os.WriteFile(enrollLastErrorPath(), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	clearEnrollLastError()

	if _, err := os.Stat(enrollLastErrorPath()); !os.IsNotExist(err) {
		t.Errorf("stale file should have been removed, stat err = %v", err)
	}
}

func TestClearEnrollLastError_NoFileIsNoError(t *testing.T) {
	tmp := t.TempDir()
	origPath := enrollLastErrorPath
	enrollLastErrorPath = func() string { return filepath.Join(tmp, "never-existed.txt") }
	t.Cleanup(func() { enrollLastErrorPath = origPath })

	// Should not panic or log at error level.
	clearEnrollLastError()
}
