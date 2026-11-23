package userhelpertask

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	agentservice "github.com/breeze-rmm/agent/service"
)

// fakeScheduler is Task Scheduler as schtasks.exe and the TaskCache registry
// show it: one optional registered document for TaskName.
type fakeScheduler struct {
	t          *testing.T
	registered []byte // UTF-8 document; nil = no task
	creates    [][]byte
	calls      []string
	existsErr  error
	createErr  error
	// queryRender, when set, replaces the document /Query returns.
	queryRender func(doc []byte) []byte
	// afterCreate runs once a create lands (e.g. something deletes it again).
	afterCreate func()
}

func (f *fakeScheduler) exists() (bool, error) {
	if f.existsErr != nil {
		return false, f.existsErr
	}
	return f.registered != nil, nil
}

func (f *fakeScheduler) run(args ...string) ([]byte, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch {
	case len(args) == 6 && args[0] == "/Create" && args[1] == "/TN" && args[3] == "/XML" && args[5] == "/F":
		if args[2] != TaskName {
			f.t.Fatalf("created task %q, want %q", args[2], TaskName)
		}
		raw, err := os.ReadFile(args[4])
		if err != nil {
			f.t.Fatalf("schtasks could not read the task file: %v", err)
		}
		f.creates = append(f.creates, raw)
		if f.createErr != nil {
			return nil, f.createErr
		}
		doc, err := decodeTaskXML(raw)
		if err != nil {
			f.t.Fatalf("task file is not decodable: %v", err)
		}
		f.registered = doc
		if f.afterCreate != nil {
			f.afterCreate()
		}
		return []byte("SUCCESS"), nil
	case len(args) == 4 && args[0] == "/Query" && args[1] == "/TN" && args[3] == "/XML":
		if f.registered == nil {
			return nil, errors.New("exit status 1")
		}
		doc := f.registered
		if f.queryRender != nil {
			doc = f.queryRender(doc)
		}
		return utf16le(doc), nil
	}
	f.t.Fatalf("unexpected schtasks call: %q", args)
	return nil, nil
}

func (f *fakeScheduler) createCalls() int {
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, "/Create") {
			n++
		}
	}
	return n
}

func utf16le(doc []byte) []byte {
	units := utf16.Encode([]rune(string(doc)))
	out := []byte{0xff, 0xfe}
	for _, u := range units {
		out = binary.LittleEndian.AppendUint16(out, u)
	}
	return out
}

type rig struct {
	sched        *fakeScheduler
	helper       bool
	helperErr    error
	helperPath   string
	uninstalling bool
	now          time.Time
	r            *Repairer
}

func newRig(t *testing.T) *rig {
	t.Helper()
	g := &rig{sched: &fakeScheduler{t: t}, helper: true, now: time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)}
	g.r = New(Deps{
		TaskExists: g.sched.exists,
		HelperPresent: func(path string) (bool, error) {
			g.helperPath = path
			return g.helper, g.helperErr
		},
		Uninstalling: func() bool { return g.uninstalling },
		Schtasks:     g.sched.run,
		TempDir:      t.TempDir(),
		Now:          func() time.Time { return g.now },
	})
	return g
}

func mustCheck(t *testing.T, r *Repairer, want Outcome) {
	t.Helper()
	got, err := r.Check()
	if got != want {
		t.Fatalf("Check() = %q (err %v), want %q", got, err, want)
	}
}

func TestMissingTaskWithHelperPresentIsCreatedAndVerified(t *testing.T) {
	g := newRig(t)
	mustCheck(t, g.r, OutcomeRepaired)

	if len(g.sched.creates) != 1 {
		t.Fatalf("creates = %d, want 1", len(g.sched.creates))
	}
	raw := g.sched.creates[0]
	if !bytes.HasPrefix(raw, []byte{0xff, 0xfe}) {
		t.Fatalf("task file must be UTF-16LE with a BOM, starts %x", raw[:2])
	}
	doc, err := decodeTaskXML(raw)
	if err != nil {
		t.Fatal(err)
	}
	// Byte-for-byte the installer's definition: the embedded file itself.
	if !bytes.Equal(doc, agentservice.WindowsUserHelperTaskXML) {
		t.Fatalf("registered document differs from the installer's task XML:\n%s", doc)
	}
	last := g.sched.calls[len(g.sched.calls)-1]
	if last != "/Query /TN "+TaskName+" /XML" {
		t.Fatalf("the create was not read back; last call %q", last)
	}
	if g.helperPath != `C:\Program Files\Breeze\breeze-user-helper.exe` {
		t.Fatalf("checked the helper at %q", g.helperPath)
	}
	// The temp file is gone once the create has read it.
	if entries, _ := os.ReadDir(g.r.deps.TempDir); len(entries) != 0 {
		t.Fatalf("task file left behind: %v", entries)
	}
}

