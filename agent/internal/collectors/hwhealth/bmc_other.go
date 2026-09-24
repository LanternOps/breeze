//go:build !windows && !linux

package hwhealth

func bmcToolNames(Kind) []string { return nil }
