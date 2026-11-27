package oemupdates

import (
	"errors"
	"fmt"
	"unicode/utf16"
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
// precedence over the settings key are NOT verified. The reading below fails
// closed:
//   - a policy ScheduleMode that is anything but ManualUpdates refuses
//     (vendor_schedule_policy_not_manual);
//   - a policy key that exists, with no ScheduleMode of exactly ManualUpdates
//     at a path this knows, refuses (vendor_schedule_policy_unknown): the real
//     layout may hold a schedule this does not read, such as one that forces
//     automatic updates;
//   - a policy ManualUpdates never stands in for the settings value; both must
//     read manual.
// This trades refusing some policy-managed devices for never running beside a
// second scheduler. A policy key that does not exist changes nothing.
//
// The value is compared as stored: only the single terminating NUL of a
// REG_SZ is dropped, so "ManualUpdates\x00Auto" or "ManualUpdates " is not
// manual (decodeRegSZ).

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
	codeSchedulePolicyUnknown   = "vendor_schedule_policy_unknown"
	// codeToolNotInstalled: dcu-cli.exe is not on the device. Breeze does not
	// install it, because a fresh install schedules its own updates.
	codeToolNotInstalled = "vendor_tool_not_installed"
)

// regRead is one registry value as read: whether its key and the value exist,
// and its text when the value is a REG_SZ.
type regRead struct {
	KeyExists   bool
	ValueExists bool
	// String is set only for a REG_SZ value; any other type leaves it false.
	String bool
	// Value is the whole REG_SZ as stored (decodeRegSZ), embedded NULs included.
	Value string
}

// maxRegSZBytes bounds the read. ManualUpdates is 28 bytes with its NUL; a
// longer value cannot be a mode name and is reported as a read error.
const maxRegSZBytes = 512

// decodeRegSZ decodes a REG_SZ's raw bytes (UTF-16LE). Exactly one terminating
// NUL is dropped; everything else is kept, embedded NULs included, so
// "ManualUpdates\x00Auto" never compares equal to ManualUpdates (a string
// conversion that stops at the first NUL would make it). An odd byte count is
// not a REG_SZ string and reports false.
func decodeRegSZ(raw []byte) (string, bool) {
	if len(raw)%2 != 0 {
		return "", false
	}
	u := make([]uint16, len(raw)/2)
	for i := range u {
		u[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	if n := len(u); n > 0 && u[n-1] == 0 {
		u = u[:n-1]
	}
	return string(utf16.Decode(u)), true
}

// shownMode is a mode as it is logged and reported: quoted with every control
// character and non-ASCII rune escaped, and its stored length, so a refused
// "ManualUpdates " or "ManualUpdates\x00Auto" cannot look like the passing
// value. Bounded for the log.
func shownMode(s string) string {
	shown := s
	if len(shown) > 2*maxVersionLen {
		shown = shown[:2*maxVersionLen]
	}
	return fmt.Sprintf("%+q (%d bytes)", shown, len(s))
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
	// Note is a detail for the log, such as a policy key in a layout this does
	// not recognise.
	Note string
	// PolicyUnknown: the policy key exists but holds no ScheduleMode of exactly
	// ManualUpdates at a path this knows.
	PolicyUnknown bool
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
	case m.PolicyUnknown:
		return codeSchedulePolicyUnknown
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
	// verified. Opening the policy key tells whether any policy is present: a
	// subkey cannot exist without it.
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
	if policyKeyExists && !policyManual {
		// Fail closed: the real layout may set a schedule this does not read.
		return dellScheduleMode{Source: scheduleSourcePolicy, PolicyUnknown: true,
			Note: "policy key present, layout not recognised: no ScheduleMode of ManualUpdates where Breeze looks"}
	}
	m := dellScheduleMode{Source: scheduleSourceSettings}
	if policyManual {
		m.Note = "policy ScheduleMode is ManualUpdates; its precedence is not verified, the settings value decides"
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

// CheckToolConfig refuses unless the tool is installed and in manual-updates
// mode. It only stats files and reads the registry: it spawns nothing and
// writes nothing.
func (l *dellLane) CheckToolConfig() (Outcome, error) {
	// Presence first, by file stat (the same check the availability gate
	// uses), so a device without the tool is told to install it rather than to
	// change a schedule it does not have yet.
	if _, ok := l.toolPath(); !ok {
		log.Warn("Dell Command | Update is not installed; the vendor update run is refused and Breeze does not install it, because a new install schedules its own updates",
			"errorCode", codeToolNotInstalled)
		return OutcomeToolUnavailable, runErr(codeToolNotInstalled, errors.New(`Dell Command | Update is not installed under either Program Files\Dell\CommandUpdate`))
	}
	m := readDellScheduleMode(l.host.registry)
	if m.Manual() {
		if m.Note != "" {
			log.Info("Dell Command | Update is in manual-updates mode", "note", m.Note)
		}
		return "", nil
	}
	code := m.refusalCode()
	if m.Err != nil {
		log.Warn("could not read Dell Command | Update's schedule mode; the vendor update run is refused and the tool is not started",
			"errorCode", code, "source", m.Source, "error", m.Err.Error(), "note", m.Note)
		return OutcomeToolUnavailable, runErr(code, m.Err)
	}
	if m.PolicyUnknown {
		log.Warn("a Dell Command | Update policy is present in a layout Breeze does not recognise; the vendor update run is refused and the tool is not started",
			"errorCode", code, "policyKey", `HKLM\`+dellPolicyKey, "note", m.Note)
		return OutcomeToolUnavailable, runErr(code, fmt.Errorf(`policy key HKLM\%s is present with no ScheduleMode of %q where Breeze looks`, dellPolicyKey, dellManualUpdates))
	}
	mode := shownMode(m.Mode)
	log.Warn("Dell Command | Update is not in manual-updates mode; the vendor update run is refused and the tool is not started",
		"errorCode", code, "source", m.Source, "state", m.State.String(), "mode", mode, "note", m.Note)
	return OutcomeToolUnavailable, runErr(code, fmt.Errorf("%s ScheduleMode is %s %s, want %q", m.Source, m.State, mode, dellManualUpdates))
}
