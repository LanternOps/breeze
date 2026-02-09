package ipc

import (
	"testing"
	"time"
)

func TestRateLimiterAllow(t *testing.T) {
	rl := NewRateLimiter(3, 1*time.Second)

	// First 3 should be allowed
	for i := 0; i < 3; i++ {
		if !rl.Allow("1000") {
			t.Errorf("attempt %d should be allowed", i+1)
		}
	}

	// 4th should be rejected
	if rl.Allow("1000") {
		t.Error("4th attempt should be rejected")
	}

	// Different identity should be allowed
	if !rl.Allow("2000") {
		t.Error("different identity should be allowed")
	}
}

func TestRateLimiterWindowExpiry(t *testing.T) {
	rl := NewRateLimiter(2, 100*time.Millisecond)

	if !rl.Allow("1000") {
		t.Error("first attempt should be allowed")
	}
	if !rl.Allow("1000") {
		t.Error("second attempt should be allowed")
	}
	if rl.Allow("1000") {
		t.Error("third attempt should be rejected")
	}

	// Wait for window to expire
	time.Sleep(150 * time.Millisecond)

	if !rl.Allow("1000") {
		t.Error("should be allowed after window expires")
	}
}

func TestRateLimiterReset(t *testing.T) {
	rl := NewRateLimiter(1, 1*time.Minute)

	if !rl.Allow("1000") {
		t.Error("first should be allowed")
	}
	if rl.Allow("1000") {
		t.Error("second should be rejected")
	}

	rl.Reset()

	if !rl.Allow("1000") {
		t.Error("should be allowed after reset")
	}
}

func TestRateLimiterMultipleIdentities(t *testing.T) {
	rl := NewRateLimiter(2, 1*time.Second)

	for _, key := range []string{"100", "200", "S-1-5-21-123-456"} {
		if !rl.Allow(key) {
			t.Errorf("identity %s first attempt should be allowed", key)
		}
		if !rl.Allow(key) {
			t.Errorf("identity %s second attempt should be allowed", key)
		}
		if rl.Allow(key) {
			t.Errorf("identity %s third attempt should be rejected", key)
		}
	}
}
