package oemupdates

import (
	"errors"
	"fmt"
)

// Dell Command | Update's own schedule mode (#12267). The lane requires the
// tool to be in manual-updates mode before it installs, replaces or runs it:
// with the tool's own schedule on, two schedulers would update firmware on one
// machine. The lane never writes the schedule; it only reads it.
//
// Lab captures (DCU 5.7.2, #12267): the mode is one REG_SZ value, ScheduleMode,
// under the settings key below, holding the enum name. The key is absent on a
// fresh install, and after -restoreDefaults the key is left with no values; the default behaves as
// automatic (every 3 days, per the CLI help). LocalSystem can read it and the
// read writes nothing. The mode is never read through the tool's CLI: any call
// to it, even /version, wakes the vendor service, which rewrites its scheduler
// file.
//
// The policy key is named by the tool's settings assembly as supporting
// ScheduleMode, but it did not exist on the lab unit. Its layout and its
// precedence over the settings key are NOT verified. The reading below is
// conservative: a policy ScheduleMode that is anything but ManualUpdates refuses,
// a policy ManualUpdates never stands in for the settings value, and a policy
// key with no ScheduleMode where this looks is reported, not interpreted.

// Registry keys, all under HKLM in the 64-bit view.
const (
	dellScheduleKey       = `SOFTWARE\Dell\UpdateService\Clients\CommandUpdate\Preferences\Settings\Schedule`
	dellPolicyKey         = `SOFTWARE\Policies\Dell\UpdateService\Clients\CommandUpdate`
	dellPolicyScheduleKey = dellPolicyKey + `\Preferences\Settings\Schedule`
	dellScheduleModeValue = "ScheduleMode"
	dellManualUpdates     = "ManualUpdates"
)

// dellRegistryKeys are the only keys the reader opens.
var dellRegistryKeys = []string{dellScheduleKey, dellPolicyKey, dellPolicyScheduleKey}

// Refusal codes. They travel as the result's errorCode with outcome
// tool_unavailable, because the outcome is a closed enum an older API would
// reject while errorCode is any identifier (packages/shared OEM_TOOL_CONFIG_ERROR_CODES).
const (
	codeScheduleNotManual       = "vendor_schedule_not_manual"
	codeSchedulePolicyNotManual = "vendor_schedule_policy_not_manual"
	codeScheduleUnreadable      = "vendor_schedule_unreadable"
)

// regRead is one registry value as read: whether its key and the value exist,
// and its text when the value is a REG_SZ.
type regRead struct {
	KeyExists   bool
	ValueExists bool
	// String is set only for a REG_SZ value; any other type leaves it false.
	String bool
	Value  string
}

// regReader reads one named value under HKLM in the 64-bit view with query
// rights only. A missing key or value is not an error.
type regReader func(key, name string) (regRead, error)

type scheduleValueState int

const (
	scheduleValueAbsent scheduleValueState = iota
	scheduleValueString
	scheduleValueWrongType
)

func (s scheduleValueState) String() string {
	switch s {
	case scheduleValueString:
		return "string"
	case scheduleValueWrongType:
		return "wrong_type"
	}
	return "absent"
}

// Where the deciding reading came from.
const (
	scheduleSourceSettings = "settings"
	scheduleSourcePolicy   = "policy"
)

// dellScheduleMode is what the registry says about the tool's schedule mode.
type dellScheduleMode struct {
	// Source is the key that decided: the settings key, or the policy key when
	// it set something other than ManualUpdates or could not be read.
	Source string
	State  scheduleValueState
	// Mode is the REG_SZ text as read, untrusted; "" when absent or another type.
	Mode string
	// Note is a detail for the log, such as a policy key that was not interpreted.
	Note string
	// Err is a read failure, never an absent key or value.
	Err error
}

// Manual reports whether the tool is in manual-updates mode: the settings key
// reads exactly ManualUpdates and no policy says otherwise.
func (m dellScheduleMode) Manual() bool {
	return m.Err == nil && m.Source == scheduleSourceSettings && m.State == scheduleValueString && m.Mode == dellManualUpdates
}

