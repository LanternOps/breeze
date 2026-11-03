package isolation

import (
	"bytes"
	"encoding/binary"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const recoveryTaskFolder = `\Breeze\`

var recoveryAttemptPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

type recoveryTask struct {
	Name string
	XML  []byte
}

func buildRollbackTask(path, dataDir, attemptID string, at time.Time) (recoveryTask, error) {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return recoveryTask{}, fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	return buildRecoveryTask("IsolationRollback-"+attemptID, path, "rollback-if-uncommitted --data-dir "+quoteWindowsArgument(dataDir)+" --attempt "+attemptID, at, false), nil
}

func buildExpiryTask(path, dataDir string, at time.Time) recoveryTask {
	return buildRecoveryTask("IsolationExpireAt", path, "expire-check --data-dir "+quoteWindowsArgument(dataDir), at, false)
}

func buildPollTask(path, dataDir string, at time.Time) recoveryTask {
	return buildRecoveryTask("IsolationPoll", path, "expire-check --data-dir "+quoteWindowsArgument(dataDir), at, true)
}

func buildRecoveryTask(name, path, arguments string, at time.Time, poll bool) recoveryTask {
	// Task boundaries use whole seconds. Truncation could run an expiry check
	// just before the journal deadline, making the one-shot a permanent no-op.
	if at.Nanosecond() != 0 {
		at = at.Truncate(time.Second).Add(time.Second)
	}
	escape := func(s string) string { var b bytes.Buffer; _ = xml.EscapeText(&b, []byte(s)); return b.String() }
	repetition, boot := "", ""
	// StartWhenAvailable applies to time triggers only when they have an end
	// boundary or repeat infinitely. Keep deadline triggers active for catch-up
	// after arbitrary downtime, while still firing just once. See Microsoft's
	// TaskSettings.StartWhenAvailable remarks; normal cleanup deletes these tasks.
	end := "\n      <EndBoundary>9999-12-31T23:59:59Z</EndBoundary>"
	if poll {
		end = ""
		repetition = "\n      <Repetition>\n        <Interval>PT15M</Interval>\n        <StopAtDurationEnd>false</StopAtDurationEnd>\n      </Repetition>"
		boot = "\n    <BootTrigger>\n      <Enabled>true</Enabled>\n    </BootTrigger>"
	}
	document := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger>%s
      <StartBoundary>%s</StartBoundary>%s
      <Enabled>true</Enabled>
    </TimeTrigger>%s
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>%s</Command>
      <Arguments>%s</Arguments>
    </Exec>
  </Actions>
</Task>
`, repetition, at.UTC().Format(time.RFC3339), end, boot, escape(path), escape(arguments))
	return recoveryTask{Name: recoveryTaskFolder + name, XML: []byte(document)}
}

// quoteWindowsArgument uses CommandLineToArgvW/Go command-line conventions.
// XML escaping is a separate step: XML entities do not quote command arguments.
func quoteWindowsArgument(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\n\r\"") {
		return s
	}
	var b strings.Builder
	b.WriteByte('"')
	slashes := 0
	for _, c := range s {
		if c == '\\' {
			slashes++
			continue
		}
		if c == '"' {
			b.WriteString(strings.Repeat("\\", slashes*2+1))
		} else {
			b.WriteString(strings.Repeat("\\", slashes))
		}
		slashes = 0
		b.WriteRune(c)
	}
	b.WriteString(strings.Repeat("\\", slashes*2))
	b.WriteByte('"')
	return b.String()
}

// encodeTaskXML matches schtasks /XML's UTF-16LE file encoding, including BOM.
func encodeTaskXML(document []byte) []byte {
	units := utf16.Encode([]rune(string(document)))
	out := make([]byte, 2+len(units)*2)
	out[0], out[1] = 0xff, 0xfe
	for i, u := range units {
		binary.LittleEndian.PutUint16(out[2+i*2:], u)
	}
	return out
}

