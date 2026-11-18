//go:build !linux

package sessionbroker

// defaultLinuxLogindLookup is nil off Linux: there is no logind, so Linux
// desktop helper admission (only reachable with goos "linux") refuses.
func defaultLinuxLogindLookup() logindLookupFunc { return nil }

// recordRunningBuildHash is only needed for Linux desktop helper admission;
// elsewhere it skips hashing the agent binary at every start.
func recordRunningBuildHash() string { return "" }
