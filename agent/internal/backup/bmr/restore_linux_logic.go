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
// exact match on one of etcRestoreExcludes (a single excluded file), nested
// under one of them (an excluded directory), or the source machine's own
// Breeze agent state (isBreezeAgentEtcPath).
func isExcludedEtcPath(relPath string) bool {
	relPath = filepath.ToSlash(relPath)
	for _, excl := range etcRestoreExcludes {
		if relPath == excl || strings.HasPrefix(relPath, excl+"/") {
			return true
		}
	}
	return isBreezeAgentEtcPath(relPath)
}

// breezeAgentUnitPrefix is the name prefix every systemd unit the Breeze
// agent installs carries (breeze-agent, breeze-watchdog, breeze-agent-user,
// breeze-recovery).
const breezeAgentUnitPrefix = "breeze-"

// systemdUnitDirs are the /etc-relative systemd unit directories whose
// breeze-* entries a restore must skip.
var systemdUnitDirs = []string{"systemd/system/", "systemd/user/"}

// isBreezeAgentEtcPath reports whether relPath (relative to /etc,
// forward-slash separated) is the SOURCE machine's Breeze agent state, which
// a live BMR restore must never copy onto the recovery target (#6436):
//
//   - breeze, breeze/...: /etc/breeze, the agent's config and enrollment
//     identity.
//   - systemd/{system,user}/breeze-*: the agent's unit files and their
//     .d drop-in directories.
//   - systemd/{system,user}/<target>.wants|.requires/breeze-*: the
//     enablement links that start those units at boot.
//
// The recovery target runs its own recovery helper and re-enrolls
// explicitly; inheriting the source's units left a target with no agent
// binary or /var/lib/breeze restarting breeze-watchdog every 15 s.
func isBreezeAgentEtcPath(relPath string) bool {
	relPath = filepath.ToSlash(relPath)
	if relPath == "breeze" || strings.HasPrefix(relPath, "breeze/") {
		return true
	}
	for _, dir := range systemdUnitDirs {
		rest, ok := strings.CutPrefix(relPath, dir)
		if !ok {
			continue
		}
		parts := strings.Split(rest, "/")
		// systemd/system/breeze-agent.service[.d[/override.conf]]
		if isBreezeAgentUnit(parts[0]) {
			return true
		}
		// systemd/system/multi-user.target.wants/breeze-agent.service
		if len(parts) >= 2 && (strings.HasSuffix(parts[0], ".wants") || strings.HasSuffix(parts[0], ".requires")) &&
			isBreezeAgentUnit(parts[1]) {
			return true
		}
	}
	return false
}

// isBreezeAgentUnit reports whether a systemd unit (or unit drop-in
// directory) name belongs to the Breeze agent — see breezeAgentUnitPrefix.
func isBreezeAgentUnit(unit string) bool {
	return strings.HasPrefix(unit, breezeAgentUnitPrefix)
}

// parseSystemdEnabledUnits extracts unit names from the output of
// `systemctl list-unit-files --type=service` — the exact format
// systemstate.LinuxCollector writes to services/systemd.txt
// (agent/internal/backup/systemstate/state_linux.go) — keeping only units
// whose STATE column reads exactly "enabled". The header row ("UNIT FILE
// STATE ...") and the "N unit files listed." footer are ignored because
// neither has "enabled" in its second field.
//
// This is the one parser for that artifact: restore_linux.go's
// restoreServices (the units to re-enable) and validate.go's
// enabledSystemdUnitsFromStaging (the units post-restore validation
// probes) both call it, so they can never disagree on what "enabled"
// means. It replaced two same-purpose copies (#5412).
func parseSystemdEnabledUnits(data []byte) []string {
	var units []string
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[1] == "enabled" {
			units = append(units, fields[0])
		}
	}
	return units
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
