package pamdecline

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	reqA = "11111111-1111-4111-8111-111111111111"
	reqB = "22222222-2222-4222-8222-222222222222"
	reqC = "33333333-3333-4333-8333-333333333333"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock { return &fakeClock{t: time.Date(2027, 1, 10, 10, 0, 0, 0, time.UTC)} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newFileStore(t *testing.T, clock *fakeClock) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pam-declined-requests.json")
	s := NewStore(path, clock.Now)
	if err := s.Load(); err != nil {
		t.Fatalf("Load on a missing file: %v", err)
	}
	return s, path
}

func mustRefuse(t *testing.T, s *Store, id, wantCode string) {
	t.Helper()
	refuse, code := s.Check(id)
	if !refuse || code != wantCode {
		t.Fatalf("Check(%s) = (%v, %q), want (true, %q)", id, refuse, code, wantCode)
	}
}

func mustAllow(t *testing.T, s *Store, id string) {
	t.Helper()
	if refuse, code := s.Check(id); refuse {
		t.Fatalf("Check(%s) = (true, %q), want allow", id, code)
	}
}

func TestDeclineThenCheckRefuses(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDecisionPending)
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)
	mustAllow(t, s, reqB)
}

func TestDeclineWithoutAwaitingStillRefuses(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	if err := s.Decline(reqA, ReasonDialogError); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)
}

func TestCheckIsCaseInsensitive(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	const lower = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	if err := s.Decline(lower, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	// An apply payload carrying the same id in another case must not slip past.
	mustRefuse(t, s, strings.ToUpper(lower), CodeUserDeclined)
}

func TestConsentRemovesAndAllows(t *testing.T) {
	s, path := newFileStore(t, newClock())
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Consent(reqA); err != nil {
		t.Fatal(err)
	}
	mustAllow(t, s, reqA)
	reloaded := NewStore(path, newClock().Now)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	mustAllow(t, reloaded, reqA)
}

func TestStoreSurvivesReload(t *testing.T) {
	clock := newClock()
	s, path := newFileStore(t, clock)
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	reloaded := NewStore(path, clock.Now)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, reloaded, reqA, CodeUserDeclined)
	due := reloaded.Due()
	if len(due) != 1 || due[0].RequestID != reqA || due[0].Reason != ReasonUserDenied || due[0].ServerStatus != "pending" {
		t.Fatalf("Due after reload = %+v", due)
	}
	if !due[0].DeclinedAt.Equal(clock.Now()) {
		t.Fatalf("DeclinedAt = %v, want %v", due[0].DeclinedAt, clock.Now())
	}
}

func TestAwaitingAtLoadBecomesDeclinedTimeout(t *testing.T) {
	clock := newClock()
	s, path := newFileStore(t, clock)
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BeginAwaiting(reqB, "auto_approved"); err != nil {
		t.Fatal(err)
	}
	// The process dies with both dialogs open.
	clock.Advance(time.Minute)
	reloaded := NewStore(path, clock.Now)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, reloaded, reqA, CodeUserDeclined)
	mustRefuse(t, reloaded, reqB, CodeUserDeclined)
	due := reloaded.Due()
	if len(due) != 1 || due[0].RequestID != reqA || due[0].Reason != ReasonUserTimeout {
		t.Fatalf("Due = %+v, want only the pending request as user_timeout", due)
	}
	// The conversion is persisted, not only applied in memory.
	again := NewStore(path, clock.Now)
	if err := again.Load(); err != nil {
		t.Fatal(err)
	}
	if e, ok := again.entry(reqA); !ok || e.State != StateDeclined || e.Reason != ReasonUserTimeout {
		t.Fatalf("entry after second reload = %+v, %v", e, ok)
	}
}

