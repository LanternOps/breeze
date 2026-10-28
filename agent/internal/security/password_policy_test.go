package security

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

// encodeUTF16LEWithBOM renders s the way `secedit /export` writes its .inf:
// UTF-16LE with a leading byte-order mark and CRLF line endings.
func encodeUTF16LEWithBOM(s string) []byte {
	s = strings.ReplaceAll(s, "\n", "\r\n")
	units := utf16.Encode([]rune(s))
	out := make([]byte, 0, 2+2*len(units))
	out = append(out, 0xFF, 0xFE)
	for _, u := range units {
		out = append(out, byte(u), byte(u>>8))
	}
	return out
}

// seceditExportEnglish is the shape of `secedit /export /areas SECURITYPOLICY`
// on an English Windows 11 workgroup machine with a hardened local policy.
const seceditExportEnglish = `[Unicode]
Unicode=yes
[System Access]
MinimumPasswordAge = 1
MaximumPasswordAge = 60
MinimumPasswordLength = 14
PasswordComplexity = 1
PasswordHistorySize = 24
LockoutBadCount = 5
ResetLockoutCount = 15
LockoutDuration = 15
AllowAdministratorLockout = 1
RequireLogonToChangePassword = 0
ForceLogoffWhenHourExpire = 0
NewAdministratorName = "Administrator"
NewGuestName = "Guest"
ClearTextPassword = 0
LSAAnonymousNameLookup = 0
EnableAdminAccount = 0
EnableGuestAccount = 0
[Event Audit]
AuditSystemEvents = 0
AuditLogonEvents = 0
[Registry Values]
MACHINE\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\LegalNoticeCaption=1,""
[Privilege Rights]
SeNetworkLogonRight = *S-1-1-0,*S-1-5-32-544,*S-1-5-32-545,*S-1-5-32-551
[Version]
signature="$CHICAGO$"
Revision=1
`

// seceditExportGerman is the same export from a German (de-DE) Windows with
// the out-of-box policy: passwords never expire, no lockout, no complexity.
// Section names and keys are not localized; only free-text values are
// (account names, legal notice), so the parser must not depend on them.
const seceditExportGerman = `[Unicode]
Unicode=yes
[System Access]
MinimumPasswordAge = 0
MaximumPasswordAge = -1
MinimumPasswordLength = 0
PasswordComplexity = 0
PasswordHistorySize = 0
LockoutBadCount = 0
RequireLogonToChangePassword = 0
ForceLogoffWhenHourExpire = 0
NewAdministratorName = "Administrator"
NewGuestName = "Gast"
ClearTextPassword = 0
LSAAnonymousNameLookup = 0
EnableAdminAccount = 0
EnableGuestAccount = 0
[Registry Values]
MACHINE\Software\Microsoft\Windows NT\CurrentVersion\Winlogon\LegalNoticeText=7,Zugriff nur für autorisierte Benutzer – Überwachung aktiv
[Version]
signature="$CHICAGO$"
Revision=1
`

func TestParseSeceditSystemAccessEnglishUTF16(t *testing.T) {
	got, err := parseSeceditSystemAccess(encodeUTF16LEWithBOM(seceditExportEnglish))
	if err != nil {
		t.Fatalf("parseSeceditSystemAccess: %v", err)
	}
	want := map[string]any{
		"source":            "secedit",
		"minLength":         14,
		"complexityEnabled": true,
		"maxAgeDays":        60,
		"minAgeDays":        1,
		"lockoutThreshold":  5,
		"historyCount":      24,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed policy = %#v\nwant %#v", got, want)
	}
}

func TestParseSeceditSystemAccessGermanDefaults(t *testing.T) {
	got, err := parseSeceditSystemAccess(encodeUTF16LEWithBOM(seceditExportGerman))
	if err != nil {
		t.Fatalf("parseSeceditSystemAccess: %v", err)
	}
	want := map[string]any{
		"source":            "secedit",
		"minLength":         0,
		"complexityEnabled": false,
		// MaximumPasswordAge = -1 is "never expires"; the record uses 0 for
		// that, the Windows (net accounts / Local Security Policy) convention.
		"maxAgeDays":       0,
		"minAgeDays":       0,
		"lockoutThreshold": 0,
		"historyCount":     0,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed policy = %#v\nwant %#v", got, want)
	}
}

// secedit writes UTF-16LE, but a copy saved by hand (or an older build) may be
// UTF-8 with or without a BOM, with LF endings and odd spacing/case.
func TestParseSeceditSystemAccessUTF8Variants(t *testing.T) {
	body := "[system access]\nminimumpasswordlength=8\n  PasswordComplexity   =   1  \n"
	for name, data := range map[string][]byte{
		"plain":   []byte(body),
		"bom":     append([]byte{0xEF, 0xBB, 0xBF}, body...),
		"utf16le": encodeUTF16LEWithBOM(body),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := parseSeceditSystemAccess(data)
			if err != nil {
				t.Fatalf("parseSeceditSystemAccess: %v", err)
			}
			want := map[string]any{"source": "secedit", "minLength": 8, "complexityEnabled": true}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("parsed policy = %#v, want %#v", got, want)
			}
		})
	}
}

