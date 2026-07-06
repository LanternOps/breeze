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
