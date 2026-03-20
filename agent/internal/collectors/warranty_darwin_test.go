//go:build darwin

package collectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestParseAppleWarrantyPlist(t *testing.T) {
	// Create a temp dir with a test plist
	dir := t.TempDir()

	tests := []struct {
		name          string
		plistContent  string
		wantEnd       string
		wantStart     string
		wantType      string
		wantNil       bool
		wantErr       bool
	}{
		{
			name: "valid plist with coverageEndDate",
			plistContent: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>coverageEndDate</key>
	<string>2027-06-15</string>
	<key>coverageStartDate</key>
	<string>2024-06-15</string>
	<key>coverageType</key>
	<string>AppleCare+</string>
	<key>deviceName</key>
	<string>MacBook Pro</string>
</dict>
</plist>`,
			wantEnd:   "2027-06-15",
			wantStart: "2024-06-15",
			wantType:  "AppleCare+",
		},
		{
			name: "plist with RFC3339 date",
			plistContent: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>coverageEndDate</key>
	<string>2027-06-15T00:00:00Z</string>
</dict>
</plist>`,
			wantEnd: "2027-06-15",
		},
		{
			name: "empty plist",
			plistContent: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>`,
			wantNil: true,
		},
		{
			name: "plist with no warranty fields",
			plistContent: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>someOtherField</key>
	<string>hello</string>
</dict>
</plist>`,
			wantNil: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(dir, tt.name+".plist")
			if err := os.WriteFile(path, []byte(tt.plistContent), 0644); err != nil {
				t.Fatalf("failed to write test plist: %v", err)
			}

			info, err := parseAppleWarrantyPlist(path)
			if tt.wantErr {
				if err == nil {
					t.Error("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if tt.wantNil {
				if info != nil {
					t.Errorf("expected nil, got %+v", info)
				}
				return
			}

			if info == nil {
				t.Fatal("expected non-nil info, got nil")
			}

			if info.CoverageEndDate != tt.wantEnd {
				t.Errorf("CoverageEndDate: got %q, want %q", info.CoverageEndDate, tt.wantEnd)
			}
			if tt.wantStart != "" && info.CoverageStartDate != tt.wantStart {
				t.Errorf("CoverageStartDate: got %q, want %q", info.CoverageStartDate, tt.wantStart)
			}
			if tt.wantType != "" && info.CoverageType != tt.wantType {
				t.Errorf("CoverageType: got %q, want %q", info.CoverageType, tt.wantType)
			}
		})
	}
}

func TestNormalizeDate(t *testing.T) {
	tests := []struct {
		input any
		want  string
	}{
		{"2027-06-15", "2027-06-15"},
		{"2027-06-15T00:00:00Z", "2027-06-15"},
		{"2027-06-15T10:30:00+05:00", "2027-06-15"},
		{"06/15/2027", "2027-06-15"},
		{float64(1750000000), "2025-06-15"},
		{42, ""},
		{nil, ""},
		{"not-a-date", "not-a-date"},
	}

	for _, tt := range tests {
		t.Run(jsonStr(tt.input), func(t *testing.T) {
			got := normalizeDate(tt.input)
			if got != tt.want {
				t.Errorf("normalizeDate(%v) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func jsonStr(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestParseAppleWarrantyPlist_NonexistentFile(t *testing.T) {
	_, err := parseAppleWarrantyPlist("/nonexistent/path.plist")
	if err == nil {
		t.Error("expected error for nonexistent file, got nil")
	}
}
