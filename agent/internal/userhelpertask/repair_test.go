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
	deleteErr   error
	// deleteKeeps: /Delete exits 0 but the task stays registered.
	deleteKeeps bool
	// states, when set, are what successive run-state probes return; the
	// last one repeats. Unset: Ready while a task is registered.
	states []stateReply
	probes int
}

type stateReply struct {
	state RunState
	err   error
}

func (f *fakeScheduler) runState() (RunState, error) {
	f.probes++
	if len(f.states) == 0 {
		if f.registered == nil {
			return StateUnreadable, &StateReadError{Err: errors.New("0x80070002")}
		}
		return StateReady, nil
	}
	reply := f.states[0]
	if len(f.states) > 1 {
		f.states = f.states[1:]
	}
	return reply.state, reply.err
}

// brokenRegistration is the half-deleted lab state: the task reads back but
// Task Scheduler cannot report or run it until a reboot (0x80070057).
var brokenRegistration = stateReply{StateUnreadable, &StateReadError{Err: errors.New("HRESULT 0x80070057")}}

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
	case len(args) == 4 && args[0] == "/Delete" && args[1] == "/TN" && args[3] == "/F":
		if args[2] != TaskName {
			f.t.Fatalf("deleted task %q, want %q", args[2], TaskName)
		}
		if f.deleteErr != nil {
			return nil, f.deleteErr
		}
		if f.deleteKeeps {
			return []byte("SUCCESS"), nil
		}
		f.registered = nil
		return []byte("SUCCESS"), nil
	}
	f.t.Fatalf("unexpected schtasks call: %q", args)
	return nil, nil
}

func (f *fakeScheduler) createCalls() int { return f.countCalls("/Create") }

func (f *fakeScheduler) deleteCalls() int { return f.countCalls("/Delete") }

func (f *fakeScheduler) countCalls(verb string) int {
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c, verb+" ") {
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
	uninstallErr error
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
		Uninstalling: func() (bool, error) { return g.uninstalling, g.uninstallErr },
		Schtasks:     g.sched.run,
		RunState:     g.sched.runState,
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
	if entries, _ := os.ReadDir(g.r.deps.TempDir); len(entries) != 0 {
		t.Fatalf("task file left behind after a failed create: %v", entries)
	}
}

// Only a re-creation that landed counts toward the backoff: a create that
// keeps failing is retried on the normal cadence, not latched off.
func TestFailedCreatesDoNotSpendTheBackoff(t *testing.T) {
	g := newRig(t)
	g.sched.createErr = errors.New("exit status 1")
	for range MaxRepairs + 2 {
		mustCheck(t, g.r, OutcomeRepairFailed)
		g.now = g.now.Add(time.Hour)
	}
	g.sched.createErr = nil
	mustCheck(t, g.r, OutcomeRepaired)
	if got := g.r.RepairsInWindow(); got != 1 {
		t.Fatalf("RepairsInWindow = %d, want 1", got)
	}
}

func TestUnreadableUninstallStateIsACheckFailure(t *testing.T) {
	g := newRig(t)
	g.uninstallErr = errors.New("service manager unavailable")
	mustCheck(t, g.r, OutcomeCheckFailed)
	if len(g.sched.calls) != 0 {
		t.Fatalf("schtasks run with the uninstall state unknown: %q", g.sched.calls)
	}
}

// Every field that decides whether the task starts the helper at logon, as
// the user, is compared on read-back.
func TestReadBackRejectsEachMeaningfulDifference(t *testing.T) {
	cases := map[string][2]string{
		"run level elevated": {"<RunLevel>LeastPrivilege</RunLevel>", "<RunLevel>HighestAvailable</RunLevel>"},
		"other group":        {"<GroupId>S-1-5-32-545</GroupId>", "<GroupId>S-1-5-32-544</GroupId>"},
		"user principal":     {"<GroupId>S-1-5-32-545</GroupId>", "<UserId>S-1-5-18</UserId>"},
		"task disabled":      {"<Hidden>true</Hidden>", "<Hidden>true</Hidden>\n    <Enabled>false</Enabled>"},
		"trigger disabled":   {"<LogonTrigger>\n      <Enabled>true</Enabled>", "<LogonTrigger>\n      <Enabled>false</Enabled>"},
		"time trigger":       {"LogonTrigger>", "BootTrigger>"},
		"other command":      {`breeze-user-helper.exe"`, `breeze-agent.exe"`},
		"second action":      {"</Exec>", "</Exec>\n    <Exec><Command>cmd.exe</Command></Exec>"},
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			g := newRig(t)
			g.sched.queryRender = func(doc []byte) []byte {
				out := strings.ReplaceAll(string(doc), edit[0], edit[1])
				if out == string(doc) {
					t.Fatalf("edit %q matched nothing", edit[0])
				}
				return []byte(out)
			}
			mustCheck(t, g.r, OutcomeRepairFailed)
		})
	}
}

