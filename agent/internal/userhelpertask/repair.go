// Package userhelpertask keeps the Windows user-helper logon task
// (\Breeze\AgentUserHelper) registered (#12580).
//
// The MSI registers the task once, at install (scripts/install/
// install-windows.ps1). When it later goes missing the per-user helper no
// longer starts at logon, and nothing brought it back short of a reinstall.
// The agent now checks for it and, when it is missing and the helper
// executable is on disk, registers it again from the installer's own task
// definition (embedded from service/windows, never a copy), reads it back,
// and asks Task Scheduler whether it can run it (see settle).
//
// It never fights a removal in a loop: after MaxRepairs re-registrations
// within RepairWindow it stops until the next agent start, and it never
// registers anything while an uninstall is in progress.
//
// The decisions take every OS boundary as a function, so they are tested on
// any host; repair_windows.go supplies the real ones.
package userhelpertask

import (
	"bytes"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	agentservice "github.com/breeze-rmm/agent/service"
)

// TaskName is the logon task the installer registers
// (selfuninstall.UserHelperTaskName removes the same one).
const TaskName = `\Breeze\AgentUserHelper`

// Backoff: a task that is re-registered and gone again MaxRepairs times
// within RepairWindow is left alone until the agent next starts. The window
// is well over MaxRepairs check intervals, so a task removed after every
// repair trips it instead of being re-created forever.
const (
	MaxRepairs   = 3
	RepairWindow = 24 * time.Hour
)

// Outcome is the closed result of one Check. The values are reported to the
// server, so they are stable.
type Outcome string

const (
	// OutcomePresent: the task is registered; nothing was written.
	OutcomePresent Outcome = "present"
	// OutcomeRepaired: the task was missing and was registered, read back,
	// and Task Scheduler reports it ready to run.
	OutcomeRepaired Outcome = "repaired"
	// OutcomeRepairedPendingReboot: the task was registered and reads back
	// as the installer's, but Task Scheduler cannot run it, even after one
	// clean re-registration. Seen when the task's cache entries were removed
	// from under the service: it runs again after the next reboot. Not a
	// healthy repair, and the checks that follow only probe it again.
	OutcomeRepairedPendingReboot Outcome = "repaired_pending_reboot"
	// OutcomeHelperMissing: the task is missing, and so is the helper
	// executable it would start; nothing was registered.
	OutcomeHelperMissing Outcome = "helper_missing"
	// OutcomeBackedOff: the task is missing again after MaxRepairs repairs
	// within RepairWindow; repair is off until the agent next starts.
	OutcomeBackedOff Outcome = "backed_off"
	// OutcomeUninstalling: an uninstall is in progress; nothing was checked
	// or written.
	OutcomeUninstalling Outcome = "uninstalling"
	// OutcomeCheckFailed: whether the task or the helper exists could not be
	// determined; nothing was written.
	OutcomeCheckFailed Outcome = "check_failed"
	// OutcomeRepairFailed: registering, or reading back, the task failed.
	OutcomeRepairFailed Outcome = "repair_failed"
)

// Deps are the OS boundaries of a Check.
type Deps struct {
	// TaskExists reports whether TaskName is registered. An error means the
	// state is unknown, which is never treated as missing.
	TaskExists func() (bool, error)
	// HelperPresent reports whether the helper executable is on disk. An
	// error means it could not be determined.
	HelperPresent func(path string) (bool, error)
	// Uninstalling reports an uninstall in progress. An error means it
	// could not be determined, which stops the check without a write.
	Uninstalling func() (bool, error)
	// Schtasks runs schtasks.exe (resolved from the system directory) and
	// returns its output.
	Schtasks func(args ...string) ([]byte, error)
	// RunState reports whether Task Scheduler can run TaskName. An error
	// means the probe itself could not run (the service could not be
	// reached), which is never read as "not runnable"; a *StateReadError
	// means the service answered but could not report the task's state,
	// which is.
	RunState func() (RunState, error)
	// TempDir holds the task file schtasks reads. Production uses the
	// agent's SYSTEM-only data directory, never a shared temp directory.
	TempDir string
	Now     func() time.Time
}

