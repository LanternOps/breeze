//go:build linux

package tools

import "os"

func readMountTable() ([]string, bool) {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil, false
	}
	defer func() { _ = f.Close() }()
	table := parseMountInfo(f)
	return table, len(table) > 0
}
