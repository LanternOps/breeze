package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// HP BIOS path (spec §4.5, Decision 7): CMSL's Get-HPBIOSUpdates, because HP's guide
// for HPIA does not mention BitLocker. It is inert in this wave: the bios gate stays
// closed until leg H4 passes and #5515 ships CMSL. This lane only ever detects an
// installed CMSL. It never installs one, because that would fork the EULA consent
// #5511 owns.
//
// UNCONFIRMED until W14: every flag below, the module layout, what -Check returns,
// and whether -Flash reboots by itself (testdata/hp/README.md).

const (
	hpCmslModule     = "HPCMSL"
	hpFirmwareModule = "HP.Firmware"

	hpBiosFlashCommand = "Get-HPBIOSUpdates -Flash -Yes -BitLocker suspend"
	hpBiosItemTitle    = "HP BIOS update (applies at the next reboot)"
)

// The script's own exit codes, so what PowerShell reports needs no reading of tool
// output. Anything else, including PowerShell's own 1, may have reached the flash.
const (
	hpBiosExitFlashError = 1
	hpBiosExitNoFlash    = 2
	hpBiosExitUpToDate   = 256
	hpBiosExitStaged     = 3010
)

// hpScriptSafePath keeps a path inside the script's single quotes. PowerShell also
// closes a string on a curly quote, so this names what is allowed, not what is not.
var hpScriptSafePath = regexp.MustCompile(`^[A-Za-z]:\\[A-Za-z0-9 ._()\\-]+$`)

type hpBiosState int

const (
	hpBiosNotAsked hpBiosState = iota
	hpBiosSkipped
	hpBiosUpToDate
	hpBiosStaged
	hpBiosNoFlash
	hpBiosUncertain
)

type hpBiosStep struct {
	state hpBiosState
	code  string
	// exit is nil when PowerShell gave no exit code, or never ran.
	exit *int64
}

// flashMayHaveStarted is what decides a reboot is owed.
func (s hpBiosStep) flashMayHaveStarted() bool {
	return s.state == hpBiosStaged || s.state == hpBiosUncertain
}

