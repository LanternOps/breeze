package sessionbroker

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeTicketClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeTicketClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeTicketClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func newTestTickets() (*linuxDesktopTickets, *fakeTicketClock) {
	clk := &fakeTicketClock{now: time.Unix(1_800_000_000, 0)}
	return newLinuxDesktopTickets(clk.Now), clk
}

func testBinding(session string, gen uint64) LinuxDesktopBinding {
	return LinuxDesktopBinding{UID: 1000, Username: "alice", LogindSessionID: session, Generation: gen}
}

func mustIssue(t *testing.T, tk *linuxDesktopTickets, b LinuxDesktopBinding) string {
	t.Helper()
	nonce, err := tk.issue(b)
	if err != nil {
		t.Fatalf("issue(%+v): %v", b, err)
	}
	return nonce
}

func TestLinuxDesktopTicket_RoundTrip(t *testing.T) {
	tk, _ := newTestTickets()
	want := testBinding("3", 1)
	nonce := mustIssue(t, tk, want)
	if len(nonce) != 43 { // 32 bytes, base64url without padding
		t.Fatalf("nonce length = %d, want 43", len(nonce))
	}
	got, err := tk.consume(nonce, "3", 1000)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if got != want {
		t.Fatalf("binding = %+v, want %+v", got, want)
	}
}

func TestLinuxDesktopTicket_SingleUse(t *testing.T) {
	tk, _ := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	if _, err := tk.consume(nonce, "3", 1000); err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if _, err := tk.consume(nonce, "3", 1000); !errors.Is(err, errTicketUnknown) {
		t.Fatalf("second consume err = %v, want errTicketUnknown", err)
	}
}

func TestLinuxDesktopTicket_Expired(t *testing.T) {
	tk, clk := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	clk.Advance(linuxDesktopTicketTTL + time.Nanosecond)
	if _, err := tk.consume(nonce, "3", 1000); !errors.Is(err, errTicketExpired) {
		t.Fatalf("err = %v, want errTicketExpired", err)
	}
}

func TestLinuxDesktopTicket_AtTTLStillValid(t *testing.T) {
	tk, clk := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	clk.Advance(linuxDesktopTicketTTL)
	if _, err := tk.consume(nonce, "3", 1000); err != nil {
		t.Fatalf("consume at exactly TTL: %v", err)
	}
}

func TestLinuxDesktopTicket_UIDMismatch(t *testing.T) {
	tk, _ := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	if _, err := tk.consume(nonce, "3", 1001); !errors.Is(err, errTicketUIDMismatch) {
		t.Fatalf("err = %v, want errTicketUIDMismatch", err)
	}
}

func TestLinuxDesktopTicket_RootPeerRejected(t *testing.T) {
	tk, _ := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	if _, err := tk.consume(nonce, "3", 0); !errors.Is(err, errTicketUIDMismatch) {
		t.Fatalf("err = %v, want errTicketUIDMismatch for uid 0", err)
	}
}

func TestLinuxDesktopTicket_SessionMismatch(t *testing.T) {
	tk, _ := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	if _, err := tk.consume(nonce, "4", 1000); !errors.Is(err, errTicketSessionMismatch) {
		t.Fatalf("err = %v, want errTicketSessionMismatch", err)
	}
}

func TestLinuxDesktopTicket_StaleGeneration(t *testing.T) {
	tk, _ := newTestTickets()
	gen1 := mustIssue(t, tk, testBinding("3", 1))
	gen2 := mustIssue(t, tk, testBinding("3", 2))
	if _, err := tk.consume(gen1, "3", 1000); !errors.Is(err, errTicketUnknown) {
		t.Fatalf("gen 1 consume err = %v, want errTicketUnknown", err)
	}
	if _, err := tk.consume(gen2, "3", 1000); err != nil {
		t.Fatalf("gen 2 consume: %v", err)
	}
}

