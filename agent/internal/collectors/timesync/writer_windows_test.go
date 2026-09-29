//go:build windows

package timesync

import (
	"reflect"
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
