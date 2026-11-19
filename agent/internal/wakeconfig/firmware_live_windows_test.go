//go:build windows

package wakeconfig

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// TestLiveDellFirmwareReadiness runs the shipped Windows path end to end on
// real hardware: Detect, the Dell PowerShell read, ReadFirmware, and Compute
// over the live Windows readings. Opt-in (BREEZE_LIVE_DELL_BIOS=1), for a lab
// Dell, run as SYSTEM. It asserts only that the firmware layer was read.
func TestLiveDellFirmwareReadiness(t *testing.T) {
	if os.Getenv("BREEZE_LIVE_DELL_BIOS") != "1" {
		t.Skip("set BREEZE_LIVE_DELL_BIOS=1 on a lab Dell")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	a := biosconfig.Detect("Dell Inc.", "")
	if a == nil {
		t.Fatal("Detect returned nil on Windows")
	}
	fw := ReadFirmware(ctx, a)
	if fw == nil || fw.Status != FirmwareRead {
		t.Fatalf("firmware not read: %+v", fw)
	}
	win, err := CollectWindows(ctx)
	if err != nil {
		t.Fatalf("windows readings: %v", err)
	}
	s := Compute(Inputs{OS: "windows", Manufacturer: "Dell Inc.", Model: "lab", Windows: win, Firmware: fw, Now: time.Now()})
	t.Logf("settings=%d protection=%s state=%s reasons=%v firmware=%v", len(fw.Settings), fw.Protection, s.ReadinessState, s.ReasonCodes, s.Details["firmwareSettings"])
}