// A generation that does not move forward for its session is refused at
// issue time, so an older spawn can never be re-armed.
func TestLinuxDesktopTicket_NonIncreasingGenerationRefused(t *testing.T) {
	tk, _ := newTestTickets()
	mustIssue(t, tk, testBinding("3", 5))
	for _, gen := range []uint64{5, 4} {
		if _, err := tk.issue(testBinding("3", gen)); !errors.Is(err, errTicketStaleGeneration) {
			t.Fatalf("issue gen %d err = %v, want errTicketStaleGeneration", gen, err)
		}
	}
	// Other sessions keep their own sequence.
	mustIssue(t, tk, testBinding("4", 1))
}

func TestLinuxDesktopTicket_FailedConsumeBurnsNonce(t *testing.T) {
	tk, _ := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	if _, err := tk.consume(nonce, "3", 1001); !errors.Is(err, errTicketUIDMismatch) {
		t.Fatalf("mismatch consume err = %v", err)
	}
	if _, err := tk.consume(nonce, "3", 1000); !errors.Is(err, errTicketUnknown) {
		t.Fatalf("retry err = %v, want errTicketUnknown", err)
	}
}

func TestLinuxDesktopTicket_RevokeSession(t *testing.T) {
	tk, _ := newTestTickets()
	n3 := mustIssue(t, tk, testBinding("3", 1))
	n4 := mustIssue(t, tk, testBinding("4", 1))
	tk.revokeSession("3")
	if _, err := tk.consume(n3, "3", 1000); !errors.Is(err, errTicketUnknown) {
		t.Fatalf("revoked consume err = %v, want errTicketUnknown", err)
	}
	if _, err := tk.consume(n4, "4", 1000); err != nil {
		t.Fatalf("other session consume: %v", err)
	}
}

func TestLinuxDesktopTicket_Cap(t *testing.T) {
	tk, _ := newTestTickets()
	for i := 0; i < maxLinuxDesktopTickets; i++ {
		mustIssue(t, tk, testBinding(string(rune('a'+i)), 1))
	}
	if _, err := tk.issue(testBinding("z", 1)); !errors.Is(err, errTicketStoreFull) {
		t.Fatalf("17th issue err = %v, want errTicketStoreFull", err)
	}
}

// Expired tickets do not count against the cap.
func TestLinuxDesktopTicket_CapIgnoresExpired(t *testing.T) {
	tk, clk := newTestTickets()
	for i := 0; i < maxLinuxDesktopTickets; i++ {
		mustIssue(t, tk, testBinding(string(rune('a'+i)), 1))
	}
	clk.Advance(linuxDesktopTicketTTL + time.Second)
	mustIssue(t, tk, testBinding("z", 1))
}

func TestLinuxDesktopTicket_InvalidBindingRefused(t *testing.T) {
	tk, _ := newTestTickets()
	cases := map[string]LinuxDesktopBinding{
		"uid 0":            {UID: 0, LogindSessionID: "3", Generation: 1},
		"empty session":    {UID: 1000, LogindSessionID: "", Generation: 1},
		"session with dot": {UID: 1000, LogindSessionID: "../3", Generation: 1},
		"overlong session": {UID: 1000, LogindSessionID: "123456789012345678901234567890123", Generation: 1},
		"generation 0":     {UID: 1000, LogindSessionID: "3", Generation: 0},
	}
	for name, b := range cases {
		if _, err := tk.issue(b); err == nil {
			t.Errorf("%s: issue accepted %+v", name, b)
		}
	}
}

func TestLinuxDesktopTicket_EmptyNonceUnknown(t *testing.T) {
	tk, _ := newTestTickets()
	mustIssue(t, tk, testBinding("3", 1))
	if _, err := tk.consume("", "3", 1000); !errors.Is(err, errTicketUnknown) {
		t.Fatalf("err = %v, want errTicketUnknown", err)
	}
}

func TestLinuxDesktopTicket_ConcurrentConsume(t *testing.T) {
	tk, _ := newTestTickets()
	nonce := mustIssue(t, tk, testBinding("3", 1))
	var wins atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, err := tk.consume(nonce, "3", 1000); err == nil {
				wins.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	if got := wins.Load(); got != 1 {
		t.Fatalf("successful consumes = %d, want exactly 1", got)
	}
}
