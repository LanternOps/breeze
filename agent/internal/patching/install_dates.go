package patching

import (
	"strings"
	"time"
)

// Install dates for installed inventory (#9723). Providers fill
// InstalledPatch.InstalledAt only from a date the OS itself recorded; when it
// has none the field stays empty and the dashboard shows "date unknown".

// IUpdateHistoryEntry.Operation and .ResultCode values used to pick
// installation dates out of the Windows Update history. ResultCode 3 is
// orcSucceededWithErrors; windows.go names the same value
// wuaResultSucceededReboot.
const (
	wuaHistoryOperationInstallation     = 1 // uoInstallation
	wuaHistoryResultSucceeded           = 2 // orcSucceeded
	wuaHistoryResultSucceededWithErrors = 3 // orcSucceededWithErrors
)

// wuaHistoryEntry is the part of an IUpdateHistoryEntry needed to date an
// installed update.
type wuaHistoryEntry struct {
	UpdateID   string
	Operation  int
	ResultCode int
	Date       time.Time
}

// newestWUAInstallDates maps each UpdateID to the date of its newest
// successful installation in the history. Failed attempts and uninstalls are
// ignored. Dates are compared, so the history's order does not matter.
func newestWUAInstallDates(entries []wuaHistoryEntry) map[string]time.Time {
	dates := make(map[string]time.Time)
	for _, e := range entries {
		if e.UpdateID == "" || e.Date.IsZero() || !isSuccessfulWUAInstall(e.Operation, e.ResultCode) {
			continue
		}
		if prev, ok := dates[e.UpdateID]; !ok || e.Date.After(prev) {
			dates[e.UpdateID] = e.Date
		}
	}
	return dates
}

// isSuccessfulWUAInstall reports whether a history entry records a completed
// installation, the only kind that can date an installed update.
func isSuccessfulWUAInstall(operation, resultCode int) bool {
	return operation == wuaHistoryOperationInstallation &&
		(resultCode == wuaHistoryResultSucceeded || resultCode == wuaHistoryResultSucceededWithErrors)
}

// applyWUAInstallDates sets InstalledAt (RFC 3339, UTC) on each installed
// update whose UpdateID has a dated installation in the history.
func applyWUAInstallDates(installed []InstalledPatch, dates map[string]time.Time) {
	for i := range installed {
		if t, ok := dates[installed[i].ID]; ok {
			installed[i].InstalledAt = t.UTC().Format(time.RFC3339)
		}
	}
}

// uninstallEntry is one machine-wide Uninstall registry key: what Windows
// lists under Installed apps for all users. Per-user keys are not read.
type uninstallEntry struct {
	DisplayName    string
	DisplayVersion string
	InstallDate    string // raw registry value, normally yyyyMMdd
}

// readUninstallEntries lists the machine-wide Uninstall keys. A package var so
// tests can stand in for the registry.
var readUninstallEntries = platformUninstallEntries

// parseUninstallInstallDate converts an Uninstall key's InstallDate (yyyyMMdd)
// to yyyy-MM-dd. Any other shape returns "": installers that write a locale
// string leave the date unknown rather than risk a misread day and month.
func parseUninstallInstallDate(raw string) string {
	raw = strings.TrimSpace(raw)
	if len(raw) != 8 {
		return ""
	}
	t, err := time.Parse("20060102", raw)
	if err != nil {
		return ""
	}
	return t.Format("2006-01-02")
}

func uninstallNameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// applyUninstallInstallDates fills InstalledAt for package-manager inventory
// (winget, Chocolatey) from the Uninstall key whose DisplayName equals the
// package's title. The match must be exact (case-insensitive): a truncated or
// differently-worded name stays unknown. When several keys share the name,
// only those with the package's version count, and if none has it, or they
// disagree on the date, the date is left unknown.
//
// winget's Name column is the installed app's display name, so most winget
// packages can match. A Chocolatey title is the package id ("git",
// "googlechrome"), which matches only when the id equals the display name.
func applyUninstallInstallDates(installed []InstalledPatch, entries []uninstallEntry) {
	if len(installed) == 0 || len(entries) == 0 {
		return
	}
	byName := make(map[string][]uninstallEntry, len(entries))
	for _, e := range entries {
		if key := uninstallNameKey(e.DisplayName); key != "" {
			byName[key] = append(byName[key], e)
		}
	}
	for i := range installed {
		if installed[i].InstalledAt != "" {
			continue
		}
		candidates := byName[uninstallNameKey(installed[i].Title)]
		installed[i].InstalledAt = uninstallInstallDate(candidates, installed[i].Version)
	}
}

func uninstallInstallDate(candidates []uninstallEntry, version string) string {
	if version = strings.TrimSpace(version); version != "" {
		var sameVersion []uninstallEntry
		for _, c := range candidates {
			if strings.TrimSpace(c.DisplayVersion) == version {
				sameVersion = append(sameVersion, c)
			}
		}
		switch {
		case len(sameVersion) > 0:
			candidates = sameVersion
		case len(candidates) > 1:
			// Several keys and none has this version: none is known to be
			// the installed package.
			return ""
		}
		// A single key under the name is taken even when its version is
		// written differently (winget can normalise "5.0.0" to "5.0").
	}
	date := ""
	for _, c := range candidates {
		d := parseUninstallInstallDate(c.InstallDate)
		if d == "" {
			continue
		}
		if date != "" && d != date {
			return ""
		}
		date = d
	}
	return date
}

// withUninstallInstallDates fills install dates on package-manager inventory
// from the Uninstall registry. A registry read failure is logged and leaves
// the dates unknown; it never fails the inventory itself.
func withUninstallInstallDates(installed []InstalledPatch, provider string) {
	if len(installed) == 0 {
		return
	}
	entries, err := readUninstallEntries()
	if err != nil {
		log.Warn("reading Uninstall registry keys for install dates failed; dates left unknown",
			"provider", provider, "error", err.Error())
		return
	}
	applyUninstallInstallDates(installed, entries)
}
