package sessionbroker

import "testing"

// #12808 review: two connections under the same SessionID (a helper that
// reconnected) get different, nonzero, stable serials.
func TestConnSerialIsUniquePerConnection(t *testing.T) {
	a := &Session{SessionID: "assist-u-1"}
	b := &Session{SessionID: "assist-u-1"}
	if a.ConnSerial() == 0 || b.ConnSerial() == 0 {
		t.Fatal("a serial is zero (zero means unknown)")
	}
	if a.ConnSerial() == b.ConnSerial() {
		t.Fatalf("two connections share serial %d", a.ConnSerial())
	}
	if first := a.ConnSerial(); a.ConnSerial() != first {
		t.Fatal("a session's serial changed")
	}
}
