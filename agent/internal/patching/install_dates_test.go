package patching

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// #9723: a Windows Update history entry maps onto the installed update with
// the same UpdateID, using the newest successful installation.
func TestNewestWUAInstallDatesMapsSuccessfulInstalls(t *testing.T) {
	older := time.Date(2026, 1, 10, 9, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 2, 14, 18, 30, 5, 0, time.UTC)
	dates := newestWUAInstallDates([]wuaHistoryEntry{
		{UpdateID: "cu-1", Operation: wuaHistoryOperationInstallation, ResultCode: wuaHistoryResultSucceeded, Date: older},
		{UpdateID: "cu-1", Operation: wuaHistoryOperationInstallation, ResultCode: wuaHistoryResultSucceededWithErrors, Date: newer},
		// A failed attempt after the last success is not when it was installed.
		{UpdateID: "cu-1", Operation: wuaHistoryOperationInstallation, ResultCode: 4, Date: newer.Add(time.Hour)},
		// An uninstall is not an install.
		{UpdateID: "cu-1", Operation: 2, ResultCode: wuaHistoryResultSucceeded, Date: newer.Add(2 * time.Hour)},
		{UpdateID: "defs", Operation: wuaHistoryOperationInstallation, ResultCode: wuaHistoryResultSucceeded, Date: older},
		{UpdateID: "only-failed", Operation: wuaHistoryOperationInstallation, ResultCode: 4, Date: older},
		{UpdateID: "", Operation: wuaHistoryOperationInstallation, ResultCode: wuaHistoryResultSucceeded, Date: older},
		{UpdateID: "zero-date", Operation: wuaHistoryOperationInstallation, ResultCode: wuaHistoryResultSucceeded},
	})

	if got := dates["cu-1"]; !got.Equal(newer) {
		t.Errorf("cu-1 = %v, want newest successful install %v", got, newer)
	}
	if got := dates["defs"]; !got.Equal(older) {
		t.Errorf("defs = %v, want %v", got, older)
	}
	for _, id := range []string{"only-failed", "", "zero-date"} {
		if _, ok := dates[id]; ok {
			t.Errorf("dates[%q] set, want absent", id)
		}
	}

	installed := []InstalledPatch{
		{ID: "cu-1", Title: "Cumulative Update", KBNumber: "KB5050001"},
		{ID: "not-in-history", Title: "Old Update", KBNumber: "KB4000000"},
	}
	applyWUAInstallDates(installed, dates)
	if installed[0].InstalledAt != "2026-02-14T18:30:05Z" {
		t.Errorf("cu-1 InstalledAt = %q, want 2026-02-14T18:30:05Z", installed[0].InstalledAt)
	}
	// History is a bounded log: an update installed before the retained
	// entries stays unknown rather than guessing.
	if installed[1].InstalledAt != "" {
		t.Errorf("not-in-history InstalledAt = %q, want empty", installed[1].InstalledAt)
	}
}

func TestIsSuccessfulWUAInstall(t *testing.T) {
	cases := []struct {
		op, rc int
		want   bool
	}{
		{wuaHistoryOperationInstallation, wuaHistoryResultSucceeded, true},
		{wuaHistoryOperationInstallation, wuaHistoryResultSucceededWithErrors, true},
		{wuaHistoryOperationInstallation, 4, false}, // failed
		{wuaHistoryOperationInstallation, 5, false}, // aborted
		{wuaHistoryOperationInstallation, 1, false}, // in progress
		{2, wuaHistoryResultSucceeded, false},       // uninstall
		{0, 0, false},
	}
	for _, tc := range cases {
		if got := isSuccessfulWUAInstall(tc.op, tc.rc); got != tc.want {
			t.Errorf("isSuccessfulWUAInstall(%d, %d) = %v, want %v", tc.op, tc.rc, got, tc.want)
		}
	}
}

