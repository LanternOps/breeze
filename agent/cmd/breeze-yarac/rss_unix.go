//go:build !windows

package main

import (
	"runtime"
	"syscall"
)

// peakRSSBytes is the process's peak resident set size from getrusage
// (ru_maxrss is bytes on darwin, KiB on Linux). 0 if unavailable.
func peakRSSBytes() uint64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil || ru.Maxrss <= 0 {
		return 0
	}
	if runtime.GOOS == "darwin" {
		return uint64(ru.Maxrss)
	}
	return uint64(ru.Maxrss) * 1024
}