func hpWinJoin(base string, parts ...string) string {
	return strings.TrimRight(base, `\`) + `\` + strings.Join(parts, `\`)
}

// detectCMSL looks for the module directory under Program Files. It is quiet and
// spawns nothing: a machine without CMSL is normal. The answer is where the modules
// are, not that they can be trusted, which runBIOS checks fresh.
func (l *hpLane) detectCMSL() ToolState {
	base := l.host.programFiles()
	if base == "" {
		return ToolState{}
	}
	modules := hpWinJoin(base, "WindowsPowerShell", "Modules")
	if !l.host.dirExists(hpWinJoin(modules, hpCmslModule)) {
		return ToolState{}
	}
	return ToolState{Present: true, Path: modules}
}

// hpModuleFile returns name inside the module's highest version directory.
func (l *hpLane) hpModuleFile(modules, module, name string) (string, error) {
	dir := hpWinJoin(modules, module)
	best := ""
	for _, v := range l.host.listDir(dir) {
		if _, err := parseVersion(v); err != nil {
			continue
		}
		if best == "" || versionAtLeast(v, best) {
			best = v
		}
	}
	if best == "" {
		return "", fmt.Errorf("module %s has no version directory", module)
	}
	path := hpWinJoin(dir, best, name)
	if !hpScriptSafePath.MatchString(path) {
		return "", fmt.Errorf("module path %q is not safe in a script", path)
	}
	return path, nil
}

// hpVerifiedCMSL resolves the module and checks its signature. HP.Firmware holds
// Get-HPBIOSUpdates, and HPCMSL is what gets imported.
func (l *hpLane) hpVerifiedCMSL(modules string) (manifest string, err error) {
	manifest, err = l.hpModuleFile(modules, hpCmslModule, hpCmslModule+".psd1")
	if err != nil {
		return "", err
	}
	firmware, err := l.hpModuleFile(modules, hpFirmwareModule, hpFirmwareModule+".psm1")
	if err != nil {
		return "", err
	}
	for _, path := range []string{manifest, firmware} {
		if err := verifyPublisher(l.host.verifier, path, l.allow); err != nil {
			return "", err
		}
	}
	return manifest, nil
}

// hpBiosScript imports by the verified path, so a module of the same name elsewhere
// on the search path cannot answer instead.
func hpBiosScript(manifest string) string {
	return fmt.Sprintf(
		"$ErrorActionPreference = 'Stop'; "+
			"try { Import-Module -Name '%s' -Force; $current = Get-HPBIOSUpdates -Check } catch { exit %d }; "+
			"if ($current) { exit %d }; "+
			"try { %s } catch { exit %d }; "+
			"exit %d",
		manifest, hpBiosExitNoFlash, hpBiosExitUpToDate, hpBiosFlashCommand, hpBiosExitFlashError, hpBiosExitStaged)
}

// runBIOS is the flash, behind the gates the runner already applied (a reboot Breeze
// controls, power, a current recovery key) and inside its flash guard section.
func (l *hpLane) runBIOS(ctx context.Context, plan FilterPlan, ex Exec) hpBiosStep {
	state := l.cmsl.Get()
	if !state.Present {
		return hpBiosStep{state: hpBiosSkipped, code: "hp_cmsl_absent"}
	}
	// Get-HPBIOSUpdates installs the latest and takes no list, so a block on a BIOS
	// SoftPaq could not be honoured. Which BIOS it would be is not known beforehand.
	if len(plan.BlockedIDs) > 0 {
		return hpBiosStep{state: hpBiosSkipped, code: "bios_blocklist_unenforceable"}
	}
	powershell := l.host.powershell()
	manifest, err := l.hpVerifiedCMSL(state.Path)
	if err == nil && powershell == "" {
		err = errors.New("no PowerShell path")
	}
	if err != nil {
		l.cmsl.Invalidate()
		log.Warn("HP BIOS path not run: CMSL could not be verified", "error", err.Error())
		// A bad signature reads differently from an unexpected layout: one may be
		// tampering, the other a CMSL version this lane has not seen.
		code := "hp_cmsl_unverified"
		if c := errorCodeOf(err); c != "" {
			code = "hp_cmsl_" + c
		}
		return hpBiosStep{state: hpBiosSkipped, code: code}
	}
	// Before the flash: a process that dies in it must still leave the reboot owed.
	if err := l.writeRebootOwed(); err != nil {
		log.Warn("HP BIOS path not run: the reboot it needs could not be recorded", "error", err.Error())
		return hpBiosStep{state: hpBiosSkipped, code: "bios_record_unwritable"}
	}
	// powershell.exe is catalog-signed by Windows and comes from System32 by full
	// path, as in bitlockerguard. RemoteSigned because SYSTEM's default policy on a
	// client refuses every script, which would refuse the module too.
	out, err := ex.Run(ctx, ExecSpec{Path: powershell, Args: []string{
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-Command", hpBiosScript(manifest),
	}})
	if err != nil {
		log.Warn("HP BIOS path ended without an answer", "error", err.Error())
		return hpBiosStep{state: hpBiosUncertain, code: "bios_flash_uncertain"}
	}
	step := hpBiosStep{exit: int64Ptr(out.ExitCode)}
	switch out.ExitCode {
	case hpBiosExitStaged:
		step.state = hpBiosStaged
	case hpBiosExitUpToDate:
		step.state = hpBiosUpToDate
	case hpBiosExitNoFlash:
		step.state, step.code = hpBiosNoFlash, "bios_check_failed"
	default:
		step.state, step.code = hpBiosUncertain, "bios_flash_uncertain"
	}
	if !step.flashMayHaveStarted() {
		if err := l.host.store.Remove(hpRebootOwedFile); err != nil {
			log.Warn("could not clear the HP reboot record of a run that did not flash", "error", err.Error())
		}
	}
	return step
}

// hpBiosOnly is the result of a run that asked for nothing but BIOS.
func hpBiosOnly(res RunResult, step hpBiosStep) RunResult {
	res.Outcome = OutcomeNoUpdates
	switch step.state {
	case hpBiosSkipped:
		// Nothing ran. Not "failed": the runner keeps a pending verification for a
		// failed run, which could later raise an alert against nothing.
		res.Outcome = OutcomeRetryLater
		if strings.HasPrefix(step.code, "hp_cmsl_") {
			res.Outcome = OutcomeToolUnavailable
		}
	case hpBiosNoFlash:
		// Nothing flashed, so the same reason as a skip.
		res.Outcome = OutcomeRetryLater
	case hpBiosStaged:
		res.Outcome = OutcomeSuccessRebootRequired
	case hpBiosUncertain:
		res.Outcome = OutcomeFailed
	}
	res.RawExitCode = step.exit
	return hpBiosNotes(res, step)
}

// hpMergeBios lays the BIOS step over what HPIA reported.
func hpMergeBios(res RunResult, step hpBiosStep) RunResult {
	clean := res.Outcome == OutcomeSuccess || res.Outcome == OutcomeSuccessRebootRequired
	none := res.Outcome == OutcomeNoUpdates
	switch step.state {
	case hpBiosSkipped:
		if res.ErrorCode == nil || *res.ErrorCode == "report_unavailable" {
			res.ErrorCode = strPtr(step.code)
		}
		return hpBiosNotes(res, hpBiosStep{state: hpBiosSkipped})
	case hpBiosStaged:
		switch {
		case clean || none:
			res.Outcome = OutcomeSuccessRebootRequired
		case res.Outcome == OutcomeNotSupported:
			// not_supported is sticky at the API and drops the pending verification,
			// and this run did flash.
			res.Outcome, res.ErrorCode = OutcomePartial, strPtr("hpia_not_supported")
		case res.Outcome == OutcomeFailed:
			res.Outcome = OutcomePartial
		}
	case hpBiosNoFlash:
		switch {
		case clean:
			res.Outcome = OutcomePartial
		case none:
			// Nothing ran at all, so not "failed": see hpBiosOnly.
			res.Outcome = OutcomeRetryLater
		}
		if res.ErrorCode == nil {
			res.ErrorCode = strPtr(step.code)
		}
		return res
	case hpBiosUncertain:
		switch {
		case clean, res.Outcome == OutcomeNotSupported:
			res.Outcome = OutcomePartial
		case none:
			res.Outcome = OutcomeFailed
		}
		res.ErrorCode = strPtr(step.code)
		step.code = ""
	}
	return hpBiosNotes(res, step)
}

// hpBiosNotes adds what the step says whatever else ran: its skip, its item, its
// reboot and its code.
func hpBiosNotes(res RunResult, step hpBiosStep) RunResult {
	switch step.state {
	case hpBiosSkipped:
		res.SkippedCategories = append(res.SkippedCategories, SkippedCategory{Category: CategoryBIOS, Reason: SkipGate})
	case hpBiosStaged:
		res.Items = append(res.Items, Item{Title: hpBiosItemTitle, Category: CategoryBIOS, Result: ItemInstalled})
		res.RebootRequired = true
	case hpBiosUncertain:
		res.Items = append(res.Items, Item{Title: hpBiosItemTitle, Category: CategoryBIOS, Result: ItemFailed})
		res.RebootRequired = true
	}
	if step.code != "" && res.ErrorCode == nil {
		res.ErrorCode = strPtr(step.code)
	}
	return res
}