// RunState is the task's TASK_STATE as Task Scheduler reports it, or
// StateUnreadable when the service answered but could not report it.
type RunState int

const (
	StateUnreadable RunState = -1
	StateUnknown    RunState = 0 // TASK_STATE_UNKNOWN
	StateDisabled   RunState = 1 // TASK_STATE_DISABLED
	StateQueued     RunState = 2 // TASK_STATE_QUEUED
	StateReady      RunState = 3 // TASK_STATE_READY
	StateRunning    RunState = 4 // TASK_STATE_RUNNING
)

// Runnable: only a state Task Scheduler reports positively.
func (s RunState) Runnable() bool {
	return s == StateQueued || s == StateReady || s == StateRunning
}

// StateReadError: Task Scheduler was reached but could not report the
// task's state. The task is then not runnable, not unknown.
type StateReadError struct{ Err error }

func (e *StateReadError) Error() string { return "read the task's state: " + e.Err.Error() }
func (e *StateReadError) Unwrap() error { return e.Err }

// Repairer checks for the task and registers it again when it is missing.
// Its backoff lives in memory: it resets when the agent restarts.
type Repairer struct {
	deps Deps

	mu sync.Mutex
	// repairs are the registrations that landed within RepairWindow.
	repairs   []time.Time
	backedOff bool
	// unverified: the last registration landed but did not read back as
	// the installer's task. A task that exists is then read back again
	// rather than taken as present.
	unverified bool
	// runnable tracks the last registration until Task Scheduler reports it
	// runnable. While it is not settled, a task that exists is probed again
	// rather than taken as present.
	runnable runnableState
}

type runnableState int

const (
	// runnableSettled: no registration of ours is waiting on the probe.
	runnableSettled runnableState = iota
	// runnableAwaiting: registered, not yet reported runnable; the one
	// clean re-registration is still available.
	runnableAwaiting
	// runnableRetrySpent: the clean re-registration has been used (or
	// attempted); later checks only probe.
	runnableRetrySpent
)

// New returns a Repairer over deps.
func New(deps Deps) *Repairer { return &Repairer{deps: deps} }

// Check runs one check, repairing the task when it is missing and repair is
// allowed. The error carries detail for the log; it is never reported to the
// server.
func (r *Repairer) Check() (Outcome, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if outcome, stop, err := r.uninstallGate(); stop {
		return outcome, err
	}
	exists, err := r.deps.TaskExists()
	if err != nil {
		return OutcomeCheckFailed, fmt.Errorf("read the task registration: %w", err)
	}
	if exists {
		if r.unverified {
			if err := r.readBack(installerDocument()); err != nil {
				return OutcomeRepairFailed, err
			}
			r.unverified = false
		}
		if r.runnable != runnableSettled {
			return r.settle(OutcomePresent)
		}
		return OutcomePresent, nil
	}
	if r.backedOff {
		return OutcomeBackedOff, nil
	}
	present, err := r.deps.HelperPresent(HelperPath())
	if err != nil {
		return OutcomeCheckFailed, fmt.Errorf("check the helper executable: %w", err)
	}
	if !present {
		return OutcomeHelperMissing, nil
	}
	now := r.deps.Now()
	r.pruneRepairs(now)
	if len(r.repairs) >= MaxRepairs {
		r.backedOff = true
		return OutcomeBackedOff, nil
	}
	// An uninstall may have started since the first look: check again right
	// before the write.
	if outcome, stop, err := r.uninstallGate(); stop {
		return outcome, err
	}
	created, err := r.register()
	if created {
		// Only a registration that landed counts toward the backoff; a
		// create that keeps failing is retried on the normal cadence.
		r.repairs = append(r.repairs, now)
		r.unverified = err != nil
		r.runnable = runnableAwaiting
	}
	if err != nil {
		return OutcomeRepairFailed, err
	}
	return r.settle(OutcomeRepaired)
}