func decodeTaskXML(data []byte) ([]byte, error) {
	var order binary.ByteOrder
	switch {
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}):
		order = binary.LittleEndian
		data = data[2:]
	case bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		order = binary.BigEndian
		data = data[2:]
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
		return nil, errors.New("task XML has incomplete UTF-16 code unit")
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = order.Uint16(data[i*2:])
	}
	for i := 0; i < len(units); i++ {
		u := units[i]
		if u >= 0xd800 && u <= 0xdbff {
			if i+1 == len(units) || units[i+1] < 0xdc00 || units[i+1] > 0xdfff {
				return nil, errors.New("task XML has unpaired UTF-16 surrogate")
			}
			i++
		} else if u >= 0xdc00 && u <= 0xdfff {
			return nil, errors.New("task XML has unpaired UTF-16 surrogate")
		}
	}
	return []byte(string(utf16.Decode(units))), nil
}

// taskShape is everything that decides whether a recovery task will actually
// run the recovery binary: its single Exec action, the SYSTEM principal, the
// enabled flags, catch-up after downtime, and the trigger set. Start
// boundaries are left out: schtasks may re-render them in local time.
type taskShape struct {
	Command, Arguments string
	UserID             string
	Enabled            bool
	StartWhenAvailable bool
	Triggers           []string
}

// parseTaskAction accepts schtasks output in either console encoding. Requiring
// exactly one Exec action prevents a read-back with additional actions passing.
func parseTaskAction(data []byte) (string, string, error) {
	shape, err := parseTaskShape(data)
	if err != nil {
		return "", "", err
	}
	return shape.Command, shape.Arguments, nil
}

type taskTrigger struct {
	XMLName  xml.Name
	Enabled  string `xml:"Enabled"`
	Interval string `xml:"Repetition>Interval"`
}

