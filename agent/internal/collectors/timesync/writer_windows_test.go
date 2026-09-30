//go:build windows

package timesync

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestManagementWindowsQuoteRoundTrip(t *testing.T) {
	want := []string{"w32tm.exe", "/config", "/manualpeerlist:time.cloudflare.com,0x9 pool.ntp.org,0x9", "/syncfromflags:manual", "/update"}
	got, err := windows.DecomposeCommandLine(windows.ComposeCommandLine(want))
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatal(got, err)
	}
}
func TestManagementInstalledZoneValidation(t *testing.T) {
	if err := windowsZoneExists("UTC"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", `..\UTC`, "UTC/child", "Breeze Nonexistent Test Zone"} {
		if err := windowsZoneExists(id); err == nil {
			t.Fatalf("accepted %q", id)
		}
	}
}
func TestManagementSCMStartErrorMapping(t *testing.T) {
	// A trigger-start W32Time that started itself (or is start-pending) is success.
	if err := scmStartError(windows.ERROR_SERVICE_ALREADY_RUNNING); err != nil {
		t.Fatal(err)
	}
	if err := scmStartError(nil); err != nil {
		t.Fatal(err)
	}
	for _, e := range []error{windows.ERROR_SERVICE_DISABLED, windows.ERROR_ACCESS_DENIED} {
		if err := scmStartError(e); !errors.Is(err, e) {
			t.Fatal(err)
		}
	}
}
func TestManagementRunTimeCommandReportsHresultInHex(t *testing.T) {
	// cmd.exe exits with the HRESULT w32tm returns while W32Time is stopped.
	code, err := runTimeCommand(context.Background(), "cmd.exe", "/c", "exit", "-2147023834")
	var ee *exec.ExitError
	if uint32(code) != 0x80070426 || err == nil || !errors.As(err, &ee) {
		t.Fatal(code, err)
	}
	if got := err.Error(); got != "cmd.exe exited 0x80070426" {
		t.Fatalf("error %q", got)
	}
	if code, err = runTimeCommand(context.Background(), "cmd.exe", "/c", "exit", "0"); code != 0 || err != nil {
		t.Fatal(code, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = runTimeCommand(ctx, "cmd.exe", "/c", "exit", "0"); !errors.Is(err, context.Canceled) || !strings.HasPrefix(err.Error(), "cmd.exe did not finish: ") {
		t.Fatal(err)
	}
	if _, err = runTimeCommand(context.Background(), "breeze-missing-tool.exe"); err == nil || !strings.HasPrefix(err.Error(), "run breeze-missing-tool.exe: ") {
		t.Fatal(err)
	}
}
