//go:build linux

package bmr

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// linuxRestorer applies Linux-specific system state during BMR.
type linuxRestorer struct{}

func newRestorer() Restorer {
	return &linuxRestorer{}
}

// runCommand executes an external command and returns its combined output.
// It is a package-level var (rather than calling exec.Command directly)
// purely so tests can substitute a fake instead of shelling out to real
// apt-get/dnf/systemctl/crontab/iptables-restore.
var runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// etcTargetDir is where restoreEtcTree copies the staged /etc tree. It is a
// package-level var (rather than a literal "/etc") purely so tests can
// redirect it to a temp directory instead of writing into the real live
// /etc during a unit test run.
var etcTargetDir = "/etc"

// RestoreSystemState applies Linux system state from the staging directory.
// This includes the /etc/ tree, package lists, systemd services, firewall
// rules, and crontabs.
//
// Every step below runs even if an earlier one failed (best-effort — a
// partial restore is more useful than none), and a genuine failure (a
// command that ran and errored) is collected and returned so the caller
// (applySystemState in bmr.go) can tell "system state was NOT applied"
// apart from "system state was fully applied". A step finding its OPTIONAL
// artifact simply absent from staging (e.g. no packages/rpm.txt on a dpkg
// system) is not an error — that's logged at info level and skipped.
func (r *linuxRestorer) RestoreSystemState(stagingDir string) error {
	slog.Info("bmr: restoring Linux system state", "stagingDir", stagingDir)

	var errs []error
	if _, err := r.restoreEtcTree(stagingDir); err != nil {
		errs = append(errs, fmt.Errorf("etc: %w", err))
	}
	if err := r.reinstallPackages(stagingDir); err != nil {
		errs = append(errs, fmt.Errorf("packages: %w", err))
	}
	if err := r.restoreServices(stagingDir); err != nil {
		errs = append(errs, fmt.Errorf("services: %w", err))
	}
	if err := r.restoreFirewall(stagingDir); err != nil {
		errs = append(errs, fmt.Errorf("firewall: %w", err))
	}
	if err := r.restoreCrontabs(stagingDir); err != nil {
		errs = append(errs, fmt.Errorf("crontabs: %w", err))
	}

	if len(errs) > 0 {
		return fmt.Errorf("bmr: linux system state restore had errors: %w", errors.Join(errs...))
	}

	slog.Info("bmr: Linux system state restore complete")
	return nil
}

// InjectDrivers is a no-op on Linux (kernel modules are handled by packages).
func (r *linuxRestorer) InjectDrivers(_ string) (int, error) {
	slog.Info("bmr: driver injection not applicable on Linux (use packages)")
	return 0, nil
}

// restoreEtcTree copies the backed-up /etc/ tree back onto the live system,
// skipping anything matched by etcRestoreExcludes (restore_linux_logic.go).
// It returns the list of relative paths skipped, purely so tests can assert
// on it; RestoreSystemState itself only cares about the error.
func (r *linuxRestorer) restoreEtcTree(stagingDir string) ([]string, error) {
	srcDir := filepath.Join(stagingDir, "etc")
	if _, err := os.Stat(srcDir); os.IsNotExist(err) {
		slog.Info("bmr: no etc/ artifact in staging dir, skipping /etc restore")
		return nil, nil
	}

	var skipped []string
	var copyErrs []error

	walkErr := filepath.WalkDir(srcDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relPath, relErr := filepath.Rel(srcDir, path)
		if relErr != nil {
			return relErr
		}
		if relPath == "." {
			return nil
		}
		if isExcludedEtcPath(relPath) {
			skipped = append(skipped, relPath)
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		dst := filepath.Join(etcTargetDir, relPath)
		info, infoErr := d.Info() // Lstat-based: does not follow symlinks
		if infoErr != nil {
			copyErrs = append(copyErrs, fmt.Errorf("%s: stat: %w", relPath, infoErr))
			return nil
		}
		if d.IsDir() {
			if mkErr := restoreEtcDir(dst, info); mkErr != nil {
				copyErrs = append(copyErrs, fmt.Errorf("%s: %w", relPath, mkErr))
			}
			return nil
		}
		if cpErr := restoreEtcEntry(path, dst, info); cpErr != nil {
			copyErrs = append(copyErrs, fmt.Errorf("%s: %w", relPath, cpErr))
		}
		return nil
	})
	if walkErr != nil {
		copyErrs = append(copyErrs, fmt.Errorf("walk staged /etc: %w", walkErr))
	}

	if len(skipped) > 0 {
		// Operator-visible: these paths are machine-identity/network config
		// deliberately left untouched — see etcRestoreExcludes for why each
		// one is excluded. Do not silently skip.
		slog.Warn("bmr: skipped restoring machine-specific /etc paths",
			"count", len(skipped), "paths", strings.Join(skipped, ", "))
	}
	if len(copyErrs) > 0 {
		return skipped, errors.Join(copyErrs...)
	}

	slog.Info("bmr: /etc tree restored", "skipped", len(skipped))
	return skipped, nil
}