// A task the agent registered but could not verify is not taken as healthy
// just because it now exists: it is read back again on later checks.
func TestUnverifiedTaskIsReverifiedNotTakenAsPresent(t *testing.T) {
	g := newRig(t)
	bad := func(doc []byte) []byte {
		return bytes.Replace(doc, []byte("--role user"), []byte("--role system"), 1)
	}
	g.sched.queryRender = bad
	mustCheck(t, g.r, OutcomeRepairFailed)
	mustCheck(t, g.r, OutcomeRepairFailed)
	if got := g.sched.createCalls(); got != 1 {
		t.Fatalf("re-verification created the task again: creates = %d", got)
	}
	g.sched.queryRender = nil
	mustCheck(t, g.r, OutcomePresent)
	g.sched.queryRender = bad // verified once: back to presence only
	mustCheck(t, g.r, OutcomePresent)
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

// --- A registered task must also be runnable (#12580, lab round 2) ---

func TestRunnableAfterCreateIsRepaired(t *testing.T) {
	g := newRig(t)
	mustCheck(t, g.r, OutcomeRepaired)
	if g.sched.probes != 1 {
		t.Fatalf("run-state probes = %d, want 1", g.sched.probes)
	}
	if g.sched.deleteCalls() != 0 || g.sched.createCalls() != 1 {
		t.Fatalf("a runnable task was re-registered: %q", g.sched.calls)
	}
	// Runnable once: later checks are presence only.
	mustCheck(t, g.r, OutcomePresent)
	if g.sched.probes != 1 {
		t.Fatalf("a settled task was probed again: probes = %d", g.sched.probes)
	}
}

func TestNotRunnableAfterCreateIsReregisteredCleanlyOnce(t *testing.T) {
	g := newRig(t)
	g.sched.states = []stateReply{brokenRegistration, {StateReady, nil}}
	mustCheck(t, g.r, OutcomeRepaired)
	want := []string{
		"/Create /TN " + TaskName,
		"/Query /TN " + TaskName + " /XML",
		"/Delete /TN " + TaskName + " /F",
		"/Create /TN " + TaskName,
		"/Query /TN " + TaskName + " /XML",
	}
	if len(g.sched.calls) != len(want) {
		t.Fatalf("calls = %q, want %q", g.sched.calls, want)
	}
	for i, prefix := range want {
		if !strings.HasPrefix(g.sched.calls[i], prefix) {
			t.Fatalf("call %d = %q, want %q...", i, g.sched.calls[i], prefix)
		}
	}
	if got := g.r.RepairsInWindow(); got != 1 {
		t.Fatalf("RepairsInWindow = %d, want 1: the clean re-registration is part of one repair", got)
	}
	mustCheck(t, g.r, OutcomePresent)
}

func TestNotRunnableAfterCleanReregistrationIsPendingReboot(t *testing.T) {
	for name, broken := range map[string]stateReply{
		"state unreadable": brokenRegistration,
		"state unknown":    {StateUnknown, nil},
		"state disabled":   {StateDisabled, nil},
	} {
		t.Run(name, func(t *testing.T) {
			g := newRig(t)
			g.sched.states = []stateReply{broken}
			mustCheck(t, g.r, OutcomeRepairedPendingReboot)
			if g.sched.createCalls() != 2 || g.sched.deleteCalls() != 1 {
				t.Fatalf("want one create, one delete, one create: %q", g.sched.calls)
			}
			if got := g.r.RepairsInWindow(); got != 1 {
				t.Fatalf("RepairsInWindow = %d, want 1 (charged once)", got)
			}
			// Sticky, and never another write: later checks only probe.
			writes := len(g.sched.calls)
			for range 3 {
				g.now = g.now.Add(4 * time.Hour)
				mustCheck(t, g.r, OutcomeRepairedPendingReboot)
			}
			if len(g.sched.calls) != writes {
				t.Fatalf("a pending task was written again: %q", g.sched.calls[writes:])
			}
			if got := g.r.RepairsInWindow(); got > 1 {
				t.Fatalf("RepairsInWindow = %d after re-probes", got)
			}
			// Runnable at last (e.g. after Task Scheduler restarted): present.
			g.sched.states = []stateReply{{StateReady, nil}}
			mustCheck(t, g.r, OutcomePresent)
		})
	}
}

// A pending task that keeps being removed still runs into the backoff.
func TestPendingRebootRepairsCountTowardTheBackoff(t *testing.T) {
	g := newRig(t)
	g.sched.states = []stateReply{brokenRegistration}
	for range MaxRepairs {
		mustCheck(t, g.r, OutcomeRepairedPendingReboot)
		g.sched.registered = nil
		g.now = g.now.Add(time.Hour)
	}
	mustCheck(t, g.r, OutcomeBackedOff)
	if got := g.sched.createCalls(); got != 2*MaxRepairs {
		t.Fatalf("creates = %d, want %d", got, 2*MaxRepairs)
	}
}

func TestRunStateProbeFailureIsACheckFailure(t *testing.T) {
	g := newRig(t)
	g.sched.states = []stateReply{{0, errors.New("connect to Task Scheduler: 0x80070005")}}
	mustCheck(t, g.r, OutcomeCheckFailed)
	if g.sched.deleteCalls() != 0 || g.sched.createCalls() != 1 {
		t.Fatalf("re-registered on a probe that did not run: %q", g.sched.calls)
	}
	// Not taken as present while the probe cannot run.
	mustCheck(t, g.r, OutcomeCheckFailed)
	if g.sched.createCalls() != 1 {
		t.Fatalf("re-created while the probe cannot run: %q", g.sched.calls)
	}
	// The probe runs again and reports a runnable task.
	g.sched.states = []stateReply{{StateReady, nil}}
	mustCheck(t, g.r, OutcomePresent)
	if got := g.r.RepairsInWindow(); got != 1 {
		t.Fatalf("RepairsInWindow = %d, want 1", got)
	}
}

func TestDeleteFailureDuringCleanReregistrationIsPendingReboot(t *testing.T) {
	g := newRig(t)
	g.sched.states = []stateReply{brokenRegistration}
	g.sched.deleteErr = errors.New("exit status 1")
	mustCheck(t, g.r, OutcomeRepairedPendingReboot)
	if g.sched.createCalls() != 1 {
		t.Fatalf("created again after the delete failed: %q", g.sched.calls)
	}
	mustCheck(t, g.r, OutcomeRepairedPendingReboot)
	if g.sched.deleteCalls() != 1 {
		t.Fatalf("delete retried: %q", g.sched.calls)
	}
}

func TestSecondCreateFailureIsAFailedRepairChargedOnce(t *testing.T) {
	g := newRig(t)
	g.sched.states = []stateReply{brokenRegistration, {StateReady, nil}}
	g.sched.afterCreate = func() { g.sched.createErr = errors.New("exit status 1") }
	mustCheck(t, g.r, OutcomeRepairFailed)
	if got := g.r.RepairsInWindow(); got != 1 {
		t.Fatalf("RepairsInWindow = %d, want 1", got)
	}
	// The task is gone now; the next check repairs it on the normal path.
	g.sched.createErr, g.sched.afterCreate = nil, nil
	mustCheck(t, g.r, OutcomeRepaired)
	if got := g.r.RepairsInWindow(); got != 2 {
		t.Fatalf("RepairsInWindow = %d, want 2", got)
	}
}

// A failed clean re-registration never clears the pending state without a
// positive probe: a task that is still there is not taken as present.
func TestFailedReregistrationOfATaskThatStayedIsNotTakenAsPresent(t *testing.T) {
	g := newRig(t)
	g.sched.states = []stateReply{brokenRegistration}
	g.sched.deleteKeeps = true
	g.sched.afterCreate = func() { g.sched.createErr = errors.New("exit status 1") }
	mustCheck(t, g.r, OutcomeRepairFailed)
	mustCheck(t, g.r, OutcomeRepairedPendingReboot)
	if g.sched.createCalls() != 2 || g.sched.deleteCalls() != 1 {
		t.Fatalf("re-registered again: %q", g.sched.calls)
	}
}

func TestUninstallStartingBeforeCleanReregistrationStopsIt(t *testing.T) {
	g := newRig(t)
	g.sched.states = []stateReply{brokenRegistration}
	g.sched.afterCreate = func() { g.uninstalling = true }
	mustCheck(t, g.r, OutcomeUninstalling)
	if g.sched.deleteCalls() != 0 || g.sched.createCalls() != 1 {
		t.Fatalf("re-registered during an uninstall: %q", g.sched.calls)
	}
}

func TestTaskFolderAndLeaf(t *testing.T) {
	folder, leaf := taskFolderAndLeaf()
	if folder != `\Breeze` || leaf != "AgentUserHelper" {
		t.Fatalf("taskFolderAndLeaf() = %q, %q", folder, leaf)
	}
}

func TestRunStateRunnable(t *testing.T) {
	for state, want := range map[RunState]bool{
		StateUnreadable: false, StateUnknown: false, StateDisabled: false,
		StateQueued: true, StateReady: true, StateRunning: true, RunState(5): false,
	} {
		if got := state.Runnable(); got != want {
			t.Errorf("RunState(%d).Runnable() = %v, want %v", state, got, want)
		}
	}
}
