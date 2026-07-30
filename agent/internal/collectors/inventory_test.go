package collectors

import (
	"errors"
	"testing"

	"github.com/shirou/gopsutil/v3/disk"
)

// gopsutil's Windows disk.Partitions returns the drives it could enumerate plus
// a non-fatal warnings aggregate, so an unreadable volume must not discard the
// healthy ones. Verified against a fleet where 75 Windows endpoints reported no
// disk inventory at all because one drive answered "Access is denied".
func TestCollectDisksPartitionErrorHandling(t *testing.T) {
	hostPartitions, err := disk.Partitions(false)
	if err != nil || len(hostPartitions) == 0 {
		t.Skip("host has no cleanly enumerable partitions to exercise the collector")
	}

	tests := []struct {
		name       string
		partitions []disk.PartitionStat
		err        error
		wantErr    bool
		wantDisks  bool
	}{
		{
			name:       "warning alongside partitions is not fatal",
			partitions: hostPartitions,
			err:        errors.New("\tError 0: Access is denied.\n"),
			wantErr:    false,
			wantDisks:  true,
		},
		{
			name:       "error with nothing enumerated is fatal",
			partitions: nil,
			err:        errors.New("\tError 0: Access is denied.\n"),
			wantErr:    true,
		},
		{
			name:       "clean enumeration succeeds",
			partitions: hostPartitions,
			err:        nil,
			wantErr:    false,
			wantDisks:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			original := partitionsFn
			t.Cleanup(func() { partitionsFn = original })
			partitionsFn = func(bool) ([]disk.PartitionStat, error) {
				return tt.partitions, tt.err
			}

			disks, err := NewInventoryCollector().CollectDisks()

			if tt.wantErr {
				if err == nil {
					t.Fatal("expected an error when no partitions were enumerated")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.wantDisks && len(disks) == 0 {
				t.Fatal("collector discarded every partition")
			}
		})
	}
}