func TestAwaitBlocksUntilDecline(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	type answer struct {
		refuse bool
		code   string
	}
	got := make(chan answer, 1)
	go func() {
		r, c := s.Await(context.Background(), reqA)
		got <- answer{r, c}
	}()
	select {
	case a := <-got:
		t.Fatalf("Await returned %+v before the user answered", a)
	case <-time.After(50 * time.Millisecond):
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	select {
	case a := <-got:
		if !a.refuse || a.code != CodeUserDeclined {
			t.Fatalf("Await = %+v, want refuse user_declined", a)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Await did not return after Decline")
	}
}

func TestAwaitBlocksUntilConsent(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	got := make(chan bool, 1)
	go func() {
		r, _ := s.Await(context.Background(), reqA)
		got <- r
	}()
	select {
	case <-got:
		t.Fatal("Await returned before the user answered")
	case <-time.After(50 * time.Millisecond):
	}
	if err := s.Consent(reqA); err != nil {
		t.Fatal(err)
	}
	select {
	case refuse := <-got:
		if refuse {
			t.Fatal("Await refused after Consent")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Await did not return after Consent")
	}
}

func TestAwaitReturnsAtOnceWhenNoEntry(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if refuse, code := s.Await(ctx, reqA); refuse {
		t.Fatalf("Await on an unknown request refused with %q", code)
	}
	if ctx.Err() != nil {
		t.Fatal("Await blocked on an unknown request")
	}
}

func TestAwaitTimesOutAsDecisionPending(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	refuse, code := s.Await(ctx, reqA)
	if !refuse || code != CodeUserDecisionPending {
		t.Fatalf("Await = (%v, %q), want (true, %q)", refuse, code, CodeUserDecisionPending)
	}
}

func TestCorruptStoreFencesAllApplies(t *testing.T) {
	clock := newClock()
	path := filepath.Join(t.TempDir(), "pam-declined-requests.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := NewStore(path, clock.Now)
	if err := s.Load(); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Load = %v, want ErrCorrupt", err)
	}
	if _, err := os.Stat(path + ".corrupt"); err != nil {
		t.Fatalf("corrupt file not moved aside: %v", err)
	}
	mustRefuse(t, s, reqC, CodeDeclineRecordUntrusted)

	// The fence survives a restart: the quarantined file is gone, so the
	// fence must be in the replacement file.
	clock.Advance(time.Hour)
	restarted := NewStore(path, clock.Now)
	if err := restarted.Load(); err != nil {
		t.Fatalf("Load after quarantine: %v", err)
	}
	mustRefuse(t, restarted, reqB, CodeDeclineRecordUntrusted)

	clock.Advance(UntrustedLoadFence)
	mustAllow(t, s, reqC)
	mustAllow(t, restarted, reqB)
}

func TestUnknownSchemaOrBadEntryIsCorrupt(t *testing.T) {
	for name, body := range map[string]string{
		"newer schema":  `{"schemaVersion":99,"entries":{}}`,
		"bad id":        `{"schemaVersion":1,"entries":{"NOT-A-UUID":{"requestId":"NOT-A-UUID","state":"declined","reason":"user_denied"}}}`,
		"key mismatch":  fmt.Sprintf(`{"schemaVersion":1,"entries":{%q:{"requestId":%q,"state":"declined","reason":"user_denied"}}}`, reqA, reqB),
		"unknown state": fmt.Sprintf(`{"schemaVersion":1,"entries":{%q:{"requestId":%q,"state":"maybe"}}}`, reqA, reqA),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "pam-declined-requests.json")
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			s := NewStore(path, newClock().Now)
			if err := s.Load(); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("Load = %v, want ErrCorrupt", err)
			}
			mustRefuse(t, s, reqC, CodeDeclineRecordUntrusted)
		})
	}
}

func TestPersistFailureStillRefusesInProcess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permission bits do not block writes on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permission bits")
	}
	dir := filepath.Join(t.TempDir(), "ro")
	if err := os.Mkdir(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
	s := NewStore(filepath.Join(dir, "pam-declined-requests.json"), newClock().Now)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BeginAwaiting(reqA, "pending"); !errors.Is(err, ErrPersist) {
		t.Fatalf("BeginAwaiting = %v, want ErrPersist", err)
	}
	mustRefuse(t, s, reqA, CodeUserDecisionPending)
	if err := s.Decline(reqA, ReasonUserDenied); !errors.Is(err, ErrPersist) {
		t.Fatalf("Decline = %v, want ErrPersist", err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)
	if len(s.Due()) != 1 {
		t.Fatal("an unpersisted decline must still be delivered")
	}
}

func TestUnackedNeverPruned(t *testing.T) {
	clock := newClock()
	s, _ := newFileStore(t, clock)
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	clock.Advance(30 * 24 * time.Hour)
	if err := s.Prune(); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)
}

func TestAckedPrunedAfterSevenDays(t *testing.T) {
	clock := newClock()
	s, _ := newFileStore(t, clock)
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkAcked(reqA, "withdrawn"); err != nil {
		t.Fatal(err)
	}
	// An ack never clears the refusal.
	mustRefuse(t, s, reqA, CodeUserDeclined)
	if len(s.Due()) != 0 {
		t.Fatal("an acked entry is still due")
	}
	clock.Advance(AckedRetention - time.Minute)
	if err := s.Prune(); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)
	clock.Advance(2 * time.Minute)
	if err := s.Prune(); err != nil {
		t.Fatal(err)
	}
	mustAllow(t, s, reqA)
}