// refusalCode is the errorCode for a reading that is not manual; "" for manual.
func (m dellScheduleMode) refusalCode() string {
	switch {
	case m.Manual():
		return ""
	case m.Err != nil:
		return codeScheduleUnreadable
	case m.Source == scheduleSourcePolicy:
		return codeSchedulePolicyNotManual
	}
	return codeScheduleNotManual
}

var errNoRegistryReader = errors.New("no registry reader")

func stateOf(r regRead) scheduleValueState {
	switch {
	case !r.ValueExists:
		return scheduleValueAbsent
	case r.String:
		return scheduleValueString
	}
	return scheduleValueWrongType
}

// readDellScheduleMode reads the policy key, then the settings key. It never
// guesses: an error is an error, an absent value is absent, and only a REG_SZ
// reading exactly ManualUpdates in the settings key counts as manual.
func readDellScheduleMode(read regReader) dellScheduleMode {
	if read == nil {
		return dellScheduleMode{Source: scheduleSourceSettings, Err: errNoRegistryReader}
	}
	// Policy first. ScheduleMode is looked for directly under the policy key
	// and under the settings-shaped path beneath it; neither layout is
	// verified, and looking in both can only add refusals.
	policyKeyExists, policyManual := false, false
	for _, key := range []string{dellPolicyKey, dellPolicyScheduleKey} {
		r, err := read(key, dellScheduleModeValue)
		if err != nil {
			return dellScheduleMode{Source: scheduleSourcePolicy, Err: fmt.Errorf(`read HKLM\%s: %w`, key, err)}
		}
		policyKeyExists = policyKeyExists || r.KeyExists
		switch st := stateOf(r); {
		case st == scheduleValueAbsent:
			continue
		case st == scheduleValueString && r.Value == dellManualUpdates:
			policyManual = true
		default:
			mode := ""
			if st == scheduleValueString {
				mode = r.Value
			}
			return dellScheduleMode{Source: scheduleSourcePolicy, State: st, Mode: mode}
		}
	}
	m := dellScheduleMode{Source: scheduleSourceSettings}
	switch {
	case policyManual:
		m.Note = "policy ScheduleMode is ManualUpdates; its precedence is not verified, the settings value decides"
	case policyKeyExists:
		m.Note = "policy key present, not interpreted"
	}
	r, err := read(dellScheduleKey, dellScheduleModeValue)
	if err != nil {
		m.Err = fmt.Errorf(`read HKLM\%s: %w`, dellScheduleKey, err)
		return m
	}
	m.State = stateOf(r)
	if m.State == scheduleValueString {
		m.Mode = r.Value
	}
	return m
}

// CheckToolConfig refuses unless the tool is in manual-updates mode. It only
// reads the registry: it spawns nothing and writes nothing.
func (l *dellLane) CheckToolConfig() (Outcome, error) {
	m := readDellScheduleMode(l.host.registry)
	if m.Manual() {
		if m.Note != "" {
			log.Info("Dell Command | Update is in manual-updates mode", "note", m.Note)
		}
		return "", nil
	}
	code := m.refusalCode()
	mode := sanitizeToolText(m.Mode, maxVersionLen)
	if m.Err != nil {
		log.Warn("could not read Dell Command | Update's schedule mode; the vendor update run is refused and the tool is not started",
			"errorCode", code, "source", m.Source, "error", m.Err.Error(), "note", m.Note)
		return OutcomeToolUnavailable, runErr(code, m.Err)
	}
	log.Warn("Dell Command | Update is not in manual-updates mode; the vendor update run is refused and the tool is not started",
		"errorCode", code, "source", m.Source, "state", m.State.String(), "mode", mode, "note", m.Note)
	return OutcomeToolUnavailable, runErr(code, fmt.Errorf("%s ScheduleMode is %s %q, want %q", m.Source, m.State, mode, dellManualUpdates))
}
