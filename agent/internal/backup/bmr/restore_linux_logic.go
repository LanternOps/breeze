package bmr

import (
	"io/fs"
	"path/filepath"
	"strings"
)

// This file holds Linux BMR restore logic that is pure (no exec.Command,
// no writes outside a caller-supplied directory) so it can be unit-tested
// with `go test -race ./internal/backup/bmr/` on any platform, including
// macOS dev machines. The orchestration that actually shells out to
// dpkg/systemctl/crontab/iptables-restore and writes into the live /etc
// lives in restore_linux.go, which carries a `//go:build linux` tag.

// etcRestoreExcludes lists /etc paths (relative to /etc, slash-separated)
// that a BMR restore must NEVER overwrite, because they identify or address
// the specific machine being restored rather than describing installed
// software/config:
//
//   - fstab: block-device UUIDs from the OLD machine — restoring it can
//     leave the recovered machine unbootable/unmountable on new hardware.
//   - machine-id: systemd's D-Bus/journald identity — duplicating it
//     across machines breaks machine tracking and can collide DHCP leases.
//   - hostname: default-skip so BMR never silently renames the recovery
//     target out from under a fresh install's placeholder hostname.
//   - netplan, network/interfaces, NetworkManager/system-connections:
//     network config tied to the OLD machine's NIC topology — a mismatched
//     interface name after restore can leave the machine unreachable.
//
// A package-level var (not const) so tests can assert against it directly
// and so it's easy to extend later. Entries name either a single file
// (matched exactly) or a directory (matched as a prefix), decided by
// isExcludedEtcPath below — there is no separate "is this a dir" flag
// because the same exact-or-prefix check handles both uniformly.
var etcRestoreExcludes = []string{
	"fstab",
	"machine-id",
	"hostname",
	"netplan",
	"network/interfaces",
	"NetworkManager/system-connections",
}

// isExcludedEtcPath reports whether relPath (a path relative to /etc,
// forward-slash separated) must be skipped by the /etc restore — either an
// exact match on one of etcRestoreExcludes (a single excluded file) or
// nested under one of them (an excluded directory).
func isExcludedEtcPath(relPath string) bool {
	relPath = filepath.ToSlash(relPath)
	for _, excl := range etcRestoreExcludes {
		if relPath == excl || strings.HasPrefix(relPath, excl+"/") {
			return true
		}
	}
	return false
}

// parseEnabledServices extracts unit names from the output of
// `systemctl list-unit-files --type=service` — the exact format
// systemstate.LinuxCollector writes to services/systemd.txt
// (agent/internal/backup/systemstate/state_linux.go) — keeping only units
// whose STATE column reads exactly "enabled". The header row ("UNIT FILE
// STATE ...") and the "N unit files listed." footer are ignored because
// neither has "enabled" in its second field.
func parseEnabledServices(data []byte) []string {
	var services []string
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[1] == "enabled" {
			services = append(services, fields[0])
		}
	}
	return services
}

// crontabSpoolEntries walks spoolDir — stagingDir/crontabs/spool, as
// written by systemstate.LinuxCollector.collectCrontabs, which copies
// /var/spool/cron verbatim — and returns the absolute path of every
// regular file found, keyed by its base filename (the username the
// crontab belongs to).
//
// It deliberately does not care how deep a file sits: Debian/Ubuntu nest
// an extra "crontabs" directory (/var/spool/cron/crontabs/<user>), while
// RHEL/Fedora do not (/var/spool/cron/<user>), so the same collector call
// produces different nesting depending on the source distro. Walking
// recursively and keying by base name handles both layouts without the
// restorer needing to know which distro produced the backup.
//
// It never looks at stagingDir/crontabs/crontab (the /etc/crontab copy):
// that file lives at the crontabs/ root, one level above spool/, so a walk
// rooted at spool/ never reaches it. Restoring it as a per-user crontab
// named "crontab" would be wrong, and it's redundant with the /etc tree
// restore anyway.
func crontabSpoolEntries(spoolDir string) (map[string]string, error) {
	entries := make(map[string]string)
	err := filepath.WalkDir(spoolDir, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		entries[d.Name()] = path
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}
