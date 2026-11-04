package collectors

import (
	"errors"
	"testing"
)

// Type 3 structure with chassis type 10, then the end-of-table structure.
var chassisTestTable = []byte{
	3, 6, 0x03, 0x00, 0, 10, 0, 0,
	127, 4, 0xFF, 0xFE, 0, 0,
}

func TestChassisTypeFromSMBIOS(t *testing.T) {
	spawned := func(name string, args []string) {
		t.Errorf("chassis type must be read in-process, spawned %q %v", name, args)
	}
	prev := collectorCommandHook.Swap(&spawned)
	t.Cleanup(func() { collectorCommandHook.Store(prev) })

	read := func() ([]byte, error) { return chassisTestTable, nil }
	if got := chassisTypeFromSMBIOS(read); got != "10" {
		t.Fatalf("got %q, want 10", got)
	}

	// A failed read or a malformed table is an unknown chassis, not an error.
	failed := func() ([]byte, error) { return nil, errors.New("firmware table unavailable") }
	if got := chassisTypeFromSMBIOS(failed); got != "" {
		t.Fatalf("failed read: got %q, want empty", got)
	}
	malformed := func() ([]byte, error) { return []byte{3, 0xFF, 0, 0}, nil }
	if got := chassisTypeFromSMBIOS(malformed); got != "" {
		t.Fatalf("malformed table: got %q, want empty", got)
	}
}
