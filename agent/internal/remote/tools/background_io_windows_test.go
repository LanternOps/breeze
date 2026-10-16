//go:build windows

package tools

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

// ERROR_THREAD_MODE_ALREADY_BACKGROUND: returned by a second BEGIN on a
// thread that is already in background mode — the observable proof that
// beginBackgroundIO actually switched the thread.
const errThreadModeAlreadyBackground = windows.Errno(400)

func TestBeginBackgroundIOEntersAndLeavesBackgroundMode(t *testing.T) {
	end := beginBackgroundIO()
	err := setCurrentThreadPriority(threadModeBackgroundBegin)
	if !errors.Is(err, errThreadModeAlreadyBackground) {
		end()
		t.Fatalf("thread not in background mode after beginBackgroundIO: second BEGIN returned %v", err)
	}
	end()
}
