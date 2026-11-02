package collectors

import (
	"encoding/json"
	"os"
	"testing"
)

// systemUUIDFixturePath is shared with the API's normalizeSystemUuid test so
// the agent and the server agree on every vector (#8318).
const systemUUIDFixturePath = "../../../packages/shared/src/testing/system-uuid-normalization-v1.json"

type systemUUIDFixture struct {
	Version   int `json:"version"`
	Normalize []struct {
		Name  string `json:"name"`
		Input string `json:"input"`
		Want  string `json:"want"`
	} `json:"normalize"`
}

func loadSystemUUIDFixture(t *testing.T) systemUUIDFixture {
	t.Helper()
	data, err := os.ReadFile(systemUUIDFixturePath)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var f systemUUIDFixture
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	if f.Version != 1 || len(f.Normalize) == 0 {
		t.Fatalf("unexpected fixture shape: version=%d vectors=%d", f.Version, len(f.Normalize))
	}
	return f
}

func TestNormalizeSystemUUIDSharedVectors(t *testing.T) {
	for _, tt := range loadSystemUUIDFixture(t).Normalize {
		t.Run(tt.Name, func(t *testing.T) {
			if got := normalizeSystemUUID(tt.Input); got != tt.Want {
				t.Errorf("normalizeSystemUUID(%q) = %q, want %q", tt.Input, got, tt.Want)
			}
		})
	}
}

func TestNormalizeSystemUUIDRejectsEveryPlaceholder(t *testing.T) {
	for placeholder := range placeholderSystemUUIDs {
		if got := normalizeSystemUUID(placeholder); got != "" {
			t.Errorf("placeholder %q normalized to %q, want rejection", placeholder, got)
		}
	}
	for _, digit := range "0123456789abcdef" {
		repeated := ""
		for i := 0; i < 32; i++ {
			repeated += string(digit)
		}
		if got := normalizeSystemUUID(repeated); got != "" {
			t.Errorf("repeated digit %q normalized to %q, want rejection", repeated, got)
		}
	}
}

func TestNormalizeSystemUUIDIsIdempotent(t *testing.T) {
	for _, tt := range loadSystemUUIDFixture(t).Normalize {
		if tt.Want == "" {
			continue
		}
		if again := normalizeSystemUUID(tt.Want); again != tt.Want {
			t.Errorf("normalizeSystemUUID(%q) = %q, want it unchanged", tt.Want, again)
		}
	}
}

func TestParseSPHardwareJSON(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		wantOK   bool
		wantErr  bool
		wantUUID string
		wantSN   string
	}{
		{
			name:     "platform_UUID mapped and normalized",
			input:    `{"SPHardwareDataType":[{"_name":"hardware_overview","serial_number":"C02XK0ABJGH5","machine_name":"MacBook Pro","boot_rom_version":"10151.1.1","chip_type":"Apple M2","platform_UUID":"A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF"}]}`,
			wantOK:   true,
			wantUUID: "a1b2c3d4-e5f6-4711-8899-aabbccddeeff",
			wantSN:   "C02XK0ABJGH5",
		},
		{
			name:   "no platform_UUID key leaves the hint empty",
			input:  `{"SPHardwareDataType":[{"serial_number":"C02XK0ABJGH5","machine_name":"Mac mini"}]}`,
			wantOK: true,
			wantSN: "C02XK0ABJGH5",
		},
		{
			name:   "placeholder platform_UUID rejected",
			input:  `{"SPHardwareDataType":[{"serial_number":"X","platform_UUID":"00000000-0000-0000-0000-000000000000"}]}`,
			wantOK: true,
			wantSN: "X",
		},
		{
			name:   "empty list",
			input:  `{"SPHardwareDataType":[]}`,
			wantOK: false,
		},
		{
			name:    "invalid JSON",
			input:   `nope`,
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			entry, ok, err := parseSPHardwareJSON([]byte(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			hw := &HardwareInfo{}
			applySPHardwareEntry(hw, entry)
			if hw.SystemUUID != tt.wantUUID {
				t.Errorf("SystemUUID = %q, want %q", hw.SystemUUID, tt.wantUUID)
			}
			if hw.SerialNumber != tt.wantSN {
				t.Errorf("SerialNumber = %q, want %q", hw.SerialNumber, tt.wantSN)
			}
		})
	}
}

// The hardware report body embeds HardwareInfo, so systemUuid must serialize
// at the top level and be omitted when empty (older APIs ignore the key).
func TestHardwareInfoSystemUUIDJSON(t *testing.T) {
	withUUID, _ := json.Marshal(HardwareInfo{SystemUUID: "4c4c4544-0042-3510-8051-b4c04f4d3132"})
	var m map[string]any
	_ = json.Unmarshal(withUUID, &m)
	if m["systemUuid"] != "4c4c4544-0042-3510-8051-b4c04f4d3132" {
		t.Errorf("systemUuid not serialized: %s", withUUID)
	}
	without, _ := json.Marshal(HardwareInfo{})
	m = map[string]any{}
	_ = json.Unmarshal(without, &m)
	if _, present := m["systemUuid"]; present {
		t.Errorf("empty systemUuid must be omitted: %s", without)
	}
}