// Keys with the same names outside [System Access] must not be read, and a
// non-numeric value is skipped rather than reported as 0.
func TestParseSeceditSystemAccessIgnoresOtherSectionsAndGarbage(t *testing.T) {
	body := "[Event Audit]\nMinimumPasswordLength = 99\n[System Access]\nMinimumPasswordLength = abc\nPasswordHistorySize = 10\n[Version]\nPasswordHistorySize = 77\n"
	got, err := parseSeceditSystemAccess(encodeUTF16LEWithBOM(body))
	if err != nil {
		t.Fatalf("parseSeceditSystemAccess: %v", err)
	}
	want := map[string]any{"source": "secedit", "historyCount": 10}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsed policy = %#v, want %#v", got, want)
	}
}

func TestParseSeceditSystemAccessRejectsExportWithoutPolicy(t *testing.T) {
	cases := map[string][]byte{
		"empty":              nil,
		"no system access":   encodeUTF16LEWithBOM("[Unicode]\nUnicode=yes\n[Version]\nRevision=1\n"),
		"no recognized keys": encodeUTF16LEWithBOM("[System Access]\nNewGuestName = \"Guest\"\n"),
		"odd utf16 length":   append(encodeUTF16LEWithBOM("[System Access]\n"), 0x41),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if got, err := parseSeceditSystemAccess(data); err == nil {
				t.Fatalf("expected an error, got %#v", got)
			}
		})
	}
}

func TestPasswordPolicyFromUserModals(t *testing.T) {
	got := passwordPolicyFromUserModals(userModalsPolicy{
		MinPasswordLen:    12,
		MaxPasswordAgeSec: 42 * 86400,
		MinPasswordAgeSec: 86400,
		PasswordHistLen:   5,
		LockoutThreshold:  10,
		HaveLockout:       true,
	})
	want := map[string]any{
		"source":           "netapi",
		"minLength":        12,
		"maxAgeDays":       42,
		"minAgeDays":       1,
		"historyCount":     5,
		"lockoutThreshold": 10,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("policy = %#v\nwant %#v", got, want)
	}
	if _, ok := got["complexityEnabled"]; ok {
		t.Fatal("NetUserModalsGet cannot read complexity; the record must not claim a value")
	}
}

func TestPasswordPolicyFromUserModalsNeverExpiresAndNoLockoutLevel(t *testing.T) {
	got := passwordPolicyFromUserModals(userModalsPolicy{MaxPasswordAgeSec: timeqForever})
	if got["maxAgeDays"] != 0 {
		t.Fatalf("TIMEQ_FOREVER must map to maxAgeDays 0 (never expires), got %v", got["maxAgeDays"])
	}
	if _, ok := got["lockoutThreshold"]; ok {
		t.Fatal("lockoutThreshold must be absent when level 3 was not read")
	}
}

func withPasswordPolicyReaders(t *testing.T, secedit, netapi func() (map[string]any, error)) {
	t.Helper()
	prevS, prevN := readPasswordPolicySecedit, readPasswordPolicyNetAPI
	readPasswordPolicySecedit, readPasswordPolicyNetAPI = secedit, netapi
	t.Cleanup(func() { readPasswordPolicySecedit, readPasswordPolicyNetAPI = prevS, prevN })
}

func TestCollectPasswordPolicySummaryWindowsPrefersSecedit(t *testing.T) {
	netapiCalled := false
	withPasswordPolicyReaders(t,
		func() (map[string]any, error) { return map[string]any{"source": "secedit", "minLength": 14}, nil },
		func() (map[string]any, error) { netapiCalled = true; return nil, errors.New("unused") },
	)
	got, err := collectPasswordPolicySummaryWindows()
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if got["source"] != "secedit" || netapiCalled {
		t.Fatalf("expected the secedit record without a fallback, got %v (netapi called: %v)", got, netapiCalled)
	}
}

func TestCollectPasswordPolicySummaryWindowsFallsBackToNetAPI(t *testing.T) {
	withPasswordPolicyReaders(t,
		func() (map[string]any, error) { return nil, errors.New("secedit.exe exited 3") },
		func() (map[string]any, error) { return map[string]any{"source": "netapi", "minLength": 8}, nil },
	)
	got, err := collectPasswordPolicySummaryWindows()
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if got["source"] != "netapi" || got["minLength"] != 8 {
		t.Fatalf("expected the NetUserModalsGet record, got %v", got)
	}
}

func TestCollectPasswordPolicySummaryWindowsReportsBothFailures(t *testing.T) {
	withPasswordPolicyReaders(t,
		func() (map[string]any, error) { return nil, errors.New("secedit boom") },
		func() (map[string]any, error) { return nil, errors.New("netapi boom") },
	)
	_, err := collectPasswordPolicySummaryWindows()
	if err == nil || !strings.Contains(err.Error(), "secedit boom") || !strings.Contains(err.Error(), "netapi boom") {
		t.Fatalf("expected both causes in the error, got %v", err)
	}
}
