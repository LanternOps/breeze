package collectors

import (
	"errors"
	"testing"
	"time"
)

// failOnCollectorCommand installs the collector command hook so any collector
// subprocess spawned during the test fails it (#9267: link speed must be read
// in-process, never via a PowerShell spawn per adapter).
func failOnCollectorCommand(t *testing.T) {
	t.Helper()
	hook := func(name string, args []string) {
		t.Errorf("collector spawned a subprocess %q %v; link speed must be read in-process", name, args)
	}
	prev := collectorCommandHook.Swap(&hook)
	t.Cleanup(func() { collectorCommandHook.Store(prev) })
}

func TestLinkSpeedTableLookup(t *testing.T) {
	failOnCollectorCommand(t)
	table := newLinkSpeedTable([]ifLinkSpeedRow{
		{Alias: "Ethernet", Description: "Intel(R) Ethernet Connection I219-LM", ReceiveLinkSpeed: 1_000_000_000, TransmitLinkSpeed: 1_000_000_000},
		// NDIS filter pseudo-interfaces share the description but carry their own alias.
		{Alias: "Ethernet-WFP Native MAC Layer LightWeight Filter-0000", Description: "Intel(R) Ethernet Connection I219-LM", ReceiveLinkSpeed: 1_000_000_000},
		{Alias: "Wi-Fi", Description: "Intel(R) Wi-Fi 6 AX201 160MHz", ReceiveLinkSpeed: 866_700_000, TransmitLinkSpeed: 433_300_000},
		// Disconnected adapter: NDIS reports the unknown sentinel.
		{Alias: "Ethernet 2", Description: "Realtek USB GbE Family Controller", ReceiveLinkSpeed: ifLinkSpeedUnknown, TransmitLinkSpeed: ifLinkSpeedUnknown},
		// Receive unknown but transmit known: fall back to transmit.
		{Alias: "vEthernet (Default Switch)", Description: "Hyper-V Virtual Ethernet Adapter", ReceiveLinkSpeed: 0, TransmitLinkSpeed: 10_000_000_000},
	})

	tests := []struct {
		name string
		want uint64
	}{
		{"Ethernet", 1_000_000_000},
		{"ethernet", 1_000_000_000}, // aliases are case-insensitive on Windows
		{"Wi-Fi", 866_700_000},      // ReceiveLinkSpeed preferred (what Get-NetAdapter reported)
		{"Ethernet 2", 0},           // unknown sentinel is not a speed
		{"vEthernet (Default Switch)", 10_000_000_000},
		{"Intel(R) Wi-Fi 6 AX201 160MHz", 866_700_000}, // description fallback
		{"Loopback Pseudo-Interface 1", 0},             // absent
		{"", 0},
	}
	for _, tt := range tests {
		if got := table.lookup(tt.name); got != tt.want {
			t.Errorf("lookup(%q) = %d, want %d", tt.name, got, tt.want)
		}
	}
}

func TestLinkSpeedTableDuplicateAliasKeepsFirstKnownSpeed(t *testing.T) {
	table := newLinkSpeedTable([]ifLinkSpeedRow{
		{Alias: "Ethernet", ReceiveLinkSpeed: 0},
		{Alias: "Ethernet", ReceiveLinkSpeed: 2_500_000_000},
		{Alias: "Ethernet", ReceiveLinkSpeed: 100_000_000},
	})
	if got := table.lookup("Ethernet"); got != 2_500_000_000 {
		t.Fatalf("lookup = %d, want first known speed 2500000000", got)
	}
}

func TestLinkSpeedSourceReadsTableOncePerCycle(t *testing.T) {
	failOnCollectorCommand(t)
	reads := 0
	now := time.Unix(1_700_000_000, 0)
	src := &linkSpeedSource{
		ttl: linkSpeedTableTTL,
		now: func() time.Time { return now },
		read: func() ([]ifLinkSpeedRow, error) {
			reads++
			return []ifLinkSpeedRow{
				{Alias: "Ethernet", ReceiveLinkSpeed: 1_000_000_000},
				{Alias: "Wi-Fi", ReceiveLinkSpeed: 300_000_000},
			}, nil
		},
	}

	// One metrics cycle looks up every adapter: a single table read must serve them all.
	for _, name := range []string{"Ethernet", "Wi-Fi", "Ethernet 2", "vEthernet (WSL)"} {
		src.speed(name)
	}
	if reads != 1 {
		t.Fatalf("table reads in one cycle = %d, want 1", reads)
	}
	if got := src.speed("Wi-Fi"); got != 300_000_000 {
		t.Fatalf("speed(Wi-Fi) = %d", got)
	}

	now = now.Add(linkSpeedTableTTL + time.Second)
	src.speed("Ethernet")
	if reads != 2 {
		t.Fatalf("table reads after TTL = %d, want 2", reads)
	}
}

func TestLinkSpeedSourceReadErrorReturnsZeroAndIsNotHammered(t *testing.T) {
	failOnCollectorCommand(t)
	reads := 0
	now := time.Unix(1_700_000_000, 0)
	src := &linkSpeedSource{
		ttl: linkSpeedTableTTL,
		now: func() time.Time { return now },
		read: func() ([]ifLinkSpeedRow, error) {
			reads++
			return nil, errors.New("GetIfTable2Ex: access denied")
		},
	}
	for range 4 {
		if got := src.speed("Ethernet"); got != 0 {
			t.Fatalf("speed on read error = %d, want 0", got)
		}
	}
	if reads != 1 {
		t.Fatalf("failed table reads within TTL = %d, want 1", reads)
	}
}