// restoreEtcDir creates dst (or ensures it exists) with the staged
// directory's exact mode, ownership, and mtime. MkdirAll's perm argument
// alone is not sufficient — it's subject to umask — so mode is set again
// explicitly via Chmod after creation.
func restoreEtcDir(dst string, info fs.FileInfo) error {
	if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	if err := os.Chmod(dst, info.Mode().Perm()); err != nil {
		return fmt.Errorf("chmod: %w", err)
	}
	chownBestEffort(dst, info)
	if err := os.Chtimes(dst, info.ModTime(), info.ModTime()); err != nil {
		slog.Warn("bmr: failed to restore dir mtime", "path", dst, "error", err.Error())
	}
	return nil
}

// restoreEtcEntry restores a single non-directory staged /etc entry to
// dst: a symlink is recreated as a symlink (never dereferenced into a
// regular-file copy of its target), a regular file is copied byte-for-byte
// with mode/ownership/mtime restored, and any other type (socket, fifo,
// device — none of which cp -a would meaningfully reproduce into a fresh
// /etc anyway) is skipped with a logged note.
func restoreEtcEntry(src, dst string, info fs.FileInfo) error {
	switch mode := info.Mode(); {
	case mode&fs.ModeSymlink != 0:
		return restoreEtcSymlink(src, dst, info)
	case mode.IsRegular():
		return restoreEtcRegularFile(src, dst, info)
	default:
		slog.Info("bmr: skipping non-regular /etc entry", "path", dst, "type", mode.Type().String())
		return nil
	}
}

// restoreEtcSymlink reads the staged symlink's target (Readlink never
// resolves it, so a dangling target restores fine) and recreates it at
// dst, replacing whatever is already there. cp -a preserves symlinks
// exactly this way; without this, os.Stat+ReadFile in the old
// implementation dereferenced the link and either copied the *target's*
// content as a plain file (e.g. /etc/resolv.conf's systemd-resolved stub)
// or failed outright for a dangling link.
func restoreEtcSymlink(src, dst string, info fs.FileInfo) error {
	target, err := os.Readlink(src)
	if err != nil {
		return fmt.Errorf("readlink: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("mkdir parent: %w", err)
	}
	if rmErr := os.Remove(dst); rmErr != nil && !os.IsNotExist(rmErr) {
		return fmt.Errorf("remove existing entry before symlink: %w", rmErr)
	}
	if err := os.Symlink(target, dst); err != nil {
		return fmt.Errorf("symlink -> %s: %w", target, err)
	}
	chownBestEffort(dst, info) // os.Lchown: sets the link's own ownership, not the target's
	return nil
}

// restoreEtcRegularFile copies a staged regular file to dst, then
// explicitly restores mode/ownership/mtime. os.WriteFile's perm argument
// only takes effect when it creates the file — an already-existing dst
// (e.g. a fresh install's stock /etc/hosts) keeps its old mode otherwise —
// so Chmod is called unconditionally afterward to guarantee dst ends up at
// the staged file's exact mode either way.
func restoreEtcRegularFile(src, dst string, info fs.FileInfo) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("mkdir parent: %w", err)
	}
	if err := os.WriteFile(dst, data, info.Mode().Perm()); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	if err := os.Chmod(dst, info.Mode().Perm()); err != nil {
		return fmt.Errorf("chmod: %w", err)
	}
	chownBestEffort(dst, info)
	if err := os.Chtimes(dst, info.ModTime(), info.ModTime()); err != nil {
		slog.Warn("bmr: failed to restore file mtime", "path", dst, "error", err.Error())
	}
	return nil
}

