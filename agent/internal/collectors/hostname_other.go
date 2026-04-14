//go:build !windows

package collectors

import "os"

// platformHostnameFallbacks is the non-Windows tail of the hostname
// resolver chain. On Unix os.Hostname() rarely fails, so these are
// safety nets, not primary sources:
//
//  1. HOSTNAME environment variable — set by most login shells; rarely
//     present in service contexts but free to check.
//  2. /etc/hostname — authoritative on most Linux distros and cheap to
//     read.
//  3. `hostname` command — final safety net. Calls the same syscall as
//     os.Hostname() in practice, so it only helps if the Go runtime
//     wrapper glitched without the system binary doing the same.
func platformHostnameFallbacks() []hostnameSource {
	return []hostnameSource{
		func() string { return os.Getenv("HOSTNAME") },
		hostnameFromFile,
		hostnameFromCommand,
	}
}

func hostnameFromFile() string {
	data, err := os.ReadFile("/etc/hostname")
	if err != nil {
		return ""
	}
	return string(data)
}

func hostnameFromCommand() string {
	out, err := runCollectorOutput(collectorShortCommandTimeout, "hostname")
	if err != nil {
		return ""
	}
	return string(out)
}
