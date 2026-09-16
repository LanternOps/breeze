package networkdiagnostic

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func journalCommandFixture() Command {
	return Command{CommandID: "command", RunID: "run", AttemptID: "attempt", PlanDigest: "digest", ExpiresAt: time.Now().Add(time.Minute)}
}
func TestJournalCrashNeverRepeatsSideEffect(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal")
	j, e := OpenJournal(path)
	if e != nil {
		t.Fatal(e)
	}
	command := journalCommandFixture()
	if accepted, e := j.Accept(command); !accepted || e != nil {
		t.Fatal(e)
	}
	key := command.StepKey("step")
	initial := StepResult{ID: "step", Attribution: Attribution{OriginAgentID: "agent", OriginDeviceID: "device", RequestedMethod: "icmp", EvidenceRefs: []string{}, Quality: "unknown"}}
	if started, e := j.StartStep(key, initial); !started || e != nil {
		t.Fatal(e)
	}
	_ = j.Close()
	j, e = OpenJournal(path)
	if e != nil {
		t.Fatal(e)
	}
	result, ok := j.Result(key)
	if !ok || result == nil || *result.Reason != "outcome_indeterminate" || result.Attribution.OriginAgentID != "agent" {
		t.Fatal(result)
	}
	if started, e := j.StartStep(key); started || e != nil {
		t.Fatal("duplicate probe", e)
	}
}
func TestJournalConcurrentDuplicates(t *testing.T) {
	j, e := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	c := journalCommandFixture()
	_, e = j.Accept(c)
	if e != nil {
		t.Fatal(e)
	}
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started, e := j.StartStep(c.StepKey("s"))
			if e != nil {
				t.Error(e)
			}
			if started {
				winners.Add(1)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatal(winners.Load())
	}
}
func TestJournalRefusesCorruptionAndWriteFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal")
	if e := os.WriteFile(path, []byte("{"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := OpenJournal(path); e == nil {
		t.Fatal("corruption accepted")
	}
	j, e := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	j.write = func(string, []byte) error { return os.ErrPermission }
	if accepted, e := j.Accept(journalCommandFixture()); accepted || !errors.Is(e, os.ErrPermission) {
		t.Fatal(accepted, e)
	}
}
func TestJournalTerminalRetryAndRetention(t *testing.T) {
	j, e := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	now := time.Now()
	j.clock = func() time.Time { return now }
	c := journalCommandFixture()
	_, _ = j.Accept(c)
	key := c.StepKey("s")
	_, _ = j.StartStep(key)
	result := StepResult{ID: "s", State: "succeeded"}
	if e = j.FinishStep(key, result); e != nil {
		t.Fatal(e)
	}
	if e = j.FinishStep(key, StepResult{ID: "s", State: "failed_check"}); e != nil {
		t.Fatal(e)
	}
	stored, _ := j.Result(key)
	if stored.State != "succeeded" {
		t.Fatal("terminal overwritten")
	}
	now = c.ExpiresAt.Add(24*time.Hour - time.Nanosecond)
	next := cloneJournal(j.data)
	j.cleanup(&next, now)
	if len(next.Entries) != 1 {
		t.Fatal("early expiry")
	}
	now = c.ExpiresAt.Add(24 * time.Hour)
	j.cleanup(&next, now)
	if len(next.Entries) != 0 {
		t.Fatal("retention boundary")
	}
}

func TestJournalExclusiveOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal")
	first, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := OpenJournal(path); err == nil {
		second.Close()
		t.Fatal("two journal owners")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
}
func TestJournalCancellationTombstoneSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "journal")
	j, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	c := journalCommandFixture()
	if err = j.Cancel(c.CommandID, c.RunID, c.AttemptID); err != nil {
		t.Fatal(err)
	}
	j.Close()
	j, err = OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	if _, err = j.Accept(c); !errors.Is(err, ErrCancelled) {
		t.Fatal(err)
	}
}

func TestJournalRejectsDifferentCommandForSameAttempt(t *testing.T) {
	j, err := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	c := journalCommandFixture()
	if _, err = j.Accept(c); err != nil {
		t.Fatal(err)
	}
	c.CommandID = "replacement-command"
	if _, err = j.Accept(c); !errors.Is(err, ErrJournalConflict) {
		t.Fatal(err)
	}
}
func TestJournalFullAndClockRollback(t *testing.T) {
	j, err := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	now := time.Now()
	j.clock = func() time.Time { return now }
	for i := 0; i < 10000; i++ {
		j.data.Commands[fmt.Sprint(i)] = journalCommand{RunID: fmt.Sprint(i), AttemptID: "a", ExpiresAt: now.Add(time.Hour)}
	}
	if _, err = j.Accept(journalCommandFixture()); !errors.Is(err, ErrJournalFull) {
		t.Fatal(err)
	}
	j.data.LastClock = now.Add(48 * time.Hour)
	next := cloneJournal(j.data)
	j.cleanup(&next, now.Add(30*time.Hour))
	if len(next.Commands) != 10000 {
		t.Fatal("rollback expired entries")
	}
}

func TestJournalIntentPersistenceStagesFailClosed(t *testing.T) {
	for _, stage := range []string{"write", "fsync", "rename"} {
		t.Run(stage, func(t *testing.T) {
			j, err := OpenJournal(filepath.Join(t.TempDir(), "journal"))
			if err != nil {
				t.Fatal(err)
			}
			defer j.Close()
			c := journalCommandFixture()
			if _, err = j.Accept(c); err != nil {
				t.Fatal(err)
			}
			ops := nativeJournalOps()
			failure := errors.New(stage + " failed")
			switch stage {
			case "write":
				ops.write = func(*os.File, []byte) (int, error) { return 0, failure }
			case "fsync":
				ops.sync = func(*os.File) error { return failure }
			case "rename":
				ops.replace = func(string, string) error { return failure }
			}
			j.write = func(path string, data []byte) error { return writeJournalWithOps(path, data, ops) }
			if started, err := j.StartStep(c.StepKey("s")); started || !errors.Is(err, failure) {
				t.Fatal(started, err)
			}
			if _, exists := j.Result(c.StepKey("s")); exists {
				t.Fatal("failed intent published")
			}
		})
	}
}
