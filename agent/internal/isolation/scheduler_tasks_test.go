package isolation

import (
	"bytes"
	"encoding/binary"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

var updateSchedulerGolden = flag.Bool("update-scheduler", false, "rewrite Windows recovery task XML goldens")

func TestRecoveryTaskXMLGolden(t *testing.T) {
	at := time.Date(2026, 10, 25, 19, 30, 0, 0, time.FixedZone("test", -7*3600))
	path, dir := `C:\Program Files\Breeze & Co\recovery.exe`, `C:\Program Data\Breeze & "quoted"\`
	rollback, err := buildRollbackTask(path, dir, "attempt-123", at)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		task recoveryTask
		args string
	}{
		{"rollback", rollback, `rollback-if-uncommitted --data-dir "C:\Program Data\Breeze & \"quoted\"\\" --attempt attempt-123`},
		{"expiry", buildExpiryTask(path, dir, at), `expire-check --data-dir "C:\Program Data\Breeze & \"quoted\"\\"`},
		{"poll", buildPollTask(path, dir, at), `expire-check --data-dir "C:\Program Data\Breeze & \"quoted\"\\"`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := filepath.Join("testdata", "scheduler_"+tc.name+".xml")
			if *updateSchedulerGolden {
				if err := os.WriteFile(file, tc.task.XML, 0600); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(tc.task.XML, want) {
				t.Fatalf("XML differs from %s; regenerate with go test ./internal/isolation -run TestRecoveryTaskXMLGolden -update-scheduler", file)
			}
			command, args, err := parseTaskAction(tc.task.XML)
			if err != nil || command != path || args != tc.args {
				t.Fatalf("action = %q %q %v", command, args, err)
			}
			for _, literal := range []string{`<UserId>S-1-5-18</UserId>`, `<RunLevel>HighestAvailable</RunLevel>`, `<StartWhenAvailable>true</StartWhenAvailable>`, `<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`, `<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`, `<ExecutionTimeLimit>PT2M</ExecutionTimeLimit>`, `<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`, `<StartBoundary>2026-10-26T02:30:00Z</StartBoundary>`} {
				if !bytes.Contains(tc.task.XML, []byte(literal)) {
					t.Errorf("missing %s", literal)
				}
			}
			if tc.name == "poll" {
				if !bytes.Contains(tc.task.XML, []byte("<Interval>PT15M</Interval>")) || !bytes.Contains(tc.task.XML, []byte("<BootTrigger>")) || bytes.Contains(tc.task.XML, []byte("<Duration>")) {
					t.Fatal("poll must repeat indefinitely and run at boot")
				}
			} else if bytes.Contains(tc.task.XML, []byte("<Repetition>")) || bytes.Contains(tc.task.XML, []byte("<BootTrigger>")) {
				t.Fatal("deadline tasks must be one-shot")
			}
		})
	}
	// StartWhenAvailable may run a missed task up to ten minutes late. ExpireAt,
	// not the fifteen-minute poll, is the primary expiry mechanism.
}

func TestRecoveryTaskAttemptValidation(t *testing.T) {
	for _, id := range []string{"", "../bad", `a\b`, "a b", "x\"", strings.Repeat("a", 65), "é", "\n"} {
		if _, err := buildRollbackTask("recovery.exe", "data", id, time.Now()); err == nil {
			t.Errorf("accepted attempt %q", id)
		}
	}
	for _, id := range []string{"a", "A-Z-0123", strings.Repeat("x", 64)} {
		task, err := buildRollbackTask("recovery.exe", "data", id, time.Now())
		if err != nil || task.Name != `\Breeze\IsolationRollback-`+id {
			t.Errorf("valid attempt: %q %v", task.Name, err)
		}
	}
}

func TestTaskUTF16AndQueryParser(t *testing.T) {
	task := buildExpiryTask(`C:\Breeze & 中文\recovery.exe`, `C:\Data`, time.Now())
	encoded := encodeTaskXML(task.XML)
	if len(encoded) < 4 || encoded[0] != 0xff || encoded[1] != 0xfe {
		t.Fatal("missing UTF-16LE BOM")
	}
	if !bytes.Contains(task.XML, []byte(`encoding="UTF-16"`)) {
		t.Fatal("wrong encoding declaration")
	}
	command, args, err := parseTaskAction(encoded)
	if err != nil || command != `C:\Breeze & 中文\recovery.exe` || args != `expire-check --data-dir C:\Data` {
		t.Fatalf("UTF16 roundtrip: %q %q %v", command, args, err)
	}
	// schtasks output can be UTF-8 (including a UTF-16 declaration), UTF-8 BOM,
	// UTF-16LE, or UTF-16BE, depending on redirection and Windows version.
	utf8XML := bytes.ReplaceAll(task.XML, []byte("UTF-16"), []byte("UTF-8"))
	be := append([]byte(nil), encoded...)
	be[0], be[1] = 0xfe, 0xff
	for i := 2; i < len(be); i += 2 {
		be[i], be[i+1] = be[i+1], be[i]
	}
	for _, data := range [][]byte{task.XML, utf8XML, append([]byte{0xef, 0xbb, 0xbf}, utf8XML...), be} {
		c, a, e := parseTaskAction(data)
		if e != nil || c != command || a != args {
			t.Errorf("parse variant: %q %q %v", c, a, e)
		}
	}
	units := make([]uint16, (len(encoded)-2)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(encoded[2+2*i:])
	}
	if string(utf16.Decode(units)) != string(task.XML) {
		t.Fatal("encoding changes document")
	}
	for _, bad := range [][]byte{nil, []byte(`<Task/>`), []byte(`<Task><Actions><Exec><Command>x</Command></Exec><Exec><Command>y</Command></Exec></Actions></Task>`), []byte(`<Task><Actions><Exec><Command></Command></Exec></Actions></Task>`), {0xff, 0xfe, 0x41}, {0xff, 0xfe, 0x00, 0xd8}} {
		if _, _, err := parseTaskAction(bad); err == nil {
			t.Errorf("accepted malformed query %q", bad)
		}
	}
}

func TestRecoveryTaskWindowsQuoting(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", `""`}, {`C:\Data`, `C:\Data`}, {`C:\Program Data\`, `"C:\Program Data\\"`}, {`a"b`, `"a\"b"`}, {`a\"b`, `"a\\\"b"`}, {"a\tb", "\"a\tb\""},
	} {
		if got := quoteWindowsArgument(tc.in); got != tc.want {
			t.Errorf("quote(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func newFakeRecoveryScheduler(t *testing.T) (*windowsScheduler, map[string][]byte, *[]string) {
	t.Helper()
	tasks, calls := map[string][]byte{}, []string{}
	scheduler := &windowsScheduler{
		dataDir: `C:\Program Data\Breeze`, recoveryPath: func() (string, error) { return `C:\Program Files\Breeze\recovery.exe`, nil },
		exists: func(string) bool { return true }, verifySignature: func(string) error { return nil }, selfTest: func(string) error { return nil }, now: func() time.Time { return time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC) },
	}
	scheduler.run = func(args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, "|"))
		arg := func(name string) string {
			for i := 0; i+1 < len(args); i++ {
				if args[i] == name {
					return args[i+1]
				}
			}
			return ""
		}
		switch args[0] {
		case "/Create":
			data, err := os.ReadFile(arg("/XML"))
			if err != nil {
				return nil, err
			}
			if data[0] != 0xff || data[1] != 0xfe {
				t.Fatal("Create did not receive UTF-16")
			}
			tasks[arg("/TN")] = data
			return nil, nil
		case "/Query":
			if arg("/FO") == "CSV" {
				var out strings.Builder
				for name := range tasks {
					out.WriteString(`"` + name + `","","Ready"` + "\r\n")
				}
				return []byte(out.String()), nil
			}
			data, ok := tasks[arg("/TN")]
			if !ok {
				return nil, errors.New("task missing")
			}
			return data, nil
		case "/Delete":
			delete(tasks, arg("/TN"))
			return nil, nil
		}
		return nil, errors.New("unexpected command")
	}
	return scheduler, tasks, &calls
}

func TestWindowsSchedulerReadbackAndReadiness(t *testing.T) {
	s, tasks, calls := newFakeRecoveryScheduler(t)
	if ok, _ := s.Ready(); ok {
		t.Fatal("ready without poll task")
	}
	if err := s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	if ok, why := s.Ready(); !ok {
		t.Fatal(why)
	}
	if err := s.ArmProvisional("attempt-123", s.now().Add(90*time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := s.ArmExpiry("episode", 1, s.now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	first := append([]byte(nil), tasks[`\Breeze\IsolationExpireAt`]...)
	if err := s.ArmExpiry("episode", 2, s.now().Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, tasks[`\Breeze\IsolationExpireAt`]) {
		t.Fatal("extension did not rearm expiry")
	}
	for i, call := range *calls {
		if strings.HasPrefix(call, "/Create|") && (i+1 == len(*calls) || !strings.HasPrefix((*calls)[i+1], "/Query|")) {
			t.Fatal("registration was not immediately read back")
		}
	}
	if err := s.DisarmProvisional("attempt-123"); err != nil {
		t.Fatal(err)
	}
	if _, ok := tasks[`\Breeze\IsolationRollback-attempt-123`]; ok {
		t.Fatal("rollback survived disarm")
	}
}

func TestWindowsSchedulerRefusesUnusableRecovery(t *testing.T) {
	for _, kind := range []string{"missing-journal", "empty-path", "nonexistent", "unsigned"} {
		t.Run(kind, func(t *testing.T) {
			s, _, calls := newFakeRecoveryScheduler(t)
			switch kind {
			case "missing-journal":
				s.recoveryPath = func() (string, error) { return "", os.ErrNotExist }
			case "empty-path":
				s.recoveryPath = func() (string, error) { return "", nil }
			case "nonexistent":
				s.exists = func(string) bool { return false }
			case "unsigned":
				s.verifySignature = func(string) error { return errors.New("unsigned") }
			}
			if err := s.ArmProvisional("a", s.now()); err == nil {
				t.Fatal("rollback registered")
			}
			if err := s.ArmExpiry("e", 1, s.now()); err == nil {
				t.Fatal("expiry registered")
			}
			if err := s.EnsurePoll(); err == nil {
				t.Fatal("poll registered")
			}
			if ok, why := s.Ready(); ok || why == "" {
				t.Fatalf("readiness = %v %q", ok, why)
			}
			if len(*calls) != 0 {
				t.Fatalf("ran schtasks for unusable path: %v", *calls)
			}
		})
	}
}

func TestWindowsSchedulerReadbackFailure(t *testing.T) {
	for _, kind := range []string{"create-error", "query-error", "wrong-command", "wrong-arguments", "invalid-xml"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _ := newFakeRecoveryScheduler(t)
			delegate := s.run
			s.run = func(args ...string) ([]byte, error) {
				if args[0] == "/Create" && kind == "create-error" {
					return nil, errors.New("create failure")
				}
				if args[0] == "/Query" {
					switch kind {
					case "query-error":
						return nil, errors.New("query failure")
					case "wrong-command":
						return buildPollTask("foreign.exe", s.dataDir, s.now()).XML, nil
					case "wrong-arguments":
						return buildPollTask(`C:\Program Files\Breeze\recovery.exe`, "wrong", s.now()).XML, nil
					case "invalid-xml":
						return []byte("invalid"), nil
					}
				}
				return delegate(args...)
			}
			for _, arm := range []func() error{func() error { return s.ArmProvisional("a", s.now()) }, func() error { return s.ArmExpiry("e", 1, s.now()) }, s.EnsurePoll} {
				if err := arm(); err == nil {
					t.Fatal("arm succeeded without valid readback")
				}
			}
			if ok, _ := s.Ready(); ok {
				t.Fatal("ready with broken task")
			}
		})
	}
	s, _, _ := newFakeRecoveryScheduler(t)
	if err := s.EnsurePoll(); err != nil {
		t.Fatal(err)
	}
	s.selfTest = func(string) error { return errors.New("broken recovery") }
	if ok, _ := s.Ready(); ok {
		t.Fatal("ready when self-test fails")
	}
}

func TestWindowsSchedulerRemovesOnlyOwnedTasks(t *testing.T) {
	s, tasks, calls := newFakeRecoveryScheduler(t)
	for _, name := range []string{`\Breeze\IsolationPoll`, `\Breeze\IsolationExpireAt`, `\Breeze\IsolationRollback-attempt-1`, `\Other\IsolationPoll`, `\Breeze\OtherTask`, `\Breeze\IsolationRollback-evil\task`, `\Breeze\IsolationRollback-`} {
		tasks[name] = nil
	}
	if err := s.RemoveAll(); err != nil {
		t.Fatal(err)
	}
	for name := range tasks {
		if isOwnedRecoveryTask(name) {
			t.Errorf("owned task survived %s", name)
		}
	}
	if len(tasks) != 4 {
		t.Fatalf("foreign tasks touched: %v", tasks)
	}
	before := len(*calls)
	if err := s.DisarmProvisional(`..\foreign`); err == nil {
		t.Fatal("accepted unsafe name")
	}
	if len(*calls) != before {
		t.Fatal("invalid name ran command")
	}
}

func TestWindowsSchedulerDeleteFailureIsNotSuccess(t *testing.T) {
	s, tasks, _ := newFakeRecoveryScheduler(t)
	tasks[`\Breeze\IsolationPoll`] = nil
	delegate := s.run
	s.run = func(args ...string) ([]byte, error) {
		if args[0] == "/Delete" {
			return nil, errors.New("denied")
		}
		return delegate(args...)
	}
	if err := s.RemoveAll(); err == nil {
		t.Fatal("reported removal with task remaining")
	}
	if err := s.DisarmProvisional("missing"); err != nil {
		t.Fatalf("absent task should be idempotent: %v", err)
	}
	tasks[`\Breeze\IsolationRollback-present`] = nil
	if err := s.DisarmProvisional("present"); err == nil {
		t.Fatal("failed delete reported success")
	}
}

func TestRecoveryOneShotCatchupBoundary(t *testing.T) {
	at := time.Date(2026, 10, 25, 10, 0, 0, 0, time.UTC)
	rollback, err := buildRollbackTask("recovery.exe", "data", "attempt", at)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []recoveryTask{rollback, buildExpiryTask("recovery.exe", "data", at)} {
		if !bytes.Contains(task.XML, []byte("<EndBoundary>9999-12-31T23:59:59Z</EndBoundary>")) {
			t.Errorf("%s: one-shot tasks need EndBoundary for StartWhenAvailable to apply", task.Name)
		}
	}
	if bytes.Contains(buildPollTask("recovery.exe", "data", at).XML, []byte("<EndBoundary>")) {
		t.Fatal("poll must remain indefinitely recurring")
	}
}

func TestRecoveryTaskOwnershipIsCaseInsensitive(t *testing.T) {
	for _, name := range []string{`\breeze\isolationpoll`, `\BREEZE\ISOLATIONEXPIREAT`, `\Breeze\isolationrollback-Attempt-1`} {
		if !isOwnedRecoveryTask(name) {
			t.Errorf("missed owned task %q", name)
		}
	}
	s, tasks, _ := newFakeRecoveryScheduler(t)
	tasks[`\BREEZE\ISOLATIONPOLL`] = nil
	if err := s.RemoveAll(); err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 0 {
		t.Fatal("mixed-case owned task survived cleanup")
	}
	tasks[`\BREEZE\ISOLATIONROLLBACK-PRESENT`] = nil
	delegate := s.run
	s.run = func(args ...string) ([]byte, error) {
		if args[0] == "/Delete" {
			return nil, errors.New("denied")
		}
		return delegate(args...)
	}
	if err := s.DisarmProvisional("present"); err == nil {
		t.Fatal("case mismatch hid a failed deletion")
	}
}

func TestRecoveryDeadlineNeverRoundsEarlier(t *testing.T) {
	at := time.Date(2026, 11, 1, 12, 0, 0, 500000000, time.UTC)
	rollback, err := buildRollbackTask(`C:\Breeze\recovery.exe`, `C:\Breeze`, "attempt-1", at)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range []recoveryTask{rollback, buildExpiryTask(`C:\Breeze\recovery.exe`, `C:\Breeze`, at)} {
		if !strings.Contains(string(task.XML), "<StartBoundary>2026-11-01T12:00:01Z</StartBoundary>") {
			t.Fatalf("%s can run before the journal deadline and become a no-op", task.Name)
		}
	}
}