// settle asks Task Scheduler whether the task it registered can run. A task
// whose cache entries were removed from under the service can be registered
// again and read back while the service still cannot run it until a reboot
// (lab, #12580). Such a task gets one clean re-registration (delete, then
// create); if that does not help either, it is reported as pending a reboot
// and only probed from then on. runnable is the outcome when the task can run.
// Neither the delete nor the second create counts toward the backoff: the
// whole sequence is the one repair already counted.
func (r *Repairer) settle(runnable Outcome) (Outcome, error) {
	state, err := r.deps.RunState()
	if err != nil && !isStateReadError(err) {
		return OutcomeCheckFailed, fmt.Errorf("ask Task Scheduler whether the task can run: %w", err)
	}
	if err == nil && state.Runnable() {
		r.runnable = runnableSettled
		return runnable, nil
	}
	notRunnable := notRunnableError(state, err)
	if r.runnable != runnableAwaiting {
		return OutcomeRepairedPendingReboot, notRunnable
	}
	// An uninstall may have started since the create: check again before
	// writing.
	if outcome, stop, err := r.uninstallGate(); stop {
		return outcome, err
	}
	// Spent before the writes, so it happens at most once whatever follows.
	r.runnable = runnableRetrySpent
	if _, err := r.deps.Schtasks("/Delete", "/TN", TaskName, "/F"); err != nil {
		// Still registered, still not runnable: nothing more to try.
		return OutcomeRepairedPendingReboot, fmt.Errorf("%w; clean re-registration: schtasks /Delete: %w", notRunnable, err)
	}
	created, err := r.register()
	if !created {
		// The task is normally gone now, and the next check registers it on
		// the normal path, which counts toward the backoff. The pending state
		// stays: if the task is somehow still there it is only probed, never
		// taken as present.
		return OutcomeRepairFailed, fmt.Errorf("clean re-registration after %w: %w", notRunnable, err)
	}
	if err != nil {
		r.unverified = true
		return OutcomeRepairFailed, fmt.Errorf("clean re-registration: %w", err)
	}
	state, err = r.deps.RunState()
	if err != nil && !isStateReadError(err) {
		return OutcomeCheckFailed, fmt.Errorf("ask Task Scheduler whether the re-registered task can run: %w", err)
	}
	if err == nil && state.Runnable() {
		r.runnable = runnableSettled
		return OutcomeRepaired, nil
	}
	return OutcomeRepairedPendingReboot, fmt.Errorf("after a clean re-registration: %w", notRunnableError(state, err))
}