func uuidN(n int) string {
	return fmt.Sprintf("%08x-0000-4000-8000-%012x", n, n)
}

func TestMaxEntriesEvictsAckedFirst(t *testing.T) {
	clock := newClock()
	s := NewStore("", clock.Now)
	// Pending declines: an undeliverable one is settled at once (and so
	// acked), which would change which entry the cap evicts.
	declinePending := func(id string) {
		t.Helper()
		if _, err := s.BeginAwaiting(id, "pending"); err != nil {
			t.Fatal(err)
		}
		if err := s.Decline(id, ReasonUserDenied); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < MaxEntries; i++ {
		declinePending(uuidN(i))
		clock.Advance(time.Second)
	}
	// The newest-but-one entry is acked; the oldest is not.
	acked := uuidN(MaxEntries - 2)
	if err := s.MarkAcked(acked, "withdrawn"); err != nil {
		t.Fatal(err)
	}
	declinePending(uuidN(MaxEntries))
	if n := s.Len(); n != MaxEntries {
		t.Fatalf("Len = %d, want %d", n, MaxEntries)
	}
	mustAllow(t, s, acked)
	mustRefuse(t, s, uuidN(0), CodeUserDeclined)
	mustRefuse(t, s, uuidN(MaxEntries), CodeUserDeclined)

	// With nothing acked left, the oldest overall goes.
	declinePending(uuidN(MaxEntries + 1))
	mustAllow(t, s, uuidN(0))
	mustRefuse(t, s, uuidN(1), CodeUserDeclined)
}

func TestDueOnlyPendingDeclinedUnacked(t *testing.T) {
	clock := newClock()
	s, _ := newFileStore(t, clock)
	for _, setup := range []struct {
		id     string
		status string
	}{{reqA, "pending"}, {reqB, "auto_approved"}, {reqC, "pending"}} {
		if _, err := s.BeginAwaiting(setup.id, setup.status); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqB, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	// reqC stays awaiting: not due.
	due := s.Due()
	if len(due) != 1 || due[0].RequestID != reqA {
		t.Fatalf("Due = %+v, want only reqA", due)
	}
	next := clock.Now().Add(time.Minute)
	if err := s.MarkAttempt(reqA, next); err != nil {
		t.Fatal(err)
	}
	if len(s.Due()) != 0 {
		t.Fatal("an entry is due before its NextAttemptAt")
	}
	clock.Advance(time.Minute)
	due = s.Due()
	if len(due) != 1 || due[0].Attempts != 1 {
		t.Fatalf("Due after backoff = %+v", due)
	}
}

func TestRejectsNonCanonicalUUID(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	for _, id := range []string{"", "not-a-uuid", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-111111111111 "} {
		if _, err := s.BeginAwaiting(id, "pending"); err == nil {
			t.Errorf("BeginAwaiting(%q) accepted a non-canonical id", id)
		}
		if err := s.Decline(id, ReasonUserDenied); err == nil {
			t.Errorf("Decline(%q) accepted a non-canonical id", id)
		}
	}
	if _, err := s.BeginAwaiting("11111111-1111-4111-8111-11111111111A", "pending"); err == nil {
		t.Error("BeginAwaiting accepted an upper-case id")
	}
	if err := s.Decline(reqA, Reason("other")); err == nil {
		t.Error("Decline accepted an unknown reason")
	}
	if s.Len() != 0 {
		t.Fatalf("rejected calls left %d entries", s.Len())
	}
}

func TestBeginAwaitingDoesNotResurrectDeclined(t *testing.T) {
	clock := newClock()
	s, _ := newFileStore(t, clock)
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	first, _ := s.entry(reqA)
	clock.Advance(time.Minute)

	already, err := s.BeginAwaiting(reqA, "pending")
	if err != nil || !already {
		t.Fatalf("BeginAwaiting on a declined entry = (%v, %v), want (true, nil)", already, err)
	}
	if err := s.Consent(reqA); err != nil {
		t.Fatal(err)
	}
	if err := s.Release(reqA); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserTimeout); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)
	after, _ := s.entry(reqA)
	if !after.DeclinedAt.Equal(first.DeclinedAt) || after.Reason != ReasonUserDenied {
		t.Fatalf("decline changed: before %+v, after %+v", first, after)
	}
}