func parseTaskShape(data []byte) (taskShape, error) {
	data, err := decodeTaskXML(data)
	if err != nil {
		return taskShape{}, err
	}
	var document struct {
		XMLName  xml.Name `xml:"Task"`
		Triggers []struct {
			Items []taskTrigger `xml:",any"`
		} `xml:"Triggers"`
		UserIDs  []string `xml:"Principals>Principal>UserId"`
		Settings struct {
			Enabled            string `xml:"Enabled"`
			StartWhenAvailable string `xml:"StartWhenAvailable"`
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
	decoder.CharsetReader = func(label string, input io.Reader) (io.Reader, error) {
		if strings.EqualFold(label, "UTF-16") || strings.EqualFold(label, "UTF-8") {
			return input, nil
		}
		return nil, fmt.Errorf("unsupported task XML encoding %q", label)
	}
	if err := decoder.Decode(&document); err != nil {
		return taskShape{}, fmt.Errorf("parse task XML: %w", err)
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return taskShape{}, fmt.Errorf("parse trailing task XML: %w", err)
		}
		if text, ok := token.(xml.CharData); !ok || len(bytes.TrimSpace(text)) != 0 {
			return taskShape{}, errors.New("extra content after task XML")
		}
	}
	if len(document.Actions) != 1 || len(document.Actions[0].Items) != 1 {
		return taskShape{}, errors.New("task must contain exactly one action")
	}
	action := document.Actions[0].Items[0]
	if action.XMLName.Local != "Exec" || strings.TrimSpace(action.Command) == "" {
		return taskShape{}, errors.New("task must contain a nonempty Exec command")
	}
	if len(document.UserIDs) != 1 {
		return taskShape{}, errors.New("task must contain exactly one principal")
	}
	// Task Scheduler treats an absent <Enabled> as true and an absent
	// <StartWhenAvailable> as false.
	enabled := func(v string, def bool) bool {
		v = strings.TrimSpace(v)
		if v == "" {
			return def
		}
		return strings.EqualFold(v, "true")
	}
	shape := taskShape{
		Command:            action.Command,
		Arguments:          action.Arguments,
		UserID:             strings.TrimSpace(document.UserIDs[0]),
		Enabled:            enabled(document.Settings.Enabled, true),
		StartWhenAvailable: enabled(document.Settings.StartWhenAvailable, false),
	}
	if len(document.Triggers) != 1 {
		return taskShape{}, errors.New("task must contain exactly one trigger list")
	}
	for _, trigger := range document.Triggers[0].Items {
		shape.Triggers = append(shape.Triggers, fmt.Sprintf("%s|enabled=%t|every=%s",
			trigger.XMLName.Local, enabled(trigger.Enabled, true), strings.TrimSpace(trigger.Interval)))
	}
	sort.Strings(shape.Triggers)
	return shape, nil
}

// windowsScheduler keeps decisions portable so CI tests every error path with
// fake OS boundaries; scheduler_windows.go supplies only the actual adapters.
type windowsScheduler struct {
	dataDir string
	// tempDir holds the transient task XML before schtasks reads it. Production
	// uses the SYSTEM-only agent data directory rather than a shared temp dir.
	tempDir         string
	recoveryPath    func() (string, error)
	run             func(...string) ([]byte, error)
	exists          func(string) bool
	verifySignature func(string) error
	selfTest        func(string) error
	now             func() time.Time
}

var _ RecoveryScheduler = (*windowsScheduler)(nil)

func (s *windowsScheduler) checkedRecoveryPath() (string, error) {
	path, err := s.recoveryPath()
	if err != nil {
		return "", fmt.Errorf("load recovery path: %w", err)
	}
	if strings.TrimSpace(path) == "" {
		return "", errors.New("journal has no recovery path")
	}
	if !s.exists(path) {
		return "", fmt.Errorf("recovery executable does not exist: %s", path)
	}
	if err := s.verifySignature(path); err != nil {
		return "", fmt.Errorf("verify recovery executable: %w", err)
	}
	return path, nil
}

// ArmProvisional registers and reads back the independent rollback deadline.
func (s *windowsScheduler) ArmProvisional(attemptID string, deadline time.Time) error {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	task, err := buildRollbackTask(path, s.dataDir, attemptID, deadline)
	if err != nil {
		return err
	}
	return s.register(task)
}

// ArmExpiry replaces the one-shot expiry task and verifies its recovery action.
func (s *windowsScheduler) ArmExpiry(_ string, _ int, at time.Time) error {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	// One stable task is overwritten on extend. Recovery re-reads the journal,
	// so an already queued old expiry invocation cannot release a newer expiry.
	return s.register(buildExpiryTask(path, s.dataDir, at))
}

// EnsurePoll installs the boot and fifteen-minute backstop, then reads it back.
func (s *windowsScheduler) EnsurePoll() error {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return err
	}
	return s.register(buildPollTask(path, s.dataDir, s.now()))
}

func (s *windowsScheduler) register(task recoveryTask) error {
	file, err := os.CreateTemp(s.tempDir, "breeze-isolation-task-*.xml")
	if err != nil {
		return fmt.Errorf("create task XML: %w", err)
	}
	defer func() { _ = os.Remove(file.Name()) }()
	if _, err := file.Write(encodeTaskXML(task.XML)); err != nil {
		_ = file.Close()
		return fmt.Errorf("write task XML: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close task XML: %w", err)
	}
	if _, err := s.run("/Create", "/TN", task.Name, "/XML", file.Name(), "/F"); err != nil {
		return fmt.Errorf("schtasks /Create %s: %w", task.Name, err)
	}
	return s.readback(task)
}

