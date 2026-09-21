package bmr

import "testing"

func TestClientCapabilities_IncludesMembership(t *testing.T) {
	if !HasCapability(ClientCapabilities(), CapabilitySnapshotFileMembershipV1) {
		t.Fatalf("ClientCapabilities() = %v, want to include %q", ClientCapabilities(), CapabilitySnapshotFileMembershipV1)
	}
}

func TestHasCapability(t *testing.T) {
	list := []string{"a", CapabilitySnapshotFileMembershipV1, "b"}
	if !HasCapability(list, CapabilitySnapshotFileMembershipV1) {
		t.Fatal("expected capability present")
	}
	if HasCapability(list, "not-present") {
		t.Fatal("expected capability absent")
	}
	if HasCapability(nil, CapabilitySnapshotFileMembershipV1) {
		t.Fatal("expected false on nil list")
	}
}
