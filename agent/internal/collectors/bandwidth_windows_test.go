//go:build windows

package collectors

import (
	"testing"
	"time"
)

// TestGetLinkSpeedWindowsNeverSpawnsProcess drives the real Windows
// getLinkSpeed with a fake MIB_IF_TABLE2 reader. Before #9267 it ran
// `powershell Get-NetAdapter` once per adapter, which trips the hook.
func TestGetLinkSpeedWindowsNeverSpawnsProcess(t *testing.T) {
	failOnCollectorCommand(t)

	reads := 0
	prev := windowsLinkSpeeds
	windowsLinkSpeeds = &linkSpeedSource{
		ttl: linkSpeedTableTTL,
		now: time.Now,
		read: func() ([]ifLinkSpeedRow, error) {
			reads++
			return []ifLinkSpeedRow{
				{Alias: "Ethernet", ReceiveLinkSpeed: 1_000_000_000},
				{Alias: "Wi-Fi", ReceiveLinkSpeed: 866_700_000},
			}, nil
		},
	}
	t.Cleanup(func() { windowsLinkSpeeds = prev })

	if got := getLinkSpeed("Ethernet"); got != 1_000_000_000 {
		t.Fatalf("getLinkSpeed(Ethernet) = %d", got)
	}
	if got := getLinkSpeed("Wi-Fi"); got != 866_700_000 {
		t.Fatalf("getLinkSpeed(Wi-Fi) = %d", got)
	}
	getLinkSpeed("Ethernet 2")
	getLinkSpeed("Bluetooth Network Connection")
	if reads != 1 {
		t.Fatalf("table reads = %d, want 1 for four adapters", reads)
	}
}

// TestReadIfTable2LinkSpeedsLive reads the real interface table; on any
// Windows host there is at least the loopback pseudo-interface.
func TestReadIfTable2LinkSpeedsLive(t *testing.T) {
	failOnCollectorCommand(t)
	rows, err := readIfTable2LinkSpeeds()
	if err != nil {
		t.Fatalf("readIfTable2LinkSpeeds: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("readIfTable2LinkSpeeds returned no interfaces")
	}
	for _, r := range rows {
		if r.Alias == "" {
			t.Fatalf("row with empty alias: %+v", r)
		}
	}
}