func TestParseUninstallInstallDate(t *testing.T) {
	cases := map[string]string{
		"20240115":   "2024-01-15",
		" 20240115 ": "2024-01-15",
		"":           "",
		"2024-01-15": "",
		"20241399":   "",
		"jeu. févr.": "",
		"202401151":  "",
	}
	for raw, want := range cases {
		if got := parseUninstallInstallDate(raw); got != want {
			t.Errorf("parseUninstallInstallDate(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestApplyUninstallInstallDates(t *testing.T) {
	entries := []uninstallEntry{
		{DisplayName: "Git", DisplayVersion: "2.51.0.2", InstallDate: "20260105"},
		// Same product under the 32-bit view with the same date.
		{DisplayName: "git", DisplayVersion: "2.51.0.2", InstallDate: "20260105"},
		// Two installs of one name: the version picks the right key.
		{DisplayName: "Node.js", DisplayVersion: "20.11.0", InstallDate: "20250301"},
		{DisplayName: "Node.js", DisplayVersion: "22.3.0", InstallDate: "20260220"},
		// Same name, different dates, no version to tell them apart.
		{DisplayName: "Twin Tool", DisplayVersion: "1.0", InstallDate: "20250101"},
		{DisplayName: "Twin Tool", DisplayVersion: "2.0", InstallDate: "20250202"},
		{DisplayName: "No Date App", DisplayVersion: "3.0"},
		{DisplayName: "Bad Date App", DisplayVersion: "1.0", InstallDate: "garbage"},
		// One key under the name: a differently-formatted version is still it.
		{DisplayName: "Solo App", DisplayVersion: "5.0.0", InstallDate: "20250505"},
		// Several keys, none with the reported version: neither is known to
		// be the installed package, even though they agree on the date.
		{DisplayName: "Pair Tool", DisplayVersion: "1.0", InstallDate: "20250101"},
		{DisplayName: "Pair Tool", DisplayVersion: "2.0", InstallDate: "20250101"},
	}
	installed := []InstalledPatch{
		{ID: "Git.Git", Title: "Git", Version: "2.51.0.2"},
		{ID: "OpenJS.NodeJS", Title: "Node.js", Version: "22.3.0"},
		{ID: "Twin.Tool", Title: "Twin Tool", Version: "9.9"},
		{ID: "No.Date", Title: "No Date App", Version: "3.0"},
		{ID: "Bad.Date", Title: "Bad Date App", Version: "1.0"},
		{ID: "Missing.App", Title: "Not In Registry", Version: "1.0"},
		{ID: "Truncated.App", Title: "Microsoft Visual C++ 2015-2022 Redistrib…", Version: "14.38"},
		{ID: "Solo.App", Title: "Solo App", Version: "5.0"},
		{ID: "Pair.Tool", Title: "Pair Tool", Version: "3.0"},
	}
	applyUninstallInstallDates(installed, entries)

	want := map[string]string{
		"Git.Git":       "2026-01-05",
		"OpenJS.NodeJS": "2026-02-20",
		"Twin.Tool":     "",
		"No.Date":       "",
		"Bad.Date":      "",
		"Missing.App":   "",
		"Truncated.App": "",
		"Solo.App":      "2025-05-05",
		"Pair.Tool":     "",
	}
	for _, p := range installed {
		if p.InstalledAt != want[p.ID] {
			t.Errorf("%s InstalledAt = %q, want %q", p.ID, p.InstalledAt, want[p.ID])
		}
	}
}

func stubUninstallEntries(t *testing.T, entries []uninstallEntry, err error) {
	t.Helper()
	prev := readUninstallEntries
	readUninstallEntries = func() ([]uninstallEntry, error) { return entries, err }
	t.Cleanup(func() { readUninstallEntries = prev })
}

const wingetListFixture = "Name             Id               Version   Source\n" +
	"----------------------------------------------------\n" +
	"Git              Git.Git          2.51.0.2  winget\n" +
	"Mozilla Firefox  Mozilla.Firefox  128.0     winget\n"

// #9723: winget list has no date column, so the date comes from the
// package's Uninstall key when it has one.
func TestSystemWingetGetInstalledFillsInstallDateFromUninstallKey(t *testing.T) {
	stubUninstallEntries(t, []uninstallEntry{
		{DisplayName: "Git", DisplayVersion: "2.51.0.2", InstallDate: "20260105"},
		{DisplayName: "Mozilla Firefox (x64 en-US)", DisplayVersion: "128.0", InstallDate: "20260301"},
	}, nil)
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		return wingetListFixture, "", 0, nil
	})

	installed, err := p.GetInstalled()
	if err != nil {
		t.Fatal(err)
	}
	if len(installed) != 2 {
		t.Fatalf("got %d installed, want 2: %+v", len(installed), installed)
	}
	if installed[0].ID != "Git.Git" || installed[0].InstalledAt != "2026-01-05" {
		t.Errorf("Git = %+v, want InstalledAt 2026-01-05", installed[0])
	}
	// No Uninstall key with that exact name: leave it unknown, don't guess.
	if installed[1].InstalledAt != "" {
		t.Errorf("Firefox InstalledAt = %q, want empty", installed[1].InstalledAt)
	}
}

func TestSystemWingetGetInstalledRegistryFailureKeepsInventory(t *testing.T) {
	stubUninstallEntries(t, nil, errors.New("access denied"))
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		return wingetListFixture, "", 0, nil
	})

	installed, err := p.GetInstalled()
	if err != nil {
		t.Fatalf("a registry read failure must not fail the inventory: %v", err)
	}
	if len(installed) != 2 {
		t.Fatalf("got %d installed, want 2", len(installed))
	}
	for _, ip := range installed {
		if ip.InstalledAt != "" {
			t.Errorf("%s InstalledAt = %q, want empty", ip.ID, ip.InstalledAt)
		}
	}
}

func TestSystemWingetGetInstalledSkipsRegistryWhenNothingInstalled(t *testing.T) {
	prev := readUninstallEntries
	readUninstallEntries = func() ([]uninstallEntry, error) {
		t.Fatal("must not read the registry for an empty inventory")
		return nil, nil
	}
	t.Cleanup(func() { readUninstallEntries = prev })
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		return "Name Id Version Source\n" + strings.Repeat("-", 30) + "\n", "", 0, nil
	})
	if _, err := p.GetInstalled(); err != nil {
		t.Fatal(err)
	}
}
