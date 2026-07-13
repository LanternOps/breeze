package collectors

import "runtime"

// RuntimeStats is a snapshot of the agent's own Go runtime memory state,
// reported on every heartbeat so fleet-wide agent memory leaks are visible
// from the server without shell access to the device (issue #2389).
type RuntimeStats struct {
	HeapAllocBytes    uint64 `json:"heapAllocBytes"`
	HeapInuseBytes    uint64 `json:"heapInuseBytes"`
	HeapReleasedBytes uint64 `json:"heapReleasedBytes"`
	SysBytes          uint64 `json:"sysBytes"`
	NumGC             uint32 `json:"numGc"`
	Goroutines        int    `json:"goroutines"`

	// Worker-pool wedge gauges (issue #2400). Filled in by the heartbeat —
	// not by CollectRuntimeStats, which has no view of the pool.
	// CommandsInFlight is how many pool-dispatched commands are currently
	// executing; CommandsOverdue is how many of those have been running
	// longer than their in-flight watchdog tier (wedged-worker suspects).
	CommandsInFlight int `json:"commandsInFlight"`
	CommandsOverdue  int `json:"commandsOverdue"`
}

// CollectRuntimeStats reads the Go runtime's memory statistics for this
// process. runtime.ReadMemStats is a brief stop-the-world read (microseconds
// for a typical agent heap) — cheap enough to call on every heartbeat.
func CollectRuntimeStats() *RuntimeStats {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return &RuntimeStats{
		HeapAllocBytes:    ms.HeapAlloc,
		HeapInuseBytes:    ms.HeapInuse,
		HeapReleasedBytes: ms.HeapReleased,
		SysBytes:          ms.Sys,
		NumGC:             ms.NumGC,
		Goroutines:        runtime.NumGoroutine(),
	}
}