// chownBestEffort applies the staged entry's uid/gid to dst via os.Lchown,
// which acts on the entry itself rather than following a symlink — correct
// for files, dirs, and symlinks alike. It never fails the restore: the
// recovery agent may not be running as root, in which case chown to an
// arbitrary uid/gid returns EPERM, and aborting the entire /etc restore
// over an ownership bit is far worse than proceeding without it — but it
// IS logged, because wrong ownership on e.g. /etc/shadow, /etc/sudoers, or
// /etc/ssl/private is a real, operator-relevant difference from the
// source machine, not a cosmetic one.
func chownBestEffort(dst string, info fs.FileInfo) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	if err := os.Lchown(dst, int(stat.Uid), int(stat.Gid)); err != nil {
		slog.Warn("bmr: failed to restore ownership",
			"path", dst, "uid", stat.Uid, "gid", stat.Gid, "error", err.Error())
	}
}

// reinstallPackages reads the package selections list collected by
// systemstate.LinuxCollector and reinstalls via dpkg or dnf. Both
// packages/dpkg.txt and packages/rpm.txt are optional — a system only ever
// has one of the two package managers, so the other's absence is expected,
// not an error.
func (r *linuxRestorer) reinstallPackages(stagingDir string) error {
	dpkgList := filepath.Join(stagingDir, "packages", "dpkg.txt")
	if _, err := os.Stat(dpkgList); err == nil {
		return r.reinstallDpkg(dpkgList)
	}

	rpmList := filepath.Join(stagingDir, "packages", "rpm.txt")
	if _, err := os.Stat(rpmList); err == nil {
		return r.reinstallDnf(rpmList)
	}

	slog.Info("bmr: no package selections list found in staging dir, skipping package reinstall")
	return nil
}

func (r *linuxRestorer) reinstallDpkg(listPath string) error {
	slog.Info("bmr: reinstalling packages via dpkg", "list", listPath)

	out, err := runCommand(context.Background(), "bash", "-c",
		fmt.Sprintf("dpkg --set-selections < %s", shellQuote(listPath)))
	if err != nil {
		return fmt.Errorf("dpkg --set-selections: %s: %w", string(out), err)
	}

	out, err = runCommand(context.Background(), "apt-get", "dselect-upgrade", "-y")
	if err != nil {
		return fmt.Errorf("apt-get dselect-upgrade: %s: %w", string(out), err)
	}

	slog.Info("bmr: dpkg package restore complete")
	return nil
}

func (r *linuxRestorer) reinstallDnf(listPath string) error {
	slog.Info("bmr: reinstalling packages via dnf", "list", listPath)

	data, err := os.ReadFile(listPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", listPath, err)
	}

	packages := strings.Fields(strings.TrimSpace(string(data)))
	if len(packages) == 0 {
		slog.Info("bmr: rpm package list is empty, skipping package reinstall")
		return nil
	}

	args := append([]string{"install", "-y"}, packages...)
	out, err := runCommand(context.Background(), "dnf", args...)
	if err != nil {
		return fmt.Errorf("dnf install: %s: %w", string(out), err)
	}

	slog.Info("bmr: dnf package restore complete", "packages", len(packages))
	return nil
}

