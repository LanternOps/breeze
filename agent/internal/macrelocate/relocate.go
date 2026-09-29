// Package macrelocate decides, at daemon startup, whether a privileged macOS
// Breeze binary (agent or watchdog) must move out of /usr/local/bin into the
// root-owned /Library/Breeze/bin, and cleans up after a move that already
// happened.
//
// Why moving is expensive (#7211): the agent and watchdog are signed bare
// binaries, not an app bundle, and macOS keys a bare binary's TCC grants —
// Full Disk Access in particular — to its file path. A relocated binary is a
// new TCC client with no grant, and nothing but a person at the Mac (or an MDM
// PPPC profile) can grant it again. So the move happens only when the legacy
// location is actually unsafe for a root daemon: the binary or any directory
// above it is not root-owned, or is writable by group or other (the
// Homebrew-on-Intel shape that motivated #7199). A safe /usr/local/bin keeps
// the binary, and its grant, where it is.
//
// The package is deliberately untagged and dependency-injected so its
// decision logic runs in the required Linux agent test job; only the thin
// wiring in internal/agentapp and cmd/breeze-watchdog is darwin-only.
package macrelocate

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// Config names where one binary lives and what to clean up after it moves.
type Config struct {
	// LegacyDir is the pre-relocation install directory (/usr/local/bin).
	LegacyDir string
	// TrustedDir is the root-owned, Breeze-only directory (/Library/Breeze/bin).
	TrustedDir string
	// PlistPath is the LaunchDaemon plist whose ProgramArguments name this
	// binary. A relocation repoints it; cleanup only runs once it names the
	// trusted copy and no longer names the legacy one.
	PlistPath string
	// Siblings are other binaries installed next to this one (the agent's
	// breeze-backup). Their legacy copy is removed only once a trusted copy
	// exists, since the agent resolves them relative to its own directory.
	Siblings []string
	// RecordDir, when set, receives a Record whenever a leftover legacy copy
	// of this binary is found after a relocation, so the heartbeat can report
	// that Full Disk Access needs re-granting. Only the agent sets it: the
	// agent is the binary whose FDA grant the device page reports.
	RecordDir string
}

// Deps are the side effects Run performs, injected for tests.
type Deps struct {
	Geteuid    func() int
	Executable func() (string, error)
	// VerifyLocation returns nil when the executable and every directory above
	// it are root-owned and not group/other-writable
	// (securefs.VerifyTrustedExecutablePathChain).
	VerifyLocation func(path string) error
	// Migrate copies legacyPath into trustedDir and returns the new path
	// (securefs.MigrateExecutableToTrustedDir).
	Migrate func(legacyPath, trustedDir string) (string, error)
	// StartDetached runs script in a detached shell that survives this
	// process being unloaded by launchd.
	StartDetached func(script string) error
	ReadFile      func(path string) ([]byte, error)
	Lstat         func(path string) (os.FileInfo, error)
	// RemoveLegacyFile removes dir/name only if it is a regular file, never
	// following a symlink (securefs.RemoveRegularFileNoFollow).
	RemoveLegacyFile func(dir, name string) error
	WriteRecord      func(dir string, r Record) error
	Now              func() time.Time
	Log              *slog.Logger
}

// Outcome reports what Run decided, for tests and logging.
type Outcome string

const (
	OutcomeUnprivileged        Outcome = "unprivileged"
	OutcomeUnresolved          Outcome = "unresolved"
	OutcomeOtherLocation       Outcome = "other_location"
	OutcomeKeptLegacy          Outcome = "kept_legacy"
	OutcomeRelocationScheduled Outcome = "relocation_scheduled"
	OutcomeRelocationFailed    Outcome = "relocation_failed"
	OutcomeTrusted             Outcome = "trusted"
)

// Run is the startup entry point. It never fails startup: every error is
// logged and the daemon carries on from wherever it is running.
func Run(cfg Config, d Deps) Outcome {
	if d.Geteuid() != 0 {
		return OutcomeUnprivileged
	}
	self, err := d.Executable()
	if err != nil {
		d.Log.Warn("executable relocation: could not resolve own path", "error", err.Error())
		return OutcomeUnresolved
	}
	self = filepath.Clean(self)
	switch filepath.Dir(self) {
	case filepath.Clean(cfg.LegacyDir):
		return relocateIfUnsafe(cfg, d, self)
	case filepath.Clean(cfg.TrustedDir):
		cleanupAfterRelocation(cfg, d, self)
		return OutcomeTrusted
	default:
		return OutcomeOtherLocation
	}
}