func TestPresentTaskIsNotWritten(t *testing.T) {
	g := newRig(t)
	g.sched.registered = append([]byte(nil), agentservice.WindowsUserHelperTaskXML...)
	mustCheck(t, g.r, OutcomePresent)
	if len(g.sched.calls) != 0 {
		t.Fatalf("schtasks was run for a present task: %q", g.sched.calls)
	}
}

func TestMissingHelperIsNotRegistered(t *testing.T) {
	g := newRig(t)
	g.helper = false
	mustCheck(t, g.r, OutcomeHelperMissing)
	if g.sched.createCalls() != 0 {
		t.Fatalf("created a task with the helper missing: %q", g.sched.calls)
	}
}

func TestHelperStatErrorIsNotAMissingHelperOrARepair(t *testing.T) {
	g := newRig(t)
	g.helperErr = errors.New("access denied")
	mustCheck(t, g.r, OutcomeCheckFailed)
	if g.sched.createCalls() != 0 {
		t.Fatalf("created a task on an unreadable helper: %q", g.sched.calls)
	}
}

func TestUnknownTaskStateIsNeverTreatedAsMissing(t *testing.T) {
	g := newRig(t)
	g.sched.existsErr = errors.New("registry read failed")
	mustCheck(t, g.r, OutcomeCheckFailed)
	if len(g.sched.calls) != 0 {
		t.Fatalf("schtasks run on an unknown task state: %q", g.sched.calls)
	}
}

func TestRepeatedDeletionBacksOff(t *testing.T) {
	g := newRig(t)
	for range MaxRepairs {
		mustCheck(t, g.r, OutcomeRepaired)
		g.sched.registered = nil // gone again
		g.now = g.now.Add(time.Hour)
	}
	mustCheck(t, g.r, OutcomeBackedOff)
	if got := g.sched.createCalls(); got != MaxRepairs {
		t.Fatalf("creates = %d, want %d", got, MaxRepairs)
	}
	// Sticky until the next agent start, even once the window has passed.
	g.now = g.now.Add(RepairWindow * 2)
	mustCheck(t, g.r, OutcomeBackedOff)
	if got := g.sched.createCalls(); got != MaxRepairs {
		t.Fatalf("repaired after backing off: creates = %d", got)
	}
	// A task put back by someone else is reported as present.
	g.sched.registered = append([]byte(nil), agentservice.WindowsUserHelperTaskXML...)
	mustCheck(t, g.r, OutcomePresent)
}

func TestRepairsSpreadBeyondTheWindowDoNotBackOff(t *testing.T) {
	g := newRig(t)
	for range MaxRepairs * 2 {
		mustCheck(t, g.r, OutcomeRepaired)
		g.sched.registered = nil
		g.now = g.now.Add(RepairWindow/time.Duration(MaxRepairs) + time.Minute)
	}
}

func TestUninstallInProgressIsNotRepaired(t *testing.T) {
	g := newRig(t)
	g.uninstalling = true
	mustCheck(t, g.r, OutcomeUninstalling)
	if g.sched.createCalls() != 0 {
		t.Fatalf("created a task during uninstall: %q", g.sched.calls)
	}
}

func TestUninstallStartingMidCheckIsNotRepaired(t *testing.T) {
	g := newRig(t)
	g.r.deps.HelperPresent = func(string) (bool, error) {
		g.uninstalling = true // the uninstall starts between the checks
		return true, nil
	}
	mustCheck(t, g.r, OutcomeUninstalling)
	if g.sched.createCalls() != 0 {
		t.Fatalf("created a task during uninstall: %q", g.sched.calls)
	}
}

