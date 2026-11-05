package heartbeat

import (
	"errors"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

var deferralEpoch = time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)

type fakeDeferralClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeDeferralClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeDeferralClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func newTestDeferral() (*loopDeferral, *fakeDeferralClock) {
	clk := &fakeDeferralClock{now: deferralEpoch}
	return &loopDeferral{now: clk.Now}, clk
}

func retryAtErr(at time.Time) error {
	return fmt.Errorf("send: %w", &httputil.RetryableStatusError{StatusCode: http.StatusServiceUnavailable, URL: "u", RetryAt: at})
}

const softwareKey = "https://api.example.invalid PUT /api/v1/agents/:id/software"

func TestDeferralBlocksUntilRetryAt(t *testing.T) {
	d, clk := newTestDeferral()
	if ok, _ := d.Ready(softwareKey); !ok {
		t.Fatal("empty store not ready")
	}
	if _, set := d.Record(softwareKey, retryAtErr(deferralEpoch.Add(150*time.Second))); !set {
		t.Fatal("Record did not set a deferral")
	}
	clk.Advance(149 * time.Second)
	if ok, until := d.Ready(softwareKey); ok || !until.Equal(deferralEpoch.Add(150*time.Second)) {
		t.Fatalf("Ready at 149s = (%v, %v), want blocked until 150s", ok, until)
	}
	clk.Advance(time.Second)
	if ok, _ := d.Ready(softwareKey); !ok {
		t.Fatal("still blocked at RetryAt")
	}
}

func TestDeferralKeyIncludesOriginAndMethod(t *testing.T) {
	a := loopKey("PUT", "https://primary.example.invalid/api/v1/agents/agent-1/software")
	b := loopKey("PUT", "https://backup.example.invalid/api/v1/agents/agent-1/software")
	c := loopKey("POST", "https://primary.example.invalid/api/v1/agents/agent-1/software")
	if a == b || a == c {
		t.Fatalf("keys collide: %q %q %q", a, b, c)
	}
	d, _ := newTestDeferral()
	d.Record(a, retryAtErr(deferralEpoch.Add(time.Minute)))
	if ok, _ := d.Ready(b); !ok {
		t.Fatal("a deferral on the old primary blocked the promoted backup")
	}
}

func TestDeferralKeyNormalisesIDs(t *testing.T) {
	a := loopKey("PUT", "https://api.example.invalid/api/v1/agents/1b4e28ba-2fa1-11d2-883f-0016d3cca427/software")
	b := loopKey("PUT", "https://api.example.invalid/api/v1/agents/agent-2/software")
	if a != b {
		t.Fatalf("agent ids not normalised: %q vs %q", a, b)
	}
	if a != "https://api.example.invalid PUT /api/v1/agents/:id/software" {
		t.Fatalf("key = %q", a)
	}
	c1 := loopKey("POST", "https://api.example.invalid/api/v1/agents/a/commands/1b4e28ba-2fa1-11d2-883f-0016d3cca427/result")
	c2 := loopKey("POST", "https://api.example.invalid/api/v1/agents/a/commands/6fa459ea-ee8a-3ca4-894e-db77e160355e/result")
	if c1 != c2 {
		t.Fatalf("command ids not normalised: %q vs %q", c1, c2)
	}
	if s := loopKey("PUT", "https://api.example.invalid/api/v1/agents/a/security/recovery-keys"); s != "https://api.example.invalid PUT /api/v1/agents/:id/security/recovery-keys" {
		t.Fatalf("route name mangled: %q", s)
	}
}

func TestSkipDoesNotExtendDeferral(t *testing.T) {
	d, clk := newTestDeferral()
	at := deferralEpoch.Add(time.Minute)
	d.Record(softwareKey, retryAtErr(at))
	for i := 0; i < 5; i++ {
		clk.Advance(10 * time.Second)
		if _, until := d.Ready(softwareKey); !until.Equal(at) {
			t.Fatalf("skip %d moved the deferral to %v", i, until)
		}
	}
}

func TestLaterRetryAtWins(t *testing.T) {
	d, _ := newTestDeferral()
	late, early := deferralEpoch.Add(3*time.Minute), deferralEpoch.Add(time.Minute)
	d.Record(softwareKey, retryAtErr(late))
	if _, set := d.Record(softwareKey, retryAtErr(early)); set {
		t.Fatal("an earlier RetryAt replaced a later one")
	}
	if _, until := d.Ready(softwareKey); !until.Equal(late) {
		t.Fatalf("until = %v, want %v", until, late)
	}
}

func TestRecordWithoutRetryAtKeepsDeferral(t *testing.T) {
	d, _ := newTestDeferral()
	at := deferralEpoch.Add(time.Minute)
	d.Record(softwareKey, retryAtErr(at))
	for _, err := range []error{errors.New("connection reset"), &httputil.RetryableStatusError{StatusCode: 503}, nil} {
		if _, set := d.Record(softwareKey, err); set {
			t.Fatalf("Record(%v) changed the deferral", err)
		}
	}
	if ok, until := d.Ready(softwareKey); ok || !until.Equal(at) {
		t.Fatalf("deferral lost: (%v, %v)", ok, until)
	}
}

func TestDeferralConcurrentRecordReady(t *testing.T) {
	d, clk := newTestDeferral()
	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			key := fmt.Sprintf("k%d", g%4)
			for i := 0; i < 200; i++ {
				d.Record(key, retryAtErr(deferralEpoch.Add(time.Duration(i)*time.Second)))
				d.Ready(key)
				if g == 0 && i%50 == 0 {
					clk.Advance(time.Second)
				}
			}
		}(g)
	}
	wg.Wait()
}

func TestDeferralDisabledByConfig(t *testing.T) {
	httputil.SetLoopRetryAfter(false)
	t.Cleanup(func() { httputil.SetLoopRetryAfter(true) })
	d, _ := newTestDeferral()
	if _, set := d.Record(softwareKey, retryAtErr(deferralEpoch.Add(time.Hour))); set {
		t.Fatal("Record set a deferral with loop_retry_after=false")
	}
	if ok, _ := d.Ready(softwareKey); !ok {
		t.Fatal("Ready blocked with loop_retry_after=false")
	}
}

func TestZeroValueDeferralIsUsable(t *testing.T) {
	var d loopDeferral
	if ok, _ := d.Ready("k"); !ok {
		t.Fatal("zero value not ready")
	}
	if _, set := d.Record("k", retryAtErr(time.Now().Add(time.Minute))); !set {
		t.Fatal("zero value could not record")
	}
	if ok, _ := d.Ready("k"); ok {
		t.Fatal("zero value did not block after Record")
	}
}
