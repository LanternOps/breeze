package syscleanup

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// Spec §7.2's allowlist, verbatim, plus the exclusions. This is the single
// most safety-critical list in the wave: a per-user handler under the SYSTEM
// service account operates on the SYSTEM profile rather than the logged-in
// user, DownloadsFolder deletes user data, ESD breaks Reset this PC, and
// Language Pack uninstalls installed languages.
func TestCleanmgrHandlerAllowlistIsExactlyTheSpecSet(t *testing.T) {
	// `update_cleanup` was in this list until #6482: it deadlocks in session 0
	// before freeing anything, and win_dism_component_cleanup is the supported
	// non-interactive equivalent. It lives in winRetiredCleanmgrHandlers now.
	want := map[string]string{
		"delivery_optimization_files":                  "Delivery Optimization Files",
		"device_driver_packages":                       "Device Driver Packages",
		"previous_installations":                       "Previous Installations",
		"upgrade_discarded_files":                      "Upgrade Discarded Files",
		"windows_upgrade_log_files":                    "Windows Upgrade Log Files",
		"setup_log_files":                              "Setup Log Files",
		"temporary_setup_files":                        "Temporary Setup Files",
		"service_pack_cleanup":                         "Service Pack Cleanup",
		"system_error_memory_dump_files":               "System error memory dump files",
		"system_error_minidump_files":                  "System error minidump files",
		"windows_error_reporting_files":                "Windows Error Reporting Files",
		"windows_error_reporting_system_archive_files": "Windows Error Reporting System Archive Files",
		"windows_error_reporting_system_queue_files":   "Windows Error Reporting System Queue Files",
		"temporary_files":                              "Temporary Files",
		"windows_defender":                             "Windows Defender",
		"old_chkdsk_files":                             "Old ChkDsk Files",
		"diagnostic_data_viewer_database_files":        "Diagnostic Data Viewer database files",
		"branchcache":                                  "BranchCache",
		"content_indexer_cleaner":                      "Content Indexer Cleaner",
	}
	if len(winCleanmgrHandlers) != len(want) {
		t.Fatalf("winCleanmgrHandlers has %d entries, want %d", len(winCleanmgrHandlers), len(want))
	}
	for _, handler := range winCleanmgrHandlers {
		keyName, ok := want[handler.slug]
		if !ok {
			t.Fatalf("unexpected handler slug %q", handler.slug)
		}
		if handler.keyName != keyName {
			t.Fatalf("slug %q maps to registry key %q, want %q", handler.slug, handler.keyName, keyName)
		}
		if handler.label == "" {
			t.Fatalf("slug %q has no fallback friendly label", handler.slug)
		}
	}
	// Every sub-id in the shared catalogue resolves to exactly one offered
	// handler, or to a retired one carrying a reason.
	for _, subID := range winCleanmgrSubIDs {
		if _, ok := winCleanmgrHandlerBySubID(subID); ok {
			continue
		}
		if _, retired := winRetiredCleanmgrHandlers[strings.TrimPrefix(subID, "win_cleanmgr:")]; !retired {
			t.Fatalf("catalogue sub-id %q has neither a handler nor a retirement reason", subID)
		}
	}
}

func TestCleanmgrHandlersExcludeUserDataAndRecoveryHandlers(t *testing.T) {
	forbidden := []string{
		"DownloadsFolder", "Windows ESD installation files", "Language Pack",
		"Recycle Bin", "Thumbnail Cache", "Temporary Internet Files",
		"Internet Cache Files", "Active Setup Temp Folders",
		"GameNewsFiles", "GameStatisticsFiles", "GameUpdateFiles",
	}
	for _, handler := range winCleanmgrHandlers {
		for _, name := range forbidden {
			if strings.EqualFold(handler.keyName, name) {
				t.Fatalf("forbidden cleanmgr handler %q is in the allowlist", name)
			}
		}
	}
}

