package powerrequest

import "testing"

// On Windows this creates and sets a real PowerRequestSystemRequired request;
// elsewhere it exercises the no-op. Either way the release must be callable
// more than once.
func TestHoldSystemAwakeReleasesIdempotently(t *testing.T) {
	release, err := HoldSystemAwake("Breeze agent power request test")
	if err != nil {
		t.Fatalf("HoldSystemAwake: %v", err)
	}
	if release == nil {
		t.Fatal("HoldSystemAwake returned a nil release without an error")
	}
	release()
	release()
}

func TestHoldSystemAwakeConcurrentHolds(t *testing.T) {
	first, err := HoldSystemAwake("Breeze agent power request test 1")
	if err != nil {
		t.Fatalf("first hold: %v", err)
	}
	second, err := HoldSystemAwake("Breeze agent power request test 2")
	if err != nil {
		first()
		t.Fatalf("second hold: %v", err)
	}
	first()
	second()
}