func (s *windowsScheduler) readback(expected recoveryTask) error {
	data, err := s.run("/Query", "/TN", expected.Name, "/XML")
	if err != nil {
		return fmt.Errorf("schtasks /Query %s: %w", expected.Name, err)
	}
	got, err := parseTaskShape(data)
	if err != nil {
		return fmt.Errorf("read back %s: %w", expected.Name, err)
	}
	want, err := parseTaskShape(expected.XML)
	if err != nil {
		return err
	}
	if got.Command != want.Command || got.Arguments != want.Arguments {
		return fmt.Errorf("read back %s: recovery action does not match journal", expected.Name)
	}
	// A task that still names the recovery binary but is disabled, lost a
	// trigger, or no longer runs as SYSTEM will never fire: not armed.
	if !strings.EqualFold(got.UserID, want.UserID) || got.Enabled != want.Enabled ||
		got.StartWhenAvailable != want.StartWhenAvailable || strings.Join(got.Triggers, ";") != strings.Join(want.Triggers, ";") {
		return fmt.Errorf("read back %s: task principal, triggers or settings do not match", expected.Name)
	}
	return nil
}

// Ready checks the journal artifact, poll action, and recovery self-test without
// registering a task or relying on the running agent for future recovery.
func (s *windowsScheduler) Ready() (bool, string) {
	path, err := s.checkedRecoveryPath()
	if err != nil {
		return false, err.Error()
	}
	if err := s.readback(buildPollTask(path, s.dataDir, s.now())); err != nil {
		return false, err.Error()
	}
	if err := s.selfTest(path); err != nil {
		return false, fmt.Sprintf("recovery self-test: %v", err)
	}
	return true, ""
}

func isOwnedRecoveryTask(name string) bool {
	switch strings.ToLower(name) {
	case `\breeze\isolationpoll`, `\breeze\isolationexpireat`:
		return true
	}
	const prefix = recoveryTaskFolder + "IsolationRollback-"
	return len(name) > len(prefix) && strings.EqualFold(name[:len(prefix)], prefix) && recoveryAttemptPattern.MatchString(name[len(prefix):])
}

func (s *windowsScheduler) ownedTasks() ([]string, error) {
	data, err := s.run("/Query", "/FO", "CSV", "/NH")
	if err != nil {
		return nil, fmt.Errorf("schtasks /Query task list: %w", err)
	}
	// /FO CSV is emitted through the console code page; owned task names are
	// strictly ASCII, so parsing names does not depend on the locale.
	reader := csv.NewReader(bytes.NewReader(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})))
	reader.FieldsPerRecord = -1
	var names []string
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parse schtasks task list: %w", err)
		}
		if len(row) > 0 && isOwnedRecoveryTask(row[0]) {
			names = append(names, row[0])
		}
	}
	sort.Strings(names)
	return names, nil
}

// DisarmProvisional deletes only the validated attempt task and confirms absence.
func (s *windowsScheduler) DisarmProvisional(attemptID string) error {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	return s.deleteTask(recoveryTaskFolder + "IsolationRollback-" + attemptID)
}

func (s *windowsScheduler) deleteTask(name string) error {
	if !isOwnedRecoveryTask(name) {
		return fmt.Errorf("refuse to delete foreign task %q", name)
	}
	_, deleteErr := s.run("/Delete", "/TN", name, "/F")
	// Avoid localized error-string matching: enumerate to distinguish missing
	// tasks from access failures, and to confirm successful deletions as well.
	names, err := s.ownedTasks()
	if err != nil {
		return err
	}
	for _, present := range names {
		if strings.EqualFold(present, name) {
			if deleteErr != nil {
				return fmt.Errorf("schtasks /Delete %s: %w", name, deleteErr)
			}
			return fmt.Errorf("schtasks /Delete %s left the task installed", name)
		}
	}
	return nil
}

// RemoveAll deletes only this scheduler's task names, including prior attempts.
func (s *windowsScheduler) RemoveAll() error {
	names, err := s.ownedTasks()
	if err != nil {
		return err
	}
	var failures []error
	for _, name := range names {
		if err := s.deleteTask(name); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