func TestReleaseRemovesAwaitingAndWakesWaiters(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	done := make(chan bool, 1)
	go func() {
		r, _ := s.Await(context.Background(), reqA)
		done <- r
	}()
	time.Sleep(20 * time.Millisecond)
	if err := s.Release(reqA); err != nil {
		t.Fatal(err)
	}
	select {
	case refuse := <-done:
		if refuse {
			t.Fatal("Await refused after Release")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Await did not return after Release")
	}
	mustAllow(t, s, reqA)
}

func TestFileModeIs0600(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits only")
	}
	s, path := newFileStore(t, newClock())
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("mode = %o, want 600", mode)
	}
}

func TestMemoryOnlyStoreWorks(t *testing.T) {
	s := NewStore("", newClock().Now)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)
}

func TestDeclineIfAwaitingOnlyTouchesAwaiting(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	// Absent: nothing recorded (an approved request has no entry).
	if declined, err := s.DeclineIfAwaiting(reqA, ReasonDialogError); err != nil || declined {
		t.Fatalf("DeclineIfAwaiting on absent = (%v, %v)", declined, err)
	}
	mustAllow(t, s, reqA)
	// Awaiting: declined with the given reason.
	if _, err := s.BeginAwaiting(reqB, "pending"); err != nil {
		t.Fatal(err)
	}
	if declined, err := s.DeclineIfAwaiting(reqB, ReasonDialogError); err != nil || !declined {
		t.Fatalf("DeclineIfAwaiting on awaiting = (%v, %v)", declined, err)
	}
	if e, _ := s.entry(reqB); e.State != StateDeclined || e.Reason != ReasonDialogError {
		t.Fatalf("entry = %+v", e)
	}
	// Declined: first reason kept.
	if declined, err := s.DeclineIfAwaiting(reqB, ReasonUserTimeout); err != nil || declined {
		t.Fatalf("DeclineIfAwaiting on declined = (%v, %v)", declined, err)
	}
	if e, _ := s.entry(reqB); e.Reason != ReasonDialogError {
		t.Fatalf("reason changed to %q", e.Reason)
	}
}

func TestConcurrentUseIsRaceFree(t *testing.T) {
	s, _ := newFileStore(t, newClock())
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := uuidN(i)
			_, _ = s.BeginAwaiting(id, "pending")
			go func() { _, _ = s.Await(context.Background(), id) }()
			_, _ = s.Check(id)
			if i%2 == 0 {
				_ = s.Decline(id, ReasonUserDenied)
			} else {
				_ = s.Consent(id)
			}
			_ = s.Due()
			_ = s.Prune()
		}(i)
	}
	wg.Wait()
}

