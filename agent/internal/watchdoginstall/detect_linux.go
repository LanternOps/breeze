//go:build linux

package watchdoginstall

const (
	// systemdRunDir exists iff the host was booted with systemd as PID 1.
	systemdRunDir = "/run/systemd/system"
	// Paths written by `breeze-watchdog service install` (and install-linux.sh).
	linuxWatchdogBinary = "/usr/local/bin/breeze-watchdog"
	linuxWatchdogUnit   = "/etc/systemd/system/breeze-watchdog.service"
)

// Detect reports whether the watchdog is registered: systemd present, binary at
// /usr/local/bin/breeze-watchdog, and its unit file. A non-systemd host is
// Unsupported (the watchdog ships only a systemd unit).
func Detect(stat StatFunc) Status {
	return detectFiles(stat, systemdRunDir, []string{linuxWatchdogBinary}, linuxWatchdogUnit)
}
