package discovery

import (
	"net"
	"testing"
	"time"
)

func TestPingSweepEmptyTargets(t *testing.T) {
	result := PingSweep(nil, time.Second, 4)
	if result != nil {
		t.Fatalf("PingSweep(nil) should return nil, got %v", result)
	}
}

func TestPingSweepEmptySlice(t *testing.T) {
	result := PingSweep([]net.IP{}, time.Second, 4)
	if result != nil {
		t.Fatalf("PingSweep([]) should return nil, got %v", result)
	}
}

func TestPingSweepDefaultTimeout(t *testing.T) {
	// Zero timeout should not panic - function should handle it gracefully.
	// ICMP requires root so this will likely return nil on non-root, but
	// it should not crash.
	result := PingSweep([]net.IP{net.ParseIP("192.0.2.1")}, 0, 1)
	// We cannot assert the result since ICMP availability depends on privileges.
	_ = result
}

func TestPingSweepDefaultWorkers(t *testing.T) {
	// Zero/negative workers should not panic.
	result := PingSweep([]net.IP{net.ParseIP("192.0.2.1")}, time.Second, 0)
	_ = result
	result = PingSweep([]net.IP{net.ParseIP("192.0.2.1")}, time.Second, -1)
	_ = result
}

func TestPingResultStruct(t *testing.T) {
	ip := net.ParseIP("10.0.0.1")
	pr := PingResult{IP: ip, RTT: 5 * time.Millisecond}
	if !pr.IP.Equal(ip) {
		t.Fatal("IP mismatch")
	}
	if pr.RTT != 5*time.Millisecond {
		t.Fatalf("RTT = %v, want 5ms", pr.RTT)
	}
}

func TestPingSequenceAtomic(t *testing.T) {
	// Verify the pingSequence counter exists and is a uint32
	// Just confirm it doesn't panic when read
	_ = pingSequence
}
