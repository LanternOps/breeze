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
			profiles, _ := details["profiles"].([]string)
			if len(profiles) != 3 {
				t.Errorf("expected 3 profile identifiers, got %d", len(profiles))
			}
			// Verify "(verified)" suffix was stripped
			for _, p := range profiles {
				if p == "" {
					t.Error("empty profile identifier")
				}
			}
		}
	}
	if !found {
		t.Error("expected macOS Configuration Profiles detection")
	}
}

func TestParseMacProfilesEmptyInput(t *testing.T) {
	detections := parseMacProfilesOutput("")
	if detections != nil {
		t.Errorf("expected nil for empty input, got %v", detections)
	}
}

func TestParseMacProfilesCountOnly(t *testing.T) {
	// Count line present but no profile identifiers
	sample := `There are 2 configuration profiles installed
`
	detections := parseMacProfilesOutput(sample)
	if len(detections) != 1 {
		t.Fatalf("expected 1 detection, got %d", len(detections))
	}
	details, ok := detections[0].Details.(map[string]any)
	if !ok {
		t.Fatal("details should be a map")
	}
	count, _ := details["profileCount"].(int)
	if count != 2 {
		t.Errorf("expected 2 profiles, got %d", count)
	}
	profiles, _ := details["profiles"].([]string)
	if len(profiles) != 0 {
		t.Errorf("expected 0 profile identifiers, got %d", len(profiles))
	}
}

func TestParseMacProfilesSingularCount(t *testing.T) {
	sample := `There are 1 configuration profile installed

Attribute (Profile Identifier): com.apple.mdm.managed (verified)
`
	detections := parseMacProfilesOutput(sample)
	if len(detections) != 1 {
		t.Fatalf("expected 1 detection, got %d", len(detections))
	}
	details, ok := detections[0].Details.(map[string]any)
	if !ok {
		t.Fatal("details should be a map")
	}
	count, _ := details["profileCount"].(int)
	if count != 1 {
		t.Errorf("expected 1 profile, got %d", count)
	}
}

func TestParseMacProfilesVerifiedSuffix(t *testing.T) {
	sample := `There are 2 configuration profiles installed

Attribute (Profile Identifier): com.apple.mdm.managed (verified)
Attribute (Profile Identifier): com.company.wifi
`
	detections := parseMacProfilesOutput(sample)
	if len(detections) != 1 {
		t.Fatalf("expected 1 detection, got %d", len(detections))
	}
	details, ok := detections[0].Details.(map[string]any)
	if !ok {
		t.Fatal("details should be a map")
	}
	profiles, _ := details["profiles"].([]string)
	if len(profiles) != 2 {
		t.Fatalf("expected 2 profile identifiers, got %d", len(profiles))
	}
	// The first one should have "(verified)" stripped
	if profiles[0] != "com.apple.mdm.managed" {
		t.Errorf("expected com.apple.mdm.managed, got %s", profiles[0])
	}
	// The second one has no "(verified)" suffix
	if profiles[1] != "com.company.wifi" {
		t.Errorf("expected com.company.wifi, got %s", profiles[1])
	}
}
