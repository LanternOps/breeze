package bmr

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// This file holds the Windows reinstall-then-recover (bmr-recover) system
// state logic. It is untagged, and shells out only through the runCommand
// seam (exec_seam.go), so it is unit-tested on every platform; the
// //go:build windows restorer in restore_windows.go just calls it.
//
// Decision (#5470, Option B; docs/superpowers/plans/backup/
// 2026-09-10-bmr-windows-offline-hive-decision.md): this path applies only
// the certificate database and the firewall policy. Registry hives and the
// BCD store belong to the running OS the helper executes under, and
// restoring them live is not a supported operation, so they are collected
// for reference only and never applied here. Registry-level Windows
// recovery is the rebuild engine's job (agent/internal/backup/rebuild, which
// applies hives offline to a disk that is not booted).

// windowsLiveAppliedCategories are the staged top-level directories this
// restorer applies. Every other staged directory is reference-only.
var windowsLiveAppliedCategories = map[string]bool{
	"certs":    true,
	"firewall": true,
}

// windowsReferenceLabels names the collector's reference-only categories
// (systemstate/state_windows.go) in its collection order. "registry" is
// labelled separately, with the hive names.
var windowsReferenceLabels = []struct{ dir, label string }{
	{"registry", ""},
	{"boot", "boot configuration (BCD)"},
	{"drivers", "driver inventory"},
	{"services", "service list"},
	{"tasks", "scheduled tasks"},
	{"features", "Windows features list"},
	{"iis", "IIS configuration"},
}

// restoreWindowsLiveState applies the Windows system state that is safe to
// apply to the running OS: the AD CS certificate database (certs/, present
// only when the source had the role) and the firewall policy
// (firewall/rules.wfw). Each step runs even if the other failed; a failure
// is returned as an error, so the caller reports the state as not applied.
// The report names what was collected but left unapplied, and says so when
// nothing was applied at all.
func restoreWindowsLiveState(stagingDir string) (RestoreReport, error) {
	var report RestoreReport
	if w := windowsReferenceOnlyWarning(stagingDir); w != "" {
		report.Warnings = append(report.Warnings, w)
	}

	var errs []error
	applied := 0

	certsDir := filepath.Join(stagingDir, "certs")
	if dirHasEntries(certsDir) {
		if out, err := runCommand(context.Background(), "certutil", "-restoreDB", certsDir); err != nil {
			errs = append(errs, fmt.Errorf("certificates: certutil -restoreDB: %s: %w", strings.TrimSpace(string(out)), err))
		} else {
			applied++
			slog.Info("bmr: certificate database restored")
		}
	}

	fwPath := filepath.Join(stagingDir, "firewall", "rules.wfw")
	if info, err := os.Stat(fwPath); err == nil && info.Mode().IsRegular() {
		if out, err := runCommand(context.Background(), "netsh", "advfirewall", "import", fwPath); err != nil {
			errs = append(errs, fmt.Errorf("firewall: netsh advfirewall import: %s: %w", strings.TrimSpace(string(out)), err))
		} else {
			applied++
			slog.Info("bmr: firewall policy restored")
		}
	}

	if len(errs) > 0 {
		return report, fmt.Errorf("bmr: windows system state restore had errors: %w", errors.Join(errs...))
	}
	if applied == 0 {
		report.NothingApplied = "the snapshot has no certificate database or firewall policy to apply; " +
			"Windows recovery onto a running OS applies only those, and keeps registry hives and boot configuration for reference"
	}
	return report, nil
}

// windowsReferenceOnlyWarning names every staged category this restorer
// does not apply, or returns "" when there is none.
func windowsReferenceOnlyWarning(stagingDir string) string {
	entries, err := os.ReadDir(stagingDir)
	if err != nil {
		return ""
	}
	staged := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() && !windowsLiveAppliedCategories[e.Name()] && dirHasEntries(filepath.Join(stagingDir, e.Name())) {
			staged[e.Name()] = true
		}
	}

	var parts []string
	for _, c := range windowsReferenceLabels {
		if !staged[c.dir] {
			continue
		}
		delete(staged, c.dir)
		label := c.label
		if c.dir == "registry" {
			label = "registry hives"
			if hives := stagedHiveNames(filepath.Join(stagingDir, "registry")); len(hives) > 0 {
				label += " (" + strings.Join(hives, ", ") + ")"
			}
		}
		parts = append(parts, label)
	}
	var unknown []string
	for dir := range staged {
		unknown = append(unknown, dir)
	}
	sort.Strings(unknown)
	parts = append(parts, unknown...)

	if len(parts) == 0 {
		return ""
	}
	return "collected for reference only, not applied: " + strings.Join(parts, ", ") +
		". Windows recovery onto a running OS never applies these; use breeze-backup rebuild for registry-level recovery"
}

// stagedHiveNames lists the hive files in a staged registry directory,
// sorted, leaving out their transaction logs (SYSTEM.LOG1, SYSTEM.LOG2).
func stagedHiveNames(registryDir string) []string {
	entries, err := os.ReadDir(registryDir)
	if err != nil {
		return nil
	}
	var hives []string
	for _, e := range entries {
		if !e.IsDir() && !strings.Contains(e.Name(), ".") {
			hives = append(hives, e.Name())
		}
	}
	sort.Strings(hives)
	return hives
}

// dirHasEntries reports whether dir exists, is a directory, and is not empty.
func dirHasEntries(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}
