package patching

import "testing"

func TestParseWindowsFeatureUpdateTitle(t *testing.T) {
	tests := []struct {
		title       string
		wantProduct string
		wantVersion string
		wantOK      bool
	}{
		{"Windows 11, version 24H2", "windows-11", "24H2", true},
		{"Feature update to Windows 10, version 22H2 via Enablement Package (KB5015684)", "windows-10", "22H2", true},
		{"Windows 11, version 25h2", "windows-11", "25H2", true},
		{"Upgrade to Windows 11 Pro, version 24H2", "windows-11", "24H2", true},
		// Windows Update sometimes drops the comma; the anchor still identifies it.
		{"Feature Update to Windows 11 Version 23H2 via Enablement Package", "windows-11", "23H2", true},
		// Names a release but is not a feature release: anchored away.
		{".NET Framework 4.8.1 for Windows 11, version 24H2 for x64 (KB5050187)", "", "", false},
		{"Microsoft .NET Framework 4.8.1 for Windows 11, version 21H2 for x64", "", "", false},
		{"2026-10 Cumulative Update Preview for .NET Framework 3.5 and 4.8.1 for Windows 11, version 24H2 for x64 (KB5064401)", "", "", false},
		// Cumulative updates name the release without a comma and must never
		// be mistaken for a feature update.
		{"2026-10 Cumulative Update for Windows 11 Version 24H2 for x64-based Systems (KB5066835)", "", "", false},
		{"Microsoft .NET Framework 4.8.1 Feature Pack", "", "", false},
		{"", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.title, func(t *testing.T) {
			product, version, ok := ParseWindowsFeatureUpdateTitle(tt.title)
			if ok != tt.wantOK || product != tt.wantProduct || version != tt.wantVersion {
				t.Errorf("ParseWindowsFeatureUpdateTitle(%q) = (%q, %q, %v), want (%q, %q, %v)",
					tt.title, product, version, ok, tt.wantProduct, tt.wantVersion, tt.wantOK)
			}
		})
	}
}

