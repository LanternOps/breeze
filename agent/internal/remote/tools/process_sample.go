package tools

import (
	"fmt"
	"sort"

	"github.com/shirou/gopsutil/v3/process"
)

// ProcessSampleEntry is one process in a periodic top-N snapshot. JSON tags
// match the API ingest schema and the device_process_samples top_processes
// JSONB shape. DiskBps/NetBps are reserved for later phases (omitted now).
type ProcessSampleEntry struct {
	Name    string  `json:"name"`
	PID     int32   `json:"pid"`
	CPU     float64 `json:"cpu"`
	RAMMb   float64 `json:"ramMb"`
	DiskBps float64 `json:"diskBps,omitempty"`
	NetBps  float64 `json:"netBps,omitempty"`
}

// TopProcessSample enumerates processes once, measures *instantaneous* CPU over
// a single shared 250ms window (sampleProcessCPUPercents — never the lifetime
// average), reads RSS, and returns the union of the top perDimension by CPU and
// by RAM. It skips username resolution on purpose: the snapshot does not need
// it, and resolveUsername is the expensive Windows SID-lookup path.
func TopProcessSample(perDimension int) ([]ProcessSampleEntry, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}

	cpuPercents := sampleProcessCPUPercents(procs, cpuSampleInterval)

	entries := make([]ProcessSampleEntry, 0, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil {
			continue
		}
		// Bound the name to the ingest schema's limit (256) so one pathological
		// name can't 400 the whole sample; rune-safe.
		name, _ = truncateStringBytes(name, 256)
		e := ProcessSampleEntry{Name: name, PID: p.Pid, CPU: cpuPercents[p.Pid]}
		if mem, err := p.MemoryInfo(); err == nil && mem != nil {
			e.RAMMb = float64(mem.RSS) / 1024 / 1024
		}
		entries = append(entries, e)
	}

	// A non-empty process table that yields zero entries means every Name()
	// lookup failed (sandbox/permission/platform regression) — surface it as an
	// error rather than silently POSTing an empty "successful" snapshot.
	if len(procs) > 0 && len(entries) == 0 {
		return nil, fmt.Errorf("collected 0 of %d processes: all Name() lookups failed", len(procs))
	}

	return selectTopN(entries, perDimension), nil
}

// selectTopN returns the union of the top perDimension entries by CPU and the
// top perDimension by RAM, deduped by PID, preserving the original input order.
func selectTopN(entries []ProcessSampleEntry, perDimension int) []ProcessSampleEntry {
	if perDimension < 1 {
		perDimension = 1
	}

	rankTop := func(less func(a, b ProcessSampleEntry) bool) map[int32]bool {
		sorted := append([]ProcessSampleEntry(nil), entries...)
		sort.Slice(sorted, func(i, j int) bool { return less(sorted[i], sorted[j]) })
		top := map[int32]bool{}
		for i := 0; i < len(sorted) && i < perDimension; i++ {
			top[sorted[i].PID] = true
		}
		return top
	}

	keep := rankTop(func(a, b ProcessSampleEntry) bool { return a.CPU > b.CPU })
	for pid := range rankTop(func(a, b ProcessSampleEntry) bool { return a.RAMMb > b.RAMMb }) {
		keep[pid] = true
	}

	out := make([]ProcessSampleEntry, 0, len(keep))
	for _, e := range entries {
		if keep[e.PID] {
			out = append(out, e)
		}
	}
	return out
}
