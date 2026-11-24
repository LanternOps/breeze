package rebuild

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// listSequence answers each call with the next listing, repeating the last
// one once the sequence runs out.
func listSequence(listings ...[]int) (func() ([]WinVolume, error), *int) {
	calls := 0
	return func() ([]WinVolume, error) {
		i := calls
		if i >= len(listings) {
			i = len(listings) - 1
		}
		calls++
		var vols []WinVolume
		for _, n := range listings[i] {
			vols = append(vols, WinVolume{GUIDPath: `\\?\Volume{p` + string(rune('0'+n)) + `}\`, PartitionNumber: n})
		}
		return vols, nil
	}, &calls
}

// A volume for a partition the caller did not ask for does not satisfy the
// wait: listing {1, 2, 7} has three volumes, but partition 4 is missing.
func TestWaitForPartitionVolumes_WaitsForNamedPartitionsNotACount(t *testing.T) {
	list, calls := listSequence([]int{1, 2, 7}, []int{1, 2, 7}, []int{1, 2, 4, 7})
	vols, err := waitForPartitionVolumes(context.Background(), list, 3, []int{1, 2, 4}, time.Second, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if *calls != 3 {
		t.Fatalf("listed %d times, want 3 (until partition 4 appeared)", *calls)
	}
	if len(vols) != 4 {
		t.Fatalf("vols = %+v, want the whole final listing", vols)
	}
}

func TestWaitForPartitionVolumes_TimeoutNamesMissingAndPresentPartitions(t *testing.T) {
	list, _ := listSequence([]int{7, 1})
	_, err := waitForPartitionVolumes(context.Background(), list, 3, []int{4, 1, 2}, 20*time.Millisecond, time.Millisecond)
	if err == nil {
		t.Fatal("want a timeout error")
	}
	for _, want := range []string{"volumes for partitions 2, 4 did not appear on disk 3", "volumes present for partitions: 1, 7"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %q, want it to contain %q", err, want)
		}
	}
}

func TestWaitForPartitionVolumes_SingleMissingPartitionWording(t *testing.T) {
	list, _ := listSequence(nil)
	_, err := waitForPartitionVolumes(context.Background(), list, 1, []int{9}, 0, time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "volume for partition 9 did not appear on disk 1") || !strings.Contains(err.Error(), "partitions: none") {
		t.Fatalf("err = %v", err)
	}
}

func TestWaitForPartitionVolumes_EmptyWantReturnsFirstListing(t *testing.T) {
	list, calls := listSequence([]int{1})
	vols, err := waitForPartitionVolumes(context.Background(), list, 1, nil, time.Second, time.Millisecond)
	if err != nil || len(vols) != 1 || *calls != 1 {
		t.Fatalf("vols=%+v err=%v calls=%d", vols, err, *calls)
	}
}

func TestWaitForPartitionVolumes_StopsOnContextCancel(t *testing.T) {
	list, _ := listSequence([]int{1})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := waitForPartitionVolumes(ctx, list, 1, []int{2}, time.Hour, time.Hour)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestWaitForPartitionVolumes_ListErrorIsReturned(t *testing.T) {
	boom := errors.New("enumerate failed")
	_, err := waitForPartitionVolumes(context.Background(), func() ([]WinVolume, error) { return nil, boom }, 1, []int{1}, time.Second, time.Millisecond)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
}
