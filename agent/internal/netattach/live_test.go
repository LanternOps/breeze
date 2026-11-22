package netattach

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestCurrent_Live reads this machine's real tables. It asserts structural
// invariants only, so it passes on any host, including a CI container whose
// reads fail. The server host is an IP literal: no DNS query is sent. With
// NETATTACH_LIVE=1 it also logs what it read, for the native runs.
func TestCurrent_Live(t *testing.T) {
	const bound = 3 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), bound)
	defer cancel()
	start := time.Now()
	got, complete, err := Current(ctx, "203.0.113.20")
	elapsed := time.Since(start)
	if elapsed > bound+500*time.Millisecond {
		t.Errorf("Current took %v, bound %v", elapsed, bound)
	}
	if len(got) > MaxAttachments {
		t.Errorf("%d attachments, max %d", len(got), MaxAttachments)
	}
	if err != nil && complete {
		t.Errorf("complete with err %v", err)
	}
	primaries := 0
	for _, a := range got {
		if a.Primary {
			primaries++
		}
		if !a.LocalAddress.Is4() || !a.GatewayAddress.Is4() {
			t.Errorf("non-IPv4 attachment %+v", a)
		}
		if a.PrefixLength > 32 {
			t.Errorf("prefix length %d in %+v", a.PrefixLength, a)
		}
		if a.GatewayMAC != nil && len(a.GatewayMAC) != 6 {
			t.Errorf("gateway MAC %v is not 6 bytes", a.GatewayMAC)
		}
		if a.InterfaceName == "" {
			t.Errorf("empty interface name in %+v", a)
		}
	}
	if primaries > 1 {
		t.Errorf("%d primary attachments", primaries)
	}
	if os.Getenv("NETATTACH_LIVE") == "1" {
		t.Logf("complete=%v err=%v elapsed=%v attachments=%d", complete, err, elapsed, len(got))
		for _, a := range got {
			mac := "null"
			if a.GatewayMAC != nil {
				mac = a.GatewayMAC.String()
			}
			t.Logf("  if=%q index=%d local=%s/%d gateway=%s mac=%s primary=%v",
				a.InterfaceName, a.InterfaceIndex, a.LocalAddress, a.PrefixLength, a.GatewayAddress, mac, a.Primary)
		}
	}
}
