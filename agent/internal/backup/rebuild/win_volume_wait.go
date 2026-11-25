// win_volume_wait.go — the poll loop behind WinSystem.WaitForVolumes,
// untagged so the ordinary cross-platform suite exercises the same code the
// real seam (winsystem_windows.go) runs.
package rebuild

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// waitForPartitionVolumes polls list until every partition number in want
// has a volume, then returns the whole listing (which may hold volumes for
// other partitions too). It waits for the named partitions rather than for
// a number of volumes: a volume for a partition the caller did not ask for
// must not satisfy the wait while one it needs is still missing (#12576).
// After timeout the error names the missing partition numbers and the ones
// that did appear.
func waitForPartitionVolumes(ctx context.Context, list func() ([]WinVolume, error), diskNumber int, want []int, timeout, interval time.Duration) ([]WinVolume, error) {
	deadline := time.Now().Add(timeout)
	for {
		vols, err := list()
		if err != nil {
			return nil, err
		}
		missing := missingPartitionVolumes(vols, want)
		if len(missing) == 0 {
			return vols, nil
		}
		if !time.Now().Before(deadline) {
			present := make([]int, 0, len(vols))
			for _, v := range vols {
				present = append(present, v.PartitionNumber)
			}
			return vols, fmt.Errorf("%s did not appear on disk %d within %s (volumes present for partitions: %s)",
				describeMissingPartitions(missing), diskNumber, timeout, joinPartitionNumbers(present))
		}
		select {
		case <-ctx.Done():
			return vols, ctx.Err()
		case <-time.After(interval):
		}
	}
}

// missingPartitionVolumes returns the partition numbers in want that no
// volume in vols belongs to, sorted and without duplicates.
func missingPartitionVolumes(vols []WinVolume, want []int) []int {
	have := make(map[int]bool, len(vols))
	for _, v := range vols {
		have[v.PartitionNumber] = true
	}
	seen := map[int]bool{}
	var missing []int
	for _, n := range want {
		if !have[n] && !seen[n] {
			seen[n] = true
			missing = append(missing, n)
		}
	}
	sort.Ints(missing)
	return missing
}

func describeMissingPartitions(missing []int) string {
	if len(missing) == 1 {
		return "volume for partition " + strconv.Itoa(missing[0])
	}
	return "volumes for partitions " + joinPartitionNumbers(missing)
}

// joinPartitionNumbers renders partition numbers sorted, comma-separated
// ("none" for an empty list). It sorts a copy; the caller's slice is kept.
func joinPartitionNumbers(numbers []int) string {
	if len(numbers) == 0 {
		return "none"
	}
	sorted := append([]int(nil), numbers...)
	sort.Ints(sorted)
	parts := make([]string, len(sorted))
	for i, n := range sorted {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ", ")
}
