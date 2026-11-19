package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
	"github.com/breeze-rmm/agent/internal/patching"
)

// Surface lane (spec §5). There is no vendor tool: updates come through the
// Windows Update API, so this lane installs no software and has no download path.
//
// UNCONFIRMED until the Surface lab wave (W12): how Surface updates identify
// themselves, how many reboots a capsule takes, and how the search behaves under
// ExcludeWUDriversInQualityUpdate. Both gates stay closed until then.
//
// Firmware cannot be rolled back, and capsules are refused unless BitLocker is
// bound to PCR 7 (vendor doc).

const (
	// surfaceRebootCount is what Surface suspends BitLocker for. Microsoft's
	// documents disagree on how many reboots a capsule takes. Leg S4 counts them.
	surfaceRebootCount = bitlockerguard.MinRebootCount

	firmwareIrreversibleNote = " (firmware cannot be rolled back)"
	defaultFirmwareTitle     = "Surface firmware update"
	// surfaceIdentityUnread marks a failed SMBIOS read in the gate's answer, which
	// has no field for it. It must not read as "not a Surface": not_supported is
	// sticky at the API.
	surfaceIdentityUnread = "smbios-unreadable"
)

// surfaceCategoryOrder fixes the plan's order so Filter stays stable.
var surfaceCategoryOrder = []string{CategoryBIOS, CategoryFirmware, CategoryDriver, CategoryApplication}

var (
	surfaceMaker = regexp.MustCompile(`(?i)^microsoft corporation$`)
	// A Surface model name starts with the word. `Virtual Machine` does not.
	surfaceProduct = regexp.MustCompile(`(?i)^surface\s`)
)

// isSurfaceIdentity is the API's rule (applicability.ts), checked again here:
// the whole trimmed string, because a near-miss must not authorize a flash.
func isSurfaceIdentity(maker, model string) bool {
	return surfaceMaker.MatchString(strings.TrimSpace(maker)) && surfaceProduct.MatchString(strings.TrimSpace(model))
}

// surfaceHost is how the lane looks at and changes the machine.
type surfaceHost struct {
	// identity reads SMBIOS. It must not spawn a process.
	identity func() (maker, model string, err error)
	// updatesDisabled reports the Windows Update service disabled. No spawn.
	updatesDisabled func() bool
	search          func(ctx context.Context) ([]patching.DriverUpdate, error)
	install         func(ctx context.Context, ids []string) []patching.DriverInstallOutcome
	rebootPending   func() (bool, error)
	power           func() (PowerStatus, error)
	guard           bitlockerguard.Deps
}

type surfaceLane struct {
	host surfaceHost
	gate *ToolGate
}

var _ ToolFreeLane = (*surfaceLane)(nil)

func (l *surfaceLane) toolFree() {}

func newSurfaceLane(host surfaceHost) *surfaceLane {
	l := &surfaceLane{host: host}
	l.gate = NewToolGate("surface", l.detect)
	return l
}

func (l *surfaceLane) ID() string           { return LaneSurface }
func (l *surfaceLane) Gate() *ToolGate      { return l.gate }
func (l *surfaceLane) Allow() LaneAllowlist { return LaneAllowlist{} }
func (l *surfaceLane) Range() VersionRange  { return VersionRange{} }
func (l *surfaceLane) SkippedForNoReboot() []string {
	return []string{CategoryBIOS, CategoryFirmware}
}

// ToolVersion has nothing to read: EnsureTool never reaches it for this lane.
func (l *surfaceLane) ToolVersion(string) (string, error) { return "", nil }

// FlashesOutsideFilter is true until W12 confirms the DriverClass strings: an
// update that looks like a driver could write firmware, so every run holds the
// flash guard and a reboot waits for it.
func (l *surfaceLane) FlashesOutsideFilter() bool { return true }

// InstallArgs and Prerequisite have nothing to install.
func (l *surfaceLane) InstallArgs(string, string) []string { return nil }

func (l *surfaceLane) Prerequisite(string) (PrerequisiteHandler, bool) {
	return PrerequisiteHandler{}, false
}