// writeGarbage puts an undecodable decline file at a fresh path.
func writeGarbage(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pam-declined-requests.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// Review fix (#10420): the fence written after a quarantine is the only thing
// that keeps a restart within the window refusing. When that write fails, the
// corrupt file goes back in place so the next Load fences again, and the
// in-memory fence still holds in this process.
func TestCorruptFenceWriteFailureRestoresCorruptFile(t *testing.T) {
	clock := newClock()
	path := writeGarbage(t)
	s := NewStore(path, clock.Now)
	s.writeFault = func() error { return errors.New("disk full") }

	err := s.Load()
	if !errors.Is(err, ErrCorrupt) || !errors.Is(err, ErrPersist) {
		t.Fatalf("Load = %v, want ErrCorrupt and ErrPersist", err)
	}
	mustRefuse(t, s, reqC, CodeDeclineRecordUntrusted)
	if _, err := os.Stat(path + ".corrupt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the .corrupt file was not restored (stat err %v)", err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "{not json" {
		t.Fatalf("restored file = %q, %v; want the original corrupt bytes", data, err)
	}

	// A restart within the window fences again.
	clock.Advance(time.Hour)
	restarted := NewStore(path, clock.Now)
	if err := restarted.Load(); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Load after a failed fence write = %v, want ErrCorrupt again", err)
	}
	mustRefuse(t, restarted, reqB, CodeDeclineRecordUntrusted)
}

// A quarantine rename that fails must not let the fence write overwrite the
// original file: it stays in place, and the next Load fences again.
func TestCorruptQuarantineRenameFailureKeepsOriginal(t *testing.T) {
	clock := newClock()
	path := writeGarbage(t)
	s := NewStore(path, clock.Now)
	s.renameFn = func(string, string) error { return errors.New("sharing violation") }

	err := s.Load()
	if !errors.Is(err, ErrCorrupt) || !errors.Is(err, ErrPersist) {
		t.Fatalf("Load = %v, want ErrCorrupt and ErrPersist", err)
	}
	mustRefuse(t, s, reqC, CodeDeclineRecordUntrusted)
	if _, err := s.BeginAwaiting(reqA, "pending"); !errors.Is(err, ErrPersist) {
		t.Fatalf("BeginAwaiting after a failed quarantine = %v, want ErrPersist (no write over the original)", err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "{not json" {
		t.Fatalf("file = %q, %v; want the original corrupt bytes", data, err)
	}
}

// Review fix (#10420): a read error (access denied, EIO, an AV sharing
// violation at boot) is not corruption. The file and its un-acked declines
// stay on disk and are not rewritten; this process fences every apply in
// memory instead.
func TestReadErrorFencesInMemoryAndKeepsFile(t *testing.T) {
	clock := newClock()
	first, path := newFileStore(t, clock)
	if _, err := first.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := first.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	s := NewStore(path, clock.Now)
	s.readFileFn = func(string) ([]byte, error) { return nil, errors.New("access is denied") }
	err = s.Load()
	if !errors.Is(err, ErrUnreadable) || errors.Is(err, ErrCorrupt) {
		t.Fatalf("Load = %v, want ErrUnreadable and not ErrCorrupt", err)
	}
	if _, err := os.Stat(path + ".corrupt"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("an unreadable file was quarantined (stat err %v)", err)
	}
	mustRefuse(t, s, reqA, CodeDeclineRecordUntrusted)
	mustRefuse(t, s, reqC, CodeDeclineRecordUntrusted)

	// New answers are enforced in memory but never written over the file.
	if _, err := s.BeginAwaiting(reqB, "pending"); !errors.Is(err, ErrPersist) {
		t.Fatalf("BeginAwaiting = %v, want ErrPersist", err)
	}
	if err := s.Decline(reqB, ReasonUserDenied); !errors.Is(err, ErrPersist) {
		t.Fatalf("Decline = %v, want ErrPersist", err)
	}
	if now, err := os.ReadFile(path); err != nil || string(now) != string(original) {
		t.Fatalf("file changed after a read error: %q, %v", now, err)
	}

	// A restart that can read the file gets the unsent decline back.
	restarted := NewStore(path, clock.Now)
	if err := restarted.Load(); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, restarted, reqA, CodeUserDeclined)
	if due := restarted.Due(); len(due) != 1 || due[0].RequestID != reqA {
		t.Fatalf("Due after restart = %+v, want the unsent decline", due)
	}
}

// Review fix (#10420): a decline the server can never be told about (an
// auto_approved request, or one with no recorded ingest status) is settled
// locally at decline time, so the 7-day prune applies instead of the cap.
func TestUndeliverableDeclineSettledAndPruned(t *testing.T) {
	clock := newClock()
	s, path := newFileStore(t, clock)
	if _, err := s.BeginAwaiting(reqA, "auto_approved"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BeginAwaiting(reqB, "auto_approved"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeclineIfAwaiting(reqB, ReasonDialogError); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqC, ReasonUserTimeout); err != nil { // no entry, no status
		t.Fatal(err)
	}
	for _, id := range []string{reqA, reqB, reqC} {
		e, ok := s.entry(id)
		if !ok || e.AckedAt.IsZero() || !e.AckedAt.Equal(e.DeclinedAt) || e.AckOutcome != AckOutcomeNotDelivered {
			t.Fatalf("entry %s = %+v, want settled at its decline time as %q", id, e, AckOutcomeNotDelivered)
		}
		mustRefuse(t, s, id, CodeUserDeclined)
	}
	if due := s.Due(); len(due) != 0 {
		t.Fatalf("Due = %+v, want nothing to deliver", due)
	}

	// An auto_approved dialog that died with the process is settled at load.
	if _, err := s.BeginAwaiting(uuidN(7), "auto_approved"); err != nil {
		t.Fatal(err)
	}
	reloaded := NewStore(path, clock.Now)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	if e, _ := reloaded.entry(uuidN(7)); e.AckOutcome != AckOutcomeNotDelivered || e.AckedAt.IsZero() {
		t.Fatalf("converted auto_approved entry = %+v, want settled", e)
	}

	clock.Advance(AckedRetention - time.Minute)
	if err := reloaded.Prune(); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, reloaded, reqA, CodeUserDeclined)
	clock.Advance(2 * time.Minute)
	if err := reloaded.Prune(); err != nil {
		t.Fatal(err)
	}
	if n := reloaded.Len(); n != 0 {
		t.Fatalf("Len after the prune = %d, want every settled entry pruned", n)
	}
	mustAllow(t, reloaded, reqA)
}
