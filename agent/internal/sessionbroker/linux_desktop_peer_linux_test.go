//go:build linux

package sessionbroker

import (
	"os"
	"testing"
)

func TestParseProcStatStartTime(t *testing.T) {
	// comm may contain spaces and parentheses; fields count from the last ')'.
	stat := "1234 (a (weird) name) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 200 18446744073709551615"
	got, ok := parseProcStatStartTime(stat)
	if !ok || got != 98765 {
		t.Fatalf("start = %d, %v; want 98765", got, ok)
	}
	for _, bad := range []string{"", "1234 (x) S 1 2", "no paren here", "1 (x) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 notanumber"} {
		if _, ok := parseProcStatStartTime(bad); ok {
			t.Errorf("parsed %q", bad)
		}
	}
}

func TestParseProcStatusUID(t *testing.T) {
	ok := "Name:\tx\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n"
	if uid, good := parseProcStatusUID(ok); !good || uid != 1000 {
		t.Fatalf("uid %d %v", uid, good)
	}
	for _, bad := range []string{"", "Name:\tx\n", "Uid:\t1000\t0\t0\t0\n", "Uid:\tx\tx\n", "Uid:\t1000\n"} {
		if _, good := parseProcStatusUID(bad); good {
			t.Errorf("parsed %q", bad)
		}
	}
}

func TestLinuxDesktopPeerIdentity_Self(t *testing.T) {
	start, uid, alive := linuxDesktopPeerIdentity(os.Getpid())
	if !alive || start == 0 || uid != uint32(os.Getuid()) {
		t.Fatalf("self identity start=%d uid=%d alive=%v", start, uid, alive)
	}
	again, _, _ := linuxDesktopPeerIdentity(os.Getpid())
	if again != start {
		t.Fatal("start time not stable for one process")
	}
	if _, _, alive := linuxDesktopPeerIdentity(0); alive {
		t.Fatal("pid 0 reported alive")
	}
}