// taskFolderAndLeaf splits TaskName for the Task Scheduler API, which gets a
// task by name from its folder.
func taskFolderAndLeaf() (folder, leaf string) {
	i := strings.LastIndex(TaskName, `\`)
	folder, leaf = TaskName[:i], TaskName[i+1:]
	if folder == "" {
		folder = `\`
	}
	return folder, leaf
}

func isStateReadError(err error) bool {
	var stateErr *StateReadError
	return errors.As(err, &stateErr)
}

func notRunnableError(state RunState, err error) error {
	if err != nil {
		return fmt.Errorf("the task is registered but Task Scheduler cannot run it: %w", err)
	}
	return fmt.Errorf("the task is registered but Task Scheduler cannot run it (state %d)", int(state))
}

// uninstallGate stops a check while an uninstall is in progress, and when it
// cannot be told whether one is: never a write on an unknown state.
func (r *Repairer) uninstallGate() (outcome Outcome, stop bool, err error) {
	uninstalling, err := r.deps.Uninstalling()
	switch {
	case err != nil:
		return OutcomeCheckFailed, true, fmt.Errorf("check for an uninstall in progress: %w", err)
	case uninstalling:
		return OutcomeUninstalling, true, nil
	}
	return "", false, nil
}

// RepairsInWindow is how many repairs count toward the backoff now.
func (r *Repairer) RepairsInWindow() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pruneRepairs(r.deps.Now())
	return len(r.repairs)
}

func (r *Repairer) pruneRepairs(now time.Time) {
	kept := r.repairs[:0]
	for _, at := range r.repairs {
		if now.Sub(at) < RepairWindow {
			kept = append(kept, at)
		}
	}
	r.repairs = kept
}

// register writes the installer's document to a file, registers it with
// schtasks /Create /XML /F, then reads the task back and compares what
// decides whether it starts the helper at logon. created reports whether the
// create itself succeeded.
func (r *Repairer) register() (created bool, err error) {
	doc := installerDocument()
	file, err := os.CreateTemp(r.deps.TempDir, "breeze-user-helper-task-*.xml")
	if err != nil {
		return false, fmt.Errorf("create task file: %w", err)
	}
	defer func() { _ = os.Remove(file.Name()) }()
	if _, err := file.Write(encodeTaskXML(doc)); err != nil {
		_ = file.Close()
		return false, fmt.Errorf("write task file: %w", err)
	}
	if err := file.Close(); err != nil {
		return false, fmt.Errorf("close task file: %w", err)
	}
	if _, err := r.deps.Schtasks("/Create", "/TN", TaskName, "/XML", file.Name(), "/F"); err != nil {
		return false, fmt.Errorf("schtasks /Create: %w", err)
	}
	return true, r.readBack(doc)
}

func (r *Repairer) readBack(doc []byte) error {
	want, err := parseShape(doc)
	if err != nil {
		return fmt.Errorf("parse the installer's task definition: %w", err)
	}
	out, err := r.deps.Schtasks("/Query", "/TN", TaskName, "/XML")
	if err != nil {
		return fmt.Errorf("schtasks /Query after create: %w", err)
	}
	got, err := parseShape(out)
	if err != nil {
		return fmt.Errorf("read back the task: %w", err)
	}
	if got.Command != want.Command || got.Arguments != want.Arguments {
		return errors.New("read back the task: its action differs from the installer's")
	}
	if !strings.EqualFold(got.GroupID, want.GroupID) || !strings.EqualFold(got.RunLevel, want.RunLevel) ||
		got.LogonTrigger != want.LogonTrigger || got.Enabled != want.Enabled {
		return errors.New("read back the task: its principal, trigger or settings differ from the installer's")
	}
	exists, err := r.deps.TaskExists()
	if err != nil {
		return fmt.Errorf("read the task registration after create: %w", err)
	}
	if !exists {
		return errors.New("the task is not registered after create")
	}
	return nil
}

// installerDocument is the task XML exactly as install-windows.ps1 passes it
// to Register-ScheduledTask: Get-Content -Raw drops a UTF-8 BOM, nothing
// else.
func installerDocument() []byte {
	return bytes.TrimPrefix(agentservice.WindowsUserHelperTaskXML, []byte{0xef, 0xbb, 0xbf})
}

// HelperPath is the helper executable the task starts: the <Command> of the
// installer's definition, unquoted. The task is registered only when this
// file exists.
func HelperPath() string {
	shape, err := parseShape(installerDocument())
	if err != nil {
		return ""
	}
	return strings.Trim(shape.Command, `"`)
}

// taskShape is what decides whether the task starts the helper at logon.
type taskShape struct {
	URI, Command, Arguments, GroupID, RunLevel string
	// LogonTrigger: the only trigger is an enabled logon trigger.
	LogonTrigger bool
	// Enabled is the task's own <Settings><Enabled>.
	Enabled bool
}

// parseShape reads a task document in UTF-8 or UTF-16 (schtasks /Query /XML
// output is UTF-16), requiring one principal and one Exec action.
func parseShape(data []byte) (taskShape, error) {
	data, err := decodeTaskXML(data)
	if err != nil {
		return taskShape{}, err
	}
	var document struct {
		XMLName  xml.Name `xml:"Task"`
		URI      string   `xml:"RegistrationInfo>URI"`
		Triggers []struct {
			Items []struct {
				XMLName xml.Name
				Enabled string `xml:"Enabled"`
			} `xml:",any"`
		} `xml:"Triggers"`
		Principals []struct {
			GroupID  string `xml:"GroupId"`
			RunLevel string `xml:"RunLevel"`
		} `xml:"Principals>Principal"`
		Settings struct {
			Enabled string `xml:"Enabled"`
		} `xml:"Settings"`
		Actions []struct {
			Items []struct {
				XMLName   xml.Name
				Command   string `xml:"Command"`
				Arguments string `xml:"Arguments"`
			} `xml:",any"`
		} `xml:"Actions"`
	}
	decoder := xml.NewDecoder(bytes.NewReader(data))
	// The bytes are already UTF-8; the declaration may still say UTF-16.
	decoder.CharsetReader = func(label string, input io.Reader) (io.Reader, error) {
		if strings.EqualFold(label, "UTF-16") || strings.EqualFold(label, "UTF-8") {
			return input, nil
		}
		return nil, fmt.Errorf("unsupported task XML encoding %q", label)
	}
	if err := decoder.Decode(&document); err != nil {
		return taskShape{}, fmt.Errorf("parse task XML: %w", err)
	}
	if len(document.Actions) != 1 || len(document.Actions[0].Items) != 1 ||
		document.Actions[0].Items[0].XMLName.Local != "Exec" {
		return taskShape{}, errors.New("task must contain exactly one Exec action")
	}
	if len(document.Principals) != 1 {
		return taskShape{}, errors.New("task must contain exactly one principal")
	}
	// Task Scheduler reads an absent <Enabled> as true.
	enabled := func(v string) bool {
		v = strings.TrimSpace(v)
		return v == "" || strings.EqualFold(v, "true")
	}
	action := document.Actions[0].Items[0]
	// An absent <RunLevel> is LeastPrivilege.
	runLevel := strings.TrimSpace(document.Principals[0].RunLevel)
	if runLevel == "" {
		runLevel = "LeastPrivilege"
	}
	shape := taskShape{
		URI:       strings.TrimSpace(document.URI),
		Command:   strings.TrimSpace(action.Command),
		Arguments: strings.TrimSpace(action.Arguments),
		GroupID:   strings.TrimSpace(document.Principals[0].GroupID),
		RunLevel:  runLevel,
		Enabled:   enabled(document.Settings.Enabled),
	}
	if len(document.Triggers) == 1 && len(document.Triggers[0].Items) == 1 {
		trigger := document.Triggers[0].Items[0]
		shape.LogonTrigger = trigger.XMLName.Local == "LogonTrigger" && enabled(trigger.Enabled)
	}
	return shape, nil
}

// encodeTaskXML is the encoding schtasks /XML reads: UTF-16LE with a BOM
// (the same as internal/isolation's task files).
func encodeTaskXML(document []byte) []byte {
	units := utf16.Encode([]rune(string(document)))
	out := make([]byte, 2+len(units)*2)
	out[0], out[1] = 0xff, 0xfe
	for i, u := range units {
		binary.LittleEndian.PutUint16(out[2+i*2:], u)
	}
	return out
}

// decodeTaskXML returns a task document as UTF-8, from UTF-16 (either byte
// order, with or without a BOM) or UTF-8.
func decodeTaskXML(data []byte) ([]byte, error) {
	var order binary.ByteOrder
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}):
		order, data = binary.LittleEndian, data[2:]
	case bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		order, data = binary.BigEndian, data[2:]
	case len(data) >= 4 && data[0] == '<' && data[1] == 0:
		order = binary.LittleEndian
	case len(data) >= 4 && data[0] == 0 && data[1] == '<':
		order = binary.BigEndian
	default:
		data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
		if !utf8.Valid(data) {
			return nil, errors.New("task XML is not valid UTF-8")
		}
		return data, nil
	}
	if len(data)%2 != 0 {
		return nil, errors.New("task XML has an incomplete UTF-16 code unit")
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = order.Uint16(data[i*2:])
	}
	return []byte(string(utf16.Decode(units))), nil
}
