package security

import (
	"strings"
	"testing"
)

func TestParseBitLockerRecoveryKeys(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		want    int
		wantErr bool
		check   func(t *testing.T, keys []RecoveryKey)
	}{
		{
			name:   "two volumes",
			output: `[{"Mount":"C:","ProtectorId":"{11111111-1111-1111-1111-111111111111}","RecoveryPassword":"111111-222222-333333-444444-555555-666666-777777-888888"},{"Mount":"D:","ProtectorId":"{22222222-2222-2222-2222-222222222222}","RecoveryPassword":"999999-888888-777777-666666-555555-444444-333333-222222"}]`,
			want:   2,
			check: func(t *testing.T, keys []RecoveryKey) {
				if keys[0].Mount != "C:" {
					t.Errorf("mount = %q, want C:", keys[0].Mount)
				}
				if keys[0].ProtectorID != "11111111-1111-1111-1111-111111111111" {
					t.Errorf("protector braces not stripped: %q", keys[0].ProtectorID)
				}
				if keys[0].KeyType != KeyTypeBitLocker {
					t.Errorf("keyType = %q", keys[0].KeyType)
				}
			},
		},
		{
			name:   "PS 5.1 single object collapse",
			output: `{"Mount":"C:","ProtectorId":"{11111111-1111-1111-1111-111111111111}","RecoveryPassword":"111111-222222-333333-444444-555555-666666-777777-888888"}`,
			want:   1,
		},
		{name: "empty array", output: `[]`, want: 0},
		{name: "empty output", output: ``, want: 0},
		{name: "entry without password skipped", output: `[{"Mount":"C:","ProtectorId":"{x}","RecoveryPassword":""}]`, want: 0},
		{name: "malformed json", output: `not-json{`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			keys, err := parseBitLockerRecoveryKeys(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if len(keys) != tt.want {
				t.Fatalf("len = %d, want %d", len(keys), tt.want)
			}
			if tt.check != nil {
				tt.check(t, keys)
			}
		})
	}
}

func TestFingerprintRecoveryKeys(t *testing.T) {
	a := RecoveryKey{Mount: "C:", ProtectorID: "p1", KeyType: KeyTypeBitLocker, Key: "key-one"}
	b := RecoveryKey{Mount: "D:", ProtectorID: "p2", KeyType: KeyTypeBitLocker, Key: "key-two"}

	if got := FingerprintRecoveryKeys(nil); got != "" {
		t.Errorf("empty fingerprint = %q, want empty string", got)
	}
	fp1 := FingerprintRecoveryKeys([]RecoveryKey{a, b})
	fp2 := FingerprintRecoveryKeys([]RecoveryKey{b, a})
	if fp1 != fp2 {
		t.Error("fingerprint must be order-insensitive")
	}
	changed := RecoveryKey{Mount: "C:", ProtectorID: "p1", KeyType: KeyTypeBitLocker, Key: "key-changed"}
	if FingerprintRecoveryKeys([]RecoveryKey{changed, b}) == fp1 {
		t.Error("fingerprint must change when a key changes")
	}
	if strings.Contains(fp1, "key-one") {
		t.Error("fingerprint must not embed key material")
	}
}

func TestParseFileVaultNewKey(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		want    string
		wantErr bool
	}{
		{
			name:   "typical fdesetup output",
			output: "New personal recovery key = 'DWXL-9K2M-4NPQ-R7ST-UV3W-XY8Z'",
			want:   "DWXL-9K2M-4NPQ-R7ST-UV3W-XY8Z",
		},
		{name: "no key in output", output: "Error: unable to change recovery key.", wantErr: true},
		{name: "empty", output: "", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseFileVaultNewKey(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("key = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBuildFileVaultAuthPlist(t *testing.T) {
	withCreds := buildFileVaultAuthPlist("jane", `pa<ss&"word`, "")
	if !strings.Contains(withCreds, "<key>Username</key>") || !strings.Contains(withCreds, "<string>jane</string>") {
		t.Error("username missing from plist")
	}
	if !strings.Contains(withCreds, "pa&lt;ss&amp;&#34;word") && !strings.Contains(withCreds, "pa&lt;ss&amp;&quot;word") {
		t.Errorf("password not XML-escaped: %s", withCreds)
	}
	withKey := buildFileVaultAuthPlist("", "", "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF")
	if strings.Contains(withKey, "<key>Username</key>") {
		t.Error("recovery-key auth must not include Username")
	}
	if !strings.Contains(withKey, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF") {
		t.Error("recovery key missing from plist")
	}
}

func TestMountAndProtectorValidation(t *testing.T) {
	if !validBitLockerMount("C:") || validBitLockerMount("C:\\") || validBitLockerMount("'; rm") {
		t.Error("mount validation wrong")
	}
	if !validProtectorID("11111111-1111-1111-1111-111111111111") || validProtectorID("x'; $(evil)") {
		t.Error("protector id validation wrong")
	}
}
