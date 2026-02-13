package mgmtdetect

import "testing"

func TestParseMacProfilesOutput(t *testing.T) {
	sample := `There are 3 configuration profiles installed

Attribute (Profile Identifier): com.apple.mdm.managed (verified)
Attribute (Profile Identifier): com.company.wifi (verified)
Attribute (Profile Identifier): com.company.security (verified)
`
	detections := parseMacProfilesOutput(sample)
	if len(detections) == 0 {
		t.Error("expected at least one policy detection")
	}
	found := false
	for _, d := range detections {
		if d.Name == "macOS Configuration Profiles" {
			found = true
			details, ok := d.Details.(map[string]any)
			if !ok {
				t.Error("details should be a map")
				continue
			}
			count, _ := details["profileCount"].(int)
			if count != 3 {
				t.Errorf("expected 3 profiles, got %d", count)
			}
		}
	}
	if !found {
		t.Error("expected macOS Configuration Profiles detection")
	}
}
