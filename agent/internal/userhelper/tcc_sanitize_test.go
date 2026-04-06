package userhelper

import "testing"

func TestSystemSettingsURLForPermission(t *testing.T) {
	t.Parallel()

	url, err := systemSettingsURLForPermission("Full Disk Access")
	if err != nil {
		t.Fatalf("systemSettingsURLForPermission: %v", err)
	}
	if url == "" {
		t.Fatal("expected non-empty URL")
	}
	if _, err := systemSettingsURLForPermission("Unknown"); err == nil {
		t.Fatal("expected unknown permission to fail")
	}
}