func TestFeatureUpdatePolicyAllows(t *testing.T) {
	feature := func(title string) AvailablePatch {
		return AvailablePatch{Title: title, UpdateType: "feature", Category: "feature"}
	}
	software := AvailablePatch{Title: "2026-10 Cumulative Update for Windows 11 Version 24H2 (KB5066835)", UpdateType: "software"}
	pin := FeatureUpdatePolicy{Mode: FeatureUpdatePin, Product: "windows-11", TargetVersion: "25H2"}

	tests := []struct {
		name   string
		policy FeatureUpdatePolicy
		patch  AvailablePatch
		want   bool
	}{
		{"non-feature patch is never filtered (block)", FeatureUpdatePolicy{Mode: FeatureUpdateBlock}, software, true},
		{"non-feature patch is never filtered (pin)", pin, software, true},
		{"block excludes feature updates", FeatureUpdatePolicy{Mode: FeatureUpdateBlock}, feature("Windows 11, version 25H2"), false},
		{"allow includes feature updates", FeatureUpdatePolicy{Mode: FeatureUpdateAllow}, feature("Windows 11, version 26H2"), true},
		{"pin allows the pinned release", pin, feature("Windows 11, version 25H2"), true},
		{"pin is case-insensitive on the release", pin, feature("Windows 11, version 25h2"), true},
		{"pin excludes a newer release", pin, feature("Windows 11, version 26H2"), false},
		{"pin excludes an older release", pin, feature("Windows 11, version 24H2"), false},
		{"pin excludes another product", FeatureUpdatePolicy{Mode: FeatureUpdatePin, Product: "windows-10", TargetVersion: "22H2"}, feature("Windows 11, version 24H2"), false},
		{"pin excludes an unparseable feature title", pin, feature("Some optional upgrade"), false},
		{"zero-value policy fails closed", FeatureUpdatePolicy{}, feature("Windows 11, version 25H2"), false},
		{"default policy blocks", DefaultFeatureUpdatePolicy(), feature("Windows 11, version 25H2"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.policy.Allows(tt.patch); got != tt.want {
				t.Errorf("Allows() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestParseFeatureUpdatePolicy(t *testing.T) {
	tests := []struct {
		name    string
		raw     any
		want    FeatureUpdatePolicy
		wantErr bool
	}{
		{"block", map[string]any{"mode": "block"}, FeatureUpdatePolicy{Mode: FeatureUpdateBlock}, false},
		{"allow", map[string]any{"mode": "allow"}, FeatureUpdatePolicy{Mode: FeatureUpdateAllow}, false},
		{
			"pin camelCase, version upper-cased",
			map[string]any{"mode": "pin", "product": "windows-11", "targetVersion": "25h2"},
			FeatureUpdatePolicy{Mode: FeatureUpdatePin, Product: "windows-11", TargetVersion: "25H2"},
			false,
		},
		{
			"pin snake_case",
			map[string]any{"mode": "pin", "product": "windows-10", "target_version": "22H2"},
			FeatureUpdatePolicy{Mode: FeatureUpdatePin, Product: "windows-10", TargetVersion: "22H2"},
			false,
		},
		{"not an object", "block", FeatureUpdatePolicy{}, true},
		{"missing mode", map[string]any{"product": "windows-11"}, FeatureUpdatePolicy{}, true},
		{"unknown mode", map[string]any{"mode": "latest"}, FeatureUpdatePolicy{}, true},
		{"pin without version", map[string]any{"mode": "pin", "product": "windows-11"}, FeatureUpdatePolicy{}, true},
		{"pin without product", map[string]any{"mode": "pin", "targetVersion": "25H2"}, FeatureUpdatePolicy{}, true},
		{"pin with unknown product", map[string]any{"mode": "pin", "product": "windows-7", "targetVersion": "25H2"}, FeatureUpdatePolicy{}, true},
		{"pin with malformed version", map[string]any{"mode": "pin", "product": "windows-11", "targetVersion": "25H3"}, FeatureUpdatePolicy{}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseFeatureUpdatePolicy(tt.raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseFeatureUpdatePolicy() error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Errorf("ParseFeatureUpdatePolicy() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestIsWindowsUpgradeClassification(t *testing.T) {
	if !isWindowsUpgradeClassification([]string{"Windows 11", "Upgrades"}) {
		t.Error("Upgrades classification should be recognised")
	}
	if !isWindowsUpgradeClassification([]string{"UPGRADES"}) {
		t.Error("match should be case-insensitive")
	}
	if isWindowsUpgradeClassification([]string{"Windows 11", "Drivers"}) {
		t.Error("Drivers is not an upgrade classification")
	}
	// A real WUA product category for drivers that merely contains the word.
	if isWindowsUpgradeClassification([]string{"Windows 10 and later upgrade & servicing drivers", "Drivers"}) {
		t.Error("the upgrade & servicing drivers product category is not the Upgrades classification")
	}
	if isWindowsUpgradeClassification(nil) {
		t.Error("nil names is not an upgrade")
	}
}

func TestWindowsUpdateType(t *testing.T) {
	tests := []struct {
		name       string
		wuaType    int
		browseOnly bool
		names      []string
		title      string
		want       string
	}{
		{"cumulative update", 1, false, []string{"Windows 11", "Security Updates"}, "2026-10 Cumulative Update for Windows 11 Version 24H2 (KB5066835)", UpdateTypeSoftware},
		{"driver", 2, false, []string{"Windows 10 and later upgrade & servicing drivers", "Drivers"}, "Intel - Net - 1.2.3", UpdateTypeDriver},
		{"upgrades classification is a feature release even when pushed (not BrowseOnly)", 1, false, []string{"Windows 11", "Upgrades"}, "Windows 11, version 25H2", UpdateTypeFeature},
		{"browse-only feature release", 1, true, []string{"Windows 11"}, "Windows 11, version 25H2", UpdateTypeFeature},
		{"browse-only preview is optional, not feature", 1, true, []string{"Windows 11", "Updates"}, "2026-10 Cumulative Update Preview for Windows 11 Version 24H2 (KB5067036)", UpdateTypeOptional},
		{"browse-only .NET preview naming a release is optional", 1, true, []string{"Windows 11", "Updates"}, ".NET Framework 4.8.1 for Windows 11, version 24H2 for x64 (KB5050187)", UpdateTypeOptional},
		{"browse-only driver is optional (hidden, as before)", 2, true, []string{"Drivers"}, "Realtek - Media - 6.0.9", UpdateTypeOptional},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := windowsUpdateType(tt.wuaType, tt.browseOnly, tt.names, tt.title); got != tt.want {
				t.Errorf("windowsUpdateType() = %q, want %q", got, tt.want)
			}
		})
	}
}