// Risk flags the spec assigns per handler (§7.2). These drive the UI badges;
// getting them wrong means a tech restarts a machine they were not warned
// about, or loses driver rollback without being told.
func TestCleanmgrHandlerRiskFlags(t *testing.T) {
	byslug := map[string]winCleanmgrHandler{}
	for _, handler := range winCleanmgrHandlers {
		byslug[handler.slug] = handler
	}
	if !containsFold(byslug["device_driver_packages"].riskFlags, RiskRemovesDriverRollback) {
		t.Error("Device Driver Packages must carry removes_driver_rollback")
	}
	// Spec §13 #15: deleting Windows.old / $WINDOWS.~BT ends the "go back to
	// the previous version" window, which no later action can restore.
	for _, slug := range []string{"previous_installations", "upgrade_discarded_files"} {
		if !containsFold(byslug[slug].riskFlags, RiskRemovesOSRollback) {
			t.Errorf("%s must carry removes_os_rollback", slug)
		}
	}
	if containsFold(byslug["setup_log_files"].riskFlags, RiskRemovesOSRollback) {
		t.Error("Setup Log Files must not claim to remove OS rollback")
	}
	if len(byslug["setup_log_files"].riskFlags) != 0 {
		t.Error("Setup Log Files carries no risk flag")
	}
}

// Argv from constants only; /d is not supported with /sagerun, so all volumes
// are processed (spec §7.2) and no volume string is ever interpolated.
func TestCleanmgrAndDismArgs(t *testing.T) {
	if got := strings.Join(cleanmgrArgs(), " "); got != "/sagerun:5555" {
		t.Fatalf("cleanmgrArgs() = %q", got)
	}
	analyze := strings.Join(dismAnalyzeArgs(), " ")
	if analyze != "/English /Online /Cleanup-Image /AnalyzeComponentStore" {
		t.Fatalf("dismAnalyzeArgs() = %q", analyze)
	}
	cleanup := strings.Join(dismCleanupArgs(), " ")
	if cleanup != "/English /Online /Cleanup-Image /StartComponentCleanup" {
		t.Fatalf("dismCleanupArgs() = %q", cleanup)
	}
	// /ResetBase is never reachable: it makes every installed update
	// permanent and unremovable (spec §10 item 7, out of scope in §1).
	for _, args := range [][]string{cleanmgrArgs(), dismAnalyzeArgs(), dismCleanupArgs()} {
		for _, arg := range args {
			if strings.Contains(strings.ToLower(arg), "resetbase") {
				t.Fatalf("args %v contain /ResetBase", args)
			}
			if strings.Contains(arg, "/d") && strings.Contains(arg, "sagerun") {
				t.Fatalf("args %v combine /d with /sagerun", args)
			}
		}
	}
	// /English is what makes parseDismAnalyze deterministic on a non-English
	// endpoint (spec §7.1).
	if !strings.HasPrefix(analyze, "/English") {
		t.Fatal("DISM must be invoked with /English before anything else")
	}
}

