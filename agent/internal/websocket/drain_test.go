package websocket

import (
	"math/rand/v2"
	"testing"
	"time"
)

// W09 (#8148, D4): the server may send {"type":"drain","reconnectWithinMs":N}
// before it closes a socket. The agent spreads its redial uniformly over
// max(N, 5 s) from the close. The sender is W5c's; this is the agent side.

func TestDrainHintValidation(t *testing.T) {
	cases := []struct {
		raw    string
		ok     bool
		within time.Duration
	}{
		{`{"type":"drain","reconnectWithinMs":120000}`, true, 120 * time.Second},
		{`{"type":"drain","reconnectWithinMs":0}`, true, 0},
		{`{"type":"drain","reconnectWithinMs":900000}`, true, 600 * time.Second},
		{`{"type":"drain","reconnectWithinMs":-1}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":1.5}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":1e3}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":"120000"}`, false, 0},
		{`{"type":"drain"}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":null}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":true}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":99999999999999999999999}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":120000,"reason":"rolling-deploy"}`, true, 120 * time.Second},
		{`not json`, false, 0},
	}
	for _, tc := range cases {
		within, ok := parseDrainHint([]byte(tc.raw))
		if ok != tc.ok || within != tc.within {
			t.Errorf("parseDrainHint(%s) = (%v, %v), want (%v, %v)", tc.raw, within, ok, tc.within, tc.ok)
		}
	}
}

// Spec acceptance: "10k simulated agents told 'reconnect within 120 s' arrive
// spread over 120 s ±10 %". Each 10 s bucket expects 833 (σ ≈ 28), so ±10 %
// is about 3σ; the seed is fixed, so the test is deterministic. If a later
// change to how the backoff consumes randomness trips it, run the body over
// ~50 seeds and check the failure rate is near the expected ~3 % before
// changing the seed.
func TestDrainSpread10kAgents(t *testing.T) {
	r := rand.New(rand.NewPCG(8148, 9))
	b := newReconnectBackoff(r.Float64)
	const agents, window = 10000, 120 * time.Second
	var buckets [12]int
	var maxDelay time.Duration
	for i := 0; i < agents; i++ {
		d := b.afterDrainedDisconnect(disconnectServerNormal, time.Hour, window)
		if d < 0 || d > window {
			t.Fatalf("agent %d delay %v outside [0, %v]", i, d, window)
		}
		maxDelay = max(maxDelay, d)
		bk := int(d / (10 * time.Second))
		if bk == 12 {
			bk = 11
		}
		buckets[bk]++
	}
	mean := float64(agents) / 12
	for i, n := range buckets {
		if float64(n) < mean*0.9 || float64(n) > mean*1.1 {
			t.Fatalf("bucket %d has %d arrivals, want %.0f ±10%%: %v", i, n, mean, buckets)
		}
	}
	if maxDelay < window*95/100 {
		t.Fatalf("latest arrival %v: the window shrank (want ≥ %v)", maxDelay, window*95/100)
	}
}

func TestAfterDrainedDisconnect(t *testing.T) {
	tests := []struct {
		name   string
		kind   disconnectKind
		lasted time.Duration
		within time.Duration
		r      float64
		want   time.Duration
	}{
		{"stable normal: U(0, N)", disconnectServerNormal, time.Minute, 120 * time.Second, 0.5, 60 * time.Second},
		{"stable abnormal (1012): max(U(0, N), jitter(1 s))", disconnectAbnormal, time.Minute, 120 * time.Second, 0.5, 60 * time.Second},
		{"stable abnormal, tiny window: jitter(1 s) wins over U(0, 5 s) at r=0.1", disconnectAbnormal, time.Minute, 0, 0.1, 760 * time.Millisecond},
		{"stable, N below 5 s widens to 5 s", disconnectServerNormal, time.Minute, 2 * time.Second, 0.5, 2500 * time.Millisecond},
		{"stable, N = 0 at r=0 keeps the floor", disconnectServerNormal, time.Minute, 0, 0, minReconnectDelay},
		{"short-lived: max(#9145 wait, U(0, N))", disconnectServerNormal, time.Second, 120 * time.Second, 0.5, 60 * time.Second},
		{"short-lived, N = 0: the #9145 wait", disconnectServerNormal, time.Second, 0, 0.5, 3 * time.Second},
		{"local ignores the hint", disconnectLocal, time.Minute, 120 * time.Second, 0.5, 625 * time.Millisecond},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := newReconnectBackoff(fixedRand(tt.r))
			if got := b.afterDrainedDisconnect(tt.kind, tt.lasted, tt.within); got != tt.want {
				t.Fatalf("afterDrainedDisconnect = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAfterDrainedDisconnectStepBookkeepingMatchesNoHint(t *testing.T) {
	// The hint changes the wait, never the step: the next dial failure backs
	// off exactly as it would have without the hint.
	for _, kind := range []disconnectKind{disconnectServerNormal, disconnectAbnormal, disconnectLocal} {
		for _, lasted := range []time.Duration{time.Second, time.Minute} {
			hinted := newReconnectBackoff(fixedRand(0.5))
			plain := newReconnectBackoff(fixedRand(0.5))
			hinted.step, plain.step = 8*time.Second, 8*time.Second
			hinted.afterDrainedDisconnect(kind, lasted, 120*time.Second)
			plain.afterDisconnect(kind, lasted)
			if hinted.step != plain.step {
				t.Fatalf("kind %v lasted %v: step with hint %v, without %v", kind, lasted, hinted.step, plain.step)
			}
		}
	}
}
