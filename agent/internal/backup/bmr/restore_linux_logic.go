package bmr

import (
	"os"
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

// crontabSpoolEntries returns the absolute path of every per-user crontab
// file found DIRECTLY under spoolDir — stagingDir/crontabs/spool, as
// written by systemstate.LinuxCollector.collectCrontabs, which copies
// /var/spool/cron verbatim — keyed by its base filename (the username the
// crontab belongs to). Anything skipped (a subdirectory that isn't a
// per-user crontab store, or a dotfile/non-regular entry) is returned in
// the second slice so the caller can log it, rather than silently
// dropping it.
//
// It handles both spool layouts a collector run can produce, without
// needing to know which distro produced the backup:
//   - RHEL/Fedora: spoolDir/<user> — per-user files sit directly at the
//     top level.
//   - Debian/Ubuntu: spoolDir/crontabs/<user> — one level down, alongside
//     sibling directories (atjobs/, atspool/, for at(1)'s job queues) and
//     sometimes a lock file, all copied verbatim from /var/spool/cron.
//
// It ONLY ever descends into a "crontabs" subdirectory directly under
// spoolDir — never atjobs/, atspool/, or anything else — and only takes
// regular files there and at spoolDir's own top level, skipping any other
// subdirectory, dotfiles, and non-regular entries. A prior implementation
// walked every descendant recursively and used the basename as a
// username, which handed `crontab -u .SEQ` (an at(1) sequence file) or
// similar non-crontab entries to the crontab command and failed the whole
// crontab restore step over something that was never a user crontab.
//
// It never looks at stagingDir/crontabs/crontab (the /etc/crontab copy):
// that file lives at the crontabs/ root, one level above spoolDir, so this
// function — rooted at spoolDir — never reaches it regardless. Restoring
// it as a per-user crontab named "crontab" would be wrong, and it's
// redundant with the /etc tree restore anyway.
func crontabSpoolEntries(spoolDir string) (entries map[string]string, skipped []string, err error) {
	entries = make(map[string]string)

	collect := func(dir string, isTopLevel bool) error {
		dirEntries, readErr := os.ReadDir(dir)
		if readErr != nil {
			if os.IsNotExist(readErr) {
				return nil
			}
			return readErr
		}
		for _, de := range dirEntries {
			name := de.Name()
			full := filepath.Join(dir, name)

			if de.IsDir() {
				// Only descend into a "crontabs" subdirectory directly
				// under spoolDir (the Debian layout) — every other
				// subdirectory (atjobs/, atspool/, anything else) is not
				// a per-user crontab store and must not be walked.
				if isTopLevel && name == "crontabs" {
					continue
				}
				skipped = append(skipped, full+"/")
				continue
			}
			if strings.HasPrefix(name, ".") {
				skipped = append(skipped, full)
				continue
			}
			info, infoErr := de.Info()
			if infoErr != nil {
				return infoErr
			}
			if !info.Mode().IsRegular() {
				skipped = append(skipped, full)
				continue
			}
			entries[name] = full
		}
		return nil
	}

	if err = collect(spoolDir, true); err != nil {
		return nil, nil, err
	}
	if err = collect(filepath.Join(spoolDir, "crontabs"), false); err != nil {
		return nil, nil, err
	}
	return entries, skipped, nil
}