// DISM reports 1024-based sizes with a two-character suffix ("1.64 GB"),
// which is neither of the two grammars in sizes.go.
func TestParseDismSize(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"1.64 GB", 1_760_936_591, true},
		{"389.51 MB", 408_430_838, true},
		{"512 KB", 524_288, true},
		{"0 bytes", 0, true},
		{"", 0, false},
		{"unknown", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseDismSize(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseDismSize(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestParseDismAnalyzeSumsBackupsAndCache(t *testing.T) {
	const fixture = `Deployment Image Servicing and Management tool
Version: 10.0.22621.2792

Image Version: 10.0.22621.2861

[===========================99.0%========================= ]

Component Store (WinSxS) information:

Windows Explorer Reported Size of Component Store : 8.63 GB

Actual Size of Component Store : 8.21 GB

    Shared with Windows : 6.18 GB
    Backups and Disabled Features : 1.64 GB
    Cache and Temporary Data :  389.51 MB

Date of Last Cleanup : 2026-08-01 03:00:11

Number of Reclaimable Packages : 12
Component Store Cleanup Recommended : Yes

The operation completed successfully.
`
	got, ok, recommended := parseDismAnalyze(fixture)
	if !ok {
		t.Fatal("the documented AnalyzeComponentStore shape must parse")
	}
	if want := int64(1_760_936_591 + 408_430_838); got != want {
		t.Fatalf("parseDismAnalyze() = %d, want %d", got, want)
	}
	if !recommended {
		t.Fatal("recommended must be true for this fixture")
	}
}

// Plan amendment 25 (spec §13 #14): "Cleanup Recommended : No" is NOT a zero.
// The two fields are component-store overhead and a direct
// /StartComponentCleanup has no 30-day grace period, so Windows saying "not
// worth it" is not the same as "nothing would be freed". The sum is still
// reported; only the recommendation flag changes.
func TestParseDismAnalyzeReportsTheSumEvenWhenNotRecommended(t *testing.T) {
	const fixture = `Component Store (WinSxS) information:

Actual Size of Component Store : 6.10 GB

    Shared with Windows : 5.90 GB
    Backups and Disabled Features : 180.00 MB
    Cache and Temporary Data : 20.00 MB

Number of Reclaimable Packages : 0
Component Store Cleanup Recommended : No

The operation completed successfully.
`
	got, ok, recommended := parseDismAnalyze(fixture)
	if !ok {
		t.Fatal("the shape must parse")
	}
	if want := int64(180*(1<<20) + 20*(1<<20)); got != want {
		t.Fatalf("parseDismAnalyze() = %d, want %d — a 'No' recommendation does not zero the estimate", got, want)
	}
	if recommended {
		t.Fatal("recommended must be false for this fixture")
	}
}

func TestParseDismAnalyzeOnAnErrorBody(t *testing.T) {
	const fixture = `Error: 1392

The file or directory is corrupted and unreadable.

The DISM log file can be found at C:\Windows\Logs\DISM\dism.log
`
	if _, ok, _ := parseDismAnalyze(fixture); ok {
		t.Fatal("an error body must be estimateKnown:false, never 0")
	}
}

// Plan amendment 26 (spec §13 #14). The Delivery Optimization cache is NOT
// under SoftwareDistribution — it lives in the NetworkService profile and is
// policy-overridable — and the Temporary Files handler covers more than
// %SystemRoot%\Temp, so sizing it from that one directory under-reports.
func TestDeliveryOptimizationAndTemporaryFilesEstimatePaths(t *testing.T) {
	byslug := map[string]winCleanmgrHandler{}
	for _, handler := range winCleanmgrHandlers {
		byslug[handler.slug] = handler
	}

	do := byslug["delivery_optimization_files"]
	if len(do.estimatePaths) != 0 {
		t.Fatalf("Delivery Optimization must resolve its cache at runtime (policy override), not from a static path list; got %v", do.estimatePaths)
	}
	if do.estimatePathsFn == nil {
		t.Fatal("Delivery Optimization needs a runtime path resolver")
	}
	if got := deliveryOptimizationCachePath(""); got != `%SystemDrive%\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache` {
		t.Fatalf("default DO cache path = %q", got)
	}
	// DOModifyCacheDrive names a drive or a folder; the default tail is
	// appended to a bare drive letter.
	if got := deliveryOptimizationCachePath("E:"); !strings.HasPrefix(got, `E:\`) {
		t.Fatalf("policy-overridden DO cache path = %q, want it on E:", got)
	}
	if got := deliveryOptimizationCachePath(`D:\DOCache`); got != `D:\DOCache` {
		t.Fatalf("an explicit policy folder must be used verbatim; got %q", got)
	}

	if len(byslug["temporary_files"].estimatePaths) != 0 {
		t.Fatal("Temporary Files must report an UNKNOWN estimate: the handler covers more than %SystemRoot%\\Temp")
	}
}

// --- Profile hygiene (spec §13 #4) -----------------------------------------
//
// These are the most safety-critical assertions in the wave, and the Windows
// `go test` job does not run internal/syscleanup at all — so the registry seam
// is a function variable and this fake is the only place the rules execute.

func withFakeVolumeCaches(t *testing.T, present []string, failOn string) map[string]uint32 {
	t.Helper()
	return withFakeVolumeCachesResult(t, present, failOn, ProcResult{})
}

// withFakeVolumeCachesResult additionally dictates what the faked cleanmgr
// invocation reports back, so the session-0 outcomes (#6482) are testable off
// Windows.
func withFakeVolumeCachesResult(t *testing.T, present []string, failOn string, proc ProcResult) map[string]uint32 {
	t.Helper()
	written := map[string]uint32{}
	originalPresent, originalSet := presentVolumeCaches, setStateFlags
	originalResolve, originalRun := resolveWindowsBinary, runWindowsProcessIdle
	t.Cleanup(func() { resolveWindowsBinary, runWindowsProcessIdle = originalResolve, originalRun })
	resolveWindowsBinary = func(candidates ...string) (string, bool) { return candidates[0], true }
	runWindowsProcessIdle = func(_ context.Context, timeout time.Duration, limits idleLimits, binary string, args ...string) ProcResult {
		if timeout != cleanmgrTimeout || binary != systemRoot()+cleanmgrBinaryRelative || strings.Join(args, " ") != "/sagerun:5555" {
			t.Fatalf("unexpected cleaner invocation: %s %v (%s)", binary, args, timeout)
		}
		// The watchdog is the whole point: a cleanmgr launched without it
		// wedges for the full hour under the SYSTEM service.
		if !limits.enabled() {
			t.Fatal("cleanmgr must be launched with the session-0 idle watchdog armed")
		}
		written["__cleanmgr_started__"] = 1
		return proc
	}
	t.Cleanup(func() { presentVolumeCaches, setStateFlags = originalPresent, originalSet })

	presentVolumeCaches = func() ([]string, error) { return present, nil }
	setStateFlags = func(keyName string, value uint32) error {
		if keyName == failOn {
			return errors.New("access is denied")
		}
		written[keyName] = value
		return nil
	}
	return written
}

// The whole point: /sagerun:5555 runs EVERY handler flagged 2, wherever that 2
// came from. A third-party or excluded handler that already carries one must
// be zeroed, or it executes alongside the selection with no trace in the
// result.
func TestCleanmgrRunZeroesEveryNonSelectedHandlerIncludingUnallowlistedOnes(t *testing.T) {
	written := withFakeVolumeCaches(t, []string{
		"Setup Log Files",
		"Update Cleanup",
		"DownloadsFolder",     // excluded built-in
		"Contoso Disk Helper", // third-party
		"Windows ESD installation files",
	}, "")

	action := winCleanmgrAction{selectedSlugs: []string{"setup_log_files"}}
	got := action.Run(context.Background(), Params{})
	if got.Status != StatusCompleted || written["__cleanmgr_started__"] != 1 {
		t.Fatalf("cleanmgr was not invoked after preparing the profile: %+v", got)
	}

	if written["Setup Log Files"] != 2 {
		t.Fatalf("the selected handler was flagged %d, want 2", written["Setup Log Files"])
	}
	for _, keyName := range []string{"Update Cleanup", "DownloadsFolder", "Contoso Disk Helper", "Windows ESD installation files"} {
		value, seen := written[keyName]
		if !seen {
			t.Errorf("%q was never written; a stale StateFlags5555=2 would run it", keyName)
			continue
		}
		if value != 0 {
			t.Errorf("%q was flagged %d, want 0", keyName, value)
		}
	}
}

// A half-written profile executes an arbitrary subset that matches neither the
// selection nor the reported result, so the action fails before cleanmgr runs.
func TestCleanmgrRunAbortsBeforeCleanmgrWhenAProfileWriteFails(t *testing.T) {
	written := withFakeVolumeCaches(t,
		[]string{"Setup Log Files", "Contoso Disk Helper"}, "Contoso Disk Helper")

	got := winCleanmgrAction{selectedSlugs: []string{"setup_log_files"}}.Run(context.Background(), Params{})

	if got.Status != StatusFailed {
		t.Fatalf("status = %q, want failed", got.Status)
	}
	if !strings.Contains(got.Error, "aborted before running cleanmgr") {
		t.Fatalf("error = %q, want it to say the run was aborted before cleanmgr", got.Error)
	}
	if _, ran := written["__cleanmgr_started__"]; ran {
		t.Fatal("cleanmgr must not have been started")
	}
}

func TestWindowsActionsShape(t *testing.T) {
	byID := map[string]ActionInfo{}
	for _, action := range windowsActions() {
		byID[action.ID()] = action.Describe()
	}
	for _, id := range []string{"win_cleanmgr", "win_dism_component_cleanup"} {
		info, ok := byID[id]
		if !ok {
			t.Fatalf("windowsActions() is missing %q", id)
		}
		if info.OS != "windows" || info.Label == "" || info.Description == "" {
			t.Errorf("%s: %+v", id, info)
		}
		if !containsFold(info.RiskFlags, RiskLongRunning) {
			t.Errorf("%s must carry long_running — both can run for the best part of an hour", id)
		}
	}
	if !containsFold(byID["win_dism_component_cleanup"].RiskFlags, RiskMayRequireRebootFree) {
		t.Error("DISM component cleanup must carry may_require_reboot_free_state")
	}
}

func TestCleanmgrSubActionsExposeHandlerRiskFlags(t *testing.T) {
	withFakeVolumeCaches(t, []string{"Previous Installations", "Upgrade Discarded Files", "Device Driver Packages", "Setup Log Files"}, "")
	for _, sub := range (winCleanmgrAction{}).SubActions() {
		raw, err := json.Marshal(sub)
		if err != nil {
			t.Fatal(err)
		}
		var wire struct {
			RiskFlags []string `json:"riskFlags"`
		}
		if err := json.Unmarshal(raw, &wire); err != nil {
			t.Fatal(err)
		}
		handler, _ := winCleanmgrHandlerBySubID(sub.ID)
		if wire.RiskFlags == nil {
			t.Errorf("%s omits riskFlags", sub.ID)
		}
		for _, flag := range handler.riskFlags {
			if !containsFold(wire.RiskFlags, flag) {
				t.Errorf("%s missing %s", sub.ID, flag)
			}
		}
	}
}

// --- #6482: session-0 outcomes ---------------------------------------------

// The W05 lab's BUG-3: the parent action reported `timed_out` while every
// sub-action underneath it still claimed `completed`. A tech reading the run
// history saw "Windows Update cleanup: completed" for a handler that provably
// never ran.
func TestCleanmgrTimedOutRunDoesNotClaimItsHandlersCompleted(t *testing.T) {
	withFakeVolumeCachesResult(t, []string{"Setup Log Files", "Temporary Files"}, "",
		ProcResult{TimedOut: true, Err: errors.New("cleanmgr.exe timed out after 1h0m0s and its process tree was terminated")})

	got := winCleanmgrAction{selectedSlugs: []string{"setup_log_files", "temporary_files"}}.Run(context.Background(), Params{})

	if got.Status != StatusTimedOut {
		t.Fatalf("status = %q, want timed_out", got.Status)
	}
	if len(got.SubActions) != 2 {
		t.Fatalf("SubActions = %+v, want one per selected handler", got.SubActions)
	}
	for _, sub := range got.SubActions {
		if sub.Status == StatusCompleted {
			t.Errorf("%s reports completed inside a %s run; nothing proved that handler finished", sub.ID, got.Status)
		}
		if sub.Status != StatusTimedOut {
			t.Errorf("%s reports %q, want the parent's timed_out", sub.ID, sub.Status)
		}
	}
}

func TestCleanmgrFailedRunDoesNotClaimItsHandlersCompleted(t *testing.T) {
	withFakeVolumeCachesResult(t, []string{"Setup Log Files"}, "",
		ProcResult{Err: errors.New("exec failed")})

	got := winCleanmgrAction{selectedSlugs: []string{"setup_log_files"}}.Run(context.Background(), Params{})
	if got.Status != StatusFailed {
		t.Fatalf("status = %q, want failed", got.Status)
	}
	if got.SubActions[0].Status != StatusFailed {
		t.Fatalf("sub-action status = %q, want failed", got.SubActions[0].Status)
	}
}

// The fix's payoff: a tree that stopped using CPU and was terminated by the
// watchdog is a COMPLETED cleanup, not an hour-long timeout — cleanmgr does
// its work and then wedges its invisible session-0 progress UI.
func TestCleanmgrIdleStoppedRunCompletesAndSaysWhy(t *testing.T) {
	withFakeVolumeCachesResult(t, []string{"Setup Log Files"}, "",
		ProcResult{IdleStopped: true, Err: errors.New("cleanmgr.exe stopped using CPU for 5m0s and never exited; its process tree was terminated")})

	got := winCleanmgrAction{selectedSlugs: []string{"setup_log_files"}}.Run(context.Background(), Params{})

	if got.Status != StatusCompleted {
		t.Fatalf("status = %q, want completed — the handlers ran; only cleanmgr's UI wedged", got.Status)
	}
	if got.SubActions[0].Status != StatusCompleted {
		t.Fatalf("sub-action status = %q, want completed", got.SubActions[0].Status)
	}
	if got.Error != "" {
		t.Fatalf("Error = %q, want empty on a completed action", got.Error)
	}
	if !strings.Contains(got.OutputTail, "never exits under the SYSTEM service") {
		t.Fatalf("outputTail = %q, want it to explain why the tree had to be terminated", got.OutputTail)
	}
}

// Windows Update cleanup is the one handler that deadlocks BEFORE doing any
// work under the SYSTEM service (3/3 lab runs wedged inside
// DismGetUsedSpaceInternal with nothing freed). It is no longer offered; the
// supported non-interactive equivalent is win_dism_component_cleanup, which
// completed in 7.6 s on the same rig.
func TestCleanmgrNoLongerOffersUpdateCleanup(t *testing.T) {
	withFakeVolumeCaches(t, []string{"Update Cleanup", "Setup Log Files"}, "")

	for _, sub := range (winCleanmgrAction{}).SubActions() {
		if sub.ID == "win_cleanmgr:update_cleanup" {
			t.Fatal("update_cleanup is still offered in the catalogue; it cannot complete in session 0")
		}
	}
	for _, handler := range winCleanmgrHandlers {
		if handler.slug == "update_cleanup" {
			t.Fatal("update_cleanup is still in the offered handler list")
		}
	}
	// The id stays in the shared catalogue so an older selection is still a
	// recognised token rather than a validation error.
	if !IsKnownActionID("win_cleanmgr:update_cleanup") {
		t.Fatal("win_cleanmgr:update_cleanup must remain a KNOWN id for wire compatibility")
	}
}

func TestCleanmgrRefusesARetiredHandlerAndNamesTheReplacement(t *testing.T) {
	written := withFakeVolumeCaches(t, []string{"Update Cleanup", "Setup Log Files"}, "")

	got := winCleanmgrAction{selectedSlugs: []string{"update_cleanup"}}.Run(context.Background(), Params{})

	if got.Status != StatusUnavailable {
		t.Fatalf("status = %q, want unavailable", got.Status)
	}
	if _, ran := written["__cleanmgr_started__"]; ran {
		t.Fatal("cleanmgr must not be started for a retired-only selection — it would wedge for the cap")
	}
	if len(got.SubActions) != 1 || got.SubActions[0].Status != StatusUnavailable {
		t.Fatalf("SubActions = %+v, want the retired handler marked unavailable", got.SubActions)
	}
	if !strings.Contains(got.Error, "win_dism_component_cleanup") {
		t.Fatalf("error = %q, want it to name the replacement action", got.Error)
	}
}

// A mixed selection still runs the handlers that work; only the retired one is
// reported unavailable.
func TestCleanmgrRunsTheLiveHandlersAlongsideARetiredOne(t *testing.T) {
	written := withFakeVolumeCaches(t, []string{"Update Cleanup", "Setup Log Files"}, "")

	got := winCleanmgrAction{selectedSlugs: []string{"update_cleanup", "setup_log_files"}}.Run(context.Background(), Params{})

	if got.Status != StatusCompleted {
		t.Fatalf("status = %q, want completed", got.Status)
	}
	if written["__cleanmgr_started__"] != 1 {
		t.Fatal("cleanmgr must still run for the live part of the selection")
	}
	if written["Update Cleanup"] != 0 {
		t.Fatalf("the retired handler was flagged %d; it must be zeroed like any unselected one", written["Update Cleanup"])
	}
	byID := map[string]string{}
	for _, sub := range got.SubActions {
		byID[sub.ID] = sub.Status
	}
	if byID["win_cleanmgr:update_cleanup"] != StatusUnavailable {
		t.Errorf("update_cleanup = %q, want unavailable", byID["win_cleanmgr:update_cleanup"])
	}
	if byID["win_cleanmgr:setup_log_files"] != StatusCompleted {
		t.Errorf("setup_log_files = %q, want completed", byID["win_cleanmgr:setup_log_files"])
	}
}
