// Package userhelpertask keeps the Windows user-helper logon task
// (\Breeze\AgentUserHelper) registered (#12580).
//
// The MSI registers the task once, at install (scripts/install/
// install-windows.ps1). When it later goes missing the per-user helper no
// longer starts at logon, and nothing brought it back short of a reinstall.
// The agent now checks for it and, when it is missing and the helper
// executable is on disk, registers it again from the installer's own task
// definition (embedded from service/windows, never a copy) and reads it back.
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
	// OutcomeRepaired: the task was missing and was registered and read back.
	OutcomeRepaired Outcome = "repaired"
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
	// Uninstalling reports an uninstall in progress.
	Uninstalling func() bool
	// Schtasks runs schtasks.exe (resolved from the system directory) and
	// returns its output.
	Schtasks func(args ...string) ([]byte, error)
	// TempDir holds the task file schtasks reads. Production uses the
	// agent's SYSTEM-only data directory, never a shared temp directory.
	TempDir string
	Now     func() time.Time
}

// Repairer checks for the task and registers it again when it is missing.
// Its backoff lives in memory: it resets when the agent restarts.
type Repairer struct {
	deps Deps

	mu        sync.Mutex
	repairs   []time.Time
	backedOff bool
}

// New returns a Repairer over deps.
func New(deps Deps) *Repairer { return &Repairer{deps: deps} }

// Check runs one check, repairing the task when it is missing and repair is
// allowed. The error carries detail for the log; it is never reported to the
// server.
func (r *Repairer) Check() (Outcome, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.deps.Uninstalling() {
		return OutcomeUninstalling, nil
	}
	exists, err := r.deps.TaskExists()
	if err != nil {
		return OutcomeCheckFailed, fmt.Errorf("read the task registration: %w", err)
	}
	if exists {
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
	if r.deps.Uninstalling() {
		return OutcomeUninstalling, nil
	}
	// Counted before the write, so a failing registration is bounded too.
	r.repairs = append(r.repairs, now)
	if err := r.register(); err != nil {
		return OutcomeRepairFailed, err
	}
	return OutcomeRepaired, nil
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
// decides whether it starts the helper at logon.
func (r *Repairer) register() error {
	doc := installerDocument()
	file, err := os.CreateTemp(r.deps.TempDir, "breeze-user-helper-task-*.xml")
	if err != nil {
		return fmt.Errorf("create task file: %w", err)
	}
	defer func() { _ = os.Remove(file.Name()) }()
	if _, err := file.Write(encodeTaskXML(doc)); err != nil {
		_ = file.Close()
		return fmt.Errorf("write task file: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close task file: %w", err)
	}
	if _, err := r.deps.Schtasks("/Create", "/TN", TaskName, "/XML", file.Name(), "/F"); err != nil {
		return fmt.Errorf("schtasks /Create: %w", err)
	}
	return r.readBack(doc)
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