// detect answers "is this a Surface". A read that fails is not cached by Ready.
func (l *surfaceLane) detect() ToolState {
	maker, model, err := l.host.identity()
	if err != nil {
		log.Debug("SMBIOS identity unreadable", "error", err.Error())
		return ToolState{Present: true, Path: surfaceIdentityUnread}
	}
	return ToolState{Present: isSurfaceIdentity(maker, model)}
}

// Ready implements ToolFreeLane. It answers without a process, and quietly:
// a machine that is not a Surface is normal.
func (l *surfaceLane) Ready() (ToolState, Outcome, error) {
	state := l.gate.Get()
	if state.Path == surfaceIdentityUnread {
		l.gate.Invalidate()
		return ToolState{}, OutcomeToolUnavailable, runErr("smbios_unreadable", errors.New("SMBIOS identity could not be read"))
	}
	if !state.Present {
		return ToolState{}, OutcomeNotSupported, runErr("not_surface", errors.New("this machine is not a Surface"))
	}
	if l.host.updatesDisabled != nil && l.host.updatesDisabled() {
		return ToolState{}, OutcomeToolUnavailable, runErr("windows_update_disabled", errors.New("the Windows Update service is disabled"))
	}
	return ToolState{}, "", nil
}

// Filter keeps every requested category and leaves the reading of them to Apply.
// bios and application stay in the plan so Apply can report them as skipped; the
// runner re-filters what its gates kept, so a plan cannot carry a list of dropped
// categories. Blocked ids are only ever compared, so any string is safe, and a
// policy's ids for another vendor do no harm.
func (l *surfaceLane) Filter(cats []string, blocked []string) (FilterPlan, error) {
	want := map[string]bool{}
	for _, c := range cats {
		if !IsCategory(c) {
			return FilterPlan{}, runErr("invalid_filter", fmt.Errorf("unknown category %q", c))
		}
		want[c] = true
	}
	var ordered []string
	for _, c := range surfaceCategoryOrder {
		if want[c] {
			ordered = append(ordered, c)
		}
	}
	return FilterPlan{Categories: ordered, BlockedIDs: append([]string(nil), blocked...)}, nil
}

// surfaceRun is one Apply's working state.
type surfaceRun struct {
	items     []Item
	installed int
	failed    int
	reboot    bool
	skips     []SkippedCategory
	// code is the errorCode that says why firmware did not go, or what went wrong.
	code string
	// blockedOnPower is set when power is why the firmware did not go.
	blockedOnPower bool
	// firmwareBlocked is set when a firmware gate refused.
	firmwareBlocked bool
	// uncertain is set when an install ended in a way that does not show whether
	// a capsule was staged.
	uncertain bool
}

// Apply runs: anything owed first, search, drivers, then firmware behind its own
// gates. Drivers go first so the volume is suspended for as short a time as
// possible. It uses no Exec, because nothing here is a vendor process.
func (l *surfaceLane) Apply(ctx context.Context, _ ToolState, plan FilterPlan, _ Exec) (RunResult, error) {
	res := RunResult{Lane: LaneSurface, Takeover: TakeoverNotAttempted}
	want := map[string]bool{}
	for _, c := range plan.Categories {
		want[c] = true
	}

	// W03 relies on this: a clean result means an earlier flash's reboot happened.
	pending, err := l.host.rebootPending()
	if err != nil {
		res.Outcome, res.ErrorCode = OutcomeBlockedRebootPending, strPtr("reboot_state_unreadable")
		return res, runErr("reboot_state_unreadable", err)
	}
	if pending {
		res.Outcome, res.RebootRequired = OutcomeBlockedRebootPending, true
		return res, nil
	}
	// The registry flag is not guaranteed after a capsule, since the lane stages on
	// its own judgment. Anything but this answer reads to the API as "the device
	// came back", which disarms its monitor and clears the reboot clock.
	if owed, err := bitlockerguard.RebootOwed(l.host.guard); err == nil && owed {
		res.Outcome, res.RebootRequired, res.ErrorCode = OutcomeBlockedRebootPending, true, strPtr("bitlocker_guard_open")
		return res, nil
	}
	// An open record is a suspension still settling. An unreadable one is treated
	// the same: nothing new starts until it is understood.
	if held, err := bitlockerguard.Held(l.host.guard); held || err != nil {
		res.Outcome, res.ErrorCode = OutcomeRetryLater, strPtr("bitlocker_guard_open")
		if err != nil {
			return res, runErr("bitlocker_guard_open", err)
		}
		return res, nil
	}

	found, err := l.host.search(ctx)
	if err != nil {
		l.gate.Invalidate()
		res.Outcome, res.ErrorCode = OutcomeRetryLater, strPtr("wu_search_failed")
		return res, runErr("wu_search_failed", err)
	}
	selected := patching.SelectSurfaceDriverUpdates(found, plan.BlockedIDs)

	run := &surfaceRun{}
	for _, c := range []string{CategoryBIOS, CategoryApplication} {
		// Surface updates are only drivers or firmware; UEFI arrives as firmware.
		if want[c] {
			run.skips = append(run.skips, SkippedCategory{Category: c, Reason: SkipGate})
		}
	}
	if want[CategoryDriver] {
		l.installDrivers(ctx, selected.Drivers, run)
	}
	if want[CategoryFirmware] && len(selected.Firmware) > 0 {
		l.installFirmware(ctx, selected.Firmware, run)
	}
	return run.result(res), nil
}

