//go:build darwin

package collectors

// collectPlatformMemory reads SPMemoryDataType through the bounded command
// helper (timeout, capped stdout, non-zero exit is an error).
func collectPlatformMemory() (*MemoryInfo, error) {
	out, err := runCollectorBoundedOutput(collectorLongCommandTimeout, "system_profiler", "SPMemoryDataType", "-json")
	if err != nil {
		return nil, err
	}
	return parseSPMemoryJSON(out)
}
