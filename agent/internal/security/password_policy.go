package security

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Keys of the password-policy record every OS collector reports. The server
// (apps/api security helpers and posture scoring) and the Windows CIS checks
// read these names; use the constants so the two sides cannot drift apart
// again (the Windows CIS checks once read keys no collector ever wrote).
const (
	PasswordPolicyKeyMinLength         = "minLength"
	PasswordPolicyKeyComplexityEnabled = "complexityEnabled"
	// PasswordPolicyKeyMaxAgeDays is 0 when passwords never expire (the
	// Windows convention: net accounts, Local Security Policy, CIS 1.1.2).
	PasswordPolicyKeyMaxAgeDays       = "maxAgeDays"
	PasswordPolicyKeyMinAgeDays       = "minAgeDays"
	PasswordPolicyKeyLockoutThreshold = "lockoutThreshold"
	PasswordPolicyKeyHistoryCount     = "historyCount"
)

// seceditSystemAccessKeys maps the [System Access] entries of a
// `secedit /export` .inf to record keys. INF section and key names are fixed
// identifiers, never localized, so this works on every Windows display
// language (unlike `net accounts`, whose labels are translated).
var seceditSystemAccessKeys = map[string]string{
	"minimumpasswordlength": PasswordPolicyKeyMinLength,
	"passwordcomplexity":    PasswordPolicyKeyComplexityEnabled,
	"maximumpasswordage":    PasswordPolicyKeyMaxAgeDays,
	"minimumpasswordage":    PasswordPolicyKeyMinAgeDays,
	"lockoutbadcount":       PasswordPolicyKeyLockoutThreshold,
	"passwordhistorysize":   PasswordPolicyKeyHistoryCount,
}

// decodeSeceditExport returns the text of a secedit export. secedit writes
// UTF-16LE with a byte-order mark; UTF-16BE and UTF-8 (with or without BOM)
// are accepted too.
func decodeSeceditExport(data []byte) (string, error) {
	var bigEndian bool
	switch {
	case bytes.HasPrefix(data, []byte{0xFF, 0xFE}):
		data = data[2:]
	case bytes.HasPrefix(data, []byte{0xFE, 0xFF}):
		data, bigEndian = data[2:], true
	case bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}):
		return string(data[3:]), nil
	case len(data) >= 2 && data[0] != 0 && data[1] == 0:
		// UTF-16LE without a BOM: ASCII "[" followed by a zero byte.
	default:
		return string(data), nil
	}
	if len(data)%2 != 0 {
		return "", errors.New("secedit export is not valid UTF-16 (odd byte count)")
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		lo, hi := data[2*i], data[2*i+1]
		if bigEndian {
			lo, hi = hi, lo
		}
		units[i] = uint16(lo) | uint16(hi)<<8
	}
	return string(utf16.Decode(units)), nil
}

// parseSeceditSystemAccess reads the account password and lockout policy from
// the [System Access] section of a `secedit /export` file. It fails when the
// section is missing or carries none of the policy keys, so the caller can
// fall back instead of reporting an empty record.
func parseSeceditSystemAccess(data []byte) (map[string]any, error) {
	text, err := decodeSeceditExport(data)
	if err != nil {
		return nil, err
	}

	record := map[string]any{"source": "secedit"}
	found, inSystemAccess := 0, false
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			inSystemAccess = strings.EqualFold(strings.TrimSpace(line[1:len(line)-1]), "System Access")
			continue
		}
		if !inSystemAccess {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, known := seceditSystemAccessKeys[strings.ToLower(strings.TrimSpace(name))]
		if !known {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			continue
		}
		switch key {
		case PasswordPolicyKeyComplexityEnabled:
			record[key] = n != 0
		case PasswordPolicyKeyMaxAgeDays:
			// -1 is how the export spells "password never expires".
			record[key] = max(n, 0)
		default:
			record[key] = n
		}
		found++
	}
	if found == 0 {
		return nil, errors.New("secedit export has no [System Access] password policy")
	}
	return record, nil
}

// timeqForever is NetUserModalsGet's "no limit" for usrmod0_max_passwd_age.
const timeqForever = 0xFFFFFFFF

// userModalsPolicy is what NetUserModalsGet levels 0 and 3 report.
type userModalsPolicy struct {
	MinPasswordLen    uint32
	MaxPasswordAgeSec uint32
	MinPasswordAgeSec uint32
	PasswordHistLen   uint32
	LockoutThreshold  uint32
	// HaveLockout is false when level 3 (lockout) could not be read.
	HaveLockout bool
}

// passwordPolicyFromUserModals builds the record from NetUserModalsGet, the
// API `net accounts` itself uses. It has no password-complexity field, so
// complexityEnabled is left out (reported as unknown) rather than guessed.
func passwordPolicyFromUserModals(p userModalsPolicy) map[string]any {
	const secondsPerDay = 86400
	maxAgeDays := 0
	if p.MaxPasswordAgeSec != timeqForever {
		maxAgeDays = int(p.MaxPasswordAgeSec / secondsPerDay)
	}
	record := map[string]any{
		"source":                      "netapi",
		PasswordPolicyKeyMinLength:    int(p.MinPasswordLen),
		PasswordPolicyKeyMaxAgeDays:   maxAgeDays,
		PasswordPolicyKeyMinAgeDays:   int(p.MinPasswordAgeSec / secondsPerDay),
		PasswordPolicyKeyHistoryCount: int(p.PasswordHistLen),
	}
	if p.HaveLockout {
		record[PasswordPolicyKeyLockoutThreshold] = int(p.LockoutThreshold)
	}
	return record
}

// The Windows readers, swappable in tests. secedit is preferred because it is
// the only source that also reports password complexity.
var (
	readPasswordPolicySecedit = collectPasswordPolicySecedit
	readPasswordPolicyNetAPI  = collectPasswordPolicyNetAPI
)

// collectPasswordPolicySummaryWindows reads the effective local account
// policy. It used to query the WMI class Win32_AccountPolicy, which does not
// exist on any Windows build, so every Windows device reported no policy
// (#9597).
func collectPasswordPolicySummaryWindows() (map[string]any, error) {
	record, seceditErr := readPasswordPolicySecedit()
	if seceditErr == nil {
		return record, nil
	}
	record, netErr := readPasswordPolicyNetAPI()
	if netErr != nil {
		return nil, fmt.Errorf("read password policy: secedit: %v; NetUserModalsGet: %w", seceditErr, netErr)
	}
	log.Warn("secedit password policy export failed; reporting NetUserModalsGet values without complexity",
		"error", seceditErr.Error())
	return record, nil
}
