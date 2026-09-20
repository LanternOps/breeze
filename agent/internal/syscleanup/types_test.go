package syscleanup

import (
	"strings"
	"testing"
)

// The closed catalogue (spec §5.3, §7.2 + plan amendment 12). Registry key
// names are NEVER accepted from the client: a cleanmgr handler is addressed by
// a `win_cleanmgr:<slug>` id whose slug maps to a key name through a Go
// constant. This test pins the exact id set so widening it is a deliberate,
// reviewable edit rather than a drive-by.
func TestActionIDsIsTheClosedCatalogue(t *testing.T) {
	want := []string{
		"win_cleanmgr",
		"win_cleanmgr:update_cleanup",
		"win_cleanmgr:delivery_optimization_files",
		"win_cleanmgr:device_driver_packages",
		"win_cleanmgr:previous_installations",
		"win_cleanmgr:upgrade_discarded_files",
		"win_cleanmgr:windows_upgrade_log_files",
		"win_cleanmgr:setup_log_files",
		"win_cleanmgr:temporary_setup_files",
		"win_cleanmgr:service_pack_cleanup",
		"win_cleanmgr:system_error_memory_dump_files",
		"win_cleanmgr:system_error_minidump_files",
		"win_cleanmgr:windows_error_reporting_files",
		"win_cleanmgr:windows_error_reporting_system_archive_files",
		"win_cleanmgr:windows_error_reporting_system_queue_files",
		"win_cleanmgr:temporary_files",
		"win_cleanmgr:windows_defender",
		"win_cleanmgr:old_chkdsk_files",
		"win_cleanmgr:diagnostic_data_viewer_database_files",
		"win_cleanmgr:branchcache",
		"win_cleanmgr:content_indexer_cleaner",
		"win_dism_component_cleanup",
		"mac_tm_local_snapshots",
		"mac_brew_cleanup",
		"linux_pkg_cache_clean",
		"linux_pkg_autoremove",
		"linux_journal_vacuum",
	}
	if len(ActionIDs) != len(want) {
		t.Fatalf("ActionIDs has %d entries, want %d", len(ActionIDs), len(want))
	}
	for i := range want {
		if ActionIDs[i] != want[i] {
			t.Fatalf("ActionIDs[%d] = %q, want %q", i, ActionIDs[i], want[i])
		}
	}
}

// Excluded in code, not config (spec §7.2, §10 item 7).
func TestActionIDsExcludeTheForbiddenHandlers(t *testing.T) {
	for _, forbidden := range []string{
		"downloadsfolder", "windows esd", "language pack",
		"recycle bin", "thumbnail cache", "temporary internet files",
		"internet cache files", "active setup temp folders",
		"gamenewsfiles", "gamestatisticsfiles", "gameupdatefiles",
		"resetbase",
	} {
		for _, id := range ActionIDs {
			if strings.Contains(strings.ToLower(id), strings.ReplaceAll(forbidden, " ", "_")) {
				t.Fatalf("forbidden handler %q is reachable as action id %q", forbidden, id)
			}
		}
	}
}

func TestIsKnownActionIDRejectsAnythingElse(t *testing.T) {
	if !IsKnownActionID("linux_journal_vacuum") {
		t.Fatal("a catalogue id must be known")
	}
	for _, id := range []string{
		"", "LINUX_JOURNAL_VACUUM", "win_cleanmgr:DownloadsFolder",
		"win_cleanmgr:../../etc/passwd", "linux_journal_vacuum; rm -rf /",
	} {
		if IsKnownActionID(id) {
			t.Fatalf("IsKnownActionID(%q) = true, want false", id)
		}
	}
}

func TestCatalogVersionIsPinned(t *testing.T) {
	if CatalogVersion != 1 {
		t.Fatalf("CatalogVersion = %d, want 1 (bump deliberately; the server records it on every run)", CatalogVersion)
	}
}

// Spec §13 #4/#14/#15: two statuses and two risk flags the original catalogue
// did not have. They are pinned here because the shared TS validator, the run
// projection and eight locale catalogues all mirror these exact strings.
func TestStatusAndRiskFlagStringsArePinned(t *testing.T) {
	for _, pair := range [][2]string{
		{StatusCompleted, "completed"},
		{StatusFailed, "failed"},
		{StatusTimedOut, "timed_out"},
		{StatusUnavailable, "unavailable"},
		{StatusBusy, "busy"},
		{StatusNotStarted, "not_started"},
		{RiskLongRunning, "long_running"},
		{RiskMayRequireReboot, "may_require_reboot"},
		{RiskMayRequireRebootFree, "may_require_reboot_free_state"},
		{RiskRemovesDriverRollback, "removes_driver_rollback"},
		{RiskRemovesPackages, "removes_packages"},
		{RiskRemovesOSRollback, "removes_os_rollback"},
		{RiskRemovesRecoveryPoints, "removes_recovery_points"},
	} {
		if pair[0] != pair[1] {
			t.Errorf("constant = %q, want %q", pair[0], pair[1])
		}
	}
}
