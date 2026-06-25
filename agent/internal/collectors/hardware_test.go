package collectors

import (
	"testing"
)

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

func TestCleanHardwareIdentityValue(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "keeps real manufacturer", in: "ASUS", want: "ASUS"},
		{name: "keeps real serial", in: "PF4ABC123456", want: "PF4ABC123456"},
		{name: "trims real value", in: "  ThinkPad X1 Carbon Gen 12  ", want: "ThinkPad X1 Carbon Gen 12"},
		{name: "drops system serial placeholder", in: "System Serial Number", want: ""},
		{name: "drops system product placeholder", in: "System Product Name", want: ""},
		{name: "drops system manufacturer placeholder", in: "System Manufacturer", want: ""},
		{name: "drops common OEM placeholder", in: "To Be Filled By O.E.M.", want: ""},
		{name: "drops default string", in: "Default string", want: ""},
		{name: "drops not specified", in: "Not Specified", want: ""},
		{name: "drops all-zero placeholder", in: "00000000", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := cleanHardwareIdentityValue(tt.in); got != tt.want {
				t.Errorf("cleanHardwareIdentityValue(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestFirstCleanHardwareIdentityValue(t *testing.T) {
	tests := []struct {
		name   string
		values []string
		want   string
	}{
		{name: "keeps primary real serial", values: []string{"SERIAL-123", "BOARD-456"}, want: "SERIAL-123"},
		{name: "falls back when primary is placeholder", values: []string{"System Serial Number", "BOARD-456"}, want: "BOARD-456"},
		{name: "falls back when primary is empty", values: []string{"", "BOARD-456"}, want: "BOARD-456"},
		{name: "drops all placeholders", values: []string{"System Serial Number", "To Be Filled By O.E.M."}, want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := firstCleanHardwareIdentityValue(tt.values...); got != tt.want {
				t.Errorf("firstCleanHardwareIdentityValue(%q) = %q, want %q", tt.values, got, tt.want)
			}
		})
	}
}

func TestParseHardwareJSON(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    windowsHardwareJSON
		wantErr bool
	}{
		{
			name:  "full valid response with two GPUs",
			input: `{"BiosSerial":"SN123","BiosVersion":"1.2.3","BoardSerial":"BS456","BoardManufacturer":"ASUS","BoardProduct":"Z790","BoardVersion":"Rev 1.0","SysManufacturer":"Dell","SysModel":"XPS 15","GPUNames":["NVIDIA RTX 4090","Intel UHD 770"]}`,
			want: windowsHardwareJSON{
				BiosSerial:        "SN123",
				BiosVersion:       "1.2.3",
				BoardSerial:       "BS456",
				BoardManufacturer: "ASUS",
				BoardProduct:      "Z790",
				BoardVersion:      "Rev 1.0",
				SysManufacturer:   "Dell",
				SysModel:          "XPS 15",
				GPUNames:          []string{"NVIDIA RTX 4090", "Intel UHD 770"},
			},
		},
		{
			name:  "single GPU as array",
			input: `{"BiosSerial":"","BiosVersion":"","BoardSerial":"","BoardManufacturer":"","BoardProduct":"","BoardVersion":"","SysManufacturer":"","SysModel":"","GPUNames":["AMD Radeon RX 7900"]}`,
			want: windowsHardwareJSON{
				GPUNames: []string{"AMD Radeon RX 7900"},
			},
		},
		{
			name:  "empty GPU array",
			input: `{"BiosSerial":"SN1","BiosVersion":"1.0","BoardSerial":"","BoardManufacturer":"","BoardProduct":"","BoardVersion":"","SysManufacturer":"","SysModel":"","GPUNames":[]}`,
			want: windowsHardwareJSON{
				BiosSerial:  "SN1",
				BiosVersion: "1.0",
				GPUNames:    []string{},
			},
		},
		{
			// PowerShell 5.1 collapses a single-element array to a bare scalar in
			// ConvertTo-Json, so a one-GPU host (the common case) emits a string,
			// not an array. The custom unmarshaler must normalize it to a slice —
			// otherwise the whole hardware record would be dropped on most hosts.
			name:  "single GPU collapsed to scalar (PS 5.1 ConvertTo-Json)",
			input: `{"BiosSerial":"SN1","BiosVersion":"1.0","BoardSerial":"","BoardManufacturer":"","BoardProduct":"","BoardVersion":"","SysManufacturer":"","SysModel":"","GPUNames":"Intel(R) UHD Graphics"}`,
			want: windowsHardwareJSON{
				BiosSerial:  "SN1",
				BiosVersion: "1.0",
				GPUNames:    gpuNameList{"Intel(R) UHD Graphics"},
			},
		},
		{
			// PowerShell 5.1 serializes an empty @() as JSON null, not []. Go
			// decodes null into a nil slice, which the caller treats the same as
			// an empty list (no GPU model recorded).
			name:  "null GPU list (PS 5.1 serializes empty @() as null)",
			input: `{"BiosSerial":"SN1","BiosVersion":"1.0","BoardSerial":"","BoardManufacturer":"","BoardProduct":"","BoardVersion":"","SysManufacturer":"","SysModel":"","GPUNames":null}`,
			want: windowsHardwareJSON{
				BiosSerial:  "SN1",
				BiosVersion: "1.0",
				GPUNames:    nil,
			},
		},
		{
			name:  "trailing newline in output is tolerated",
			input: `{"BiosSerial":"X","BiosVersion":"","BoardSerial":"","BoardManufacturer":"","BoardProduct":"","BoardVersion":"","SysManufacturer":"","SysModel":"","GPUNames":["GPU1"]}` + "\n",
			want: windowsHardwareJSON{
				BiosSerial: "X",
				GPUNames:   []string{"GPU1"},
			},
		},
		{
			name:    "invalid JSON returns error",
			input:   `not json`,
			wantErr: true,
		},
		{
			name:    "empty input returns error",
			input:   ``,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseHardwareJSON([]byte(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseHardwareJSON() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			checkStr := func(field, got, want string) {
				t.Helper()
				if got != want {
					t.Errorf("%s = %q, want %q", field, got, want)
				}
			}
			checkStr("BiosSerial", got.BiosSerial, tt.want.BiosSerial)
			checkStr("BiosVersion", got.BiosVersion, tt.want.BiosVersion)
			checkStr("BoardSerial", got.BoardSerial, tt.want.BoardSerial)
			checkStr("BoardManufacturer", got.BoardManufacturer, tt.want.BoardManufacturer)
			checkStr("BoardProduct", got.BoardProduct, tt.want.BoardProduct)
			checkStr("BoardVersion", got.BoardVersion, tt.want.BoardVersion)
			checkStr("SysManufacturer", got.SysManufacturer, tt.want.SysManufacturer)
			checkStr("SysModel", got.SysModel, tt.want.SysModel)
			if len(got.GPUNames) != len(tt.want.GPUNames) {
				t.Errorf("GPUNames len = %d, want %d: got %v, want %v",
					len(got.GPUNames), len(tt.want.GPUNames), got.GPUNames, tt.want.GPUNames)
				return
			}
			for i, name := range got.GPUNames {
				if name != tt.want.GPUNames[i] {
					t.Errorf("GPUNames[%d] = %q, want %q", i, name, tt.want.GPUNames[i])
				}
			}
		})
	}
}