func (l *surfaceLane) installDrivers(ctx context.Context, updates []patching.DriverUpdate, run *surfaceRun) {
	if len(updates) == 0 {
		return
	}
	for _, o := range l.host.install(ctx, updateIDs(updates)) {
		u := findUpdate(updates, o.UpdateID)
		if o.Err != nil {
			log.Warn("Surface driver install failed", "updateId", o.UpdateID, "error", o.Err.Error())
		}
		run.note(u, CategoryDriver, o, sanitizeToolText(u.Title, maxItemTitle))
	}
}

// installFirmware is every step between "a capsule is pending" and "it is staged".
// Each gate that refuses leaves the volume as it found it.
func (l *surfaceLane) installFirmware(ctx context.Context, updates []patching.DriverUpdate, run *surfaceRun) {
	refuse := func(reason, code string, err error) {
		run.skips = append(run.skips, SkippedCategory{Category: CategoryFirmware, Reason: reason})
		run.firmwareBlocked = true
		if code != "" {
			run.code = code
		}
		if err != nil {
			log.Warn("Surface firmware not installed", "errorCode", code, "error", err.Error())
		}
	}

	// The runner checked this before the driver installs, which can take minutes.
	status, err := l.host.power()
	if err != nil {
		run.blockedOnPower = true
		refuse(SkipPower, "power_unreadable", err)
		return
	}
	if ok, why := CheckFlashPower(status); !ok {
		log.Info("Surface firmware skipped", "reason", why)
		run.blockedOnPower = true
		refuse(SkipPower, "", nil)
		return
	}

	bound, err := bitlockerguard.Preflight(ctx, l.host.guard)
	switch {
	case errors.Is(err, bitlockerguard.ErrBitLockerOff):
		// Not encrypted: no binding to read and nothing to suspend.
	case errors.Is(err, bitlockerguard.ErrAlreadySuspended):
		// Not ours, count unknown: it could run out mid-flash.
		refuse(SkipGate, "bitlocker_already_suspended", err)
		return
	case errors.Is(err, bitlockerguard.ErrStateUnknown):
		refuse(SkipGate, "bitlocker_unreadable", err)
		return
	case err != nil:
		refuse(SkipGate, "pcr7_unknown", err)
		return
	case !bound:
		refuse(SkipGate, "pcr7_not_bound", nil)
		return
	}

	token, err := bitlockerguard.Suspend(ctx, surfaceRebootCount, l.host.guard)
	if err != nil {
		refuse(SkipGate, "bitlocker_suspend_failed", err)
		return
	}
	if err := bitlockerguard.MarkInstalling(token, l.host.guard); err != nil {
		refuse(SkipGate, "bitlocker_record_failed", err)
		l.resume(ctx, token, run)
		return
	}

	outcomes := l.host.install(ctx, updateIDs(updates))
	// A short answer says nothing about the updates it left out.
	run.uncertain = len(outcomes) != len(updates)
	staged := false
	for _, o := range outcomes {
		u := findUpdate(updates, o.UpdateID)
		if o.Err != nil {
			log.Warn("Surface firmware install failed", "updateId", o.UpdateID, "installStarted", o.InstallStarted, "error", o.Err.Error())
		}
		run.note(u, CategoryFirmware, o, firmwareTitle(u.Title, o))
		switch {
		case o.Err == nil && !o.Result.Skipped:
			staged = true
		case o.Err != nil && o.InstallStarted:
			run.uncertain = true
		}
	}
	if run.uncertain {
		run.code = "firmware_install_uncertain"
	}
	if staged || run.uncertain {
		// A capsule applies during the reboot, whatever WUA reported. The volume
		// stays suspended for it, and the guard brings protection back after. An
		// uncertain install is treated the same: a needless overnight reboot costs
		// far less than a recovery prompt the next morning.
		run.reboot = true
		return
	}
	l.resume(ctx, token, run)
}

