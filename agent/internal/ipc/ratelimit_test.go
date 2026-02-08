package ipc

import (
	"testing"
	"time"
)

func TestRateLimiterAllow(t *testing.T) {
	rl := NewRateLimiter(3, 1*time.Second)

	// First 3 should be allowed
	for i := 0; i < 3; i++ {
		if !rl.Allow(1000) {
			t.Errorf("attempt %d should be allowed", i+1)
		}
	}

	// 4th should be rejected
	if rl.Allow(1000) {
		t.Error("4th attempt should be rejected")
	}

	// Different UID should be allowed
	if !rl.Allow(2000) {
		t.Error("different UID should be allowed")
	}
}

func TestRateLimiterWindowExpiry(t *testing.T) {
	rl := NewRateLimiter(2, 100*time.Millisecond)

	if !rl.Allow(1000) {
		t.Error("first attempt should be allowed")
	}
	if !rl.Allow(1000) {
		t.Error("second attempt should be allowed")
	}
	if rl.Allow(1000) {
		t.Error("third attempt should be rejected")
	}

	// Wait for window to expire
	time.Sleep(150 * time.Millisecond)

	if !rl.Allow(1000) {
		t.Error("should be allowed after window expires")
	}
}

func TestRateLimiterReset(t *testing.T) {
	rl := NewRateLimiter(1, 1*time.Minute)

	if !rl.Allow(1000) {
		t.Error("first should be allowed")
	}
	if rl.Allow(1000) {
		t.Error("second should be rejected")
	}

	rl.Reset()

	if !rl.Allow(1000) {
		t.Error("should be allowed after reset")
	}
}

func TestRateLimiterMultipleUIDs(t *testing.T) {
	rl := NewRateLimiter(2, 1*time.Second)

	for _, uid := range []uint32{100, 200, 300} {
		if !rl.Allow(uid) {
			t.Errorf("UID %d first attempt should be allowed", uid)
		}
		if !rl.Allow(uid) {
			t.Errorf("UID %d second attempt should be allowed", uid)
		}
		if rl.Allow(uid) {
			t.Errorf("UID %d third attempt should be rejected", uid)
		}
	}
}