func TestCreateFailureIsReported(t *testing.T) {
	g := newRig(t)
	g.sched.createErr = errors.New("exit status 1")
	mustCheck(t, g.r, OutcomeRepairFailed)
}

func TestReadBackMismatchIsAFailedRepair(t *testing.T) {
	g := newRig(t)
	g.sched.queryRender = func(doc []byte) []byte {
		return bytes.Replace(doc, []byte("--role user"), []byte("--role system"), 1)
	}
	mustCheck(t, g.r, OutcomeRepairFailed)
}

func TestReadBackOfARerenderedTaskVerifies(t *testing.T) {
	// schtasks /Query /XML re-renders the document: different declaration,
	// indentation and extra defaults. The meaning is what is compared.
	g := newRig(t)
	g.sched.queryRender = func(doc []byte) []byte {
		s := strings.ReplaceAll(string(doc), "  ", "    ")
		s = strings.Replace(s, "<Hidden>true</Hidden>", "<Hidden>true</Hidden>\n    <WakeToRun>false</WakeToRun>", 1)
		return []byte(s)
	}
	mustCheck(t, g.r, OutcomeRepaired)
}

func TestReadBackWithDefaultsOmittedVerifies(t *testing.T) {
	// LeastPrivilege and Enabled=true are Task Scheduler's defaults; a
	// rendering that leaves them out still describes the same task.
	g := newRig(t)
	g.sched.queryRender = func(doc []byte) []byte {
		s := strings.Replace(string(doc), "<RunLevel>LeastPrivilege</RunLevel>", "", 1)
		s = strings.Replace(s, "<Enabled>true</Enabled>\n    </LogonTrigger>", "</LogonTrigger>", 1)
		if s == string(doc) {
			t.Fatal("re-render changed nothing")
		}
		return []byte(s)
	}
	mustCheck(t, g.r, OutcomeRepaired)
}

func TestTaskGoneAfterCreateIsAFailedRepair(t *testing.T) {
	g := newRig(t)
	g.sched.afterCreate = func() { g.sched.registered = nil }
	mustCheck(t, g.r, OutcomeRepairFailed)
}

// The installer and the agent must register the same file.
func TestInstallerRegistersTheEmbeddedFile(t *testing.T) {
	root := filepath.Join("..", "..")
	onDisk, err := os.ReadFile(filepath.Join(root, "service", "windows", "breeze-agent-user-task.xml"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, agentservice.WindowsUserHelperTaskXML) {
		t.Fatal("embedded task XML differs from service/windows/breeze-agent-user-task.xml")
	}
	ps1, err := os.ReadFile(filepath.Join(root, "scripts", "install", "install-windows.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`service\windows\breeze-agent-user-task.xml`,
		`$taskXml = Get-Content $TaskXmlPath -Raw`,
		`Register-ScheduledTask -Xml $taskXml -TaskName "AgentUserHelper" -TaskPath "\Breeze\" -Force`,
	} {
		if !bytes.Contains(ps1, []byte(want)) {
			t.Fatalf("install-windows.ps1 no longer contains %q", want)
		}
	}
	wxs, err := os.ReadFile(filepath.Join(root, "installer", "breeze.wxs"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(wxs, []byte(`<?define UserTaskXmlPath=..\service\windows\breeze-agent-user-task.xml?>`)) {
		t.Fatal("breeze.wxs no longer ships service/windows/breeze-agent-user-task.xml")
	}
}

func TestTaskDefinitionIsTheProductLogonTask(t *testing.T) {
	want, err := parseShape(agentservice.WindowsUserHelperTaskXML)
	if err != nil {
		t.Fatal(err)
	}
	if want.Command != `"C:\Program Files\Breeze\breeze-user-helper.exe"` ||
		want.Arguments != "user-helper --role user" ||
		want.GroupID != "S-1-5-32-545" || want.RunLevel != "LeastPrivilege" ||
		!want.LogonTrigger || !want.Enabled || want.URI != TaskName {
		t.Fatalf("unexpected task definition: %+v", want)
	}
	if HelperPath() != `C:\Program Files\Breeze\breeze-user-helper.exe` {
		t.Fatalf("HelperPath() = %q", HelperPath())
	}
}