// resume puts protection back for a run with nothing staged. On failure the
// record stays and the guard keeps trying.
func (l *surfaceLane) resume(ctx context.Context, token bitlockerguard.Token, run *surfaceRun) {
	if err := bitlockerguard.Resume(ctx, token, l.host.guard); err != nil {
		log.Error("could not resume BitLocker after a firmware run; the guard keeps trying", "error", err.Error())
		run.code = "bitlocker_resume_failed"
	}
}

func (r *surfaceRun) note(u patching.DriverUpdate, category string, o patching.DriverInstallOutcome, title string) {
	result := ItemInstalled
	switch {
	case o.Err != nil:
		result = ItemFailed
		r.failed++
	case o.Result.Skipped:
		result = ItemSkipped
	default:
		r.installed++
		r.reboot = r.reboot || o.Result.RebootRequired
	}
	r.items = append(r.items, Item{Title: title, Category: category, Result: result})
}

// result maps the run to the contract's outcomes.
func (r *surfaceRun) result(res RunResult) RunResult {
	res.Items, res.SkippedCategories, res.RebootRequired = r.items, r.skips, r.reboot
	if r.code != "" {
		res.ErrorCode = strPtr(r.code)
	}
	if r.failed > 0 && res.ErrorCode == nil {
		res.ErrorCode = strPtr("install_failed") // the reason per update is in the agent log
	}
	switch {
	case r.installed > 0 && (r.failed > 0 || r.uncertain):
		res.Outcome = OutcomePartial
	case r.failed > 0 || r.uncertain:
		res.Outcome = OutcomeFailed
	case r.installed > 0 && r.reboot:
		res.Outcome = OutcomeSuccessRebootRequired
	case r.installed > 0:
		res.Outcome = OutcomeSuccess
	case r.blockedOnPower:
		res.Outcome = OutcomeBlockedOnBattery
	case r.firmwareBlocked:
		// Not "failed": nothing was flashed, and the runner keeps a pending
		// verification for a failed run, which could later raise an alert against
		// a run that never touched the volume.
		res.Outcome = OutcomeRetryLater
	default:
		res.Outcome = OutcomeNoUpdates
	}
	return res
}

// firmwareTitle carries the warning in the item a tech reads. The result contract
// has no other free text, and the note must survive the title's length cap.
func firmwareTitle(title string, o patching.DriverInstallOutcome) string {
	if o.Err != nil || o.Result.Skipped {
		return sanitizeToolText(title, maxItemTitle)
	}
	clean := sanitizeToolText(title, maxItemTitle-len([]rune(firmwareIrreversibleNote)))
	if clean == "" {
		clean = defaultFirmwareTitle
	}
	return clean + firmwareIrreversibleNote
}

func updateIDs(updates []patching.DriverUpdate) []string {
	ids := make([]string, 0, len(updates))
	for _, u := range updates {
		ids = append(ids, u.UpdateID)
	}
	return ids
}

func findUpdate(updates []patching.DriverUpdate, id string) patching.DriverUpdate {
	for _, u := range updates {
		if u.UpdateID == id {
			return u
		}
	}
	return patching.DriverUpdate{UpdateID: id}
}
