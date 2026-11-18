//go:build windows

package collectors

import (
	"strconv"
	"testing"
)

// wmic.exe is gone from Windows 11 24H2 and Server 2025, and the chassis type
// is on the 15-minute tick (#10911), so it must never need a process.
func TestGetChassisTypeDoesNotSpawn(t *testing.T) {
	spawned := func(name string, args []string) {
		t.Errorf("getChassisType spawned %q %v", name, args)
	}
	prev := collectorCommandHook.Swap(&spawned)
	t.Cleanup(func() { collectorCommandHook.Store(prev) })

	got := getChassisType()
	if got == "" {
		return // A VM may report no enclosure.
	}
	if _, err := strconv.Atoi(got); err != nil {
		t.Fatalf("chassis type %q is not a numeric SMBIOS code", got)
	}
}
