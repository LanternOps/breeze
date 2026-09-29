//go:build windows

package timesync

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows/svc"
)

func TestNativeLayouts(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("amd64 layout assertion")
	}
	for name, pair := range map[string][2]uintptr{
		"dsrole":           {unsafe.Sizeof(dsRoleBasic{}), 48},
		"dcinfo":           {unsafe.Sizeof(dcInfo{}), 80},
		"dynamic timezone": {unsafe.Sizeof(dynamicTimezone{}), 432},
		"domain DNS":       {unsafe.Offsetof(dsRoleBasic{}.DomainNameDNS), 16},
		"DC domain":        {unsafe.Offsetof(dcInfo{}.DomainName), 40},
		"TZ key":           {unsafe.Offsetof(dynamicTimezone{}.TimeZoneKeyName), 172},
	} {
		if pair[0] != pair[1] {
			t.Fatalf("%s: %v", name, pair)
		}
	}
}

func TestServiceStateMapping(t *testing.T) {
	for _, tc := range []struct {
		in   svc.State
		want string
	}{
		{svc.Running, "running"}, {svc.Stopped, "stopped"}, {svc.StartPending, "start_pending"},
		{svc.ContinuePending, "start_pending"}, {svc.StopPending, "stop_pending"},
		{svc.PausePending, "stop_pending"}, {svc.Paused, "paused"}, {svc.State(0), "unknown"},
	} {
		if got := timeServiceState(tc.in); got != tc.want {
			t.Fatalf("%d=%s", tc.in, got)
		}
	}
}

func TestEventScriptUsesInsertionStringsAndAllLevels(t *testing.T) {
	script := eventScript(time.Unix(1, 0), time.Unix(2, 0), 100)
	for _, want := range []string{"Microsoft-Windows-Time-Service", ".Properties", "InvariantCulture", "-MaxEvents 100", "NoMatchingEventsFound", "ConvertTo-Json -InputObject"} {
		if !strings.Contains(script, want) {
			t.Fatalf("missing %s", want)
		}
	}
	if strings.Contains(script, "Level=") || strings.Contains(script, "Level =") {
		t.Fatal("events filtered by severity")
	}
	if !strings.Contains(script, "StartTime") || !strings.Contains(script, "EndTime") {
		t.Fatal("missing window")
	}
	if _, err := decodeEvents([]byte(`not JSON`)); err == nil {
		t.Fatal("bad query output hidden")
	}
	rows, err := decodeEvents([]byte(`[]`))
	if err != nil || rows == nil || len(rows) != 0 {
		t.Fatal(rows, err)
	}
}

func TestEventsSurfacesPowerShellStderr(t *testing.T) {
	var gotName string
	s := &windowsSystem{run: func(_ context.Context, _ time.Duration, name string, _ ...string) ([]byte, error) {
		gotName = name
		return nil, &exec.ExitError{Stderr: []byte("Get-WinEvent : The EventLog service is not running.\r\n")}
	}}
	_, err := s.Events(context.Background(), time.Unix(1, 0), time.Unix(2, 0), 10)
	if gotName != "powershell.exe" {
		t.Fatalf("event query ran %q", gotName)
	}
	var exitErr *exec.ExitError
	if err == nil || !strings.Contains(err.Error(), "The EventLog service is not running.") || !errors.As(err, &exitErr) {
		t.Fatalf("PowerShell reason lost: %v", err)
	}
}