func relocateIfUnsafe(cfg Config, d Deps, self string) Outcome {
	unsafeErr := d.VerifyLocation(self)
	if unsafeErr == nil {
		d.Log.Info("executable relocation: legacy install location is root-owned and not group/other-writable; "+
			"staying put so macOS privacy grants (keyed to this path) remain valid",
			"path", self)
		return OutcomeKeptLegacy
	}

	// Siblings the agent resolves next to its own executable (breeze-backup)
	// must move with it, or every backup fails after the reload. They are
	// copied BEFORE this binary: a trusted copy of this binary is what the
	// .pkg (install-location.sh choose_bin_dir) reads as "already
	// relocated", so it must only appear once everything else is in place.
	// A failed copy aborts; the next start retries the whole move.
	for _, sib := range cfg.Siblings {
		legacySib := filepath.Join(cfg.LegacyDir, sib)
		if !isRegularFile(d, legacySib) {
			continue
		}
		if _, err := d.Migrate(legacySib, cfg.TrustedDir); err != nil {
			d.Log.Warn("executable relocation: could not copy a companion binary to the trusted directory; "+
				"continuing from the legacy location and retrying on the next start",
				"path", legacySib, "reason", unsafeErr.Error(), "error", err.Error())
			return OutcomeRelocationFailed
		}
	}
	newPath, err := d.Migrate(self, cfg.TrustedDir)
	if err != nil {
		d.Log.Warn("executable relocation: legacy install location is unsafe but copying to the trusted directory failed; "+
			"continuing from the legacy location",
			"path", self, "reason", unsafeErr.Error(), "error", err.Error())
		return OutcomeRelocationFailed
	}
	if err := d.StartDetached(BuildRelocateScript(cfg.PlistPath, self, newPath)); err != nil {
		d.Log.Warn("executable relocation: copied to the trusted directory but could not schedule the service reload",
			"path", self, "newPath", newPath, "error", err.Error())
		return OutcomeRelocationFailed
	}
	d.Log.Warn("executable relocation: legacy install location is unsafe for a root daemon; relocated and scheduled a service reload. "+
		"macOS Full Disk Access is keyed to the binary path, so it must be re-granted for the new path "+
		"(System Settings > Privacy & Security > Full Disk Access, or an MDM PPPC profile)",
		"from", self, "to", newPath, "reason", unsafeErr.Error())
	return OutcomeRelocationScheduled
}

// cleanupAfterRelocation removes copies left in the legacy directory once
// this binary runs from the trusted one and its plist has been repointed.
// A leftover copy of this binary is also the evidence that a relocation
// happened (by this version or by 0.118.0–0.118.2, which moved
// unconditionally and never cleaned up), so it is recorded first.
func cleanupAfterRelocation(cfg Config, d Deps, self string) {
	name := filepath.Base(self)
	legacySelf := filepath.Join(cfg.LegacyDir, name)

	if !isRegularFile(d, legacySelf) {
		return
	}
	plist, err := d.ReadFile(cfg.PlistPath)
	if err != nil {
		d.Log.Warn("executable relocation: could not read the launchd plist; leaving legacy copies in place",
			"plist", cfg.PlistPath, "error", err.Error())
		return
	}
	if !plistNames(plist, self) || plistNames(plist, legacySelf) {
		d.Log.Warn("executable relocation: launchd plist does not point only at the trusted copy; leaving legacy copies in place",
			"plist", cfg.PlistPath, "trusted", self, "legacy", legacySelf)
		return
	}

	if cfg.RecordDir != "" {
		rec := Record{From: legacySelf, To: self, RecordedAt: d.Now().UTC()}
		if err := d.WriteRecord(cfg.RecordDir, rec); err != nil {
			// Without the record nothing else would ever report that this
			// binary lost its Full Disk Access grant, so keep the leftover
			// (the evidence) and retry on the next start.
			d.Log.Warn("executable relocation: could not record the relocation; leaving the legacy copy for the next start",
				"legacy", legacySelf, "error", err.Error())
			return
		}
	}
	removeLegacy(cfg, d, name)
	d.Log.Warn("executable relocation: this binary was relocated from the legacy location. "+
		"macOS Full Disk Access is keyed to the binary path; if it was granted to the old path it must be re-granted for the new one",
		"from", legacySelf, "to", self)

	for _, sib := range cfg.Siblings {
		if isRegularFile(d, filepath.Join(cfg.TrustedDir, sib)) && isRegularFile(d, filepath.Join(cfg.LegacyDir, sib)) {
			removeLegacy(cfg, d, sib)
		}
	}
}

func removeLegacy(cfg Config, d Deps, name string) {
	path := filepath.Join(cfg.LegacyDir, name)
	if err := d.RemoveLegacyFile(cfg.LegacyDir, name); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return
		}
		d.Log.Warn("executable relocation: could not remove the leftover legacy copy",
			"path", path, "error", err.Error())
		return
	}
	d.Log.Info("executable relocation: removed leftover legacy copy", "path", path)
}

func isRegularFile(d Deps, path string) bool {
	info, err := d.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// plistNames reports whether plist has path as a whole <string> element —
// how a ProgramArguments entry is written in the Breeze plists.
func plistNames(plist []byte, path string) bool {
	return bytes.Contains(plist, []byte("<string>"+path+"</string>"))
}

// BuildRelocateScript renders the detached shell that repoints plistPath's
// ProgramArguments from oldPath to newPath and reloads the service. It
// sleeps briefly first so the caller (still running from oldPath) reaches a
// stable state before launchd unloads it. The unload kills the caller, which
// is why this cannot run in-process.
//
// If the rewrite did not take (the plist no longer names newPath), the
// script exits before touching launchd: reloading an unchanged plist would
// only restart the daemon at the legacy path. The next start retries.
// `sed -i.bak` is used because it means the same thing to BSD and GNU sed,
// which lets the rendered script be executed in the Linux CI tests.
func BuildRelocateScript(plistPath, oldPath, newPath string) string {
	q := shellQuote(plistPath)
	qb := shellQuote(plistPath + ".bak")
	return fmt.Sprintf(
		"sleep 2\n"+
			"/usr/bin/sed -i.bak 's|<string>%s</string>|<string>%s</string>|' %s || exit 1\n"+
			"rm -f %s\n"+
			"grep -q '<string>%s</string>' %s || exit 1\n"+
			"/bin/launchctl unload %s 2>/dev/null || true\n"+
			"/bin/launchctl load %s 2>/dev/null || true\n",
		oldPath, newPath, q, qb, newPath, q, q, q)
}

// shellQuote wraps path in single quotes. Every caller passes a
// compile-time constant plist path with no shell metacharacters; this keeps
// that true by construction rather than by convention.
func shellQuote(path string) string {
	return "'" + path + "'"
}
