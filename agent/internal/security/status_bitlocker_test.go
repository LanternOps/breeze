package security

import "testing"

func TestParseBitLockerProtectionStatus(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    bool
		wantErr bool
	}{
		{name: "numeric on", input: "1", want: true},
		{name: "numeric off", input: "0", want: false},
		{name: "text on", input: "On", want: true},
		{name: "text off", input: "Off", want: false},
		{name: "bool true", input: "true", want: true},
		{name: "bool false", input: "false", want: false},
		{name: "trimmed enabled", input: "  enabled \n", want: true},
		{name: "trimmed disabled", input: "  disabled \r\n", want: false},
		{name: "unexpected", input: "Unknown", wantErr: true},
		{name: "empty", input: "", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseBitLockerProtectionStatus(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("unexpected value: got %v want %v", got, tt.want)
			}
		})
	}
}

// Windows PowerShell 5.1's ConvertTo-Json serialises enums as integers
// (-EnumsAsStrings is PowerShell 6+), so an agent that ever sees the raw enum
// gets EncryptionMethod 6 / VolumeStatus 1 / ProtectionStatus 1 (#9608). The
// parser must report names whichever form arrives.
func TestParseBitLockerVolumes(t *testing.T) {
	tests := []struct {
		name          string
		output        string
		wantMethod    string
		wantStatus    string
		wantProtected bool
		wantPercent   any
	}{
		{
			name:          "numeric enums from Windows PowerShell 5.1",
			output:        `{"MountPoint":"C:","ProtectionStatus":1,"EncryptionMethod":6,"VolumeStatus":1,"EncryptionPercentage":100}`,
			wantMethod:    "xtsaes128",
			wantStatus:    "FullyEncrypted",
			wantProtected: true,
			wantPercent:   float64(100),
		},
		{
			name:          "string enums",
			output:        `{"MountPoint":"C:","ProtectionStatus":"On","EncryptionMethod":"XtsAes256","VolumeStatus":"EncryptionInProgress","EncryptionPercentage":42.5}`,
			wantMethod:    "xtsaes256",
			wantStatus:    "EncryptionInProgress",
			wantProtected: true,
			wantPercent:   42.5,
		},
		{
			name:          "numeric decrypted volume",
			output:        `{"MountPoint":"D:","ProtectionStatus":0,"EncryptionMethod":0,"VolumeStatus":0,"EncryptionPercentage":0}`,
			wantMethod:    "none",
			wantStatus:    "FullyDecrypted",
			wantProtected: false,
			wantPercent:   float64(0),
		},
		{
			name:          "numeric protection status Unknown (2) is not protected",
			output:        `{"MountPoint":"E:","ProtectionStatus":2,"EncryptionMethod":7,"VolumeStatus":3}`,
			wantMethod:    "xtsaes256",
			wantStatus:    "DecryptionInProgress",
			wantProtected: false,
		},
		{
			name:          "stringified numbers",
			output:        `{"MountPoint":"C:","ProtectionStatus":"1","EncryptionMethod":"3","VolumeStatus":"4"}`,
			wantMethod:    "aes128",
			wantStatus:    "EncryptionPaused",
			wantProtected: true,
		},
		{
			name:          "unmapped numeric values stay visible as unknown",
			output:        `{"MountPoint":"C:","ProtectionStatus":1,"EncryptionMethod":99,"VolumeStatus":42}`,
			wantMethod:    "unknown",
			wantStatus:    "Unknown",
			wantProtected: true,
		},
		{
			name:          "missing method",
			output:        `{"MountPoint":"C:","ProtectionStatus":"Off"}`,
			wantMethod:    "unknown",
			wantStatus:    "",
			wantProtected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			details, err := parseBitLockerVolumes(tt.output)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if details["source"] != "bitlocker" {
				t.Fatalf("source = %v, want bitlocker", details["source"])
			}
			volumes, ok := details["volumes"].([]map[string]any)
			if !ok || len(volumes) != 1 {
				t.Fatalf("volumes = %#v, want exactly one", details["volumes"])
			}
			vol := volumes[0]
			if vol["method"] != tt.wantMethod {
				t.Errorf("method = %v, want %v", vol["method"], tt.wantMethod)
			}
			if vol["status"] != tt.wantStatus {
				t.Errorf("status = %v, want %v", vol["status"], tt.wantStatus)
			}
			if vol["protected"] != tt.wantProtected {
				t.Errorf("protected = %v, want %v", vol["protected"], tt.wantProtected)
			}
			if got, present := vol["percentEncrypted"]; tt.wantPercent == nil {
				if present {
					t.Errorf("percentEncrypted = %v, want absent", got)
				}
			} else if got != tt.wantPercent {
				t.Errorf("percentEncrypted = %v, want %v", got, tt.wantPercent)
			}
		})
	}
}

func TestParseBitLockerVolumesArray(t *testing.T) {
	details, err := parseBitLockerVolumes(`[{"MountPoint":"C:","ProtectionStatus":1,"EncryptionMethod":6,"VolumeStatus":1},{"MountPoint":"D:","ProtectionStatus":0,"EncryptionMethod":0,"VolumeStatus":0}]`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	volumes := details["volumes"].([]map[string]any)
	if len(volumes) != 2 || volumes[0]["mount"] != "C:" || volumes[1]["mount"] != "D:" {
		t.Fatalf("volumes = %#v", volumes)
	}
}

func TestParseBitLockerVolumesInvalidJSON(t *testing.T) {
	if _, err := parseBitLockerVolumes("not json"); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}
