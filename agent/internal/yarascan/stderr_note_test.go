package yarascan

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// #9253: when the engine had to swap an unusable stderr for the null device
// (a Windows service), the agent log says so once, with the reason, so the
// lab leg can see the guard engaged.
func TestNoteStderrRedirectLogsOnceWithReason(t *testing.T) {
	var buf bytes.Buffer
	logging.Init("text", "info", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	var once sync.Once
	redirect := func() (bool, error) {
		return true, errors.New("GetFileType /dev/stderr: The handle is invalid.")
	}
	noteStderrRedirect(&once, redirect)
	noteStderrRedirect(&once, redirect)

	out := buf.String()
	if n := strings.Count(out, "null device"); n != 1 {
		t.Fatalf("want exactly one stderr-redirect line, got %d:\n%s", n, out)
	}
	if !strings.Contains(out, "The handle is invalid") {
		t.Fatalf("redirect line must carry the reason stderr was unusable:\n%s", out)
	}
}

func TestNoteStderrRedirectSilentWhenStderrWasUsable(t *testing.T) {
	var buf bytes.Buffer
	logging.Init("text", "info", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	var once sync.Once
	noteStderrRedirect(&once, func() (bool, error) { return false, nil })
	if buf.Len() != 0 {
		t.Fatalf("no line expected when stderr was usable, got:\n%s", buf.String())
	}
}
