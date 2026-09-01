package desktop

import (
	"errors"
	"regexp"
	"strings"
	"testing"
)

// No build tag, on purpose. The macOS shims are `darwin && cgo` and the
// Test Agent CI job runs on ubuntu-latest, so a test placed beside them would
// compile out and never execute (#4042).

// causeAsserting matches phrasing that names ONE cause for a symptom that has
// several. "may lack Screen Recording permission (check System Settings...)"
// on a plain timeout is what sent #3380 into the permissions UI four times.
var causeAsserting = regexp.MustCompile(`(?i)\b(probably|most likely|may lack|check System Settings)\b`)

func TestNoDisplayAttachedIsDistinctFromContentUnavailable(t *testing.T) {
	noDisplay := translateCaptureError(captureErrNoDisplayAttached)
	contentFailed := translateCaptureError(captureErrContentUnavailable)

	if noDisplay.Error() == contentFailed.Error() {
		t.Fatalf("no-display and content-unavailable must not produce the same message; both were %q", noDisplay)
	}
	// Both are still display-resolution failures for existing callers.
	for name, err := range map[string]error{"noDisplay": noDisplay, "contentFailed": contentFailed} {
		if !errors.Is(err, ErrDisplayNotFound) {
			t.Errorf("%s: expected errors.Is(..., ErrDisplayNotFound) to hold, got %v", name, err)
		}
	}
	// The whole point of the split: the remediations are opposite, so each
	// message must point at its own one.
	if !strings.Contains(noDisplay.Error(), "zero displays") {
		t.Errorf("no-display message should say the display count was zero, got %q", noDisplay)
	}
	if strings.Contains(noDisplay.Error(), "Screen Recording not granted") {
		t.Errorf("no-display message must not blame permissions, got %q", noDisplay)
	}
	if !strings.Contains(contentFailed.Error(), "Screen Recording") {
		t.Errorf("content-unavailable message should list Screen Recording among its causes, got %q", contentFailed)
	}
}

func TestTimeoutDoesNotAssertACause(t *testing.T) {
	err := translateCaptureError(captureErrTimeout)
	if got := causeAsserting.FindString(err.Error()); got != "" {
		t.Fatalf("timeout message asserts a cause (%q) for a symptom with several: %q", got, err)
	}
	if !strings.Contains(err.Error(), "Causes:") {
		t.Errorf("timeout message should enumerate causes, got %q", err)
	}
}

// Guards the rule for the whole table, so a future code added with a guessing
// message fails here rather than in a customer's support thread.
func TestNoCaptureErrorMessageAssertsACause(t *testing.T) {
	for code := 0; code <= 12; code++ {
		err := translateCaptureError(code)
		if err == nil {
			t.Fatalf("code %d returned a nil error", code)
		}
		if got := causeAsserting.FindString(err.Error()); got != "" {
			t.Errorf("code %d asserts a cause (%q): %q", code, got, err)
		}
	}
}

func TestEveryCodeHasADistinctMessage(t *testing.T) {
	codes := []int{
		captureErrDisplayList, captureErrContentUnavailable, captureErrPermissionDenied,
		captureErrAllocFailed, captureErrBitmapContext, captureErrNotInitialized,
		captureErrTimeout, captureErrBackendUnavailable, captureErrStreamCreate,
		captureErrStreamStart, captureErrNoDisplayAttached,
	}
	seen := make(map[string]int, len(codes))
	for _, code := range codes {
		msg := translateCaptureError(code).Error()
		if prev, dup := seen[msg]; dup {
			t.Errorf("codes %d and %d share the message %q — a caller cannot tell them apart", prev, code, msg)
		}
		seen[msg] = code
	}
}

func TestUnknownCodeReportsTheCode(t *testing.T) {
	err := translateCaptureError(99)
	if !strings.Contains(err.Error(), "99") {
		t.Errorf("unknown-code error should name the code, got %q", err)
	}
}
