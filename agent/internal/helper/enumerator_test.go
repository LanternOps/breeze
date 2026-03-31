package helper

import (
	"os"
	"runtime"
	"strconv"
	"testing"
)

func TestPlatformEnumerator(t *testing.T) {
	enum := NewPlatformEnumerator()
	sessions := enum.ActiveSessions()
	if len(sessions) == 0 {
		t.Skip("no active sessions detected")
	}

	if runtime.GOOS == "windows" {
		for _, s := range sessions {
			if s.Key == "0" {
				t.Fatal("enumerator returned Session 0")
			}
		}
		return
	}

	// Service/root contexts may legitimately enumerate a different active user.
	if os.Getuid() == 0 {
		return
	}
	myUID := strconv.Itoa(os.Getuid())
	for _, s := range sessions {
		if s.Key == myUID {
			return
		}
	}
	t.Fatalf("current uid %s not found in active sessions: %+v", myUID, sessions)
}
