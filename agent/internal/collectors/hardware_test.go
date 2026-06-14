package collectors

import "testing"

func TestNormalizeOSVersionBuild(t *testing.T) {
	tests := []struct {
		name            string
		osType          string
		platform        string
		platformVersion string
		kernelVersion   string
		wantVersion     string
		wantBuild       string
	}{
		{
			name:            "windows 11 strips embedded build from version (#1302)",
			osType:          "windows",
			platform:        "Microsoft Windows 11 Pro",
			platformVersion: "10.0.26200.8457 Build 26200.8457",
			kernelVersion:   "10.0.26200.8457 Build 26200.8457",
			wantVersion:     "Microsoft Windows 11 Pro",
			wantBuild:       "26200.8457",
		},
		{
			name:            "windows 10 enterprise",
			osType:          "windows",
			platform:        "Microsoft Windows 10 Enterprise",
			platformVersion: "10.0.19045.6456 Build 19045.6456",
			kernelVersion:   "10.0.19045.6456 Build 19045.6456",
			wantVersion:     "Microsoft Windows 10 Enterprise",
			wantBuild:       "19045.6456",
		},
		{
			name:            "windows server keeps server/datacenter keywords for role classification",
			osType:          "windows",
			platform:        "Microsoft Windows Server 2022 Datacenter",
			platformVersion: "10.0.20348.2966 Build 20348.2966",
			kernelVersion:   "10.0.20348.2966 Build 20348.2966",
			wantVersion:     "Microsoft Windows Server 2022 Datacenter",
			wantBuild:       "20348.2966",
		},
		{
			name:            "windows version without Build token falls back to dotted-quad strip",
			osType:          "windows",
			platform:        "Microsoft Windows 11 Pro",
			platformVersion: "10.0.22631.4317",
			kernelVersion:   "10.0.22631.4317",
			wantVersion:     "Microsoft Windows 11 Pro",
			wantBuild:       "22631.4317",
		},
		{
			name:            "windows already-clean build is preserved",
			osType:          "windows",
			platform:        "Microsoft Windows 11 Pro",
			platformVersion: "26100.4061",
			kernelVersion:   "26100.4061",
			wantVersion:     "Microsoft Windows 11 Pro",
			wantBuild:       "26100.4061",
		},
		{
			name:            "windows empty version yields empty build, never panics",
			osType:          "windows",
			platform:        "Microsoft Windows 11 Pro",
			platformVersion: "",
			kernelVersion:   "",
			wantVersion:     "Microsoft Windows 11 Pro",
			wantBuild:       "",
		},
		{
			name:            "linux keeps clean version + kernel build untouched",
			osType:          "linux",
			platform:        "debian",
			platformVersion: "12.12",
			kernelVersion:   "6.17.13-2-pve",
			wantVersion:     "debian 12.12",
			wantBuild:       "6.17.13-2-pve",
		},
		{
			name:            "macos keeps clean version + kernel build untouched",
			osType:          "macos",
			platform:        "darwin",
			platformVersion: "15.7.7",
			kernelVersion:   "24.6.0",
			wantVersion:     "darwin 15.7.7",
			wantBuild:       "24.6.0",
		},
		{
			name:            "non-windows with empty platformVersion does not leave trailing space",
			osType:          "linux",
			platform:        "alpine",
			platformVersion: "",
			kernelVersion:   "6.6.0",
			wantVersion:     "alpine",
			wantBuild:       "6.6.0",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotVersion, gotBuild := normalizeOSVersionBuild(tt.osType, tt.platform, tt.platformVersion, tt.kernelVersion)
			if gotVersion != tt.wantVersion {
				t.Errorf("osVersion = %q, want %q", gotVersion, tt.wantVersion)
			}
			if gotBuild != tt.wantBuild {
				t.Errorf("osBuild = %q, want %q", gotBuild, tt.wantBuild)
			}
		})
	}
}

func TestExtractWindowsBuild(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"10.0.26200.8457 Build 26200.8457", "26200.8457"},
		{"10.0.19045.6456 Build 19045.6456", "19045.6456"},
		{"10.0.22631.4317", "22631.4317"},
		{"26100.4061", "26100.4061"},
		{"  10.0.26200.8457 Build 26200.8457  ", "26200.8457"},
		{"", ""},
		// "Build" with an empty tail must not collapse to empty — fall through
		// to the trimmed original rather than lose the value.
		{"Build ", "Build"},
	}
	for _, tt := range tests {
		if got := extractWindowsBuild(tt.in); got != tt.want {
			t.Errorf("extractWindowsBuild(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