// restoreServices re-enables systemd services from the collector's
// `systemctl list-unit-files --type=service` capture at
// services/systemd.txt, restricted to units whose STATE was "enabled"
// (parseEnabledServices in restore_linux_logic.go).
func (r *linuxRestorer) restoreServices(stagingDir string) error {
	listPath := filepath.Join(stagingDir, "services", "systemd.txt")
	if _, err := os.Stat(listPath); os.IsNotExist(err) {
		slog.Info("bmr: no service list found in staging dir, skipping service restore")
		return nil
	}

	data, err := os.ReadFile(listPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", listPath, err)
	}

	services := parseEnabledServices(data)
	if len(services) == 0 {
		slog.Info("bmr: service list contained no enabled units, skipping service restore")
		return nil
	}

	var errs []error
	enabled := 0
	for _, svc := range services {
		out, runErr := runCommand(context.Background(), "systemctl", "enable", svc)
		if runErr != nil {
			slog.Warn("bmr: failed to enable service",
				"service", svc, "error", runErr.Error(), "output", string(out))
			errs = append(errs, fmt.Errorf("enable %s: %s: %w", svc, string(out), runErr))
			continue
		}
		enabled++
	}

	slog.Info("bmr: systemd services restored", "enabled", enabled, "attempted", len(services))
	if len(errs) > 0 {
		return fmt.Errorf("failed to enable %d/%d service(s): %w", len(errs), len(services), errors.Join(errs...))
	}
	return nil
}

// restoreFirewall applies saved iptables rules from firewall/iptables.rules.
func (r *linuxRestorer) restoreFirewall(stagingDir string) error {
	rulesPath := filepath.Join(stagingDir, "firewall", "iptables.rules")
	if _, err := os.Stat(rulesPath); os.IsNotExist(err) {
		slog.Info("bmr: no firewall rules found in staging dir, skipping firewall restore")
		return nil
	}

	out, err := runCommand(context.Background(), "bash", "-c",
		fmt.Sprintf("iptables-restore < %s", shellQuote(rulesPath)))
	if err != nil {
		return fmt.Errorf("iptables-restore: %s: %w", string(out), err)
	}

	slog.Info("bmr: firewall rules restored")
	return nil
}

// restoreCrontabs restores per-user crontabs from crontabs/spool/*
// (crontabSpoolEntries in restore_linux_logic.go handles both the
// Debian-nested and RHEL-flat spool layouts). crontabs/crontab — the
// collector's copy of /etc/crontab — is deliberately never restored here:
// it lives one level above spool/, so a walk rooted at spool/ never sees
// it, and it is redundant with the /etc tree restore anyway.
func (r *linuxRestorer) restoreCrontabs(stagingDir string) error {
	spoolDir := filepath.Join(stagingDir, "crontabs", "spool")
	if _, err := os.Stat(spoolDir); os.IsNotExist(err) {
		slog.Info("bmr: no crontab spool found in staging dir, skipping crontab restore")
		return nil
	}

	entries, err := crontabSpoolEntries(spoolDir)
	if err != nil {
		return fmt.Errorf("enumerate crontab spool: %w", err)
	}
	if len(entries) == 0 {
		slog.Info("bmr: crontab spool is empty, skipping crontab restore")
		return nil
	}

	var errs []error
	restored := 0
	for user, path := range entries {
		out, runErr := runCommand(context.Background(), "crontab", "-u", user, path)
		if runErr != nil {
			errs = append(errs, fmt.Errorf("restore crontab for %s: %s: %w", user, string(out), runErr))
			continue
		}
		restored++
		slog.Info("bmr: crontab restored", "user", user)
	}

	slog.Info("bmr: crontab restore complete", "restored", restored, "total", len(entries))
	if len(errs) > 0 {
		return fmt.Errorf("crontab restore had %d/%d error(s): %w", len(errs), len(entries), errors.Join(errs...))
	}
	return nil
}

// shellQuote wraps s in double quotes for interpolation into a `bash -c`
// string, escaping the few characters that are special inside double
// quotes. Staging paths are agent-generated (os.MkdirTemp under a fixed
// prefix), not attacker input, but quoting costs nothing.
func shellQuote(s string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `\$`, "`", "\\`")
	return `"` + replacer.Replace(s) + `"`
}
